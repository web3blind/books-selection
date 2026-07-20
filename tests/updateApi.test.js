const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createRequestHandler } = require('../src/server');

function requestJson(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ hostname: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

test('/api/update-check returns update metadata with platform-specific assets', async () => {
  const server = http.createServer(createRequestHandler({
    updateCheckOptions: {
      currentVersion: '0.3.4',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: 'v0.3.5',
            html_url: 'https://github.com/web3blind/books-selection/releases/tag/v0.3.5',
            assets: [
              { name: 'books-selection-desktop-linux-x64.tar.gz', browser_download_url: 'https://example.test/linux' },
              { name: 'books-selection-desktop-win-x64.exe', browser_download_url: 'https://example.test/win-exe' },
              { name: 'books-selection-desktop-win-x64.zip', browser_download_url: 'https://example.test/win-zip' },
            ],
          };
        },
      }),
    },
  }));

  try {
    await listen(server);
    const response = await requestJson(server, '/api/update-check?platform=win32');

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.hasUpdate, true);
    assert.equal(response.body.currentVersion, '0.3.4');
    assert.equal(response.body.latestVersion, '0.3.5');
    assert.deepEqual(response.body.assets.map((asset) => asset.name), [
      'books-selection-desktop-win-x64.exe',
      'books-selection-desktop-win-x64.zip',
    ]);
    assert.equal(response.body.allAssets.length, 3);
  } finally {
    server.close();
  }
});
