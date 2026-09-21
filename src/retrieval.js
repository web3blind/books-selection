const { embedQueryIfConfigured, semanticSearchChunks } = require('./embeddings');
const { queryDerivedFacts } = require('./facts');
const { getChunkContext, searchChunks } = require('./indexer');

function stripMarkup(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function hasMeaningfulText(value) {
  return (String(value || '').match(/[\p{L}\p{N}]/gu) || []).length >= 2;
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

function normalizeChunkRow(row, source, maxExcerptChars = 700) {
  return {
    chunk_id: row.chunk_id,
    book_id: row.book_id,
    cycle_name: row.cycle_name,
    title: row.title,
    chunk_index: row.chunk_index,
    snippet: trimExcerpt(row.snippet || row.text || '', maxExcerptChars),
    text: row.snippet ? stripMarkup(row.snippet) : trimExcerpt(row.text || ''),
    content_hash: row.content_hash,
    source,
    sources: [source],
    score: row.score,
  };
}

function textForScoring(row) {
  return [row.cycle_name, row.title, row.text || row.snippet]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('ru-RU');
}

function lightRussianStem(word) {
  const normalized = String(word || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  if (!/^[а-я]+$/u.test(normalized) || normalized.length < 5) return normalized;
  const ending = [
    'иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ими', 'ыми', 'ией', 'ей', 'ий', 'ый', 'ой',
    'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ую', 'юю', 'ая', 'яя', 'ое', 'ее',
    'ы', 'и', 'а', 'я', 'у', 'ю', 'е', 'о', 'й',
  ].find((suffix) => normalized.endsWith(suffix) && normalized.length - suffix.length >= 4);
  return ending ? normalized.slice(0, -ending.length) : normalized;
}

function scoringTokens(value) {
  return (String(value || '').toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}_-]+/gu) || [])
    .map((token) => lightRussianStem(token));
}

function minimumMatchedSpan(tokens, terms) {
  if (terms.length < 2) return Number.POSITIVE_INFINITY;
  const needed = new Set(terms);
  const counts = new Map();
  let covered = 0;
  let left = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let right = 0; right < tokens.length; right += 1) {
    const token = tokens[right];
    if (!needed.has(token)) continue;
    const next = (counts.get(token) || 0) + 1;
    counts.set(token, next);
    if (next === 1) covered += 1;
    while (covered === needed.size && left <= right) {
      while (left <= right && !needed.has(tokens[left])) left += 1;
      best = Math.min(best, right - left);
      const leftToken = tokens[left];
      counts.set(leftToken, counts.get(leftToken) - 1);
      if (counts.get(leftToken) === 0) covered -= 1;
      left += 1;
    }
  }
  return best;
}

function scoreEvidenceRows(rows, question) {
  const terms = [...new Set(extractQueryTerms(question, { maxTerms: 16 }).map(lightRussianStem))];
  if (terms.length <= 1 || rows.length <= 1) {
    return rows;
  }

  const scored = rows.map((row, index) => {
    const tokens = scoringTokens(textForScoring(row));
    const matchedTerms = terms.filter((term) => tokens.includes(term));
    return {
      row,
      index,
      matchedCount: matchedTerms.length,
      score: matchedTerms.length / terms.length,
      span: minimumMatchedSpan(tokens, matchedTerms),
    };
  });
  const bestMatchedCount = Math.max(...scored.map((item) => item.matchedCount));
  const minimumMatchedCount = bestMatchedCount >= 2 ? 2 : 1;

  return scored
    .filter((item) => item.matchedCount >= minimumMatchedCount)
    .sort((a, b) => b.matchedCount - a.matchedCount || a.span - b.span || b.score - a.score || a.index - b.index)
    .map((item) => item.row);
}

function factToEvidenceRows(db, fact) {
  const rows = [];
  for (const reference of Array.isArray(fact.evidence) ? fact.evidence : []) {
    const chunkId = Number(reference?.chunkId ?? reference?.chunk_id);
    const bookId = Number(reference?.bookId ?? reference?.book_id);
    const contentHash = String(reference?.contentHash ?? reference?.content_hash ?? '');
    if (!Number.isSafeInteger(chunkId) || !Number.isSafeInteger(bookId) || !contentHash || bookId !== Number(fact.bookId)) continue;
    const chunk = db.prepare(`
      SELECT chunks.id AS chunk_id, chunks.book_id, chunks.chunk_index, chunks.text, chunks.content_hash,
             books.cycle_name, books.title
      FROM chunks JOIN books ON books.id = chunks.book_id
      WHERE chunks.id = ? AND chunks.book_id = ? AND chunks.content_hash = ?
    `).get(chunkId, bookId, contentHash);
    if (!chunk) continue;
    const fullExcerpt = stripMarkup(reference?.excerpt || reference?.snippet || '').replace(/\s+/g, ' ').trim();
    const normalizedChunkText = String(chunk.text || '').replace(/\s+/g, ' ');
    if (!fullExcerpt || !normalizedChunkText.includes(fullExcerpt)) continue;
    rows.push({
      ...normalizeChunkRow(chunk, 'fact'),
      snippet: trimExcerpt(fullExcerpt, 700),
      fact_key: fact.factKey,
      confidence: fact.confidence,
    });
  }
  return rows;
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
  const eligible = [];
  const counts = new Map();
  for (const row of rows) {
    const key = `${row.cycle_name || ''}\u0000${row.title || ''}\u0000${row.book_id ?? ''}`;
    const count = counts.get(key) || 0;
    if (count >= maxPerBook) continue;
    eligible.push(row);
    counts.set(key, count + 1);
  }
  const groups = new Map();
  for (const row of eligible) {
    const cycle = String(row.cycle_name || '');
    if (!groups.has(cycle)) groups.set(cycle, []);
    groups.get(cycle).push(row);
  }
  const selected = [];
  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;
    for (const group of groups.values()) {
      if (!group[round]) continue;
      selected.push(group[round]);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
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

  return facts.slice(0, factsLimit).flatMap((fact) => factToEvidenceRows(db, fact));
}

function normalizeScope(scope = {}) {
  return {
    cycleNames: [...new Set((Array.isArray(scope.cycleNames) ? scope.cycleNames : []).slice(0, 240)
      .map((value) => String(value || '').trim().slice(0, 240)).filter(Boolean))],
    bookIds: [...new Set((Array.isArray(scope.bookIds) ? scope.bookIds : [])
      .slice(0, 240).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))],
  };
}

function rowInScope(row, scope) {
  const normalized = normalizeScope(scope);
  if (normalized.cycleNames.length === 0 && normalized.bookIds.length === 0) return true;
  return normalized.bookIds.includes(Number(row.book_id)) || normalized.cycleNames.includes(String(row.cycle_name || ''));
}

function searchFtsInScope(db, searchFn, question, { scope, limit }) {
  const normalized = normalizeScope(scope);
  if (normalized.bookIds.length === 0 && normalized.cycleNames.length > 0 && db && typeof db.prepare === 'function') {
    const placeholders = normalized.cycleNames.map(() => '?').join(', ');
    normalized.bookIds = db.prepare(`SELECT id FROM books WHERE cycle_name IN (${placeholders}) ORDER BY id`)
      .all(...normalized.cycleNames).map((row) => Number(row.id));
  }
  if (normalized.bookIds.length === 0) {
    return searchFn(db, question, { limit }).filter((row) => rowInScope(row, normalized));
  }
  const rows = [];
  for (const bookId of normalized.bookIds) {
    rows.push(...searchFn(db, question, { limit, bookId }));
  }
  return rows.filter((row) => rowInScope(row, normalized)).slice(0, limit);
}

function expandEvidenceContext(db, rows, { neighborRadius = 1, limit = 18, maxExcerptChars = 1800 } = {}) {
  if (!db || typeof db.prepare !== 'function' || !Array.isArray(rows) || rows.length === 0) return rows || [];
  const result = [];
  const seen = new Set();
  const targetIds = new Set(rows.map((row) => Number(row.chunk_id)));
  const contexts = new Map();
  // Reserve evidence slots for search hits before adding surrounding prose.
  for (const targetsOnly of [true, false]) {
  for (const targetRow of rows.slice(0, limit)) {
    if (!Number.isSafeInteger(Number(targetRow.chunk_id))) continue;
    const context = contexts.get(targetRow.chunk_id) || getChunkContext(db, Number(targetRow.chunk_id), {
      neighborCount: Math.min(Math.max(Number(neighborRadius) || 0, 0), 10),
      maxChars: Math.min(Math.max(Number(maxExcerptChars) || 1800, 1), 50000) * ((neighborRadius * 2) + 1),
    });
    contexts.set(targetRow.chunk_id, context);
    for (const chunk of context?.chunks || []) {
      if (targetsOnly ? !chunk.isTarget : targetIds.has(chunk.chunkId)) continue;
      if (result.length >= limit || seen.has(chunk.chunkId)) continue;
      if (!hasMeaningfulText(chunk.text)) continue;
      seen.add(chunk.chunkId);
      const source = chunk.isTarget ? (targetRow.source || 'fts') : 'neighbor';
      result.push({
        chunk_id: chunk.chunkId,
        book_id: context.bookId,
        cycle_name: context.cycleName,
        title: context.title,
        chunk_index: chunk.chunkIndex,
        snippet: trimExcerpt(chunk.text, maxExcerptChars),
        text: trimExcerpt(chunk.text, maxExcerptChars),
        content_hash: chunk.contentHash,
        section_path: chunk.sectionPath,
        source_kind: chunk.sourceKind,
        source_order: chunk.sourceOrder,
        source,
        sources: chunk.isTarget ? (targetRow.sources || [source]) : ['neighbor'],
        score: chunk.isTarget ? targetRow.score : undefined,
      });
    }
  }
  }
  return result;
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
  scope,
}) {
  const embeddingResult = await embedFn({ query: question, providerOverrides, env, fetchImpl, providerClient, signal });
  if (embeddingResult.status !== 'embedded') {
    return { status: embeddingResult.status, rows: [], setup: embeddingResult.setup };
  }

  const normalizedScope = normalizeScope(scope);
  const semanticCandidateLimit = Math.min(Math.max(semanticLimit * 4, semanticLimit), 72);
  const semanticCandidates = semanticSearchFn(db, embeddingResult.embedding, {
    provider: embeddingResult.provider,
    model: embeddingResult.model,
    limit: semanticCandidateLimit,
    maxPerBook: MAX_SEMANTIC_ROWS_PER_BOOK,
    bookIds: normalizedScope.bookIds,
    cycleNames: normalizedScope.cycleNames,
  });
  const coverage = semanticCandidates.coverage;
  const rows = diversifyRowsByBook(semanticCandidates.map((row) => normalizeChunkRow(row, 'semantic')).filter((row) => rowInScope(row, scope)), {
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
  scope = {},
  includeNeighbors = false,
  neighborRadius = 1,
  maxExcerptChars = 4000,
} = {}) {
  const trimmedQuestion = String(question || '').trim();
  if (!trimmedQuestion) {
    throw new Error('Question is required.');
  }

  const ftsQuery = createFtsQueryFromQuestion(trimmedQuestion);
  const ftsRows = scoreEvidenceRows(
    searchFtsInScope(db, searchFn, trimmedQuestion, { scope, limit: ftsLimit }).map((row) => normalizeChunkRow(row, 'fts')),
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
    scope,
  });
  const factRows = collectFactRows(db, {
    factFilters,
    candidateBookIds: uniqueCandidateBooks([...ftsRows, ...semantic.rows]),
    includeRelatedFacts,
    queryFactsFn,
    factsLimit,
  });

  const evidence = [];
  if (includeNeighbors) {
    // Alternate lexical and semantic hits before expanding surrounding context.
    // Direct wording matches must not be displaced by loosely related vectors.
    const groups = [ftsRows, semantic.rows, factRows];
    for (let index = 0; index < limit; index += 1) {
      for (const group of groups) if (group[index]) addDeduped(evidence, group[index], limit);
    }
  } else {
    addSourceGroup(evidence, ftsRows, [semantic.rows, factRows], limit);
    addSourceGroup(evidence, semantic.rows, [factRows], limit);
    addSourceGroup(evidence, factRows, [], limit);
  }

  return {
    query: trimmedQuestion,
    ftsQuery,
    evidence: includeNeighbors
      ? expandEvidenceContext(db, evidence, { neighborRadius, limit, maxExcerptChars })
      : evidence,
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
  expandEvidenceContext,
  extractQueryTerms,
  scoreEvidenceRows,
};
