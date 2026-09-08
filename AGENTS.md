# AGENTS.md

## Project Context
- Books Selection is a local-first CommonJS Node.js/Electron app for browsing FB2 series by annotation and asking evidence-grounded questions over a local SQLite index.
- Source/developer mode requires Node.js 22+ because search uses built-in `node:sqlite`; packaged Electron desktop builds do not require Node.js, npm, or git on the user's machine.
- Supported user-facing desktop artifacts are Linux x64 tar.gz, Windows x64 portable exe and folder zip, and macOS x64 zip. They are unsigned/not notarized, so SmartScreen or Gatekeeper warnings are expected.
- Primary entrypoints: `src/server.js` for browser/server mode, `desktop/main.js` plus `desktop/preload.js` for Electron, and `public/index.html` for the entire renderer UI.

## Architecture And File Ownership
- `src/server.js`: loopback-only HTTP server bound to `127.0.0.1`. Direct execution opens the system browser; Electron imports `startServer()` and starts the same backend in-process on an ephemeral port without a child process.
- `desktop/main.js`: Electron lifecycle, `BrowserWindow`, desktop SQLite default under Electron `userData`, native folder-dialog IPC, external-link handling, and Linux-verifiable smoke mode.
- `desktop/preload.js`: narrow context-isolated bridge exposing only `booksSelectionDesktop.isDesktop` and `pickDirectory()`; do not expose filesystem, process, shell, or arbitrary IPC access.
- `public/index.html`: intentional single-file, framework-free RU/EN UI containing markup, styles, localization, settings, annotation browser, index/Ask flow, accessible live regions, and update banner.
- `src/scan.js`: scans exactly one level of series folders, natural-sorts files, and selects the first `.fb2` or `.fb2.zip` in each folder.
- `src/fb2.js`: FB2/XML encoding detection, title/annotation/body extraction, stable text chunking, and built-in ZIP reading without Python.
- `src/indexer.js`: transactional local indexing, file fingerprinting, unchanged-file skip, chunk replacement, FTS5 synchronization, and local snippet search.
- `src/searchSchema.js`: schema for books, chunks, FTS5, embeddings, entities, evidence, relations, events, and derived facts.
- `src/searchDb.js`: optional `node:sqlite` adapter, parent-directory creation, schema initialization, and compatibility migration for older `derived_facts` tables missing `fact_type`.
- `src/embeddings.js`: embedding cache storage, query embedding, local cosine ranking, and graceful no-key semantic-search result.
- `src/embeddingIndexer.js`: bounded population of embeddings missing for the current provider/model/content hash.
- `src/retrieval.js`: hybrid evidence retrieval combining FTS, optional cached semantic hits, and cached facts with `fts`/`semantic`/`fact` source labels, scoring, dedupe, and caps.
- `src/ask.js`: evidence-only Ask pipeline and deterministic local candidate grouping; it never sends the full library to a model.
- `src/facts.js`: generic evidence-linked entity/relation/event/derived-fact storage and prompt helpers. Keep this generic; do not hardcode romance-specific schemas.
- `src/factExtractor.js`: generic model-backed fact extraction from supplied evidence and cache upsert by arbitrary `factKey`/`factType`.
- `src/appConfig.js`: normalization and persistence of user-local settings, including saved paths, providers, models, budget, and explicitly entered API keys.
- `src/providerConfig.js`: defaults and resolution for OpenRouter, local OpenAI-compatible, and Hermes modes; an explicitly saved key takes precedence over its env reference.
- `src/providerClient.js`: injectable OpenAI-compatible chat/embedding transport; budget check happens before provider requests.
- `src/providerBudget.js`: OpenRouter `/credits` guard with a process-session baseline and a default maximum additional spend of `$1`.
- `src/updateChecker.js`: GitHub Releases lookup, version comparison, and platform-specific asset selection for the update notification.
- `src/constants.js`: machine-readable scan statuses/reasons and backend fallback strings.
- `scripts/build-dist.js`: legacy `@yao-pkg/pkg` server-only bundles that open the browser; these are not the preferred desktop releases.
- `plan.md`: historical/product implementation plan. Keep active status and architecture claims aligned when behavior materially changes; do not add transient task logs or commit IDs.

## HTTP API And Data Flow
- `GET/POST /api/config`: read/write normalized local settings. JSON request bodies are limited to 1 MiB.
- `GET /api/books`: scan annotations without SQLite, provider keys, or AI/network calls.
- `POST /api/index`: scan, parse, fingerprint, chunk, and index changed books into SQLite/FTS.
- `GET /api/search`: local FTS search.
- `POST /api/embed-index`: bounded embedding cache population; accepts optional `limit` and `batchSize`.
- `GET /api/semantic-search`: local ranking over cached vectors after creating a query embedding.
- `GET /api/ask`: hybrid retrieval followed by optional evidence-only answer generation.
- `GET /api/extract-fact`: requires `q`, numeric `bookId`, and `factKey`; `factType` defaults to `generic`.
- `GET /api/update-check`: checks the public GitHub latest-release endpoint and returns current/latest version plus preferred and fallback assets.
- Root and DB resolution order is explicit query parameter, saved app config, then applicable runtime default. `q` and endpoint-specific identifiers remain required.
- Missing answer or embedding credentials must return `needs_provider_key` / `needs_embedding_provider_key` with setup metadata and no provider request.
- Plain annotation browsing, SQLite indexing, FTS, cached-vector ranking, and fact storage remain local. Only configured embeddings/chat/fact extraction and the public update check use the network.
- OpenRouter calls must pass the credits/budget guard before both chat and embeddings. Tests must mock every provider and GitHub call.
- Hermes appears in provider configuration and Settings as an optional scaffold, but no Hermes CLI/API transport is implemented yet. Do not claim it works until a dedicated adapter and tests exist.

## UI And Accessibility Invariants
- The main page uses saved books-root and DB settings; do not reintroduce visible technical path inputs there. First-run configuration belongs in Settings.
- Keep native HTML labels, buttons, links, lists, headings, and `role="status"`/`aria-live` regions; avoid custom widgets and tables for Ask evidence/results.
- Keep RU and EN text maps synchronized when adding visible copy or controls.
- The intended question flow has one prepare action (FTS index plus bounded semantic-cache attempt), one multiline question field, and one answer action.
- UI filtering depends on machine-readable `status`, `reason`, and `hasAnnotation`; do not couple it to exact backend fallback prose.
- Desktop renderer security is load-bearing: preserve `nodeIntegration: false`, `contextIsolation: true`, the narrow preload API, and external URL routing through `shell.openExternal`.
- Startup update checks must be silent and non-blocking on failure. A newer release shows OS-specific download links and a release-page fallback; the app does not auto-install, unpack, delete, or replace itself. “Skip this version” is localStorage state.

## Config, Writable Data, And Secrets
- Default config: `~/.books-selection/config.json`; override with `BOOKS_SELECTION_CONFIG_PATH`.
- Source/pkg default DB: runtime-root `data/books-selection.sqlite`; override with `BOOKS_SELECTION_DB_PATH`. Electron sets its default DB under the app's `userData/data/` directory.
- User-local config may contain API keys entered in Settings by explicit product decision. `writeAppConfig()` creates the parent directory with mode `0700` and writes the file with mode `0600` where supported.
- Never commit, print, log, return, fixture, or document real keys. Keep `.books-selection/`, local config variants, generated SQLite files/sidecars, `dist/`, and `dist-desktop/` ignored.
- Relevant env: `PORT`, `BOOKS_SELECTION_NO_OPEN`, `BOOKS_SELECTION_CONFIG_PATH`, `BOOKS_SELECTION_DB_PATH`, `OPENROUTER_API_KEY`, `LOCAL_OPENAI_API_KEY`, `BOOKS_SELECTION_OPENROUTER_MAX_SESSION_USAGE_USD`, and `BOOKS_SELECTION_OPENROUTER_USAGE_BASELINE_USD`.
- Desktop-only env used by runtime/testing: `BOOKS_SELECTION_DESKTOP`, `BOOKS_SELECTION_DESKTOP_SMOKE`; do not treat these as normal end-user configuration.

## Run, Test, And Build
- Install: `npm install`.
- Full test suite: `npm test` (`node --test tests/*.test.js`). Tests use Node's built-in test runner and temporary directories/databases.
- Browser/server mode: `npm start -- /path/to/Books 3210`.
- Browser/server mode without auto-open: `BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210`.
- Desktop development: `npm run desktop:start`.
- Preferred desktop release build: `npm run build:desktop`; output is under `dist-desktop/`.
- Legacy server-only bundle build: `npm run build:dist`; output is under `dist/`.
- Before completion run at least `npm test` and `git diff --check`. For desktop/runtime changes, also execute the real Electron smoke path under a display/Xvfb and verify page title, preload bridge, picker function, `/api/config` HTTP 200, and a non-empty DB path.
- Focused ownership: parser/ZIP changes → `tests/fb2.test.js`; schema/migrations → `tests/searchSchema.test.js` and `tests/searchDb.test.js`; indexing → `tests/indexer.test.js`; provider/config/budget → corresponding provider/app-config tests; API changes → server/update API tests; UI changes → `tests/uiStatic.test.js`; Electron/build changes → `tests/desktopStatic.test.js` and `tests/packageMetadata.test.js`.

## Change Coupling And Release Rules
- API response changes require updating every UI consumer and focused API test in the same change.
- Config/provider field changes require synchronized updates to `src/appConfig.js`, `src/providerConfig.js`, Settings controls, both translation maps, and focused tests.
- SQLite table/column changes require schema SQL, compatibility migration logic, and temp-database tests; preserve existing user databases.
- FB2/ZIP parser changes require realistic plain-FB2 and zipped-FB2 fixtures/tests, including encoding behavior where relevant.
- Keep dependencies minimal and upper-bounded. Do not add a frontend framework, native SQLite/vector extension, or heavy runtime dependency without an explicit portability justification.
- Electron release filenames are a public contract. If version, targets, architectures, repository identity, or filenames change, update `package.json`, `package-lock.json`, `src/updateChecker.js`, `README.md`, `GITHUB.md` where relevant, package/update tests, and GitHub release assets together.
- Current stable desktop asset names are `books-selection-desktop-linux-x64.tar.gz`, `books-selection-desktop-win-x64.exe`, `books-selection-desktop-win-x64.zip`, and `books-selection-desktop-mac-x64.zip`; `releases/latest/download/...` links depend on them.
- Public releases must be built from the matching package version, tested before upload, and verified by reading back the GitHub release asset list and checking each latest-download URL. Do not call a local build a published release.
