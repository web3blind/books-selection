const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');

test('gitignore excludes local config files and generated SQLite databases', () => {
  for (const marker of [
    '.books-selection/',
    'config.json',
    '*.local.json',
    'data/*.sqlite',
    'data/*.sqlite-*',
    'data/*.db',
  ]) {
    assert.ok(gitignore.includes(marker), `missing .gitignore marker: ${marker}`);
  }
});
