const DEFAULT_CONFIG = {
  activeProvider: 'openrouter',
  activeEmbeddingsProvider: 'openrouter',
  providers: {
    openrouter: {
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-nano',
      embeddingModel: 'openai/text-embedding-3-small',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      budget: {
        enabled: true,
        type: 'openrouter-credits',
        creditsPath: '/credits',
        maxSessionUsageUsd: 1,
        maxSessionUsageEnv: 'BOOKS_SELECTION_OPENROUTER_MAX_SESSION_USAGE_USD',
        baselineUsageEnv: 'BOOKS_SELECTION_OPENROUTER_USAGE_BASELINE_USD',
      },
    },
    local: {
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      embeddingModel: 'local-embedding-model',
      apiKeyEnv: 'LOCAL_OPENAI_API_KEY',
    },
    hermes: {
      type: 'hermes',
      command: 'hermes',
      model: 'default',
    },
  },
};

function mergeProvider(defaultProvider, overrideProvider = {}) {
  return {
    ...defaultProvider,
    ...overrideProvider,
    budget: defaultProvider.budget || overrideProvider.budget
      ? {
        ...(defaultProvider.budget || {}),
        ...(overrideProvider.budget || {}),
      }
      : undefined,
  };
}

function numberFromEnv(env, name) {
  if (!name || env[name] === undefined || env[name] === '') {
    return undefined;
  }
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function applyBudgetEnv(provider, env) {
  if (!provider?.budget) {
    return provider;
  }

  const maxFromEnv = numberFromEnv(env, provider.budget.maxSessionUsageEnv);
  const baselineFromEnv = numberFromEnv(env, provider.budget.baselineUsageEnv);
  return {
    ...provider,
    budget: {
      ...provider.budget,
      ...(maxFromEnv !== undefined ? { maxSessionUsageUsd: maxFromEnv } : {}),
      ...(baselineFromEnv !== undefined ? { baselineUsageUsd: baselineFromEnv } : {}),
    },
  };
}

function loadProviderConfig(overrides = {}, env = process.env) {
  const openrouter = applyBudgetEnv(
    mergeProvider(DEFAULT_CONFIG.providers.openrouter, overrides.providers?.openrouter),
    env,
  );

  return {
    activeProvider: overrides.activeProvider || DEFAULT_CONFIG.activeProvider,
    activeEmbeddingsProvider: overrides.activeEmbeddingsProvider || DEFAULT_CONFIG.activeEmbeddingsProvider,
    providers: {
      openrouter,
      local: mergeProvider(DEFAULT_CONFIG.providers.local, overrides.providers?.local),
      hermes: mergeProvider(DEFAULT_CONFIG.providers.hermes, overrides.providers?.hermes),
    },
  };
}

function getApiKey(providerConfig, env = process.env) {
  if (!providerConfig) {
    return '';
  }

  if (providerConfig.apiKey) {
    return providerConfig.apiKey;
  }

  if (!providerConfig.apiKeyEnv) {
    return '';
  }

  return env[providerConfig.apiKeyEnv] || '';
}

module.exports = {
  DEFAULT_CONFIG,
  getApiKey,
  loadProviderConfig,
};
