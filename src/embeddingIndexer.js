const { storeChunkEmbedding } = require('./embeddings');
const { getApiKey, loadProviderConfig } = require('./providerConfig');
const { createOpenAiCompatibleClient } = require('./providerClient');

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function createEmbeddingSetup({ providerName, provider }) {
  return {
    provider: providerName,
    apiKeyEnv: provider?.apiKeyEnv || '',
    message: provider?.apiKeyEnv
      ? `Set ${provider.apiKeyEnv} to enable chunk embedding indexing.`
      : 'Configure an embeddings provider API key to enable chunk embedding indexing.',
  };
}

function getEmbeddingProvider(providerOverrides, env) {
  const config = loadProviderConfig(providerOverrides, env);
  const providerName = config.activeEmbeddingsProvider || config.activeProvider;
  const provider = config.providers[providerName];
  return { providerName, provider, apiKey: getApiKey(provider, env) };
}

function countChunks(db) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM chunks').get().count);
}

function countChunksWithCurrentEmbedding(db, { provider, model }) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunks
    WHERE EXISTS (
      SELECT 1
      FROM chunk_embeddings
      WHERE chunk_embeddings.chunk_id = chunks.id
        AND chunk_embeddings.provider = ?
        AND chunk_embeddings.model = ?
        AND chunk_embeddings.content_hash = chunks.content_hash
    )
  `).get(provider, model).count);
}

function selectChunksMissingEmbeddings(db, { provider, model, limit }) {
  return db.prepare(`
    SELECT chunks.id, chunks.text, chunks.content_hash
    FROM chunks
    WHERE NOT EXISTS (
      SELECT 1
      FROM chunk_embeddings
      WHERE chunk_embeddings.chunk_id = chunks.id
        AND chunk_embeddings.provider = ?
        AND chunk_embeddings.model = ?
        AND chunk_embeddings.content_hash = chunks.content_hash
    )
    ORDER BY chunks.id
    LIMIT ?
  `).all(provider, model, limit);
}

async function indexMissingChunkEmbeddings({
  db,
  providerOverrides = {},
  env = process.env,
  fetchImpl,
  providerClient,
  limit = 100,
  batchSize = 16,
} = {}) {
  if (!db) {
    throw new Error('Embedding indexing requires a database.');
  }

  const { providerName, provider, apiKey } = getEmbeddingProvider(providerOverrides, env);
  if (!provider || provider.type !== 'openai-compatible' || !provider.embeddingModel) {
    return {
      status: 'needs_embedding_provider_setup',
      provider: providerName,
      model: provider?.embeddingModel || '',
      embedded: 0,
      skipped: 0,
      remaining: countChunks(db),
      setup: createEmbeddingSetup({ providerName, provider }),
    };
  }

  const model = provider.embeddingModel;
  const skipped = countChunksWithCurrentEmbedding(db, { provider: providerName, model });
  const runLimit = normalizePositiveInteger(limit, 100);
  const runBatchSize = normalizePositiveInteger(batchSize, 16);
  const missingChunks = selectChunksMissingEmbeddings(db, { provider: providerName, model, limit: runLimit });

  if (!apiKey) {
    return {
      status: 'needs_embedding_provider_key',
      provider: providerName,
      model,
      embedded: 0,
      skipped,
      remaining: missingChunks.length,
      setup: createEmbeddingSetup({ providerName, provider }),
    };
  }

  const client = providerClient || createOpenAiCompatibleClient({ provider, apiKey, fetchImpl });
  let embedded = 0;

  for (let offset = 0; offset < missingChunks.length; offset += runBatchSize) {
    const batch = missingChunks.slice(offset, offset + runBatchSize);
    for (const chunk of batch) {
      const embedding = await client.createEmbedding({ input: chunk.text });
      storeChunkEmbedding(db, {
        chunkId: chunk.id,
        provider: providerName,
        model,
        contentHash: chunk.content_hash,
        embedding,
      });
      embedded += 1;
    }
  }

  const remaining = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunks
    WHERE NOT EXISTS (
      SELECT 1
      FROM chunk_embeddings
      WHERE chunk_embeddings.chunk_id = chunks.id
        AND chunk_embeddings.provider = ?
        AND chunk_embeddings.model = ?
        AND chunk_embeddings.content_hash = chunks.content_hash
    )
  `).get(providerName, model).count);

  return {
    status: 'embedded',
    provider: providerName,
    model,
    embedded,
    skipped,
    remaining,
    limit: runLimit,
    batchSize: runBatchSize,
  };
}

module.exports = {
  indexMissingChunkEmbeddings,
  selectChunksMissingEmbeddings,
};
