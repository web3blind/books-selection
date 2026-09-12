const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createSchemaSql } = require('./searchSchema');

const dynamicRequire = createRequire(__filename);

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

function initializeSearchDatabase(databasePath) {
  const sqlite = loadNodeSqlite();
  if (!sqlite?.DatabaseSync) {
    throw new Error('SQLite runtime support is unavailable. Use Node.js with node:sqlite support or add a portable SQLite adapter later.');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new sqlite.DatabaseSync(databasePath);
  try {
    db.exec(createSchemaSql());
  } catch (error) {
    if (!/no such column: fact_type/i.test(error.message || '')) {
      throw error;
    }
    db.exec("ALTER TABLE derived_facts ADD COLUMN fact_type TEXT NOT NULL DEFAULT 'generic'");
    db.exec(createSchemaSql());
  }
  const bookColumns = db.prepare('PRAGMA table_info(books)').all().map((row) => row.name);
  if (!bookColumns.includes('indexed_root')) {
    db.exec('ALTER TABLE books ADD COLUMN indexed_root TEXT');
  }
  return db;
}

module.exports = {
  hasNodeSqliteSupport,
  initializeSearchDatabase,
};
