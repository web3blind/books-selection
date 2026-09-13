const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { getEmbeddingIndexStatus, indexMissingChunkEmbeddings } = require('../src/embeddingIndexer');
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

test('getEmbeddingIndexStatus reports overall readiness', () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const ids = insertBookWithChunks(db, [
      { text: 'ready', contentHash: 'hash-a' },
      { text: 'missing', contentHash: 'hash-b' },
    ]);
    storeChunkEmbedding(db, {
      chunkId: ids[0], provider: 'openrouter',
      model: 'openai/text-embedding-3-small',
      contentHash: 'hash-a', embedding: [1, 2],
    });
    const status = getEmbeddingIndexStatus({ db });
    assert.deepEqual(status, {
      status: 'partial', provider: 'openrouter',
      model: 'openai/text-embedding-3-small',
      ready: 1, total: 2, remaining: 1, percent: 50,
    });
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings reports remaining only for the active corpus root', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const insertBook = db.prepare(`INSERT INTO books
      (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
      VALUES (?, ?, ?, 1, 1, ?, ?, 'Annotation', 'indexed', ?)`);
    const stale = Number(insertBook.run('Old', '/old', '/old/book.fb2', 'old', 'Old', '/old').lastInsertRowid);
    const active = Number(insertBook.run('New', '/new', '/new/book.fb2', 'new', 'New', '/new').lastInsertRowid);
    const insertChunk = db.prepare('INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset) VALUES (?, 0, ?, ?, 0, 4)');
    insertChunk.run(stale, 'old', 'old-hash');
    insertChunk.run(active, 'new', 'new-hash');
    db.prepare(`INSERT INTO corpus_state
      (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
      VALUES (1, '/new', 1, 1, 1, 1, 1, 0, 1)`).run();
    const result = await indexMissingChunkEmbeddings({
      db, env: { OPENROUTER_API_KEY: 'test-key' }, providerClient: createMockEmbeddingClient(),
    });
    assert.equal(result.embedded, 1);
    assert.equal(result.remaining, 0);
  } finally {
    db.close();
  }
});

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
    storeChunkEmbedding(db, { chunkId, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: 'hash-a', embedding: [1, 2] });

    const result = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
    });

    assert.equal(result.status, 'embedded');
    assert.equal(result.embedded, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.remaining, 0);
    assert.deepEqual(client.calls, ['already cached chunk']);
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
    assert.deepEqual(client.calls, ['changed cached chunk after edit', 'changed cached chunk after edit']);
    assert.deepEqual(rows.map((row) => row.content_hash), ['new-hash']);
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

test('indexMissingChunkEmbeddings sends true provider batches when the client supports them', async () => {
  const db = initializeSearchDatabase(':memory:');
  const calls = [];
  const client = {
    async createEmbeddings({ inputs }) {
      calls.push(inputs);
      return inputs.map((input, index) => [input.length, index]);
    },
  };

  try {
    insertBookWithChunks(db, [
      { text: 'one', contentHash: 'hash-1' },
      { text: 'two', contentHash: 'hash-2' },
      { text: 'three', contentHash: 'hash-3' },
      { text: 'four', contentHash: 'hash-4' },
      { text: 'five', contentHash: 'hash-5' },
    ]);
    const result = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
      limit: 10,
      batchSize: 2,
    });

    assert.equal(result.embedded, 5);
    assert.equal(result.remaining, 0);
    assert.deepEqual(calls, [['one', 'two'], ['three', 'four'], ['five']]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunk_embeddings').get().count, 5);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings falls back to scalar requests when a compatible provider rejects arrays', async () => {
  const db = initializeSearchDatabase(':memory:');
  const scalarCalls = [];
  const client = {
    async createEmbeddings() {
      throw new Error('Provider embeddings request failed with HTTP 422');
    },
    async createEmbedding({ input }) {
      scalarCalls.push(input);
      return [input.length];
    },
  };
  try {
    insertBookWithChunks(db, [
      { text: 'one', contentHash: 'hash-1' },
      { text: 'two', contentHash: 'hash-2' },
    ]);
    const result = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: client,
      batchSize: 2,
    });
    assert.equal(result.embedded, 2);
    assert.deepEqual(scalarCalls, ['one', 'two']);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings removes malformed current cache rows and re-embeds them', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const [badChunkId, goodChunkId] = insertBookWithChunks(db, [
      { text: 'bad', contentHash: 'hash-bad' },
      { text: 'good', contentHash: 'hash-good' },
    ]);
    const insert = db.prepare('INSERT INTO chunk_embeddings (chunk_id, provider, model, content_hash, embedding_json) VALUES (?, ?, ?, ?, ?)');
    insert.run(badChunkId, 'openrouter', 'openai/text-embedding-3-small', 'hash-bad', '[]');
    insert.run(goodChunkId, 'openrouter', 'openai/text-embedding-3-small', 'hash-good', '[1,2]');

    const result = await indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: { createEmbeddings: async () => [[3, 4]] },
    });
    assert.equal(result.embedded, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(
      JSON.parse(db.prepare('SELECT embedding_json FROM chunk_embeddings WHERE chunk_id = ?').get(badChunkId).embedding_json),
      [3, 4],
    );
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings rejects an invalid batch before storing any vectors', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    insertBookWithChunks(db, [
      { text: 'one', contentHash: 'hash-1' },
      { text: 'two', contentHash: 'hash-2' },
    ]);
    await assert.rejects(indexMissingChunkEmbeddings({
      db,
      env: { OPENROUTER_API_KEY: 'secret-key' },
      providerClient: { createEmbeddings: async () => [[1, 2], []] },
      batchSize: 2,
    }), /empty|inconsistent/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chunk_embeddings').get().count, 0);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings rebuilds a fully populated cache when provider dimension changes', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const chunkIds = insertBookWithChunks(db, [
      { text: 'fully cached one', contentHash: 'hash-1' },
      { text: 'fully cached two', contentHash: 'hash-2' },
    ]);
    for (const chunkId of chunkIds) {
      const hash = db.prepare('SELECT content_hash FROM chunks WHERE id = ?').get(chunkId).content_hash;
      storeChunkEmbedding(db, {
        chunkId, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: hash, embedding: [1, 2],
      });
    }
    const calls = [];
    const result = await indexMissingChunkEmbeddings({
      db, env: { OPENROUTER_API_KEY: 'key' }, batchSize: 2,
      providerClient: { createEmbeddings: async ({ inputs }) => {
        calls.push(inputs);
        return inputs.map(() => [1, 2, 3]);
      } },
    });
    const dimensions = db.prepare('SELECT embedding_json FROM chunk_embeddings ORDER BY chunk_id').all()
      .map((row) => JSON.parse(row.embedding_json).length);
    assert.deepEqual(dimensions, [3, 3]);
    assert.equal(result.remaining, 0);
    assert.equal(result.embedded, 2);
    assert.equal(calls[0].length, 1);
  } finally {
    db.close();
  }
});

test('indexMissingChunkEmbeddings invalidates and rebuilds cache when provider dimension changes', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const [cachedId] = insertBookWithChunks(db, [
      { text: 'cached old dimension', contentHash: 'old' },
      { text: 'new chunk detects transition', contentHash: 'new' },
    ]);
    storeChunkEmbedding(db, {
      chunkId: cachedId, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: 'old', embedding: [1, 2],
    });
    const calls = [];
    const result = await indexMissingChunkEmbeddings({
      db, env: { OPENROUTER_API_KEY: 'key' }, batchSize: 2,
      providerClient: { createEmbeddings: async ({ inputs }) => {
        calls.push(inputs);
        return inputs.map(() => [1, 2, 3]);
      } },
    });
    const dimensions = db.prepare('SELECT embedding_json FROM chunk_embeddings ORDER BY chunk_id').all()
      .map((row) => JSON.parse(row.embedding_json).length);
    assert.deepEqual(dimensions, [3, 3]);
    assert.equal(result.remaining, 0);
    assert.ok(calls.flat().includes('cached old dimension'));
  } finally {
    db.close();
  }
});
