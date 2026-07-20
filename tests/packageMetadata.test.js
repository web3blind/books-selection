const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const buildScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-dist.js'), 'utf8');

test('package metadata defines pkg-based cross-platform release build', () => {
  assert.equal(packageJson.scripts['build:dist'], 'node scripts/build-dist.js');
  assert.equal(packageJson.bin, 'src/server.js');
  assert.deepEqual(packageJson.pkg.assets, ['public/**/*']);
  assert.match(packageJson.devDependencies['@yao-pkg/pkg'], /<7/);
});

test('package metadata defines Electron desktop release build', () => {
  assert.equal(packageJson.main, 'desktop/main.js');
  assert.equal(packageJson.scripts['desktop:start'], 'electron .');
  assert.equal(packageJson.scripts['build:desktop'], 'electron-builder --linux tar.gz --win portable zip --mac zip --publish never');
  assert.match(packageJson.devDependencies.electron, /<44/);
  assert.match(packageJson.devDependencies['electron-builder'], /<27/);
  assert.equal(packageJson.build.productName, 'Books Selection');
  assert.deepEqual(packageJson.build.linux.target, ['tar.gz']);
  assert.deepEqual(packageJson.build.win.target, ['portable', 'zip']);
  assert.deepEqual(packageJson.build.mac.target, ['zip']);
});

test('release build script creates Linux Windows and macOS bundles with data folders', () => {
  for (const marker of [
    'node22-linux-x64',
    'node22-win-x64',
    'node22-macos-x64',
    "path.join(bundleDir, 'data')",
    'books-selection-linux-x64.tar.gz',
    'books-selection-windows-x64.tar.gz',
    'books-selection-macos-x64.tar.gz',
  ]) {
    assert.ok(buildScript.includes(marker), `missing build marker: ${marker}`);
  }
});
