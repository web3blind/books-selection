const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function runNodeSqliteScript(script) {
  return spawnSync(process.execPath, ['--no-warnings', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('search DB adapter reports whether runtime SQLite support is available without opening a database', () => {
  const child = runNodeSqliteScript(`
    const { hasNodeSqliteSupport } = require('./src/searchDb');
    console.log(typeof hasNodeSqliteSupport());
  `);

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'boolean');
});

test('search DB adapter initializes schema in a supplied SQLite database path when node sqlite is available', () => {
  const child = runNodeSqliteScript(`
    const { initializeSearchDatabase } = require('./src/searchDb');
    const db = initializeSearchDatabase(':memory:');
    db.prepare("INSERT INTO books (cycle_name, folder_path, file_path, file_size, mtime_ms, content_hash, title, annotation, index_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run('Cycle', '/tmp/Cycle', '/tmp/Cycle/book.fb2', 1, 2, 'hash', 'Title', 'Annotation', 'indexed');
    const row = db.prepare('SELECT title, index_status FROM books WHERE file_path = ?').get('/tmp/Cycle/book.fb2');
    console.log(JSON.stringify(row));
    db.close();
  `);

  if (child.status !== 0 && /No such built-in module: node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/.test(child.stderr)) {
    assert.match(child.stderr, /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/);
    return;
  }

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { title: 'Title', index_status: 'indexed' });
});

test('search DB adapter adds fact_type column when opening an older derived_facts table', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { initializeSearchDatabase } = require('./src/searchDb');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-old-schema-'));
    const dbPath = path.join(dir, 'old.sqlite');
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(\`
      CREATE TABLE derived_facts (
        id INTEGER PRIMARY KEY,
        book_id INTEGER,
        fact_key TEXT NOT NULL,
        fact_value TEXT NOT NULL,
        confidence REAL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_id, fact_key)
      );
    \`);
    oldDb.close();

    const db = initializeSearchDatabase(dbPath);
    const columns = db.prepare('PRAGMA table_info(derived_facts)').all().map((row) => row.name);
    console.log(JSON.stringify(columns));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  `);

  if (child.status !== 0 && /No such built-in module: node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/.test(child.stderr)) {
    assert.match(child.stderr, /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/);
    return;
  }

  assert.equal(child.status, 0, child.stderr);
  assert.ok(JSON.parse(child.stdout.trim()).includes('fact_type'));
});
