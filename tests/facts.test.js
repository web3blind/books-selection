const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const {
  buildFactExtractionPrompt,
  createEvent,
  createEvidence,
  createRelation,
  getOrCreateEntity,
  queryDerivedFacts,
  upsertDerivedFact,
} = require('../src/facts');

function insertBookAndChunk(db, overrides = {}) {
  const book = db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.cycleName || 'Fact Cycle',
    '/tmp/Fact Cycle',
    overrides.filePath || '/tmp/Fact Cycle/book.fb2',
    1,
    2,
    overrides.contentHash || 'book-hash',
    overrides.title || 'Fact Book',
    'Annotation',
    'indexed',
  );
  const bookId = Number(book.lastInsertRowid);
  const chunk = db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookId, 0, 'Герои идут вместе через лес. Тайный полный контекст не должен уходить в prompt.', 'chunk-hash', 0, 78);

  return { bookId, chunkId: Number(chunk.lastInsertRowid) };
}

test('getOrCreateEntity creates and reuses a book-scoped entity normalized by name and kind', () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const { bookId } = insertBookAndChunk(db);

    const first = getOrCreateEntity(db, { bookId, name: '  Алиса   Северная ', kind: 'character' });
    const second = getOrCreateEntity(db, { bookId, name: 'алиса северная', kind: 'character' });
    const otherKind = getOrCreateEntity(db, { bookId, name: 'алиса северная', kind: 'concept' });

    assert.equal(first.id, second.id);
    assert.notEqual(first.id, otherKind.id);
    assert.equal(second.normalizedName, 'алиса северная');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entities WHERE book_id = ?').get(bookId).count, 2);
  } finally {
    db.close();
  }
});

test('fact helpers create evidence-linked relations and events', () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const { bookId, chunkId } = insertBookAndChunk(db);
    const source = getOrCreateEntity(db, { bookId, name: 'Алиса', kind: 'character' });
    const target = getOrCreateEntity(db, { bookId, name: 'Кир', kind: 'character' });
    const evidence = createEvidence(db, {
      bookId,
      chunkId,
      excerpt: 'Алиса и Кир идут вместе через лес.',
    });
    const relation = createRelation(db, {
      bookId,
      sourceEntityId: source.id,
      targetEntityId: target.id,
      relationType: 'travels_with',
      evidenceId: evidence.id,
      confidence: 0.82,
    });
    const event = createEvent(db, {
      bookId,
      eventType: 'journey',
      summary: 'Алиса и Кир идут через лес.',
      evidenceId: evidence.id,
      confidence: 0.75,
    });

    assert.equal(evidence.bookId, bookId);
    assert.equal(evidence.chunkId, chunkId);
    assert.equal(evidence.excerpt, 'Алиса и Кир идут вместе через лес.');
    assert.equal(relation.sourceEntityId, source.id);
    assert.equal(relation.targetEntityId, target.id);
    assert.equal(relation.evidenceId, evidence.id);
    assert.equal(relation.relationType, 'travels_with');
    assert.equal(event.bookId, bookId);
    assert.equal(event.evidenceId, evidence.id);
    assert.equal(event.eventType, 'journey');

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((item) => item.name);
    assert.ok(indexes.includes('idx_evidence_book_chunk'));
    assert.ok(indexes.includes('idx_relations_book_type'));
    assert.ok(indexes.includes('idx_events_book_type'));
  } finally {
    db.close();
  }
});

test('upsertDerivedFact stores provider/model/confidence and replaces by book and fact key', () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const { bookId, chunkId } = insertBookAndChunk(db);
    const evidence = createEvidence(db, { bookId, chunkId, excerpt: 'Герои действуют вместе.' });

    const first = upsertDerivedFact(db, {
      bookId,
      factKey: 'acts_together_through_main_plot',
      factType: 'plot_trait',
      factValue: 'partial',
      confidence: 0.55,
      evidence: [{ evidenceId: evidence.id, excerpt: evidence.excerpt }],
      provider: 'openrouter',
      model: 'test-model-a',
    });
    const second = upsertDerivedFact(db, {
      bookId,
      factKey: 'acts_together_through_main_plot',
      factType: 'plot_trait',
      factValue: 'yes',
      confidence: 0.9,
      evidence: [{ evidenceId: evidence.id, chunkId, excerpt: evidence.excerpt }],
      provider: 'local',
      model: 'test-model-b',
    });

    assert.equal(first.id, second.id);
    assert.equal(second.factValue, 'yes');
    assert.equal(second.factType, 'plot_trait');
    assert.equal(second.confidence, 0.9);
    assert.equal(second.provider, 'local');
    assert.equal(second.model, 'test-model-b');
    assert.deepEqual(second.evidence, [{ evidenceId: evidence.id, chunkId, excerpt: evidence.excerpt }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM derived_facts WHERE book_id = ?').get(bookId).count, 1);
  } finally {
    db.close();
  }
});

test('queryDerivedFacts filters cached facts by book, cycle, and generic fact type', () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const first = insertBookAndChunk(db, { cycleName: 'Cycle A', filePath: '/tmp/a/book.fb2', title: 'Book A', contentHash: 'hash-a' });
    const second = insertBookAndChunk(db, { cycleName: 'Cycle B', filePath: '/tmp/b/book.fb2', title: 'Book B', contentHash: 'hash-b' });
    upsertDerivedFact(db, { bookId: first.bookId, factKey: 'tone', factType: 'mood', factValue: 'dark', evidence: [], provider: 'local', model: 'model' });
    upsertDerivedFact(db, { bookId: first.bookId, factKey: 'has_artifact', factType: 'plot_trait', factValue: 'yes', evidence: [], provider: 'local', model: 'model' });
    upsertDerivedFact(db, { bookId: second.bookId, factKey: 'tone', factType: 'mood', factValue: 'bright', evidence: [], provider: 'local', model: 'model' });

    const byBook = queryDerivedFacts(db, { bookId: first.bookId });
    const byCycleAndType = queryDerivedFacts(db, { cycleName: 'Cycle A', factType: 'mood' });

    assert.deepEqual(byBook.map((fact) => fact.factKey).sort(), ['has_artifact', 'tone']);
    assert.equal(byCycleAndType.length, 1);
    assert.equal(byCycleAndType[0].bookId, first.bookId);
    assert.equal(byCycleAndType[0].cycleName, 'Cycle A');
    assert.equal(byCycleAndType[0].bookTitle, 'Book A');
    assert.equal(byCycleAndType[0].factType, 'mood');
    assert.equal(byCycleAndType[0].factValue, 'dark');
  } finally {
    db.close();
  }
});

test('buildFactExtractionPrompt is generic and includes only supplied evidence excerpts', () => {
  const prompt = buildFactExtractionPrompt({
    factKey: 'survives_finale',
    factType: 'plot_trait',
    question: 'Кто жив в финале?',
    chunks: [
      {
        bookId: 1,
        cycle: 'Cycle A',
        book: 'Book A',
        chunkId: 10,
        chunkIndex: 3,
        excerpt: 'В эпилоге Алиса отвечает на письмо.',
        text: 'В эпилоге Алиса отвечает на письмо. Скрытый полный контекст не нужен.',
      },
    ],
  });

  assert.match(prompt, /fact_key: survives_finale/);
  assert.match(prompt, /fact_type: plot_trait/);
  assert.match(prompt, /Кто жив в финале\?/);
  assert.match(prompt, /chunk_id=10/);
  assert.match(prompt, /В эпилоге Алиса отвечает на письмо/);
  assert.doesNotMatch(prompt, /Скрытый полный контекст не нужен/);
  assert.doesNotMatch(prompt, /love card|romance/i);
});
