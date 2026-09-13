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

test('search DB adapter refuses a non-empty unrecognized SQLite database before creating app tables', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { initializeSearchDatabase } = require('./src/searchDb');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-foreign-db-'));
    const dbPath = path.join(dir, 'foreign.sqlite');
    const foreign = new DatabaseSync(dbPath);
    foreign.exec('CREATE TABLE personal_notes (id INTEGER PRIMARY KEY, body TEXT)');
    foreign.close();
    if (process.platform !== 'win32') {
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(dbPath, 0o644);
    }

    let message = '';
    try { initializeSearchDatabase(dbPath); } catch (error) { message = error.message; }
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    const applicationId = check.prepare('PRAGMA application_id').get().application_id;
    check.close();
    console.log(JSON.stringify({
      message, tables, applicationId,
      dirMode: fs.statSync(dir).mode & 0o777,
      dbMode: fs.statSync(dbPath).mode & 0o777,
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  `);

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.match(result.message, /not a Books Selection database/i);
  assert.deepEqual(result.tables, ['personal_notes']);
  assert.equal(result.applicationId, 0);
  if (process.platform !== 'win32') {
    assert.equal(result.dirMode, 0o755);
    assert.equal(result.dbMode, 0o644);
  }
});

test('search DB adapter refuses lookalike books/chunks tables without the complete legacy schema and preserves permissions', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { initializeSearchDatabase } = require('./src/searchDb');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-books-only-'));
    const dbPath = path.join(dir, 'foreign.sqlite');
    const foreign = new DatabaseSync(dbPath);
    foreign.exec('CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE chunks (id INTEGER PRIMARY KEY, text TEXT)');
    foreign.close();
    if (process.platform !== 'win32') fs.chmodSync(dbPath, 0o644);
    let message = '';
    try { initializeSearchDatabase(dbPath); } catch (error) { message = error.message; }
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    check.close();
    console.log(JSON.stringify({ message, tables, dbMode: fs.statSync(dbPath).mode & 0o777 }));
    fs.rmSync(dir, { recursive: true, force: true });
  `);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.match(result.message, /not a Books Selection database/i);
  assert.deepEqual(result.tables, ['books', 'chunks']);
  if (process.platform !== 'win32') assert.equal(result.dbMode, 0o644);
});

test('search DB adapter refuses a schema-compatible file with unexpected active triggers before side effects', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { createSchemaSql } = require('./src/searchSchema');
    const { initializeSearchDatabase } = require('./src/searchDb');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-trigger-spoof-'));
    const dbPath = path.join(dir, 'foreign.sqlite');
    const foreign = new DatabaseSync(dbPath);
    foreign.exec(createSchemaSql());
    foreign.exec("CREATE TRIGGER reject_books BEFORE INSERT ON books BEGIN SELECT RAISE(ABORT, 'foreign trigger'); END");
    foreign.close();
    if (process.platform !== 'win32') fs.chmodSync(dbPath, 0o644);
    let message = '';
    try { initializeSearchDatabase(dbPath); } catch (error) { message = error.message; }
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const trigger = check.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'reject_books'").get()?.name || '';
    const applicationId = check.prepare('PRAGMA application_id').get().application_id;
    check.close();
    console.log(JSON.stringify({ message, trigger, applicationId, dbMode: fs.statSync(dbPath).mode & 0o777 }));
    fs.rmSync(dir, { recursive: true, force: true });
  `);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.match(result.message, /not a Books Selection database/i);
  assert.equal(result.trigger, 'reject_books');
  assert.equal(result.applicationId, 0);
  if (process.platform !== 'win32') assert.equal(result.dbMode, 0o644);
});

test('search DB adapter refuses a Books Selection database from a newer unsupported schema version', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const { initializeSearchDatabase } = require('./src/searchDb');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-future-db-'));
    const dbPath = path.join(dir, 'future.sqlite');
    const future = new DatabaseSync(dbPath);
    future.exec('PRAGMA application_id = 1112755027; PRAGMA user_version = 999; CREATE TABLE books (id INTEGER PRIMARY KEY)');
    future.close();
    let message = '';
    try { initializeSearchDatabase(dbPath); } catch (error) { message = error.message; }
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const columns = check.prepare('PRAGMA table_info(books)').all().map((row) => row.name);
    check.close();
    console.log(JSON.stringify({ message, columns }));
    fs.rmSync(dir, { recursive: true, force: true });
  `);

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.match(result.message, /newer.*version/i);
  assert.deepEqual(result.columns, ['id']);
});

test('search DB adapter marks app databases and applies private permissions and write-safety pragmas', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { initializeSearchDatabase } = require('./src/searchDb');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-db-safety-'));
    const dataDir = path.join(dir, 'private-data');
    fs.mkdirSync(dataDir, { mode: 0o755 });
    const dbPath = path.join(dataDir, 'books.sqlite');
    const db = initializeSearchDatabase(dbPath);
    const result = {
      applicationId: db.prepare('PRAGMA application_id').get().application_id,
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      busyTimeout: db.prepare('PRAGMA busy_timeout').get().timeout,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
      dirMode: fs.statSync(dataDir).mode & 0o777,
      dbMode: fs.statSync(dbPath).mode & 0o777,
    };
    db.close();
    console.log(JSON.stringify(result));
    fs.rmSync(dir, { recursive: true, force: true });
  `);

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.notEqual(result.applicationId, 0);
  assert.ok(result.userVersion >= 1);
  assert.ok(result.busyTimeout >= 5000);
  assert.equal(result.journalMode, 'wal');
  assert.equal(result.synchronous, 1);
  if (process.platform !== 'win32') {
    assert.equal(result.dirMode, 0o755);
    assert.equal(result.dbMode, 0o600);
  }
});

test('search DB adapter creates missing parent directories for project data database paths', () => {
  const child = runNodeSqliteScript(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { initializeSearchDatabase } = require('./src/searchDb');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-selection-db-parent-'));
    const dbPath = path.join(dir, 'nested', 'data', 'books-selection.sqlite');
    const db = initializeSearchDatabase(dbPath);
    db.close();
    console.log(JSON.stringify({ exists: fs.existsSync(dbPath) }));
    fs.rmSync(dir, { recursive: true, force: true });
  `);

  if (child.status !== 0 && /No such built-in module: node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/.test(child.stderr)) {
    assert.match(child.stderr, /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/);
    return;
  }

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { exists: true });
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
      PRAGMA application_id = 1112755027;
      CREATE TABLE books (
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
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        UNIQUE(book_id, chunk_index)
      );
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
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    db.close();
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('old.sqlite.backup-'));
    console.log(JSON.stringify({ columns, applicationId, userVersion, backups }));
    fs.rmSync(dir, { recursive: true, force: true });
  `);

  if (child.status !== 0 && /No such built-in module: node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/.test(child.stderr)) {
    assert.match(child.stderr, /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/);
    return;
  }

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.ok(result.columns.includes('fact_type'));
  assert.notEqual(result.applicationId, 0);
  assert.ok(result.userVersion >= 1);
  assert.equal(result.backups.length, 1);
});
