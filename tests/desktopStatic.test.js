const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');

test('Electron desktop starts backend in main process and opens BrowserWindow', () => {
  assert.ok(main.includes("require('../src/server')"), 'desktop should import the server module directly');
  assert.ok(main.includes("require('./portableData')"), 'desktop should resolve and migrate packaged writable data');
  assert.ok(main.includes('PORTABLE_EXECUTABLE_DIR'), 'desktop should honor electron-builder portable EXE location');
  assert.ok(main.includes('migrateLegacyData'), 'desktop should preserve legacy config and SQLite data on first portable launch');
  assert.ok(main.includes("process.platform === 'win32'"), 'only Windows portable builds should write beside the executable');
  assert.ok(main.includes('requestSingleInstanceLock'), 'desktop should prevent concurrent first-launch migration races');
  assert.ok(main.includes('providerFetchImpl: net.fetch'), 'desktop provider calls should use Electron Chromium networking');
  assert.ok(main.includes('const { app, BrowserWindow, dialog, ipcMain, net, shell }'), 'desktop should import Electron net');
  assert.ok(main.includes("defaultRoot: ''"), 'desktop should start the backend without a default books folder');
  assert.ok(main.includes('port: 0'), 'desktop should allocate an ephemeral loopback port');
  assert.ok(main.includes('openBrowser: false'), 'desktop should not open the system browser');
  assert.ok(main.includes('new BrowserWindow'), 'desktop should open an app window');
  assert.ok(main.includes('serverHandle.url'), 'desktop window should load the in-process server URL');
  assert.ok(main.includes('async function ensureServer()'), 'desktop should reuse one backend server for reopened windows');
  assert.ok(main.includes('sandbox: true'), 'desktop renderer should use Chromium sandboxing');
  assert.ok(main.includes("mainWindow.webContents.on('will-navigate'"), 'desktop should block navigation away from its loopback origin');
  assert.ok(main.includes('isAllowedExternalUrl'), 'desktop should validate URLs before opening them externally');
  assert.ok(main.includes('isTrustedRendererUrl'), 'desktop IPC should validate the calling renderer URL');
  assert.ok(main.includes('BOOKS_SELECTION_DESKTOP_SMOKE'), 'desktop should include a Linux-verifiable smoke mode');
  assert.ok(main.includes('configPath: config.path'), 'desktop smoke should expose the resolved portable config path');
  assert.ok(!main.includes('child_process'), 'desktop backend must not be spawned as a separate child process');
});

test('Electron preload exposes only a narrow native folder picker API', () => {
  assert.ok(preload.includes('contextBridge.exposeInMainWorld'));
  assert.ok(preload.includes('booksSelectionDesktop'));
  assert.ok(preload.includes('pickDirectory'));
  assert.ok(!preload.includes('child_process'), 'preload should not expose process spawning to the page');
});
