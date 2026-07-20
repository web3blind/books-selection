const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  isAppConfigured,
  normalizeAppConfig,
  readAppConfig,
  toProviderOverrides,
  writeAppConfig,
} = require('../src/appConfig');

test('app config normalizes settings and stores explicitly provided local API keys', () => {
  const config = normalizeAppConfig({
    booksRoot: ' /books ',
    dbPath: ' /tmp/books.sqlite ',
    activeProvider: 'openrouter',
    providers: {
      openrouter: {
        model: 'openai/gpt-4.1-nano',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        apiKey: 'api-key-fixture',
        maxSessionUsageUsd: '2',
        baselineUsageUsd: '10.5',
      },
    },
    apiKey: 'api-key-fixture',
  });

  assert.equal(config.booksRoot, '/books');
  assert.equal(config.dbPath, '/tmp/books.sqlite');
  assert.equal(config.providers.openrouter.maxSessionUsageUsd, 2);
  assert.equal(config.providers.openrouter.baselineUsageUsd, 10.5);
  assert.equal(isAppConfigured(config), true);
  assert.equal(config.providers.openrouter.apiKey, 'api-key-fixture');
});

test('app config read returns defaults for missing file and write persists normalized config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-'));
  const env = { BOOKS_SELECTION_CONFIG_PATH: path.join(dir, 'config.json') };

  try {
    const missing = await readAppConfig(env);
    assert.equal(missing.exists, false);
    assert.equal(isAppConfigured(missing.config), false);

    const written = await writeAppConfig({ booksRoot: '/books', dbPath: '/tmp/books.sqlite' }, env);
    const readBack = await readAppConfig(env);

    assert.equal(written.exists, true);
    assert.equal(readBack.exists, true);
    assert.equal(readBack.config.booksRoot, '/books');
    assert.equal(readBack.config.dbPath, '/tmp/books.sqlite');
    assert.equal(readBack.config.providers.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('app config converts UI settings to provider overrides for AI calls', () => {
  const overrides = toProviderOverrides(normalizeAppConfig({
    activeProvider: 'local',
    activeEmbeddingsProvider: 'openrouter',
    providers: {
      openrouter: {
        maxSessionUsageUsd: 2,
        baselineUsageUsd: 5,
        apiKey: 'openrouter-key-fixture',
      },
      local: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-chat',
        embeddingModel: 'local-embed',
      },
    },
  }));

  assert.equal(overrides.activeProvider, 'local');
  assert.equal(overrides.activeEmbeddingsProvider, 'openrouter');
  assert.equal(overrides.providers.local.model, 'local-chat');
  assert.equal(overrides.providers.openrouter.budget.maxSessionUsageUsd, 2);
  assert.equal(overrides.providers.openrouter.budget.baselineUsageUsd, 5);
  assert.equal(overrides.providers.openrouter.apiKey, 'openrouter-key-fixture');
});
