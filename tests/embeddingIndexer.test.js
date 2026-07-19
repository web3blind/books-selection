const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { indexMissingChunkEmbeddings } = require('../src/embeddingIndexer');
const { storeChunkEmbedding } = require('../src/embeddings');

function insertBookWithChunks(db, chunks) {
  const book = db.prepare("INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run('Embedding Cycle', '/tmp/Embedding Cycle', '/tmp/Embedding Cycle/book.fb2', 1, 2, 'book-hash', 'Embedding Book', 'Annotation', 'indexed');
  const bookId = Number(book.lastInsertRowid);

  return chunks.map((chunk, index) => Number(db.prepare('INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, index, chunk.text, chunk.contentHash, index * 10, index * 10 + chunk.text.length).lastInsertRowid));
}

function createMockEmbeddingClient() {
  const calls = [];
  return {
    calls,
    async createEmbedding({ input }) {
      calls.push(input);
      return [input.length, calls.length];
    },
  };
}

test('indexMissingChunkEmbeddings returns setup status without provider key and does not call provider', async () => {
  const db = initializeSearchDatabase(':memory:');
  const client = createMockEmbeddingClient();

  try {
    insertBookWithChunks(db, [{ text: 'chunk needs vector', contentHash: 'hash-a' }]);

    const result = await indexMissingChunkEmbeddings({ db, env: {}, providerClient: client });

    assert.equal(result.status, 'needs_embedding_provider_key');
    assert.equal(result.embedded, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.remaining, 1);
    assert.equal(result.setup.apiKeyEnv, 'OPENROUTER_API_KEY');
    assert.deepEqual(client.calls, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunk_embeddings').get().count, 0);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings embeds missing chunks with mocked provider and stores cache rows', async () => {
  const db = initializeSearchDatabase(':memory:');
  const client = createMockEmbeddingClient();

  try {
    const [firstChunkId, secondChunkId] = insertBookWithChunks(db, [
      { text: 'first semantic chunk', contentHash: 'hash-a' },
      { text: 'second semantic chunk', contentHash: 'hash-b' },
    ]);

    const result = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
      limit: 10,
    });

    const rows = db.prepare('SELECT chunk_id, provider, model, content_hash, embedding_json FROM chunk_embeddings ORDER BY chunk_id').all();
    assert.equal(result.status, 'embedded');
    assert.equal(result.embedded, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.remaining, 0);
    assert.deepEqual(client.calls, ['first semantic chunk', 'second semantic chunk']);
    assert.deepEqual(rows.map((row) => row.chunk_id), [firstChunkId, secondChunkId]);
    assert.deepEqual(rows.map((row) => row.provider), ['openrouter', 'openrouter']);
    assert.deepEqual(rows.map((row) => row.model), ['openai/text-embedding-3-small', 'openai/text-embedding-3-small']);
    assert.deepEqual(rows.map((row) => row.content_hash), ['hash-a', 'hash-b']);
    assert.deepEqual(rows.map((row) => JSON.parse(row.embedding_json)), [[20, 1], [21, 2]]);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings skips already embedded unchanged chunks', async () => {
  const db = initializeSearchDatabase(':memory:');
  const client = createMockEmbeddingClient();

  try {
    const [chunkId] = insertBookWithChunks(db, [{ text: 'already cached chunk', contentHash: 'hash-a' }]);
    storeChunkEmbedding(db, { chunkId, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: 'hash-a', embedding: [1, 2, 3] });

    const result = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
    });

    assert.equal(result.status, 'embedded');
    assert.equal(result.embedded, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.remaining, 0);
    assert.deepEqual(client.calls, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunk_embeddings').get().count, 1);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings re-embeds changed chunk hashes without duplicating the same hash', async () => {
  const db = initializeSearchDatabase(':memory:');
  const client = createMockEmbeddingClient();

  try {
    const [chunkId] = insertBookWithChunks(db, [{ text: 'changed cached chunk', contentHash: 'old-hash' }]);
    storeChunkEmbedding(db, { chunkId, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: 'old-hash', embedding: [1, 2, 3] });
    db.prepare('UPDATE chunks SET content_hash = ?, text = ? WHERE id = ?').run('new-hash', 'changed cached chunk after edit', chunkId);

    const first = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
    });
    const second = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
    });

    const rows = db.prepare('SELECT content_hash FROM chunk_embeddings WHERE chunk_id = ? ORDER BY content_hash').all(chunkId);
    assert.equal(first.embedded, 1);
    assert.equal(second.embedded, 0);
    assert.deepEqual(client.calls, ['changed cached chunk after edit']);
    assert.deepEqual(rows.map((row) => row.content_hash), ['new-hash', 'old-hash']);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings respects limit and batchSize for bounded cache population runs', async () => {
  const db = initializeSearchDatabase(':memory:');
  const client = createMockEmbeddingClient();

  try {
    insertBookWithChunks(db, [
      { text: 'chunk one', contentHash: 'hash-1' },
      { text: 'chunk two', contentHash: 'hash-2' },
      { text: 'chunk three', contentHash: 'hash-3' },
    ]);

    const first = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
      limit: 2,
      batchSize: 1,
    });
    const second = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
      limit: 2,
      batchSize: 1,
    });

    assert.equal(first.embedded, 2);
    assert.equal(first.remaining, 1);
    assert.equal(second.embedded, 1);
    assert.equal(second.remaining, 0);
    assert.deepEqual(client.calls, ['chunk one', 'chunk two', 'chunk three']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunk_embeddings').get().count, 3);
  } finally {
    db.close();
  }
});
