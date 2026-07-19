function createSchemaSql() {
  return `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  cycle_name TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  annotation TEXT NOT NULL,
  index_status TEXT NOT NULL DEFAULT 'pending',
  indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  UNIQUE(book_id, chunk_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id'
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  normalized_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  source_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  target_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  relation_type TEXT NOT NULL,
  confidence REAL,
  evidence_id INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence REAL,
  evidence_id INTEGER
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  excerpt TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chunk'
);

CREATE TABLE IF NOT EXISTS derived_facts (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(book_id, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_books_hash_mtime ON books(content_hash, mtime_ms);
CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_entities_book_name ON entities(book_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_derived_facts_book_key ON derived_facts(book_id, fact_key);
`;
}

module.exports = {
  createSchemaSql,
};
