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

async function replaceBookBody(filePath, marker) {
  const xml = await fs.readFile(filePath, 'utf8');
  await fs.writeFile(filePath, xml.replace('Незабываемый дракон охраняет библиотеку.', marker));
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

    assert.deepEqual(result, { indexed: 1, skipped: 0, errors: 0, total: 1, removed: 0 });
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

test('indexLibrary reads each changed plain FB2 file only once', async () => {
  const root = await createTempRoot();
  const filePath = await writeSampleBook(root);
  const db = initializeSearchDatabase(':memory:');
  const originalReadFile = fs.readFile;
  let reads = 0;
  fs.readFile = async (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(filePath)) reads += 1;
    return originalReadFile(...args);
  };

  try {
    await indexLibrary(db, root);
    assert.equal(reads, 1);
  } finally {
    fs.readFile = originalReadFile;
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('indexLibrary rejects oversized FB2 sources before reading their contents', async () => {
  const root = await createTempRoot();
  const folder = path.join(root, 'Oversized');
  const filePath = path.join(folder, 'book.fb2');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(filePath, 'x');
  await fs.truncate(filePath, (64 * 1024 * 1024) + 1);
  const originalReadFile = fs.readFile;
  let sourceReads = 0;
  fs.readFile = async (...args) => {
    if (path.resolve(args[0]) === path.resolve(filePath)) sourceReads += 1;
    return originalReadFile(...args);
  };
  const db = initializeSearchDatabase(':memory:');
  try {
    const result = await indexLibrary(db, root);
    assert.equal(result.errors, 1);
    assert.equal(sourceReads, 0);
  } finally {
    fs.readFile = originalReadFile;
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('searchChunks treats natural-language punctuation and FTS operators as plain terms without throwing', async () => {
  const root = await createTempRoot();
  await writeSampleBook(root);
  const db = initializeSearchDatabase(':memory:');

  try {
    await indexLibrary(db, root);

    assert.equal(searchChunks(db, 'Где есть маяк?').length, 1);
    assert.equal(searchChunks(db, '" OR * (').length, 0);
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

    assert.deepEqual(first, { indexed: 1, skipped: 0, errors: 0, total: 1, removed: 0 });
    assert.deepEqual(second, { indexed: 0, skipped: 1, errors: 0, total: 1, removed: 0 });
    assert.deepEqual(afterBook, beforeBook);
    assert.deepEqual(afterChunkIds, beforeChunkIds);
    assert.ok(searchChunks(db, 'дракон').length > 0);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('indexLibrary removes missing books and FTS rows only for the indexed root', async () => {
  const firstRoot = await createTempRoot();
  const secondRoot = await createTempRoot();
  const firstFile = await writeSampleBook(firstRoot, 'First Cycle');
  await writeSampleBook(secondRoot, 'Second Cycle');
  const db = initializeSearchDatabase(':memory:');

  try {
    await indexLibrary(db, firstRoot);
    await indexLibrary(db, secondRoot);
    await fs.unlink(firstFile);

    const result = await indexLibrary(db, firstRoot);
    const books = db.prepare('SELECT cycle_name FROM books ORDER BY cycle_name').all().map((row) => row.cycle_name);

    assert.equal(result.removed, 1);
    assert.deepEqual(books, ['Second Cycle']);
    assert.equal(searchChunks(db, 'маяк').length, 1);
  } finally {
    db.close();
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('indexLibrary invalidates graph data and stale FTS evidence when a book changes', async () => {
  const root = await createTempRoot();
  const filePath = await writeSampleBook(root);
  const db = initializeSearchDatabase(':memory:');

  try {
    await indexLibrary(db, root);
    const bookId = db.prepare('SELECT id FROM books').get().id;
    const chunkId = db.prepare('SELECT id FROM chunks WHERE book_id = ? ORDER BY id LIMIT 1').get(bookId).id;
    const entityId = Number(db.prepare("INSERT INTO entities (book_id, name, kind, normalized_name) VALUES (?, 'Алиса', 'character', 'алиса')").run(bookId).lastInsertRowid);
    const evidenceId = Number(db.prepare("INSERT INTO evidence (book_id, chunk_id, excerpt) VALUES (?, ?, 'old excerpt')").run(bookId, chunkId).lastInsertRowid);
    db.prepare("INSERT INTO relations (book_id, source_entity_id, target_entity_id, relation_type, evidence_id) VALUES (?, ?, ?, 'self', ?)").run(bookId, entityId, entityId, evidenceId);
    db.prepare("INSERT INTO events (book_id, event_type, summary, evidence_id) VALUES (?, 'old', 'old event', ?)").run(bookId, evidenceId);
    db.prepare("INSERT INTO derived_facts (book_id, fact_key, fact_value) VALUES (?, 'old', 'yes')").run(bookId);

    await replaceBookBody(filePath, 'Новый феникс охраняет архив.');
    await indexLibrary(db, root);

    for (const table of ['entities', 'evidence', 'relations', 'events', 'derived_facts']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE book_id = ?`).get(bookId).count, 0, table);
    }
    assert.equal(searchChunks(db, 'дракон').length, 0);
    assert.equal(searchChunks(db, 'феникс').length, 1);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('indexLibrary preserves the last good index for a present but temporarily unreadable book', async () => {
  const root = await createTempRoot();
  const folder = path.join(root, 'Broken Cycle');
  const filePath = path.join(folder, 'book.fb2.zip');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(filePath, 'temporarily broken zip');
  const db = initializeSearchDatabase(':memory:');

  try {
    const bookId = Number(db.prepare(`
      INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_root)
      VALUES ('Broken Cycle', ?, ?, 1, 1, 'old-hash', 'Last good title', 'Last good annotation', 'indexed', ?)
    `).run(folder, filePath, path.resolve(root)).lastInsertRowid);
    const chunkId = Number(db.prepare(`
      INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
      VALUES (?, 0, 'Последний хороший текст.', 'chunk-hash', 0, 23)
    `).run(bookId).lastInsertRowid);
    db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(chunkId, 'Последний хороший текст.');

    const result = await indexLibrary(db, root);

    assert.equal(result.errors, 1);
    assert.equal(result.removed, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM books').get().count, 1);
    assert.equal(searchChunks(db, 'хороший').length, 1);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
