const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('index page exposes accessible AI search controls without committed secrets', () => {
  const requiredMarkers = [
    'for="dbPath"',
    'id="dbPath"',
    'books-selection:last-db',
    'id="buildIndexButton"',
    'id="ftsQuestion"',
    'for="ftsQuestion"',
    'id="localSearchButton"',
    'id="askButton"',
    'id="embedIndexButton"',
    'id="aiStatus"',
    'aria-live="polite"',
    'id="aiResults"',
    '<ul',
    '/api/index',
    '/api/search',
    '/api/ask',
    '/api/embed-index',
    'needs_provider_key',
    'needs_embedding_provider_key',
  ];

  for (const marker of requiredMarkers) {
    assert.ok(html.includes(marker), `missing UI marker: ${marker}`);
  }

  assert.ok(!html.includes('sk-'), 'index.html must not contain API-key looking values');
  assert.ok(!html.includes('OPENROUTER_API_KEY='), 'index.html must not contain secret assignment examples');
});
