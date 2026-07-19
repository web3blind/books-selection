const { checkProviderBudget } = require('./providerBudget');

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parseJsonContent(content) {
  if (typeof content !== 'string') {
    return { answer: String(content || ''), confidence: 'unknown' };
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Plain text model output is acceptable for the scaffold.
  }

  return { answer: content, confidence: 'unknown' };
}

function createOpenAiCompatibleClient({
  provider,
  apiKey,
  fetchImpl = globalThis.fetch,
  budgetGuard = checkProviderBudget,
  budgetState,
}) {
  if (!provider || !provider.baseUrl || !provider.model) {
    throw new Error('OpenAI-compatible provider requires baseUrl and model.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('OpenAI-compatible provider requires fetch support or injected fetchImpl.');
  }

  async function assertBudgetAllowsRequest() {
    if (typeof budgetGuard !== 'function') {
      return { status: 'disabled' };
    }
    return budgetGuard({ provider, apiKey, fetchImpl, budgetState });
  }

  return {
    async chatCompletion({ messages, temperature = 0.2 }) {
      await assertBudgetAllowsRequest();
      const response = await fetchImpl(`${trimTrailingSlash(provider.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        throw new Error(`Provider chat completion failed with HTTP ${response.status}`);
      }

      const payload = await response.json();
      return parseJsonContent(payload?.choices?.[0]?.message?.content || '');
    },

    async createEmbedding({ input }) {
      if (!provider.embeddingModel) {
        throw new Error('OpenAI-compatible provider requires embeddingModel for embeddings.');
      }

      await assertBudgetAllowsRequest();
      const response = await fetchImpl(`${trimTrailingSlash(provider.baseUrl)}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.embeddingModel,
          input,
        }),
      });

      if (!response.ok) {
        throw new Error(`Provider embeddings request failed with HTTP ${response.status}`);
      }

      const payload = await response.json();
      const embedding = payload?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('Provider embeddings response did not include an embedding vector.');
      }
      return embedding;
    },
  };
}

module.exports = {
  createOpenAiCompatibleClient,
  parseJsonContent,
};
