const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createSchemaSql } = require('./searchSchema');

const dynamicRequire = createRequire(__filename);
const APPLICATION_ID = 0x42534b53; // "BSKS"
const SCHEMA_VERSION = 6;
const BUSY_TIMEOUT_MS = 5000;
const KNOWN_TABLES = new Set([
  'books', 'chunks', 'chunk_embeddings', 'entities', 'relations', 'events', 'evidence', 'derived_facts', 'corpus_state',
  'cycle_favorites', 'cycle_query_hits', 'cycle_reading_state', 'cycle_series',
  'chunks_fts', 'chunks_fts_data', 'chunks_fts_idx', 'chunks_fts_docsize', 'chunks_fts_config',
]);

function loadNodeSqlite() {
  try {
    return dynamicRequire('node:sqlite');
  } catch {
    return null;
  }
}

function hasNodeSqliteSupport() {
  return Boolean(loadNodeSqlite()?.DatabaseSync);
}

function hasRequiredColumnDefinitions(db, tableName, requiredColumns) {
  const columns = new Map(db.prepare(`PRAGMA table_info("${tableName}")`).all().map((row) => [row.name, row]));
  return Object.entries(requiredColumns).every(([name, expected]) => {
    const actual = columns.get(name);
    return actual
      && String(actual.type).toUpperCase() === expected.type
      && Number(actual.notnull) === expected.notnull
      && Number(actual.pk) === expected.pk;
  });
}

function hasUniqueIndex(db, tableName, expectedColumns) {
  return db.prepare(`PRAGMA index_list("${tableName}")`).all().some((index) => {
    if (!index.unique) return false;
    const columns = db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    return columns.length === expectedColumns.length
      && columns.every((column, position) => column === expectedColumns[position]);
  });
}

function hasExpectedChunkForeignKey(db) {
  return db.prepare('PRAGMA foreign_key_list("chunks")').all().some((row) => (
    row.table === 'books' && row.from === 'book_id' && row.to === 'id' && String(row.on_delete).toUpperCase() === 'CASCADE'
  ));
}

function hasNoUnexpectedActiveObjects(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('trigger', 'view') AND name NOT LIKE 'sqlite_%'").get().count === 0;
}

function isRecognizedDatabase(db) {
  const applicationId = db.prepare('PRAGMA application_id').get().application_id;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map((row) => row.name);
  if (tables.length === 0) return applicationId === 0 || applicationId === APPLICATION_ID;
  const legacyCorePresent = tables.includes('books') && tables.includes('chunks');
  const coreSchemaValid = legacyCorePresent
    && tables.every((name) => KNOWN_TABLES.has(name))
    && hasNoUnexpectedActiveObjects(db)
    && hasRequiredColumnDefinitions(db, 'books', {
      id: { type: 'INTEGER', notnull: 0, pk: 1 },
      cycle_name: { type: 'TEXT', notnull: 1, pk: 0 },
      folder_path: { type: 'TEXT', notnull: 1, pk: 0 },
      file_path: { type: 'TEXT', notnull: 1, pk: 0 },
      file_size: { type: 'INTEGER', notnull: 1, pk: 0 },
      mtime_ms: { type: 'INTEGER', notnull: 1, pk: 0 },
      content_hash: { type: 'TEXT', notnull: 1, pk: 0 },
      title: { type: 'TEXT', notnull: 1, pk: 0 },
      annotation: { type: 'TEXT', notnull: 1, pk: 0 },
      index_status: { type: 'TEXT', notnull: 1, pk: 0 },
      indexed_at: { type: 'TEXT', notnull: 0, pk: 0 },
    })
    && hasRequiredColumnDefinitions(db, 'chunks', {
      id: { type: 'INTEGER', notnull: 0, pk: 1 },
      book_id: { type: 'INTEGER', notnull: 1, pk: 0 },
      chunk_index: { type: 'INTEGER', notnull: 1, pk: 0 },
      text: { type: 'TEXT', notnull: 1, pk: 0 },
      content_hash: { type: 'TEXT', notnull: 1, pk: 0 },
      start_offset: { type: 'INTEGER', notnull: 1, pk: 0 },
      end_offset: { type: 'INTEGER', notnull: 1, pk: 0 },
    })
    && hasUniqueIndex(db, 'books', ['file_path'])
    && hasUniqueIndex(db, 'chunks', ['book_id', 'chunk_index'])
    && hasExpectedChunkForeignKey(db);
  return (applicationId === 0 || applicationId === APPLICATION_ID) && coreSchemaValid;
}

function initializeSearchDatabase(databasePath) {
  const sqlite = loadNodeSqlite();
  if (!sqlite?.DatabaseSync) {
    throw new Error('SQLite runtime support is unavailable. Use Node.js with node:sqlite support or add a portable SQLite adapter later.');
  }

  const isFileDatabase = databasePath !== ':memory:';
  const existedBeforeOpen = isFileDatabase && fs.existsSync(databasePath);
  const existingSize = existedBeforeOpen ? fs.statSync(databasePath).size : 0;
  const directory = path.dirname(databasePath);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (isFileDatabase && process.platform !== 'win32' && directory !== '.' && !directoryExisted) {
    fs.chmodSync(directory, 0o700);
  }
  const db = new sqlite.DatabaseSync(databasePath);
  const currentApplicationId = db.prepare('PRAGMA application_id').get().application_id;
  const currentUserVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (currentApplicationId === APPLICATION_ID && currentUserVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema version ${currentUserVersion} is newer than supported version ${SCHEMA_VERSION}.`);
  }
  if (!isRecognizedDatabase(db)) {
    db.close();
    throw new Error('Refusing to modify a SQLite file that is not a Books Selection database. Choose a new database path.');
  }
  if (isFileDatabase && process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
  if (isFileDatabase && existedBeforeOpen && existingSize > 0
    && (currentApplicationId !== APPLICATION_ID || currentUserVersion < SCHEMA_VERSION)) {
    const backupPath = `${databasePath}.backup-${Date.now()}`;
    const escapedBackupPath = backupPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedBackupPath}'`);
    if (process.platform !== 'win32') fs.chmodSync(backupPath, 0o600);
  }

  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA foreign_keys = ON');
    if (isFileDatabase) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(createSchemaSql());
    } catch (error) {
      if (!/no such column: fact_type/i.test(error.message || '')) throw error;
      db.exec("ALTER TABLE derived_facts ADD COLUMN fact_type TEXT NOT NULL DEFAULT 'generic'");
      db.exec(createSchemaSql());
    }
    const bookColumns = db.prepare('PRAGMA table_info(books)').all().map((row) => row.name);
    if (!bookColumns.includes('indexed_root')) {
      db.exec('ALTER TABLE books ADD COLUMN indexed_root TEXT');
    }
    if (!bookColumns.includes('context_version')) {
      db.exec('ALTER TABLE books ADD COLUMN context_version INTEGER NOT NULL DEFAULT 0');
    }
    const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all().map((row) => row.name);
    if (!chunkColumns.includes('body_index')) db.exec('ALTER TABLE chunks ADD COLUMN body_index INTEGER NOT NULL DEFAULT 0');
    if (!chunkColumns.includes('section_path')) db.exec("ALTER TABLE chunks ADD COLUMN section_path TEXT NOT NULL DEFAULT '[]'");
    if (!chunkColumns.includes('source_order')) db.exec('ALTER TABLE chunks ADD COLUMN source_order INTEGER NOT NULL DEFAULT 0');
    if (!chunkColumns.includes('source_kind')) db.exec("ALTER TABLE chunks ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy'");
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
    if (isFileDatabase && process.platform !== 'win32') {
      for (const statePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (fs.existsSync(statePath)) fs.chmodSync(statePath, 0o600);
      }
    }
    return db;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
}

module.exports = {
  hasNodeSqliteSupport,
  initializeSearchDatabase,
};
