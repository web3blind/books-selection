const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { createOpenAiCompatibleClient } = require('../src/providerClient');
const { loadProviderConfig } = require('../src/providerConfig');
const {
  cosineSimilarity,
  embedQueryIfConfigured,
  semanticSearchChunks,
  storeChunkEmbedding,
} = require('../src/embeddings');

test('schema stores durable chunk embeddings keyed by chunk, provider, model, and content hash', () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const book = db.prepare("INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run('Cycle', '/tmp/Cycle', '/tmp/Cycle/book.fb2', 1, 2, 'book-hash', 'Title', 'Annotation', 'indexed');
    const chunkId = Number(db.prepare('INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Number(book.lastInsertRowid), 0, 'semantic dragon lantern', 'chunk-hash', 0, 23).lastInsertRowid);

    storeChunkEmbedding(db, {
      chunkId,
      provider: 'openrouter',
      model: 'text-embedding-3-small',
      contentHash: 'chunk-hash',
      embedding: [0.1, 0.2, 0.3],
    });

    const row = db.prepare('SELECT chunk_id, provider, model, content_hash, embedding_json FROM chunk_embeddings').get();
    assert.equal(row.chunk_id, chunkId);
    assert.equal(row.provider, 'openrouter');
    assert.equal(row.model, 'text-embedding-3-small');
    assert.equal(row.content_hash, 'chunk-hash');
    assert.deepEqual(JSON.parse(row.embedding_json), [0.1, 0.2, 0.3]);

    assert.throws(() => storeChunkEmbedding(db, {
      chunkId,
      provider: 'openrouter',
      model: 'text-embedding-3-small',
      contentHash: 'chunk-hash',
      embedding: [0.4, 0.5, 0.6],
    }), /UNIQUE|constraint/i);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chunk_embeddings'").all().map((item) => item.name);
    assert.ok(indexes.includes('idx_chunk_embeddings_provider_model_hash'));
    assert.ok(indexes.includes('idx_chunk_embeddings_chunk'));
  } finally {
    db.close();
  }
});

test('provider config exposes secret-free embedding defaults for OpenRouter and local providers', () => {
  const config = loadProviderConfig({}, { OPENROUTER_API_KEY: 'secret-value' });

  assert.equal(config.activeEmbeddingsProvider, 'openrouter');
  assert.equal(config.providers.openrouter.embeddingModel, 'openai/text-embedding-3-small');
  assert.equal(config.providers.local.embeddingModel, 'local-embedding-model');
  assert.equal(config.providers.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.doesNotMatch(JSON.stringify(config), /secret-value/);
});

test('OpenAI-compatible provider client posts embeddings through injectable fetch without leaking secrets in results', async () => {
  let request;
  const client = createOpenAiCompatibleClient({
    provider: {
      baseUrl: 'https://example.test/v1',
      model: 'chat-model',
      embeddingModel: 'embedding-model',
    },
    apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ embedding: [0.25, 0.5, 0.75] }] };
        },
      };
    },
  });

  const embedding = await client.createEmbedding({ input: 'локальный запрос' });

  assert.equal(request.url, 'https://example.test/v1/embeddings');
  assert.equal(request.options.headers.authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'embedding-model', input: 'локальный запрос' });
  assert.deepEqual(embedding, [0.25, 0.5, 0.75]);
  assert.doesNotMatch(JSON.stringify(embedding), /secret-key/);
});

test('cosineSimilarity and semanticSearchChunks rank cached DB vectors locally', () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const book = db.prepare("INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run('Vector Cycle', '/tmp/Vector Cycle', '/tmp/Vector Cycle/book.fb2', 1, 2, 'book-hash', 'Vector Book', 'Annotation', 'indexed');
    const bookId = Number(book.lastInsertRowid);
    const chunkA = Number(db.prepare('INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)')
      .run(bookId, 0, 'дракон и фонарь', 'hash-a', 0, 16).lastInsertRowid);
    const chunkB = Number(db.prepare('INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)')
      .run(bookId, 1, 'космический корабль', 'hash-b', 17, 35).lastInsertRowid);

    storeChunkEmbedding(db, { chunkId: chunkA, provider: 'openrouter', model: 'embed', contentHash: 'hash-a', embedding: [1, 0, 0] });
    storeChunkEmbedding(db, { chunkId: chunkB, provider: 'openrouter', model: 'embed', contentHash: 'hash-b', embedding: [0, 1, 0] });

    const results = semanticSearchChunks(db, [0.9, 0.1, 0], { provider: 'openrouter', model: 'embed', limit: 2 });

    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(results.length, 2);
    assert.equal(results[0].chunk_id, chunkA);
    assert.equal(results[0].chunk_index, 0);
    assert.equal(results[0].title, 'Vector Book');
    assert.ok(results[0].score > results[1].score);
  } finally {
    db.close();
  }
});

test('embedQueryIfConfigured returns setup status without provider key and does not call network', async () => {
  let fetchCalled = false;
  const result = await embedQueryIfConfigured({
    query: 'семантический фонарь',
    env: {},
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('network should not be called');
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.status, 'needs_embedding_provider_key');
  assert.equal(result.embedding, null);
  assert.equal(result.setup.provider, 'openrouter');
  assert.equal(result.setup.apiKeyEnv, 'OPENROUTER_API_KEY');
});

test('embedQueryIfConfigured uses mocked embeddings provider when key is configured', async () => {
  const result = await embedQueryIfConfigured({
    query: 'семантический фонарь',
    env: { OPENROUTER_API_KEY: 'secret-key' },
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).endsWith('/credits')) {
          return { data: { total_credits: 10, total_usage: 0.2 } };
        }
        return { data: [{ embedding: [0.7, 0.2] }] };
      },
    }),
  });

  assert.equal(result.status, 'embedded');
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'openai/text-embedding-3-small');
  assert.deepEqual(result.embedding, [0.7, 0.2]);
});
