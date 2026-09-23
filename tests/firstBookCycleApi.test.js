const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');
const { writeAppConfig } = require('../src/appConfig');

function chatResponse(result) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function passages(prompt) {
  return [...prompt.matchAll(/<untrusted_book_text id="([^"]+)" book_id="(\d+)"[^>]*>\s*([^\n]+)\s*<\/untrusted_book_text>/g)]
    .map((match) => ({ id: match[1], bookId: Number(match[2]), ...JSON.parse(match[3]) }));
}

test('connected Ask API screens 22 cycles, reports a missing review, and finds a later-volume match', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-first-cycle-api-'));
  const previous = [process.env.BOOKS_SELECTION_CONFIG_PATH, process.env.BOOKS_SELECTION_LOG_PATH];
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.BOOKS_SELECTION_LOG_PATH = path.join(dir, 'log');
  let started;
  let screenCalls = 0;
  let providerCalls = 0;
  try {
    const root = path.join(dir, 'library');
    for (let index = 1; index <= 22; index += 1) {
      const cycle = index === 21 ? 'Missing Review' : index === 22 ? 'Later Match' : `Cycle ${String(index).padStart(2, '0')}`;
      const cycleDir = path.join(root, cycle);
      await fs.mkdir(cycleDir, { recursive: true });
      const text = index === 22 ? 'nothing relevant in this opening' : `topic evidence ${index}`;
      await fs.writeFile(path.join(cycleDir, '01.fb2'), `<?xml version="1.0"?><FictionBook><description><title-info><book-title>First ${index}</book-title></title-info></description><body><section><p>${text}</p></section></body></FictionBook>`);
      if (index === 22) await fs.writeFile(path.join(cycleDir, '02.fb2'), '<?xml version="1.0"?><FictionBook><description><title-info><book-title>Later proof</book-title></title-info></description><body><section><p>topic evidence appears in the later volume</p></section></body></FictionBook>');
    }
    await writeAppConfig({ booksRoot: root, dbPath: path.join(dir, 'db.sqlite'), activeProvider: 'local', activeEmbeddingsProvider: 'local', providers: { local: { ['api' + 'Key']: 'fixture-key', model: 'fixture', embeddingModel: 'fixture' } } }, process.env);
    const providerFetchImpl = async (url, options = {}) => {
      providerCalls += 1;
      const body = JSON.parse(options.body || '{}');
      if (String(url).endsWith('/embeddings')) {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: text === 'Герой и героиня всё делают вместе' ? [0, 1] : [1, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (!String(url).endsWith('/chat/completions')) throw new Error(`Unexpected provider URL: ${url}`);
      const phase = body.messages[0].content;
      const prompt = body.messages.at(-1).content;
      if (phase.includes('plan phase')) return chatResponse({ intentType: 'question_answer', queries: [] });
      if (phase.includes('screening a small batch')) {
        screenCalls += 1;
        const rows = passages(prompt);
        return chatResponse({ candidateChecks: rows
          .filter((row) => row.cycle !== 'Missing Review')
          .map((row) => ({ bookId: row.bookId, verdict: 'uncertain', evidence: [row.id], reason: 'Needs more volumes.' })) });
      }
      const later = passages(prompt).find((row) => row.book === 'Later proof');
      assert.ok(later, 'later-volume evidence reached final provider call');
      return chatResponse({ status: 'answered', answer: 'Later Match fits.', evidence: [later.id], recommendations: [{ bookId: later.bookId, evidence: [later.id] }], finalCandidateChecks: [{ bookId: later.bookId, verdict: 'supported', evidence: [later.id], reason: 'Direct passage.', entities: [{ name: 'topic', evidence: [later.id] }], criteria: [{ criterion: 'topic', verdict: 'supported', reason: 'Direct passage.', evidence: [later.id] }] }] });
    };
    started = await startServer({ port: 0, openBrowser: false, log: false, providerFetchImpl });
    const home = await fetch(started.url);
    const cookie = home.headers.get('set-cookie').split(';')[0];
    const post = async (route, body) => {
      const response = await fetch(started.url + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post('/api/index', {})).status, 200);
    const embeddingStatus = await (await fetch(started.url + '/api/embedding-status', { headers: { cookie } })).json();
    const embedded = await post('/api/embed-index', { allRemaining: true, expectedProvider: 'local', expectedRemaining: embeddingStatus.result.remaining });
    assert.equal(embedded.status, 200, JSON.stringify(embedded.body));
    const response = await post('/api/ask', { q: 'Герой и героиня всё делают вместе' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const coverage = response.body.result.research.cycleCoverage;
    assert.equal(coverage.totalCycles, 22);
    assert.equal(coverage.firstBooksSearched, 22);
    // Semantic retrieval supplies an unrelated opening too; it is reviewed as
    // uncertain, not treated as an absent passage or a rejected cycle.
    assert.equal(coverage.firstBooksReviewed, 21);
    assert.equal(coverage.noEvidenceCycles, 0);
    assert.equal(coverage.incompleteCycles, 1);
    assert.equal(coverage.complete, false);
    assert.equal(coverage.cycles.find((row) => row.cycle === 'Missing Review').status, 'unreviewed');
    assert.equal(coverage.cycles.find((row) => row.cycle === 'Later Match').status, 'supported');
    const log = await fs.readFile(process.env.BOOKS_SELECTION_LOG_PATH, 'utf8');
    const diagnostic = log.trim().split('\n').map(JSON.parse).find(row => row.category === 'ask_diagnostic');
    assert.equal(diagnostic.version, require('../package.json').version);
    assert.equal(diagnostic.ask.intent, 'recommendation');
    assert.equal(diagnostic.ask.cycleCoveragePresent, true);
    assert.equal(diagnostic.ask.firstBooksSearched, coverage.firstBooksSearched);
    assert.equal(diagnostic.ask.firstBooksReviewed, coverage.firstBooksReviewed);
    assert.equal(diagnostic.ask.incompleteCycles, coverage.incompleteCycles);
    assert.equal(diagnostic.ask.representedBooks, response.body.result.coverage.representedBooks);
    assert.doesNotMatch(log, /fixture-key|topic evidence|Later Match fits|Герой и героиня/);
    assert.equal(screenCalls, 6);
    assert.ok(providerCalls < 40, `provider call budget unexpectedly high: ${providerCalls}`);
  } finally {
    if (started) await new Promise((resolve) => started.server.close(resolve));
    for (const [index, key] of ['BOOKS_SELECTION_CONFIG_PATH', 'BOOKS_SELECTION_LOG_PATH'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
