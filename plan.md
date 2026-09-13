# books-selection plan

## Status

Статус: кандидат `v0.3.12` добавляет живой прогресс подготовки embeddings, отдельное ожидание provider, прошедшее время и щадящие отменяемые паузы между пакетами для больших корпусов. Уменьшение remaining после локальной переиндексации продолжает первоначально подтверждённый запуск без второго клика; увеличение требует нового согласия. Экранный диктор получает обновления с шагом 5%, устаревшие ответы polling игнорируются, завершённые server operation records автоматически очищаются. Проверено `187/187` тестами, browser/API и Electron smoke; защищённый `AGENTS.md` не изменён. Hermes provider transport Денис реализует отдельно; до появления транспорта Hermes остаётся внутренним scaffold и не показывается как рабочий выбор в UI.

Основной annotation-browser выполнен. Стратегическое направление: превратить Books Selection в локальный AI/semantic search tool по FB2-библиотеке с SQLite, FTS5, embeddings, графом фактов и несколькими AI provider modes.

## Active audit remediation

## Visible embedding progress and one-click consent continuity

- `outcome`: во время долгой подготовки пользователь видит живой прогресс, прошедшее время и ожидание текущего provider-пакета; первое нажатие не требует повторного согласия, если после локальной индексации объём не вырос; крупные запуски автоматически делают короткие паузы и отдают управление UI, чтобы desktop-приложение не подвисало.
- `verification`: API сообщает активное состояние и пакетный прогресс без повторного сканирования SQLite; UI опрашивает его во время операции, показывает доступный progress/status и сохраняет отмену; увеличение объёма по-прежнему требует нового согласия; indexer pacing не меняет число отправленных фрагментов и отключён для малых запусков.
- `constraints`: не отправлять больше подтверждённого верхнего лимита; не ослаблять provider/destination checks; не обращаться к реальному OpenRouter; не менять пользовательскую SQLite/config.
- `boundaries`: `src/embeddingIndexer.js`, `src/server.js`, `public/index.html`, focused tests and plan; релиз и version bump отдельно только по явному запросу.
- `stop_when`: исправление потребует фонового persistent job, возобновления после перезапуска приложения или изменения provider API.

## One-click complete embedding preparation

- `outcome`: одно подтверждение и одно нажатие подготавливают embeddings для всех оставшихся фрагментов; повторные пакеты по 1000 и повторные подтверждения не требуются.
- `verification`: indexer обрабатывает весь remaining corpus внутренними provider-batches, UI отправляет `allRemaining`, показывает понятный полный объём и сохраняет отмену/возобновление.
- `constraints`: OpenRouter всё ещё требует явного согласия; provider requests остаются bounded batch-ами; успешные batches сохраняются, поэтому повтор после отмены/ошибки продолжает с остатка.
- `boundaries`: embedding indexer/API/UI, focused tests, version/release artifacts; не менять модели, стоимость provider или пользовательский corpus.
- `stop_when`: provider запрещает batch/объём либо публикация требует замены существующего релиза.

## Release v0.3.11

- `outcome`: опубликовать one-click complete embedding preparation с четырьмя стабильными desktop-артефактами и прямой Windows-ссылкой.
- `verification`: полная desktop-сборка, Electron smoke, проверка архивов и SHA-256, read-back GitHub Release и HTTP range-проверка каждого файла.
- `constraints`: не обращаться к реальному provider при тестировании и не изменять пользовательскую SQLite/config; не заменять артефакты прошлых релизов.

## Cycle-only annotation browser regression

- `outcome`: главная страница показывает одну карточку на цикл: название папки цикла и аннотацию первого файла по natural sort, без названия и имени отдельной книги.
- `verification`: два цикла отображаются двумя карточками, три книги индексируются тремя записями; UI не выводит book title/file; RU/EN подписи описывают циклы.
- `constraints`: все `.fb2`/`.fb2.zip` внутри цикла остаются в полном SQLite/FTS/embedding индексе и доступны Ask-поиску.
- `boundaries`: `src/scan.js`, вызов индексатора, annotation UI, focused tests, package version, release artifacts.
- `stop_when`: выбор аннотации цикла требует новой продуктовой логики вместо исторического правила «первый файл по natural sort».

## Release v0.3.10

- `outcome`: опубликовать исправление cycle-only главной страницы с теми же четырьмя desktop-артефактами и прямой Windows-ссылкой.
- `verification`: полная desktop-сборка, проверка архивов и SHA-256, read-back GitHub Release и HTTP range-проверка каждого опубликованного файла.
- `constraints`: не менять AI/index contracts и пользовательские данные; не заменять уже опубликованные артефакты `v0.3.9`.

## Release v0.3.9

- `outcome`: опубликовать проверенный `main` как GitHub Release `v0.3.9` и дать прямую ссылку для скачивания Windows-версии.
- `verification`: повторный `npm test`, полная desktop-сборка, проверка архивов и SHA-256, затем read-back релиза и HTTP-проверка опубликованных файлов.
- `constraints`: без реальных AI-provider вызовов; без изменений пользовательских библиотек, конфигурации и SQLite; без заявлений о подписи или notarization.
- `boundaries`: `plan.md`, release commit/tag и сгенерированные `dist-desktop/` артефакты; код исправлений не меняется.
- `stop_when`: тесты или сборка не проходят, тег/релиз `v0.3.9` уже существует либо загрузка любого обязательного артефакта не подтверждается.

## Published release v0.3.6

- `outcome`: publish current verified `main` as GitHub Release `v0.3.6` with stable Linux, Windows portable EXE/ZIP, and macOS ZIP assets.
- `verification`: full tests, Electron smoke, `npm run build:desktop`, archive listing, SHA-256 checksums, GitHub asset read-back, and HTTP range checks for published downloads.
- `constraints`: no real provider calls, no user data/config/database changes, no signing/notarization claims, and no modification of release contents after verification except replacing a failed upload before publication.
- `boundaries`: package version/lockfile, `plan.md`, generated ignored `dist-desktop/`, Git tag, and GitHub Release only.
- `stop_when`: build cannot produce a required platform asset, tests fail, GitHub authentication fails, or publishing would overwrite an existing `v0.3.6` tag/release.

## Windows OpenRouter network fix

- `outcome`: Electron provider calls use Chromium networking; failures identify their stage and write a sanitized local log.
- `release`: publish the verified fix as `v0.3.7` with the same four stable cross-platform asset names.
- `verification`: TDD, full tests, Electron smoke, release build, artifact checks, and published-download checks.
- `constraints`: never log keys, authorization headers, prompts, excerpts, paths to books, or response bodies.
- `boundaries`: server fetch injection, Electron main process, diagnostics, tests, package version, and release artifacts.

### Scope and non-goals

- Защитить loopback API от cross-origin/DNS-rebinding запросов, не возвращать сохранённые ключи и валидировать provider configuration.
- Исправить удаление устаревших книг, фактов и embeddings; сохранить совместимость существующих SQLite баз.
- Проверять model-generated evidence и не сохранять неподтверждённые ссылки.
- Исправить нулевой бюджет, конкурентные Ask-запросы, `bookId`, chunk/ZIP limits, permissions и prompt-injection boundary.
- Исправить RU/EN UI, доступные статусы, folder picker, uncertainty, Electron navigation/lifecycle и release metadata.
- Обновить уязвимые build dependencies в пределах совместимых major versions, если lockfile позволяет устранить audit findings без смены архитектуры.
- Не реализовывать Hermes adapter в этой задаче, не публиковать release и не обращаться к реальным AI providers.

### Files and boundaries

- In scope: `src/`, `desktop/`, `public/index.html`, focused tests, package metadata/lockfile, `.gitignore`, `README.md`, `AGENTS.md`, `plan.md`.
- Out of scope: user libraries/config/databases, live API keys, GitHub release publication, Hermes transport implementation, production deployment.

### Functional slices

1. Loopback API and provider configuration security with API-level regression tests.
2. SQLite/index/fact/embedding consistency with migration-safe database tests.
3. FB2 chunking and bounded ZIP parsing tests/fixes.
4. AI evidence validation, budget correctness and request deduplication tests/fixes.
5. UI localization/accessibility/folder/uncertainty behavior.
6. Electron navigation/lifecycle hardening and release/dependency hygiene.
7. Full integration, browser/Electron smoke, security review and documentation alignment.

### Verification

- RED/GREEN focused tests for every behavior change.
- `npm test` and `git diff --check`.
- `npm audit --json` with remaining findings classified.
- Real loopback API smoke using temporary config/library/database only.
- Electron smoke under Xvfb with temporary config/database.
- Browser-visible flow and console check where practical without real provider calls.

### Completion contract

- `outcome`: all audit findings are fixed or explicitly proven non-actionable; existing annotation, indexing, Ask fallback and desktop startup remain working.
- `verification`: focused regression tests plus full suite, syntax, API and Electron/browser smoke evidence.
- `constraints`: no real provider calls, no user data/config mutation, no Hermes adapter, no release publication, no widening beyond audited defects.
- `boundaries`: only this repository and temporary test data may change; external accounts/services remain untouched.
- `stop_when`: a fix requires real credentials, live spending, release publication, incompatible dependency major upgrade, or a product decision that changes the Hermes adapter contract.

## Product Goal

Пользователь должен уметь не только читать аннотации, но и задавать смысловые вопросы по книгам и циклам, например:

- найти цикл с парой, которая любит друг друга, действует вместе и оба живы в финале;
- найти книги по атмосфере, типу героя, развитию персонажа, жанровым условиям;
- получить ответ с объяснением, уверенностью и доказательными фрагментами.

## Existing Delivered Baseline

- Локальный Node.js tool без внешних npm-зависимостей.
- Сканирование корневой папки с подпапками книг.
- Поиск первого `.fb2` или `.fb2.zip` в каждой подпапке.
- Извлечение `book-title` и `annotation` из FB2.
- Чтение `.fb2.zip` через встроенный ZIP parser на Node.js, без `python3`.
- Локальный HTTP server с `GET /api/books`.
- Простой доступный web UI с поиском, reload, выбором языка RU/EN и fallback на ручной ввод пути.
- Базовые тесты на FB2 parsing и scan behavior.

- SQLite schema, indexer and FTS endpoints delivered in commit `73ec214`.
- Current TDD increment delivered Ask MVP over local FTS evidence: evidence-only prompt construction, no-key fallback status, mockable OpenAI-compatible provider client scaffold, and `POST /api/ask`.
- Embeddings cache / semantic scaffold increment delivered: durable `chunk_embeddings` table, embedding model config defaults, mockable OpenAI-compatible `/embeddings` client, local cosine ranking over cached vectors, no-key semantic setup fallback, and `POST /api/semantic-search` status endpoint.
- Chunk embedding indexing increment delivered: `src/embeddingIndexer.js` selects chunks missing the current embeddings provider/model/content hash, returns `needs_embedding_provider_key` without network when the key is absent, writes mocked-provider vectors into `chunk_embeddings`, supports changed chunk re-embedding and bounded `limit`/`batchSize` runs, and exposes `POST /api/embed-index?db=...&limit=...&batchSize=...`.
- Generic fact graph helper increment delivered: `src/facts.js` storage helpers for book-scoped entities, chunk-linked evidence, evidence-linked relations/events, derived fact upsert/query by book/cycle/type, plus an evidence-only fact-extraction prompt scaffold.
- Generic model-backed fact extraction increment delivered: `src/factExtractor.js` builds generic prompts from supplied excerpts/snippets, returns `needs_provider_key` without network when no key is configured, uses injectable/mockable provider clients, upserts arbitrary `factKey`/`factType` results into `derived_facts`, and exposes a small `POST /api/extract-fact` setup/cache endpoint.
- Minimal accessible UI controls increment delivered: `public/index.html` now exposes separate browser-persisted SQLite DB path input, a single prepare-index button that builds/updates SQLite FTS and attempts semantic cache setup, a multi-line question field, a single Find answer action, provider/setup live status, and list-based results/evidence rendering without a frontend framework.
- Hybrid Ask retrieval increment delivered: `src/retrieval.js` combines local FTS snippets, optional cached semantic-vector hits, and cached derived facts with `fts`/`semantic`/`fact` source labels, dedupe/caps, graceful no-key semantic fallback, and evidence rows compatible with `answerLibraryQuestion`.
- OpenRouter budget guard delivered: provider calls check OpenRouter `/credits` before chat and embeddings requests, default to a `$1` process-session spend cap, support `BOOKS_SELECTION_OPENROUTER_MAX_SESSION_USAGE_USD` and optional baseline env override, and block the provider request when the cap is reached.
- Settings/config UI increment delivered: `src/appConfig.js` manages `~/.books-selection/config.json` (or `BOOKS_SELECTION_CONFIG_PATH`), supports direct local API keys, defaults SQLite to project-local `data/books-selection.sqlite`, `GET/POST /api/config` read/write normalized settings, first launch opens Settings when `booksRoot`/`dbPath` are missing, the main page hides path inputs and uses saved root/db by default, and the index/ask/embedding APIs use saved provider overrides. Local config and generated SQLite DB files are gitignored.
- Electron desktop increment delivered: `npm start` still starts `src/server.js` and opens the normal browser, while packaged desktop builds start the same backend inside Electron main process with no backend child process and load the UI in `BrowserWindow`. Desktop exposes a narrow preload API (`booksSelectionDesktop.pickDirectory()`) for native folder selection; browser mode keeps the existing fallback behavior. `electron-builder` creates Linux tar.gz, Windows portable exe + folder zip, and macOS zip assets with stable `releases/latest/download/...` names.

## Current Architecture

- `src/fb2.js`: parsing FB2/XML, decoding encoding, чтение `.fb2.zip`.
- `src/scan.js`: обход каталога, natural sort, формирование записей со `status`, `reason`, `hasAnnotation`.
- `src/server.js`: локальный HTTP server и раздача `public/index.html`.
- `public/index.html`: single-file UI без framework.
- `tests/fb2.test.js`: тесты парсинга FB2 и zip.
- `tests/scan.test.js`: тесты scanning logic и edge cases.

## New Scope: AI Library Search

### Stage 1 — SQLite library index foundation

Implement a durable local SQLite database for extracted library data.

Expected behavior:

- Store cycles/folders, books, file path, file size, mtime, content hash, title, annotation and indexing status.
- Extract full text from `.fb2` / `.fb2.zip` without sending it to any model.
- Split text into stable chunks, preferably chapter-aware when possible and fixed-size fallback when chapter detection is weak.
- Add SQLite FTS5 over chunks for cheap local text search.
- Re-index only changed files by hash/mtime.
- Keep the annotation UI working.

### Stage 2 — Semantic search / embeddings

Status: cache/schema/search scaffold and bounded chunk embedding cache population are implemented. Semantic search can rank cached vectors; `/api/embed-index` fills missing cache rows when an embeddings provider key is configured and returns setup status without network otherwise.

Add vector/semantic search over chunks.

Provider requirements:

- Default embeddings provider should be configurable.
- Prefer a local/default cheap path where possible.
- Do not require OpenRouter for plain annotation browsing or FTS search.
- Cache embeddings by chunk hash.

Implementation options:

- SQLite stores embeddings as JSON/BLOB initially.
- If native sqlite vector extension is unavailable, implement a small cosine-similarity search in Node over cached vectors as MVP.
- Later upgrade path can use sqlite-vec/sqlite-vss, but not as a hard MVP dependency unless it is proven portable.

### Stage 3 — Ask mode over retrieved evidence

Add `Ask library` / `Ask cycles` mode.

Expected pipeline:

1. Parse the user's question into retrieval hints where possible.
2. Use FTS5 + vector search + existing extracted metadata to collect candidate chunks.
3. Group candidates by book and cycle.
4. Send only relevant snippets/evidence to the answer model.
5. Return answer with:
   - matching cycles/books;
   - why they match;
   - confidence;
   - checked books/chunks;
   - evidence excerpts;
   - uncertainty / “needs more indexing” notes.

### Stage 4 — Fact graph inside SQLite

Add gradually enriched fact extraction, not fixed “love cards”.

Graph model should be generic:

- `entities`: characters, places, organizations, races/species, artifacts, concepts.
- `relations`: loves, allies_with, enemy_of, travels_with, saves, kills, related_to, teaches, betrays, etc.
- `events`: death, resurrection, marriage, separation, final_state, major battle, journey, transformation.
- `evidence`: links every extracted fact to book/chapter/chunk text.
- `derived_facts`: user-question-specific traits, e.g. `acts_together_through_main_plot`, cached with confidence and evidence.

Important: do not prebuild only romance-specific cards. Romance is one query type; the graph must support arbitrary future questions.

### Stage 5 — On-demand enrichment and cache

When the database lacks facts for a new question:

- retrieve relevant chunks;
- ask the configured model to extract the missing trait/fact type;
- save extracted facts and evidence to SQLite;
- use saved facts in future answers;
- allow re-analysis if model/provider/settings change.

### Stage 6 — Provider configuration

Add config-backed AI provider support.

Default:

- OpenRouter with a normal but cheap model, configured in app config, not hardcoded in random call sites.
- The concrete default model should be easy to change in a config file or UI field.
- API keys must come from environment variables or user-local config ignored by git; never commit secrets.

Also support:

- local model provider, e.g. Ollama / llama.cpp-compatible OpenAI API / LM Studio;
- Hermes Desktop / Hermes Agent integration mode if Denis later installs Hermes locally.

Provider abstraction should cover at least:

- answer/chat completion;
- optional structured fact extraction;
- embeddings, if provider supports it.

Hermes integration assumption:

- Do not depend on Hermes being installed for normal app startup.
- If Hermes is available, provide a provider mode that can call Hermes through a local CLI/API/MCP-compatible adapter, with config fields documented.
- Keep Hermes mode optional and failure-tolerant: show clear setup/check messages rather than breaking local search.

### Stage 7 — Accessible UI

Add accessible controls:

- build/update index;
- show indexing progress;
- choose provider mode: OpenRouter / Local model / Hermes;
- configure model names without exposing stored secrets;
- ask a question;
- show answer, confidence, evidence, and checked books;
- show whether result came from cached facts, retrieved chunks, or new model analysis.

Keep the UI screen-reader friendly: normal buttons, labels, status regions, no visual-only controls.

## Non-goals

- Do not send full library contents to OpenRouter on every question.
- Do not require a cloud account for annotation browsing or local FTS search.
- Do not build a separate heavy frontend framework unless the existing single-file UI becomes unmaintainable.
- Do not promise perfect literary truth. Model answers must carry confidence and evidence.
- Do not implement unattended cloud sync or multi-user backend in this project unless explicitly requested later.

## Completion Contract

### Outcome

Books Selection has a local, incremental semantic search foundation that can evolve into AI plot search without repeatedly paying to re-read the whole library.

### Verification

Required local checks:

- `npm test`
- API smoke for existing `/api/books`
- new tests for DB schema/indexing/chunking/provider config
- no committed secrets or local API keys

Future manual checks once UI is added:

- Start with `BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210`.
- Build index for a small sample library.
- Ask a question and verify answer contains evidence and uncertainty.
- Verify no model call is made for plain annotation scan / FTS-only search.

### Constraints

- Preserve existing `/api/books` contract fields unless plan explicitly updates consumers and tests.
- Keep config-backed provider selection.
- Default to OpenRouter cheap model for AI answering, but support local/Hermes modes.
- Secrets stay out of git.
- Local search/indexing must work without OpenRouter.

### Boundaries

In scope:

- `src/` local Node implementation;
- `public/index.html` accessible UI;
- SQLite database/index files under user-local ignored paths;
- README/AGENTS/plan docs if architecture changes.

Out of scope unless explicitly requested:

- deploying a hosted service;
- uploading user's book texts to a remote database;
- DRM handling;
- piracy/source acquisition features;
- changing Hermes global config.

### Stop When

Ask Denis before:

- adding a paid provider as the only working path;
- storing API keys anywhere other than env/user-local ignored config;
- adding a heavy native dependency that is hard to install on Windows/Linux;
- changing project from local tool to hosted backend.

## Implementation Milestones

1. **RED/GREEN: full text extraction and chunking**
   - tests for FB2 body extraction and stable chunk boundaries;
   - implementation in `src/fb2.js` or dedicated module.

2. **RED/GREEN: SQLite adapter and schema**
   - tests create temp DB;
   - migrations initialize tables for books/chunks/FTS/provider cache/facts;
   - no external secrets.

3. **RED/GREEN: indexing service**
   - scans existing folders;
   - extracts text;
   - writes books/chunks;
   - skips unchanged files.

4. **RED/GREEN: FTS query API**
   - `GET /api/search?q=...` or `POST /api/search`;
   - returns grouped book/cycle hits with snippets.

5. **RED/GREEN: provider config abstraction**
   - config loader with defaults;
   - OpenRouter default model fields;
   - local OpenAI-compatible endpoint fields;
   - Hermes optional mode fields;
   - tests verify config defaults and env-key lookup without printing secrets.

6. **RED/GREEN: answer pipeline MVP**
   - retrieve evidence locally;
   - if AI provider configured, answer from evidence only;
   - if not configured, return candidate evidence with setup guidance.

7. **RED/GREEN: generic graph tables and fact cache**
   - add schema and helpers;
   - store entities/relations/events/derived facts with evidence links;
   - do not overfit to romance.
   - Status: delivered as storage/prompt scaffold plus generic model-backed extraction/cache service; tests use mocked provider clients only and no real network calls.

8. **UI integration**
   - accessible controls for index/search/ask/provider status;
   - preserve existing annotation workflow.
   - Status: minimal accessible controls delivered for local FTS index/search, Ask setup/evidence, and optional semantic embedding setup; graph/fact UI remains intentionally out of scope.

9. **Documentation**
   - README explains indexing, privacy, OpenRouter/local/Hermes provider modes, and costs.
   - AGENTS.md updated with architecture and validation commands.

## Risks And Assumptions

- SQLite package choice matters: Node has no built-in SQLite in current project baseline. Prefer a portable dependency only after confirming install behavior; otherwise use a small CLI bridge to `sqlite3` only if available. This is an implementation decision to verify.
- Local models may be slower and less accurate for Russian fiction; UI should communicate uncertainty.
- Vector search without native extension can be acceptable for MVP-sized libraries but may become slow for huge chunk counts.
- Hermes Desktop integration details may depend on the installed Hermes version; keep adapter optional and documented.

## Validation

- `npm test`
- `git diff --check`
- manual API smoke for old `/api/books`
- new sample-library indexing/search smoke after implementation

## Notes

- UI больше не должен опираться на точные fallback-строки backend, а должен использовать machine-readable поля `status`, `reason`, `hasAnnotation`.
- Архитектура больше не остаётся полностью без БД: AI search требует локального durable index. БД должна быть локальной и переносимой.