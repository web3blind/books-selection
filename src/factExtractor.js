const { buildFactExtractionPrompt, upsertDerivedFact } = require('./facts');
const { getApiKey, loadProviderConfig } = require('./providerConfig');
const { createOpenAiCompatibleClient } = require('./providerClient');

function normalizeEvidenceRows(rows = []) {
  return rows.map((row) => ({
    bookId: row.bookId ?? row.book_id,
    cycle: row.cycle ?? row.cycle_name,
    book: row.book ?? row.title,
    chunkId: row.chunkId ?? row.chunk_id,
    chunkIndex: row.chunkIndex ?? row.chunk_index,
    excerpt: String(row.excerpt ?? row.snippet ?? '').replace(/<[^>]+>/g, '').trim(),
  }));
}

function buildFactExtractionMessages({ factKey, factType, question, evidenceRows }) {
  return [
    {
      role: 'system',
      content: 'You extract one generic fact from supplied book evidence only. Return strict JSON.',
    },
    {
      role: 'user',
      content: buildFactExtractionPrompt({
        factKey,
        factType,
        question,
        chunks: normalizeEvidenceRows(evidenceRows),
      }),
    },
  ];
}

function createSetupResult({ providerName, provider, factKey, factType, question, evidence }) {
  return {
    status: 'needs_provider_key',
    factKey,
    factType,
    question,
    evidence,
    setup: {
      provider: providerName,
      apiKeyEnv: provider?.apiKeyEnv || '',
      message: provider?.apiKeyEnv
        ? `Set ${provider.apiKeyEnv} to enable fact extraction.`
        : 'Configure an API key environment variable to enable fact extraction.',
    },
  };
}

async function extractFactFromEvidence({
  db,
  bookId,
  factKey,
  factType = 'generic',
  question = '',
  evidenceRows = [],
  providerOverrides = {},
  env = process.env,
  providerClient,
} = {}) {
  if (bookId === undefined || bookId === null || bookId === '') {
    throw new Error('bookId is required.');
  }
  if (!String(factKey || '').trim()) {
    throw new Error('factKey is required.');
  }

  const normalizedEvidence = normalizeEvidenceRows(evidenceRows);
  const config = loadProviderConfig(providerOverrides, env);
  const providerName = config.activeProvider;
  const provider = config.providers[providerName];
  const apiKey = getApiKey(provider, env);

  if (!apiKey) {
    return createSetupResult({
      providerName,
      provider,
      factKey,
      factType,
      question,
      evidence: normalizedEvidence,
    });
  }

  const client = providerClient || createOpenAiCompatibleClient({ provider, apiKey });
  const providerResult = await client.chatCompletion({
    messages: buildFactExtractionMessages({ factKey, factType, question, evidenceRows: normalizedEvidence }),
  });
  const factValue = providerResult.fact_value ?? providerResult.factValue ?? providerResult.value ?? 'unknown';
  const evidence = Array.isArray(providerResult.evidence) ? providerResult.evidence : normalizedEvidence;
  const fact = upsertDerivedFact(db, {
    bookId,
    factKey,
    factType,
    factValue,
    confidence: providerResult.confidence ?? null,
    evidence,
    provider: providerName,
    model: provider?.model || null,
  });

  return {
    status: 'extracted',
    fact,
  };
}

module.exports = {
  buildFactExtractionMessages,
  extractFactFromEvidence,
  normalizeEvidenceRows,
};
