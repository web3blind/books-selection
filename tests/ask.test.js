const test = require('node:test');
const assert = require('node:assert/strict');

const { answerLibraryQuestion, buildEvidencePrompt, createEvidenceCandidates } = require('../src/ask');
const { createOpenAiCompatibleClient } = require('../src/providerClient');

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
        return { answer: 'Один общий ответ.', confidence: 'medium' };
      },
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Один общий ответ.');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.book), ['Lantern Book', 'Forest Book']);
  assert.deepEqual(result.candidates.map((candidate) => candidate.evidenceCount), [2, 1]);
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
  assert.equal(result.uncertainty, 'Проверены только найденные hybrid evidence.');
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.checked.books, ['Lantern Book']);
  assert.deepEqual(result.checked.cycles, ['Dragon Cycle']);
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
