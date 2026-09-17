const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { cardsCachePath, loadCycleCards, listingKey } = require('../src/bookCards');

async function makeLibrary(folders) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-cards-'));
  for (const [folderName, fileName] of folders) {
    const folderPath = path.join(root, folderName);
    await fs.mkdir(folderPath, { recursive: true });
    if (fileName) {
      await fs.writeFile(path.join(folderPath, fileName), '<FictionBook><description><title-info><book-title>Книга</book-title><annotation><p>Аннотация.</p></annotation></title-info></description></FictionBook>', 'utf8');
    }
  }
  return root;
}

function countingReader(options = {}) {
  const calls = [];
  const reader = async (filePath) => {
    calls.push(filePath);
    if (options.failFor && filePath.includes(options.failFor)) throw new Error('Не удалось прочитать книгу');
    return { title: `Заголовок ${path.dirname(filePath).split(path.sep).pop()}`, annotation: 'Аннотация.' };
  };
  return { reader, calls };
}

test('card cache serves a warm start without reading any book', async () => {
  const root = await makeLibrary([['Цикл A', 'a.fb2'], ['Цикл B', 'b.fb2']]);
  const cachePath = path.join(root, 'search.sqlite.cards.json');

  const cold = countingReader();
  const first = await loadCycleCards(root, { cachePath, readInfo: cold.reader });
  assert.equal(first.books.length, 2);
  assert.equal(first.fromCache, false);
  assert.equal(first.parsed, 2);
  assert.equal(cold.calls.length, 2);

  const warm = countingReader();
  const second = await loadCycleCards(root, { cachePath, readInfo: warm.reader });
  assert.equal(second.fromCache, true);
  assert.equal(second.parsed, 0);
  assert.equal(warm.calls.length, 0, 'a warm start must not read book files');
  assert.deepEqual(second.books.map((card) => card.folderName), ['Цикл A', 'Цикл B']);
  assert.equal(second.books[0].title, 'Заголовок Цикл A');
});

test('card cache parses only the folders that changed', async () => {
  const root = await makeLibrary([['Цикл A', 'a.fb2'], ['Цикл B', 'b.fb2']]);
  const cachePath = path.join(root, 'search.sqlite.cards.json');
  await loadCycleCards(root, { cachePath, readInfo: countingReader().reader });

  const extraFolder = path.join(root, 'Цикл C');
  await fs.mkdir(extraFolder);
  await fs.writeFile(path.join(extraFolder, 'c.fb2'), '<FictionBook/>', 'utf8');

  const incremental = countingReader();
  const result = await loadCycleCards(root, { cachePath, readInfo: incremental.reader });
  assert.equal(result.parsed, 1, 'only the new cycle is parsed');
  assert.equal(result.fromCache, false);
  assert.equal(incremental.calls.length, 1);
  assert.ok(incremental.calls[0].endsWith(path.join('Цикл C', 'c.fb2')));
  assert.deepEqual(result.books.map((card) => card.folderName), ['Цикл A', 'Цикл B', 'Цикл C']);
});

test('card cache drops deleted cycles and re-reads a replaced book file', async () => {
  const root = await makeLibrary([['Цикл A', 'a.fb2'], ['Цикл B', 'b.fb2']]);
  const cachePath = path.join(root, 'search.sqlite.cards.json');
  await loadCycleCards(root, { cachePath, readInfo: countingReader().reader });

  await fs.rm(path.join(root, 'Цикл B'), { recursive: true });
  await fs.writeFile(path.join(root, 'Цикл A', 'renamed.fb2'), '<FictionBook/>', 'utf8');
  await fs.rm(path.join(root, 'Цикл A', 'a.fb2'));

  const reader = countingReader();
  const result = await loadCycleCards(root, { cachePath, readInfo: reader.reader });
  assert.deepEqual(result.books.map((card) => card.folderName), ['Цикл A']);
  assert.equal(result.parsed, 1, 'the folder with a new file name is parsed again');
  assert.ok(reader.calls[0].endsWith(path.join('Цикл A', 'renamed.fb2')));
});

test('card cache ignores a corrupt or foreign cache file', async () => {
  const root = await makeLibrary([['Цикл A', 'a.fb2']]);
  const cachePath = path.join(root, 'search.sqlite.cards.json');

  await fs.writeFile(cachePath, '{ это не json', 'utf8');
  const afterCorrupt = countingReader();
  const first = await loadCycleCards(root, { cachePath, readInfo: afterCorrupt.reader });
  assert.equal(first.parsed, 1);
  assert.equal(afterCorrupt.calls.length, 1);

  await fs.writeFile(cachePath, JSON.stringify({ version: 1, root: '/другая/папка', key: 'x', cards: {} }), 'utf8');
  const afterForeign = countingReader();
  const second = await loadCycleCards(root, { cachePath, readInfo: afterForeign.reader });
  assert.equal(second.parsed, 1, 'a cache for another root is not reused');
  assert.equal(afterForeign.calls.length, 1);
});

test('card cache retries a book that failed to parse and never stores the error', async () => {
  const root = await makeLibrary([['Цикл A', 'a.fb2']]);
  const cachePath = path.join(root, 'search.sqlite.cards.json');

  const failing = countingReader({ failFor: 'a.fb2' });
  const broken = await loadCycleCards(root, { cachePath, readInfo: failing.reader });
  assert.equal(broken.books[0].status, 'error');

  const healthy = countingReader();
  const second = await loadCycleCards(root, { cachePath, readInfo: healthy.reader });
  assert.equal(second.parsed, 1, 'the failed book is parsed again');
  assert.equal(second.books[0].status, 'ok');
});

test('card cache refresh re-reads every book and skips caching without a database', async () => {
  const root = await makeLibrary([['Цикл A', 'a.fb2'], ['Цикл B', 'b.fb2']]);
  const cachePath = path.join(root, 'search.sqlite.cards.json');
  await loadCycleCards(root, { cachePath, readInfo: countingReader().reader });

  const refreshed = countingReader();
  const result = await loadCycleCards(root, { cachePath, refresh: true, readInfo: refreshed.reader });
  assert.equal(result.parsed, 2);
  assert.equal(result.fromCache, false);
  assert.equal(refreshed.calls.length, 2);

  const noCache = countingReader();
  const withoutCache = await loadCycleCards(root, { readInfo: noCache.reader });
  assert.equal(withoutCache.fromCache, false);
  assert.equal(noCache.calls.length, 2);
  assert.equal(cardsCachePath(''), '');
  assert.equal(cardsCachePath('/data/search.sqlite'), '/data/search.sqlite.cards.json');
});

test('card cache key follows the folder and file composition', async () => {
  const first = listingKey([{ folderName: 'Цикл A', fileName: 'a.fb2' }]);
  const same = listingKey([{ folderName: 'Цикл A', fileName: 'a.fb2' }]);
  const otherFile = listingKey([{ folderName: 'Цикл A', fileName: 'b.fb2' }]);
  const emptyFolder = listingKey([{ folderName: 'Цикл A', fileName: null }]);
  assert.equal(first, same);
  assert.notEqual(first, otherFile);
  assert.notEqual(first, emptyFolder);
});
