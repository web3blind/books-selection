const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  commitNoReplace,
  configurePortableEnvironment,
  migrateLegacyData,
  resolvePortablePaths,
  samePath,
  shouldMigratePortableDatabase,
} = require('../desktop/portableData');

function windowsPaths(overrides = {}) {
  return resolvePortablePaths({
    isPackaged: true,
    platform: 'win32',
    execPath: 'C:\\Apps\\Books Selection\\Books Selection.exe',
    env: {},
    userDataPath: 'C:\\Users\\Denis\\AppData\\Roaming\\Books Selection',
    homeDir: 'C:\\Users\\Denis',
    ...overrides,
  });
}

test('Windows ZIP build stores all writable data beside the executable', () => {
  const paths = windowsPaths();
  assert.equal(paths.dataDir, path.win32.join('C:\\Apps\\Books Selection', 'data'));
  assert.equal(paths.configPath, path.win32.join(paths.dataDir, 'config.json'));
  assert.equal(paths.dbPath, path.win32.join(paths.dataDir, 'books-selection.sqlite'));
  assert.equal(paths.logPath, path.win32.join(paths.dataDir, 'errors.log'));
});

test('Windows portable EXE uses electron-builder portable launch directory instead of extraction temp', () => {
  const paths = windowsPaths({
    execPath: 'C:\\Users\\Denis\\AppData\\Local\\Temp\\Books Selection.exe',
    env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Portable\\Books Selection' },
  });
  assert.equal(paths.dataDir, path.win32.join('D:\\Portable\\Books Selection', 'data'));
});

test('non-Windows packages keep platform user-data defaults instead of writing beside system apps', () => {
  const macPaths = resolvePortablePaths({
    isPackaged: true,
    platform: 'darwin',
    execPath: '/Applications/Books Selection.app/Contents/MacOS/Books Selection',
    env: {},
    userDataPath: '/Users/denis/Library/Application Support/Books Selection',
    homeDir: '/Users/denis',
  });
  const linuxPaths = resolvePortablePaths({
    isPackaged: true,
    platform: 'linux',
    execPath: '/opt/books-selection/books-selection',
    env: {},
    userDataPath: '/home/denis/.config/Books Selection',
    homeDir: '/home/denis',
  });
  assert.equal(macPaths, null);
  assert.equal(linuxPaths, null);
});

test('portable environment respects explicit overrides and fills all portable defaults', () => {
  const env = { BOOKS_SELECTION_DB_PATH: '/custom/books.sqlite' };
  configurePortableEnvironment(env, {
    configPath: '/portable/data/config.json',
    dbPath: '/portable/data/books-selection.sqlite',
    logPath: '/portable/data/errors.log',
  });
  assert.equal(env.BOOKS_SELECTION_CONFIG_PATH, '/portable/data/config.json');
  assert.equal(env.BOOKS_SELECTION_DB_PATH, '/custom/books.sqlite');
  assert.equal(env.BOOKS_SELECTION_LOG_PATH, '/portable/data/errors.log');
});

test('path comparison is case-insensitive only on Windows', () => {
  assert.equal(samePath('C:\\Data\\Books.sqlite', 'c:\\data\\books.sqlite', 'win32'), true);
  assert.equal(samePath('/Data/Books.sqlite', '/data/books.sqlite', 'linux'), false);
});

test('database migration decision treats config and DB overrides independently', () => {
  const portableDbPath = 'C:\\Portable\\data\\books.sqlite';
  assert.equal(shouldMigratePortableDatabase({
    explicitConfigPath: 'C:\\custom-config.json',
    explicitDbPath: '',
    configuredDbPath: portableDbPath,
    portableDbPath,
    platform: 'win32',
  }), true);
  assert.equal(shouldMigratePortableDatabase({
    explicitConfigPath: 'C:\\custom-config.json',
    explicitDbPath: '',
    configuredDbPath: 'D:\\existing\\books.sqlite',
    portableDbPath,
    platform: 'win32',
  }), false);
  assert.equal(shouldMigratePortableDatabase({
    explicitConfigPath: '',
    explicitDbPath: 'D:\\explicit\\books.sqlite',
    configuredDbPath: 'D:\\explicit\\books.sqlite',
    portableDbPath,
    platform: 'win32',
  }), false);
});

test('commit falls back to exclusive copy when hard links are unsupported', async () => {
  const calls = [];
  const fsOps = {
    async link() {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    },
    async copyFile(source, destination, flags) {
      calls.push({ source, destination, flags });
    },
  };

  assert.equal(await commitNoReplace('/tmp/source', '/tmp/destination', fsOps), true);
  assert.deepEqual(calls, [{
    source: '/tmp/source',
    destination: '/tmp/destination',
    flags: require('node:fs').constants.COPYFILE_EXCL,
  }]);
});

test('first portable launch safely copies legacy config, SQLite content and log without deleting sources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-portable-'));
  const portableDir = path.join(root, 'portable', 'data');
  const legacyConfigPath = path.join(root, 'home', '.books-selection', 'config.json');
  const legacyDbPath = path.join(root, 'userData', 'data', 'books-selection.sqlite');
  const legacyLogPath = path.join(root, 'home', '.books-selection', 'logs', 'books-selection.log');
  const paths = {
    dataDir: portableDir,
    configPath: path.join(portableDir, 'config.json'),
    dbPath: path.join(portableDir, 'books-selection.sqlite'),
    logPath: path.join(portableDir, 'books-selection.log'),
    legacyConfigPath,
    legacyDbPath,
    legacyLogPath,
  };
  await fs.mkdir(path.dirname(legacyConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(legacyDbPath), { recursive: true });
  await fs.mkdir(path.dirname(legacyLogPath), { recursive: true });
  await fs.writeFile(legacyConfigPath, JSON.stringify({
    booksRoot: 'D:\\Books',
    dbPath: legacyDbPath,
    providers: { openrouter: { apiKey: 'saved-key-fixture' } },
  }));
  const db = new DatabaseSync(legacyDbPath);
  db.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES (\'preserved\')');
  db.close();
  await fs.writeFile(legacyLogPath, '{"old":true}\n');

  try {
    const result = await migrateLegacyData(paths);
    const migratedConfig = JSON.parse(await fs.readFile(paths.configPath, 'utf8'));
    const migratedDb = new DatabaseSync(paths.dbPath, { readOnly: true });
    const marker = migratedDb.prepare('SELECT value FROM marker').get();
    migratedDb.close();

    assert.equal(result.migratedConfig, true);
    assert.equal(result.migratedDatabase, true);
    assert.equal(migratedConfig.dbPath, paths.dbPath);
    assert.equal(migratedConfig.providers.openrouter.apiKey, 'saved-key-fixture');
    assert.equal(marker.value, 'preserved');
    assert.equal(await fs.readFile(paths.logPath, 'utf8'), '{"old":true}\n');
    assert.deepEqual((await fs.readdir(paths.dataDir)).filter((name) => name.includes('.tmp')), []);
    await fs.access(legacyConfigPath);
    await fs.access(legacyDbPath);
    await fs.access(legacyLogPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration preserves a deliberately configured custom database path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-portable-custom-'));
  const dataDir = path.join(root, 'portable', 'data');
  const customDbPath = path.join(root, 'custom', 'library.sqlite');
  const paths = {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    dbPath: path.join(dataDir, 'books-selection.sqlite'),
    logPath: path.join(dataDir, 'books-selection.log'),
    legacyConfigPath: path.join(root, 'legacy', 'config.json'),
    legacyDbPath: path.join(root, 'legacy', 'books-selection.sqlite'),
    legacyLogPath: path.join(root, 'legacy', 'books-selection.log'),
  };
  await fs.mkdir(path.dirname(paths.legacyConfigPath), { recursive: true });
  await fs.writeFile(paths.legacyConfigPath, JSON.stringify({ dbPath: customDbPath }));
  await fs.writeFile(paths.legacyDbPath, 'legacy-default-db');

  try {
    const result = await migrateLegacyData(paths);
    const migratedConfig = JSON.parse(await fs.readFile(paths.configPath, 'utf8'));
    assert.equal(result.migratedConfig, true);
    assert.equal(result.migratedDatabase, false);
    assert.equal(migratedConfig.dbPath, customDbPath);
    await assert.rejects(fs.access(paths.dbPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration never overwrites existing portable data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-portable-existing-'));
  const dataDir = path.join(root, 'portable', 'data');
  const paths = {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    dbPath: path.join(dataDir, 'books-selection.sqlite'),
    logPath: path.join(dataDir, 'books-selection.log'),
    legacyConfigPath: path.join(root, 'legacy', 'config.json'),
    legacyDbPath: path.join(root, 'legacy', 'books-selection.sqlite'),
    legacyLogPath: path.join(root, 'legacy', 'books-selection.log'),
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.dirname(paths.legacyConfigPath), { recursive: true });
  await fs.writeFile(paths.configPath, JSON.stringify({ booksRoot: 'portable' }));
  await fs.writeFile(paths.dbPath, 'portable-db');
  await fs.writeFile(paths.logPath, 'portable-log');
  await fs.writeFile(paths.legacyConfigPath, JSON.stringify({ booksRoot: 'legacy', dbPath: 'E:\\Custom\\library.sqlite' }));
  await fs.writeFile(paths.legacyDbPath, 'legacy-db');
  await fs.writeFile(paths.legacyLogPath, 'legacy-log');

  try {
    const result = await migrateLegacyData(paths);
    assert.deepEqual(result, { migratedConfig: false, migratedDatabase: false, migratedLog: false });
    assert.equal(await fs.readFile(paths.configPath, 'utf8'), JSON.stringify({ booksRoot: 'portable' }));
    assert.equal(await fs.readFile(paths.dbPath, 'utf8'), 'portable-db');
    assert.equal(await fs.readFile(paths.logPath, 'utf8'), 'portable-log');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('migration applies per-resource overrides without dropping unoverridden legacy data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-portable-overrides-'));
  const dataDir = path.join(root, 'portable', 'data');
  const customDbPath = path.join(root, 'custom.sqlite');
  const paths = {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    dbPath: path.join(dataDir, 'books-selection.sqlite'),
    logPath: path.join(dataDir, 'books-selection.log'),
    legacyConfigPath: path.join(root, 'legacy', 'config.json'),
    legacyDbPath: path.join(root, 'legacy', 'books-selection.sqlite'),
    legacyLogPath: path.join(root, 'legacy', 'books-selection.log'),
  };
  await fs.mkdir(path.dirname(paths.legacyConfigPath), { recursive: true });
  await fs.writeFile(paths.legacyConfigPath, JSON.stringify({ booksRoot: '/books', dbPath: paths.legacyDbPath }));
  await fs.writeFile(paths.legacyLogPath, 'legacy-log');

  try {
    const result = await migrateLegacyData(paths, {
      migrateConfig: true,
      migrateDatabase: false,
      migrateLog: false,
      configuredDbPath: customDbPath,
    });
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'));
    assert.deepEqual(result, { migratedConfig: true, migratedDatabase: false, migratedLog: false });
    assert.equal(config.dbPath, customDbPath);
    await assert.rejects(fs.access(paths.dbPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(paths.logPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('corrupt legacy config and database are skipped independently with sanitized warnings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-portable-corrupt-'));
  const dataDir = path.join(root, 'portable', 'data');
  const paths = {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    dbPath: path.join(dataDir, 'books-selection.sqlite'),
    logPath: path.join(dataDir, 'books-selection.log'),
    legacyConfigPath: path.join(root, 'private-home', 'config.json'),
    legacyDbPath: path.join(root, 'private-user-data', 'books-selection.sqlite'),
    legacyLogPath: path.join(root, 'private-home', 'books-selection.log'),
  };
  await fs.mkdir(path.dirname(paths.legacyConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.legacyDbPath), { recursive: true });
  await fs.writeFile(paths.legacyConfigPath, '{secret-corrupt-config');
  await fs.writeFile(paths.legacyDbPath, 'secret-corrupt-database');
  await fs.writeFile(paths.legacyLogPath, 'legacy-log');
  const warnings = [];

  try {
    const result = await migrateLegacyData(paths, { warn: (message) => warnings.push(message) });

    assert.deepEqual(result, { migratedConfig: false, migratedDatabase: false, migratedLog: true });
    assert.deepEqual(warnings, [
      'Legacy configuration could not be migrated; the source was preserved.',
      'Legacy database could not be migrated; the source was preserved.',
    ]);
    assert.doesNotMatch(warnings.join(' '), /private-home|private-user-data|secret/i);
    assert.equal(await fs.readFile(paths.legacyConfigPath, 'utf8'), '{secret-corrupt-config');
    assert.equal(await fs.readFile(paths.legacyDbPath, 'utf8'), 'secret-corrupt-database');
    assert.equal(await fs.readFile(paths.logPath, 'utf8'), 'legacy-log');
    await assert.rejects(fs.access(paths.configPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(paths.dbPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent first-launch migrations commit each portable destination at most once', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-portable-race-'));
  const dataDir = path.join(root, 'portable', 'data');
  const paths = {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    dbPath: path.join(dataDir, 'books-selection.sqlite'),
    logPath: path.join(dataDir, 'books-selection.log'),
    legacyConfigPath: path.join(root, 'legacy', 'config.json'),
    legacyDbPath: path.join(root, 'legacy', 'books-selection.sqlite'),
    legacyLogPath: path.join(root, 'legacy', 'books-selection.log'),
  };
  await fs.mkdir(path.dirname(paths.legacyConfigPath), { recursive: true });
  await fs.writeFile(paths.legacyConfigPath, JSON.stringify({ dbPath: paths.legacyDbPath }));
  const db = new DatabaseSync(paths.legacyDbPath);
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('source')");
  db.close();
  await fs.writeFile(paths.legacyLogPath, 'source-log');

  try {
    await Promise.all([migrateLegacyData(paths), migrateLegacyData(paths)]);
    const migrated = new DatabaseSync(paths.dbPath, { readOnly: true });
    assert.equal(migrated.prepare('SELECT value FROM marker').get().value, 'source');
    migrated.close();
    assert.equal(JSON.parse(await fs.readFile(paths.configPath, 'utf8')).dbPath, paths.dbPath);
    assert.equal(await fs.readFile(paths.logPath, 'utf8'), 'source-log');
    assert.deepEqual((await fs.readdir(paths.dataDir)).filter((name) => name.includes('.tmp')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
