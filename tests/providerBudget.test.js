const test = require('node:test');
const assert = require('node:assert/strict');

const { checkProviderBudget, parseCreditsPayload } = require('../src/providerBudget');
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
  const budgetState = new Map([['https://openrouter.ai/api/v1\u0000OPENROUTER_API_KEY\u0000openrouter-credits', 10]]);
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
