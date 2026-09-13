function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isAllowedExternalUrl(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    return false;
  }
  if (/^\/web3blind\/books-selection\/releases\/(?:latest|tag\/[^/]+)$/.test(url.pathname)) {
    return true;
  }
  const assetMatch = url.pathname.match(/^\/web3blind\/books-selection\/releases\/download\/[^/]+\/([^/]+)$/);
  return Boolean(assetMatch && new Set([
    'books-selection-desktop-linux-x64.tar.gz',
    'books-selection-desktop-win-x64.exe',
    'books-selection-desktop-win-x64.zip',
    'books-selection-desktop-mac-x64.zip',
  ]).has(assetMatch[1]));
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
