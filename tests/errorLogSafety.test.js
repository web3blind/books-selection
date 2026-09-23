const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeErrorLog } = require('../src/diagnostics');

test('logger masks secrets before truncation, rotates and survives unavailable storage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-log-safety-'));
  const log = path.join(dir, 'errors.log');
  const secret = 'private-key-for-test-only';
  const env = { BOOKS_SELECTION_LOG_PATH: log, OPENROUTER_API_KEY: secret };
  try {
    await writeErrorLog(new Error('x'.repeat(495) + secret), {}, env);
    let content = await fs.readFile(log, 'utf8');
    assert.ok(!content.includes('private'));
    await fs.writeFile(log, 'x'.repeat(1024 * 1024));
    await writeErrorLog(new Error('second failure'), { operation: 'ask' }, env);
    assert.equal((await fs.stat(log + '.1')).size, 1024 * 1024);
    assert.equal(JSON.parse(await fs.readFile(log, 'utf8')).message, 'second failure');
    assert.equal(await writeErrorLog(new Error('original'), {}, { BOOKS_SELECTION_LOG_PATH: path.join(log, 'blocked') }), '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
