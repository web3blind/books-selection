const { favoriteKeyForCycle } = require('./favorites');

function cycleReadingKey(cycle) {
  return favoriteKeyForCycle(cycle);
}

function readRow(db, cycleKey) {
  return db.prepare('SELECT * FROM cycle_reading_state WHERE cycle_key = ?').get(cycleKey) || null;
}

function toState(row) {
  return {
    cycleKey: row.cycle_key,
    cycleName: row.cycle_name,
    isRead: Number(row.is_read) === 1,
    isUnfinished: Number(row.is_unfinished) === 1,
    updatedAt: Number(row.updated_at),
  };
}

function upsertState(db, { cycleKey, now, patch }) {
  const existing = readRow(db, cycleKey);
  const isRead = patch.isRead === undefined ? existing ? Number(existing.is_read) === 1 : false : patch.isRead;
  const isUnfinished = patch.isUnfinished === undefined
    ? existing ? Number(existing.is_unfinished) === 1 : false
    : patch.isUnfinished;

  db.prepare(`
    INSERT INTO cycle_reading_state (cycle_key, cycle_name, is_read, is_unfinished, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cycle_key) DO UPDATE SET
      is_read = excluded.is_read,
      is_unfinished = excluded.is_unfinished,
      updated_at = excluded.updated_at
  `).run(cycleKey, existing?.cycle_name || cycleKey, isRead ? 1 : 0, isUnfinished ? 1 : 0, Number(now));

  return { cycleKey, isRead, isUnfinished, created: !existing };
}

function setCycleRead(db, { cycle, read, now = Date.now() } = {}) {
  const cycleKey = cycleReadingKey(cycle);
  if (!cycleKey) throw new Error('Cycle name is required to change the reading state.');
  return upsertState(db, { cycleKey, now, patch: { isRead: read !== false } });
}

function setCycleUnfinished(db, { cycle, unfinished, now = Date.now() } = {}) {
  const cycleKey = cycleReadingKey(cycle);
  if (!cycleKey) throw new Error('Cycle name is required to change the reading state.');
  return upsertState(db, { cycleKey, now, patch: { isUnfinished: unfinished !== false } });
}

function listReadingStates(db) {
  return db.prepare('SELECT * FROM cycle_reading_state ORDER BY cycle_name ASC').all().map(toState);
}

function deleteCycleReadingState(db, { cycle } = {}) {
  const cycleKey = cycleReadingKey(cycle);
  if (!cycleKey) return { removed: false };
  const result = db.prepare('DELETE FROM cycle_reading_state WHERE cycle_key = ?').run(cycleKey);
  return { removed: Number(result.changes) > 0 };
}

module.exports = {
  cycleReadingKey,
  deleteCycleReadingState,
  listReadingStates,
  setCycleRead,
  setCycleUnfinished,
};
