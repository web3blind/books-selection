const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchWithProviderContext, readJsonWithProviderContext } = require('../src/providerNetwork');

test('fetchWithProviderContext exposes the failed provider stage and safe network cause', async () => {
  const cause = Object.assign(new Error('connect ENETUNREACH 203.0.113.10:443'), { code: 'ENETUNREACH' });
  const networkError = new TypeError('fetch failed', { cause });

  await assert.rejects(
    fetchWithProviderContext(
      async () => { throw networkError; },
      'https://openrouter.ai/api/v1/credits',
      { method: 'GET', headers: { authorization: 'Bearer secret-value' } },
      'OpenRouter credits check',
    ),
    (error) => {
      assert.equal(error.code, 'PROVIDER_NETWORK_ERROR');
      assert.equal(error.providerOperation, 'OpenRouter credits check');
      assert.equal(error.endpoint, 'https://openrouter.ai');
      assert.equal(error.causeCode, 'ENETUNREACH');
      assert.match(error.message, /OpenRouter credits check/);
      assert.match(error.message, /ENETUNREACH/);
      assert.doesNotMatch(error.message, /secret-value|203\.0\.113\.10/);
      return true;
    },
  );
});

test('provider diagnostics omit unsafe codes and configurable endpoint paths', async () => {
  const failure = Object.assign(new Error('fetch failed'), { code: 'Bearer SECRET' });
  await assert.rejects(
    fetchWithProviderContext(
      async () => { throw failure; },
      'https://user:password@localhost:9443/private-token/embeddings?key=secret',
      {},
      'Provider embeddings request',
    ),
    (error) => {
      assert.equal(error.causeCode, '');
      assert.equal(error.endpoint, 'https://localhost:9443');
      assert.doesNotMatch(JSON.stringify(error), /SECRET|password|private-token|key=secret/);
      return true;
    },
  );
});

test('response-body transport failures retain provider stage while malformed JSON stays distinct', async () => {
  const bodyFailure = new TypeError('terminated', {
    cause: Object.assign(new Error('socket reset with private response'), { code: 'ECONNRESET' }),
  });
  await assert.rejects(
    readJsonWithProviderContext(
      { json: async () => { throw bodyFailure; } },
      'https://openrouter.ai/api/v1/credits',
      'OpenRouter credits response',
    ),
    (error) => error.code === 'PROVIDER_NETWORK_ERROR'
      && error.providerOperation === 'OpenRouter credits response'
      && error.causeCode === 'ECONNRESET',
  );

  await assert.rejects(
    readJsonWithProviderContext(
      { json: async () => { throw new SyntaxError('Unexpected token secret-body'); } },
      'https://openrouter.ai/api/v1/credits',
      'OpenRouter credits response',
    ),
    (error) => error.code !== 'PROVIDER_NETWORK_ERROR'
      && error.message === 'OpenRouter credits response returned invalid JSON.',
  );
});

test('provider fetch aborts after a bounded timeout and preserves caller abort support', async () => {
  let timeoutSignal;
  await assert.rejects(fetchWithProviderContext(async (_url, options) => {
    timeoutSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }, 'https://example.test/v1/chat/completions', {}, 'Provider chat completion', { timeoutMs: 5 }),
  (error) => error.code === 'PROVIDER_TIMEOUT');
  assert.equal(timeoutSignal.aborted, true);
  const caller = new AbortController();
  const pending = fetchWithProviderContext(
    async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })),
    'https://example.test/v1/embeddings', { signal: caller.signal }, 'Provider embeddings request', { timeoutMs: 1000 },
  );
  caller.abort(new Error('cancelled by caller'));
  await assert.rejects(pending, (error) => error.code === 'PROVIDER_ABORTED');
});

test('provider JSON reader rejects declared and actual oversized responses before parsing', async () => {
  await assert.rejects(readJsonWithProviderContext(
    { headers: { get: () => '1000' }, text: async () => '{"small":true}' },
    'https://example.test/v1/chat', 'Provider chat response', { maxResponseBytes: 100 },
  ), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
  await assert.rejects(readJsonWithProviderContext(
    { headers: { get: () => null }, text: async () => JSON.stringify({ value: 'x'.repeat(200) }) },
    'https://example.test/v1/chat', 'Provider chat response', { maxResponseBytes: 100 },
  ), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('provider JSON reader stops chunked bodies at the byte limit', async () => {
  let cancelled = false;
  const chunks = [Buffer.from('{"value":"'), Buffer.alloc(128, 120), Buffer.from('"}')];
  const reader = {
    async read() { return chunks.length ? { done: false, value: chunks.shift() } : { done: true }; },
    async cancel() { cancelled = true; },
    releaseLock() {},
  };
  await assert.rejects(readJsonWithProviderContext(
    { headers: { get: () => null }, body: { getReader: () => reader } },
    'https://example.test/v1/chat', 'Provider chat response', { maxResponseBytes: 64 },
  ), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('provider JSON reader preserves caller cancellation after response headers arrive', async () => {
  const caller = new AbortController();
  const reader = {
    read: () => new Promise(() => {}),
    cancel: async () => {},
    releaseLock: () => {},
  };
  const pending = readJsonWithProviderContext({
    headers: { get: () => null },
    body: { getReader: () => reader },
  }, 'https://example.test/v1/chat/completions', 'Provider chat response', {
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    signal: caller.signal,
  });
  caller.abort();
  await assert.rejects(pending, (error) => error.code === 'PROVIDER_ABORTED');
});

test('provider JSON reader times out a stalled response body', async () => {
  let cancelled = false;
  const reader = {
    async read() { return new Promise(() => {}); },
    async cancel() { cancelled = true; },
    releaseLock() {},
  };
  await assert.rejects(readJsonWithProviderContext(
    { headers: { get: () => null }, body: { getReader: () => reader } },
    'https://example.test/v1/chat', 'Provider chat response', { timeoutMs: 5 },
  ), (error) => error.code === 'PROVIDER_TIMEOUT');
  assert.equal(cancelled, true);
});
