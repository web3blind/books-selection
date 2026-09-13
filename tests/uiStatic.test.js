const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('index page exposes simplified accessible AI question flow without committed secrets', () => {
  const requiredMarkers = [
    'id="dbPath"',
    'id="buildIndexButton"',
    'id="ftsQuestion"',
    '<textarea id="ftsQuestion"',
    'for="ftsQuestion"',
    'id="askButton"',
    'id="aiStatus"',
    'aria-live="polite"',
    'id="aiResults"',
    'id="updateBanner"',
    'role="status"',
    'aria-atomic="true"',
    'id="updateBannerLinks"',
    '/api/update-check',
    'updateAvailableTitle',
    'books-selection:skipped-update-version',
    'ai-processing-status',
    'renderAiProcessingStatus(result)',
    'renderAiProcessingError(message)',
    'renderCandidates(candidates)',
    'uncertaintyLabel',
    'result.uncertainty',
    'result.citedEvidence',
    'result.coverage',
    'citedEvidenceHeading',
    'coverageSummary',
    '<details>',
    'setControlBusy(askButton, true)',
    'setControlBusy(askButton, false)',
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
    'id="settingsClearOpenrouterApiKey"',
    'id="settingsClearLocalApiKey"',
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
  assert.ok(!html.includes('id="embedIndexButton"'), 'search preparation should use the single combined button');
  assert.ok(html.includes('id="embeddingConsent"'), 'cloud embedding preparation must still require explicit consent');
  assert.ok(!html.includes('settingsOpenrouterApiKeyEnv'), 'settings should collect API key directly instead of asking for env variable names');
  assert.ok(!html.includes('settingsLocalApiKeyEnv'), 'local settings should collect API key directly instead of asking for env variable names');
  assert.ok(!html.includes('<option value="hermes">'), 'Hermes must not be presented as working until its adapter exists');
  for (const key of [
    'mainViewButtonText', 'settingsViewButtonText', 'settingsTitleText', 'settingsIntroText',
    'settingsBooksRootLabel', 'settingsDbPathLabel', 'settingsActiveProviderLabel',
    'settingsEmbeddingProviderLabel', 'saveSettingsButtonText', 'settingsSaved',
    'uncertaintyLabel', 'citedEvidenceHeading', 'coverageSummary',
  ]) {
    assert.ok(html.includes(`${key}:`), `missing localized UI key: ${key}`);
  }
  assert.ok(!html.includes('Локальный FTS поиск'), 'RU UI should not ask users to choose a separate FTS action');
  assert.ok(!html.includes('Optional: prepare semantic embeddings'), 'EN UI should not expose semantic setup as a separate button');
  assert.ok(!html.includes('sk-'), 'index.html must not contain API-key looking values');
  assert.ok(!html.includes('OPENROUTER_API_KEY='), 'index.html must not contain secret assignment examples');
});

test('UI keeps filesystem paths in saved config instead of browser URL or storage', () => {
  assert.ok(!html.includes('webkitdirectory'));
  assert.ok(!html.includes('id="folderPicker"'));
  assert.ok(!html.includes('guessRootFromFiles'));
  assert.ok(!html.includes("books-selection:last-root"));
  assert.ok(!html.includes("queryParams.get('root')"));
  assert.ok(!html.includes("searchParams.set('root'"));
  assert.ok(html.includes('manualPathRequired'));
});

test('settings exposes an accessible required books-path error and cannot announce false success', () => {
  assert.ok(html.includes('id="settingsBooksRoot"'));
  assert.ok(html.includes('required aria-describedby="settingsBooksRootError"'));
  assert.ok(html.includes('id="settingsBooksRootError"'));
  assert.ok(html.includes("setAttribute('aria-invalid', 'true')"));
  assert.ok(html.includes('settingsFields.booksRoot.focus()'));
  assert.ok(html.includes('if (!data.isConfigured)'));
  assert.ok(html.includes("throw new Error(t('booksRootRequired'))"));
});

test('one preparation button builds local FTS and one consented embedding batch', () => {
  for (const marker of [
    'id="buildIndexButton"',
    'id="embeddingReadiness"',
    'id="embeddingConsent"',
    'id="embeddingConsentDetails"',
    'buildLocalIndex',
    'prepareEmbeddings',
    'embeddingDestination',
    'embeddingChunkCount',
    'embeddingConsentRequired',
  ]) assert.ok(html.includes(marker), `missing embedding consent marker: ${marker}`);
  assert.ok(html.includes('Up to 1000 text snippets'));
  assert.ok(html.includes('До 1000 текстовых фрагментов'));
  assert.equal(html.split("fetchJson('/api/embed-index'").length - 1, 1);
  assert.ok(!html.includes('while (semanticResult.remaining > 0)'));
  assert.ok(!html.includes('storageKey'));
  assert.ok(!html.includes('id="embedIndexButton"'));
  assert.ok(html.includes('prepareSearch'));
  assert.ok(html.includes("openrouter.hasApiKey ? '••••••••' : ''"));
  assert.ok(html.includes('id="settingsOpenrouterApiKeyStatus"'));
  assert.equal(html.split('apiKeySaved:').length - 1, 2);
  assert.ok(html.includes('expectedProvider: savedEmbeddingProvider'));
  assert.ok(html.includes('cloudConsent: embeddingConsent.checked'));
  assert.ok(html.includes('let activeAiOperation = false'));
  assert.ok(html.includes('split into several technical requests'));
});

test('primary controls and results are inside the main landmark', () => {
  const mainStart = html.indexOf('<main id="appMain"');
  const mainEnd = html.indexOf('</main>');
  assert.ok(mainStart >= 0 && mainEnd > mainStart);
  for (const id of ['pickFolderButton', 'loadButton', 'reloadButton', 'search', 'buildIndexButton', 'askButton', 'results']) {
    const position = html.indexOf(`id="${id}"`);
    assert.ok(position > mainStart && position < mainEnd, `${id} must be inside main`);
  }
  assert.ok(html.includes('<section id="results"'));
});

test('operational copy, placeholders, consent, and update authenticity guidance are localized', () => {
  for (const key of [
    'languageLabel', 'settingsBooksRootPlaceholder', 'settingsDbPathPlaceholder',
    'openrouterApiKeyPlaceholder', 'manualPathRequired', 'booksRootRequired',
    'embeddingDestination', 'embeddingChunkCount', 'embeddingConsentRequired',
    'updateAuthenticityGuidance', 'localIndexing', 'localIndexReady',
  ]) {
    const occurrences = html.split(`${key}:`).length - 1;
    assert.equal(occurrences, 2, `${key} must exist in RU and EN`);
  }
  assert.ok(html.includes('checksums'));
  assert.ok(!html.includes('cryptographically signed'));
});
