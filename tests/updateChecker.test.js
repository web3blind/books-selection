const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkForUpdates,
  compareVersions,
  getAssetKind,
  preferredKindsForPlatform,
  selectPlatformAssets,
} = require('../src/updateChecker');

test('compareVersions handles v-prefixed semantic release tags', () => {
  assert.equal(compareVersions('v0.3.5', '0.3.4'), 1);
  assert.equal(compareVersions('0.3.4', 'v0.3.4'), 0);
  assert.equal(compareVersions('0.3.3', '0.3.4'), -1);
});

test('selectPlatformAssets chooses platform-specific desktop assets without hiding all downloads', () => {
  const releaseAssets = [
    { name: 'books-selection-desktop-linux-x64.tar.gz', browser_download_url: 'https://example.test/linux' },
    { name: 'books-selection-desktop-win-x64.exe', browser_download_url: 'https://example.test/win-exe' },
    { name: 'books-selection-desktop-win-x64.zip', browser_download_url: 'https://example.test/win-zip' },
    { name: 'books-selection-desktop-mac-x64.zip', browser_download_url: 'https://example.test/mac' },
  ];

  assert.equal(getAssetKind(releaseAssets[0].name), 'linuxTarGz');
  assert.deepEqual(preferredKindsForPlatform('win32'), ['windowsZip', 'windowsExe']);
  assert.deepEqual(selectPlatformAssets(releaseAssets, 'win32').preferred.map((asset) => asset.name), [
    'books-selection-desktop-win-x64.exe',
    'books-selection-desktop-win-x64.zip',
  ]);
  assert.deepEqual(selectPlatformAssets(releaseAssets, 'linux').preferred.map((asset) => asset.name), [
    'books-selection-desktop-linux-x64.tar.gz',
  ]);
  assert.deepEqual(selectPlatformAssets(releaseAssets, 'darwin').preferred.map((asset) => asset.name), [
    'books-selection-desktop-mac-x64.zip',
  ]);
  assert.equal(selectPlatformAssets(releaseAssets, 'linux').all.length, 4);
});

test('checkForUpdates returns latest release metadata through injectable fetch', async () => {
  let requestedUrl;
  const result = await checkForUpdates({
    currentVersion: '0.3.4',
    platform: 'linux',
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.headers.accept, 'application/vnd.github+json');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: 'v0.3.5',
            html_url: 'https://github.com/web3blind/books-selection/releases/tag/v0.3.5',
            name: 'Books Selection v0.3.5',
            published_at: '2026-07-20T00:00:00Z',
            body: 'Release notes',
            assets: [
              { name: 'books-selection-desktop-linux-x64.tar.gz', browser_download_url: 'https://example.test/linux', size: 123 },
              { name: 'books-selection-desktop-win-x64.zip', browser_download_url: 'https://example.test/win', size: 456 },
            ],
          };
        },
      };
    },
  });

  assert.match(requestedUrl, /api\.github\.com/);
  assert.equal(result.status, 'ok');
  assert.equal(result.currentVersion, '0.3.4');
  assert.equal(result.latestVersion, '0.3.5');
  assert.equal(result.hasUpdate, true);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].kind, 'linuxTarGz');
  assert.equal(result.allAssets.length, 2);
});
