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
  indexed_at TEXT,
  indexed_root TEXT
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

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  id INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chunk_id, provider, model, content_hash)
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
  normalized_name TEXT NOT NULL,
  UNIQUE(book_id, kind, normalized_name)
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  excerpt TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chunk'
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  source_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  target_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  relation_type TEXT NOT NULL,
  confidence REAL,
  evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence REAL,
  evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS derived_facts (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'generic',
  fact_value TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(book_id, fact_key)
);

CREATE TABLE IF NOT EXISTS corpus_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  indexed_root TEXT NOT NULL,
  discovered_cycles INTEGER NOT NULL,
  discovered_books INTEGER NOT NULL,
  indexed_cycles INTEGER NOT NULL,
  indexed_books INTEGER NOT NULL,
  indexed_chunks INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_books_hash_mtime ON books(content_hash, mtime_ms);
CREATE TABLE IF NOT EXISTS cycle_favorites (
  cycle_key TEXT PRIMARY KEY,
  cycle_name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  sort_position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cycle_query_hits (
  cycle_key TEXT NOT NULL,
  query_normalized TEXT NOT NULL,
  query_display TEXT NOT NULL,
  best_position INTEGER NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (cycle_key, query_normalized)
);

CREATE INDEX IF NOT EXISTS idx_cycle_query_hits_cycle ON cycle_query_hits(cycle_key, best_position);

CREATE TABLE IF NOT EXISTS cycle_series (
  cycle_key TEXT PRIMARY KEY,
  cycle_name TEXT NOT NULL,
  series_id INTEGER NOT NULL,
  series_url TEXT NOT NULL,
  series_title TEXT,
  work_ids TEXT NOT NULL,
  work_count INTEGER NOT NULL,
  is_complete INTEGER,
  has_updates INTEGER NOT NULL DEFAULT 0 CHECK (has_updates IN (0, 1)),
  update_kinds TEXT NOT NULL DEFAULT '[]',
  new_works TEXT NOT NULL DEFAULT '[]',
  last_check_status TEXT NOT NULL DEFAULT 'ok',
  last_check_error TEXT,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cycle_reading_state (
  cycle_key TEXT PRIMARY KEY,
  cycle_name TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_unfinished INTEGER NOT NULL DEFAULT 0 CHECK (is_unfinished IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_provider_model_hash ON chunk_embeddings(provider, model, content_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chunk ON chunk_embeddings(chunk_id);
CREATE INDEX IF NOT EXISTS idx_entities_book_name ON entities(book_id, kind, normalized_name);
CREATE INDEX IF NOT EXISTS idx_evidence_book_chunk ON evidence(book_id, chunk_id);
CREATE INDEX IF NOT EXISTS idx_relations_book_type ON relations(book_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_events_book_type ON events(book_id, event_type);
CREATE INDEX IF NOT EXISTS idx_derived_facts_book_key ON derived_facts(book_id, fact_key);
CREATE INDEX IF NOT EXISTS idx_derived_facts_type ON derived_facts(fact_type);
`;
}

module.exports = {
  createSchemaSql,
};
