const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createRequestHandler, startServer } = require('../src/server');

test('server module is importable for Electron without immediately listening', () => {
  assert.equal(typeof createRequestHandler, 'function');
  assert.equal(typeof startServer, 'function');
});

test('startServer can run on an ephemeral port without opening a browser', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-server-module-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');

  const started = await startServer({ port: 0, openBrowser: false, log: false });
  try {
    assert.ok(started.port > 0);
    const response = await new Promise((resolve, reject) => {
      http.get(`${started.url}/api/config`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.isConfigured, false);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) {
      delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    } else {
      process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
