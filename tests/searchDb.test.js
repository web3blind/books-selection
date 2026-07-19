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
