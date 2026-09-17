const { favoriteKeyForCycle } = require('./favorites');

const MAX_CHECK_ERROR_LENGTH = 200;

function seriesCycleKey(cycle) {
  return favoriteKeyForCycle(cycle);
}

function parseJsonList(value, fallback = []) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toBinding(row) {
  if (!row) return null;
  return {
    cycleKey: row.cycle_key,
    cycleName: row.cycle_name,
    seriesId: row.series_id,
    seriesUrl: row.series_url,
    seriesTitle: row.series_title || null,
    workIds: parseJsonList(row.work_ids).map(Number),
    workCount: Number(row.work_count),
    isComplete: row.is_complete === null ? null : Number(row.is_complete) === 1,
    hasUpdates: Number(row.has_updates) === 1,
    updateKinds: parseJsonList(row.update_kinds),
    newWorks: parseJsonList(row.new_works).map((work) => ({
      workId: Number(work.workId),
      title: String(work.title || ''),
      url: `https://author.today/work/${Number(work.workId)}`,
    })),
    lastCheckStatus: row.last_check_status,
    lastCheckError: row.last_check_error || null,
    lastCheckedAt: row.last_checked_at === null ? null : Number(row.last_checked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function readBindingRow(db, cycleKey) {
  return db.prepare('SELECT * FROM cycle_series WHERE cycle_key = ?').get(cycleKey) || null;
}

function validWorkIds(works) {
  const ids = [];
  if (!Array.isArray(works)) return ids;
  for (const work of works) {
    const workId = Number(work?.workId);
    if (Number.isSafeInteger(workId) && workId > 0 && !ids.includes(workId)) ids.push(workId);
  }
  return ids;
}

function snapshotColumns(snapshot) {
  const workIds = validWorkIds(snapshot?.works);
  return {
    workIds,
    workIdsJson: JSON.stringify(workIds),
    workCount: workIds.length,
    isComplete: snapshot?.isComplete === true ? 1 : snapshot?.isComplete === false ? 0 : null,
  };
}

function bindCycleSeries(db, { cycle, snapshot, now = Date.now() }) {
  const trimmedCycle = String(cycle || '').trim();
  if (!trimmedCycle) throw new Error('Cycle name is required.');
  const cycleKey = seriesCycleKey(trimmedCycle);
  if (!snapshot || !Array.isArray(snapshot.works) || snapshot.works.length === 0) {
    throw new Error('Author.Today snapshot must contain at least one book.');
  }

  const columns = snapshotColumns(snapshot);
  if (columns.workCount === 0) {
    throw new Error('Author.Today snapshot must contain at least one book with a valid work id.');
  }
  const existing = readBindingRow(db, cycleKey);
  db.prepare(`
    INSERT INTO cycle_series (
      cycle_key, cycle_name, series_id, series_url, series_title, work_ids, work_count,
      is_complete, has_updates, update_kinds, new_works, last_check_status, last_check_error,
      last_checked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', '[]', 'ok', NULL, ?, ?, ?)
    ON CONFLICT(cycle_key) DO UPDATE SET
      cycle_name = excluded.cycle_name,
      series_id = excluded.series_id,
      series_url = excluded.series_url,
      series_title = excluded.series_title,
      work_ids = excluded.work_ids,
      work_count = excluded.work_count,
      is_complete = excluded.is_complete,
      has_updates = 0,
      update_kinds = '[]',
      new_works = '[]',
      last_check_status = 'ok',
      last_check_error = NULL,
      last_checked_at = excluded.last_checked_at,
      updated_at = excluded.updated_at
  `).run(
    cycleKey,
    trimmedCycle,
    Number(snapshot.seriesId),
    String(snapshot.canonicalUrl),
    snapshot.seriesTitle || null,
    columns.workIdsJson,
    columns.workCount,
    columns.isComplete,
    now,
    existing ? Number(existing.created_at) : now,
    now,
  );

  return toBinding(readBindingRow(db, cycleKey));
}

function unbindCycleSeries(db, { cycle }) {
  const cycleKey = seriesCycleKey(cycle);
  const result = db.prepare('DELETE FROM cycle_series WHERE cycle_key = ?').run(cycleKey);
  return { cycleKey, removed: Number(result.changes) > 0 };
}

function listCycleSeries(db) {
  return db.prepare('SELECT * FROM cycle_series ORDER BY cycle_name COLLATE NOCASE').all().map(toBinding);
}

function applySeriesCheck(db, { cycle, snapshot, now = Date.now() }) {
  const cycleKey = seriesCycleKey(cycle);
  const existing = readBindingRow(db, cycleKey);
  if (!existing) throw new Error('Cycle is not bound to an Author.Today series.');

  const previousIds = parseJsonList(existing.work_ids)
    .map(Number)
    .filter((workId) => Number.isSafeInteger(workId) && workId > 0);
  const columns = snapshotColumns(snapshot);
  const currentIds = columns.workIds;
  const titlesById = new Map((Array.isArray(snapshot.works) ? snapshot.works : []).map((work) => [
    Number(work?.workId),
    String(work?.title || ''),
  ]));
  // Неполная страница (пагинация, обрезанный ответ) не должна терять известные книги:
  // иначе следующая полная проверка объявит их «новыми».
  const missingIds = previousIds.filter((workId) => !currentIds.includes(workId));
  const mergedIds = [...previousIds, ...currentIds.filter((workId) => !previousIds.includes(workId))];
  const newWorks = currentIds
    .filter((workId) => !previousIds.includes(workId))
    .map((workId) => ({ workId, title: titlesById.get(workId) || '' }));

  const knownCompletion = existing.is_complete === null ? null : Number(existing.is_complete) === 1;
  const updateKinds = [];
  if (newWorks.length > 0) updateKinds.push('new_works');
  if (snapshot.isComplete === true && knownCompletion === false) updateKinds.push('now_complete');

  const nextCompletion = snapshot.isComplete === null ? existing.is_complete : columns.isComplete;
  const partialPage = missingIds.length > 0;
  const checkStatus = partialPage ? 'partial' : 'ok';
  const checkNote = partialPage
    ? `Страница отдала меньше книг (${currentIds.length} из ${previousIds.length}); сохранён прежний состав цикла.`
    : null;

  db.prepare(`
    UPDATE cycle_series SET
      series_title = ?,
      work_ids = ?,
      work_count = ?,
      is_complete = ?,
      has_updates = ?,
      update_kinds = ?,
      new_works = ?,
      last_check_status = ?,
      last_check_error = ?,
      last_checked_at = ?,
      updated_at = ?
    WHERE cycle_key = ?
  `).run(
    snapshot.seriesTitle || existing.series_title || null,
    JSON.stringify(mergedIds),
    mergedIds.length,
    nextCompletion,
    updateKinds.length > 0 ? 1 : 0,
    JSON.stringify(updateKinds),
    JSON.stringify(newWorks),
    checkStatus,
    checkNote,
    now,
    now,
    cycleKey,
  );

  return toBinding(readBindingRow(db, cycleKey));
}

function recordSeriesCheckFailure(db, { cycle, message, now = Date.now() }) {
  const cycleKey = seriesCycleKey(cycle);
  const cleanMessage = String(message || 'Не удалось проверить страницу цикла.').replaceAll(/\s+/g, ' ').trim();
  const existing = readBindingRow(db, cycleKey);
  if (!existing) throw new Error('Cycle is not bound to an Author.Today series.');

  db.prepare(`
    UPDATE cycle_series SET
      last_check_status = 'failed',
      last_check_error = ?,
      last_checked_at = ?,
      updated_at = ?
    WHERE cycle_key = ?
  `).run(cleanMessage.slice(0, MAX_CHECK_ERROR_LENGTH), now, now, cycleKey);

  return toBinding(readBindingRow(db, cycleKey));
}

module.exports = {
  MAX_CHECK_ERROR_LENGTH,
  applySeriesCheck,
  bindCycleSeries,
  listCycleSeries,
  recordSeriesCheckFailure,
  seriesCycleKey,
  unbindCycleSeries,
};
