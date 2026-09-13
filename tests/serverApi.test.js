const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-server-api-'));
}

async function writeSampleBook(root) {
  const folder = path.join(root, 'Api Cycle');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'book.fb2'), `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>API Indexed Book</book-title>
        <annotation><p>Annotation stays browsable.</p></annotation>
      </title-info>
    </description>
    <body><section><p>Локальный поиск находит слово фонарь внутри тела книги.</p></section></body>
  </FictionBook>`);
}

function requestRaw(port, method, pathname, { payload, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = rawBody !== undefined
      ? rawBody
      : payload === undefined ? '' : JSON.stringify(payload);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...headers,
        ...(body && headers['content-length'] === undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: responseBody,
      }));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function requestJson(port, method, pathname, payload, headers = {}) {
  const requestHeaders = payload === undefined
    ? headers
    : { 'content-type': 'application/json', ...headers };
  const response = await requestRaw(port, method, pathname, { payload, headers: requestHeaders });
  return { ...response, body: JSON.parse(response.body) };
}

async function getApiCookie(port) {
  const response = await requestRaw(port, 'GET', '/');
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie']?.[0] || '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  return setCookie.split(';', 1)[0];
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stdout.on('data', (data) => {
      const text = data.toString('utf8');
      const match = text.match(/Books Selection started: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (data) => {
      const text = data.toString('utf8');
      if (!text.includes('ExperimentalWarning')) {
        reject(new Error(text));
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

function spawnTestServer(root, configPath, port = 0) {
  return spawn(process.execPath, ['src/server.js', root, String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOOKS_SELECTION_NO_OPEN: '1',
      BOOKS_SELECTION_CONFIG_PATH: configPath,
      OPENROUTER_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('server preserves /api/books and exposes local index/search/ask/fact endpoints', async () => {
  const root = await createTempRoot();
  await writeSampleBook(root);
  const dbPath = path.join(root, 'search.sqlite');
  const configPath = path.join(root, 'app-config.json');
  const port = 33000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['src/server.js', root, String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, BOOKS_SELECTION_NO_OPEN: '1', BOOKS_SELECTION_CONFIG_PATH: configPath, OPENROUTER_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    const apiCookie = await getApiCookie(port);
    const apiRequest = (method, pathname, payload) => requestJson(
      port,
      method,
      pathname,
      payload,
      { cookie: apiCookie },
    );

    const configBefore = await apiRequest('GET', '/api/config');
    const configSaved = await apiRequest('POST', '/api/config', {
      booksRoot: root,
      dbPath,
      activeProvider: 'local',
      activeEmbeddingsProvider: 'local',
      providers: {
        openrouter: {
          model: 'openai/gpt-4.1-nano',
          embeddingModel: 'openai/text-embedding-3-small',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          apiKey: 'openrouter-key-fixture',
          maxSessionUsageUsd: 2,
        },
      },
    });
    const configAfter = await apiRequest('GET', '/api/config');
    const configCleared = await apiRequest('POST', '/api/config', {
      booksRoot: root,
      dbPath,
      activeProvider: 'local',
      activeEmbeddingsProvider: 'local',
      providers: { openrouter: { clearApiKey: true } },
    });
    const books = await apiRequest('GET', '/api/books');
    const indexed = await apiRequest('POST', '/api/index', { root, db: dbPath });
    const hits = await apiRequest('GET', `/api/search?q=${encodeURIComponent('фонарь')}&db=${encodeURIComponent(dbPath)}`);
    const answer = await apiRequest('POST', '/api/ask', { q: 'Где есть фонарь?', db: dbPath });
    const extracted = await apiRequest('POST', '/api/extract-fact', {
      q: 'Есть ли фонарь?', bookId: 1, factKey: 'has_lantern', factType: 'plot_trait', db: dbPath,
    });
    const semantic = await apiRequest('POST', '/api/semantic-search', { q: 'Где есть фонарь?', db: dbPath });
    const embedIndex = await apiRequest('POST', '/api/embed-index', { db: dbPath, limit: 2 });

    assert.equal(configBefore.statusCode, 200);
    assert.equal(configBefore.body.isConfigured, false);
    assert.equal(configSaved.statusCode, 200);
    assert.equal(configSaved.body.isConfigured, true);
    assert.equal(configSaved.body.config.providers.openrouter.maxSessionUsageUsd, 2);
    assert.equal(configSaved.body.config.providers.openrouter.apiKey, '');
    assert.equal(configSaved.body.config.providers.openrouter.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(configSaved.body), /openrouter-key-fixture/);
    assert.equal(configAfter.body.config.booksRoot, root);
    assert.equal(configAfter.body.config.dbPath, dbPath);
    assert.equal(configCleared.statusCode, 200);
    assert.equal(configCleared.body.config.providers.openrouter.hasApiKey, false);
    assert.equal(books.statusCode, 200);
    assert.equal(books.body.books[0].title, 'API Indexed Book');
    assert.equal(indexed.statusCode, 200);
    assert.deepEqual(indexed.body.result, { indexed: 1, skipped: 0, errors: 0, total: 1, removed: 0 });
    assert.equal(hits.statusCode, 200);
    assert.equal(hits.body.query, 'фонарь');
    assert.equal(hits.body.count, 1);
    assert.equal(hits.body.results[0].title, 'API Indexed Book');
    assert.match(hits.body.results[0].text, /фонарь/);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body.query, 'Где есть фонарь?');
    assert.equal(answer.body.result.status, 'needs_provider_key');
    assert.equal(answer.body.result.evidence.length, 1);
    assert.equal(answer.body.result.checked.books[0], 'API Indexed Book');
    assert.equal(extracted.statusCode, 200);
    assert.equal(extracted.body.query, 'Есть ли фонарь?');
    assert.equal(extracted.body.result.status, 'needs_provider_key');
    assert.equal(extracted.body.result.factKey, 'has_lantern');
    assert.equal(extracted.body.result.factType, 'plot_trait');
    assert.equal(extracted.body.result.evidence.length, 1);
    assert.equal(extracted.body.result.setup.apiKeyEnv, 'LOCAL_OPENAI_API_KEY');
    assert.equal(semantic.statusCode, 200);
    assert.equal(semantic.body.query, 'Где есть фонарь?');
    assert.equal(semantic.body.result.status, 'needs_embedding_provider_key');
    assert.deepEqual(semantic.body.result.results, []);
    assert.equal(semantic.body.result.setup.apiKeyEnv, 'LOCAL_OPENAI_API_KEY');
    assert.equal(embedIndex.statusCode, 200);
    assert.equal(embedIndex.body.result.status, 'needs_embedding_provider_key');
    assert.equal(embedIndex.body.result.embedded, 0);
    assert.equal(embedIndex.body.result.remaining, 1);
    assert.equal(embedIndex.body.result.setup.apiKeyEnv, 'LOCAL_OPENAI_API_KEY');
  } finally {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('server keeps root and config endpoints usable when saved config JSON is malformed', async () => {
  const root = await createTempRoot();
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, '{not-json');
  const child = spawnTestServer(root, configPath);

  try {
    const port = await waitForServer(child);
    const rootResponse = await requestRaw(port, 'GET', '/');
    const cookie = rootResponse.headers['set-cookie'][0].split(';', 1)[0];
    const broken = await requestJson(port, 'GET', '/api/config', undefined, { cookie });
    const saved = await requestJson(port, 'POST', '/api/config', {
      booksRoot: root,
      dbPath: path.join(root, 'search.sqlite'),
    }, { cookie });
    const readBack = JSON.parse(await fs.readFile(configPath, 'utf8'));

    assert.equal(rootResponse.statusCode, 200);
    assert.equal(broken.statusCode, 200);
    assert.equal(broken.body.configError.code, 'invalid_config_json');
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.configError, undefined);
    assert.equal(readBack.booksRoot, root);
  } finally {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('server API rejects missing launch token, hostile Host, and cross-origin requests', async () => {
  const root = await createTempRoot();
  const child = spawnTestServer(root, path.join(root, 'config.json'));

  try {
    const port = await waitForServer(child);
    const missingToken = await requestJson(port, 'GET', '/api/config');
    const hostileHost = await requestRaw(port, 'GET', '/', {
      headers: { host: `attacker.example:${port}` },
    });
    const cookie = await getApiCookie(port);
    const hostileOrigin = await requestJson(port, 'GET', '/api/config', undefined, {
      cookie,
      origin: 'https://attacker.example',
    });
    const paidGet = await requestJson(port, 'GET', '/api/ask?q=test', undefined, { cookie });

    assert.equal(missingToken.statusCode, 403);
    assert.equal(hostileHost.statusCode, 403);
    assert.equal(hostileOrigin.statusCode, 403);
    assert.equal(paidGet.statusCode, 405);
  } finally {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('server API returns clean errors for unsupported content types and malformed or oversized JSON', async () => {
  const root = await createTempRoot();
  const child = spawnTestServer(root, path.join(root, 'config.json'));

  try {
    const port = await waitForServer(child);
    const cookie = await getApiCookie(port);
    const commonHeaders = { cookie };
    const unsupported = await requestRaw(port, 'POST', '/api/config', {
      rawBody: '{}',
      headers: { ...commonHeaders, 'content-type': 'text/plain' },
    });
    const malformed = await requestRaw(port, 'POST', '/api/config', {
      rawBody: '{not-json',
      headers: { ...commonHeaders, 'content-type': 'application/json' },
    });
    const oversized = await requestRaw(port, 'POST', '/api/config', {
      rawBody: '{}',
      headers: {
        ...commonHeaders,
        'content-type': 'application/json',
        'content-length': String((1024 * 1024) + 1),
      },
    });

    assert.equal(unsupported.statusCode, 415);
    assert.match(JSON.parse(unsupported.body).error, /application\/json/);
    assert.equal(malformed.statusCode, 400);
    assert.match(JSON.parse(malformed.body).error, /valid JSON/);
    assert.equal(oversized.statusCode, 413);
    assert.match(JSON.parse(oversized.body).error, /too large/);
  } finally {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});
