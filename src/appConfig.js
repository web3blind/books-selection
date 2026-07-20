const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG } = require('./providerConfig');

function getConfigPath(env = process.env) {
  return env.BOOKS_SELECTION_CONFIG_PATH || path.join(os.homedir(), '.books-selection', 'config.json');
}

function defaultAppConfig() {
  const openrouter = DEFAULT_CONFIG.providers.openrouter;
  const local = DEFAULT_CONFIG.providers.local;
  return {
    booksRoot: '',
    dbPath: '',
    activeProvider: DEFAULT_CONFIG.activeProvider,
    activeEmbeddingsProvider: DEFAULT_CONFIG.activeEmbeddingsProvider,
    providers: {
      openrouter: {
        baseUrl: openrouter.baseUrl,
        model: openrouter.model,
        embeddingModel: openrouter.embeddingModel,
        apiKeyEnv: openrouter.apiKeyEnv,
        maxSessionUsageUsd: openrouter.budget.maxSessionUsageUsd,
        baselineUsageUsd: '',
      },
      local: {
        baseUrl: local.baseUrl,
        model: local.model,
        embeddingModel: local.embeddingModel,
        apiKeyEnv: local.apiKeyEnv,
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
  return ['openrouter', 'local', 'hermes'].includes(value) ? value : fallback;
}

function normalizeAppConfig(input = {}) {
  const defaults = defaultAppConfig();
  const openrouter = input.providers?.openrouter || input.openrouter || {};
  const local = input.providers?.local || input.local || {};

  return {
    booksRoot: cleanString(input.booksRoot || input.root),
    dbPath: cleanString(input.dbPath || input.db),
    activeProvider: normalizeProviderName(input.activeProvider, defaults.activeProvider),
    activeEmbeddingsProvider: normalizeProviderName(input.activeEmbeddingsProvider, defaults.activeEmbeddingsProvider),
    providers: {
      openrouter: {
        baseUrl: cleanString(openrouter.baseUrl) || defaults.providers.openrouter.baseUrl,
        model: cleanString(openrouter.model) || defaults.providers.openrouter.model,
        embeddingModel: cleanString(openrouter.embeddingModel) || defaults.providers.openrouter.embeddingModel,
        apiKeyEnv: cleanString(openrouter.apiKeyEnv) || defaults.providers.openrouter.apiKeyEnv,
        maxSessionUsageUsd: cleanOptionalNumber(openrouter.maxSessionUsageUsd) || defaults.providers.openrouter.maxSessionUsageUsd,
        baselineUsageUsd: cleanOptionalNumber(openrouter.baselineUsageUsd),
      },
      local: {
        baseUrl: cleanString(local.baseUrl) || defaults.providers.local.baseUrl,
        model: cleanString(local.model) || defaults.providers.local.model,
        embeddingModel: cleanString(local.embeddingModel) || defaults.providers.local.embeddingModel,
        apiKeyEnv: cleanString(local.apiKeyEnv) || defaults.providers.local.apiKeyEnv,
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
    maxSessionUsageUsd: Number(normalized.providers.openrouter.maxSessionUsageUsd) || 1,
  };
  if (normalized.providers.openrouter.baselineUsageUsd !== '') {
    openrouterBudget.baselineUsageUsd = Number(normalized.providers.openrouter.baselineUsageUsd);
  }

  return {
    activeProvider: normalized.activeProvider,
    activeEmbeddingsProvider: normalized.activeEmbeddingsProvider,
    providers: {
      openrouter: {
        baseUrl: normalized.providers.openrouter.baseUrl,
        model: normalized.providers.openrouter.model,
        embeddingModel: normalized.providers.openrouter.embeddingModel,
        apiKeyEnv: normalized.providers.openrouter.apiKeyEnv,
        budget: openrouterBudget,
      },
      local: {
        baseUrl: normalized.providers.local.baseUrl,
        model: normalized.providers.local.model,
        embeddingModel: normalized.providers.local.embeddingModel,
        apiKeyEnv: normalized.providers.local.apiKeyEnv,
      },
    },
  };
}

async function readAppConfig(env = process.env) {
  const filePath = getConfigPath(env);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { config: normalizeAppConfig(JSON.parse(raw)), path: filePath, exists: true };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: defaultAppConfig(), path: filePath, exists: false };
    }
    throw error;
  }
}

async function writeAppConfig(input, env = process.env) {
  const filePath = getConfigPath(env);
  const config = normalizeAppConfig(input);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { config, path: filePath, exists: true };
}

module.exports = {
  defaultAppConfig,
  getConfigPath,
  isAppConfigured,
  normalizeAppConfig,
  readAppConfig,
  toProviderOverrides,
  writeAppConfig,
};
