# books-selection plan

## Status

Основной annotation-browser выполнен. Новый активный план: превратить Books Selection в локальный AI/semantic search tool по FB2-библиотеке с SQLite, FTS5, embeddings, графом фактов и несколькими AI provider modes.

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
- Current TDD increment delivered Ask MVP over local FTS evidence: evidence-only prompt construction, no-key fallback status, mockable OpenAI-compatible provider client scaffold, and `GET /api/ask?q=...&db=...`.

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

8. **UI integration**
   - accessible controls for index/search/ask/provider status;
   - preserve existing annotation workflow.

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
