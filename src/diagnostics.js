const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;

function getDiagnosticLogPath(env = process.env) {
  return env.BOOKS_SELECTION_LOG_PATH || path.join(os.homedir(), '.books-selection', 'logs', 'books-selection.log');
}

function safeText(value, maxLength = 300) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

function safeOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function safeCauseCode(value) {
  const code = String(value || '');
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : '';
}

async function rotateIfNeeded(logPath) {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < MAX_LOG_BYTES) return;
    await fs.rename(logPath, `${logPath}.1`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function writeProviderNetworkDiagnostic(error, context = {}, env = process.env) {
  const logPath = getDiagnosticLogPath(env);
  const directory = path.dirname(logPath);
  let directoryExisted = true;
  try {
    await fs.stat(directory);
  } catch (statError) {
    if (statError.code !== 'ENOENT') throw statError;
    directoryExisted = false;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && !directoryExisted) await fs.chmod(directory, 0o700);
  await rotateIfNeeded(logPath);

  const record = {
    timestamp: new Date().toISOString(),
    category: 'provider_network_error',
    route: safeText(context.route, 80),
    operation: safeText(error?.providerOperation, 120),
    endpoint: safeOrigin(error?.endpoint),
    causeCode: safeCauseCode(error?.causeCode),
  };
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(logPath, 0o600);
  return logPath;
}

module.exports = {
  getDiagnosticLogPath,
  writeProviderNetworkDiagnostic,
};
