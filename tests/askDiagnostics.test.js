const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeAskDiagnostic } = require('../src/diagnostics');

test('Ask diagnostics distinguish QA and absent research without logging payloads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-diag-'));
  const log = path.join(dir, 'errors.log');
  const env = { BOOKS_SELECTION_LOG_PATH: log };
  try {
    await writeAskDiagnostic({ status: 'answered', question: 'private query', answer: 'private answer', evidence: [{text:'private excerpt'}], research: { intentType: 'question_answer', phases: ['plan','check','final','private phase'], chatCalls: 3 }, coverage: {totalCycles:22,totalBooks:209,representedBooks:9,retrievedChunks:12} }, {model:'test-model', secrets:['secret-credential'], provider:'local'}, env);
    await writeAskDiagnostic({status:'no_evidence'}, {}, env);
    const text = await fs.readFile(log, 'utf8');
    const [qa, missing] = text.trim().split('\n').map(JSON.parse);
    assert.equal(qa.version, require('../package.json').version);
    assert.equal(qa.operation, 'ask-completed');
    assert.equal(qa.ask.intent, 'question_answer');
    assert.equal(qa.ask.cycleCoveragePresent, false);
    assert.equal(qa.ask.firstBooksReviewed, null);
    assert.equal(qa.ask.representedBooks, 9);
    assert.deepEqual(qa.ask.phases, ['plan','check','final']);
    assert.equal(missing.ask.intent, 'unknown');
    assert.equal(missing.ask.researchPresent, false);
    assert.equal(missing.ask.initialScreenComplete, null);
    assert.doesNotMatch(text, /private|secret-credential/);
    assert.equal(await writeAskDiagnostic({}, {}, {BOOKS_SELECTION_LOG_PATH:dir}), '');
  } finally { await fs.rm(dir, {recursive:true,force:true}); }
});
