const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { extractFactFromEvidence } = require('../src/factExtractor');
const { queryDerivedFacts } = require('../src/facts');

function insertBookAndChunk(db) {
  const book = db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Generic Cycle',
    '/tmp/Generic Cycle',
    '/tmp/Generic Cycle/book.fb2',
    1,
    2,
    'generic-book-hash',
    'Generic Book',
    'Annotation',
    'indexed',
  );
  const bookId = Number(book.lastInsertRowid);
  const chunk = db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    bookId,
    4,
    'Полный текст чанка содержит секретный контекст, который нельзя отправлять модели.',
    'generic-chunk-hash',
    0,
    73,
  );

  return { bookId, chunkId: Number(chunk.lastInsertRowid) };
}

const suppliedEvidence = [
  {
    bookId: 1,
    cycle: 'Generic Cycle',
    book: 'Generic Book',
    chunkId: 10,
    chunkIndex: 4,
    excerpt: 'В финале герой чинит маяк и остаётся в городе.',
    text: 'Полный текст чанка содержит секретный контекст, который нельзя отправлять модели.',
  },
];

test('extractFactFromEvidence returns setup status without provider key and does not call provider', async () => {
  const db = initializeSearchDatabase(':memory:');
  let providerCalled = false;

  try {
    const { bookId } = insertBookAndChunk(db);
    const result = await extractFactFromEvidence({
      db,
      bookId,
      factKey: 'repairs_lighthouse',
      factType: 'plot_trait',
      question: 'Чинит ли герой маяк?',
      evidenceRows: suppliedEvidence,
      env: {},
      providerClient: {
        chatCompletion: async () => {
          providerCalled = true;
          return { fact_value: 'should not happen' };
        },
      },
    });

    assert.equal(providerCalled, false);
    assert.equal(result.status, 'needs_provider_key');
    assert.equal(result.factKey, 'repairs_lighthouse');
    assert.equal(result.factType, 'plot_trait');
    assert.equal(result.setup.provider, 'openrouter');
    assert.equal(result.setup.apiKeyEnv, 'OPENROUTER_API_KEY');
    assert.deepEqual(queryDerivedFacts(db, { bookId }), []);
  } finally {
    db.close();
  }
});

test('extractFactFromEvidence sends only supplied excerpts to mocked provider and upserts a generic derived fact', async () => {
  const db = initializeSearchDatabase(':memory:');
  let sentMessages;

  try {
    const { bookId, chunkId } = insertBookAndChunk(db);
    const result = await extractFactFromEvidence({
      db,
      bookId,
      factKey: 'repairs_lighthouse',
      factType: 'plot_trait',
      question: 'Чинит ли герой маяк?',
      evidenceRows: [
        {
          ...suppliedEvidence[0],
          bookId,
          chunkId,
        },
      ],
      env: { OPENROUTER_API_KEY: 'test-key' },
      providerClient: {
        chatCompletion: async ({ messages }) => {
          sentMessages = messages;
          return {
            fact_key: 'provider-tried-to-rename-key',
            fact_type: 'provider-tried-to-rename-type',
            fact_value: 'yes',
            confidence: 0.88,
            evidence: [
              { chunkId, excerpt: 'В финале герой чинит маяк и остаётся в городе.' },
            ],
          };
        },
      },
    });

    const sentText = JSON.stringify(sentMessages);
    assert.match(sentText, /fact_key: repairs_lighthouse/);
    assert.match(sentText, /fact_type: plot_trait/);
    assert.match(sentText, /В финале герой чинит маяк/);
    assert.doesNotMatch(sentText, /секретный контекст/);
    assert.doesNotMatch(sentText, /love card|romance/i);
    assert.equal(result.status, 'extracted');
    assert.equal(result.fact.factKey, 'repairs_lighthouse');
    assert.equal(result.fact.factType, 'plot_trait');
    assert.equal(result.fact.factValue, 'yes');
    assert.equal(result.fact.confidence, 0.88);
    assert.equal(result.fact.provider, 'openrouter');
    assert.equal(result.fact.model, 'openai/gpt-4.1-nano');
    assert.deepEqual(result.fact.evidence, [
      { chunkId, excerpt: 'В финале герой чинит маяк и остаётся в городе.' },
    ]);

    const stored = queryDerivedFacts(db, { bookId, factKey: 'repairs_lighthouse' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].factValue, 'yes');
  } finally {
    db.close();
  }
});

test('extractFactFromEvidence accepts arbitrary fact keys and fact types without romance-specific schema', async () => {
  const db = initializeSearchDatabase(':memory:');

  try {
    const { bookId } = insertBookAndChunk(db);
    const result = await extractFactFromEvidence({
      db,
      bookId,
      factKey: 'narrative_weather_pattern',
      factType: 'atmosphere_signal',
      question: 'Какая погода важна для атмосферы?',
      evidenceRows: [{ excerpt: 'В каждой главе идёт холодный дождь.' }],
      env: { OPENROUTER_API_KEY: 'test-key' },
      providerClient: {
        chatCompletion: async () => ({
          fact_value: 'cold_rain',
          confidence: 0.7,
          evidence: [{ excerpt: 'В каждой главе идёт холодный дождь.' }],
        }),
      },
    });

    assert.equal(result.status, 'extracted');
    assert.equal(result.fact.factKey, 'narrative_weather_pattern');
    assert.equal(result.fact.factType, 'atmosphere_signal');
    assert.equal(result.fact.factValue, 'cold_rain');
  } finally {
    db.close();
  }
});
