const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  getDefaultDbPath,
  isAppConfigured,
  normalizeAppConfig,
  readAppConfig,
  redactAppConfig,
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
  assert.equal(config.providers.openrouter.baselineUsageUsd, undefined);
  assert.equal(isAppConfigured(config), true);
  assert.equal(config.providers.openrouter.apiKey, 'api-key-fixture');
});

test('app config missing file defaults SQLite database to project data folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-'));
  const env = { BOOKS_SELECTION_CONFIG_PATH: path.join(dir, 'config.json') };

  try {
    const missing = await readAppConfig(env);
    assert.equal(missing.config.dbPath, getDefaultDbPath());
    assert.match(missing.config.dbPath, /data[\\/]books-selection\.sqlite$/);
    assert.equal(isAppConfigured(missing.config), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('app config read recovers defaults and exposes an error state for malformed JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-malformed-'));
  const configPath = path.join(dir, 'config.json');
  const env = { BOOKS_SELECTION_CONFIG_PATH: configPath };

  try {
    await fs.writeFile(configPath, '{not-json');

    const state = await readAppConfig(env);

    assert.equal(state.exists, true);
    assert.equal(state.config.booksRoot, '');
    assert.equal(state.error.code, 'invalid_config_json');
    assert.match(state.error.message, /valid JSON/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('app config read recovers defaults from values that fail provider validation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-invalid-'));
  const configPath = path.join(dir, 'config.json');
  const env = { BOOKS_SELECTION_CONFIG_PATH: configPath };
  try {
    await fs.writeFile(configPath, JSON.stringify({ providers: { openrouter: { baseUrl: 'https://attacker.example/v1' } } }));
    const state = await readAppConfig(env);
    assert.equal(state.exists, true);
    assert.equal(state.config.booksRoot, '');
    assert.equal(state.error.code, 'invalid_config_values');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
  assert.equal(overrides.providers.openrouter.budget.baselineUsageUsd, undefined);
  assert.equal(overrides.providers.openrouter.apiKey, 'openrouter-key-fixture');
});

test('app config keeps Hermes unavailable until its transport adapter exists', () => {
  const config = normalizeAppConfig({ activeProvider: 'hermes', activeEmbeddingsProvider: 'hermes' });
  assert.equal(config.activeProvider, 'openrouter');
  assert.equal(config.activeEmbeddingsProvider, 'openrouter');
});

test('app config preserves a zero OpenRouter session budget', () => {
  const config = normalizeAppConfig({ providers: { openrouter: { maxSessionUsageUsd: 0 } } });
  const overrides = toProviderOverrides(config);

  assert.equal(config.providers.openrouter.maxSessionUsageUsd, 0);
  assert.equal(overrides.providers.openrouter.budget.maxSessionUsageUsd, 0);
});

test('app config redaction reports key presence without returning saved or environment keys', () => {
  const redacted = redactAppConfig(normalizeAppConfig({
    providers: {
      openrouter: { apiKey: 'saved-secret' },
      local: { apiKey: '' },
    },
  }), { LOCAL_OPENAI_API_KEY: 'environment-secret' });

  assert.equal(redacted.providers.openrouter.apiKey, '');
  assert.equal(redacted.providers.openrouter.hasApiKey, true);
  assert.equal(redacted.providers.local.apiKey, '');
  assert.equal(redacted.providers.local.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(redacted), /saved-secret|environment-secret/);
});

test('writing blank or masked API key fields preserves existing saved keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-'));
  const env = { BOOKS_SELECTION_CONFIG_PATH: path.join(dir, 'config.json') };

  try {
    await writeAppConfig({
      providers: {
        openrouter: { apiKey: 'saved-openrouter-secret' },
        local: { apiKey: 'saved-local-secret' },
      },
    }, env);
    await writeAppConfig({
      providers: {
        openrouter: { apiKey: '' },
        local: { apiKey: '********' },
      },
    }, env);

    const readBack = await readAppConfig(env);
    assert.equal(readBack.config.providers.openrouter.apiKey, 'saved-openrouter-secret');
    assert.equal(readBack.config.providers.local.apiKey, 'saved-local-secret');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAppConfig clears a saved API key only through an explicit clear action', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-clear-'));
  const env = { BOOKS_SELECTION_CONFIG_PATH: path.join(dir, 'config.json') };
  try {
    await writeAppConfig({ providers: { openrouter: { apiKey: 'saved-secret' } } }, env);
    await writeAppConfig({ providers: { openrouter: { apiKey: '', clearApiKey: true } } }, env);
    const readBack = await readAppConfig(env);
    assert.equal(readBack.config.providers.openrouter.apiKey, '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAppConfig repairs restrictive permissions on existing config paths', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-config-mode-'));
  const configPath = path.join(dir, '.books-selection', 'config.json');
  const env = { ...process.env, BOOKS_SELECTION_CONFIG_PATH: configPath };
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o755 });
  await fs.writeFile(configPath, '{}', { mode: 0o644 });

  try {
    await writeAppConfig({ booksRoot: '/books' }, env);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
