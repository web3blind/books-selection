const test = require('node:test');
const assert = require('node:assert/strict');

const { checkProviderBudget, getBudgetSessionKey, parseCreditsPayload } = require('../src/providerBudget');
const { createOpenAiCompatibleClient } = require('../src/providerClient');

const openRouterProvider = {
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
  },
};

test('parseCreditsPayload reads OpenRouter total credits and usage', () => {
  const result = parseCreditsPayload({ data: { total_credits: 5, total_usage: 1.25 } });

  assert.equal(result.totalCredits, 5);
  assert.equal(result.totalUsage, 1.25);
  assert.equal(result.remaining, 3.75);
});

test('checkProviderBudget establishes a baseline and allows requests below the session limit', async () => {
  const calls = [];
  const budgetState = new Map();
  const result = await checkProviderBudget({
    provider: openRouterProvider,
    apiKey: 'secret-key',
    budgetState,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { total_credits: 5, total_usage: 0.25 } };
        },
      };
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.baselineUsage, 0.25);
  assert.equal(result.spentSinceBaseline, 0);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/credits');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-key');
  assert.doesNotMatch(JSON.stringify(result), /secret-key/);
});

test('createOpenAiCompatibleClient blocks provider calls after OpenRouter session budget is reached', async () => {
  const calledUrls = [];
  const budgetState = new Map([[getBudgetSessionKey(openRouterProvider, 'secret-key'), 10]]);
  const client = createOpenAiCompatibleClient({
    provider: openRouterProvider,
    apiKey: 'secret-key',
    budgetState,
    fetchImpl: async (url) => {
      calledUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          if (String(url).endsWith('/credits')) {
            return { data: { total_credits: 20, total_usage: 11.01 } };
          }
          return { choices: [{ message: { content: '{"answer":"should not happen"}' } }] };
        },
      };
    },
  });

  await assert.rejects(
    () => client.chatCompletion({ messages: [{ role: 'user', content: 'test' }] }),
    /OpenRouter budget limit reached/,
  );
  assert.deepEqual(calledUrls, ['https://openrouter.ai/api/v1/credits']);
});

test('createOpenAiCompatibleClient checks OpenRouter budget before embeddings requests too', async () => {
  const calledUrls = [];
  const budgetState = new Map();
  const client = createOpenAiCompatibleClient({
    provider: openRouterProvider,
    apiKey: 'secret-key',
    budgetState,
    fetchImpl: async (url) => {
      calledUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          if (String(url).endsWith('/credits')) {
            return { data: { total_credits: 20, total_usage: 3 } };
          }
          return { data: [{ embedding: [0.1, 0.2] }] };
        },
      };
    },
  });

  const embedding = await client.createEmbedding({ input: 'chunk' });

  assert.deepEqual(embedding, [0.1, 0.2]);
  assert.deepEqual(calledUrls, [
    'https://openrouter.ai/api/v1/credits',
    'https://openrouter.ai/api/v1/embeddings',
  ]);
});

test('zero OpenRouter budget blocks paid calls without being replaced by the default', async () => {
  const calledUrls = [];
  const client = createOpenAiCompatibleClient({
    provider: { ...openRouterProvider, budget: { ...openRouterProvider.budget, maxSessionUsageUsd: 0 } },
    apiKey: 'zero-budget-key',
    fetchImpl: async (url) => {
      calledUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() { return { data: { total_credits: 20, total_usage: 0 } }; },
      };
    },
  });

  await assert.rejects(
    () => client.chatCompletion({ messages: [{ role: 'user', content: 'test' }] }),
    /budget limit reached/,
  );
  assert.deepEqual(calledUrls, ['https://openrouter.ai/api/v1/credits']);
});

test('budget session key distinguishes credentials without containing raw keys', () => {
  const first = getBudgetSessionKey(openRouterProvider, 'credential-one');
  const second = getBudgetSessionKey(openRouterProvider, 'credential-two');

  assert.notEqual(first, second);
  assert.doesNotMatch(first, /credential-one/);
  assert.doesNotMatch(second, /credential-two/);
});

test('provider client identifies whether credits or chat networking failed', async () => {
  const networkFailure = () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('private detail'), { code: 'ECONNRESET' }) });
  };
  await assert.rejects(
    checkProviderBudget({ provider: openRouterProvider, apiKey: 'test-key', fetchImpl: networkFailure }),
    (error) => error.code === 'PROVIDER_NETWORK_ERROR' && error.providerOperation === 'OpenRouter credits check',
  );

  const client = createOpenAiCompatibleClient({
    provider: { ...openRouterProvider, budget: { enabled: false } },
    apiKey: 'test-key',
    fetchImpl: networkFailure,
  });
  await assert.rejects(
    client.chatCompletion({ messages: [{ role: 'user', content: 'test' }] }),
    (error) => error.code === 'PROVIDER_NETWORK_ERROR' && error.providerOperation === 'Provider chat completion',
  );
});

test('provider client identifies response-body transport failures', async () => {
  const bodyFailureResponse = {
    ok: true,
    status: 200,
    json: async () => {
      throw new TypeError('terminated', {
        cause: Object.assign(new Error('private body detail'), { code: 'ECONNRESET' }),
      });
    },
  };
  await assert.rejects(
    checkProviderBudget({
      provider: openRouterProvider,
      apiKey: 'test-key',
      fetchImpl: async () => bodyFailureResponse,
    }),
    (error) => error.code === 'PROVIDER_NETWORK_ERROR'
      && error.providerOperation === 'OpenRouter credits response',
  );

  const client = createOpenAiCompatibleClient({
    provider: { ...openRouterProvider, budget: { enabled: false } },
    apiKey: 'test-key',
    fetchImpl: async () => bodyFailureResponse,
  });
  await assert.rejects(
    client.chatCompletion({ messages: [{ role: 'user', content: 'test' }] }),
    (error) => error.code === 'PROVIDER_NETWORK_ERROR'
      && error.providerOperation === 'Provider chat response',
  );
});

test('budget guard rejects a configured baseline later than current provider usage', async () => {
  await assert.rejects(
    () => checkProviderBudget({
      provider: {
        ...openRouterProvider,
        budget: { ...openRouterProvider.budget, baselineUsageUsd: 11 },
      },
      apiKey: 'baseline-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { return { data: { total_credits: 20, total_usage: 10 } }; },
      }),
    }),
    /baseline cannot exceed current OpenRouter usage/,
  );
});

test('concurrent paid calls serialize budget check and provider operation per credential', async () => {
  let usage = 0;
  let paidCalls = 0;
  const client = createOpenAiCompatibleClient({
    provider: {
      ...openRouterProvider,
      budget: { ...openRouterProvider.budget, baselineUsageUsd: 0 },
    },
    apiKey: 'concurrent-key',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/credits')) {
        const snapshot = usage;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ok: true,
          status: 200,
          async json() { return { data: { total_credits: 20, total_usage: snapshot } }; },
        };
      }
      paidCalls += 1;
      usage += 1.1;
      return {
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content: '{"answer":"ok"}' } }] }; },
      };
    },
  });

  const results = await Promise.allSettled([
    client.chatCompletion({ messages: [{ role: 'user', content: 'first' }] }),
    client.chatCompletion({ messages: [{ role: 'user', content: 'second' }] }),
  ]);

  assert.equal(paidCalls, 1);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /budget limit reached/);
});

test('budget reports soft stop-after semantics and chat completions always have a bounded output', async () => {
  let chatBody;
  const provider = { ...openRouterProvider, maxOutputTokens: 600, budget: { ...openRouterProvider.budget, baselineUsageUsd: 0 } };
  const client = createOpenAiCompatibleClient({
    provider, apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/credits')) return { ok: true, status: 200, json: async () => ({ data: { total_credits: 20, total_usage: 0.25 } }) };
      chatBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"ok"}' } }] }) };
    },
  });
  const budget = await checkProviderBudget({
    provider, apiKey: 'secret-key',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { total_usage: 0.25 } }) }),
  });
  await client.chatCompletion({ messages: [{ role: 'user', content: 'test' }], maxTokens: 50_000 });
  assert.equal(budget.enforcement, 'soft_stop_after_threshold');
  assert.equal(budget.requestReservationUsd, null);
  assert.equal(chatBody.max_tokens, 600);
});
