const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { BOOK_STATUSES } = require('./constants');
const { assertBookSourceSize, chunkText, readBookDocument } = require('./fb2');
const { scanBooks } = require('./scan');

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function getFileFingerprint(filePath) {
  const stat = await fs.stat(filePath);
  assertBookSourceSize(filePath, stat.size);
  const buffer = await fs.readFile(filePath);

  return {
    fileSize: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    contentHash: hashBuffer(buffer),
    buffer,
    stat,
  };
}

function getExistingBook(db, filePath) {
  return db.prepare('SELECT id, file_size, mtime_ms, content_hash FROM books WHERE file_path = ?').get(filePath);
}

function isUnchanged(existing, fingerprint) {
  return Boolean(existing)
    && existing.file_size === fingerprint.fileSize
    && existing.mtime_ms === fingerprint.mtimeMs
    && existing.content_hash === fingerprint.contentHash;
}

function upsertBook(db, book) {
  const existing = db.prepare('SELECT id FROM books WHERE file_path = ?').get(book.filePath);

  if (existing) {
    db.prepare(`
      UPDATE books
      SET cycle_name = ?, folder_path = ?, file_size = ?, mtime_ms = ?, content_hash = ?,
          title = ?, annotation = ?, index_status = 'indexed', indexed_at = CURRENT_TIMESTAMP,
          indexed_root = ?
      WHERE id = ?
    `).run(
      book.cycleName,
      book.folderPath,
      book.fileSize,
      book.mtimeMs,
      book.contentHash,
      book.title,
      book.annotation,
      book.indexedRoot,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_at, indexed_root)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', CURRENT_TIMESTAMP, ?)
  `).run(
    book.cycleName,
    book.folderPath,
    book.filePath,
    book.fileSize,
    book.mtimeMs,
    book.contentHash,
    book.title,
    book.annotation,
    book.indexedRoot,
  );
  return Number(result.lastInsertRowid);
}

function deleteChunksForBook(db, bookId) {
  const chunks = db.prepare('SELECT id, text FROM chunks WHERE book_id = ?').all(bookId);
  const deleteFts = db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)");

  for (const chunk of chunks) {
    deleteFts.run(chunk.id, chunk.text);
  }

  db.prepare('DELETE FROM chunks WHERE book_id = ?').run(bookId);
}

function invalidateBookDerivedData(db, bookId) {
  db.prepare('DELETE FROM relations WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM events WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM evidence WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM entities WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM derived_facts WHERE book_id = ?').run(bookId);
}

function isPathInside(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function claimCompatibleBooksForRoot(db, indexedRoot) {
  const claim = db.prepare('UPDATE books SET indexed_root = ? WHERE id = ?');
  for (const book of db.prepare('SELECT id, file_path FROM books WHERE indexed_root IS NULL').all()) {
    if (isPathInside(indexedRoot, path.resolve(book.file_path))) {
      claim.run(indexedRoot, book.id);
    }
  }
}

function removeMissingBooks(db, indexedRoot, presentFilePaths) {
  let removed = 0;
  for (const book of db.prepare('SELECT id, file_path FROM books WHERE indexed_root = ?').all(indexedRoot)) {
    if (presentFilePaths.has(path.resolve(book.file_path))) {
      continue;
    }
    deleteChunksForBook(db, book.id);
    db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
    removed += 1;
  }
  return removed;
}

function insertChunks(db, bookId, chunks) {
  const insertChunk = db.prepare(`
    INSERT INTO chunks (book_id, chunk_index, text, content_hash, start_offset, end_offset)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)');

  for (const chunk of chunks) {
    const result = insertChunk.run(
      bookId,
      chunk.index,
      chunk.text,
      chunk.contentHash,
      chunk.startOffset,
      chunk.endOffset,
    );
    insertFts.run(Number(result.lastInsertRowid), chunk.text);
  }
}

async function indexLibrary(db, rootPath, options = {}) {
  const indexedRoot = path.resolve(rootPath);
  const scanResult = await scanBooks(indexedRoot, { readInfo: false });
  const summary = { indexed: 0, skipped: 0, errors: 0, total: scanResult.length };
  const presentFilePaths = new Set();
  const preparedBooks = [];

  for (const item of scanResult) {
    if (item.fileName) {
      presentFilePaths.add(path.resolve(indexedRoot, item.folderName, item.fileName));
    }
    if (item.status !== BOOK_STATUSES.OK) {
      summary.errors += 1;
      continue;
    }

    const folderPath = path.join(indexedRoot, item.folderName);
    const filePath = path.join(folderPath, item.fileName);
    try {
      const fingerprint = await getFileFingerprint(filePath);
      const existing = getExistingBook(db, filePath);
      if (isUnchanged(existing, fingerprint)) {
        preparedBooks.push({ unchanged: true, existing });
        continue;
      }
      const document = await readBookDocument(filePath, {
        buffer: fingerprint.buffer,
        stat: fingerprint.stat,
      });
      preparedBooks.push({ item, folderPath, filePath, fingerprint, document, existing });
    } catch {
      summary.errors += 1;
    }
  }

  db.exec('BEGIN');
  try {
    for (const prepared of preparedBooks) {
      if (prepared.unchanged) {
        db.prepare('UPDATE books SET indexed_root = ? WHERE id = ?').run(indexedRoot, prepared.existing.id);
        summary.skipped += 1;
        continue;
      }
      const { item, folderPath, filePath, fingerprint, document } = prepared;
      const bookId = upsertBook(db, {
        cycleName: item.folderName,
        folderPath,
        filePath,
        fileSize: fingerprint.fileSize,
        mtimeMs: fingerprint.mtimeMs,
        contentHash: fingerprint.contentHash,
        title: document.title,
        annotation: document.annotation,
        indexedRoot,
      });
      invalidateBookDerivedData(db, bookId);
      deleteChunksForBook(db, bookId);
      insertChunks(db, bookId, chunkText(document.bodyText, options.chunkOptions));
      summary.indexed += 1;
    }

    claimCompatibleBooksForRoot(db, indexedRoot);
    summary.removed = removeMissingBooks(db, indexedRoot, presentFilePaths);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return summary;
}

function toSafeFtsQuery(query) {
  return (String(query || '').match(/[\p{L}\p{N}_]+/gu) || [])
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function searchChunks(db, query, options = {}) {
  const ftsQuery = toSafeFtsQuery(query);
  if (!ftsQuery) return [];
  const limit = options.limit || 20;
  const bookId = options.bookId;
  const whereBook = bookId === undefined ? '' : ' AND books.id = ?';
  const params = bookId === undefined ? [ftsQuery, limit] : [ftsQuery, bookId, limit];
  const rows = db.prepare(`
    SELECT
      books.id AS book_id,
      chunks.id AS chunk_id,
      books.cycle_name,
      books.title,
      snippet(chunks_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
      chunks.text,
      chunks.chunk_index
    FROM chunks_fts
    JOIN chunks ON chunks.id = chunks_fts.rowid
    JOIN books ON books.id = chunks.book_id
    WHERE chunks_fts MATCH ?${whereBook}
    ORDER BY rank
    LIMIT ?
  `).all(...params);

  return rows;
}

module.exports = {
  indexLibrary,
  searchChunks,
};
