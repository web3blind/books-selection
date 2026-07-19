const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { BOOK_STATUSES } = require('./constants');
const { chunkText, readBookDocument } = require('./fb2');
const { scanBooks } = require('./scan');

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function getFileFingerprint(filePath) {
  const [stat, buffer] = await Promise.all([
    fs.stat(filePath),
    fs.readFile(filePath),
  ]);

  return {
    fileSize: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    contentHash: hashBuffer(buffer),
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
          title = ?, annotation = ?, index_status = 'indexed', indexed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      book.cycleName,
      book.folderPath,
      book.fileSize,
      book.mtimeMs,
      book.contentHash,
      book.title,
      book.annotation,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', CURRENT_TIMESTAMP)
  `).run(
    book.cycleName,
    book.folderPath,
    book.filePath,
    book.fileSize,
    book.mtimeMs,
    book.contentHash,
    book.title,
    book.annotation,
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
  const scanResult = await scanBooks(rootPath);
  const summary = { indexed: 0, skipped: 0, errors: 0, total: scanResult.length };

  db.exec('BEGIN');
  try {
    for (const item of scanResult) {
      if (item.status !== BOOK_STATUSES.OK) {
        summary.errors += 1;
        continue;
      }

      const folderPath = path.join(rootPath, item.folderName);
      const filePath = path.join(folderPath, item.fileName);
      const fingerprint = await getFileFingerprint(filePath);
      const existing = getExistingBook(db, filePath);

      if (isUnchanged(existing, fingerprint)) {
        summary.skipped += 1;
        continue;
      }

      const document = await readBookDocument(filePath);
      const bookId = upsertBook(db, {
        cycleName: item.folderName,
        folderPath,
        filePath,
        fileSize: fingerprint.fileSize,
        mtimeMs: fingerprint.mtimeMs,
        contentHash: fingerprint.contentHash,
        title: document.title,
        annotation: document.annotation,
      });

      deleteChunksForBook(db, bookId);
      insertChunks(db, bookId, chunkText(document.bodyText, options.chunkOptions));
      summary.indexed += 1;
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return summary;
}

function searchChunks(db, query, options = {}) {
  const limit = options.limit || 20;
  const rows = db.prepare(`
    SELECT
      books.id AS book_id,
      books.cycle_name,
      books.title,
      snippet(chunks_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
      chunks.text,
      chunks.chunk_index
    FROM chunks_fts
    JOIN chunks ON chunks.id = chunks_fts.rowid
    JOIN books ON books.id = chunks.book_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);

  return rows;
}

module.exports = {
  indexLibrary,
  searchChunks,
};
