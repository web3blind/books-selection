const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { initializeSearchDatabase } = require('../src/searchDb');
const { indexLibrary, searchChunks } = require('../src/indexer');

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-indexer-'));
}

async function writeSampleBook(root, cycleName = 'Cycle One') {
  const folder = path.join(root, cycleName);
  await fs.mkdir(folder, { recursive: true });
  const filePath = path.join(folder, 'book.fb2');
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>FTS Test Book</book-title>
        <annotation><p>Short annotation for browsing.</p></annotation>
      </title-info>
    </description>
    <body>
      <section>
        <title><p>Chapter One</p></title>
        <p>Незабываемый дракон охраняет библиотеку.</p>
        <p>Героиня ищет редкое слово маяк и находит друзей.</p>
      </section>
    </body>
  </FictionBook>`;
  await fs.writeFile(filePath, xml);
  return filePath;
}

test('indexLibrary stores a scanned FB2 book, writes chunks, and makes body text searchable with FTS', async () => {
  const root = await createTempRoot();
  await writeSampleBook(root);
  const db = initializeSearchDatabase(':memory:');

  try {
    const result = await indexLibrary(db, root, { chunkOptions: { maxChars: 120 } });
    const book = db.prepare('SELECT id, cycle_name, title, annotation, index_status, file_size, mtime_ms, content_hash FROM books').get();
    const chunks = db.prepare('SELECT book_id, chunk_index, text, content_hash FROM chunks ORDER BY chunk_index').all();
    const hits = searchChunks(db, 'маяк');

    assert.deepEqual(result, { indexed: 1, skipped: 0, errors: 0, total: 1 });
    assert.equal(book.cycle_name, 'Cycle One');
    assert.equal(book.title, 'FTS Test Book');
    assert.equal(book.annotation, 'Short annotation for browsing.');
    assert.equal(book.index_status, 'indexed');
    assert.ok(book.file_size > 0);
    assert.ok(book.mtime_ms > 0);
    assert.match(book.content_hash, /^[a-f0-9]{64}$/);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.some((chunk) => chunk.text.includes('маяк')));
    assert.ok(chunks.every((chunk) => chunk.book_id === book.id));
    assert.ok(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.content_hash)));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].book_id, book.id);
    assert.equal(hits[0].cycle_name, 'Cycle One');
    assert.equal(hits[0].title, 'FTS Test Book');
    assert.match(hits[0].text, /маяк/);
    assert.match(hits[0].snippet, /маяк/);
    assert.equal(typeof hits[0].chunk_index, 'number');
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('indexLibrary skips unchanged files while preserving stable book and chunk ids', async () => {
  const root = await createTempRoot();
  await writeSampleBook(root);
  const db = initializeSearchDatabase(':memory:');

  try {
    const first = await indexLibrary(db, root, { chunkOptions: { maxChars: 120 } });
    const beforeBook = db.prepare('SELECT id, content_hash, file_size, mtime_ms FROM books').get();
    const beforeChunkIds = db.prepare('SELECT id FROM chunks ORDER BY id').all().map((row) => row.id);

    const second = await indexLibrary(db, root, { chunkOptions: { maxChars: 120 } });
    const afterBook = db.prepare('SELECT id, content_hash, file_size, mtime_ms FROM books').get();
    const afterChunkIds = db.prepare('SELECT id FROM chunks ORDER BY id').all().map((row) => row.id);

    assert.deepEqual(first, { indexed: 1, skipped: 0, errors: 0, total: 1 });
    assert.deepEqual(second, { indexed: 0, skipped: 1, errors: 0, total: 1 });
    assert.deepEqual(afterBook, beforeBook);
    assert.deepEqual(afterChunkIds, beforeChunkIds);
    assert.ok(searchChunks(db, 'дракон').length > 0);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
