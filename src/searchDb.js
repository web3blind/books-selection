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
  return db;
}

module.exports = {
  hasNodeSqliteSupport,
  initializeSearchDatabase,
};
