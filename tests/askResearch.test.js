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

function supportedFinalCheck(bookId, evidence, criterion = 'requested condition') {
  return {
    bookId, verdict: 'supported', evidence, reason: 'Named entities satisfy the requested condition in the cited text.',
    entities: [{ name: 'named entities', evidence }],
    criteria: [{ criterion, verdict: 'supported', reason: 'The cited text directly supports this condition.', evidence }],
  };
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
      finalCandidateChecks: [supportedFinalCheck(accepted.bookId, ['evidence_1', 'evidence_3'])],
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
    assert.equal(retrievalRequests.length, 4);
    assert.equal(retrievalRequests[0].question, 'Где двое действуют вместе и выживают');
    assert.deepEqual(retrievalRequests.slice(0, 3).map((item) => item.scope), [
      { cycleNames: [], bookIds: [] },
      { cycleNames: [], bookIds: [] },
      { cycleNames: [], bookIds: [] },
    ]);
    assert.deepEqual(retrievalRequests[3].scope, { cycleNames: [], bookIds: [accepted.bookId] });
    assert.equal(result.answer, 'Подходит Accepted Cycle.');
    assert.deepEqual(result.candidates.map((candidate) => candidate.book), ['Accepted Book']);
    assert.deepEqual(result.cycleGroups.map((group) => group.cycle), ['Accepted Cycle']);
    assert.deepEqual(result.citedEvidence.map((item) => item.evidenceId), ['evidence_1', 'evidence_3']);
    assert.equal(result.research.mode, 'model_guided');
    assert.deepEqual(result.research.phases, ['plan', 'retrieve', 'check', 'refine', 'final']);
    assert.equal(result.research.chatCalls, 3);
    assert.equal(result.research.embeddingQueries, 4);
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
      finalCandidateChecks: [supportedFinalCheck(book.bookId, ['evidence_1'])],
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
    { candidateChecks: [{ bookId: book.bookId, verdict: 'supported', evidence: ['evidence_1'] }], additionalQueries: [{ query: 'уточняющий поиск', bookIds: [book.bookId] }] },
    { status: 'answered', answer: 'Уточнение найдено.', confidence: 'medium', evidence: ['evidence_7'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_7'] }], finalCandidateChecks: [supportedFinalCheck(book.bookId, ['evidence_7'])] },
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

test('runAskResearch returns evidence_insufficient without candidate cards for a contradicted recommendation', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Фрагмент опровергает условие.']);
  const responses = [
    { queries: [{ query: 'проверка' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'rejected', evidence: ['evidence_1'] }] },
    { answer: 'Книга не подходит.', confidence: 'high', evidence: ['evidence_1'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_1'] }] },
    { status: 'evidence_insufficient', recommendations: [] },
  ];
  try {
    const result = await runAskResearch({
      db, question: 'Подходит ли книга?', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0, snippet: 'Фрагмент опровергает условие.', content_hash: 'hash-Book-0', source: 'semantic' }], semantic: { status: 'searched' } }),
    });
    assert.equal(result.status, 'evidence_insufficient');
    assert.match(result.answer, /недостаточно подтверждённых данных/i);
    assert.deepEqual(result.citedEvidence, []);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.cycleGroups, []);
    assert.equal(result.research.persistedFacts, 0);
  } finally { db.close(); }
});

test('runAskResearch returns evidence_insufficient for uncited final prose and observes cancellation between mocked calls', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Доказательство.']);
  const makeRun = (providerClient, signal) => runAskResearch({
    db, question: 'Вопрос', providerName: 'mock', provider: { model: 'mock' }, providerClient, signal,
    retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0, snippet: 'Доказательство.', content_hash: 'hash-Book-0', source: 'semantic' }], semantic: { status: 'searched' } }),
  });
  try {
    const responses = [{ queries: [{ query: 'поиск' }] }, {}, { answer: 'Без ссылки.', evidence: [] }, { status: 'evidence_insufficient', recommendations: [] }];
    const insufficient = await makeRun({ chatCompletion: async () => responses.shift() });
    assert.equal(insufficient.status, 'evidence_insufficient');
    assert.doesNotMatch(insufficient.answer, /Без ссылки/);
    assert.deepEqual(insufficient.candidates, []);
    const controller = new AbortController();
    await assert.rejects(makeRun({ chatCompletion: async () => {
      controller.abort();
      return { queries: [{ query: 'поиск' }] };
    } }, controller.signal), (error) => error.name === 'AbortError');
  } finally { db.close(); }
});

test('runAskResearch retries one truncated final response and keeps the four-call cap', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Доказательство.']);
  const truncated = { answer: '{"answer":"Оборвано' };
  Object.defineProperty(truncated, '_providerResponse', { value: { parsedJson: false, finishReason: 'length' } });
  const responses = [
    { queries: [{ query: 'поиск' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'supported', evidence: ['evidence_1'] }] },
    truncated,
    { status: 'answered', answer: 'Подтверждено.', confidence: 'low', evidence: ['evidence_1'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_1'] }], finalCandidateChecks: [supportedFinalCheck(book.bookId, ['evidence_1'])] },
  ];
  const phases = [];
  try {
    const result = await runAskResearch({
      db, question: 'Что подтверждено?', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async ({ messages }) => { phases.push(messages[0].content); return responses.shift(); } },
      retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0, snippet: 'Доказательство.', content_hash: 'hash-Book-0', source: 'semantic' }], semantic: { status: 'searched' } }),
    });
    assert.equal(result.status, 'answered');
    assert.equal(result.answer, 'Подтверждено.');
    assert.equal(result.research.chatCalls, 4);
    assert.match(phases[3], /final-recovery phase/);
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

test('foreign verbose plan and rejected weak roster evidence cannot produce a recommendation', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Ложный цикл', 'Книга-призыв', ['* * *', 'На совет призвали: Алина, Борис, Вера.', 'Алина и Борис стояли в одном зале.']);
  const queries = [];
  const responses = [
    { queries: [{ query: 'find all romantic protagonists who remain together and survive throughout every volume in the complete series' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'rejected', evidence: ['evidence_1'] }], additionalQueries: [{ query: 'Алина Борис', bookIds: [book.bookId] }] },
    { answer: 'Цикл подходит.', evidence: ['evidence_1'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_1'] }] },
    { status: 'evidence_insufficient', recommendations: [] },
  ];
  try {
    const result = await runAskResearch({
      db, question: 'Найди цикл, где два главных героя действуют вместе и оба живы в финале.',
      providerClient: { chatCompletion: async () => responses.shift() }, providerName: 'mock', provider: { model: 'mock' },
      retrievalFn: async ({ question, scope }) => {
        queries.push({ question, scope });
        return { evidence: [
          { chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Ложный цикл', title: 'Книга-призыв', chunk_index: 0, snippet: '* * *', content_hash: 'hash-Книга-призыв-0', source: 'neighbor' },
          { chunk_id: book.chunkIds[1], book_id: book.bookId, cycle_name: 'Ложный цикл', title: 'Книга-призыв', chunk_index: 1, snippet: 'На совет призвали: Алина, Борис, Вера.', content_hash: 'hash-Книга-призыв-1', source: 'semantic' },
          { chunk_id: book.chunkIds[2], book_id: book.bookId, cycle_name: 'Ложный цикл', title: 'Книга-призыв', chunk_index: 2, snippet: 'Алина и Борис стояли в одном зале.', content_hash: 'hash-Книга-призыв-2', source: 'neighbor' },
        ], semantic: { status: 'searched' } };
      },
    });
    assert.match(queries[0].question, /[А-Яа-яЁё]/);
    assert.ok(queries[0].question.split(/\s+/).length <= 12);
    assert.deepEqual(queries[1].scope.bookIds, [book.bookId]);
    assert.equal(result.status, 'evidence_insufficient');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.evidence.some((item) => item.excerpt === '* * *'), false);
    assert.equal(result.evidence.some((item) => /стояли в одном зале/.test(item.excerpt)), true);
  } finally { db.close(); }
});

test('refinement can revise uncertain to supported using newly retrieved book evidence', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Ада и Бен названы.', 'В эпилоге Ада и Бен вместе вернулись домой.']);
  const responses = [
    { intentType: 'recommendation', queries: [{ query: 'Ада Бен' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'uncertain', evidence: ['evidence_1'], reason: 'Имена есть, отношение не доказано.' }], additionalQueries: [{ query: 'Ада Бен эпилог', bookIds: [book.bookId] }] },
    { status: 'answered', answer: 'Книга подходит.', evidence: ['evidence_2'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_2'] }], finalCandidateChecks: [supportedFinalCheck(book.bookId, ['evidence_2'], 'вместе в финале')] },
  ];
  let retrieval = 0;
  try {
    const result = await runAskResearch({
      db, question: 'Найди книгу, где Ада и Бен вместе в финале',
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async () => {
        const index = retrieval++;
        return { evidence: [{ chunk_id: book.chunkIds[index], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: index, snippet: index ? 'В эпилоге Ада и Бен вместе вернулись домой.' : 'Ада и Бен названы.', content_hash: `hash-Book-${index}`, source: 'semantic' }], semantic: { status: 'searched' } };
      },
    });
    assert.deepEqual(result.candidates.map((item) => item.bookId), [book.bookId]);
    assert.equal(result.research.chatCalls, 3);
    assert.equal(result.research.embeddingQueries, 3);
  } finally { db.close(); }
});

test('model-supplied book and evidence IDs cannot turn a roster into a supported recommendation without final criterion and entity checks', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Roster', 'Roster Book', ['Участники совета: Ада, Бен, Вера.']);
  const responses = [
    { intentType: 'recommendation', queries: [{ query: 'Ада Бен' }] },
    { candidateChecks: [{ bookId: book.bookId, verdict: 'uncertain', evidence: ['evidence_1'], reason: 'Только список имён.' }] },
    { status: 'answered', answer: 'Подходит.', evidence: ['evidence_1'], recommendations: [{ bookId: book.bookId, evidence: ['evidence_1'] }], finalCandidateChecks: [{ bookId: book.bookId, verdict: 'supported', evidence: ['evidence_1'], reason: 'Они в списке.' }] },
    { status: 'evidence_insufficient', recommendations: [], finalCandidateChecks: [] },
  ];
  try {
    const result = await runAskResearch({ db, question: 'Найди книгу об отношениях Ады и Бена', providerClient: { chatCompletion: async () => responses.shift() }, retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Roster', title: 'Roster Book', chunk_index: 0, snippet: 'Участники совета: Ада, Бен, Вера.', content_hash: 'hash-Roster Book-0', source: 'semantic' }], semantic: { status: 'searched' } }) });
    assert.equal(result.status, 'evidence_insufficient');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.research.chatCalls, 4);
  } finally { db.close(); }
});

test('ordinary question-answer intent does not require recommendation candidates', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Cycle', 'Book', ['Фонарь лежал у двери.']);
  const responses = [
    { intentType: 'question_answer', queries: [{ query: 'фонарь дверь' }] },
    { candidateChecks: [] },
    { status: 'answered', answer: 'Фонарь лежал у двери.', evidence: ['evidence_1'], recommendations: [], finalCandidateChecks: [] },
  ];
  try {
    const result = await runAskResearch({ db, question: 'Где лежал фонарь?', providerClient: { chatCompletion: async () => responses.shift() }, retrievalFn: async () => ({ evidence: [{ chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Cycle', title: 'Book', chunk_index: 0, snippet: 'Фонарь лежал у двери.', content_hash: 'hash-Book-0', source: 'semantic' }], semantic: { status: 'searched' } }) });
    assert.equal(result.status, 'answered');
    assert.equal(result.answer, 'Фонарь лежал у двери.');
    assert.deepEqual(result.candidates, []);
  } finally { db.close(); }
});

test('generic non-romance question can support a realistic pair of books in one scoped cycle', async () => {
  const db = initializeSearchDatabase(':memory:');
  const first = seedBook(db, 'Архивисты', 'Карта пепла', ['Ира и Тим вместе расшифровали карту.']);
  const second = seedBook(db, 'Архивисты', 'Последний архив', ['Ира и Тим открыли архив в эпилоге.']);
  const responses = [
    { queries: [{ query: 'архив карта экспедиция' }] },
    { candidateChecks: [{ bookId: first.bookId, verdict: 'supported', evidence: ['evidence_1'] }, { bookId: second.bookId, verdict: 'supported', evidence: ['evidence_2'] }], additionalQueries: [{ query: 'Ира Тим архив', cycleNames: ['Архивисты'] }] },
    { status: 'answered', answer: 'Одна команда исследует архивы в двух книгах.', confidence: 'medium', evidence: ['evidence_1', 'evidence_2'], recommendations: [{ bookId: first.bookId, evidence: ['evidence_1'] }, { bookId: second.bookId, evidence: ['evidence_2'] }], finalCandidateChecks: [supportedFinalCheck(first.bookId, ['evidence_1']), supportedFinalCheck(second.bookId, ['evidence_2'])] },
  ];
  let retrievalCall = 0;
  try {
    const result = await runAskResearch({
      db, question: 'В каком цикле одна команда исследует древние архивы в нескольких книгах?',
      providerClient: { chatCompletion: async () => responses.shift() }, providerName: 'mock', provider: { model: 'mock' },
      retrievalFn: async ({ scope }) => {
        retrievalCall += 1;
        if (retrievalCall < 3) assert.deepEqual(scope, { cycleNames: [], bookIds: [] });
        if (retrievalCall === 3) assert.deepEqual(scope.cycleNames, ['Архивисты']);
        return { evidence: [first, second].map((item, index) => ({ chunk_id: item.chunkIds[0], book_id: item.bookId, cycle_name: 'Архивисты', title: index ? 'Последний архив' : 'Карта пепла', chunk_index: 0, snippet: index ? 'Ира и Тим открыли архив в эпилоге.' : 'Ира и Тим вместе расшифровали карту.', content_hash: `hash-${index ? 'Последний архив' : 'Карта пепла'}-0`, source: 'semantic' })), semantic: { status: 'searched' } };
      },
    });
    assert.equal(result.status, 'answered');
    assert.deepEqual(result.candidates.map((item) => item.bookId), [first.bookId, second.bookId]);
    assert.equal(result.cycleGroups[0].bookCount, 2);
  } finally { db.close(); }
});

test('short Cyrillic question without a question mark remains question-answer intent', async () => {
  const db = initializeSearchDatabase(':memory:');
  const book = seedBook(db, 'Цикл', 'Книга', ['Фонарь лежал у двери.']);
  const responses = [
    { intentType: 'question_answer', queries: [{ query: 'фонарь дверь' }] },
    { candidateChecks: [] },
    { status: 'answered', answer: 'Фонарь лежал у двери.', evidence: ['evidence_1'], recommendations: [], finalCandidateChecks: [] },
  ];
  try {
    const result = await runAskResearch({
      db, question: 'Где лежал фонарь', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async () => ({ evidence: [{
        chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: 'Цикл', title: 'Книга', chunk_index: 0,
        snippet: 'Фонарь лежал у двери.', content_hash: 'hash-Книга-0', source: 'fts',
      }], semantic: { status: 'searched' } }),
    });
    assert.equal(result.status, 'answered');
    assert.equal(result.answer, 'Фонарь лежал у двери.');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.research.chatCalls, 3);
  } finally { db.close(); }
});

test('wrong planner scopes cannot exclude an unhinted target from initial retrieval', async () => {
  const db = initializeSearchDatabase(':memory:');
  const decoy = seedBook(db, 'Цикл 24', 'Том 24', ['У ворот появился один демон.']);
  const target = seedBook(db, 'Цикл 11', 'Том 11', ['Герой удерживал нескольких демонов внутри себя.']);
  const retrievals = [];
  const responses = [
    {
      intentType: 'recommendation',
      queries: [
        { query: 'демоны герой', cycleNames: ['Цикл 24'] },
        { query: 'существа внутри', bookIds: [decoy.bookId] },
      ],
    },
    { candidateChecks: [{ bookId: target.bookId, verdict: 'supported', evidence: ['evidence_1'] }] },
    {
      status: 'answered', answer: 'Найдено совпадение.', evidence: ['evidence_1'],
      recommendations: [{ bookId: target.bookId, evidence: ['evidence_1'] }],
      finalCandidateChecks: [supportedFinalCheck(target.bookId, ['evidence_1'], 'несколько демонов находятся внутри героя')],
    },
  ];
  try {
    const result = await runAskResearch({
      db, question: 'Несколько демонов внутри героя', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async ({ question, scope }) => {
        retrievals.push({ question, scope });
        const book = scope.cycleNames.includes('Цикл 24') || scope.bookIds.includes(decoy.bookId) ? decoy : target;
        return { evidence: [{
          chunk_id: book.chunkIds[0], book_id: book.bookId, cycle_name: book === target ? 'Цикл 11' : 'Цикл 24',
          title: book === target ? 'Том 11' : 'Том 24', chunk_index: 0,
          snippet: book === target ? 'Герой удерживал нескольких демонов внутри себя.' : 'У ворот появился один демон.',
          content_hash: `hash-${book === target ? 'Том 11' : 'Том 24'}-0`, source: 'fts',
        }], semantic: { status: 'searched' } };
      },
    });
    assert.equal(retrievals[0].question, 'Несколько демонов внутри героя');
    assert.deepEqual(retrievals.map((item) => item.scope), [
      { cycleNames: [], bookIds: [] },
      { cycleNames: [], bookIds: [] },
      { cycleNames: [], bookIds: [] },
    ]);
    assert.deepEqual(result.candidates.map((item) => item.bookId), [target.bookId]);
    assert.deepEqual(result.cycleGroups.map((item) => item.cycle), ['Цикл 11']);
  } finally { db.close(); }
});

test('unscoped refinement can discover a candidate omitted from initial evidence', async () => {
  const db = initializeSearchDatabase(':memory:');
  const initial = seedBook(db, 'Первый цикл', 'Слабый след', ['Демонесса назвала героя.']);
  const recovered = seedBook(db, 'Второй цикл', 'Точное совпадение', ['Я призвал трёх демонов и воплотил их внутри себя.']);
  const responses = [
    { intentType: 'recommendation', queries: [{ query: 'демоны внутри героя' }] },
    { candidateChecks: [{ bookId: initial.bookId, verdict: 'uncertain', evidence: ['evidence_1'] }], additionalQueries: [{ query: 'призвал демонов воплотил внутри себя' }] },
    { status: 'answered', answer: 'Подходит «Точное совпадение».', evidence: ['evidence_2'], recommendations: [{ bookId: recovered.bookId, evidence: ['evidence_2'] }], finalCandidateChecks: [supportedFinalCheck(recovered.bookId, ['evidence_2'], 'демоны находятся внутри героя')] },
  ];
  const retrievals = [];
  try {
    const result = await runAskResearch({
      db, question: 'Демоны внутри героя', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async () => responses.shift() },
      retrievalFn: async ({ question, scope }) => {
        retrievals.push({ question, scope });
        const isRefine = question.includes('воплотил');
        const book = isRefine ? recovered : initial;
        return { evidence: [{
          chunk_id: book.chunkIds[0], book_id: book.bookId,
          cycle_name: isRefine ? 'Второй цикл' : 'Первый цикл', title: isRefine ? 'Точное совпадение' : 'Слабый след', chunk_index: 0,
          snippet: isRefine ? 'Я призвал трёх демонов и воплотил их внутри себя.' : 'Демонесса назвала героя.',
          content_hash: `hash-${isRefine ? 'Точное совпадение' : 'Слабый след'}-0`, source: 'fts',
        }], semantic: { status: 'searched' } };
      },
    });
    assert.equal(retrievals.length, 2);
    assert.deepEqual(retrievals[1].scope, { cycleNames: [], bookIds: [] });
    assert.deepEqual(result.cycleGroups.map((item) => item.cycle), ['Второй цикл']);
  } finally { db.close(); }
});
