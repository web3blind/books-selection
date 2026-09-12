const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
const ignoreLines = new Set(gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));

test('gitignore excludes local config files and generated SQLite databases', () => {
  for (const marker of [
    'dist/',
    'dist-desktop/',
    '.books-selection/',
    'config.json',
    '*.local.json',
    '*.sqlite',
    '*.sqlite-*',
    '*.db',
    '*.db-*',
  ]) {
    assert.ok(ignoreLines.has(marker), `missing .gitignore marker: ${marker}`);
  }
});
