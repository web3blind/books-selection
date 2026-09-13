const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createRequestHandler, startServer } = require('../src/server');
const { writeAppConfig } = require('../src/appConfig');
const { initializeSearchDatabase } = require('../src/searchDb');

function request(started, method, pathname, cookie, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(`${started.url}${pathname}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        }),
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        let parsedBody = responseBody;
        try {
          parsedBody = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          // The root route intentionally returns HTML; callers may only need its headers.
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('server module is importable for Electron without immediately listening', () => {
  assert.equal(typeof createRequestHandler, 'function');
  assert.equal(typeof startServer, 'function');
});

test('startServer can run on an ephemeral port without opening a browser', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-server-module-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');

  const started = await startServer({ port: 0, openBrowser: false, log: false });
  try {
    assert.ok(started.port > 0);
    const cookie = await new Promise((resolve, reject) => {
      http.get(started.url, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['set-cookie'][0].split(';', 1)[0]));
      }).on('error', reject);
    });
    const response = await new Promise((resolve, reject) => {
      http.get(`${started.url}/api/config`, { headers: { cookie } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.isConfigured, false);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) {
      delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    } else {
      process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('all-remaining API does not probe or rebuild a fully cached corpus beyond approved volume', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-server-full-cache-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'search.sqlite');
  await writeAppConfig({
    booksRoot: dir,
    dbPath,
    activeProvider: 'openrouter',
    activeEmbeddingsProvider: 'openrouter',
    providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-key' } },
  }, process.env);
  const db = initializeSearchDatabase(dbPath);
  const bookId = Number(db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES ('Cycle', ?, ?, 1, 1, 'book-hash', 'Book', 'Annotation', 'indexed')
  `).run(dir, path.join(dir, 'book.fb2')).lastInsertRowid);
  const chunkId = Number(db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, 0, 'cached evidence', 'chunk-hash', 0, 15)
  `).run(bookId).lastInsertRowid);
  db.prepare(`INSERT INTO chunk_embeddings
    (chunk_id, provider, model, content_hash, embedding_json)
    VALUES (?, 'openrouter', 'openai/text-embedding-3-small', 'chunk-hash', '[1,2]')`).run(chunkId);
  db.close();

  let fetchCalls = 0;
  const started = await startServer({
    port: 0,
    openBrowser: false,
    log: false,
    providerFetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('provider must not be called for approved volume zero');
    },
  });

  try {
    const home = await request(started, 'GET', '/', null);
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    const response = await request(started, 'POST', '/api/embed-index', cookie, {
      db: dbPath,
      expectedProvider: 'openrouter',
      cloudConsent: true,
      allRemaining: true,
      expectedRemaining: 0,
    });
    const verifiedDb = initializeSearchDatabase(dbPath);
    const stored = verifiedDb.prepare('SELECT embedding_json FROM chunk_embeddings WHERE chunk_id = ?').get(chunkId);
    verifiedDb.close();

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.result.embedded, 0);
    assert.equal(response.body.result.remaining, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(stored.embedding_json, '[1,2]');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    else process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('desktop provider fetch is injected through the server and network failures create a safe log', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-server-fetch-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  const oldLogPath = process.env.BOOKS_SELECTION_LOG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.BOOKS_SELECTION_LOG_PATH = path.join(dir, 'logs', 'books-selection.log');
  await writeAppConfig({
    booksRoot: dir,
    dbPath: path.join(dir, 'search.sqlite'),
    activeProvider: 'openrouter',
    activeEmbeddingsProvider: 'openrouter',
    providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key' } },
  }, process.env);
  const db = initializeSearchDatabase(path.join(dir, 'search.sqlite'));
  const bookId = Number(db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES ('Cycle', ?, ?, 1, 1, 'book-hash', 'Book', 'Annotation', 'indexed')
  `).run(dir, path.join(dir, 'book.fb2')).lastInsertRowid);
  const chunkId = Number(db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, 0, 'indexed evidence', 'chunk-hash', 0, 16)
  `).run(bookId).lastInsertRowid);
  db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(chunkId, 'indexed evidence');
  db.close();
  let fetchCalls = 0;
  const started = await startServer({
    port: 0,
    openBrowser: false,
    log: false,
    providerFetchImpl: async () => {
      fetchCalls += 1;
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('Bearer test-key private prompt'), { code: 'ETIMEDOUT' }),
      });
    },
  });

  try {
    const home = await request(started, 'GET', '/');
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    const mismatchedConsent = await request(started, 'POST', '/api/embed-index', cookie, {
      db: path.join(dir, 'search.sqlite'), expectedProvider: 'local', cloudConsent: false,
    });
    const missingConsent = await request(started, 'POST', '/api/embed-index', cookie, {
      db: path.join(dir, 'search.sqlite'), expectedProvider: 'openrouter', cloudConsent: false,
    });
    const missingVolume = await request(started, 'POST', '/api/embed-index', cookie, {
      db: path.join(dir, 'search.sqlite'), expectedProvider: 'openrouter', cloudConsent: true, allRemaining: true,
    });
    const staleVolume = await request(started, 'POST', '/api/embed-index', cookie, {
      db: path.join(dir, 'search.sqlite'), expectedProvider: 'openrouter', cloudConsent: true,
      allRemaining: true, expectedRemaining: 0,
    });
    assert.equal(mismatchedConsent.statusCode, 409);
    assert.equal(missingConsent.statusCode, 400);
    assert.equal(missingVolume.statusCode, 400);
    assert.equal(staleVolume.statusCode, 409);
    assert.match(staleVolume.body.error, /осталось 1 фрагментов/);
    assert.equal(fetchCalls, 0);
    const routes = [
      ['/api/ask', { q: 'indexed evidence' }],
      ['/api/semantic-search', { q: 'indexed evidence' }],
      ['/api/embed-index', { limit: 1, expectedProvider: 'openrouter', cloudConsent: true }],
      ['/api/extract-fact', { q: 'indexed evidence', bookId, factKey: 'test_fact' }],
    ];
    const responses = [];
    for (const [route, payload] of routes) {
      responses.push(await request(started, 'POST', route, cookie, {
        ...payload,
        db: path.join(dir, 'search.sqlite'),
      }));
    }
    const log = await fs.readFile(process.env.BOOKS_SELECTION_LOG_PATH, 'utf8');

    assert.equal(fetchCalls, routes.length);
    for (const response of responses) {
      assert.equal(response.statusCode, 500);
      assert.match(response.body.error, /OpenRouter credits check/);
      assert.match(response.body.error, /books-selection\.log/);
    }
    assert.equal(log.trim().split('\n').length, routes.length);
    for (const [route] of routes) assert.match(log, new RegExp(route.replace('/', '\\/')));
    assert.doesNotMatch(log, /test-key|private prompt|private question/);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    else process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    if (oldLogPath === undefined) delete process.env.BOOKS_SELECTION_LOG_PATH;
    else process.env.BOOKS_SELECTION_LOG_PATH = oldLogPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
