const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const { listReadingStates, setCycleRead, setCycleUnfinished } = require('../src/readingState');

function withDb(run) {
  const db = initializeSearchDatabase(':memory:');
  try {
    return run(db);
  } finally {
    db.close();
  }
}

test('reading state marks a cycle as read without storing dates', () => {
  withDb((db) => {
    const marked = setCycleRead(db, { cycle: 'Dragon Cycle', read: true, now: 1000 });
    assert.equal(marked.cycleKey, 'Dragon Cycle');
    assert.equal(marked.isRead, true);

    assert.deepEqual(listReadingStates(db), [
      {
        cycleKey: 'Dragon Cycle',
        cycleName: 'Dragon Cycle',
        isRead: true,
        isUnfinished: false,
        updatedAt: 1000,
      },
    ]);
  });
});

test('reading state toggles read off and keeps one row per cycle', () => {
  withDb((db) => {
    setCycleRead(db, { cycle: 'Dragon Cycle', read: true, now: 1000 });
    const cleared = setCycleRead(db, { cycle: '  Dragon Cycle ', read: false, now: 2000 });
    assert.equal(cleared.isRead, false);

    const rows = listReadingStates(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isRead, false);
    assert.equal(rows[0].updatedAt, 2000);
  });
});

test('unfinished cycles are tracked independently from read cycles', () => {
  withDb((db) => {
    setCycleUnfinished(db, { cycle: 'Forest Cycle', unfinished: true, now: 500 });
    setCycleRead(db, { cycle: 'Dragon Cycle', read: true, now: 600 });

    const rows = listReadingStates(db);
    assert.deepEqual(rows.map((row) => [row.cycleName, row.isRead, row.isUnfinished]), [
      ['Dragon Cycle', true, false],
      ['Forest Cycle', false, true],
    ]);
  });
});

test('reading state rejects an empty cycle name and tolerates unknown cycles', () => {
  withDb((db) => {
    assert.throws(() => setCycleRead(db, { cycle: '   ', read: true }), /Cycle name/);
    assert.deepEqual(setCycleRead(db, { cycle: 'Unknown', read: false }), {
      cycleKey: 'Unknown', isRead: false, isUnfinished: false, created: true,
    });
    assert.deepEqual(setCycleUnfinished(db, { cycle: 'Unknown', unfinished: false }), {
      cycleKey: 'Unknown', isRead: false, isUnfinished: false, created: false,
    });
  });
});

test('reading state persists across reopening an existing database file', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-reading-'));
  const dbPath = path.join(dir, 'search.sqlite');
  try {
    const first = initializeSearchDatabase(dbPath);
    setCycleRead(first, { cycle: 'Dragon Cycle', read: true, now: 1 });
    setCycleUnfinished(first, { cycle: 'Dragon Cycle', unfinished: true, now: 2 });
    first.close();

    const second = initializeSearchDatabase(dbPath);
    try {
      assert.deepEqual(listReadingStates(second), [
        { cycleKey: 'Dragon Cycle', cycleName: 'Dragon Cycle', isRead: true, isUnfinished: true, updatedAt: 2 },
      ]);
    } finally {
      second.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
