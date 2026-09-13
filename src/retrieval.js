const { embedQueryIfConfigured, semanticSearchChunks } = require('./embeddings');
const { queryDerivedFacts } = require('./facts');
const { searchChunks } = require('./indexer');

function stripMarkup(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

const MAX_SEMANTIC_ROWS_PER_BOOK = 3;

const QUERY_STOPWORDS = new Set([
  'а', 'без', 'бы', 'в', 'во', 'вот', 'где', 'да', 'для', 'до', 'его', 'ее', 'её', 'если', 'есть', 'же',
  'за', 'и', 'из', 'или', 'как', 'кто', 'ли', 'на', 'над', 'надо', 'не', 'но', 'ну', 'о', 'об', 'от',
  'по', 'под', 'при', 'про', 'с', 'со', 'та', 'так', 'то', 'у', 'чем', 'что', 'это', 'этот', 'эта',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'where', 'what', 'who',
]);

function extractQueryTerms(question, { maxTerms = 12 } = {}) {
  const seen = new Set();
  const terms = [];
  for (const rawTerm of String(question || '').toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}_-]+/gu) || []) {
    const term = rawTerm.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (term.length < 2 || QUERY_STOPWORDS.has(term) || seen.has(term)) {
      continue;
    }
    seen.add(term);
    terms.push(term);
    if (terms.length >= maxTerms) {
      break;
    }
  }
  return terms;
}

function createFtsQueryFromQuestion(question) {
  const terms = extractQueryTerms(question);
  const quoted = terms.map((term) => `"${term.replace(/"/g, '""')}"`);

  return quoted.length > 0 ? quoted.join(' OR ') : String(question || '').trim();
}

function trimExcerpt(value, maxLength = 700) {
  const text = stripMarkup(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeChunkRow(row, source) {
  return {
    chunk_id: row.chunk_id,
    book_id: row.book_id,
    cycle_name: row.cycle_name,
    title: row.title,
    chunk_index: row.chunk_index,
    snippet: trimExcerpt(row.snippet || row.text || ''),
    text: row.snippet ? stripMarkup(row.snippet) : trimExcerpt(row.text || ''),
    source,
    sources: [source],
    score: row.score,
  };
}

function textForScoring(row) {
  return [row.cycle_name, row.title, row.snippet, row.text]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('ru-RU');
}

function scoreEvidenceRows(rows, question) {
  const terms = extractQueryTerms(question, { maxTerms: 16 });
  if (terms.length <= 1 || rows.length <= 1) {
    return rows;
  }

  const scored = rows.map((row, index) => {
    const haystack = textForScoring(row);
    const matchedTerms = terms.filter((term) => haystack.includes(term));
    return {
      row,
      index,
      matchedCount: matchedTerms.length,
      score: matchedTerms.length / terms.length,
    };
  });
  const bestMatchedCount = Math.max(...scored.map((item) => item.matchedCount));
  const minimumMatchedCount = bestMatchedCount >= 2 ? 2 : 1;

  return scored
    .filter((item) => item.matchedCount >= minimumMatchedCount)
    .sort((a, b) => b.matchedCount - a.matchedCount || b.score - a.score || a.index - b.index)
    .map((item) => item.row);
}

function factToEvidenceRow(fact) {
  const factEvidence = Array.isArray(fact.evidence) ? fact.evidence : [];
  const excerpts = factEvidence
    .map((item) => item?.excerpt || item?.snippet || '')
    .map((item) => trimExcerpt(item, 350))
    .filter(Boolean);
  const evidenceText = excerpts.length > 0 ? ` Evidence: ${excerpts.join(' | ')}` : '';
  return {
    book_id: fact.bookId,
    cycle_name: fact.cycleName,
    title: fact.bookTitle,
    chunk_index: `fact:${fact.factKey}`,
    snippet: trimExcerpt(`Derived fact ${fact.factKey} (${fact.factType}): ${fact.factValue}.${evidenceText}`),
    text: '',
    source: 'fact',
    confidence: fact.confidence,
  };
}

function addDeduped(rows, row, limit) {
  const key = Number.isSafeInteger(row.chunk_id)
    ? `chunk\u0000${row.chunk_id}`
    : `${row.source}\u0000${row.book_id}\u0000${row.chunk_index}`;
  const existing = rows.find((item) => {
    const itemKey = Number.isSafeInteger(item.chunk_id)
      ? `chunk\u0000${item.chunk_id}`
      : `${item.source}\u0000${item.book_id}\u0000${item.chunk_index}`;
    return itemKey === key;
  });
  if (existing) {
    existing.sources = [...new Set([
      ...(existing.sources || [existing.source]),
      ...(row.sources || [row.source]),
    ].filter(Boolean))];
    return;
  }
  if (rows.length >= limit) return;
  rows.push(row);
}

function uniqueCandidateBooks(rows) {
  return [...new Set(rows.map((row) => row.book_id).filter((bookId) => bookId !== undefined && bookId !== null))];
}

function countNonEmpty(groups) {
  return groups.filter((group) => group.length > 0).length;
}

function diversifyRowsByBook(rows, { limit, maxPerBook = MAX_SEMANTIC_ROWS_PER_BOOK }) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const selected = [];
  const counts = new Map();
  for (const row of rows) {
    const key = `${row.cycle_name || ''}\u0000${row.title || ''}\u0000${row.book_id ?? ''}`;
    const count = counts.get(key) || 0;
    if (count >= maxPerBook) continue;
    selected.push(row);
    counts.set(key, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function addSourceGroup(evidence, rows, laterGroups, limit) {
  const reservedForLater = countNonEmpty(laterGroups);
  const maxForGroup = Math.max(0, limit - evidence.length - reservedForLater);
  let added = 0;
  for (const row of rows) {
    if (added >= maxForGroup) {
      break;
    }
    const before = evidence.length;
    addDeduped(evidence, row, limit);
    if (evidence.length > before) {
      added += 1;
    }
  }
}

function collectFactRows(db, { factFilters = [], candidateBookIds = [], includeRelatedFacts = true, queryFactsFn = queryDerivedFacts, factsLimit = 8 }) {
  const facts = [];
  const seen = new Set();
  const addFacts = (rows) => {
    for (const fact of rows) {
      const key = `${fact.bookId}\u0000${fact.factKey}`;
      if (!seen.has(key)) {
        seen.add(key);
        facts.push(fact);
      }
      if (facts.length >= factsLimit) {
        return;
      }
    }
  };

  for (const filter of factFilters) {
    if (facts.length >= factsLimit) {
      break;
    }
    addFacts(queryFactsFn(db, filter));
  }

  if (includeRelatedFacts) {
    for (const bookId of candidateBookIds) {
      if (facts.length >= factsLimit) {
        break;
      }
      addFacts(queryFactsFn(db, { bookId }));
    }
  }

  return facts.slice(0, factsLimit).map(factToEvidenceRow);
}

async function collectSemanticRows({
  db,
  question,
  providerOverrides,
  env,
  fetchImpl,
  providerClient,
  signal,
  embedFn = embedQueryIfConfigured,
  semanticSearchFn = semanticSearchChunks,
  semanticLimit,
}) {
  const embeddingResult = await embedFn({ query: question, providerOverrides, env, fetchImpl, providerClient, signal });
  if (embeddingResult.status !== 'embedded') {
    return { status: embeddingResult.status, rows: [], setup: embeddingResult.setup };
  }

  const semanticCandidates = semanticSearchFn(db, embeddingResult.embedding, {
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    limit: semanticLimit,
    maxPerBook: MAX_SEMANTIC_ROWS_PER_BOOK,
  });
  const coverage = semanticCandidates.coverage;
  const rows = diversifyRowsByBook(semanticCandidates.map((row) => normalizeChunkRow(row, 'semantic')), {
    limit: semanticLimit,
  });

  return {
    status: 'searched',
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    queryEmbeddingDimension: embeddingResult.embedding.length,
    rows,
    coverage,
  };
}

async function collectHybridEvidence({
  db,
  question,
  providerOverrides = {},
  env = process.env,
  fetchImpl,
  providerClient,
  signal,
  searchFn = searchChunks,
  embedFn = embedQueryIfConfigured,
  semanticSearchFn = semanticSearchChunks,
  queryFactsFn = queryDerivedFacts,
  factFilters = [],
  includeRelatedFacts = true,
  limit = 12,
  ftsLimit = limit,
  semanticLimit = Math.max(0, limit - 1),
  factsLimit = 8,
} = {}) {
  const trimmedQuestion = String(question || '').trim();
  if (!trimmedQuestion) {
    throw new Error('Question is required.');
  }

  const ftsQuery = createFtsQueryFromQuestion(trimmedQuestion);
  const ftsRows = scoreEvidenceRows(
    searchFn(db, trimmedQuestion, { limit: ftsLimit }).map((row) => normalizeChunkRow(row, 'fts')),
    trimmedQuestion,
  );
  const semantic = await collectSemanticRows({
    db,
    question: trimmedQuestion,
    providerOverrides,
    env,
    fetchImpl,
    providerClient,
    signal,
    embedFn,
    semanticSearchFn,
    semanticLimit,
  });
  const factRows = collectFactRows(db, {
    factFilters,
    candidateBookIds: uniqueCandidateBooks([...ftsRows, ...semantic.rows]),
    includeRelatedFacts,
    queryFactsFn,
    factsLimit,
  });

  const evidence = [];
  addSourceGroup(evidence, ftsRows, [semantic.rows, factRows], limit);
  addSourceGroup(evidence, semantic.rows, [factRows], limit);
  addSourceGroup(evidence, factRows, [], limit);

  return {
    query: trimmedQuestion,
    ftsQuery,
    evidence,
    semantic: {
      status: semantic.status,
      provider: semantic.provider,
      model: semantic.model,
      queryEmbeddingDimension: semantic.queryEmbeddingDimension,
      setup: semantic.setup,
      coverage: semantic.coverage,
    },
  };
}

module.exports = {
  collectHybridEvidence,
  createFtsQueryFromQuestion,
  extractQueryTerms,
  scoreEvidenceRows,
};
