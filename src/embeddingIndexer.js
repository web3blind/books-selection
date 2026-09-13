const { storeChunkEmbedding } = require('./embeddings');
const { getApiKey, loadProviderConfig } = require('./providerConfig');
const { createOpenAiCompatibleClient } = require('./providerClient');

const ACTIVE_CORPUS_FILTER = `(
  NOT EXISTS (SELECT 1 FROM corpus_state WHERE id = 1)
  OR books.indexed_root = (SELECT indexed_root FROM corpus_state WHERE id = 1)
)`;
const EMBEDDING_ROW_BATCH_SIZE = 256;

function normalizePositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
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
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM chunks
    JOIN books ON books.id = chunks.book_id
    WHERE ${ACTIVE_CORPUS_FILTER}
  `).get().count);
}

function countChunksWithCurrentEmbedding(db, { provider, model }) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM chunks
    JOIN books ON books.id = chunks.book_id
    WHERE ${ACTIVE_CORPUS_FILTER} AND EXISTS (
      SELECT 1
      FROM chunk_embeddings
      WHERE chunk_embeddings.chunk_id = chunks.id
        AND chunk_embeddings.provider = ?
        AND chunk_embeddings.model = ?
        AND chunk_embeddings.content_hash = chunks.content_hash
    )
  `).get(provider, model).count);
}

function* iterateCurrentEmbeddingBatches(db, { provider, model, batchSize = EMBEDDING_ROW_BATCH_SIZE }) {
  const normalizedBatchSize = normalizePositiveInteger(batchSize, EMBEDDING_ROW_BATCH_SIZE, 1000);
  const statement = db.prepare(`
    SELECT chunk_embeddings.chunk_id, chunk_embeddings.embedding_json
    FROM chunk_embeddings
    JOIN chunks ON chunks.id = chunk_embeddings.chunk_id
    JOIN books ON books.id = chunks.book_id
    WHERE ${ACTIVE_CORPUS_FILTER}
      AND chunk_embeddings.provider = ?
      AND chunk_embeddings.model = ?
      AND chunk_embeddings.content_hash = chunks.content_hash
      AND chunk_embeddings.chunk_id > ?
    ORDER BY chunk_embeddings.chunk_id
    LIMIT ?
  `);
  let afterChunkId = 0;
  while (true) {
    const rows = statement.all(provider, model, afterChunkId, normalizedBatchSize);
    if (rows.length === 0) return;
    yield rows;
    afterChunkId = rows[rows.length - 1].chunk_id;
  }
}

function selectChunksMissingEmbeddings(db, { provider, model, limit }) {
  return db.prepare(`
    SELECT chunks.id, chunks.text, chunks.content_hash
    FROM chunks
    JOIN books ON books.id = chunks.book_id
    WHERE ${ACTIVE_CORPUS_FILTER} AND NOT EXISTS (
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

function getEmbeddingIndexStatus({ db, providerOverrides = {}, env = process.env, expectedDimension = null } = {}) {
  if (!db) throw new Error('Embedding status requires a database.');
  const { providerName, provider } = getEmbeddingProvider(providerOverrides, env);
  const model = provider?.embeddingModel || '';
  const total = countChunks(db);
  const dimensionCounts = new Map();
  if (model) {
    for (const rows of iterateCurrentEmbeddingBatches(db, { provider: providerName, model })) {
      for (const row of rows) {
        try {
          const vector = JSON.parse(row.embedding_json);
          const valid = Array.isArray(vector) && vector.length > 0
            && vector.every((value) => typeof value === 'number' && Number.isFinite(value));
          if (valid) dimensionCounts.set(vector.length, (dimensionCounts.get(vector.length) || 0) + 1);
        } catch {
          // Malformed cached vectors are not ready.
        }
      }
    }
  }
  const normalizedExpectedDimension = Number.isInteger(expectedDimension) && expectedDimension > 0
    ? expectedDimension
    : null;
  const ready = normalizedExpectedDimension
    ? (dimensionCounts.get(normalizedExpectedDimension) || 0)
    : ([...dimensionCounts.values()].sort((left, right) => right - left)[0] || 0);
  const remaining = Math.max(0, total - ready);
  const corpusState = db.prepare('SELECT errors, complete FROM corpus_state WHERE id = 1').get() || null;
  const status = corpusState && Number(corpusState.errors) > 0
    ? 'index_errors'
    : total === 0 ? 'empty' : remaining === 0 ? 'ready' : ready > 0 ? 'partial' : 'missing';
  const result = {
    status, provider: providerName, model, ready, total, remaining,
    percent: total > 0 ? Math.round((ready / total) * 100) : 0,
  };
  if (corpusState) {
    result.indexErrors = Number(corpusState.errors);
    result.corpusComplete = corpusState.complete === 1;
  }
  return result;
}

function pruneInvalidCurrentEmbeddings(db, { provider, model }) {
  function parseEmbedding(row) {
    try {
      const embedding = JSON.parse(row.embedding_json);
      const valid = Array.isArray(embedding)
        && embedding.length > 0
        && embedding.every((value) => typeof value === 'number' && Number.isFinite(value));
      return { chunkId: row.chunk_id, embedding: valid ? embedding : null };
    } catch {
      return { chunkId: row.chunk_id, embedding: null };
    }
  }

  const dimensionCounts = new Map();
  for (const rows of iterateCurrentEmbeddingBatches(db, { provider, model })) {
    for (const rawRow of rows) {
      const row = parseEmbedding(rawRow);
      if (!row.embedding) continue;
      dimensionCounts.set(row.embedding.length, (dimensionCounts.get(row.embedding.length) || 0) + 1);
    }
  }
  const expectedDimension = [...dimensionCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] || null;
  const deleteRow = db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ? AND provider = ? AND model = ?');
  for (const rows of iterateCurrentEmbeddingBatches(db, { provider, model })) {
    for (const rawRow of rows) {
      const row = parseEmbedding(rawRow);
      if (!row.embedding || row.embedding.length !== expectedDimension) {
        deleteRow.run(row.chunkId, provider, model);
      }
    }
  }
  return expectedDimension;
}

function validateEmbeddingBatch(embeddings, expectedCount, expectedDimension) {
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
    throw new Error('Embeddings provider returned a different number of vectors than requested.');
  }
  const dimension = expectedDimension || embeddings[0]?.length;
  const valid = Number.isInteger(dimension) && dimension > 0 && embeddings.every((embedding) => (
    Array.isArray(embedding)
    && embedding.length === dimension
    && embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
  ));
  if (!valid) {
    throw new Error('Embeddings provider returned empty, non-finite, or inconsistent vectors.');
  }
  return dimension;
}

async function indexMissingChunkEmbeddings({
  db,
  providerOverrides = {},
  env = process.env,
  fetchImpl,
  providerClient,
  signal,
  limit = 100,
  batchSize = 16,
  maxTransmittedChunks = null,
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
  const currentEmbeddingDimension = pruneInvalidCurrentEmbeddings(db, { provider: providerName, model });
  const totalChunks = countChunks(db);
  let skipped = countChunksWithCurrentEmbedding(db, { provider: providerName, model });
  const approvedTransmissionLimit = Number.isSafeInteger(maxTransmittedChunks) && maxTransmittedChunks >= 0
    ? Math.min(maxTransmittedChunks, totalChunks)
    : totalChunks;
  const runLimit = limit === null ? approvedTransmissionLimit : normalizePositiveInteger(limit, 100, 1000);
  const runBatchSize = normalizePositiveInteger(batchSize, 16, 128);
  const totalMissing = Math.max(0, totalChunks - skipped);

  if (!apiKey) {
    return {
      status: 'needs_embedding_provider_key',
      provider: providerName,
      model,
      embedded: 0,
      skipped,
      remaining: totalMissing,
      setup: createEmbeddingSetup({ providerName, provider }),
    };
  }

  const client = providerClient || createOpenAiCompatibleClient({ provider, apiKey, fetchImpl });
  async function requestEmbeddingsForChunks(chunks) {
    if (typeof client.createEmbeddings === 'function') {
      try {
        return await client.createEmbeddings({ inputs: chunks.map((chunk) => chunk.text), signal });
      } catch (error) {
        const canFallBackToScalar = maxTransmittedChunks === null
          && typeof client.createEmbedding === 'function'
          && /Provider embeddings request failed with HTTP (400|404|405|413|422)\b/.test(error.message || '');
        if (!canFallBackToScalar) throw error;
      }
    }
    return Promise.all(chunks.map((chunk) => client.createEmbedding({ input: chunk.text, signal })));
  }

  let embedded = 0;
  let expectedDimension = currentEmbeddingDimension;
  let dimensionTransitionHandled = false;

  let processedThisRun = 0;
  while (processedThisRun < runLimit) {
    const batch = selectChunksMissingEmbeddings(db, {
      provider: providerName,
      model,
      limit: Math.min(runBatchSize, runLimit - processedThisRun),
    });
    if (batch.length === 0) break;
    const embeddings = await requestEmbeddingsForChunks(batch);
    const batchDimension = validateEmbeddingBatch(embeddings, batch.length);
    if (expectedDimension && batchDimension !== expectedDimension) {
      if (dimensionTransitionHandled) {
        throw new Error('Embeddings provider changed vector dimension repeatedly during one indexing run.');
      }
      db.prepare('DELETE FROM chunk_embeddings WHERE provider = ? AND model = ?').run(providerName, model);
      dimensionTransitionHandled = true;
      expectedDimension = batchDimension;
      skipped = 0;
      embedded = 0;
    }
    expectedDimension = batchDimension;
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index];
      const embedding = embeddings[index];
      storeChunkEmbedding(db, {
        chunkId: chunk.id,
        provider: providerName,
        model,
        contentHash: chunk.content_hash,
        embedding,
      });
      embedded += 1;
    }
    processedThisRun += batch.length;
  }

  const remaining = Math.max(0, countChunks(db) - countChunksWithCurrentEmbedding(db, {
    provider: providerName,
    model,
  }));

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
  getEmbeddingIndexStatus,
  indexMissingChunkEmbeddings,
  iterateCurrentEmbeddingBatches,
  selectChunksMissingEmbeddings,
};
