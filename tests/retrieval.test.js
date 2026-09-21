const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { storeChunkEmbedding } = require('../src/embeddings');
const { upsertDerivedFact } = require('../src/facts');
const { collectHybridEvidence, createFtsQueryFromQuestion, expandEvidenceContext } = require('../src/retrieval');

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

test('createFtsQueryFromQuestion removes broad stopwords before FTS matching', () => {
  assert.equal(createFtsQueryFromQuestion('Где девушка и парень помогают друг другу?'), '"девушка" OR "парень" OR "помогают" OR "друг" OR "другу"');
});

test('collectHybridEvidence reranks broad OR FTS hits toward multi-term evidence', async () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const noisyFriend = insertBook(db, { cycleName: 'Noisy Cycle', title: 'Only Friend', filePath: '/tmp/noisy.fb2', contentHash: 'noisy' });
    insertChunk(db, {
      bookId: noisyFriend,
      chunkIndex: 0,
      text: 'Кайзер постоянно подгонял друга, Максим жаловался, но всё равно бежал.',
      contentHash: 'noisy-chunk',
    });
    const noisyGirl = insertBook(db, { cycleName: 'Girl Cycle', title: 'Only Girl', filePath: '/tmp/girl.fb2', contentHash: 'girl' });
    insertChunk(db, {
      bookId: noisyGirl,
      chunkIndex: 0,
      text: 'Растрёпанная девушка поправляла волосы на ходу и ушла по коридору.',
      contentHash: 'girl-chunk',
    });
    const relevant = insertBook(db, { cycleName: 'Попаданец с опытом', title: 'Попаданец с опытом. Целитель', filePath: '/tmp/relevant.fb2', contentHash: 'relevant' });
    insertChunk(db, {
      bookId: relevant,
      chunkIndex: 0,
      text: 'Девушка говорила уверенно, а парень помогал ей выбраться. Они доверяли друг другу и поддерживали друг друга.',
      contentHash: 'relevant-chunk',
    });

    const result = await collectHybridEvidence({
      db,
      question: 'Где девушка и парень помогают друг другу?',
      env: {},
      limit: 5,
      ftsLimit: 10,
      semanticLimit: 0,
      includeRelatedFacts: false,
    });

    assert.ok(result.evidence.length >= 1);
    assert.equal(result.evidence[0].book_id, relevant);
    assert.deepEqual([...new Set(result.evidence.map((row) => row.book_id))], [relevant]);
    assert.match(result.evidence[0].snippet, /Девушка|парень|друг/i);
  } finally {
    db.close();
  }
});

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
    const chunkId = insertChunk(db, {
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
      evidence: [{ bookId, chunkId, contentHash: 'chunk-c', excerpt: 'локальный FTS фрагмент про фонарь.' }],
      provider: 'mock',
      model: 'fact-model',
    });

    const result = await collectHybridEvidence({
      db,
      question: 'Каково сохранённое финальное состояние?',
      env: {},
      factFilters: [{ factType: 'plot_trait', factKey: 'survives_finale' }],
      limit: 5,
    });

    const factRows = result.evidence.filter((row) => row.source === 'fact');
    assert.equal(factRows.length, 1);
    assert.equal(factRows[0].book_id, bookId);
    assert.equal(factRows[0].chunk_id, chunkId);
    assert.match(factRows[0].snippet, /локальный FTS фрагмент про фонарь/);
    assert.doesNotMatch(factRows[0].snippet, /Скрытый полный хвост/);
  } finally {
    db.close();
  }
});

test('collectHybridEvidence diversifies semantic evidence across books instead of filling the result from one book', async () => {
  const repeated = Array.from({ length: 12 }, (_, index) => ({
    book_id: 1,
    cycle_name: 'Noisy Cycle',
    title: 'Noisy Book',
    chunk_index: index,
    text: `похожий фрагмент ${index}`,
    score: 1 - index / 100,
  }));
  const alternatives = [2, 3, 4].map((bookId) => ({
    book_id: bookId,
    cycle_name: `Cycle ${bookId}`,
    title: `Book ${bookId}`,
    chunk_index: 0,
    text: `другой подходящий кандидат ${bookId}`,
    score: 0.7 - bookId / 100,
  }));

  const result = await collectHybridEvidence({
    db: {},
    question: 'У героя несколько демонов внутри',
    env: { OPENROUTER_API_KEY: 'test-key' },
    searchFn: () => [],
    embedFn: async () => ({ status: 'embedded', provider: 'openrouter', model: 'embed', embedding: [1, 0] }),
    semanticSearchFn: () => [...repeated, ...alternatives],
    includeRelatedFacts: false,
    limit: 6,
    semanticLimit: 6,
  });

  assert.ok(result.evidence.filter((row) => row.book_id === 1).length <= 3);
  assert.ok(result.evidence.some((row) => row.book_id === 2));
  assert.ok(new Set(result.evidence.map((row) => row.book_id)).size >= 2);
});

test('collectHybridEvidence merges FTS and semantic sources for the same chunk_id', async () => {
  const shared = { chunk_id: 77, book_id: 9, cycle_name: 'Cycle', title: 'Book', chunk_index: 3 };
  const result = await collectHybridEvidence({
    db: {}, question: 'общий фрагмент', env: { OPENROUTER_API_KEY: 'test-key' },
    searchFn: () => [{ ...shared, snippet: 'общий фрагмент' }],
    embedFn: async () => ({ status: 'embedded', provider: 'openrouter', model: 'embed', embedding: [1] }),
    semanticSearchFn: () => [{ ...shared, text: 'общий фрагмент', score: 1 }],
    includeRelatedFacts: false, limit: 4,
  });
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.evidence[0].sources, ['fts', 'semantic']);
});

test('collectHybridEvidence passes natural language to safe FTS search instead of recompiling FTS syntax', async () => {
  let receivedQuery = '';
  const result = await collectHybridEvidence({
    db: {},
    question: 'red lamp',
    searchFn: (_db, query) => {
      receivedQuery = query;
      return [];
    },
    embedFn: async () => ({ status: 'needs_embedding_provider_key', setup: {} }),
    queryFactsFn: () => [],
  });
  assert.equal(receivedQuery, 'red lamp');
  assert.equal(result.ftsQuery, '"red" OR "lamp"');
});

test('expandEvidenceContext replaces tiny hits with full source chunks and bounded neighbors', () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const bookId = insertBook(db, { cycleName: 'Cycle', title: 'Book', filePath: '/tmp/context.fb2', contentHash: 'book' });
    const ids = [
      insertChunk(db, { bookId, chunkIndex: 0, text: 'Предыдущая сцена.', contentHash: 'h0' }),
      insertChunk(db, { bookId, chunkIndex: 1, text: 'Главная сцена с важным финалом.', contentHash: 'h1' }),
      insertChunk(db, { bookId, chunkIndex: 2, text: 'Следующая сцена.', contentHash: 'h2' }),
      insertChunk(db, { bookId, chunkIndex: 3, text: 'Слишком далёкая сцена.', contentHash: 'h3' }),
    ];
    db.prepare("UPDATE chunks SET section_path = '[\"Финал\"]', source_kind = 'body' WHERE id = ?").run(ids[1]);
    const rows = expandEvidenceContext(db, [{
      chunk_id: ids[1], book_id: bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 1,
      snippet: 'важным финалом', source: 'fts', sources: ['fts'],
    }], { neighborRadius: 1, limit: 3, maxExcerptChars: 1000 });
    assert.deepEqual(rows.map((row) => row.chunk_id), [ids[1], ids[0], ids[2]]);
    assert.match(rows[0].snippet, /^Главная сцена/);
    assert.equal(rows[0].content_hash, 'h1');
    assert.deepEqual(rows[0].section_path, ['Финал']);
    assert.equal(rows[0].source_kind, 'body');
    assert.deepEqual(rows.slice(1).map((row) => row.source), ['neighbor', 'neighbor']);
    assert.doesNotMatch(JSON.stringify(rows), /Слишком далёкая/);
  } finally {
    db.close();
  }
});

test('cached facts are retrieval leads only when their original chunk hash still matches', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const bookId = insertBook(db, { cycleName: 'Cycle', title: 'Book', filePath: '/tmp/fact-lead.fb2', contentHash: 'book' });
    const chunkId = insertChunk(db, { bookId, chunkIndex: 0, text: 'В эпилоге героиня жива.', contentHash: 'current-hash' });
    upsertDerivedFact(db, {
      bookId, factKey: 'plot.final_state', factType: 'plot_observation', factValue: 'alive', confidence: 0.8,
      evidence: [{ bookId, chunkId, contentHash: 'current-hash', excerpt: 'В эпилоге героиня жива.' }],
      provider: 'mock', model: 'mock',
    });
    upsertDerivedFact(db, {
      bookId, factKey: 'plot.stale', factType: 'plot_observation', factValue: 'stale', confidence: 0.8,
      evidence: [{ bookId, chunkId, contentHash: 'old-hash', excerpt: 'В эпилоге героиня жива.' }],
      provider: 'mock', model: 'mock',
    });
    const result = await collectHybridEvidence({
      db, question: 'финальное состояние', env: {}, searchFn: () => [], semanticLimit: 0,
      factFilters: [{ factType: 'plot_observation' }], includeRelatedFacts: false, limit: 5,
    });
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].chunk_id, chunkId);
    assert.equal(result.evidence[0].source, 'fact');
    assert.match(result.evidence[0].snippet, /героиня жива/);
    assert.doesNotMatch(result.evidence[0].snippet, /Derived fact|stale/i);
  } finally {
    db.close();
  }
});

test('cached fact validation uses the full excerpt before display truncation', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const bookId = insertBook(db, { cycleName: 'Cycle', title: 'Book', filePath: '/tmp/long-fact.fb2', contentHash: 'book' });
    const longExcerpt = `Начало ${'важная деталь '.repeat(70)}конец.`;
    const chunkId = insertChunk(db, { bookId, chunkIndex: 0, text: longExcerpt, contentHash: 'long-hash' });
    upsertDerivedFact(db, {
      bookId, factKey: 'plot.long', factType: 'plot_observation', factValue: 'present', confidence: 0.9,
      evidence: [{ bookId, chunkId, contentHash: 'long-hash', excerpt: longExcerpt }], provider: 'mock', model: 'mock',
    });
    const result = await collectHybridEvidence({
      db, question: 'длинный факт', env: {}, searchFn: () => [], semanticLimit: 0,
      factFilters: [{ factKey: 'plot.long' }], includeRelatedFacts: false, limit: 2,
    });
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].source, 'fact');
    assert.ok(result.evidence[0].snippet.length <= 700);
  } finally { db.close(); }
});

test('expandEvidenceContext drops punctuation-only target and neighbor separators', () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const bookId = insertBook(db, { cycleName: 'Cycle', title: 'Book', filePath: '/tmp/separators.fb2', contentHash: 'book' });
    const ids = [
      insertChunk(db, { bookId, chunkIndex: 0, text: '* * *', contentHash: 'h0' }),
      insertChunk(db, { bookId, chunkIndex: 1, text: '— — —', contentHash: 'h1' }),
      insertChunk(db, { bookId, chunkIndex: 2, text: 'Герои нашли старую карту.', contentHash: 'h2' }),
    ];
    const rows = expandEvidenceContext(db, [{
      chunk_id: ids[1], book_id: bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 1,
      snippet: '— — —', source: 'semantic', sources: ['semantic'],
    }], { neighborRadius: 1, limit: 4, maxExcerptChars: 1000 });
    assert.deepEqual(rows.map((row) => row.chunk_id), [ids[2]]);
  } finally { db.close(); }
});

test('collectHybridEvidence keeps inflected multi-term Russian evidence ahead of incidental literal matches', async () => {
  const rows = [
    { chunk_id: 1, book_id: 1, cycle_name: 'Ложный цикл', title: 'Ложная книга', chunk_index: 0, snippet: 'Внутри стало тихо, прошли дни и недели, а у далёких ворот собрались демоны.' },
    { chunk_id: 2, book_id: 2, cycle_name: 'Подходящий цикл', title: 'Подходящая книга', chunk_index: 0, snippet: 'Я призвал сразу трёх демонов и воплотил их внутри себя.' },
    { chunk_id: 3, book_id: 3, cycle_name: 'Шум', title: 'Герой', chunk_index: 0, snippet: 'Памятник героя стоял на площади.' },
  ];
  const result = await collectHybridEvidence({
    db: {}, question: 'Демоны внутри героя', env: {}, searchFn: () => rows,
    embedFn: async () => ({ status: 'needs_embedding_provider_key', setup: {} }),
    queryFactsFn: () => [], includeRelatedFacts: false, semanticLimit: 0, limit: 3,
  });
  assert.equal(result.evidence[0].book_id, 2);
  assert.equal(result.evidence.some((row) => row.book_id === 3), false);
});

test('collectHybridEvidence broadens and diversifies semantic candidates by cycle', async () => {
  const dominant = Array.from({ length: 12 }, (_, index) => ({
    chunk_id: index + 1, book_id: index + 1, cycle_name: 'Большой шумный цикл',
    title: `Шум ${index + 1}`, chunk_index: 0, text: `похожий шум ${index + 1}`, score: 1 - index / 100,
  }));
  const relevant = { chunk_id: 99, book_id: 99, cycle_name: 'Другой цикл', title: 'Точное совпадение', chunk_index: 0, text: 'демоны живут внутри героя', score: 0.75 };
  let requestedLimit = 0;
  const result = await collectHybridEvidence({
    db: {}, question: 'Демоны внутри героя', env: { OPENROUTER_API_KEY: 'test-key' }, searchFn: () => [],
    embedFn: async () => ({ status: 'embedded', provider: 'openrouter', model: 'embed', embedding: [1] }),
    semanticSearchFn: (_db, _embedding, options) => {
      requestedLimit = options.limit;
      return [...dominant, relevant].slice(0, options.limit);
    },
    queryFactsFn: () => [], includeRelatedFacts: false, limit: 6, semanticLimit: 6,
  });
  assert.ok(requestedLimit > 6);
  assert.ok(result.evidence.some((row) => row.cycle_name === 'Другой цикл'));
});
