const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { storeChunkEmbedding } = require('../src/embeddings');
const { upsertDerivedFact } = require('../src/facts');
const { collectHybridEvidence } = require('../src/retrieval');

function insertBook(db, { cycleName, title, filePath, contentHash }) {
  return Number(db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cycleName, `/tmp/${cycleName}`, filePath, 1, 2, contentHash, title, 'Annotation', 'indexed').lastInsertRowid);
}

function insertChunk(db, { bookId, chunkIndex, text, contentHash }) {
  const chunkId = Number(db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookId, chunkIndex, text, contentHash, 0, text.length).lastInsertRowid);
  db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(chunkId, text);
  return chunkId;
}

test('collectHybridEvidence returns FTS evidence when semantic provider key is absent', async () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const bookId = insertBook(db, { cycleName: 'Cycle A', title: 'Book A', filePath: '/tmp/a.fb2', contentHash: 'book-a' });
    insertChunk(db, { bookId, chunkIndex: 0, text: 'героиня нашла фонарь у башни', contentHash: 'chunk-a' });

    let fetchCalled = false;
    const result = await collectHybridEvidence({
      db,
      question: 'Где есть фонарь?',
      env: {},
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('network should not be called');
      },
    });

    assert.equal(fetchCalled, false);
    assert.equal(result.semantic.status, 'needs_embedding_provider_key');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].source, 'fts');
    assert.equal(result.evidence[0].book_id, bookId);
    assert.equal(result.evidence[0].title, 'Book A');
    assert.match(result.evidence[0].snippet, /фонарь/);
  } finally {
    db.close();
  }
});

test('collectHybridEvidence combines FTS and cached semantic hits with source labels and caps the result', async () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const bookId = insertBook(db, { cycleName: 'Cycle B', title: 'Book B', filePath: '/tmp/b.fb2', contentHash: 'book-b' });
    const ftsChunk = insertChunk(db, { bookId, chunkIndex: 0, text: 'фонарь найден в первой главе', contentHash: 'chunk-fts' });
    const semanticChunk = insertChunk(db, { bookId, chunkIndex: 1, text: 'герои действуют вместе до финала', contentHash: 'chunk-semantic' });

    storeChunkEmbedding(db, { chunkId: ftsChunk, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: 'chunk-fts', embedding: [0, 1] });
    storeChunkEmbedding(db, { chunkId: semanticChunk, provider: 'openrouter', model: 'openai/text-embedding-3-small', contentHash: 'chunk-semantic', embedding: [1, 0] });

    const result = await collectHybridEvidence({
      db,
      question: 'Где фонарь?',
      env: { OPENROUTER_API_KEY: 'test-key' },
      providerClient: {
        createEmbedding: async () => [1, 0],
      },
      limit: 2,
      ftsLimit: 1,
      semanticLimit: 2,
    });

    assert.equal(result.semantic.status, 'searched');
    assert.equal(result.evidence.length, 2);
    assert.deepEqual(result.evidence.map((row) => row.source), ['fts', 'semantic']);
    assert.equal(result.evidence[0].chunk_index, 0);
    assert.equal(result.evidence[1].chunk_index, 1);
    assert.match(result.evidence[1].snippet, /герои действуют вместе/);
  } finally {
    db.close();
  }
});

test('collectHybridEvidence adds cached derived facts for explicit filters and related books without leaking chunk text', async () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const bookId = insertBook(db, { cycleName: 'Cycle C', title: 'Book C', filePath: '/tmp/c.fb2', contentHash: 'book-c' });
    insertChunk(db, {
      bookId,
      chunkIndex: 0,
      text: 'локальный FTS фрагмент про фонарь. Скрытый полный хвост не должен уйти как факт.',
      contentHash: 'chunk-c',
    });
    upsertDerivedFact(db, {
      bookId,
      factKey: 'survives_finale',
      factType: 'plot_trait',
      factValue: 'yes',
      confidence: 0.88,
      evidence: [{ excerpt: 'В эпилоге героиня отвечает на письмо.' }],
      provider: 'mock',
      model: 'fact-model',
    });

    const result = await collectHybridEvidence({
      db,
      question: 'Кто жив в финале и где фонарь?',
      env: {},
      factFilters: [{ factType: 'plot_trait', factKey: 'survives_finale' }],
      limit: 5,
    });

    const factRows = result.evidence.filter((row) => row.source === 'fact');
    assert.equal(factRows.length, 1);
    assert.equal(factRows[0].book_id, bookId);
    assert.equal(factRows[0].chunk_index, 'fact:survives_finale');
    assert.match(factRows[0].snippet, /survives_finale/);
    assert.match(factRows[0].snippet, /В эпилоге героиня отвечает на письмо/);
    assert.doesNotMatch(factRows[0].snippet, /Скрытый полный хвост/);
  } finally {
    db.close();
  }
});
