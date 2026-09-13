const CURRENT_VERSION = require('../package.json').version;

const RELEASES_API_URL = 'https://api.github.com/repos/web3blind/books-selection/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/web3blind/books-selection/releases/latest';
const EXPECTED_ASSET_NAMES = new Set([
  'books-selection-desktop-linux-x64.tar.gz',
  'books-selection-desktop-win-x64.exe',
  'books-selection-desktop-win-x64.zip',
  'books-selection-desktop-mac-x64.zip',
]);

function parseExpectedGitHubUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function isExpectedReleaseUrl(value) {
  const url = parseExpectedGitHubUrl(value);
  return Boolean(url && /^\/web3blind\/books-selection\/releases\/(?:latest|tag\/[^/]+)$/.test(url.pathname));
}

function isExpectedAssetUrl(value, assetName) {
  const url = parseExpectedGitHubUrl(value);
  return Boolean(
    url
    && EXPECTED_ASSET_NAMES.has(assetName)
    && url.pathname.startsWith('/web3blind/books-selection/releases/download/')
    && url.pathname.endsWith(`/${assetName}`)
  );
}

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '').split('+', 1)[0];
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left[index]) - Number(right[index]);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index] - right.core[index];
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function getAssetKind(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.includes('-win-') && name.endsWith('.exe')) return 'windowsExe';
  if (name.includes('-win-') && name.endsWith('.zip')) return 'windowsZip';
  if (name.includes('-linux-') && name.endsWith('.tar.gz')) return 'linuxTarGz';
  if (name.includes('-mac-') && name.endsWith('.zip')) return 'macZip';
  return 'other';
}

function normalizeAsset(asset) {
  const name = String(asset.name || '');
  const url = asset.browser_download_url || asset.url || '';
  if (!isExpectedAssetUrl(url, name)) return null;
  return {
    name,
    kind: getAssetKind(name),
    url,
    size: asset.size || 0,
  };
}

function preferredKindsForPlatform(platform) {
  if (platform === 'win32') return ['windowsZip', 'windowsExe'];
  if (platform === 'darwin') return ['macZip'];
  if (platform === 'linux') return ['linuxTarGz'];
  return [];
}

function selectPlatformAssets(assets, platform) {
  const normalized = assets.map(normalizeAsset).filter(Boolean);
  const preferredKinds = preferredKindsForPlatform(platform);
  const preferred = normalized.filter((asset) => preferredKinds.includes(asset.kind));
  return {
    preferred,
    all: normalized,
  };
}

async function fetchLatestRelease({ fetchImpl = globalThis.fetch, apiUrl = RELEASES_API_URL } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available for update checks.');
  }

  const response = await fetchImpl(apiUrl, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'books-selection-update-check',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function checkForUpdates({
  currentVersion = CURRENT_VERSION,
  platform = process.platform,
  fetchImpl,
  apiUrl,
} = {}) {
  const latest = await fetchLatestRelease({ fetchImpl, apiUrl });
  const latestVersion = normalizeVersion(latest.tag_name || latest.name || '');
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
  const assets = selectPlatformAssets(Array.isArray(latest.assets) ? latest.assets : [], platform);

  return {
    status: 'ok',
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    hasUpdate,
    platform,
    releaseUrl: isExpectedReleaseUrl(latest.html_url) ? latest.html_url : RELEASES_PAGE_URL,
    releaseName: latest.name || latest.tag_name || '',
    publishedAt: latest.published_at || '',
    body: latest.body || '',
    assets: assets.preferred,
    allAssets: assets.all,
  };
}

module.exports = {
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  checkForUpdates,
  compareVersions,
  getAssetKind,
  normalizeVersion,
  preferredKindsForPlatform,
  selectPlatformAssets,
};
