const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('index page exposes simplified accessible AI question flow without committed secrets', () => {
  const requiredMarkers = [
    'for="dbPath"',
    'id="dbPath"',
    'books-selection:last-db',
    'id="buildIndexButton"',
    'id="ftsQuestion"',
    '<textarea id="ftsQuestion"',
    'for="ftsQuestion"',
    'id="askButton"',
    'id="aiStatus"',
    'aria-live="polite"',
    'id="aiResults"',
    '<ul',
    '/api/index',
    '/api/embed-index',
    '/api/ask',
    'needs_provider_key',
    'needs_embedding_provider_key',
    'setControlBusy(buildIndexButton, true)',
    'setControlBusy(buildIndexButton, false)',
  ];

  for (const marker of requiredMarkers) {
    assert.ok(html.includes(marker), `missing UI marker: ${marker}`);
  }

  assert.ok(!html.includes('id="localSearchButton"'), 'question flow should not expose a separate local FTS search button');
  assert.ok(!html.includes('id="embedIndexButton"'), 'question flow should not expose a separate semantic setup button');
  assert.ok(!html.includes('Локальный FTS поиск'), 'RU UI should not ask users to choose a separate FTS action');
  assert.ok(!html.includes('Optional: prepare semantic embeddings'), 'EN UI should not expose semantic setup as a separate button');
  assert.ok(!html.includes('sk-'), 'index.html must not contain API-key looking values');
  assert.ok(!html.includes('OPENROUTER_API_KEY='), 'index.html must not contain secret assignment examples');
});
