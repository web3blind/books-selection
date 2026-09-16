const MAX_RANKED_POSITION = 5;
// Points for Ask positions 1..5. Single source of truth for both the stored SQL rating and tests.
const POSITION_POINTS = [5, 4, 3, 2, 1];

function ratingCaseSql() {
  return POSITION_POINTS
    .map((points, index) => `WHEN ${index + 1} THEN ${points}`)
    .join(' ');
}

function normalizeFavoriteQuery(query) {
  return String(query ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function favoriteKeyForCycle(cycle) {
  return String(cycle ?? '').trim();
}

function readFavoriteRows(db) {
  return db.prepare(`
    SELECT f.cycle_key, f.cycle_name, f.added_at, f.sort_position,
      COALESCE(SUM(CASE h.best_position ${ratingCaseSql()} ELSE 0 END), 0) AS rating,
      COALESCE(SUM(CASE WHEN h.best_position = 1 THEN 1 ELSE 0 END), 0) AS leader_count,
      COUNT(h.query_normalized) AS query_count
    FROM cycle_favorites f
    LEFT JOIN cycle_query_hits h ON h.cycle_key = f.cycle_key
    GROUP BY f.cycle_key, f.cycle_name, f.added_at, f.sort_position
    ORDER BY f.sort_position ASC, f.cycle_name ASC
  `).all();
}

function readHitRows(db, cycleKey) {
  return db.prepare(`
    SELECT query_display, best_position, times_seen, last_seen_at
    FROM cycle_query_hits
    WHERE cycle_key = ?
    ORDER BY best_position ASC, last_seen_at DESC, query_display ASC
  `).all(cycleKey);
}

function listFavorites(db) {
  return readFavoriteRows(db).map((row) => ({
    cycleKey: row.cycle_key,
    cycleName: row.cycle_name,
    addedAt: Number(row.added_at),
    sortPosition: Number(row.sort_position),
    rating: Number(row.rating),
    leaderCount: Number(row.leader_count),
    queryCount: Number(row.query_count),
    hits: readHitRows(db, row.cycle_key).map((hit) => ({
      query: hit.query_display,
      bestPosition: Number(hit.best_position),
      timesSeen: Number(hit.times_seen),
      lastSeenAt: Number(hit.last_seen_at),
    })),
  }));
}

function addCycleFavorite(db, { cycle, now = Date.now() } = {}) {
  const cycleKey = favoriteKeyForCycle(cycle);
  if (!cycleKey) throw new Error('Cycle name is required to add a favorite.');
  const existing = db.prepare('SELECT cycle_key, sort_position FROM cycle_favorites WHERE cycle_key = ?').get(cycleKey);
  if (existing) {
    return { cycleKey, created: false, sortPosition: Number(existing.sort_position) };
  }
  const nextPosition = Number(db.prepare('SELECT COALESCE(MAX(sort_position), 0) AS maximum FROM cycle_favorites').get().maximum) + 1;
  db.prepare('INSERT INTO cycle_favorites (cycle_key, cycle_name, added_at, sort_position) VALUES (?, ?, ?, ?)')
    .run(cycleKey, cycleKey, Number(now), nextPosition);
  return { cycleKey, created: true, sortPosition: nextPosition };
}

function removeCycleFavorite(db, { cycle } = {}) {
  const cycleKey = favoriteKeyForCycle(cycle);
  if (!cycleKey) return { removed: false };
  const result = db.prepare('DELETE FROM cycle_favorites WHERE cycle_key = ?').run(cycleKey);
  return { removed: Number(result.changes) > 0 };
}

// Query history is intentionally kept when a cycle stops being a favorite, so that
// re-favoriting restores the previous rating instead of silently losing it.
function recordAskCycleHits(db, { cycleGroups, query, now = Date.now() } = {}) {
  const queryNormalized = normalizeFavoriteQuery(query);
  if (!queryNormalized) return { recorded: 0 };
  const groups = Array.isArray(cycleGroups) ? cycleGroups : [];
  if (groups.length === 0) return { recorded: 0 };
  const favoriteKeys = new Set(db.prepare('SELECT cycle_key FROM cycle_favorites').all().map((row) => row.cycle_key));
  if (favoriteKeys.size === 0) return { recorded: 0 };

  const queryDisplay = String(query ?? '').trim().replace(/\s+/g, ' ');
  const upsert = db.prepare(`
    INSERT INTO cycle_query_hits
      (cycle_key, query_normalized, query_display, best_position, times_seen, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(cycle_key, query_normalized) DO UPDATE SET
      best_position = MIN(cycle_query_hits.best_position, excluded.best_position),
      times_seen = cycle_query_hits.times_seen + 1,
      last_seen_at = excluded.last_seen_at,
      query_display = excluded.query_display
  `);

  let recorded = 0;
  groups.forEach((group, index) => {
    const position = index + 1;
    if (position > MAX_RANKED_POSITION) return;
    const cycleKey = favoriteKeyForCycle(group?.cycle);
    if (!cycleKey || !favoriteKeys.has(cycleKey)) return;
    upsert.run(cycleKey, queryNormalized, queryDisplay, position, Number(now), Number(now));
    recorded += 1;
  });

  return { recorded };
}

function writeOrder(db, cycleKeys) {
  const update = db.prepare('UPDATE cycle_favorites SET sort_position = ? WHERE cycle_key = ?');
  cycleKeys.forEach((cycleKey, index) => update.run(index + 1, cycleKey));
}

function moveFavorite(db, { cycle, direction } = {}) {
  const cycleKey = favoriteKeyForCycle(cycle);
  if (!cycleKey || !['up', 'down'].includes(direction)) return { moved: false };
  const ordered = db.prepare('SELECT cycle_key FROM cycle_favorites ORDER BY sort_position ASC, cycle_name ASC').all()
    .map((row) => row.cycle_key);
  const index = ordered.indexOf(cycleKey);
  if (index === -1) return { moved: false };
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= ordered.length) return { moved: false };
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  writeOrder(db, ordered);
  return { moved: true, sortPosition: targetIndex + 1 };
}

function rebuildFavoriteOrderByRating(db) {
  const ordered = readFavoriteRows(db)
    .sort((left, right) => (
      Number(right.rating) - Number(left.rating)
      || Number(right.leader_count) - Number(left.leader_count)
      || String(left.cycle_name).localeCompare(String(right.cycle_name))
    ))
    .map((row) => row.cycle_key);
  writeOrder(db, ordered);
  return { reordered: ordered.length };
}

function clearFavoriteHistory(db, { cycle } = {}) {
  if (cycle === undefined || cycle === null) {
    const result = db.prepare('DELETE FROM cycle_query_hits').run();
    return { cleared: Number(result.changes) };
  }
  const cycleKey = favoriteKeyForCycle(cycle);
  if (!cycleKey) return { cleared: 0 };
  const result = db.prepare('DELETE FROM cycle_query_hits WHERE cycle_key = ?').run(cycleKey);
  return { cleared: Number(result.changes) };
}

module.exports = {
  MAX_RANKED_POSITION,
  addCycleFavorite,
  clearFavoriteHistory,
  favoriteKeyForCycle,
  listFavorites,
  moveFavorite,
  normalizeFavoriteQuery,
  POSITION_POINTS,
  rebuildFavoriteOrderByRating,
  recordAskCycleHits,
  removeCycleFavorite,
};
