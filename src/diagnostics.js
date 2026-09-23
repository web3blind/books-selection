const fs = require('node:fs/promises');
const path = require('node:path');

const { getDefaultDbPath } = require('./appConfig');
const { version: APP_VERSION } = require('../package.json');

const MAX_LOG_BYTES = 1024 * 1024;

function getErrorLogPath(env = process.env) {
  return env.BOOKS_SELECTION_LOG_PATH || path.join(path.dirname(getDefaultDbPath(env)), 'errors.log');
}

function safeText(value, maxLength = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

function safeOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function safeCode(value) {
  const code = String(value || '');
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : '';
}

function redact(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const token = String(secret || '');
    if (token.length >= 4) text = text.split(token).join('[REDACTED]');
  }
  return text
    .replace(/\bAuthorization\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/([?&](?:api_?key|key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]');
}

async function rotateIfNeeded(logPath) {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < MAX_LOG_BYTES) return;
    await fs.rm(`${logPath}.1`, { force: true });
    await fs.rename(logPath, `${logPath}.1`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function appendRecord(record, env) {
  const logPath = getErrorLogPath(env);
  const directory = path.dirname(logPath);
  let directoryExisted = true;
  try {
    await fs.stat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directoryExisted = false;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && !directoryExisted) await fs.chmod(directory, 0o700);
  await rotateIfNeeded(logPath);
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(logPath, 0o600);
  return logPath;
}

async function writeErrorLog(error, context = {}, env = process.env) {
  try {
    const secrets = [...(Array.isArray(context.secrets) ? context.secrets : []),
      ...Object.entries(env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value)];
    const status = Number(error?.statusCode ?? error?.status);
    const record = {
      timestamp: new Date().toISOString(),
      version: APP_VERSION,
      category: safeText(context.category || 'application_error', 80),
      operation: safeText(context.operation || context.route || 'unknown', 120),
      route: safeText(context.route, 120),
      phase: safeText(error?.providerOperation || context.phase, 120),
      provider: safeText(context.provider, 80),
      model: safeText(context.model, 160),
      code: safeCode(error?.code || context.code),
      causeCode: safeCode(error?.causeCode),
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
      endpoint: safeOrigin(error?.endpoint || context.endpoint),
      message: error?.code === 'PROVIDER_NETWORK_ERROR' ? 'Provider network request failed' : redact(error?.message || context.message || 'Unknown error', secrets),
    };
    if (context.omitMessage) delete record.message;
    for (const key of Object.keys(record)) {
      if (record[key] === '' || record[key] === undefined) delete record[key];
      else if (typeof record[key] === 'string') record[key] = safeText(redact(record[key], secrets));
    }
    return await appendRecord(record, env);
  } catch {
    return '';
  }
}

async function writeProviderNetworkDiagnostic(error, context = {}, env = process.env) {
  return writeErrorLog(error, {
    ...context,
    category: 'provider_network_error',
    operation: context.operation || error?.providerOperation || 'provider',
    omitMessage: true,
  }, env);
}

module.exports = {
  getDiagnosticLogPath: getErrorLogPath,
  getErrorLogPath,
  writeErrorLog,
  writeProviderNetworkDiagnostic,
};
