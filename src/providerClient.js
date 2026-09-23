const { checkProviderBudget, runWithProviderBudget } = require('./providerBudget');
const { fetchWithProviderContext, readJsonWithProviderContext } = require('./providerNetwork');

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS_CAP = 4096;

function boundedOutputTokens(requested, configured) {
  const configuredValue = Number(configured);
  const providerMaximum = Number.isInteger(configuredValue) && configuredValue > 0
    ? Math.min(configuredValue, MAX_OUTPUT_TOKENS_CAP)
    : MAX_OUTPUT_TOKENS_CAP;
  const requestedValue = Number(requested);
  return Number.isInteger(requestedValue) && requestedValue > 0
    ? Math.min(requestedValue, providerMaximum)
    : (Number.isInteger(configuredValue) && configuredValue > 0 ? providerMaximum : DEFAULT_MAX_OUTPUT_TOKENS);
}

function networkLimits(provider) {
  return { timeoutMs: provider.requestTimeoutMs, maxResponseBytes: provider.maxResponseBytes };
}

function providerHttpError(operation, status) {
  const error = new Error(`${operation} failed with HTTP ${status}`);
  error.code = 'PROVIDER_HTTP_ERROR';
  error.status = Number(status);
  error.providerOperation = operation;
  return error;
}

function withProviderResponse(value, metadata) {
  Object.defineProperty(value, '_providerResponse', {
    value: metadata,
    enumerable: false,
  });
  return value;
}

function parseJsonContent(content, { finishReason = '' } = {}) {
  if (typeof content !== 'string') {
    return withProviderResponse(
      { answer: String(content || ''), confidence: 'unknown' },
      { parsedJson: false, finishReason: String(finishReason || '') },
    );
  }

  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return withProviderResponse(parsed, {
        parsedJson: true,
        finishReason: String(finishReason || ''),
      });
    }
  } catch {
    // Plain text output remains available to legacy callers; metadata marks it as non-JSON.
  }

  return withProviderResponse(
    { answer: content, confidence: 'unknown' },
    { parsedJson: false, finishReason: String(finishReason || '') },
  );
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

  async function runBudgeted(operation) {
    if (typeof budgetGuard !== 'function') {
      return operation();
    }
    return runWithProviderBudget({
      provider,
      apiKey,
      fetchImpl,
      budgetState,
      budgetGuard,
      operation,
    });
  }

  async function requestEmbeddings(input, expectedCount, signal) {
    if (!provider.embeddingModel) {
      throw new Error('OpenAI-compatible provider requires embeddingModel for embeddings.');
    }

    return runBudgeted(async () => {
      const requestUrl = `${trimTrailingSlash(provider.baseUrl)}/embeddings`;
      const response = await fetchWithProviderContext(fetchImpl, requestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: provider.embeddingModel, input }),
        signal,
      }, 'Provider embeddings request', networkLimits(provider));

      if (!response.ok) {
        throw providerHttpError('Provider embeddings request', response.status);
      }

      const payload = await readJsonWithProviderContext(response, requestUrl, 'Provider embeddings response', { ...networkLimits(provider), signal });
      const rows = Array.isArray(payload?.data) ? [...payload.data] : [];
      const indexedRows = rows.filter((row) => Number.isInteger(row?.index));
      let embeddings;
      if (indexedRows.length > 0) {
        const indices = indexedRows.map((row) => row.index);
        const validIndices = indexedRows.length === expectedCount
          && new Set(indices).size === expectedCount
          && indices.every((index) => index >= 0 && index < expectedCount);
        if (!validIndices) {
          throw new Error('Provider embeddings response included invalid or duplicate indices.');
        }
        embeddings = Array(expectedCount);
        for (const row of indexedRows) embeddings[row.index] = row.embedding;
      } else {
        embeddings = rows.map((row) => row?.embedding);
      }
      if (embeddings.length !== expectedCount || embeddings.some((embedding) => !Array.isArray(embedding))) {
        throw new Error('Provider embeddings response did not include all requested embedding vectors.');
      }
      return embeddings;
    });
  }

  return {
    async chatCompletion({ messages, temperature = 0.2, maxTokens, signal } = {}) {
      return runBudgeted(async () => {
        const requestUrl = `${trimTrailingSlash(provider.baseUrl)}/chat/completions`;
        const response = await fetchWithProviderContext(fetchImpl, requestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: provider.model,
            messages,
            temperature,
            max_tokens: boundedOutputTokens(maxTokens, provider.maxOutputTokens),
            response_format: { type: 'json_object' },
          }),
          signal,
        }, 'Provider chat completion', networkLimits(provider));

        if (!response.ok) {
          throw providerHttpError('Provider chat completion', response.status);
        }

        const payload = await readJsonWithProviderContext(response, requestUrl, 'Provider chat response', { ...networkLimits(provider), signal });
        const choice = payload?.choices?.[0];
        return parseJsonContent(choice?.message?.content || '', { finishReason: choice?.finish_reason });
      });
    },

    async createEmbedding({ input, signal }) {
      const embeddings = await requestEmbeddings(input, 1, signal);
      return embeddings[0];
    },

    async createEmbeddings({ inputs, signal }) {
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new Error('OpenAI-compatible provider requires at least one embedding input.');
      }
      return requestEmbeddings(inputs, inputs.length, signal);
    },
  };
}

module.exports = {
  createOpenAiCompatibleClient,
  parseJsonContent,
};
