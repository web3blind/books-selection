const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const pkgBin = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'pkg.cmd')
  : path.join(root, 'node_modules', '.bin', 'pkg');

const targets = [
  { target: 'node22-linux-x64', dir: 'books-selection-linux-x64', exe: 'books-selection', archive: 'books-selection-linux-x64.tar.gz' },
  { target: 'node22-win-x64', dir: 'books-selection-windows-x64', exe: 'books-selection.exe', archive: 'books-selection-windows-x64.tar.gz' },
  { target: 'node22-macos-x64', dir: 'books-selection-macos-x64', exe: 'books-selection', archive: 'books-selection-macos-x64.tar.gz' },
];

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
}

function writeBundleReadme(bundleDir, platformName, exeName) {
  const launcher = exeName.endsWith('.exe') ? exeName : `./${exeName}`;
  const text = `Books Selection (${platformName})\n\n` +
    `Run:\n  ${launcher}\n\n` +
    `Then open http://127.0.0.1:3210 if the browser does not open automatically.\n\n` +
    `Local writable files:\n` +
    `- data/books-selection.sqlite: default SQLite index database\n` +
    `- config file: ~/.books-selection/config.json by default, or BOOKS_SELECTION_CONFIG_PATH if set\n\n` +
    `Optional environment variables:\n` +
    `- PORT=3210\n` +
    `- BOOKS_SELECTION_NO_OPEN=1\n` +
    `- BOOKS_SELECTION_CONFIG_PATH=/path/to/config.json\n` +
    `- BOOKS_SELECTION_DB_PATH=/path/to/books-selection.sqlite\n` +
    `- BOOKS_SELECTION_OPENROUTER_MAX_SESSION_USAGE_USD=1\n`;
  fs.writeFileSync(path.join(bundleDir, 'README.txt'), text);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const item of targets) {
  const bundleDir = path.join(distDir, item.dir);
  fs.mkdirSync(path.join(bundleDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'data', '.gitkeep'), '');

  const exePath = path.join(bundleDir, item.exe);
  run(pkgBin, ['.', '--targets', item.target, '--output', exePath, '--public', '--compress', 'GZip']);
  if (!item.exe.endsWith('.exe')) {
    fs.chmodSync(exePath, 0o755);
  }
  writeBundleReadme(bundleDir, item.dir, item.exe);

  run('tar', ['-czf', path.join(distDir, item.archive), '-C', distDir, item.dir]);
}

console.log('\nBuilt release bundles:');
for (const item of targets) {
  console.log(`- dist/${item.dir}/`);
  console.log(`- dist/${item.archive}`);
}
