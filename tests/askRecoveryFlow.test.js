const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');
const { writeAppConfig } = require('../src/appConfig');
const { createAskProvider, writeAskBooks } = require('./fixtures/askProvider');

for (const mode of ['fenced', 'missing-citations', 'truncated', 'insufficient', 'invalid-twice', 'truncated-twice', 'http-failure']) {
  test(`real Ask API handles ${mode} provider output`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-recovery-'));
    const previous = [process.env.BOOKS_SELECTION_CONFIG_PATH, process.env.BOOKS_SELECTION_LOG_PATH];
    process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
    process.env.BOOKS_SELECTION_LOG_PATH = path.join(dir, 'data', 'errors.log');
    let started;
    let finalCalls = 0;
    try {
      const root = path.join(dir, 'library');
      await writeAskBooks(root);
      await writeAppConfig({ booksRoot: root, dbPath: path.join(dir, 'db.sqlite'), language: 'ru', activeProvider: 'local', activeEmbeddingsProvider: 'local', providers: { local: { apiKey: 'fixture-key', model: 'fixture', embeddingModel: 'fixture' } } }, process.env);
      const base = createAskProvider();
      const providerFetchImpl = async (url, options) => {
        const response = await base(url, options);
        const request = JSON.parse(options.body || '{}');
        if (!url.endsWith('/chat/completions') || !/final(?:-recovery)? phase/.test(request.messages[0].content)) return response;
        finalCalls++;
        if (mode === 'http-failure') return new Response('', { status: 401 });
        const payload = await response.json();
        const choice = payload.choices[0];
        choice.finish_reason = 'stop';
        if (mode === 'fenced') choice.message.content = '```json\n' + choice.message.content + '\n```';
        if (mode === 'missing-citations' && finalCalls === 1) choice.message.content = JSON.stringify({ answer: 'Unsupported output', recommendations: [] });
        if ((mode === 'truncated' && finalCalls === 1) || mode === 'truncated-twice') {
          choice.finish_reason = 'length';
          // Even syntactically complete JSON is not a complete provider turn.
        }
        if (mode === 'insufficient') choice.message.content = JSON.stringify({ status: 'evidence_insufficient', answer: 'Do not expose arbitrary model prose', recommendations: [], evidence: [] });
        if (mode === 'invalid-twice') choice.message.content = JSON.stringify({ answer: 'Unsupported output', evidence: ['invented_id'], recommendations: [] });
        return { ok: true, status: 200, json: async () => payload };
      };
      started = await startServer({ port: 0, openBrowser: false, log: false, providerFetchImpl });
      const home = await fetch(started.url);
      const cookie = home.headers.get('set-cookie').split(';')[0];
      const post = async (route, body) => {
        const response = await fetch(started.url + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      assert.equal((await post('/api/index', {})).status, 200);
      const readiness = await (await fetch(started.url + '/api/embedding-status', { headers: { cookie } })).json();
      const prepared = await post('/api/embed-index', { allRemaining: true, expectedProvider: 'local', expectedRemaining: readiness.result.remaining });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      await post('/api/cycle-favorite', { cycle: 'Путь двоих', favorite: true });
      const result = await post('/api/ask', { q: 'Где Лира и Марк путешествуют вместе?' });
      if (mode.endsWith('-twice') || mode === 'http-failure') {
        assert.notEqual(result.status, 200);
        assert.equal(finalCalls, mode === 'http-failure' ? 1 : 2);
        assert.doesNotMatch(JSON.stringify(result.body), /Unsupported output/);
        const errorLog = await fs.readFile(process.env.BOOKS_SELECTION_LOG_PATH, 'utf8');
        const record = JSON.parse(errorLog.trim().split('\n').at(-1));
        assert.equal(record.operation, 'ask');
        assert.equal(record.phase, mode === 'http-failure' ? 'Provider chat completion' : 'final-recovery');
        assert.equal(record.provider, 'local');
        assert.equal(record.model, 'fixture');
        assert.equal(record.code, mode === 'http-failure' ? 'PROVIDER_HTTP_ERROR' : 'PROVIDER_PROTOCOL_ERROR');
        if (mode === 'http-failure') assert.equal(record.status, 401);
        if (mode.endsWith('-twice')) {
          assert.deepEqual(record.ask.validationReasons, [mode === 'truncated-twice' ? 'truncated' : 'invalid_evidence']);
          assert.equal(record.ask.finishReason, mode === 'truncated-twice' ? 'length' : 'stop');
          assert.equal(record.ask.intent, 'question_answer');
          assert.equal(record.ask.chatCalls, 4);
          assert.equal(record.ask.retrievedChunks > 0, true);
        }
        assert.doesNotMatch(errorLog, /Unsupported output|Лира|Марк|fixture-key/i);
      } else {
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.result.status, mode === 'insufficient' ? 'evidence_insufficient' : 'answered');
        assert.equal(finalCalls, ['missing-citations', 'truncated'].includes(mode) ? 2 : 1);
        if (mode === 'insufficient') {
          assert.deepEqual(result.body.result.candidates, []);
          assert.equal(result.body.result.research.persistedFacts, 0);
          assert.doesNotMatch(JSON.stringify(result.body), /Do not expose arbitrary/);
        } else assert.ok(result.body.result.citedEvidence.length > 0);
      }
    } finally {
      if (started) await new Promise(resolve => started.server.close(resolve));
      for (const [i, key] of ['BOOKS_SELECTION_CONFIG_PATH', 'BOOKS_SELECTION_LOG_PATH'].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
