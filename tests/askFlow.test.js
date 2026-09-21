const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');
const { writeAppConfig } = require('../src/appConfig');
const { initializeSearchDatabase } = require('../src/searchDb');
const { createAskProvider, writeAskBooks } = require('./fixtures/askProvider');

for (const embeddingProvider of ['local', 'openrouter']) {
test(`connected prepare -> guided Ask -> cache preserves data (${embeddingProvider} embeddings)`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-guided-flow-'));
  const root = path.join(dir, 'library');
  const dbPath = path.join(dir, 'search.sqlite');
  const oldConfig = process.env.BOOKS_SELECTION_CONFIG_PATH;
  const oldLog = process.env.BOOKS_SELECTION_LOG_PATH;
  process.env.BOOKS_SELECTION_LOG_PATH = path.join(dir, 'diagnostics.log');
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  let started;
  try {
    await writeAskBooks(root);
    await writeAppConfig({ booksRoot: root, dbPath, language: 'ru', activeProvider: 'local', activeEmbeddingsProvider: embeddingProvider, providers: { openrouter: { apiKey: 'controlled-fixture', embeddingModel: 'fixture-cloud-vector' }, local: { apiKey: 'fixture-only', model: 'fixture-chat', embeddingModel: 'fixture-vector' } } }, process.env);
    const calls = [];
    started = await startServer({ port: 0, openBrowser: false, log: false, providerFetchImpl: createAskProvider({ onRequest: (url, body) => calls.push({ url, body }) }) });
    const home = await fetch(started.url);
    const cookie = home.headers.get('set-cookie').split(';')[0];
    const request = async (route, payload) => {
      const response = await fetch(`${started.url}${route}`, { method: payload ? 'POST' : 'GET', headers: { cookie, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const index = await request('/api/index', { root, db: dbPath });
    assert.equal(index.result.indexed, 2);
    assert.equal(calls.length, 0, 'plain-text preparation must not call an AI');
    const status = (await request('/api/embedding-status')).result;
    assert.ok(status.remaining > 0);
    await request('/api/embed-index', { db: dbPath, expectedProvider: embeddingProvider, cloudConsent: embeddingProvider === 'openrouter', allRemaining: true, expectedRemaining: status.remaining });
    await request('/api/cycle-favorite', { cycle: 'Путь двоих', favorite: true });
    await request('/api/cycle-reading', { cycle: 'Путь двоих', read: true });
    const answer = (await request('/api/ask', { q: 'Герой и героиня вместе во всём цикле' })).result;
    assert.equal(answer.status, 'answered');
    assert.equal(answer.research.mode, 'model_guided');
    assert.ok(answer.research.phases.includes('refine'));
    assert.deepEqual(answer.cycleGroups.map((item) => item.cycle), ['Путь двоих']);
    assert.ok(answer.citedEvidence.every((item) => item.excerpt.includes('Лира')));
    assert.ok(answer.research.persistedFacts > 0);
    assert.ok(answer.research.chatCalls <= 4);
    assert.ok(answer.research.embeddingQueries <= 5);
    assert.equal(answer.research.partial, true);
    const chatCalls = calls.filter((call) => call.url.endsWith('/chat/completions'));
    assert.ok(chatCalls.every((call) => call.body.max_tokens > 0));
    assert.ok(chatCalls.every((call) => call.url.startsWith('http://127.0.0.1:')));
    const embeddingCalls = calls.filter((call) => call.url.endsWith('/embeddings'));
    assert.ok(embeddingCalls.every((call) => call.body.model === (embeddingProvider === 'openrouter' ? 'fixture-cloud-vector' : 'fixture-vector')));
    assert.ok(embeddingCalls.every((call) => call.url.startsWith(embeddingProvider === 'openrouter' ? 'https://openrouter.ai/' : 'http://127.0.0.1:')));
    assert.ok(chatCalls.every((call) => !call.body.messages.some((message) => /<FictionBook>|<binary/.test(message.content))));
    let db = initializeSearchDatabase(dbPath);
    const before = db.prepare('SELECT chunk_id, content_hash, embedding_json FROM chunk_embeddings ORDER BY chunk_id').all();
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM derived_facts').get().n > 0);
    db.close();
    const repeated = await request('/api/index', { root, db: dbPath });
    assert.equal(repeated.result.skipped, 2);
    db = initializeSearchDatabase(dbPath);
    assert.deepEqual(db.prepare('SELECT chunk_id, content_hash, embedding_json FROM chunk_embeddings ORDER BY chunk_id').all(), before);
    db.close();
    assert.equal((await request('/api/favorites')).favorites[0].cycleName, 'Путь двоих');
    assert.equal((await request('/api/reading')).states[0].isRead, true);
  } finally {
    if (started) await new Promise((resolve) => started.server.close(resolve));
    if (oldLog === undefined) delete process.env.BOOKS_SELECTION_LOG_PATH;
    else process.env.BOOKS_SELECTION_LOG_PATH = oldLog;
    if (oldConfig === undefined) delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    else process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
}
