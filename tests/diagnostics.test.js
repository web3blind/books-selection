const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getErrorLogPath, writeErrorLog, writeProviderNetworkDiagnostic } = require('../src/diagnostics');
const { ProviderNetworkError } = require('../src/providerNetwork');

test('provider network diagnostics write a restrictive sanitized JSONL log', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-diagnostics-'));
  const logPath = path.join(dir, 'logs', 'books-selection.log');
  const cause = Object.assign(new Error('Bearer secret-value prompt-private-text'), { code: 'ETIMEDOUT' });
  const error = new ProviderNetworkError({
    operation: 'Provider embeddings request',
    endpoint: 'https://user:secret@openrouter.ai/private-token/embeddings?key=hidden',
    causeCode: 'ETIMEDOUT',
    cause,
  });

  try {
    const writtenPath = await writeProviderNetworkDiagnostic(error, { route: '/api/ask' }, {
      BOOKS_SELECTION_LOG_PATH: logPath,
    });
    const content = await fs.readFile(logPath, 'utf8');
    const record = JSON.parse(content.trim());

    assert.equal(writtenPath, logPath);
    assert.equal(record.route, '/api/ask');
    assert.equal(record.operation, 'Provider embeddings request');
    assert.equal(record.endpoint, 'https://openrouter.ai');
    assert.equal(record.causeCode, 'ETIMEDOUT');
    assert.equal(record.message, undefined);
    assert.doesNotMatch(content, /secret-value|prompt-private-text|authorization|private-token|key=hidden/i);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('error log uses the app data directory and redacts configured secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-errors-'));
  const logPath = path.join(dir, 'data', 'errors.log');
  const apiKey = 'configured-secret-fixture';
  const error = Object.assign(new Error(`HTTP 401 Authorization: Bearer ${apiKey}`), {
    code: 'PROVIDER_HTTP_ERROR',
    statusCode: 401,
    providerOperation: 'final-recovery',
  });

  try {
    assert.equal(getErrorLogPath({ BOOKS_SELECTION_LOG_PATH: logPath }), logPath);
    await writeErrorLog(error, {
      operation: 'ask', route: '/api/ask', provider: 'local', model: 'fixture-model', secrets: [apiKey],
    }, { BOOKS_SELECTION_LOG_PATH: logPath });
    const content = await fs.readFile(logPath, 'utf8');
    const record = JSON.parse(content.trim());
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.version, require('../package.json').version);
    assert.equal(record.operation, 'ask');
    assert.equal(record.phase, 'final-recovery');
    assert.equal(record.provider, 'local');
    assert.equal(record.model, 'fixture-model');
    assert.equal(record.code, 'PROVIDER_HTTP_ERROR');
    assert.equal(record.status, 401);
    assert.doesNotMatch(content, /configured-secret-fixture|Bearer|Authorization/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('diagnostic logging preserves permissions of a pre-existing override directory', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-diagnostics-existing-'));
  const logPath = path.join(dir, 'books-selection.log');
  await fs.chmod(dir, 0o755);
  const error = new ProviderNetworkError({
    operation: 'OpenRouter credits check',
    endpoint: 'https://openrouter.ai/api/v1/credits',
    causeCode: 'ETIMEDOUT',
  });

  try {
    await writeProviderNetworkDiagnostic(error, { route: '/api/ask' }, { BOOKS_SELECTION_LOG_PATH: logPath });
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
