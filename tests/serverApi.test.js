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

function requestJson(port, method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: body ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      } : undefined,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stdout.on('data', (data) => {
      if (data.toString('utf8').includes('Books Selection started:')) {
        clearTimeout(timeout);
        resolve();
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

    const configBefore = await requestJson(port, 'GET', '/api/config');
    const configSaved = await requestJson(port, 'POST', '/api/config', {
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
    const configAfter = await requestJson(port, 'GET', '/api/config');
    const books = await requestJson(port, 'GET', '/api/books');
    const indexed = await requestJson(port, 'POST', '/api/index');
    const hits = await requestJson(port, 'GET', `/api/search?q=${encodeURIComponent('фонарь')}&db=${encodeURIComponent(dbPath)}`);
    const answer = await requestJson(port, 'GET', `/api/ask?q=${encodeURIComponent('Где есть фонарь?')}&db=${encodeURIComponent(dbPath)}`);
    const extracted = await requestJson(port, 'GET', `/api/extract-fact?q=${encodeURIComponent('Есть ли фонарь?')}&bookId=1&factKey=${encodeURIComponent('has_lantern')}&factType=${encodeURIComponent('plot_trait')}&db=${encodeURIComponent(dbPath)}`);
    const semantic = await requestJson(port, 'GET', `/api/semantic-search?q=${encodeURIComponent('Где есть фонарь?')}&db=${encodeURIComponent(dbPath)}`);
    const embedIndex = await requestJson(port, 'POST', `/api/embed-index?db=${encodeURIComponent(dbPath)}&limit=2`);

    assert.equal(configBefore.statusCode, 200);
    assert.equal(configBefore.body.isConfigured, false);
    assert.equal(configSaved.statusCode, 200);
    assert.equal(configSaved.body.isConfigured, true);
    assert.equal(configSaved.body.config.providers.openrouter.maxSessionUsageUsd, 2);
    assert.equal(configSaved.body.config.providers.openrouter.apiKey, 'openrouter-key-fixture');
    assert.equal(configAfter.body.config.booksRoot, root);
    assert.equal(configAfter.body.config.dbPath, dbPath);
    assert.equal(books.statusCode, 200);
    assert.equal(books.body.books[0].title, 'API Indexed Book');
    assert.equal(indexed.statusCode, 200);
    assert.deepEqual(indexed.body.result, { indexed: 1, skipped: 0, errors: 0, total: 1 });
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
