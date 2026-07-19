function normalizeEntityName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function assertRequired(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label} is required.`);
  }
}

function mapEntity(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    kind: row.kind,
    normalizedName: row.normalized_name,
  };
}

function mapEvidence(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    chunkId: row.chunk_id,
    excerpt: row.excerpt,
    source: row.source,
  };
}

function mapRelation(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationType: row.relation_type,
    confidence: row.confidence,
    evidenceId: row.evidence_id,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    eventType: row.event_type,
    summary: row.summary,
    confidence: row.confidence,
    evidenceId: row.evidence_id,
  };
}

function mapDerivedFact(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    cycleName: row.cycle_name,
    bookTitle: row.title,
    factKey: row.fact_key,
    factType: row.fact_type,
    factValue: row.fact_value,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json || '[]'),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
  };
}

function getOrCreateEntity(db, { bookId, name, kind }) {
  assertRequired(bookId, 'bookId');
  assertRequired(name, 'name');
  assertRequired(kind, 'kind');

  const normalizedName = normalizeEntityName(name);
  const existing = db.prepare(`
    SELECT id, book_id, name, kind, normalized_name
    FROM entities
    WHERE book_id = ? AND kind = ? AND normalized_name = ?
  `).get(bookId, kind, normalizedName);

  if (existing) {
    return mapEntity(existing);
  }

  const result = db.prepare(`
    INSERT INTO entities (book_id, name, kind, normalized_name)
    VALUES (?, ?, ?, ?)
  `).run(bookId, String(name).trim().replace(/\s+/g, ' '), kind, normalizedName);

  return mapEntity(db.prepare('SELECT id, book_id, name, kind, normalized_name FROM entities WHERE id = ?')
    .get(Number(result.lastInsertRowid)));
}

function createEvidence(db, { bookId, chunkId = null, excerpt, source = 'chunk' }) {
  assertRequired(bookId, 'bookId');
  assertRequired(excerpt, 'excerpt');

  const result = db.prepare(`
    INSERT INTO evidence (book_id, chunk_id, excerpt, source)
    VALUES (?, ?, ?, ?)
  `).run(bookId, chunkId, String(excerpt).trim(), source);

  return mapEvidence(db.prepare('SELECT id, book_id, chunk_id, excerpt, source FROM evidence WHERE id = ?')
    .get(Number(result.lastInsertRowid)));
}

function createRelation(db, {
  bookId,
  sourceEntityId,
  targetEntityId,
  relationType,
  confidence = null,
  evidenceId = null,
}) {
  assertRequired(bookId, 'bookId');
  assertRequired(sourceEntityId, 'sourceEntityId');
  assertRequired(targetEntityId, 'targetEntityId');
  assertRequired(relationType, 'relationType');

  const result = db.prepare(`
    INSERT INTO relations (book_id, source_entity_id, target_entity_id, relation_type, confidence, evidence_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookId, sourceEntityId, targetEntityId, relationType, confidence, evidenceId);

  return mapRelation(db.prepare(`
    SELECT id, book_id, source_entity_id, target_entity_id, relation_type, confidence, evidence_id
    FROM relations WHERE id = ?
  `).get(Number(result.lastInsertRowid)));
}

function createEvent(db, { bookId, eventType, summary, confidence = null, evidenceId = null }) {
  assertRequired(bookId, 'bookId');
  assertRequired(eventType, 'eventType');
  assertRequired(summary, 'summary');

  const result = db.prepare(`
    INSERT INTO events (book_id, event_type, summary, confidence, evidence_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, eventType, String(summary).trim(), confidence, evidenceId);

  return mapEvent(db.prepare('SELECT id, book_id, event_type, summary, confidence, evidence_id FROM events WHERE id = ?')
    .get(Number(result.lastInsertRowid)));
}

function upsertDerivedFact(db, {
  bookId,
  factKey,
  factType = 'generic',
  factValue,
  confidence = null,
  evidence = [],
  provider = null,
  model = null,
}) {
  assertRequired(bookId, 'bookId');
  assertRequired(factKey, 'factKey');
  assertRequired(factValue, 'factValue');

  db.prepare(`
    INSERT INTO derived_facts (book_id, fact_key, fact_type, fact_value, confidence, evidence_json, provider, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(book_id, fact_key) DO UPDATE SET
      fact_type = excluded.fact_type,
      fact_value = excluded.fact_value,
      confidence = excluded.confidence,
      evidence_json = excluded.evidence_json,
      provider = excluded.provider,
      model = excluded.model,
      created_at = CURRENT_TIMESTAMP
  `).run(bookId, factKey, factType, String(factValue), confidence, JSON.stringify(evidence), provider, model);

  return queryDerivedFacts(db, { bookId, factKey })[0];
}

function queryDerivedFacts(db, { bookId, cycleName, factType, factKey } = {}) {
  const conditions = [];
  const params = [];

  if (bookId !== undefined) {
    conditions.push('derived_facts.book_id = ?');
    params.push(bookId);
  }
  if (cycleName !== undefined) {
    conditions.push('books.cycle_name = ?');
    params.push(cycleName);
  }
  if (factType !== undefined) {
    conditions.push('derived_facts.fact_type = ?');
    params.push(factType);
  }
  if (factKey !== undefined) {
    conditions.push('derived_facts.fact_key = ?');
    params.push(factKey);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT derived_facts.*, books.cycle_name, books.title
    FROM derived_facts
    JOIN books ON books.id = derived_facts.book_id
    ${where}
    ORDER BY books.cycle_name, books.title, derived_facts.fact_type, derived_facts.fact_key
  `).all(...params).map(mapDerivedFact);
}

function buildFactExtractionPrompt({ factKey, factType = 'generic', question = '', chunks = [] }) {
  assertRequired(factKey, 'factKey');

  const evidence = chunks.map((chunk, index) => {
    const label = [
      `evidence_${index + 1}`,
      `book_id=${chunk.bookId ?? ''}`,
      `chunk_id=${chunk.chunkId ?? ''}`,
      `chunk_index=${chunk.chunkIndex ?? ''}`,
    ].join(' ');
    return `${label}\nCycle: ${chunk.cycle || ''}\nBook: ${chunk.book || ''}\nExcerpt: ${chunk.excerpt || chunk.snippet || ''}`;
  }).join('\n\n');

  return [
    'Extract one generic structured fact from the supplied local book evidence only.',
    'Do not use outside knowledge. If the evidence is insufficient, return fact_value="unknown" and low confidence.',
    'Return strict JSON with fact_key, fact_type, fact_value, confidence, evidence.',
    `fact_key: ${factKey}`,
    `fact_type: ${factType}`,
    question ? `question: ${question}` : '',
    'Evidence excerpts:',
    evidence || 'No evidence excerpts supplied.',
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  buildFactExtractionPrompt,
  createEvent,
  createEvidence,
  createRelation,
  getOrCreateEntity,
  normalizeEntityName,
  queryDerivedFacts,
  upsertDerivedFact,
};
