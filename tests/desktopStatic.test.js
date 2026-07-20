const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');

test('Electron desktop starts backend in main process and opens BrowserWindow', () => {
  assert.ok(main.includes("require('../src/server')"), 'desktop should import the server module directly');
  assert.ok(main.includes('startServer({ defaultRoot: \'\', port: 0, openBrowser: false'), 'desktop should start local backend without opening the system browser');
  assert.ok(main.includes('new BrowserWindow'), 'desktop should open an app window');
  assert.ok(main.includes('serverHandle.url'), 'desktop window should load the in-process server URL');
  assert.ok(main.includes('BOOKS_SELECTION_DESKTOP_SMOKE'), 'desktop should include a Linux-verifiable smoke mode');
  assert.ok(!main.includes('child_process'), 'desktop backend must not be spawned as a separate child process');
});

test('Electron preload exposes only a narrow native folder picker API', () => {
  assert.ok(preload.includes('contextBridge.exposeInMainWorld'));
  assert.ok(preload.includes('booksSelectionDesktop'));
  assert.ok(preload.includes('pickDirectory'));
  assert.ok(!preload.includes('child_process'), 'preload should not expose process spawning to the page');
});
