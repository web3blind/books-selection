const { searchChunks } = require('./indexer');
const { getApiKey, loadProviderConfig } = require('./providerConfig');
const { createOpenAiCompatibleClient } = require('./providerClient');

function stripMarkup(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeEvidence(rows) {
  return rows.map((row) => ({
    bookId: row.book_id,
    cycle: row.cycle_name,
    book: row.title,
    chunkIndex: row.chunk_index,
    excerpt: stripMarkup(row.snippet || '').trim(),
  }));
}

function createFtsQueryFromQuestion(question) {
  const terms = String(question || '')
    .match(/[\p{L}\p{N}_-]+/gu) || [];
  const quoted = terms
    .filter((term) => term.length >= 2)
    .slice(0, 12)
    .map((term) => `"${term.replace(/"/g, '""')}"`);

  return quoted.length > 0 ? quoted.join(' OR ') : String(question || '').trim();
}

function groupEvidence(evidence) {
  const groups = [];
  const byKey = new Map();

  for (const item of evidence) {
    const key = `${item.cycle}\u0000${item.book}`;
    if (!byKey.has(key)) {
      const group = { cycle: item.cycle, book: item.book, excerpts: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).excerpts.push(item);
  }

  return groups;
}

function buildEvidencePrompt(question, rows) {
  const evidence = normalizeEvidence(rows);
  const sections = groupEvidence(evidence).map((group) => {
    const excerpts = group.excerpts.map((item) => (
      `- Фрагмент ${item.chunkIndex}: ${item.excerpt}`
    )).join('\n');
    return `Цикл: ${group.cycle}\nКнига: ${group.book}\n${excerpts}`;
  }).join('\n\n');

  return [
    'Отвечай только по приведённым локально найденным фрагментам FB2-библиотеки.',
    'Не используй знания вне evidence и не делай вид, что проверена вся библиотека.',
    'Верни JSON с полями answer, confidence, uncertainty.',
    `Вопрос: ${question}`,
    'Evidence:',
    sections || 'Нет найденных фрагментов.',
  ].join('\n\n');
}

function buildMessages(question, rows) {
  return [
    {
      role: 'system',
      content: 'You answer questions about a local book library using only retrieved evidence. Return strict JSON.',
    },
    {
      role: 'user',
      content: buildEvidencePrompt(question, rows),
    },
  ];
}

function createChecked(evidence) {
  return {
    books: unique(evidence.map((item) => item.book)),
    cycles: unique(evidence.map((item) => item.cycle)),
    chunks: evidence.map((item) => ({
      book: item.book,
      cycle: item.cycle,
      chunkIndex: item.chunkIndex,
    })),
  };
}

function createFallbackResult({ providerName, provider, evidence, question }) {
  return {
    status: 'needs_provider_key',
    answer: 'AI provider is not configured; returning local evidence candidates.',
    confidence: 'unknown',
    uncertainty: 'Only local FTS evidence was retrieved; no answer model was called.',
    question,
    evidence,
    checked: createChecked(evidence),
    setup: {
      provider: providerName,
      apiKeyEnv: provider?.apiKeyEnv || '',
      message: provider?.apiKeyEnv ? `Set ${provider.apiKeyEnv} to enable AI answering.` : 'Configure an API key environment variable to enable AI answering.',
    },
  };
}

async function answerLibraryQuestion({
  db,
  question,
  providerOverrides = {},
  env = process.env,
  searchFn = searchChunks,
  providerClient,
  limit = 12,
} = {}) {
  const trimmedQuestion = String(question || '').trim();
  if (!trimmedQuestion) {
    throw new Error('Question is required.');
  }

  const retrievalQuery = createFtsQueryFromQuestion(trimmedQuestion);
  const rows = searchFn(db, retrievalQuery, { limit });
  const evidence = normalizeEvidence(rows);
  const checked = createChecked(evidence);
  const config = loadProviderConfig(providerOverrides, env);
  const providerName = config.activeProvider;
  const provider = config.providers[providerName];
  const apiKey = getApiKey(provider, env);

  if (!apiKey) {
    return createFallbackResult({ providerName, provider, evidence, question: trimmedQuestion });
  }

  const client = providerClient || createOpenAiCompatibleClient({ provider, apiKey });
  const providerAnswer = await client.chatCompletion({ messages: buildMessages(trimmedQuestion, rows) });

  return {
    status: 'answered',
    answer: providerAnswer.answer || '',
    confidence: providerAnswer.confidence || 'unknown',
    uncertainty: providerAnswer.uncertainty || '',
    question: trimmedQuestion,
    evidence,
    checked,
  };
}

module.exports = {
  answerLibraryQuestion,
  buildEvidencePrompt,
  buildMessages,
  createFtsQueryFromQuestion,
  normalizeEvidence,
};
