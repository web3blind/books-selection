const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { runAskResearch } = require('../src/askResearch');

function seedBook(db, cycleName, title, chunks) {
  const bookId = Number(db.prepare(`INSERT INTO books
    (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status)
    VALUES (?, ?, ?, 1, 1, ?, ?, '', 'indexed')`)
    .run(cycleName, `/tmp/${cycleName}`, `/tmp/${title}.fb2`, `book-${title}`, title).lastInsertRowid);
  const chunkIds = chunks.map((text, chunkIndex) => Number(db.prepare(`INSERT INTO chunks
    (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, ?, ?, ?, 0, ?)`)
    .run(bookId, chunkIndex, text, `hash-${title}-${chunkIndex}`, text.length).lastInsertRowid));
  return { bookId, chunkIds };
}

test('runAskResearch plans, checks, refines and returns only cited verified candidates within hard limits', async () => {
  const db = initializeSearchDatabase(':memory:');
  const accepted = seedBook(db, 'Accepted Cycle', 'Accepted Book', ['В эпилоге оба героя живы.', 'герои вместе пережили финал']);
  const rejected = seedBook(db, 'Rejected Cycle', 'Rejected Book', ['герой погиб в финале']);
  const chatRequests = [];
  const retrievalRequests = [];
  const responses = [
    {
      intent: 'find surviving partners',
      queries: [
        { query: 'герои вместе финал', cycleNames: ['Accepted Cycle'] },
        { query: 'гибель героя финал', bookIds: [rejected.bookId, 999999] },
        { query: '', cycleNames: ['invented cycle'] },
      ],
    },
    {
      candidateChecks: [
        { bookId: accepted.bookId, verdict: 'supported', evidence: ['evidence_1'] },
        { bookId: rejected.bookId, verdict: 'rejected', evidence: ['evidence_2'] },
      ],
      rejectedCycles: ['Rejected Cycle', 'invented cycle'],
      additionalQueries: [{ query: 'эпилог герои живы', bookIds: [accepted.bookId] }],
    },
    {
      answer: 'Подходит Accepted Cycle.',
      confidence: 'high',
      uncertainty: 'Проверены только выбранные фрагменты.',
      evidence: ['evidence_1', 'evidence_3'],
      recommendations: [
        { bookId: accepted.bookId, evidence: ['evidence_1', 'evidence_3'] },
        { bookId: rejected.bookId, evidence: ['evidence_2'] },
      ],
      rejectedCycles: ['Rejected Cycle'],
    },
  ];

  try {
    const result = await runAskResearch({
      db,
      question: 'Где двое действуют вместе и выживают?',
      providerClient: {
        chatCompletion: async (request) => {
          chatRequests.push(request);
          return responses.shift();
        },
      },
      providerName: 'mock',
      provider: { model: 'mock-model' },
      retrievalFn: async ({ question, scope }) => {
        retrievalRequests.push({ question, scope });
        const isRejected = question.includes('гибель');
        const isRefine = question.includes('эпилог');
        const book = isRejected ? rejected : accepted;
        const chunkIndex = isRejected ? 0 : (isRefine ? 0 : 1);
        return {
          evidence: [{
            chunk_id: book.chunkIds[chunkIndex],
            book_id: book.bookId,
            cycle_name: isRejected ? 'Rejected Cycle' : 'Accepted Cycle',
            title: isRejected ? 'Rejected Book' : 'Accepted Book',
            chunk_index: chunkIndex,
            snippet: isRefine ? 'В эпилоге оба героя живы.' : (isRejected ? 'Герой погиб в финале.' : 'Герои вместе пережили финал.'),
            content_hash: isRejected ? 'hash-Rejected Book-0' : `hash-Accepted Book-${chunkIndex}`,
            source: 'semantic',
            sources: ['semantic'],
          }],
          semantic: { status: 'searched', coverage: { scoredCycles: 2, scoredBooks: 2, scoredChunks: 3, embeddingsComplete: true } },
        };
      },
    });

    assert.equal(chatRequests.length, 3);
    assert.match(chatRequests[2].messages[1].content, /Write answer and uncertainty in Russian/);
    assert.equal(retrievalRequests.length, 3);
    assert.deepEqual(retrievalRequests[0].scope, { cycleNames: ['Accepted Cycle'], bookIds: [] });
    assert.deepEqual(retrievalRequests[1].scope, { cycleNames: [], bookIds: [rejected.bookId] });
    assert.equal(result.answer, 'Подходит Accepted Cycle.');
    assert.deepEqual(result.candidates.map((candidate) => candidate.book), ['Accepted Book']);
    assert.deepEqual(result.cycleGroups.map((group) => group.cycle), ['Accepted Cycle']);
    assert.deepEqual(result.citedEvidence.map((item) => item.evidenceId), ['evidence_1', 'evidence_3']);
    assert.equal(result.research.mode, 'model_guided');
    assert.deepEqual(result.research.phases, ['plan', 'retrieve', 'check', 'refine', 'final']);
    assert.equal(result.research.chatCalls, 3);
    assert.equal(result.research.embeddingQueries, 3);
    assert.equal(result.research.partial, true);
    assert.deepEqual(result.research.rejectedCycles, ['Rejected Cycle']);
  } finally {
    db.close();
  }
});

test('runAskResearch persists only observations tied to current source chunk hashes', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['В эпилоге оба героя живы.']);
  const responses = [
    { queries: [{ query: 'эпилог герои живы' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'supported', evidence: ['evidence_1'] }] },
    {
      answer: 'Оба живы.', confidence: 'high', evidence: ['evidence_1'],
      recommendations: [{ bookId: book.bookId, evidence: ['evidence_1'] }],
      observations: [
        { bookId: book.bookId, factKey: 'plot.final_state', factType: 'plot_observation', factValue: 'both protagonists alive', confidence: 0.9, evidence: ['evidence_1'] },
        { bookId: 99999, factKey: 'plot.fake', factValue: 'fake', evidence: ['evidence_1'] },
        { bookId: book.bookId, factKey: 'bad key with spaces', factValue: 'fake', evidence: ['evidence_1'] },
      ],
    },
  ];
  try {
    const result = await runAskResearch({
      db, question: 'Кто жив?', providerName: 'mock', provider: { model: 'mock-model' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async () => ({
        evidence: [{
          chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0,
          snippet: 'В эпилоге оба героя живы.', content_hash: 'hash-Book-0', source: 'semantic', sources: ['semantic'],
        }],
        semantic: { status: 'searched' },
      }),
    });
    const facts = db.prepare('SELECT * FROM derived_facts').all();
    assert.equal(facts.length, 1);
    assert.equal(facts[0].fact_key, 'plot.final_state');
    const storedEvidence = JSON.parse(facts[0].evidence_json);
    assert.deepEqual(storedEvidence.map(({ bookId, chunkId, contentHash }) => ({ bookId, chunkId, contentHash })), [
      { bookId: book.bookId, chunkId: book.chunkIds[0], contentHash: 'hash-Book-0' },
    ]);
    assert.equal(result.research.persistedFacts, 1);
  } finally {
    db.close();
  }
});

test('runAskResearch reserves evidence capacity for refinement results', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', Array.from({ length: 10 }, (_, index) => `Фрагмент ${index} с доказательством.`));
  const responses = [
    { queries: [{ query: 'первичный поиск' }] },
    { candidateChecks: [], additionalQueries: [{ query: 'уточняющий поиск', bookIds: [book.bookId] }] },
    { answer: 'Уточнение найдено.', confidence: 'medium', evidence: ['evidence_7'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_7'] }] },
  ];
  try {
    const result = await runAskResearch({
      db, question: 'Найди уточнение', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async ({ question }) => ({
        evidence: (question.includes('уточняющий') ? book.chunkIds.slice(6, 9) : book.chunkIds.slice(0, 6)).map((chunkId, index) => ({
          chunk_id: chunkId, book_id: book.bookId, cycle_name: 'Cycle', title: 'Book',
          chunk_index: question.includes('уточняющий') ? index + 6 : index,
          snippet: question.includes('уточняющий') ? `Уточнение ${index}.` : `Первичный ${index}.`,
          content_hash: `hash-Book-${question.includes('уточняющий') ? index + 6 : index}`, source: 'semantic',
        })), semantic: { status: 'searched' },
      }),
    });
    assert.equal(result.evidence.length, 9);
    assert.equal(result.citedEvidence[0].evidenceId, 'evidence_7');
    assert.match(result.citedEvidence[0].excerpt, /Уточнение/);
  } finally { db.close(); }
});

test('runAskResearch excludes books explicitly rejected by candidate checks', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Фрагмент опровергает условие.']);
  const responses = [
    { queries: [{ query: 'проверка' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'rejected', evidence: ['evidence_1'] }] },
    { answer: 'Книга не подходит.', confidence: 'high', evidence: ['evidence_1'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_1'] }] },
  ];
  try {
    await assert.rejects(runAskResearch({
      db, question: 'Подходит ли книга?', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0, snippet: 'Фрагмент опровергает условие.', content_hash: 'hash-Book-0', source: 'semantic' }], semantic: { status: 'searched' } }),
    }), /supported by supplied evidence/i);
  } finally { db.close(); }
});

test('runAskResearch rejects uncited final answers and observes cancellation between mocked calls', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Доказательство.']);
  const makeRun = (providerClient, signal) => runAskResearch({
    db, question: 'Вопрос', providerName: 'mock', provider: { model: 'mock' }, providerClient, signal,
    retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0, snippet: 'Доказательство.', content_hash: 'hash-Book-0', source: 'semantic' }], semantic: { status: 'searched' } }),
  });
  try {
    const responses = [{ queries: [{ query: 'поиск' }] }, {}, { answer: 'Без ссылки.', evidence: [] }];
    await assert.rejects(makeRun({ chatCompletion: async () => responses.shift() }), /supported by supplied evidence/i);
    const controller = new AbortController();
    await assert.rejects(makeRun({ chatCompletion: async () => {
      controller.abort();
      return { queries: [{ query: 'поиск' }] };
    } }, controller.signal), (error) => error.name === 'AbortError');
  } finally { db.close(); }
});

test('runAskResearch catalog is limited to the active root and discloses its size', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    db.prepare(`INSERT INTO corpus_state
      (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
      VALUES (1, '/active', 1, 1, 1, 1, 0, 0, 1)`).run();
    db.prepare(`INSERT INTO books
      (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
      VALUES ('Active', '/active', '/active/a.fb2', 1, 1, 'a', 'Active Book', '', 'indexed', '/active')`).run();
    const insertExtra = db.prepare(`INSERT INTO books
      (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
      VALUES ('Extra', '/active', ?, 1, 1, ?, ?, '', 'indexed', '/active')`);
    for (let index = 0; index < 240; index += 1) insertExtra.run(`/active/${index}.fb2`, `extra-${index}`, `Extra ${String(index).padStart(3, '0')}`);
    db.prepare(`INSERT INTO books
      (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
      VALUES ('Old', '/old', '/old/a.fb2', 1, 1, 'b', 'Old Book', '', 'indexed', '/old')`).run();
    let planText = '';
    const result = await runAskResearch({
      db, question: 'Вопрос', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async ({ messages }) => { planText = messages[1].content; return { queries: [{ query: 'ничего' }] }; } },
      retrievalFn: async () => ({ evidence: [], semantic: { status: 'searched' } }),
    });
    assert.match(planText, /Active Book/);
    assert.doesNotMatch(planText, /Old Book/);
    assert.match(planText, /showing 240 of 241 active-root books/);
    assert.deepEqual(result.research.catalog, { total: 241, included: 240, truncated: true });
  } finally { db.close(); }
});
