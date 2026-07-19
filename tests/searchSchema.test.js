const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { createSchemaSql } = require('../src/searchSchema');

test('search schema defines durable books, chunks, graph fact, and FTS tables', () => {
  const sql = createSchemaSql();

  for (const tableName of ['books', 'chunks', 'entities', 'relations', 'events', 'evidence', 'derived_facts']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\b`, 'i'));
  }

  assert.match(sql, /CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts\s+USING fts5/i);
  assert.match(sql, /content='chunks'/i);
  assert.match(sql, /content_hash TEXT/i);
});

test('search schema can initialize an in-memory SQLite database when node sqlite is available', () => {
  const child = spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const { createSchemaSql } = require('./src/searchSchema');
    const db = new DatabaseSync(':memory:');
    db.exec(createSchemaSql());
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name").all().map((row) => row.name);
    console.log(JSON.stringify(names));
    db.close();
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (child.status !== 0 && /No such built-in module: node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/.test(child.stderr)) {
    assert.equal(createSchemaSql().includes('CREATE TABLE IF NOT EXISTS books'), true);
    return;
  }

  assert.equal(child.status, 0, child.stderr);
  const names = JSON.parse(child.stdout.trim());
  assert.ok(names.includes('books'));
  assert.ok(names.includes('chunks'));
  assert.ok(names.includes('chunks_fts'));
  assert.ok(names.includes('entities'));
  assert.ok(names.includes('relations'));
  assert.ok(names.includes('events'));
  assert.ok(names.includes('evidence'));
  assert.ok(names.includes('derived_facts'));
});
