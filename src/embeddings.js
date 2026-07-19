const { getApiKey, loadProviderConfig } = require('./providerConfig');
const { createOpenAiCompatibleClient } = require('./providerClient');

function assertEmbedding(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('Embedding must be an array of finite numbers.');
  }
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      return 0;
    }
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function storeChunkEmbedding(db, { chunkId, provider, model, contentHash, embedding }) {
  assertEmbedding(embedding);

  return db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, provider, model, content_hash, embedding_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    chunkId,
    provider,
    model,
    contentHash,
    JSON.stringify(embedding),
  );
}

function parseEmbeddingJson(value) {
  const parsed = JSON.parse(value);
  assertEmbedding(parsed);
  return parsed;
}

function semanticSearchChunks(db, queryEmbedding, options = {}) {
  assertEmbedding(queryEmbedding);

  const provider = options.provider;
  const model = options.model;
  if (!provider || !model) {
    throw new Error('Semantic search requires provider and model.');
  }

  const limit = options.limit || 20;
  const rows = db.prepare(`
    SELECT
      chunk_embeddings.chunk_id,
      chunk_embeddings.embedding_json,
      chunks.book_id,
      chunks.chunk_index,
      chunks.text,
      chunks.content_hash,
      books.cycle_name,
      books.title
    FROM chunk_embeddings
    JOIN chunks ON chunks.id = chunk_embeddings.chunk_id
    JOIN books ON books.id = chunks.book_id
    WHERE chunk_embeddings.provider = ? AND chunk_embeddings.model = ?
  `).all(provider, model);

  return rows
    .map((row) => ({
      chunk_id: row.chunk_id,
      book_id: row.book_id,
      chunk_index: row.chunk_index,
      text: row.text,
      content_hash: row.content_hash,
      cycle_name: row.cycle_name,
      title: row.title,
      score: cosineSimilarity(queryEmbedding, parseEmbeddingJson(row.embedding_json)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function createEmbeddingSetup({ providerName, provider }) {
  return {
    provider: providerName,
    apiKeyEnv: provider?.apiKeyEnv || '',
    message: provider?.apiKeyEnv
      ? `Set ${provider.apiKeyEnv} to enable semantic query embeddings.`
      : 'Configure an embeddings provider API key to enable semantic search.',
  };
}

async function embedQueryIfConfigured({
  query,
  providerOverrides = {},
  env = process.env,
  fetchImpl,
  providerClient,
} = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    throw new Error('Semantic query is required.');
  }

  const config = loadProviderConfig(providerOverrides, env);
  const providerName = config.activeEmbeddingsProvider || config.activeProvider;
  const provider = config.providers[providerName];
  const apiKey = getApiKey(provider, env);

  if (!provider || provider.type !== 'openai-compatible' || !provider.embeddingModel) {
    return {
      status: 'needs_embedding_provider_setup',
      embedding: null,
      setup: createEmbeddingSetup({ providerName, provider }),
    };
  }

  if (!apiKey) {
    return {
      status: 'needs_embedding_provider_key',
      embedding: null,
      setup: createEmbeddingSetup({ providerName, provider }),
    };
  }

  const client = providerClient || createOpenAiCompatibleClient({ provider, apiKey, fetchImpl });
  const embedding = await client.createEmbedding({ input: trimmedQuery });

  return {
    status: 'embedded',
    provider: providerName,
    model: provider.embeddingModel,
    embedding,
  };
}

async function semanticSearchIfConfigured({ db, query, providerOverrides = {}, env = process.env, fetchImpl, limit = 20 } = {}) {
  const embeddingResult = await embedQueryIfConfigured({ query, providerOverrides, env, fetchImpl });
  if (embeddingResult.status !== 'embedded') {
    return {
      status: embeddingResult.status,
      query: String(query || '').trim(),
      results: [],
      setup: embeddingResult.setup,
    };
  }

  const results = semanticSearchChunks(db, embeddingResult.embedding, {
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    limit,
  });

  return {
    status: 'searched',
    query: String(query || '').trim(),
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    count: results.length,
    results,
  };
}

module.exports = {
  cosineSimilarity,
  embedQueryIfConfigured,
  semanticSearchChunks,
  semanticSearchIfConfigured,
  storeChunkEmbedding,
};
