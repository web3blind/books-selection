const test = require('node:test');
const assert = require('node:assert/strict');

const { answerLibraryQuestion, buildEvidencePrompt, createCoverage, createEvidenceCandidates, groupCandidatesByCycle } = require('../src/ask');
const { createOpenAiCompatibleClient } = require('../src/providerClient');
const { initializeSearchDatabase } = require('../src/searchDb');

const sampleHits = [
  {
    book_id: 1,
    cycle_name: 'Dragon Cycle',
    title: 'Lantern Book',
    chunk_index: 0,
    snippet: 'Героиня нашла <mark>фонарь</mark> в башне.',
    text: 'Героиня нашла фонарь в башне. Полный текст первого релевантного фрагмента.',
  },
  {
    book_id: 1,
    cycle_name: 'Dragon Cycle',
    title: 'Lantern Book',
    chunk_index: 1,
    snippet: 'Дракон помогает героине.',
    text: 'Дракон помогает героине пройти через библиотеку.',
  },
  {
    book_id: 2,
    cycle_name: 'Forest Cycle',
    title: 'Forest Book',
    chunk_index: 0,
    snippet: 'В лесу есть <mark>фонарь</mark>.',
    text: 'В лесу есть фонарь, но нет дракона.',
  },
];

test('buildEvidencePrompt groups retrieved snippets by cycle and book without full library text', () => {
  const prompt = buildEvidencePrompt('Где есть фонарь?', sampleHits);

  assert.match(prompt, /Вопрос: Где есть фонарь\?/);
  assert.match(prompt, /Цикл: Dragon Cycle/);
  assert.match(prompt, /Книга: Lantern Book/);
  assert.match(prompt, /Фрагмент 0/);
  assert.match(prompt, /Героиня нашла фонарь в башне/);
  assert.match(prompt, /недоверенные данные/i);
  assert.match(prompt, /evidence_1/);
  assert.match(prompt, /Цикл: Forest Cycle/);
  assert.doesNotMatch(prompt, /Полный текст первого релевантного фрагмента/);
  assert.doesNotMatch(prompt, /Дракон помогает героине пройти через библиотеку/);
});

test('createEvidenceCandidates groups local evidence without adding AI-generated reasons', () => {
  const evidence = [
    { cycle: 'Cycle A', book: 'Book A', source: 'fts', chunkIndex: 0, excerpt: 'Первый фрагмент.' },
    { cycle: 'Cycle A', book: 'Book A', source: 'semantic', chunkIndex: 2, excerpt: 'Второй фрагмент.' },
    { cycle: 'Cycle B', book: 'Book B', source: 'fts', chunkIndex: 0, excerpt: 'Другой кандидат.' },
  ];

  const candidates = createEvidenceCandidates(evidence, { maxExcerptsPerCandidate: 1 });

  assert.deepEqual(candidates, [
    {
      cycle: 'Cycle A',
      book: 'Book A',
      evidenceCount: 2,
      sources: ['fts', 'semantic'],
      excerpts: [{ source: 'fts', chunkIndex: 0, excerpt: 'Первый фрагмент.' }],
    },
    {
      cycle: 'Cycle B',
      book: 'Book B',
      evidenceCount: 1,
      sources: ['fts'],
      excerpts: [{ source: 'fts', chunkIndex: 0, excerpt: 'Другой кандидат.' }],
    },
  ]);
  assert.equal('reason' in candidates[0], false);
});

test('groupCandidatesByCycle collapses repeated cycles into one ordered group', () => {
  const candidates = [
    {
      cycle: 'Cycle A', book: 'Book A1', evidenceCount: 2, sources: ['semantic', 'fts'],
      excerpts: [{ source: 'semantic', chunkIndex: 0, excerpt: 'Первый фрагмент.' }],
    },
    {
      cycle: 'Cycle B', book: 'Book B1', evidenceCount: 1, sources: ['fts'],
      excerpts: [{ source: 'fts', chunkIndex: 3, excerpt: 'Другой цикл.' }],
    },
    {
      cycle: 'Cycle A', book: 'Book A2', evidenceCount: 1, sources: ['fts'],
      excerpts: [{ source: 'fts', chunkIndex: 7, excerpt: 'Вторая книга того же цикла.' }],
    },
  ];

  const groups = groupCandidatesByCycle(candidates);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.cycle), ['Cycle A', 'Cycle B']);
  assert.deepEqual(groups[0].books.map((book) => book.book), ['Book A1', 'Book A2']);
  assert.equal(groups[0].bookCount, 2);
  assert.equal(groups[0].evidenceCount, 3);
  assert.deepEqual(groups[0].sources, ['semantic', 'fts']);
  assert.deepEqual(groups[1].books.map((book) => book.book), ['Book B1']);
  assert.equal(groups[0].books[1].excerpts[0].excerpt, 'Вторая книга того же цикла.');
});

test('groupCandidatesByCycle tolerates missing, empty and malformed input', () => {
  assert.deepEqual(groupCandidatesByCycle(undefined), []);
  assert.deepEqual(groupCandidatesByCycle([]), []);
  assert.deepEqual(groupCandidatesByCycle([{ book: 'Without cycle' }]), [
    { cycle: '', books: [{ book: 'Without cycle' }], bookCount: 1, evidenceCount: 0, sources: [] },
  ]);
});

test('createCoverage distinguishes represented evidence from exhaustive corpus checks', () => {
  const db = {
    prepare(sql) {
      return {
        get() {
          if (/COUNT\(DISTINCT cycle_name\)/.test(sql)) return { count: 22 };
          if (/FROM books/.test(sql)) return { count: 22 };
          if (/FROM chunks/.test(sql)) return { count: 4400 };
          throw new Error('unexpected query');
        },
      };
    },
  };
  const coverage = createCoverage(db, [
    { cycle: 'A', book: 'Book A', chunkIndex: 1 },
    { cycle: 'B', book: 'Book B', chunkIndex: 2 },
  ]);

  assert.deepEqual(coverage, {
    totalCycles: 22,
    totalBooks: 22,
    totalChunks: 4400,
    representedCycles: 2,
    representedBooks: 2,
    retrievedChunks: 2,
    exhaustive: false,
  });
});

test('createCoverage does not count duplicate retrieval sources or derived facts as exhaustive chunks', () => {
  const db = { prepare: () => ({ get: () => ({ count: 2 }) }) };
  const coverage = createCoverage(db, [
    { cycle: 'A', book: 'A', chunkId: 7, source: 'fts' },
    { cycle: 'A', book: 'A', chunkId: 7, source: 'semantic' },
    { cycle: 'A', book: 'A', chunkId: null, source: 'fact' },
  ]);
  assert.equal(coverage.retrievedChunks, 1);
  assert.equal(coverage.exhaustive, false);
});

test('buildEvidencePrompt forbids corpus-wide negative conclusions when retrieval is partial', () => {
  const prompt = buildEvidencePrompt('Все ли герои выжили?', sampleHits, {
    totalCycles: 22,
    representedCycles: 2,
    totalBooks: 22,
    representedBooks: 2,
    retrievedChunks: 3,
    exhaustive: false,
  });
  assert.match(prompt, /2 из 22 циклов/);
  assert.match(prompt, /не делай отрицательный вывод обо всей библиотеке/i);
});

test('createEvidenceCandidates preserves retrieval relevance order instead of promoting noisy groups by count', () => {
  const evidence = [
    { cycle: 'Exact Cycle', book: 'Exact Book', source: 'fts', chunkIndex: 7, excerpt: 'Я призвал сразу трех демонов и воплотил их внутри себя.' },
    ...Array.from({ length: 10 }, (_, index) => ({
      cycle: 'Noisy Cycle',
      book: 'Noisy Book',
      source: 'semantic',
      chunkIndex: index,
      excerpt: `Семантически похожий, но менее точный фрагмент ${index}.`,
    })),
  ];

  const candidates = createEvidenceCandidates(evidence);
  assert.deepEqual(candidates.map((candidate) => candidate.book), ['Exact Book', 'Noisy Book']);
});

test('answerLibraryQuestion returns deterministic local candidates without extra provider calls', async () => {
  let providerCalls = 0;
  const result = await answerLibraryQuestion({
    db: {},
    question: 'Где есть фонарь?',
    env: { OPENROUTER_API_KEY: 'test-key' },
    retrievalFn: async () => ({ evidence: sampleHits, semantic: { status: 'searched' } }),
    providerClient: {
      chatCompletion: async () => {
        providerCalls += 1;
        return { answer: 'Один общий ответ.', confidence: 'medium', evidence: ['evidence_1'] };
      },
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Один общий ответ.');
  assert.match(result.uncertainty, /retrieved evidence|найденн/i);
  assert.equal(result.coverage.representedCycles, 2);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.book), ['Lantern Book', 'Forest Book']);
  assert.deepEqual(result.candidates.map((candidate) => candidate.evidenceCount), [2, 1]);
  assert.deepEqual(result.cycleGroups.map((group) => group.cycle), ['Dragon Cycle', 'Forest Cycle']);
  assert.deepEqual(result.cycleGroups.map((group) => group.bookCount), [1, 1]);
  assert.deepEqual(result.cycleGroups.map((group) => group.evidenceCount), [2, 1]);
});

test('answerLibraryQuestion refuses an answer until every indexed chunk was scored', async () => {
  const db = initializeSearchDatabase(':memory:');
  db.prepare(`INSERT INTO corpus_state
    (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
    VALUES (1, '/tmp/library', 1, 1, 1, 1, 3, 0, 1)`).run();
  let answerCalls = 0;
  try {
    const result = await answerLibraryQuestion({
      db, question: 'Кто выжил?', env: { OPENROUTER_API_KEY: 'test-key' },
      retrievalFn: async () => ({ evidence: sampleHits, semantic: {
        status: 'searched', coverage: { scoredCycles: 1, scoredBooks: 1, scoredChunks: 2, embeddingsComplete: false },
      } }),
      providerClient: { chatCompletion: async () => { answerCalls += 1; return {}; } },
    });
    assert.equal(result.status, 'corpus_not_ready');
    assert.equal(result.coverage.searchComplete, false);
    assert.deepEqual(result.cycleGroups, []);
    assert.equal(answerCalls, 0);
  } finally {
    db.close();
  }
});

test('answerLibraryQuestion never calls answer provider without semantic coverage', async () => {
  const db = initializeSearchDatabase(':memory:');
  db.prepare(`INSERT INTO corpus_state
    (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
    VALUES (1, '/tmp/library', 1, 1, 1, 1, 1, 0, 1)`).run();
  let calls = 0;
  try {
    const result = await answerLibraryQuestion({
      db, question: 'Кто выжил?', env: { OPENROUTER_API_KEY: 'test-key' },
      retrievalFn: async () => ({ evidence: sampleHits, semantic: { status: 'needs_embedding_provider_key' } }),
      providerClient: { chatCompletion: async () => { calls += 1; return {}; } },
    });
    assert.equal(result.status, 'corpus_not_ready');
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('answerLibraryQuestion verifies complete embedding coverage from the database', async () => {
  const db = initializeSearchDatabase(':memory:');
  const bookId = Number(db.prepare(`INSERT INTO books
    (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
    VALUES ('Cycle', '/tmp/library/Cycle', '/tmp/library/Cycle/book.fb2', 1, 1, 'book', 'Book', '', 'indexed', '/tmp/library')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO chunks
    (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, 0, 'Герои выжили.', 'chunk', 0, 13)`).run(bookId);
  db.prepare(`INSERT INTO corpus_state
    (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
    VALUES (1, '/tmp/library', 1, 1, 1, 1, 1, 0, 1)`).run();
  let calls = 0;
  try {
    const result = await answerLibraryQuestion({
      db, question: 'Кто выжил?', env: { OPENROUTER_API_KEY: 'test-key' },
      retrievalFn: async () => ({ evidence: sampleHits, semantic: {
        status: 'searched',
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small',
        queryEmbeddingDimension: 2,
        coverage: { scoredCycles: 1, scoredBooks: 1, scoredChunks: 1, embeddingsComplete: true },
      } }),
      providerClient: { chatCompletion: async () => { calls += 1; return {}; } },
    });
    assert.equal(result.status, 'corpus_not_ready');
    assert.equal(result.coverage.searchComplete, false);
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('answerLibraryQuestion reports complete local consideration separately from bounded evidence', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const bookId = Number(db.prepare(`INSERT INTO books
      (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
      VALUES ('Cycle', '/tmp/library/Cycle', '/tmp/library/Cycle/book.fb2', 1, 1, 'book', 'Book', 'Annotation', 'indexed', '/tmp/library')`).run().lastInsertRowid);
    const chunkId = Number(db.prepare(`INSERT INTO chunks
      (book_id, chunk_index, text, content_hash, start_offset, end_offset)
      VALUES (?, 0, 'Герои вместе выжили в финале.', 'chunk', 0, 29)`).run(bookId).lastInsertRowid);
    db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, 'Герои вместе выжили в финале.')").run(chunkId);
    db.prepare("INSERT INTO chunk_embeddings (chunk_id, provider, model, content_hash, embedding_json) VALUES (?, 'openrouter', 'openai/text-embedding-3-small', 'chunk', '[1,0]')").run(chunkId);
    db.prepare(`INSERT INTO corpus_state
      (id, indexed_root, discovered_cycles, discovered_books, indexed_cycles, indexed_books, indexed_chunks, errors, complete)
      VALUES (1, '/tmp/library', 1, 1, 1, 1, 1, 0, 1)`).run();
    const result = await answerLibraryQuestion({
      db, question: 'Где герои выжили вместе?', env: { OPENROUTER_API_KEY: 'test-key' },
      providerClient: {
        createEmbedding: async () => [1, 0],
        chatCompletion: async () => ({ answer: 'В Book.', confidence: 'high', evidence: ['evidence_1'] }),
      },
    });
    assert.equal(result.status, 'answered');
    assert.equal(result.coverage.searchComplete, true);
    assert.equal(result.coverage.searchedBooks, 1);
    assert.equal(result.coverage.representedBooks, 1);
  } finally {
    db.close();
  }
});

test('answerLibraryQuestion returns evidence and setup status without provider key instead of calling network', async () => {
  let providerCalled = false;
  const result = await answerLibraryQuestion({
    db: {},
    question: 'Где есть фонарь?',
    env: {},
    searchFn: () => sampleHits,
    providerClient: {
      chatCompletion: async () => {
        providerCalled = true;
        return { answer: 'should not happen' };
      },
    },
  });

  assert.equal(providerCalled, false);
  assert.equal(result.status, 'needs_provider_key');
  assert.equal(result.answer, 'AI provider is not configured; returning local evidence candidates.');
  assert.equal(result.confidence, 'unknown');
  assert.equal(result.evidence.length, 3);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.evidenceCount), [2, 1]);
  assert.deepEqual(result.checked.books, ['Lantern Book', 'Forest Book']);
  assert.deepEqual(result.checked.cycles, ['Dragon Cycle', 'Forest Cycle']);
  assert.equal(result.setup.provider, 'openrouter');
  assert.equal(result.setup.apiKeyEnv, 'OPENROUTER_API_KEY');
});

test('answerLibraryQuestion sends hybrid FTS semantic and fact evidence only to a mocked provider', async () => {
  let sentMessages;
  const hybridRows = [
    {
      book_id: 1,
      cycle_name: 'Dragon Cycle',
      title: 'Lantern Book',
      chunk_index: 0,
      source: 'fts',
      snippet: 'Героиня нашла фонарь в башне.',
      text: 'UNRELATED FULL FTS CHUNK TEXT MUST NOT BE SENT',
    },
    {
      book_id: 1,
      cycle_name: 'Dragon Cycle',
      title: 'Lantern Book',
      chunk_index: 2,
      source: 'semantic',
      snippet: 'Дракон и героиня действуют вместе.',
      text: 'UNRELATED FULL SEMANTIC CHUNK TEXT MUST NOT BE SENT',
    },
    {
      book_id: 1,
      cycle_name: 'Dragon Cycle',
      title: 'Lantern Book',
      chunk_index: 'fact:survives_finale',
      source: 'fact',
      snippet: 'Derived fact survives_finale: yes. Evidence: В эпилоге героиня жива.',
      text: 'UNRELATED FACT BACKING TEXT MUST NOT BE SENT',
    },
  ];
  const result = await answerLibraryQuestion({
    db: {},
    question: 'Где есть фонарь?',
    env: { OPENROUTER_API_KEY: 'test-key' },
    retrievalFn: async () => ({ evidence: hybridRows, semantic: { status: 'searched' } }),
    providerClient: {
      chatCompletion: async ({ messages }) => {
        sentMessages = messages;
        return {
          answer: 'Lantern Book подходит по фрагментам и факту.',
          confidence: 'medium',
          uncertainty: 'Проверены только найденные hybrid evidence.',
          evidence: ['evidence_1', 'evidence_2'],
        };
      },
    },
  });

  const sentText = JSON.stringify(sentMessages);
  assert.match(sentText, /\[fts\] Фрагмент 0: Героиня нашла фонарь в башне/);
  assert.match(sentText, /\[semantic\] Фрагмент 2: Дракон и героиня действуют вместе/);
  assert.match(sentText, /\[fact\] Фрагмент fact:survives_finale: Derived fact survives_finale: yes/);
  assert.doesNotMatch(sentText, /UNRELATED FULL FTS CHUNK TEXT/);
  assert.doesNotMatch(sentText, /UNRELATED FULL SEMANTIC CHUNK TEXT/);
  assert.doesNotMatch(sentText, /UNRELATED FACT BACKING TEXT/);
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Lantern Book подходит по фрагментам и факту.');
  assert.equal(result.confidence, 'medium');
  assert.match(result.uncertainty, /^Проверены только найденные hybrid evidence\./);
  assert.match(result.uncertainty, /не исчерпывающая проверка всей библиотеки/);
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.checked.books, ['Lantern Book']);
  assert.deepEqual(result.checked.cycles, ['Dragon Cycle']);
  assert.deepEqual(result.citedEvidence.map((item) => item.evidenceId), ['evidence_1', 'evidence_2']);
});

test('answerLibraryQuestion rejects provider citations outside retrieved evidence', async () => {
  await assert.rejects(answerLibraryQuestion({
    db: {},
    question: 'Где есть фонарь?',
    env: { OPENROUTER_API_KEY: 'test-key' },
    searchFn: () => sampleHits,
    providerClient: {
      chatCompletion: async () => ({
        answer: 'Поддельный ответ.',
        confidence: 'high',
        evidence: ['invented_evidence'],
      }),
    },
  }), /unknown evidence/i);
});

test('answerLibraryQuestion does not call a provider when retrieval found no evidence', async () => {
  let providerCalls = 0;
  const result = await answerLibraryQuestion({
    db: {},
    question: 'Несуществующий сюжет?',
    env: { OPENROUTER_API_KEY: 'test-key' },
    searchFn: () => [],
    providerClient: {
      chatCompletion: async () => {
        providerCalls += 1;
        return { answer: 'should not happen', evidence: [] };
      },
    },
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.status, 'no_evidence');
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.candidates, []);
});

test('answerLibraryQuestion converts a natural-language question into a safe FTS retrieval query', async () => {
  let receivedQuery;
  await answerLibraryQuestion({
    db: {},
    question: 'Где есть фонарь?',
    env: {},
    searchFn: (_db, query) => {
      receivedQuery = query;
      return sampleHits;
    },
  });

  assert.equal(receivedQuery, '"фонарь"');
});

test('OpenAI-compatible provider client posts chat completions through injectable fetch without leaking secrets', async () => {
  let request;
  const client = createOpenAiCompatibleClient({
    provider: {
      baseUrl: 'https://example.test/v1',
      model: 'fiction-model',
      apiKeyEnv: 'TEST_API_KEY',
    },
    apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '{"answer":"ok","confidence":"low"}' } }] };
        },
      };
    },
  });

  const result = await client.chatCompletion({ messages: [{ role: 'user', content: 'Evidence only' }] });

  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer secret-key');
  assert.equal(JSON.parse(request.options.body).model, 'fiction-model');
  assert.deepEqual(result, { answer: 'ok', confidence: 'low' });
  assert.doesNotMatch(JSON.stringify(result), /secret-key/);
});

test('every Ask outcome propagates semantic setup and degraded uncertainty', async () => {
  const semantic = { status: 'needs_embedding_provider_key', setup: { provider: 'local-embed', apiKeyEnv: 'EMBED_KEY', message: 'Configure embeddings.' } };
  const noEvidence = await answerLibraryQuestion({ db: {}, question: 'none', env: {}, retrievalFn: async () => ({ evidence: [], semantic }) });
  const fallback = await answerLibraryQuestion({ db: {}, question: 'fallback', env: {}, retrievalFn: async () => ({ evidence: sampleHits, semantic }) });
  const answered = await answerLibraryQuestion({
    db: {}, question: 'answered', env: { OPENROUTER_API_KEY: 'key' },
    retrievalFn: async () => ({ evidence: sampleHits, semantic }),
    providerClient: { chatCompletion: async () => ({ answer: 'ok', evidence: ['evidence_1'] }) },
  });
  for (const result of [noEvidence, fallback, answered]) {
    assert.deepEqual(result.semantic, semantic);
    assert.match(result.uncertainty, /semantic|семантич/i);
  }
});

test('coverage counts represented books by bookId even when titles are identical', () => {
  const db = { prepare: () => ({ get: () => ({ count: 10 }) }) };
  const coverage = createCoverage(db, [
    { bookId: 101, book: 'Same title', cycle: 'A', chunkId: 1 },
    { bookId: 102, book: 'Same title', cycle: 'B', chunkId: 2 },
  ]);
  assert.equal(coverage.representedBooks, 2);
});
