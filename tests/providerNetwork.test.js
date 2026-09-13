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
