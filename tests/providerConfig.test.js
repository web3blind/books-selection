const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProviderConfig, getApiKey } = require('../src/providerConfig');

test('provider config defaults to OpenRouter with a cheap configurable model and env key reference', () => {
  const config = loadProviderConfig({}, {});

  assert.equal(config.activeProvider, 'openrouter');
  assert.equal(config.providers.openrouter.type, 'openai-compatible');
  assert.equal(config.providers.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.providers.openrouter.model, 'openai/gpt-4.1-nano');
  assert.equal(config.providers.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
});

test('provider config supports local OpenAI-compatible and optional Hermes modes', () => {
  const config = loadProviderConfig({
    activeProvider: 'local',
    providers: {
      local: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-fiction-model',
      },
      hermes: {
        command: 'hermes',
        model: 'nous-local',
      },
    },
  }, {});

  assert.equal(config.activeProvider, 'local');
  assert.equal(config.providers.local.type, 'openai-compatible');
  assert.equal(config.providers.local.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(config.providers.local.model, 'local-fiction-model');
  assert.equal(config.providers.hermes.type, 'hermes');
  assert.equal(config.providers.hermes.command, 'hermes');
  assert.equal(config.providers.hermes.model, 'nous-local');
});

test('api key lookup reads configured environment variable without exposing all env values', () => {
  const config = loadProviderConfig({}, { OPENROUTER_API_KEY: 'secret-value', OTHER_SECRET: 'do-not-leak' });

  const result = getApiKey(config.providers.openrouter, { OPENROUTER_API_KEY: 'secret-value', OTHER_SECRET: 'do-not-leak' });

  assert.equal(result, 'secret-value');
  assert.deepEqual(Object.keys(config.providers.openrouter).sort(), ['apiKeyEnv', 'baseUrl', 'model', 'type'].sort());
});
