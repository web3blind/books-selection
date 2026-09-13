const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolvePortableRoot({ isPackaged, platform, execPath, env = {} }) {
  if (!isPackaged || platform !== 'win32') return '';
  const pathApi = pathApiFor(platform);
  if (env.PORTABLE_EXECUTABLE_DIR) {
    return pathApi.resolve(env.PORTABLE_EXECUTABLE_DIR);
  }
  return pathApi.dirname(execPath);
}

function resolvePortablePaths({ isPackaged, platform, execPath, env = {}, userDataPath, homeDir }) {
  const root = resolvePortableRoot({ isPackaged, platform, execPath, env });
  if (!root) return null;
  const pathApi = pathApiFor(platform);
  const dataDir = pathApi.join(root, 'data');
  return {
    dataDir,
    configPath: pathApi.join(dataDir, 'config.json'),
    dbPath: pathApi.join(dataDir, 'books-selection.sqlite'),
    logPath: pathApi.join(dataDir, 'books-selection.log'),
    legacyConfigPath: pathApi.join(homeDir, '.books-selection', 'config.json'),
    legacyDbPath: pathApi.join(userDataPath, 'data', 'books-selection.sqlite'),
    legacyLogPath: pathApi.join(homeDir, '.books-selection', 'logs', 'books-selection.log'),
  };
}

function configurePortableEnvironment(env, paths) {
  env.BOOKS_SELECTION_CONFIG_PATH ||= paths.configPath;
  env.BOOKS_SELECTION_DB_PATH ||= paths.dbPath;
  env.BOOKS_SELECTION_LOG_PATH ||= paths.logPath;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function samePath(first, second, platform = process.platform) {
  if (!first || !second) return false;
  const pathApi = pathApiFor(platform);
  const normalize = (value) => {
    const resolved = pathApi.resolve(String(value)).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

function shouldMigratePortableDatabase({ explicitConfigPath, explicitDbPath, configuredDbPath, portableDbPath, platform }) {
  if (explicitDbPath) return false;
  if (!explicitConfigPath) return true;
  return samePath(configuredDbPath, portableDbPath, platform);
}

function temporaryPathFor(destinationPath) {
  const suffix = randomBytes(6).toString('hex');
  return `${destinationPath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
}

async function commitNoReplace(temporaryPath, destinationPath, fsOps = fs) {
  try {
    await fsOps.link(temporaryPath, destinationPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP', 'ENOTSUP'].includes(error.code)) throw error;
  }

  try {
    await fsOps.copyFile(temporaryPath, destinationPath, require('node:fs').constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

async function writeJsonExclusive(filePath, value) {
  const temporaryPath = temporaryPathFor(path.join(path.dirname(filePath), `.${path.basename(filePath)}`));
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(temporaryPath, 0o600);
    return await commitNoReplace(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function backupSqliteDatabase(sourcePath, destinationPath) {
  const temporaryPath = temporaryPathFor(destinationPath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, temporaryPath);
    const verification = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      verification.prepare('PRAGMA schema_version').get();
    } finally {
      verification.close();
    }
    return await commitNoReplace(temporaryPath, destinationPath);
  } finally {
    source.close();
    await Promise.all([
      fs.rm(temporaryPath, { force: true }),
      fs.rm(`${temporaryPath}-wal`, { force: true }),
      fs.rm(`${temporaryPath}-shm`, { force: true }),
    ]);
  }
}

async function readJsonForMigration(filePath, warning, warn) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    warn(warning);
    return null;
  }
}

async function migrateLegacyData(paths, {
  backupDatabase = backupSqliteDatabase,
  migrateConfig = true,
  migrateDatabase = true,
  migrateLog = true,
  configuredDbPath = '',
  platform = process.platform,
  warn = console.warn,
} = {}) {
  const result = { migratedConfig: false, migratedDatabase: false, migratedLog: false };
  let dataDirExisted = true;
  try {
    await fs.stat(paths.dataDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    dataDirExisted = false;
  }
  await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && !dataDirExisted) await fs.chmod(paths.dataDir, 0o700);

  const portableConfigExists = await exists(paths.configPath);
  let portableConfig = null;
  if (migrateDatabase && portableConfigExists) {
    portableConfig = await readJsonForMigration(
      paths.configPath,
      'Portable configuration could not be read; existing data was preserved.',
      warn,
    );
  }
  let legacyConfig = null;
  if ((migrateConfig || migrateDatabase) && await exists(paths.legacyConfigPath)) {
    legacyConfig = await readJsonForMigration(
      paths.legacyConfigPath,
      'Legacy configuration could not be migrated; the source was preserved.',
      warn,
    );
  }
  const configForDatabase = portableConfig || legacyConfig;
  const usesPortableOrLegacyDefaultDb = !configForDatabase?.dbPath
    || samePath(configForDatabase.dbPath, paths.dbPath, platform)
    || samePath(configForDatabase.dbPath, paths.legacyDbPath, platform);

  if (migrateDatabase && !(await exists(paths.dbPath)) && usesPortableOrLegacyDefaultDb && await exists(paths.legacyDbPath)) {
    try {
      result.migratedDatabase = await backupDatabase(paths.legacyDbPath, paths.dbPath) !== false;
    } catch {
      warn('Legacy database could not be migrated; the source was preserved.');
    }
  }

  if (migrateConfig && !portableConfigExists && legacyConfig) {
    const migratedConfig = structuredClone(legacyConfig);
    if (configuredDbPath) migratedConfig.dbPath = configuredDbPath;
    else if (usesPortableOrLegacyDefaultDb) migratedConfig.dbPath = paths.dbPath;
    result.migratedConfig = await writeJsonExclusive(paths.configPath, migratedConfig);
  }

  if (migrateLog && !(await exists(paths.logPath)) && await exists(paths.legacyLogPath)) {
    try {
      await fs.copyFile(paths.legacyLogPath, paths.logPath, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') await fs.chmod(paths.logPath, 0o600);
      result.migratedLog = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  return result;
}

module.exports = {
  backupSqliteDatabase,
  commitNoReplace,
  configurePortableEnvironment,
  migrateLegacyData,
  resolvePortablePaths,
  resolvePortableRoot,
  samePath,
  shouldMigratePortableDatabase,
};
