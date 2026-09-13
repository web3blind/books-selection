const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG, validateProviderBaseUrl } = require('./providerConfig');

const projectRoot = path.join(__dirname, '..');

function getRuntimeRoot() {
  return process.pkg ? path.dirname(process.execPath) : projectRoot;
}

function getConfigPath(env = process.env) {
  return env.BOOKS_SELECTION_CONFIG_PATH || path.join(os.homedir(), '.books-selection', 'config.json');
}

function getDefaultDbPath(env = process.env) {
  return env.BOOKS_SELECTION_DB_PATH || path.join(getRuntimeRoot(), 'data', 'books-selection.sqlite');
}

function defaultAppConfig() {
  const openrouter = DEFAULT_CONFIG.providers.openrouter;
  const local = DEFAULT_CONFIG.providers.local;
  return {
    booksRoot: '',
    dbPath: getDefaultDbPath(),
    activeProvider: DEFAULT_CONFIG.activeProvider,
    activeEmbeddingsProvider: DEFAULT_CONFIG.activeEmbeddingsProvider,
    providers: {
      openrouter: {
        baseUrl: openrouter.baseUrl,
        model: openrouter.model,
        embeddingModel: openrouter.embeddingModel,
        apiKeyEnv: openrouter.apiKeyEnv,
        apiKey: '',
        maxSessionUsageUsd: openrouter.budget.maxSessionUsageUsd,

      },
      local: {
        baseUrl: local.baseUrl,
        model: local.model,
        embeddingModel: local.embeddingModel,
        apiKeyEnv: local.apiKeyEnv,
        apiKey: '',
      },
    },
  };
}

function cleanString(value) {
  return String(value || '').trim();
}

function cleanOptionalNumber(value) {
  if (value === '' || value === undefined || value === null) {
    return '';
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : '';
}

function normalizeProviderName(value, fallback) {
  return ['openrouter', 'local'].includes(value) ? value : fallback;
}

function normalizeAppConfig(input = {}) {
  const defaults = defaultAppConfig();
  const openrouter = input.providers?.openrouter || input.openrouter || {};
  const local = input.providers?.local || input.local || {};

  return {
    booksRoot: cleanString(input.booksRoot || input.root),
    dbPath: cleanString(input.dbPath || input.db) || defaults.dbPath,
    activeProvider: normalizeProviderName(input.activeProvider, defaults.activeProvider),
    activeEmbeddingsProvider: normalizeProviderName(input.activeEmbeddingsProvider, defaults.activeEmbeddingsProvider),
    providers: {
      openrouter: {
        baseUrl: validateProviderBaseUrl('openrouter', cleanString(openrouter.baseUrl) || defaults.providers.openrouter.baseUrl),
        model: cleanString(openrouter.model) || defaults.providers.openrouter.model,
        embeddingModel: cleanString(openrouter.embeddingModel) || defaults.providers.openrouter.embeddingModel,
        apiKeyEnv: defaults.providers.openrouter.apiKeyEnv,
        apiKey: cleanString(openrouter.apiKey),
        maxSessionUsageUsd: cleanOptionalNumber(openrouter.maxSessionUsageUsd) === ''
          ? defaults.providers.openrouter.maxSessionUsageUsd
          : cleanOptionalNumber(openrouter.maxSessionUsageUsd),

      },
      local: {
        baseUrl: validateProviderBaseUrl('local', cleanString(local.baseUrl) || defaults.providers.local.baseUrl),
        model: cleanString(local.model) || defaults.providers.local.model,
        embeddingModel: cleanString(local.embeddingModel) || defaults.providers.local.embeddingModel,
        apiKeyEnv: defaults.providers.local.apiKeyEnv,
        apiKey: cleanString(local.apiKey),
      },
    },
  };
}

function isAppConfigured(config) {
  return Boolean(cleanString(config.booksRoot) && cleanString(config.dbPath));
}

function toProviderOverrides(config) {
  const normalized = normalizeAppConfig(config);
  const openrouterBudget = {
    maxSessionUsageUsd: Number(normalized.providers.openrouter.maxSessionUsageUsd),
  };


  return {
    activeProvider: normalized.activeProvider,
    activeEmbeddingsProvider: normalized.activeEmbeddingsProvider,
    providers: {
      openrouter: {
        baseUrl: normalized.providers.openrouter.baseUrl,
        model: normalized.providers.openrouter.model,
        embeddingModel: normalized.providers.openrouter.embeddingModel,
        apiKeyEnv: normalized.providers.openrouter.apiKeyEnv,
        apiKey: normalized.providers.openrouter.apiKey,
        budget: openrouterBudget,
      },
      local: {
        baseUrl: normalized.providers.local.baseUrl,
        model: normalized.providers.local.model,
        embeddingModel: normalized.providers.local.embeddingModel,
        apiKeyEnv: normalized.providers.local.apiKeyEnv,
        apiKey: normalized.providers.local.apiKey,
      },
    },
  };
}

function redactAppConfig(config, env = process.env) {
  const normalized = normalizeAppConfig(config);
  for (const providerName of ['openrouter', 'local']) {
    const provider = normalized.providers[providerName];
    provider.hasApiKey = Boolean(provider.apiKey || env[provider.apiKeyEnv]);
    provider.apiKey = '';
  }
  return normalized;
}

async function readAppConfig(env = process.env) {
  const filePath = getConfigPath(env);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: defaultAppConfig(), path: filePath, exists: false };
    }
    throw error;
  }

  try {
    return { config: normalizeAppConfig(JSON.parse(raw)), path: filePath, exists: true };
  } catch (error) {
    const invalidJson = error.name === 'SyntaxError';
    return {
      config: defaultAppConfig(),
      path: filePath,
      exists: true,
      error: {
        code: invalidJson ? 'invalid_config_json' : 'invalid_config_values',
        message: invalidJson
          ? 'Saved configuration is not valid JSON. Review and save Settings to replace it.'
          : 'Saved configuration contains invalid values. Review and save Settings to replace it.',
      },
    };
  }
}

async function writeAppConfig(input, env = process.env) {
  const filePath = getConfigPath(env);
  let existingConfig = defaultAppConfig();
  try {
    existingConfig = (await readAppConfig(env)).config;
  } catch (error) {
    if (error.name !== 'SyntaxError') {
      throw error;
    }
  }

  const mergedInput = structuredClone(input || {});
  mergedInput.providers ||= {};
  for (const providerName of ['openrouter', 'local']) {
    mergedInput.providers[providerName] ||= {};
    const submittedKey = cleanString(mergedInput.providers[providerName].apiKey);
    if (mergedInput.providers[providerName].clearApiKey === true) {
      mergedInput.providers[providerName].apiKey = '';
    } else if (!submittedKey || /^[*•]+$/.test(submittedKey)) {
      mergedInput.providers[providerName].apiKey = existingConfig.providers[providerName].apiKey;
    }
    delete mergedInput.providers[providerName].clearApiKey;
  }

  const config = normalizeAppConfig(mergedInput);
  const directory = path.dirname(filePath);
  let directoryExisted = true;
  try {
    await fs.stat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directoryExisted = false;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (!directoryExisted || path.basename(directory) === '.books-selection')) {
    await fs.chmod(directory, 0o700);
  }
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return { config, path: filePath, exists: true };
}

module.exports = {
  defaultAppConfig,
  getConfigPath,
  getDefaultDbPath,
  getRuntimeRoot,
  isAppConfigured,
  normalizeAppConfig,
  readAppConfig,
  redactAppConfig,
  toProviderOverrides,
  writeAppConfig,
};
