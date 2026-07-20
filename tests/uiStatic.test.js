const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('index page exposes simplified accessible AI question flow without committed secrets', () => {
  const requiredMarkers = [
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
    'id="updateBanner"',
    'id="updateBannerLinks"',
    '/api/update-check',
    'updateAvailableTitle',
    'books-selection:skipped-update-version',
    'ai-processing-status',
    'renderAiProcessingStatus(result)',
    'renderAiProcessingError(error.message)',
    'renderCandidates(candidates)',
    'Найденные варианты',
    'Доказательных фрагментов:',
    'Found candidates',
    'Evidence snippets:',
    'Удалось обработать через ИИ: да',
    'Удалось обработать через ИИ: нет',
    'Processed through AI: yes',
    'Processed through AI: no',
    '<ul',
    '/api/index',
    '/api/embed-index',
    '/api/ask',
    'needs_provider_key',
    'needs_embedding_provider_key',
    '/api/config',
    'id="settingsPanel"',
    'id="saveSettingsButton"',
    'id="settingsActiveProvider"',
    'id="settingsOpenrouterApiKey"',
    'type="password"',
    'id="settingsOpenrouterBudget"',
    'id="settingsPickBooksRootButton"',
    'booksSelectionDesktop',
    'pickDirectory',
    'id="openrouterSettings"',
    'id="localProviderSettings"',
    'loadAppConfig()'
  ];

  for (const marker of requiredMarkers) {
    assert.ok(html.includes(marker), `missing UI marker: ${marker}`);
  }

  assert.ok(!html.includes('id="localSearchButton"'), 'question flow should not expose a separate local FTS search button');
  assert.ok(!html.includes('id="embedIndexButton"'), 'question flow should not expose a separate semantic setup button');
  assert.ok(!html.includes('settingsOpenrouterApiKeyEnv'), 'settings should collect API key directly instead of asking for env variable names');
  assert.ok(!html.includes('settingsLocalApiKeyEnv'), 'local settings should collect API key directly instead of asking for env variable names');
  assert.ok(!html.includes('Локальный FTS поиск'), 'RU UI should not ask users to choose a separate FTS action');
  assert.ok(!html.includes('Optional: prepare semantic embeddings'), 'EN UI should not expose semantic setup as a separate button');
  assert.ok(!html.includes('sk-'), 'index.html must not contain API-key looking values');
  assert.ok(!html.includes('OPENROUTER_API_KEY='), 'index.html must not contain secret assignment examples');
});
