const defaultBudgetState = new Map();

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getBudgetLimit(provider) {
  const value = Number(provider?.budget?.maxSessionUsageUsd);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function getBaselineKey(provider) {
  return `${provider?.baseUrl || ''}\u0000${provider?.apiKeyEnv || ''}\u0000${provider?.budget?.type || ''}`;
}

function parseCreditsPayload(payload) {
  const totalCredits = Number(payload?.data?.total_credits);
  const totalUsage = Number(payload?.data?.total_usage);

  if (!Number.isFinite(totalUsage)) {
    throw new Error('OpenRouter credits response did not include total_usage.');
  }

  return {
    totalCredits: Number.isFinite(totalCredits) ? totalCredits : null,
    totalUsage,
    remaining: Number.isFinite(totalCredits) ? totalCredits - totalUsage : null,
  };
}

async function fetchOpenRouterCredits({ provider, apiKey, fetchImpl }) {
  const creditsPath = provider?.budget?.creditsPath || '/credits';
  const response = await fetchImpl(`${trimTrailingSlash(provider.baseUrl)}${creditsPath}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter budget check failed with HTTP ${response.status}`);
  }

  return parseCreditsPayload(await response.json());
}

async function checkProviderBudget({
  provider,
  apiKey,
  fetchImpl = globalThis.fetch,
  budgetState = defaultBudgetState,
} = {}) {
  const budget = provider?.budget;
  if (!budget?.enabled) {
    return { status: 'not_configured' };
  }

  if (budget.type !== 'openrouter-credits') {
    return { status: 'unsupported_budget_type', type: budget.type };
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('OpenRouter budget check requires fetch support or injected fetchImpl.');
  }

  const credits = await fetchOpenRouterCredits({ provider, apiKey, fetchImpl });
  const key = getBaselineKey(provider);
  let baselineUsage = Number(budget.baselineUsageUsd);

  if (!Number.isFinite(baselineUsage)) {
    if (!budgetState.has(key)) {
      budgetState.set(key, credits.totalUsage);
    }
    baselineUsage = Number(budgetState.get(key));
  }

  const spentSinceBaseline = Math.max(0, credits.totalUsage - baselineUsage);
  const maxSessionUsageUsd = getBudgetLimit(provider);

  if (spentSinceBaseline >= maxSessionUsageUsd) {
    throw new Error(
      `OpenRouter budget limit reached: spent $${spentSinceBaseline.toFixed(4)} since baseline, limit $${maxSessionUsageUsd.toFixed(2)}. Provider request was not sent.`
    );
  }

  return {
    status: 'ok',
    provider: 'openrouter',
    totalCredits: credits.totalCredits,
    totalUsage: credits.totalUsage,
    remaining: credits.remaining,
    baselineUsage,
    spentSinceBaseline,
    maxSessionUsageUsd,
  };
}

module.exports = {
  checkProviderBudget,
  defaultBudgetState,
  parseCreditsPayload,
};
