const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');
const { writeAppConfig } = require('../src/appConfig');
const { createAskProvider, writeAskBooks } = require('./fixtures/askProvider');

for (const mode of ['fenced', 'missing-citations', 'truncated', 'insufficient', 'invalid-twice', 'truncated-twice']) {
  test(`real Ask API handles ${mode} provider output`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-recovery-'));
    const previous = [process.env.BOOKS_SELECTION_CONFIG_PATH, process.env.BOOKS_SELECTION_LOG_PATH];
    process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
    process.env.BOOKS_SELECTION_LOG_PATH = path.join(dir, 'log');
    let started;
    let finalCalls = 0;
    try {
      const root = path.join(dir, 'library');
      await writeAskBooks(root);
      await writeAppConfig({ booksRoot: root, dbPath: path.join(dir, 'db.sqlite'), language: 'ru', activeProvider: 'local', activeEmbeddingsProvider: 'local', providers: { local: { apiKey: 'fixture', model: 'fixture', embeddingModel: 'fixture' } } }, process.env);
      const base = createAskProvider();
      const providerFetchImpl = async (url, options) => {
        const response = await base(url, options);
        const request = JSON.parse(options.body || '{}');
        if (!url.endsWith('/chat/completions') || !/final(?:-recovery)? phase/.test(request.messages[0].content)) return response;
        finalCalls++;
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
      if (mode.endsWith('-twice')) {
        assert.notEqual(result.status, 200);
        assert.equal(finalCalls, 2);
        assert.doesNotMatch(JSON.stringify(result.body), /Unsupported output/);
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
