# AGENTS.md

## Project Context
- Books Selection is a local-first CommonJS Node.js/Electron app for browsing FB2 series by annotation and asking evidence-grounded questions over a local SQLite index.
- Cycles are the browsing unit: individual books are indexed for search only and are not browsed as separate entries.
- Cycle features shipped in v0.4.0: favorite cycles ranked by Ask results, per-cycle read/unfinished marks, manual Author.Today continuation checks, and an interface language kept in the app config (default `en`, allowed `en`/`ru`).
- Source/developer mode requires Node.js 22+ because search uses built-in `node:sqlite`; packaged Electron desktop builds do not require Node.js, npm, or git on the user's machine.
- Supported user-facing desktop artifacts are Linux x64 tar.gz, Windows x64 portable exe and folder zip, and macOS x64 zip. They are unsigned/not notarized, so SmartScreen or Gatekeeper warnings are expected.
- Primary entrypoints: `src/server.js` for browser/server mode, `desktop/main.js` plus `desktop/preload.js` for Electron, and `public/index.html` for the entire renderer UI.

## Architecture And File Ownership
- `src/server.js`: loopback-only HTTP server bound to `127.0.0.1`. Direct execution opens the system browser; Electron imports `startServer()` and starts the same backend in-process on an ephemeral port without a child process.
- `desktop/main.js`: Electron lifecycle, `BrowserWindow`, desktop SQLite default under Electron `userData`, native folder-dialog IPC, external-link handling, and Linux-verifiable smoke mode.
- `desktop/preload.js`: narrow context-isolated bridge exposing only `booksSelectionDesktop.isDesktop` and `pickDirectory()`; do not expose filesystem, process, shell, or arbitrary IPC access.
- `public/index.html`: intentional single-file, framework-free RU/EN UI containing markup, styles, localization, settings, annotation browser, index/Ask flow, accessible live regions, and update banner.
- `src/scan.js`: scans exactly one level of series folders, natural-sorts files, and selects the first `.fb2` or `.fb2.zip` in each folder. It exports `yieldToEventLoop()` and awaits it between books: one book parse is synchronous CPU work, and without the pause the server cannot answer other requests while scanning.
- `src/fb2.js`: FB2/XML encoding detection, title/annotation/body extraction, stable text chunking, and built-in ZIP reading without Python. Cycle cards must be read through `readBookInfo` (head window `decodeXmlHead`, 512 KiB, used only when the complete `<description>` fits) — never decode or normalize the whole body for the main list. Keep CRC32 on the native `zlib.crc32` path with the JS loop as fallback.
- `src/indexer.js`: transactional local indexing, file fingerprinting, unchanged-file skip, chunk replacement, FTS5 synchronization, and local snippet search. The per-book prepare loop yields to the event loop so indexing does not freeze the UI.
- `src/searchSchema.js`: schema for books, chunks, FTS5, embeddings, entities, evidence, relations, events, derived facts, and the cycle tables `cycle_favorites`, `cycle_query_hits`, `cycle_reading_state`, `cycle_series`.
- `src/searchDb.js`: optional `node:sqlite` adapter, parent-directory creation, schema initialization, and compatibility migration for older `derived_facts` tables missing `fact_type`. It owns `SCHEMA_VERSION` (currently 5) and `KNOWN_TABLES`: a new table must be added to both, otherwise an existing database is refused with "not a Books Selection database" on the next open. Migration writes a `<db>.backup-<timestamp>` copy before touching anything.
- `src/appConfig.js` also stores `language`; the value is injected into the served page as `window.__booksSelectionLanguage` and `<html lang>`, so the UI does not flash the wrong language and screen readers get the right one.
- `src/embeddings.js`: embedding cache storage, query embedding, local cosine ranking, and graceful no-key semantic-search result.
- `src/embeddingIndexer.js`: bounded population of embeddings missing for the current provider/model/content hash.
- `src/retrieval.js`: hybrid evidence retrieval combining FTS, optional cached semantic hits, and cached facts with `fts`/`semantic`/`fact` source labels, scoring, dedupe, and caps.
- `src/ask.js`: evidence-only Ask pipeline and deterministic local candidate grouping; it never sends the full library to a model.
- `src/favorites.js`: cycle favorites plus the Ask-only rating (top-5 positions score 5-4-3-2-1 per unique normalized query, best position kept) and explicit `sort_position` ordering.
- `src/readingState.js`: two independent per-cycle marks, `is_read` and `is_unfinished`. The cycle key is the folder/cycle name, so marks survive reindexing.
- `src/authorToday.js`: strict public series-page reader — host `author.today`/`www.author.today` only, path `/work/series/<digits>`, port 443, HTML content type, 2 MiB cap, single fetch per call, and one overall 15 s timeout that must stay armed through the body read.
- `src/seriesWatch.js`: cycle↔series bindings, stored snapshot, and check result. A snapshot must never shrink on an incomplete page (compare and store the union of book ids) and reports `partial` instead of treating vanished books as new.
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
- Every `/api/*` request is loopback-only and requires the per-session cookie token (`403` otherwise); `POST` bodies must be `application/json` and are limited to 1 MiB. Documented methods below are the methods the handler actually accepts — keep them exact.
- `GET/POST /api/config`: read/write normalized local settings, including `language`.
- `POST /api/language`: persist the interface language (`en`/`ru` only).
- `GET /api/books`: scan annotations without SQLite, provider keys, or AI/network calls.
- `POST /api/index`: scan, parse, fingerprint, chunk, and index changed books into SQLite/FTS.
- `GET /api/search`: local FTS search.
- `GET /api/embedding-status`, `GET /api/embedding-progress`: embedding cache totals and live progress of the current embedding operation.
- `POST /api/embed-index`: bounded embedding cache population; accepts optional `limit` (or `allRemaining`) and `batchSize`.
- `POST /api/semantic-search`: local ranking over cached vectors after creating a query embedding.
- `POST /api/ask`: hybrid retrieval followed by optional evidence-only answer generation; the response carries `cycleGroups` (one block per cycle with its books inside).
- `GET /api/favorites`: favorite cycles with rating, hit history, and manual order.
- `POST /api/cycle-favorite`: add or remove a cycle favorite. The Ask handler records top-5 hits through the same module.
- `POST /api/favorites/reorder`: move a favorite one position up/down, or rebuild the order by rating.
- `POST /api/favorites/clear-history`: clear the Ask hit history for one cycle or for all of them.
- `GET /api/reading`, `POST /api/cycle-reading`: list cycle marks / set `isRead` and `isUnfinished` for a cycle.
- `GET /api/cycle-series`, `POST /api/cycle-series`: list bindings / bind a cycle to an Author.Today series page or unbind it (`{bound: false}`).
- `POST /api/cycle-series/check`: one manual network request for one bound cycle. The UI may run these sequentially from the bulk control (one request per cycle, about 1 s apart, stoppable); never called automatically, in the background, or on a schedule.
- `POST /api/extract-fact`: requires `q`, numeric `bookId`, and `factKey`; `factType` defaults to `generic`.
- `GET /api/update-check`: checks the public GitHub latest-release endpoint and returns current/latest version plus preferred and fallback assets.
- Root and DB resolution order is explicit query parameter, saved app config, then applicable runtime default. `q` and endpoint-specific identifiers remain required.
- Missing answer or embedding credentials must return `needs_provider_key` / `needs_embedding_provider_key` with setup metadata and no provider request.
- Plain annotation browsing, SQLite indexing, FTS, cached-vector ranking, and fact storage remain local. Only configured embeddings/chat/fact extraction, the public update check, and an explicit Author.Today check use the network.
- Author.Today checks are user-triggered only: exactly one request per click, only to `author.today`, and a failed check must leave the stored snapshot untouched.
- OpenRouter calls must pass the credits/budget guard before both chat and embeddings. Tests must mock every provider and GitHub call.
- Hermes appears in provider configuration and Settings as an optional scaffold, but no Hermes CLI/API transport is implemented yet. Do not claim it works until a dedicated adapter and tests exist.

## UI And Accessibility Invariants
- The main page uses saved books-root and DB settings; do not reintroduce visible technical path inputs there. First-run configuration belongs in Settings.
- The renderer has four views (main, favorites, reading, settings) switched in place; keep `aria-current` on the active nav control and one live region per panel for status text.
- Cycle results are one block per cycle with its books inside `<details>/<summary>` (collapsed by default), so repeated cycles never appear as separate rows.
- Lists repeat identical controls per cycle ("Move up 1", "Mark as read", "Add to favorites"): every repeated control must carry the cycle name in its accessible name, otherwise a screen-reader user hears the same label many times without context.
- A cycle bound to Author.Today must stay reachable in the reading view even when both marks are cleared, so its binding can always be checked or removed.
- The unfinished-cycles section carries one bulk control (`readingCheckAllButton`) with a visible count of checkable cycles plus a hint when some unfinished cycles have no binding, a progress announcement in the existing status region, and a stop control that stays hidden except during a run. Keep single-cycle controls working alongside it.
- UI language comes from the server-injected `window.__booksSelectionLanguage` (config-backed, `<html lang>` set at render). Do not move it back to `localStorage`: the desktop app serves the page on a new port at every launch, so browser storage does not survive.
- Keep native HTML labels, buttons, links, lists, headings, and `role="status"`/`aria-live` regions; avoid custom widgets and tables for Ask evidence/results.
- Keep RU and EN text maps synchronized when adding visible copy or controls.
- The intended question flow has one prepare action (FTS index plus bounded semantic-cache attempt), one multiline question field, and one answer action.
- UI filtering depends on machine-readable `status`, `reason`, and `hasAnnotation`; do not couple it to exact backend fallback prose.
- Desktop renderer security is load-bearing: preserve `nodeIntegration: false`, `contextIsolation: true`, the narrow preload API, and external URL routing through `shell.openExternal`.
- Startup update checks must be silent and non-blocking on failure. A newer release shows OS-specific download links and a release-page fallback; the app does not auto-install, unpack, delete, or replace itself. “Skip this version” is localStorage state.

## Config, Writable Data, And Secrets
- Default config: `~/.books-selection/config.json`; override with `BOOKS_SELECTION_CONFIG_PATH`.
- `config.json` also stores the interface `language` (default `en`); it is the source of truth for the UI language across launches.
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
- Focused ownership: parser/ZIP changes → `tests/fb2.test.js`; schema/migrations → `tests/searchSchema.test.js` and `tests/searchDb.test.js`; indexing → `tests/indexer.test.js`; provider/config/budget → corresponding provider/app-config tests; Ask grouping → `tests/ask.test.js`; cycle favorites → `tests/favorites.test.js`; cycle marks → `tests/readingState.test.js`; Author.Today parsing/network → `tests/authorToday.test.js`; bindings and snapshots → `tests/seriesWatch.test.js`; API changes → server/update API tests; UI changes → `tests/uiStatic.test.js`; Electron/build changes → `tests/desktopStatic.test.js` and `tests/packageMetadata.test.js`.

## Change Coupling And Release Rules
- API response changes require updating every UI consumer and focused API test in the same change.
- Config/provider field changes require synchronized updates to `src/appConfig.js`, `src/providerConfig.js`, Settings controls, both translation maps, and focused tests.
- SQLite table/column changes require schema SQL, compatibility migration logic, and temp-database tests; preserve existing user databases.
- FB2/ZIP parser changes require realistic plain-FB2 and zipped-FB2 fixtures/tests, including encoding behavior where relevant.
- Keep dependencies minimal and upper-bounded. Do not add a frontend framework, native SQLite/vector extension, or heavy runtime dependency without an explicit portability justification.
- Electron release filenames are a public contract. If version, targets, architectures, repository identity, or filenames change, update `package.json`, `package-lock.json`, `src/updateChecker.js`, `README.md`, `GITHUB.md` where relevant, package/update tests, and GitHub release assets together.
- Current stable desktop asset names are `books-selection-desktop-linux-x64.tar.gz`, `books-selection-desktop-win-x64.exe`, `books-selection-desktop-win-x64.zip`, and `books-selection-desktop-mac-x64.zip`; `releases/latest/download/...` links depend on them.
- Public releases must be built from the matching package version, tested before upload, and verified by reading back the GitHub release asset list and checking each latest-download URL. Do not call a local build a published release.
- Release order: bump `package.json`/`package-lock.json`, commit, and push the version commit BEFORE `gh release create ... --target <sha>`; an unpublished target fails with `422 Release.target_commitish is invalid`.
- Cycle state tables (`cycle_favorites`, `cycle_query_hits`, `cycle_reading_state`, `cycle_series`) are keyed by the folder/cycle name; changing that key is a migration, never a silent recompute of user marks.
- User-visible cycle behavior must keep `plan.md` status, `README.md`, and this file aligned in the same change, not in a follow-up.

## Documentation Maintenance
- Treat this file as durable project memory: update it in the change that adds or alters a module, endpoint, invariant, or release rule. Denis approved one-time standing permission to keep it in sync without asking for a separate confirmation on every edit (2026-09-17).
