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
    'renderCycleGroups(cycleGroups)',
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
    'Найдено книг:',
    'Found candidates',
    'Evidence snippets:',
    'Books found:',
    "cycleGroupSummary: (books, snippets) => `Найдено книг: ${books}, фрагментов: ${snippets}`",
    "cycleGroupSummary: (books, snippets) => `Books found: ${books}, snippets: ${snippets}`",
    "<summary>${escapeHtml(book.book || 'Book')} · ${escapeHtml(t('candidateEvidenceCount', count))}</summary>",
    'const books = Array.isArray(group.books) ? group.books : [];',
    'id="favoritesPanel"',
    'id="favoritesViewButton"',
    'id="favoritesRefreshButton"',
    'id="favoritesReorderButton"',
    'id="favoritesClearAllButton"',
    'id="favoritesList"',
    'favoritesViewButtonText',
    'favoriteButtonMarkup(group.cycle)',
    'favoriteButtonMarkup(book.folderName)',
    'aria-pressed',
    'data-favorites-action="up"',
    'data-favorites-action="down"',
    'data-favorites-action="unfavorite"',
    'data-favorites-action="clear"',
    'renderFavorites()',
    'favoritesRating:',
    'favoritesQueriesHeading:',
    '/api/favorites?db=',
    "'/api/cycle-favorite'",
    "'/api/favorites/reorder'",
    "'/api/favorites/clear-history'",
    'Избранное',
    'В избранное',
    'Убрать из избранного',
    'Вверх на 1',
    'Вниз на 1',
    'Сортировать по рейтингу',
    'Рейтинг: ${rating}',
    'Favorites',
    'Add to favorites',
    'Remove from favorites',
    'Move up 1',
    'Move down 1',
    'Sort by rating',
    'id="readingPanel"',
    'id="readingViewButton"',
    'id="readingSearch"',
    'id="hideRead"',
    'readingViewButtonText',
    'data-reading-flag="read"',
    'data-reading-flag="unfinished"',
    'readingButtonsMarkup(book.folderName)',
    'readingButtonsMarkup(group.cycle)',
    'hideReadInput.checked && readingStateFor(book.folderName).isRead',
    'renderReading()',
    '/api/reading?db=',
    "'/api/cycle-reading'",
    'Прочитанное',
    'Отметить прочитанным',
    'Цикл не закончен',
    'Скрывать прочитанные циклы',
    'Незаконченные циклы',
    'Mark as read',
    'Cycle is unfinished',
    'Hide read cycles',
    'Unfinished cycles',
    'id="readingUpdateList"',
    "readingUpdateTitleText: 'Есть продолжение'",
    "readingUpdateTitleText: 'Has a continuation'",
    'class="series-input"',
    'class="series-bind"',
    'class="series-check"',
    'class="series-unbind"',
    'seriesBlockMarkup(state.cycleKey)',
    "'/api/cycle-series'",
    '`/api/cycle-series?db=',
    "'/api/cycle-series/check'",
    'Ссылка на страницу цикла Author.Today',
    'Привязать страницу',
    'Проверить обновления',
    'Author.Today series page link',
    'Check for updates',
    'window.__booksSelectionLanguage',
    "fetchJson('/api/language'",
    "languageSaveError: (message) => `Не удалось сохранить язык",
    'saveLanguagePreference(currentLanguage).catch',
    'id="readingBoundList"',
    "readingBoundTitleText: 'Привязанные циклы Author.Today'",
    'renderReadingBoundList(matches, needle)',
    'readingBoundSection.hidden = orphans.length === 0',
    "['failed', 'partial'].includes(binding.lastCheckStatus)",
    'aria-label="${escapeHtml(`${label}: ${cycleKey}`)}"',
    'withControlBusy(checkButton, t(\'seriesChecking\')',
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

test('one preparation button builds local FTS and one consented complete embedding run', () => {
  for (const marker of [
    'id="buildIndexButton"',
    'id="embeddingReadiness"',
    'id="embeddingProgress"',
    'id="embeddingActivity"',
    'id="embeddingConsent"',
    'id="embeddingConsentDetails"',
    'buildLocalIndex',
    'prepareEmbeddings',
    'embeddingDestination',
    'embeddingChunkCount',
    'embeddingConsentRequired',
    'embeddingProgressRunning',
  ]) assert.ok(html.includes(marker), `missing embedding consent marker: ${marker}`);
  assert.ok(html.includes('All remaining text snippets'));
  assert.ok(html.includes('Все оставшиеся текстовые фрагменты'));
  assert.equal(html.split("fetchJson('/api/embed-index'").length - 1, 1);
  assert.ok(!html.includes('while (semanticResult.remaining > 0)'));
  assert.ok(html.includes('allRemaining: true'));
  assert.ok(html.includes('expectedRemaining'));
  assert.ok(html.includes('embeddingConsentVolumeChanged'));
  assert.ok(html.includes('currentEmbeddingStatus.remaining > consentedRemaining'));
  assert.ok(html.includes('fetchJson(`/api/embedding-progress?db='));
  assert.ok(html.includes('startEmbeddingProgressPolling'));
  assert.ok(html.includes('stopEmbeddingProgressPolling'));
  assert.ok(html.includes('embeddingProgressGeneration'));
  assert.ok(html.includes('generation !== embeddingProgressGeneration'));
  assert.ok(html.includes('lastAnnouncedProgressPercent + 5'));
  assert.ok(html.includes('<p id="embeddingActivity" class="meta" hidden></p>'));
  assert.ok(!html.includes('id="embeddingActivity" class="meta" role="status"'));
  assert.ok(html.includes('setInterval'));
  assert.ok(html.includes('не более указанного количества'));
  assert.ok(html.includes('no more than the displayed number'));
  assert.ok(html.includes('Короткая пауза, чтобы приложение и компьютер оставались отзывчивыми.'));
  assert.ok(html.includes('Brief pause to keep the app and computer responsive.'));
  assert.ok(!html.includes('limit: 999'));
  assert.ok(!html.includes('storageKey'));
  assert.ok(!html.includes('id="embedIndexButton"'));
  assert.ok(html.includes('prepareSearch'));
  assert.ok(html.includes("openrouter.hasApiKey ? '••••••••' : ''"));
  assert.ok(html.includes('id="settingsOpenrouterApiKeyStatus"'));
  assert.equal(html.split('apiKeySaved:').length - 1, 2);
  assert.ok(html.includes('expectedProvider: savedEmbeddingProvider'));
  assert.ok(html.includes('cloudConsent: embeddingConsent.checked'));
  assert.ok(html.includes('let activeAiOperation = false'));
  assert.ok(html.includes('sequential bounded technical batches'));
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

test('annotation browser renders cycles only and does not expose individual book metadata', () => {
  const renderStart = html.indexOf('function renderBooks()');
  const renderEnd = html.indexOf('async function loadBooks()', renderStart);
  const renderSource = html.slice(renderStart, renderEnd);

  assert.ok(renderSource.includes("[book.folderName, book.annotation]"));
  assert.ok(!renderSource.includes("t('titleLabel')"));
  assert.ok(!renderSource.includes("t('fileLabel')"));
  assert.ok(html.includes("searchLabel: 'Поиск по циклу и аннотации'"));
  assert.ok(html.includes("searchLabel: 'Search by cycle and annotation'"));
  assert.ok(html.includes("showReadyOnly: 'Показывать только циклы с аннотацией и без ошибок'"));
  assert.ok(html.includes("showReadyOnly: 'Show only cycles with annotations and without errors'"));
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
