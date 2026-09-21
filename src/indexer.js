const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { BOOK_STATUSES } = require('./constants');
const { assertBookSourceSize, chunkText, readBookDocument } = require('./fb2');
const { scanBooks, yieldToEventLoop } = require('./scan');

const CURRENT_CONTEXT_VERSION = 1;

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
  return db.prepare('SELECT id, file_size, mtime_ms, content_hash, context_version FROM books WHERE file_path = ?').get(filePath);
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
          indexed_root = ?, context_version = ?
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
      CURRENT_CONTEXT_VERSION,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status, indexed_at, indexed_root, context_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', CURRENT_TIMESTAMP, ?, ?)
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
    CURRENT_CONTEXT_VERSION,
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
    INSERT INTO chunks (
      book_id, chunk_index, text, content_hash, start_offset, end_offset,
      body_index, section_path, source_order, source_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      chunk.bodyIndex || 0,
      JSON.stringify(chunk.sectionPath || []),
      chunk.sourceOrder ?? chunk.index,
      chunk.sourceKind || 'legacy',
    );
    insertFts.run(Number(result.lastInsertRowid), chunk.text);
  }
}

function metadataForLegacyChunk(chunk, representedBlocks) {
  const overlapping = representedBlocks.filter((block) => (
    block.endOffset > chunk.startOffset && block.startOffset < chunk.endOffset
  ));
  const block = overlapping[0]
    || representedBlocks.find((item) => item.startOffset >= chunk.startOffset)
    || representedBlocks.at(-1);
  return {
    ...chunk,
    bodyIndex: block?.bodyIndex || 0,
    sectionPath: block?.sectionPath || [],
    sourceAnchor: block?.sourceOrder ?? chunk.index,
    fragmentOrder: chunk.index,
    sourceKind: 'body',
  };
}

function createSupplementalChunks(contextBlocks, options, startingIndex) {
  const omitted = contextBlocks.filter((block) => !block.representedInBodyText && block.text);
  const groups = [];
  for (const block of omitted) {
    const sectionKey = JSON.stringify(block.sectionPath || []);
    const previous = groups.at(-1);
    const previousBlock = previous?.blocks.at(-1);
    if (previous
      && previous.bodyIndex === block.bodyIndex
      && previous.sectionKey === sectionKey
      && previousBlock.sourceOrder + 1 === block.sourceOrder) {
      previous.blocks.push(block);
    } else {
      groups.push({
        bodyIndex: block.bodyIndex,
        bodyName: block.bodyName,
        sectionKey,
        sectionPath: block.sectionPath || [],
        blocks: [block],
      });
    }
  }

  const supplemental = [];
  for (const group of groups) {
    const text = group.blocks.map((block) => block.text).join('\n\n');
    const firstOrder = group.blocks[0].sourceOrder;
    for (const chunk of chunkText(text, options)) {
      const fragmentOrder = chunk.index;
      supplemental.push({
        ...chunk,
        index: startingIndex + supplemental.length,
        bodyIndex: group.bodyIndex,
        sectionPath: group.sectionPath,
        sourceAnchor: firstOrder,
        fragmentOrder,
        sourceKind: group.bodyName.toLowerCase() === 'notes' ? 'notes' : 'supplemental',
      });
    }
  }
  return supplemental;
}

function assignSourceOrder(chunks) {
  const ordered = [...chunks].sort((left, right) => (
    left.sourceAnchor - right.sourceAnchor
    || left.fragmentOrder - right.fragmentOrder
    || left.index - right.index
  ));
  ordered.forEach((chunk, sourceOrder) => {
    chunk.sourceOrder = sourceOrder;
  });
  return chunks;
}

function buildContextualChunks(document, chunkOptions) {
  const representedBlocks = document.contextBlocks.filter((block) => block.representedInBodyText);
  const legacy = chunkText(document.bodyText, chunkOptions)
    .map((chunk) => metadataForLegacyChunk(chunk, representedBlocks));
  const supplemental = createSupplementalChunks(document.contextBlocks, chunkOptions, legacy.length);
  return assignSourceOrder([...legacy, ...supplemental]);
}

function backfillBookContext(db, bookId, document, chunkOptions) {
  const representedBlocks = document.contextBlocks.filter((block) => block.representedInBodyText);
  const existingChunks = db.prepare(`
    SELECT id, chunk_index, text, content_hash, start_offset, end_offset
    FROM chunks WHERE book_id = ? ORDER BY chunk_index
  `).all(bookId);
  const update = db.prepare(`
    UPDATE chunks
    SET body_index = ?, section_path = ?, source_order = ?, source_kind = 'body'
    WHERE id = ?
  `);
  const legacy = existingChunks.map((row) => ({
    id: row.id,
    ...metadataForLegacyChunk({
      index: row.chunk_index,
      text: row.text,
      contentHash: row.content_hash,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
    }, representedBlocks),
  }));
  const nextIndex = existingChunks.length === 0
    ? 0
    : Math.max(...existingChunks.map((row) => row.chunk_index)) + 1;
  const supplemental = createSupplementalChunks(document.contextBlocks, chunkOptions, nextIndex);
  assignSourceOrder([...legacy, ...supplemental]);
  for (const metadata of legacy) {
    update.run(metadata.bodyIndex, JSON.stringify(metadata.sectionPath), metadata.sourceOrder, metadata.id);
  }
  insertChunks(db, bookId, supplemental);
  db.prepare('UPDATE books SET context_version = ? WHERE id = ?').run(CURRENT_CONTEXT_VERSION, bookId);
}

function updateCorpusState(db, { indexedRoot, scanResult, errors }) {
  const discoveredCycles = new Set(scanResult.filter((item) => item.fileName).map((item) => item.folderName)).size;
  const discoveredBooks = scanResult.filter((item) => item.fileName).length;
  const indexed = db.prepare(`
    SELECT COUNT(DISTINCT books.cycle_name) AS cycles,
           COUNT(DISTINCT books.id) AS books,
           COUNT(chunks.id) AS chunks
    FROM books LEFT JOIN chunks ON chunks.book_id = books.id
    WHERE books.indexed_root = ? AND books.index_status IN ('indexed', 'no_searchable_text')
  `).get(indexedRoot);
  const complete = errors === 0
    && Number(indexed.books) === discoveredBooks
    && Number(indexed.cycles) === discoveredCycles;
  db.prepare(`
    INSERT INTO corpus_state (
      id, indexed_root, discovered_cycles, discovered_books,
      indexed_cycles, indexed_books, indexed_chunks, errors, complete, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      indexed_root = excluded.indexed_root,
      discovered_cycles = excluded.discovered_cycles,
      discovered_books = excluded.discovered_books,
      indexed_cycles = excluded.indexed_cycles,
      indexed_books = excluded.indexed_books,
      indexed_chunks = excluded.indexed_chunks,
      errors = excluded.errors,
      complete = excluded.complete,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    indexedRoot, discoveredCycles, discoveredBooks,
    Number(indexed.cycles), Number(indexed.books), Number(indexed.chunks), errors, complete ? 1 : 0,
  );
}

async function indexLibrary(db, rootPath, options = {}) {
  const indexedRoot = path.resolve(rootPath);
  const scanResult = await scanBooks(indexedRoot, { readInfo: false, allFiles: true });
  const summary = { indexed: 0, skipped: 0, errors: 0, total: scanResult.filter((item) => item.fileName).length };
  const presentFilePaths = new Set();
  const preparedBooks = [];

  for (const item of scanResult) {
    if (!item.fileName) {
      continue;
    }
    presentFilePaths.add(path.resolve(indexedRoot, item.folderName, item.fileName));
    if (item.status !== BOOK_STATUSES.OK) {
      summary.errors += 1;
      continue;
    }

    const folderPath = path.join(indexedRoot, item.folderName);
    const filePath = path.join(folderPath, item.fileName);
    try {
      const fingerprint = await getFileFingerprint(filePath);
      const existing = getExistingBook(db, filePath);
      if (isUnchanged(existing, fingerprint) && existing.context_version >= CURRENT_CONTEXT_VERSION) {
        preparedBooks.push({ unchanged: true, existing });
        continue;
      }
      const document = await readBookDocument(filePath, {
        buffer: fingerprint.buffer,
        stat: fingerprint.stat,
      });
      preparedBooks.push({
        item, folderPath, filePath, fingerprint, document, existing,
        contextBackfill: isUnchanged(existing, fingerprint),
      });
    } catch {
      summary.errors += 1;
    }

    // Разбор книги — синхронная работа; отдаём событийный цикл, чтобы интерфейс и
    // другие запросы не ждали окончания индексации.
    await yieldToEventLoop();
  }

  db.exec('BEGIN');
  try {
    for (const prepared of preparedBooks) {
      if (prepared.unchanged) {
        db.prepare('UPDATE books SET indexed_root = ? WHERE id = ?').run(indexedRoot, prepared.existing.id);
        summary.skipped += 1;
        continue;
      }
      if (prepared.contextBackfill) {
        backfillBookContext(db, prepared.existing.id, prepared.document, options.chunkOptions);
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
      const chunks = buildContextualChunks(document, options.chunkOptions);
      insertChunks(db, bookId, chunks);
      if (chunks.length === 0) {
        db.prepare("UPDATE books SET index_status = 'no_searchable_text' WHERE id = ?").run(bookId);
      }
      summary.indexed += 1;
    }

    claimCompatibleBooksForRoot(db, indexedRoot);
    summary.removed = removeMissingBooks(db, indexedRoot, presentFilePaths);
    updateCorpusState(db, { indexedRoot, scanResult, errors: summary.errors });
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
      chunks.chunk_index,
      chunks.body_index,
      chunks.section_path,
      chunks.source_order,
      chunks.source_kind
    FROM chunks_fts
    JOIN chunks ON chunks.id = chunks_fts.rowid
    JOIN books ON books.id = chunks.book_id
    WHERE chunks_fts MATCH ?${whereBook}
      AND (
        NOT EXISTS (SELECT 1 FROM corpus_state WHERE id = 1)
        OR books.indexed_root = (SELECT indexed_root FROM corpus_state WHERE id = 1)
      )
    ORDER BY rank
    LIMIT ?
  `).all(...params);

  return rows;
}

/**
 * Read a bounded, target-first local context window around a retrieved chunk.
 * This performs no vector scan or network request. `sourceOrder` preserves the
 * original FB2 order, `sectionPath` contains nested headings, and `sourceKind`
 * distinguishes body, notes and omitted text.
 */
function getChunkContext(db, chunkId, options = {}) {
  const neighborCount = Number.isSafeInteger(options.neighborCount) && options.neighborCount >= 0
    ? Math.min(options.neighborCount, 10)
    : 1;
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? Math.min(options.maxChars, 50000)
    : 12000;
  const target = db.prepare(`
    SELECT chunks.*, books.title, books.cycle_name
    FROM chunks JOIN books ON books.id = chunks.book_id
    WHERE chunks.id = ?
  `).get(chunkId);
  if (!target) return null;
  const rows = db.prepare(`
    SELECT id AS chunk_id, chunk_index, text, content_hash, body_index, section_path, source_order, source_kind
    FROM chunks WHERE book_id = ?
    ORDER BY source_order, chunk_index
  `).all(target.book_id);
  const position = rows.findIndex((row) => row.chunk_id === target.id);
  const candidatePositions = [position];
  for (let distance = 1; distance <= neighborCount; distance += 1) {
    if (position - distance >= 0) candidatePositions.push(position - distance);
    if (position + distance < rows.length) candidatePositions.push(position + distance);
  }

  let remainingChars = maxChars;
  const selected = [];
  for (const rowPosition of candidatePositions) {
    if (remainingChars <= 0) break;
    const row = rows[rowPosition];
    const text = row.text.slice(0, remainingChars);
    if (!text) continue;
    let sectionPath = [];
    try { sectionPath = JSON.parse(row.section_path); } catch {}
    selected.push({
      rowPosition,
      chunkId: row.chunk_id,
      chunkIndex: row.chunk_index,
      text,
      contentHash: row.content_hash,
      bodyIndex: row.body_index,
      sectionPath: Array.isArray(sectionPath) ? sectionPath : [],
      sourceOrder: row.source_order,
      sourceKind: row.source_kind,
      isTarget: row.chunk_id === target.id,
    });
    remainingChars -= text.length;
  }
  const chunks = selected.map(({ rowPosition, ...chunk }) => chunk);
  return {
    bookId: target.book_id,
    title: target.title,
    cycleName: target.cycle_name,
    targetChunkId: target.id,
    chunks,
  };
}

module.exports = {
  getChunkContext,
  indexLibrary,
  searchChunks,
};
