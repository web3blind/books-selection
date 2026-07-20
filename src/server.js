const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const { readAppConfig, isAppConfigured, toProviderOverrides, writeAppConfig } = require('./appConfig');
const { answerLibraryQuestion, createFtsQueryFromQuestion } = require('./ask');
const { indexMissingChunkEmbeddings } = require('./embeddingIndexer');
const { semanticSearchIfConfigured } = require('./embeddings');
const { extractFactFromEvidence } = require('./factExtractor');
const { indexLibrary, searchChunks } = require('./indexer');
const { scanBooks } = require('./scan');
const { initializeSearchDatabase } = require('./searchDb');

const publicDir = path.join(__dirname, '..', 'public');
const defaultRoot = process.argv[2] || '';
const port = Number(process.argv[3] || process.env.PORT || 3210);
const shouldOpenBrowser = process.env.BOOKS_SELECTION_NO_OPEN !== '1';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

async function sendFile(response, filePath, contentType) {
  const content = await fs.readFile(filePath);
  response.writeHead(200, { 'content-type': `${contentType}; charset=utf-8` });
  response.end(content);
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function getRootPath(url, appConfig) {
  return url.searchParams.get('root') || appConfig.booksRoot || defaultRoot;
}

function getDbPath(url, appConfig) {
  return url.searchParams.get('db') || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '';
}

async function withSearchDatabase(databasePath, callback) {
  const db = initializeSearchDatabase(databasePath);
  try {
    return await callback(db);
  } finally {
    db.close();
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const configState = await readAppConfig(process.env);
    const appConfig = configState.config;
    const providerOverrides = toProviderOverrides(appConfig);

    if (url.pathname === '/api/config') {
      if (request.method === 'GET') {
        return sendJson(response, 200, {
          config: appConfig,
          path: configState.path,
          exists: configState.exists,
          isConfigured: isAppConfigured(appConfig),
        });
      }
      if (request.method === 'POST') {
        const payload = await readJsonBody(request);
        const saved = await writeAppConfig(payload, process.env);
        return sendJson(response, 200, {
          config: saved.config,
          path: saved.path,
          exists: true,
          isConfigured: isAppConfigured(saved.config),
        });
      }
    }

    if (url.pathname === '/api/books') {
      const root = getRootPath(url, appConfig);

      if (!root) {
        return sendJson(response, 400, { error: 'Нужен путь к папке с книгами.' });
      }

      const books = await scanBooks(root);
      return sendJson(response, 200, { root, count: books.length, books });
    }

    if (url.pathname === '/api/index' && request.method === 'POST') {
      const root = getRootPath(url, appConfig);
      const databasePath = getDbPath(url, appConfig);

      if (!root) {
        return sendJson(response, 400, { error: 'Нужен путь к папке с книгами.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => indexLibrary(db, root));
      return sendJson(response, 200, { root, db: databasePath, result });
    }

    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const databasePath = getDbPath(url, appConfig);

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен поисковый запрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const results = await withSearchDatabase(databasePath, (db) => searchChunks(db, query));
      return sendJson(response, 200, { query, count: results.length, results });
    }

    if (url.pathname === '/api/ask') {
      const query = url.searchParams.get('q') || '';
      const databasePath = getDbPath(url, appConfig);

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен вопрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => answerLibraryQuestion({ db, question: query, providerOverrides }));
      return sendJson(response, 200, { query, result });
    }

    if (url.pathname === '/api/semantic-search') {
      const query = url.searchParams.get('q') || '';
      const databasePath = getDbPath(url, appConfig);

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен поисковый запрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => semanticSearchIfConfigured({ db, query, providerOverrides }));
      return sendJson(response, 200, { query, result });
    }

    if (url.pathname === '/api/embed-index' && request.method === 'POST') {
      const databasePath = getDbPath(url, appConfig);
      const limit = Number(url.searchParams.get('limit') || 100);
      const batchSize = Number(url.searchParams.get('batchSize') || 16);

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => indexMissingChunkEmbeddings({ db, limit, batchSize, providerOverrides }));
      return sendJson(response, 200, { db: databasePath, result });
    }

    if (url.pathname === '/api/extract-fact') {
      const query = url.searchParams.get('q') || '';
      const databasePath = getDbPath(url, appConfig);
      const bookId = Number(url.searchParams.get('bookId') || 0);
      const factKey = url.searchParams.get('factKey') || '';
      const factType = url.searchParams.get('factType') || 'generic';

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен вопрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      if (!bookId) {
        return sendJson(response, 400, { error: 'Нужен числовой bookId.' });
      }

      if (!factKey.trim()) {
        return sendJson(response, 400, { error: 'Нужен factKey.' });
      }

      const result = await withSearchDatabase(databasePath, async (db) => {
        const retrievalQuery = createFtsQueryFromQuestion(query);
        const evidenceRows = searchChunks(db, retrievalQuery, { limit: 12 })
          .filter((row) => row.book_id === bookId);
        return extractFactFromEvidence({ db, bookId, factKey, factType, question: query, evidenceRows, providerOverrides });
      });
      return sendJson(response, 200, { query, result });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return sendFile(response, path.join(publicDir, 'index.html'), 'text/html');
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  const appUrl = `http://127.0.0.1:${port}`;
  const rootText = defaultRoot ? `\nBooks folder: ${defaultRoot}` : '';
  console.log(`Books Selection started: ${appUrl}${rootText}`);

  if (!shouldOpenBrowser) {
    console.log('Browser auto-open is disabled by BOOKS_SELECTION_NO_OPEN=1');
    return;
  }

  const opened = openBrowser(appUrl);
  if (!opened) {
    console.log(`Could not auto-open the browser. Open manually: ${appUrl}`);
  }
});
