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

async function fetchWithProviderContext(fetchImpl, url, options, operation) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    const causeCode = safeCauseCode(error?.cause?.code || error?.code);
    throw new ProviderNetworkError({
      operation,
      endpoint: safeEndpoint(url),
      causeCode,
      cause: error,
    });
  }
}

async function readJsonWithProviderContext(response, url, operation) {
  try {
    return await response.json();
  } catch (error) {
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
};
