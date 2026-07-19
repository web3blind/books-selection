const DEFAULT_CONFIG = {
  activeProvider: 'openrouter',
  providers: {
    openrouter: {
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-nano',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    local: {
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
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
  };
}

function loadProviderConfig(overrides = {}, env = process.env) {
  void env;

  return {
    activeProvider: overrides.activeProvider || DEFAULT_CONFIG.activeProvider,
    providers: {
      openrouter: mergeProvider(DEFAULT_CONFIG.providers.openrouter, overrides.providers?.openrouter),
      local: mergeProvider(DEFAULT_CONFIG.providers.local, overrides.providers?.local),
      hermes: mergeProvider(DEFAULT_CONFIG.providers.hermes, overrides.providers?.hermes),
    },
  };
}

function getApiKey(providerConfig, env = process.env) {
  if (!providerConfig || !providerConfig.apiKeyEnv) {
    return '';
  }

  return env[providerConfig.apiKeyEnv] || '';
}

module.exports = {
  DEFAULT_CONFIG,
  getApiKey,
  loadProviderConfig,
};
