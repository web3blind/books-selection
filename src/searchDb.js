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
  db.exec(createSchemaSql());
  return db;
}

module.exports = {
  hasNodeSqliteSupport,
  initializeSearchDatabase,
};
