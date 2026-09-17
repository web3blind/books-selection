const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const { readAppConfig, redactAppConfig, isAppConfigured, toProviderOverrides, writeAppConfig } = require('./appConfig');
const { answerLibraryQuestion } = require('./ask');
const { getEmbeddingIndexStatus, indexMissingChunkEmbeddings } = require('./embeddingIndexer');
const { semanticSearchIfConfigured } = require('./embeddings');
const { extractFactFromEvidence } = require('./factExtractor');
const {
  addCycleFavorite,
  clearFavoriteHistory,
  listFavorites,
  moveFavorite,
  rebuildFavoriteOrderByRating,
  recordAskCycleHits,
  removeCycleFavorite,
} = require('./favorites');
const { indexLibrary, searchChunks } = require('./indexer');
const { listReadingStates, setCycleRead, setCycleUnfinished } = require('./readingState');
const { loadSeriesSnapshot } = require('./authorToday');
const {
  applySeriesCheck,
  bindCycleSeries,
  listCycleSeries,
  recordSeriesCheckFailure,
  unbindCycleSeries,
} = require('./seriesWatch');
const { scanBooks } = require('./scan');
const { initializeSearchDatabase } = require('./searchDb');
const { checkForUpdates } = require('./updateChecker');
const { writeProviderNetworkDiagnostic } = require('./diagnostics');

const publicDir = path.join(__dirname, '..', 'public');
const API_COOKIE_NAME = 'books_selection_api_token';
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_CYCLE_NAME_LENGTH = 200;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}


function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function sendFile(response, filePath, contentType, headers = {}) {
  const content = await fs.readFile(filePath);
  response.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, ...headers });
  response.end(content);
}

async function sendIndexFile(response, filePath, language, headers = {}) {
  const requested = ['en', 'ru'].includes(language) ? language : 'en';
  const html = await fs.readFile(filePath, 'utf8');
  const bootstrap = `<script>window.__booksSelectionLanguage=${JSON.stringify(requested)};</script>`;
  const withLanguage = html.replace(/<html lang="[^"]*"/, `<html lang="${requested}"`);
  const body = withLanguage.includes('</head>')
    ? withLanguage.replace('</head>', `${bootstrap}\n</head>`)
    : `${bootstrap}\n${withLanguage}`;
  const content = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': content.length,
    ...headers,
  });
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
    let size = 0;
    let rejected = false;
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      request.resume();
      reject(new HttpError(413, 'Request body is too large.'));
      return;
    }

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(new HttpError(413, 'Request body is too large.'));
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (rejected) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function expectedOrigin(request) {
  return `http://127.0.0.1:${request.socket.localPort}`;
}

function hasExpectedHost(request) {
  return request.headers.host === `127.0.0.1:${request.socket.localPort}`;
}

function hasAllowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === expectedOrigin(request);
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function tokensEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireJsonRequest(request) {
  const type = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'Request Content-Type must be application/json.');
  }
}

function getRootPath(url, appConfig, defaultRoot = '') {
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

function createRequestHandler(options = {}) {
  const defaultRoot = options.defaultRoot || '';
  const updateCheckOptions = options.updateCheckOptions || {};
  const providerFetchImpl = options.providerFetchImpl;
  const authorTodayFetchImpl = options.authorTodayFetchImpl;
  const diagnosticWriter = options.diagnosticWriter || writeProviderNetworkDiagnostic;
  const apiToken = options.apiToken || randomBytes(32).toString('base64url');
  const embeddingOperations = new Map();
  const requestedRetentionMs = Number(options.embeddingOperationRetentionMs ?? 60_000);
  const embeddingOperationRetentionMs = Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
    ? Math.min(requestedRetentionMs, 300_000)
    : 60_000;

  function embeddingOperationKey(databasePath) {
    return path.resolve(databasePath);
  }

  function expireEmbeddingOperation(operationKey, operation) {
    const timer = setTimeout(() => {
      if (embeddingOperations.get(operationKey) === operation && !operation.active) {
        embeddingOperations.delete(operationKey);
      }
    }, embeddingOperationRetentionMs);
    timer.unref?.();
  }

  return async function handleRequest(request, response) {
  let route = '';
  const requestAbort = new AbortController();
  request.once('aborted', () => requestAbort.abort());
  response.once('close', () => {
    if (!response.writableEnded) requestAbort.abort();
  });
  try {
    if (!hasExpectedHost(request) || !hasAllowedOrigin(request)) {
      return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    }
    const url = new URL(request.url, expectedOrigin(request));
    route = url.pathname;
    if (url.pathname.startsWith('/api/')) {
      const requestToken = parseCookies(request.headers.cookie)[API_COOKIE_NAME];
      if (!tokensEqual(requestToken, apiToken)) {
        return sendJson(response, 403, { error: 'Missing or invalid local API token.' });
      }
    }
    const configState = await readAppConfig(process.env);
    const appConfig = configState.config;
    const providerOverrides = toProviderOverrides(appConfig);

    if (url.pathname === '/api/config') {
      if (request.method === 'GET') {
        return sendJson(response, 200, {
          config: redactAppConfig(appConfig, process.env),
          path: configState.path,
          exists: configState.exists,
          isConfigured: isAppConfigured(appConfig),
          ...(configState.error ? { configError: configState.error } : {}),
        });
      }
      if (request.method === 'POST') {
        requireJsonRequest(request);
        const payload = await readJsonBody(request);
        const saved = await writeAppConfig(payload, process.env);
        return sendJson(response, 200, {
          config: redactAppConfig(saved.config, process.env),
          path: saved.path,
          exists: true,
          isConfigured: isAppConfigured(saved.config),
        });
      }
    }

    if (url.pathname === '/api/language') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const language = String(payload.language || '').trim();
      if (!['en', 'ru'].includes(language)) {
        return sendJson(response, 400, { error: 'Нужен language en или ru.' });
      }
      const saved = await writeAppConfig({ ...appConfig, language }, process.env);
      return sendJson(response, 200, {
        config: redactAppConfig(saved.config, process.env),
        path: saved.path,
        language,
      });
    }

    if (url.pathname === '/api/update-check') {
      const platform = url.searchParams.get('platform') || process.platform;
      const result = await checkForUpdates({ ...updateCheckOptions, platform });
      return sendJson(response, 200, result);
    }

    if (url.pathname === '/api/books') {
      const root = getRootPath(url, appConfig, defaultRoot);

      if (!root) {
        return sendJson(response, 400, { error: 'Нужен путь к папке с книгами.' });
      }

      const books = await scanBooks(root);
      return sendJson(response, 200, { root, count: books.length, books });
    }

    if (url.pathname === '/api/index') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const root = String(payload.root || appConfig.booksRoot || defaultRoot);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');

      if (!root) {
        return sendJson(response, 400, { error: 'Нужен путь к папке с книгами.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => indexLibrary(db, root));
      return sendJson(response, 200, { root, db: databasePath, result });
    }

    if (url.pathname === '/api/embedding-status') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
      const databasePath = getDbPath(url, appConfig);
      if (!databasePath) return sendJson(response, 400, { error: 'Нужен путь к SQLite базе.' });
      const result = await withSearchDatabase(databasePath, (db) => getEmbeddingIndexStatus({
        db, providerOverrides,
      }));
      return sendJson(response, 200, { db: databasePath, result });
    }

    if (url.pathname === '/api/embedding-progress') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
      const databasePath = getDbPath(url, appConfig);
      if (!databasePath) return sendJson(response, 400, { error: 'Нужен путь к SQLite базе.' });
      const result = embeddingOperations.get(embeddingOperationKey(databasePath)) || {
        active: false,
        phase: 'idle',
        completed: 0,
        total: 0,
        startedAt: null,
        updatedAt: null,
      };
      return sendJson(response, 200, { result });
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
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const query = String(payload.q || '');
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен вопрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, async (db) => {
        const answer = await answerLibraryQuestion({
          db, question: query, providerOverrides, fetchImpl: providerFetchImpl, signal: requestAbort.signal,
        });
        try {
          recordAskCycleHits(db, { cycleGroups: answer.cycleGroups, query });
        } catch {
          // Favorite history is a convenience layer: a failed write must never break Ask.
        }
        return answer;
      });
      return sendJson(response, 200, { query, result });
    }

    if (url.pathname === '/api/favorites') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
      const databasePath = getDbPath(url, appConfig);
      if (!databasePath) return sendJson(response, 400, { error: 'Нужен путь к SQLite базе.' });
      const favorites = await withSearchDatabase(databasePath, (db) => listFavorites(db));
      return sendJson(response, 200, { db: databasePath, count: favorites.length, favorites });
    }

    if (url.pathname === '/api/cycle-favorite') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      const cycle = String(payload.cycle || '').trim();

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }
      if (!cycle || cycle.length > MAX_CYCLE_NAME_LENGTH) {
        return sendJson(response, 400, { error: 'Нужно название цикла.' });
      }

      const favorite = payload.favorite !== false;
      const result = await withSearchDatabase(databasePath, (db) => (favorite
        ? addCycleFavorite(db, { cycle })
        : removeCycleFavorite(db, { cycle })));
      return sendJson(response, 200, { db: databasePath, cycle, favorite, result });
    }

    if (url.pathname === '/api/favorites/reorder') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      if (payload.action === 'rating') {
        const result = await withSearchDatabase(databasePath, (db) => rebuildFavoriteOrderByRating(db));
        return sendJson(response, 200, { db: databasePath, action: 'rating', result });
      }

      const cycle = String(payload.cycle || '').trim();
      const direction = String(payload.direction || '');
      if (!cycle || cycle.length > MAX_CYCLE_NAME_LENGTH || !['up', 'down'].includes(direction)) {
        return sendJson(response, 400, { error: 'Нужны cycle и direction up|down, либо action rating.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => moveFavorite(db, { cycle, direction }));
      return sendJson(response, 200, { db: databasePath, cycle, direction, result });
    }

    if (url.pathname === '/api/favorites/clear-history') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }
      const cycle = payload.cycle === undefined || payload.cycle === null ? undefined : String(payload.cycle).trim();
      if (cycle !== undefined && (!cycle || cycle.length > MAX_CYCLE_NAME_LENGTH)) {
        return sendJson(response, 400, { error: 'Пустое название цикла.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => clearFavoriteHistory(db, cycle === undefined ? {} : { cycle }));
      return sendJson(response, 200, { db: databasePath, result });
    }

    if (url.pathname === '/api/reading') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
      const databasePath = getDbPath(url, appConfig);
      if (!databasePath) return sendJson(response, 400, { error: 'Нужен путь к SQLite базе.' });
      const states = await withSearchDatabase(databasePath, (db) => listReadingStates(db));
      return sendJson(response, 200, { db: databasePath, count: states.length, states });
    }

    if (url.pathname === '/api/cycle-reading') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      const cycle = String(payload.cycle || '').trim();

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }
      if (!cycle || cycle.length > MAX_CYCLE_NAME_LENGTH) {
        return sendJson(response, 400, { error: 'Нужно название цикла.' });
      }
      const hasRead = typeof payload.read === 'boolean';
      const hasUnfinished = typeof payload.unfinished === 'boolean';
      if (!hasRead && !hasUnfinished) {
        return sendJson(response, 400, { error: 'Нужен флаг read или unfinished.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => {
        const updated = {};
        if (hasRead) updated.read = setCycleRead(db, { cycle, read: payload.read });
        if (hasUnfinished) updated.unfinished = setCycleUnfinished(db, { cycle, unfinished: payload.unfinished });
        return updated;
      });
      return sendJson(response, 200, { db: databasePath, cycle, result });
    }

    if (url.pathname === '/api/cycle-series') {
      if (request.method === 'GET') {
        const databasePath = getDbPath(url, appConfig);
        if (!databasePath) return sendJson(response, 400, { error: 'Нужен путь к SQLite базе.' });
        const bindings = await withSearchDatabase(databasePath, (db) => listCycleSeries(db));
        return sendJson(response, 200, { db: databasePath, count: bindings.length, bindings });
      }
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      const cycle = String(payload.cycle || '').trim();

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }
      if (!cycle || cycle.length > MAX_CYCLE_NAME_LENGTH) {
        return sendJson(response, 400, { error: 'Нужно название цикла.' });
      }

      if (payload.bound === false) {
        const result = await withSearchDatabase(databasePath, (db) => unbindCycleSeries(db, { cycle }));
        return sendJson(response, 200, { db: databasePath, cycle, bound: false, result });
      }

      let snapshot;
      try {
        snapshot = await loadSeriesSnapshot(payload.url, {
          fetchImpl: authorTodayFetchImpl,
          signal: requestAbort.signal,
        });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }

      const binding = await withSearchDatabase(databasePath, (db) => bindCycleSeries(db, { cycle, snapshot }));
      return sendJson(response, 200, { db: databasePath, cycle, bound: true, binding });
    }

    if (url.pathname === '/api/cycle-series/check') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      const cycle = String(payload.cycle || '').trim();

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }
      if (!cycle || cycle.length > MAX_CYCLE_NAME_LENGTH) {
        return sendJson(response, 400, { error: 'Нужно название цикла.' });
      }

      const existing = await withSearchDatabase(databasePath, (db) => (
        listCycleSeries(db).find((item) => item.cycleKey === cycle) || null
      ));
      if (!existing) {
        return sendJson(response, 404, { error: 'Цикл не привязан к странице Author.Today.' });
      }

      try {
        const snapshot = await loadSeriesSnapshot(existing.seriesUrl, {
          fetchImpl: authorTodayFetchImpl,
          signal: requestAbort.signal,
        });
        const binding = await withSearchDatabase(databasePath, (db) => applySeriesCheck(db, { cycle, snapshot }));
        return sendJson(response, 200, { db: databasePath, cycle, ok: true, binding });
      } catch (error) {
        try {
          const binding = await withSearchDatabase(databasePath, (db) => (
            recordSeriesCheckFailure(db, { cycle, message: error.message })
          ));
          return sendJson(response, 200, { db: databasePath, cycle, ok: false, error: error.message, binding });
        } catch {
          // Привязку мог снять другой запрос: отвечаем понятной ошибкой, а не 500.
          return sendJson(response, 404, { error: 'Цикл не привязан к странице Author.Today.' });
        }
      }
    }

    if (url.pathname === '/api/semantic-search') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const query = String(payload.q || '');
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен поисковый запрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      const result = await withSearchDatabase(databasePath, (db) => semanticSearchIfConfigured({
        db, query, providerOverrides, fetchImpl: providerFetchImpl, signal: requestAbort.signal,
      }));
      return sendJson(response, 200, { query, result });
    }

    if (url.pathname === '/api/embed-index') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      const limit = payload.allRemaining === true ? null : Number(payload.limit ?? 100);
      const batchSize = Number(payload.batchSize ?? 16);
      const expectedRemaining = Number(payload.expectedRemaining);
      const configuredProvider = String(appConfig.activeEmbeddingsProvider || 'openrouter');
      const expectedProvider = String(payload.expectedProvider || '');

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }
      if (expectedProvider !== configuredProvider) {
        throw new HttpError(409, 'Настройки provider изменились. Сохрани настройки и повтори операцию.');
      }
      if (configuredProvider === 'openrouter' && payload.cloudConsent !== true) {
        throw new HttpError(400, 'Для отправки фрагментов в OpenRouter требуется явное согласие.');
      }
      if (payload.allRemaining === true && (!Number.isSafeInteger(expectedRemaining) || expectedRemaining < 0)) {
        throw new HttpError(400, 'Для полной подготовки нужен подтверждённый объём оставшихся фрагментов.');
      }

      const operationKey = embeddingOperationKey(databasePath);
      const existingOperation = embeddingOperations.get(operationKey);
      if (existingOperation?.active) {
        throw new HttpError(409, 'Подготовка embeddings для этой базы уже выполняется.');
      }
      const result = await withSearchDatabase(databasePath, async (db) => {
        if (payload.allRemaining === true) {
          const status = getEmbeddingIndexStatus({ db, providerOverrides });
          if (status.remaining !== expectedRemaining) {
            throw new HttpError(409, `Объём изменился: сейчас осталось ${status.remaining} фрагментов. Подтверди новый объём.`);
          }
        }
        const startedAt = Date.now();
        const operation = {
          active: true,
          phase: 'starting',
          completed: 0,
          total: payload.allRemaining === true ? expectedRemaining : Math.max(0, limit),
          startedAt,
          updatedAt: startedAt,
        };
        embeddingOperations.set(operationKey, operation);
        try {
          const embeddingResult = await indexMissingChunkEmbeddings({
            db, limit, batchSize, maxTransmittedChunks: expectedRemaining,
            providerOverrides, fetchImpl: providerFetchImpl, signal: requestAbort.signal,
            onProgress(progress) {
              Object.assign(operation, progress, { updatedAt: Date.now() });
            },
          });
          Object.assign(operation, { active: false, phase: 'complete', updatedAt: Date.now() });
          expireEmbeddingOperation(operationKey, operation);
          return embeddingResult;
        } catch (error) {
          Object.assign(operation, { active: false, phase: 'failed', updatedAt: Date.now() });
          expireEmbeddingOperation(operationKey, operation);
          throw error;
        }
      });
      return sendJson(response, 200, { db: databasePath, result });
    }

    if (url.pathname === '/api/extract-fact') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
      requireJsonRequest(request);
      const payload = await readJsonBody(request);
      const query = String(payload.q || '');
      const databasePath = String(payload.db || appConfig.dbPath || process.env.BOOKS_SELECTION_DB_PATH || '');
      const bookId = Number(payload.bookId || 0);
      const factKey = String(payload.factKey || '');
      const factType = String(payload.factType || 'generic');

      if (!query.trim()) {
        return sendJson(response, 400, { error: 'Нужен вопрос q.' });
      }

      if (!databasePath) {
        return sendJson(response, 400, { error: 'Нужен путь к SQLite базе через параметр db или BOOKS_SELECTION_DB_PATH.' });
      }

      if (!Number.isSafeInteger(bookId) || bookId <= 0) {
        return sendJson(response, 400, { error: 'Нужен положительный целочисленный bookId.' });
      }

      if (!factKey.trim()) {
        return sendJson(response, 400, { error: 'Нужен factKey.' });
      }

      const result = await withSearchDatabase(databasePath, async (db) => {
        const evidenceRows = searchChunks(db, query, { limit: 12, bookId });
        return extractFactFromEvidence({
          db, bookId, factKey, factType, question: query, evidenceRows, providerOverrides, fetchImpl: providerFetchImpl,
          signal: requestAbort.signal,
        });
      });
      return sendJson(response, 200, { query, result });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return sendIndexFile(response, path.join(publicDir, 'index.html'), appConfig.language, {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'set-cookie': `${API_COOKIE_NAME}=${apiToken}; HttpOnly; SameSite=Strict; Path=/api`,
      });
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    let diagnosticLog = '';
    if (error.code === 'PROVIDER_NETWORK_ERROR') {
      try {
        diagnosticLog = await diagnosticWriter(error, { route }, process.env);
      } catch {
        // Never hide the original provider error if local diagnostics cannot be written.
      }
    }
    const logHint = diagnosticLog ? ` Diagnostic log: ${diagnosticLog}` : '';
    sendJson(response, error.statusCode || 500, { error: `${error.message}${logHint}` });
  }
  };
}

function startServer(options = {}) {
  const defaultRoot = options.defaultRoot ?? process.argv[2] ?? '';
  const requestedPort = options.port ?? process.env.PORT ?? process.argv[3] ?? 3210;
  const port = Number(requestedPort);
  const shouldOpenBrowser = options.openBrowser ?? (process.env.BOOKS_SELECTION_NO_OPEN !== '1');
  const shouldLog = options.log ?? true;
  const server = http.createServer(createRequestHandler({
    defaultRoot,
    updateCheckOptions: options.updateCheckOptions,
    providerFetchImpl: options.providerFetchImpl,
    authorTodayFetchImpl: options.authorTodayFetchImpl,
    diagnosticWriter: options.diagnosticWriter,
    embeddingOperationRetentionMs: options.embeddingOperationRetentionMs,
  }));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const appUrl = `http://127.0.0.1:${actualPort}`;
      const rootText = defaultRoot ? `\nBooks folder: ${defaultRoot}` : '';

      if (shouldLog) {
        console.log(`Books Selection started: ${appUrl}${rootText}`);
      }

      if (shouldOpenBrowser) {
        const opened = openBrowser(appUrl);
        if (!opened && shouldLog) {
          console.log(`Could not auto-open the browser. Open manually: ${appUrl}`);
        }
      } else if (shouldLog && process.env.BOOKS_SELECTION_NO_OPEN === '1') {
        console.log('Browser auto-open is disabled by BOOKS_SELECTION_NO_OPEN=1');
      }

      resolve({ server, url: appUrl, port: actualPort });
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createRequestHandler,
  openBrowser,
  startServer,
};
