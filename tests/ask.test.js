const test = require('node:test');
const assert = require('node:assert/strict');

const { answerLibraryQuestion, buildEvidencePrompt } = require('../src/ask');
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
  assert.deepEqual(result.checked.books, ['Lantern Book', 'Forest Book']);
  assert.deepEqual(result.checked.cycles, ['Dragon Cycle', 'Forest Cycle']);
  assert.equal(result.setup.provider, 'openrouter');
  assert.equal(result.setup.apiKeyEnv, 'OPENROUTER_API_KEY');
});

test('answerLibraryQuestion sends only retrieved evidence to a mocked provider and returns grounded answer shape', async () => {
  let sentMessages;
  const result = await answerLibraryQuestion({
    db: {},
    question: 'Где есть фонарь?',
    env: { OPENROUTER_API_KEY: 'test-key' },
    searchFn: () => sampleHits,
    providerClient: {
      chatCompletion: async ({ messages }) => {
        sentMessages = messages;
        return {
          answer: 'Фонарь есть в двух кандидатах, сильнее всего подходит Lantern Book.',
          confidence: 'medium',
          uncertainty: 'Проверены только найденные FTS-фрагменты.',
        };
      },
    },
  });

  const sentText = JSON.stringify(sentMessages);
  assert.match(sentText, /Героиня нашла фонарь в башне/);
  assert.match(sentText, /В лесу есть фонарь/);
  assert.doesNotMatch(sentText, /Полный текст первого релевантного фрагмента/);
  assert.doesNotMatch(sentText, /Дракон помогает героине пройти через библиотеку/);
  assert.equal(result.status, 'answered');
  assert.equal(result.answer, 'Фонарь есть в двух кандидатах, сильнее всего подходит Lantern Book.');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.uncertainty, 'Проверены только найденные FTS-фрагменты.');
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.checked.books, ['Lantern Book', 'Forest Book']);
  assert.deepEqual(result.checked.cycles, ['Dragon Cycle', 'Forest Cycle']);
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

  assert.equal(receivedQuery, '"Где" OR "есть" OR "фонарь"');
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
