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

test('embedding progress API exposes a live provider wait without rescanning the database', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-server-progress-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'search.sqlite');
  await writeAppConfig({
    booksRoot: dir,
    dbPath,
    activeProvider: 'local',
    activeEmbeddingsProvider: 'local',
    providers: {
      local: {
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'fixture-key',
        embeddingModel: 'fixture-embedding-model',
      },
    },
  }, process.env);
  const db = initializeSearchDatabase(dbPath);
  const bookId = Number(db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES ('Cycle', ?, ?, 1, 1, 'book-hash', 'Book', 'Annotation', 'indexed')
  `).run(dir, path.join(dir, 'book.fb2')).lastInsertRowid);
  db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, 0, 'progress evidence', 'chunk-hash', 0, 17)
  `).run(bookId);
  db.close();

  let markProviderStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const providerRelease = new Promise((resolve) => { releaseProvider = resolve; });
  const started = await startServer({
    port: 0,
    openBrowser: false,
    log: false,
    embeddingOperationRetentionMs: 1000,
    providerFetchImpl: async () => {
      markProviderStarted();
      await providerRelease;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  try {
    const home = await request(started, 'GET', '/');
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    const embeddingRequest = request(started, 'POST', '/api/embed-index', cookie, {
      db: dbPath,
      allRemaining: true,
      expectedRemaining: 1,
      batchSize: 1,
      expectedProvider: 'local',
      cloudConsent: false,
    });
    await providerStarted;

    const during = await request(
      started, 'GET', `/api/embedding-progress?db=${encodeURIComponent(dbPath)}`, cookie,
    );
    assert.equal(during.statusCode, 200);
    assert.equal(during.body.result.active, true);
    assert.equal(during.body.result.phase, 'requesting_provider');
    assert.equal(during.body.result.completed, 0);
    assert.equal(during.body.result.total, 1);
    assert.ok(Number.isFinite(during.body.result.startedAt));

    releaseProvider();
    const completed = await embeddingRequest;
    assert.equal(completed.statusCode, 200);

    const after = await request(
      started, 'GET', `/api/embedding-progress?db=${encodeURIComponent(dbPath)}`, cookie,
    );
    assert.equal(after.body.result.active, false);
    assert.equal(after.body.result.completed, 1);
    assert.equal(after.body.result.total, 1);

    await new Promise((resolve) => setTimeout(resolve, 1050));
    const expired = await request(
      started, 'GET', `/api/embedding-progress?db=${encodeURIComponent(dbPath)}`, cookie,
    );
    assert.equal(expired.body.result.active, false);
    assert.equal(expired.body.result.phase, 'idle');
    assert.equal(expired.body.result.total, 0);
  } finally {
    releaseProvider();
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

function providerJsonResponse(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

test('favorites API stores cycle marks, reorders them, and clears query history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-favorites-api-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'search.sqlite');
  await writeAppConfig({ booksRoot: dir, dbPath }, process.env);

  const started = await startServer({ port: 0, openBrowser: false, log: false });
  try {
    const home = await request(started, 'GET', '/');
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    const favoritesUrl = `/api/favorites?db=${encodeURIComponent(dbPath)}`;

    assert.equal((await request(started, 'GET', favoritesUrl)).statusCode, 403);

    const added = await request(started, 'POST', '/api/cycle-favorite', cookie, { db: dbPath, cycle: 'Dragon Cycle' });
    assert.equal(added.statusCode, 200);
    assert.equal(added.body.result.created, true);
    assert.equal(added.body.result.sortPosition, 1);

    const second = await request(started, 'POST', '/api/cycle-favorite', cookie, { db: dbPath, cycle: 'Forest Cycle' });
    assert.equal(second.body.result.sortPosition, 2);

    const list = await request(started, 'GET', favoritesUrl, cookie);
    assert.equal(list.body.count, 2);
    assert.deepEqual(list.body.favorites.map((favorite) => favorite.cycleName), ['Dragon Cycle', 'Forest Cycle']);
    assert.equal(list.body.favorites[0].rating, 0);

    const moved = await request(started, 'POST', '/api/favorites/reorder', cookie, {
      db: dbPath, cycle: 'Forest Cycle', direction: 'up',
    });
    assert.equal(moved.body.result.moved, true);
    const reordered = await request(started, 'GET', favoritesUrl, cookie);
    assert.deepEqual(reordered.body.favorites.map((favorite) => favorite.cycleName), ['Forest Cycle', 'Dragon Cycle']);

    const rebuilt = await request(started, 'POST', '/api/favorites/reorder', cookie, { db: dbPath, action: 'rating' });
    assert.equal(rebuilt.statusCode, 200);
    assert.equal(rebuilt.body.result.reordered, 2);

    assert.equal((await request(started, 'POST', '/api/favorites/reorder', cookie, {
      db: dbPath, cycle: 'Forest Cycle', direction: 'sideways',
    })).statusCode, 400);
    assert.equal((await request(started, 'POST', '/api/cycle-favorite', cookie, { db: dbPath, cycle: '   ' })).statusCode, 400);
    assert.equal((await request(started, 'POST', '/api/cycle-favorite', cookie, { db: dbPath, cycle: 'x'.repeat(201) })).statusCode, 400);
    const viaConfig = await request(started, 'POST', '/api/cycle-favorite', cookie, { cycle: 'Config Cycle' });
    assert.equal(viaConfig.statusCode, 200);
    assert.equal(viaConfig.body.db, dbPath);

    const cleared = await request(started, 'POST', '/api/favorites/clear-history', cookie, { db: dbPath });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.body.result.cleared, 0);

    const removed = await request(started, 'POST', '/api/cycle-favorite', cookie, {
      db: dbPath, cycle: 'Forest Cycle', favorite: false,
    });
    assert.equal(removed.body.result.removed, true);
    const remaining = await request(started, 'GET', favoritesUrl, cookie);
    assert.equal(remaining.body.count, 2);
    assert.deepEqual(remaining.body.favorites.map((favorite) => favorite.cycleName).sort(), ['Config Cycle', 'Dragon Cycle']);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    else process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reading API stores read and unfinished marks for cycles', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-reading-api-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'search.sqlite');
  await writeAppConfig({ booksRoot: dir, dbPath }, process.env);

  const started = await startServer({ port: 0, openBrowser: false, log: false });
  try {
    const home = await request(started, 'GET', '/');
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    const readingUrl = `/api/reading?db=${encodeURIComponent(dbPath)}`;

    assert.equal((await request(started, 'GET', readingUrl)).statusCode, 403);
    assert.equal((await request(started, 'GET', readingUrl, cookie)).body.count, 0);

    const marked = await request(started, 'POST', '/api/cycle-reading', cookie, {
      db: dbPath, cycle: 'Dragon Cycle', read: true,
    });
    assert.equal(marked.statusCode, 200);
    assert.equal(marked.body.result.read.isRead, true);

    const unfinished = await request(started, 'POST', '/api/cycle-reading', cookie, {
      db: dbPath, cycle: 'Dragon Cycle', unfinished: true,
    });
    assert.equal(unfinished.body.result.unfinished.isUnfinished, true);

    const list = await request(started, 'GET', readingUrl, cookie);
    assert.equal(list.body.count, 1);
    assert.equal(list.body.states[0].cycleName, 'Dragon Cycle');
    assert.equal(list.body.states[0].isRead, true);
    assert.equal(list.body.states[0].isUnfinished, true);
    assert.equal(typeof list.body.states[0].updatedAt, 'number');

    const cleared = await request(started, 'POST', '/api/cycle-reading', cookie, {
      db: dbPath, cycle: 'Dragon Cycle', read: false,
    });
    assert.equal(cleared.body.result.read.isRead, false);

    const afterClear = await request(started, 'GET', readingUrl, cookie);
    assert.equal(afterClear.body.states[0].isRead, false);
    assert.equal(afterClear.body.states[0].isUnfinished, true);

    assert.equal((await request(started, 'POST', '/api/cycle-reading', cookie, { db: dbPath, cycle: '   ' })).statusCode, 400);
    assert.equal((await request(started, 'POST', '/api/cycle-reading', cookie, { db: dbPath, cycle: 'Dragon Cycle' })).statusCode, 400);
    assert.equal((await request(started, 'POST', '/api/cycle-reading', cookie, {
      db: dbPath, cycle: 'x'.repeat(201), read: true,
    })).statusCode, 400);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    else process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Ask records ranked cycle hits for favorited cycles through the local API', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-favorites-ask-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  const oldLocalKey = process.env.LOCAL_OPENAI_API_KEY;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.LOCAL_OPENAI_API_KEY = 'fixture-local-key';
  const dbPath = path.join(dir, 'search.sqlite');
  await writeAppConfig({
    booksRoot: dir,
    dbPath,
    activeProvider: 'local',
    activeEmbeddingsProvider: 'local',
  }, process.env);

  const db = initializeSearchDatabase(dbPath);
  const bookId = Number(db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
    VALUES ('Dragon Cycle', ?, ?, 1, 1, 'book-hash', 'Book', 'Annotation', 'indexed', ?)
  `).run(dir, path.join(dir, 'book.fb2'), dir).lastInsertRowid);
  const chunkId = Number(db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, 0, 'indexed evidence about a lantern', 'chunk-hash', 0, 32)
  `).run(bookId).lastInsertRowid);
  db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(chunkId, 'indexed evidence about a lantern');
  db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, provider, model, content_hash, embedding_json)
    VALUES (?, 'local', 'local-embedding-model', 'chunk-hash', '[1,0]')
  `).run(chunkId);
  db.prepare(`
    INSERT INTO corpus_state
      (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
    VALUES (1, ?, 1, 1, 1, 1, 1, 0, 1)
  `).run(dir);
  db.close();

  const providerRequests = [];
  const started = await startServer({
    port: 0,
    openBrowser: false,
    log: false,
    providerFetchImpl: async (requestUrl, options = {}) => {
      providerRequests.push(String(requestUrl));
      if (String(requestUrl).endsWith('/embeddings')) {
        const body = JSON.parse(options.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return providerJsonResponse({ data: inputs.map((_, index) => ({ index, embedding: [1, 0] })) });
      }
      if (String(requestUrl).endsWith('/chat/completions')) {
        return providerJsonResponse({
          choices: [{ message: { content: JSON.stringify({ answer: 'Фонарь найден.', confidence: 'high', evidence: ['evidence_1'] }) } }],
        });
      }
      throw new Error(`Unexpected provider request in the favorites API test: ${requestUrl}`);
    },
  });

  try {
    const home = await request(started, 'GET', '/');
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    await request(started, 'POST', '/api/cycle-favorite', cookie, { db: dbPath, cycle: 'Dragon Cycle' });

    const answer = await request(started, 'POST', '/api/ask', cookie, { db: dbPath, q: 'Где фонарь?' });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body.result.status, 'answered');
    assert.deepEqual(answer.body.result.cycleGroups.map((group) => group.cycle), ['Dragon Cycle']);

    await request(started, 'POST', '/api/ask', cookie, { db: dbPath, q: 'где   ФОНАРЬ?' });

    const favorites = await request(started, 'GET', `/api/favorites?db=${encodeURIComponent(dbPath)}`, cookie);
    assert.equal(favorites.body.count, 1);
    const [favorite] = favorites.body.favorites;
    assert.equal(favorite.rating, 5, 'a repeated query must not add points twice');
    assert.equal(favorite.leaderCount, 1);
    assert.equal(favorite.queryCount, 1);
    assert.deepEqual(favorite.hits.map((hit) => hit.bestPosition), [1]);
    assert.ok(providerRequests.some((requestUrl) => requestUrl.endsWith('/chat/completions')));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    else process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    if (oldLocalKey === undefined) delete process.env.LOCAL_OPENAI_API_KEY;
    else process.env.LOCAL_OPENAI_API_KEY = oldLocalKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
