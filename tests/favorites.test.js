const test = require('node:test');
const assert = require('node:assert/strict');

const { initializeSearchDatabase } = require('../src/searchDb');
const {
  addCycleFavorite,
  clearFavoriteHistory,
  listFavorites,
  moveFavorite,
  normalizeFavoriteQuery,
  POSITION_POINTS,
  rebuildFavoriteOrderByRating,
  recordAskCycleHits,
  removeCycleFavorite,
} = require('../src/favorites');

function withDb(run) {
  const db = initializeSearchDatabase(':memory:');
  try {
    return run(db);
  } finally {
    db.close();
  }
}

test('ratings reward the top five Ask positions and ignore everything below', () => {
  assert.deepEqual(POSITION_POINTS, [5, 4, 3, 2, 1]);

  withDb((db) => {
    const cycles = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
    for (const cycle of cycles) addCycleFavorite(db, { cycle });

    recordAskCycleHits(db, {
      query: 'ranking',
      cycleGroups: cycles.map((cycle) => ({ cycle })),
    });

    const ratings = new Map(listFavorites(db).map((favorite) => [favorite.cycleName, favorite.rating]));
    assert.equal(ratings.get('First'), 5);
    assert.equal(ratings.get('Second'), 4);
    assert.equal(ratings.get('Third'), 3);
    assert.equal(ratings.get('Fourth'), 2);
    assert.equal(ratings.get('Fifth'), 1);
    assert.equal(ratings.get('Sixth'), 0);
  });
});

test('normalizeFavoriteQuery collapses whitespace and case', () => {
  assert.equal(normalizeFavoriteQuery('  Где   Фонарь? '), 'где фонарь?');
  assert.equal(normalizeFavoriteQuery('A\tB\nC'), 'a b c');
  assert.equal(normalizeFavoriteQuery(undefined), '');
  assert.equal(normalizeFavoriteQuery('   '), '');
});

test('favorites round trip keeps one entry per cycle and a stable append order', () => {
  withDb((db) => {
    const first = addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1000 });
    assert.equal(first.created, true);
    assert.equal(first.sortPosition, 1);

    const again = addCycleFavorite(db, { cycle: '  Dragon Cycle  ', now: 2000 });
    assert.equal(again.created, false);
    assert.equal(again.cycleKey, 'Dragon Cycle');

    const second = addCycleFavorite(db, { cycle: 'Forest Cycle', now: 3000 });
    assert.equal(second.sortPosition, 2);

    assert.deepEqual(listFavorites(db).map((favorite) => favorite.cycleName), ['Dragon Cycle', 'Forest Cycle']);
    assert.equal(listFavorites(db)[0].addedAt, 1000);

    const removed = removeCycleFavorite(db, { cycle: 'Dragon Cycle' });
    assert.equal(removed.removed, true);
    assert.deepEqual(listFavorites(db).map((favorite) => favorite.cycleName), ['Forest Cycle']);
    assert.equal(removeCycleFavorite(db, { cycle: 'Dragon Cycle' }).removed, false);
  });
});

test('recordAskCycleHits scores only favorited cycles inside the top five', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1 });
    addCycleFavorite(db, { cycle: 'Forest Cycle', now: 2 });

    const cycleGroups = [
      { cycle: 'Dragon Cycle', bookCount: 2, evidenceCount: 3 },
      { cycle: 'Not Favorited', bookCount: 1, evidenceCount: 1 },
      { cycle: 'Forest Cycle', bookCount: 1, evidenceCount: 1 },
      { cycle: 'Sixth Cycle', bookCount: 1, evidenceCount: 1 },
      { cycle: 'Seventh Cycle', bookCount: 1, evidenceCount: 1 },
      { cycle: 'Eighth Cycle', bookCount: 1, evidenceCount: 1 },
    ];

    const result = recordAskCycleHits(db, { cycleGroups, query: 'Где фонарь?', now: 10 });
    assert.equal(result.recorded, 2);

    const favorites = listFavorites(db);
    const dragon = favorites.find((favorite) => favorite.cycleName === 'Dragon Cycle');
    const forest = favorites.find((favorite) => favorite.cycleName === 'Forest Cycle');
    assert.equal(dragon.rating, 5);
    assert.equal(dragon.leaderCount, 1);
    assert.equal(dragon.queryCount, 1);
    assert.equal(forest.rating, 3);
    assert.equal(forest.leaderCount, 0);
    assert.deepEqual(dragon.hits, [
      { query: 'Где фонарь?', bestPosition: 1, timesSeen: 1, lastSeenAt: 10 },
    ]);
  });
});

test('recordAskCycleHits deduplicates a repeated query and keeps the best position', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1 });

    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'фонарь', now: 10 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Other' }, { cycle: 'Dragon Cycle' }], query: '  Фонарь ', now: 20 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'фонарь', now: 30 });

    const favorite = listFavorites(db)[0];
    assert.equal(favorite.rating, 5, 'repeating one query must not keep adding points');
    assert.equal(favorite.queryCount, 1);
    assert.equal(favorite.hits[0].bestPosition, 1);
    assert.equal(favorite.hits[0].timesSeen, 3);
    assert.equal(favorite.hits[0].lastSeenAt, 30);
  });
});

test('favorite history treats canonically equivalent queries as the same query', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1 });

    // «й» в разных нормализациях Unicode: один и тот же запрос для читателя.
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'й'.normalize('NFC'), now: 10 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'й'.normalize('NFD'), now: 20 });

    const favorite = listFavorites(db)[0];
    assert.equal(favorite.queryCount, 1, 'a decomposed query must not create a second history row');
    assert.equal(favorite.rating, 5, 'the same query must not be scored twice');
    assert.equal(favorite.hits[0].timesSeen, 2);
  });
});

test('recordAskCycleHits ignores empty queries, empty groups, and missing cycles', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1 });
    assert.deepEqual(recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: '   ' }), { recorded: 0 });
    assert.deepEqual(recordAskCycleHits(db, { cycleGroups: [], query: 'фонарь' }), { recorded: 0 });
    assert.deepEqual(recordAskCycleHits(db, { cycleGroups: [{ cycle: '' }], query: 'фонарь' }), { recorded: 0 });
    assert.equal(listFavorites(db)[0].rating, 0);
  });
});

test('recordAskCycleHits does nothing when no cycle is favorited', () => {
  withDb((db) => {
    assert.deepEqual(recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'фонарь' }), { recorded: 0 });
    assert.deepEqual(listFavorites(db), []);
  });
});

test('removing a favorite stops scoring but keeps its query history', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'фонарь', now: 10 });
    removeCycleFavorite(db, { cycle: 'Dragon Cycle' });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'дракон', now: 20 });

    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 30 });
    const favorite = listFavorites(db)[0];
    assert.equal(favorite.rating, 5, 'history must survive an unfavorite and re-favorite');
    assert.equal(favorite.queryCount, 1);
    assert.equal(favorite.hits[0].query, 'фонарь');
  });
});

test('moveFavorite shifts a cycle by exactly one step', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'A', now: 1 });
    addCycleFavorite(db, { cycle: 'B', now: 2 });
    addCycleFavorite(db, { cycle: 'C', now: 3 });

    assert.equal(moveFavorite(db, { cycle: 'C', direction: 'up' }).moved, true);
    assert.deepEqual(listFavorites(db).map((favorite) => favorite.cycleName), ['A', 'C', 'B']);

    assert.equal(moveFavorite(db, { cycle: 'C', direction: 'down' }).moved, true);
    assert.deepEqual(listFavorites(db).map((favorite) => favorite.cycleName), ['A', 'B', 'C']);

    assert.equal(moveFavorite(db, { cycle: 'A', direction: 'up' }).moved, false);
    assert.equal(moveFavorite(db, { cycle: 'C', direction: 'down' }).moved, false);
    assert.equal(moveFavorite(db, { cycle: 'Missing', direction: 'up' }).moved, false);
    assert.equal(moveFavorite(db, { cycle: 'A', direction: 'sideways' }).moved, false);
    assert.deepEqual(listFavorites(db).map((favorite) => favorite.sortPosition), [1, 2, 3]);
  });
});

test('rebuildFavoriteOrderByRating sorts by rating, then leaders, then name', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'Low', now: 1 });
    addCycleFavorite(db, { cycle: 'Top', now: 2 });
    addCycleFavorite(db, { cycle: 'Tie', now: 3 });
    addCycleFavorite(db, { cycle: 'Middle', now: 4 });

    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Top' }], query: 'one', now: 10 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Tie' }, { cycle: 'Middle' }], query: 'two', now: 11 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Middle' }, { cycle: 'Tie' }], query: 'three', now: 12 });

    rebuildFavoriteOrderByRating(db);

    // Middle and Tie: 9 points each with one lead each, so the name breaks the tie.
    // Top: 5 points from a single lead. Low: no hits.
    assert.deepEqual(
      listFavorites(db).map((favorite) => favorite.cycleName),
      ['Middle', 'Tie', 'Top', 'Low'],
    );
    assert.deepEqual(listFavorites(db).map((favorite) => favorite.sortPosition), [1, 2, 3, 4]);
  });
});

test('clearFavoriteHistory removes hits for one cycle or for everything', () => {
  withDb((db) => {
    addCycleFavorite(db, { cycle: 'A', now: 1 });
    addCycleFavorite(db, { cycle: 'B', now: 2 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'A' }, { cycle: 'B' }], query: 'one', now: 10 });

    assert.equal(clearFavoriteHistory(db, { cycle: 'A' }).cleared, 1);
    assert.equal(listFavorites(db)[0].rating, 0);
    assert.equal(listFavorites(db)[1].rating, 4);

    assert.equal(clearFavoriteHistory(db).cleared, 1);
    assert.deepEqual(listFavorites(db).map((favorite) => favorite.rating), [0, 0]);
  });
});

test('favorites survive repeated schema initialization', () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    addCycleFavorite(db, { cycle: 'Dragon Cycle', now: 1 });
    recordAskCycleHits(db, { cycleGroups: [{ cycle: 'Dragon Cycle' }], query: 'фонарь', now: 2 });
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    assert.ok(tableNames.includes('cycle_favorites'));
    assert.ok(tableNames.includes('cycle_query_hits'));
    assert.equal(listFavorites(db)[0].rating, 5);
  } finally {
    db.close();
  }
});
