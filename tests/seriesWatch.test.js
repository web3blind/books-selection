const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initializeSearchDatabase } = require('../src/searchDb');
const { normalizeSeriesUrl, parseSeriesPage } = require('../src/authorToday');
const {
  applySeriesCheck,
  bindCycleSeries,
  listCycleSeries,
  recordSeriesCheckFailure,
  unbindCycleSeries,
} = require('../src/seriesWatch');

const finishedHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'author-today-series-47167.html'), 'utf8');

function syntheticPage({ title = 'Тестовый цикл', complete = false, books }) {
  const label = complete ? 'label-success' : 'label-primary';
  const icon = complete ? 'check' : 'pencil';
  const text = complete ? 'завершен' : 'не завершен';
  const rows = books.map((book, index) => `
    <div class="book-row wc-row">
      <div class="book-row-content">
        <div class="book-title">
          <span class="label label-default label-row-index">${index + 1}</span>
          <a href="/work/${book.workId}">${book.title}</a>
        </div>
      </div>
    </div>`).join('');
  return `<html><body><h1>Цикл «${title}»</h1>
    <span class="label ${label}"><i class="icon-${icon} book-status-icon"></i> ${text}</span>
    <div class="panel-body collection-work-list">${rows}</div>
  </body></html>`;
}

function snapshotFrom(html, url = 'https://author.today/work/series/999') {
  const { seriesId, canonicalUrl } = normalizeSeriesUrl(url);
  return { seriesId, canonicalUrl, ...parseSeriesPage(html) };
}

function openDatabase() {
  return initializeSearchDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-series-')), 'search.sqlite'));
}

test('bindCycleSeries stores the Author.Today snapshot for a cycle', () => {
  const db = openDatabase();
  const snapshot = snapshotFrom(finishedHtml, 'https://author.today/work/series/47167');
  const binding = bindCycleSeries(db, { cycle: 'Первый суд', snapshot, now: 1000 });

  assert.equal(binding.cycleKey, 'Первый суд');
  assert.equal(binding.seriesId, 47167);
  assert.equal(binding.seriesUrl, 'https://author.today/work/series/47167');
  assert.equal(binding.seriesTitle, 'Первый суд');
  assert.deepEqual(binding.workIds, [458421, 496928, 531220]);
  assert.equal(binding.workCount, 3);
  assert.equal(binding.isComplete, true);
  assert.equal(binding.hasUpdates, false);
  assert.deepEqual(binding.updateKinds, []);
  assert.equal(binding.lastCheckedAt, 1000);
  assert.equal(binding.lastCheckStatus, 'ok');

  assert.equal(listCycleSeries(db).length, 1);
  assert.throws(() => bindCycleSeries(db, { cycle: 'Без снимка', snapshot: { seriesId: 1, works: [] } }), /snapshot/i);
});

test('applySeriesCheck keeps a quiet cycle quiet and reports new books once', () => {
  const db = openDatabase();
  const firstPage = syntheticPage({ title: 'Барьер', books: [{ workId: 1, title: 'Книга первая' }] });
  bindCycleSeries(db, { cycle: 'Барьер', snapshot: snapshotFrom(firstPage), now: 1000 });

  const unchanged = applySeriesCheck(db, { cycle: 'Барьер', snapshot: snapshotFrom(firstPage), now: 2000 });
  assert.equal(unchanged.hasUpdates, false);
  assert.deepEqual(unchanged.updateKinds, []);
  assert.deepEqual(unchanged.newWorks, []);

  const grown = syntheticPage({
    title: 'Барьер',
    books: [{ workId: 1, title: 'Книга первая' }, { workId: 2, title: 'Книга вторая' }],
  });
  const updated = applySeriesCheck(db, { cycle: 'Барьер', snapshot: snapshotFrom(grown), now: 3000 });
  assert.equal(updated.hasUpdates, true);
  assert.deepEqual(updated.updateKinds, ['new_works']);
  assert.deepEqual(updated.newWorks, [{ workId: 2, title: 'Книга вторая', url: 'https://author.today/work/2' }]);
  assert.equal(updated.workCount, 2);
  assert.deepEqual(updated.workIds, [1, 2]);

  const afterAcknowledgement = applySeriesCheck(db, { cycle: 'Барьер', snapshot: snapshotFrom(grown), now: 4000 });
  assert.equal(afterAcknowledgement.hasUpdates, false);
  assert.deepEqual(afterAcknowledgement.newWorks, []);
});

test('applySeriesCheck reports the cycle becoming complete', () => {
  const db = openDatabase();
  const books = [{ workId: 7, title: 'Единственная' }];
  bindCycleSeries(db, {
    cycle: 'Одиночка',
    snapshot: snapshotFrom(syntheticPage({ title: 'Одиночка', complete: false, books })),
    now: 1000,
  });

  const finished = applySeriesCheck(db, {
    cycle: 'Одиночка',
    snapshot: snapshotFrom(syntheticPage({ title: 'Одиночка', complete: true, books })),
    now: 2000,
  });
  assert.equal(finished.hasUpdates, true);
  assert.deepEqual(finished.updateKinds, ['now_complete']);
  assert.equal(finished.isComplete, true);

  const stable = applySeriesCheck(db, {
    cycle: 'Одиночка',
    snapshot: snapshotFrom(syntheticPage({ title: 'Одиночка', complete: true, books })),
    now: 3000,
  });
  assert.equal(stable.hasUpdates, false);
});

test('recordSeriesCheckFailure keeps the previous snapshot and a short error', () => {
  const db = openDatabase();
  const page = syntheticPage({ title: 'Сеть', books: [{ workId: 5, title: 'Книга' }] });
  bindCycleSeries(db, { cycle: 'Сеть', snapshot: snapshotFrom(page), now: 1000 });

  const failed = recordSeriesCheckFailure(db, { cycle: 'Сеть', message: `Сбой\n${'о'.repeat(400)}`, now: 2000 });
  assert.equal(failed.lastCheckStatus, 'failed');
  assert.equal(failed.lastCheckError.length, 200);
  assert.equal(failed.lastCheckError.includes('\n'), false);
  assert.deepEqual(failed.workIds, [5]);
  assert.equal(failed.lastCheckedAt, 2000);
  assert.equal(failed.hasUpdates, false);

  const recovered = applySeriesCheck(db, { cycle: 'Сеть', snapshot: snapshotFrom(page), now: 3000 });
  assert.equal(recovered.lastCheckStatus, 'ok');
  assert.equal(recovered.lastCheckError, null);
});

test('unbindCycleSeries drops the binding and unbound checks fail', () => {
  const db = openDatabase();
  const page = syntheticPage({ title: 'Убрать', books: [{ workId: 9, title: 'Книга' }] });
  bindCycleSeries(db, { cycle: 'Убрать', snapshot: snapshotFrom(page), now: 1000 });

  assert.throws(() => applySeriesCheck(db, { cycle: 'Не привязан', snapshot: snapshotFrom(page) }), /not bound/i);
  assert.deepEqual(unbindCycleSeries(db, { cycle: 'Убрать' }), { cycleKey: 'Убрать', removed: true });
  assert.equal(listCycleSeries(db).length, 0);
  assert.equal(unbindCycleSeries(db, { cycle: 'Убрать' }).removed, false);
});

test('series bindings survive reopening the database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-series-reopen-'));
  const databasePath = path.join(dir, 'search.sqlite');
  const first = initializeSearchDatabase(databasePath);
  const page = syntheticPage({ title: 'Пережить', books: [{ workId: 11, title: 'Книга' }] });
  bindCycleSeries(first, { cycle: 'Пережить', snapshot: snapshotFrom(page), now: 1000 });
  first.close();

  const second = initializeSearchDatabase(databasePath);
  const bindings = listCycleSeries(second);
  assert.equal(bindings.length, 1);
  assert.deepEqual(bindings[0].workIds, [11]);
  assert.equal(bindings[0].lastCheckedAt, 1000);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
