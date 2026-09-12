function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isAllowedExternalUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && url.protocol === 'https:');
}

function isTrustedRendererUrl(value, appUrl) {
  const rendererUrl = parseUrl(value);
  const trustedUrl = parseUrl(appUrl);
  return Boolean(
    rendererUrl
    && trustedUrl
    && rendererUrl.protocol === trustedUrl.protocol
    && rendererUrl.origin === trustedUrl.origin
    && rendererUrl.hostname === '127.0.0.1'
  );
}

module.exports = {
  isAllowedExternalUrl,
  isTrustedRendererUrl,
};
