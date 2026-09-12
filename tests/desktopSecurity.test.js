const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedExternalUrl, isTrustedRendererUrl } = require('../desktop/security');

test('desktop external links allow only HTTPS URLs', () => {
  assert.equal(isAllowedExternalUrl('https://github.com/web3blind/books-selection/releases/latest'), true);
  assert.equal(isAllowedExternalUrl('http://example.com/download'), false);
  assert.equal(isAllowedExternalUrl('file:///tmp/example'), false);
  assert.equal(isAllowedExternalUrl('custom-handler://run'), false);
  assert.equal(isAllowedExternalUrl('not a URL'), false);
});

test('desktop trusts only the exact in-process loopback origin', () => {
  const appUrl = 'http://127.0.0.1:34567';
  assert.equal(isTrustedRendererUrl(`${appUrl}/`, appUrl), true);
  assert.equal(isTrustedRendererUrl(`${appUrl}/index.html`, appUrl), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:9999/', appUrl), false);
  assert.equal(isTrustedRendererUrl('http://localhost:34567/', appUrl), false);
  assert.equal(isTrustedRendererUrl('https://example.com/', appUrl), false);
});