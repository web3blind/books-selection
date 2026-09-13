class ProviderNetworkError extends Error {
  constructor({ operation, endpoint, causeCode, cause }) {
    const codeText = causeCode ? ` (${causeCode})` : '';
    super(`${operation} failed before an HTTP response${codeText}.`, { cause });
    this.name = 'ProviderNetworkError';
    this.code = 'PROVIDER_NETWORK_ERROR';
    this.providerOperation = operation;
    this.endpoint = endpoint;
    this.causeCode = causeCode;
  }
}

class ProviderLimitError extends Error {
  constructor({ operation, code, message }) {
    super(message);
    this.name = 'ProviderLimitError';
    this.code = code;
    this.providerOperation = operation;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return '';
  }
}

function safeCauseCode(value) {
  const code = String(value || '');
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : '';
}

function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchWithProviderContext(fetchImpl, url, options = {}, operation, limits = {}) {
  const timeoutMs = boundedPositiveInteger(limits.timeoutMs, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const callerSignal = options.signal;
  let timedOut = false;
  let callerAborted = Boolean(callerSignal?.aborted);
  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort(callerSignal.reason);
  };
  if (callerSignal && !callerSignal.aborted) callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Provider request timed out.'));
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new ProviderLimitError({ operation, code: 'PROVIDER_TIMEOUT', message: `${operation} timed out after ${timeoutMs}ms.` });
    }
    if (callerAborted) {
      throw new ProviderLimitError({ operation, code: 'PROVIDER_ABORTED', message: `${operation} was aborted by the caller.` });
    }
    const causeCode = safeCauseCode(error?.cause?.code || error?.code);
    throw new ProviderNetworkError({
      operation,
      endpoint: safeEndpoint(url),
      causeCode,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function withProviderTimeout(promise, { timeoutMs, operation, onTimeout, signal }) {
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      try { await onTimeout?.(); } catch { /* best-effort cancellation */ }
      reject(new ProviderLimitError({
        operation,
        code: 'PROVIDER_TIMEOUT',
        message: `${operation} timed out after ${timeoutMs}ms.`,
      }));
    }, timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    abortHandler = () => {
      Promise.resolve(onTimeout?.()).catch(() => {});
      reject(new ProviderLimitError({
        operation,
        code: 'PROVIDER_ABORTED',
        message: `${operation} was aborted by the caller.`,
      }));
    };
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener?.('abort', abortHandler, { once: true });
  });
  return Promise.race([promise, timeout, aborted]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortHandler);
  });
}

async function readBoundedText(response, maxResponseBytes, operation, timeoutMs, signal) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    try {
      return await withProviderTimeout((async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          bytes += chunk.byteLength;
          if (bytes > maxResponseBytes) {
            await reader.cancel();
            throw new ProviderLimitError({
              operation,
              code: 'PROVIDER_RESPONSE_TOO_LARGE',
              message: `${operation} exceeded the ${maxResponseBytes}-byte response limit.`,
            });
          }
          parts.push(decoder.decode(chunk, { stream: true }));
        }
        parts.push(decoder.decode());
        return parts.join('');
      })(), { timeoutMs, operation, signal, onTimeout: () => reader.cancel() });
    } finally {
      reader.releaseLock?.();
    }
  }
  return withProviderTimeout(response.text(), { timeoutMs, operation, signal });
}

async function readJsonWithProviderContext(response, url, operation, limits = {}) {
  const maxResponseBytes = boundedPositiveInteger(limits.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const timeoutMs = boundedPositiveInteger(limits.timeoutMs, DEFAULT_TIMEOUT_MS);
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new ProviderLimitError({
      operation,
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
      message: `${operation} exceeded the ${maxResponseBytes}-byte response limit.`,
    });
  }

  try {
    if (typeof response.text === 'function' || response?.body?.getReader) {
      const text = await readBoundedText(response, maxResponseBytes, operation, timeoutMs, limits.signal);
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        throw new ProviderLimitError({
          operation,
          code: 'PROVIDER_RESPONSE_TOO_LARGE',
          message: `${operation} exceeded the ${maxResponseBytes}-byte response limit.`,
        });
      }
      return JSON.parse(text);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderLimitError) throw error;
    if (error instanceof SyntaxError) {
      throw new Error(`${operation} returned invalid JSON.`);
    }
    throw new ProviderNetworkError({
      operation,
      endpoint: safeEndpoint(url),
      causeCode: safeCauseCode(error?.cause?.code || error?.code),
      cause: error,
    });
  }
}

module.exports = {
  fetchWithProviderContext,
  readJsonWithProviderContext,
  ProviderNetworkError,
  ProviderLimitError,
};
