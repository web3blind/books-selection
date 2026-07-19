# AGENTS.md

## Project Context
- Что это: локальный Node.js tool для выбора FB2-книг по аннотациям из каталога с подпапками.
- Стек: CommonJS, без внешних npm-зависимостей. Annotation browsing работает на Node.js 18+; локальные FTS endpoints требуют runtime с `node:sqlite`.
- Главные entrypoints: `src/server.js` для HTTP-сервера, `public/index.html` для всего UI.

## Structure
- `src/server.js`: локальный HTTP server, раздача `public/index.html`, API `GET /api/books`, `POST /api/index`, `GET /api/search`, `GET /api/semantic-search`, `GET /api/ask`.
- `src/scan.js`: обход корневой папки, natural sort, поиск первого `.fb2` или `.fb2.zip` в каждой подпапке.
- `src/fb2.js`: чтение FB2/XML, decoding по XML encoding, извлечение `book-title` и `annotation`, извлечение body text/chunks для будущего индекса, чтение `.fb2.zip` через встроенный ZIP parser на Node.js.
- `src/indexer.js`: локальная индексация просканированной библиотеки в SQLite и минимальный FTS search helper без AI/network calls.
- `src/embeddings.js`: embeddings cache helpers, local cosine-similarity ranking over cached SQLite vectors, and no-key semantic-search setup fallback.
- `src/ask.js`: Ask pipeline поверх локально найденных FTS snippets; строит evidence-only prompt, возвращает setup/evidence без provider key и не отправляет полный текст библиотеки.
- `src/providerClient.js`: mockable OpenAI-compatible chat completion and embeddings scaffold с injectable `fetchImpl`; не логирует и не возвращает секреты.
- `src/providerConfig.js`: безопасные provider defaults для будущих AI и embeddings вызовов; ключи только через env references, без сетевых вызовов.
- `src/searchSchema.js`: SQLite schema SQL для books/chunks/chunk_embeddings/FTS5/entities/relations/events/evidence/derived facts.
- `src/searchDb.js`: тонкий optional adapter на `node:sqlite`; normal annotation browsing не должен от него зависеть.
- `src/constants.js`: общие status/reason constants и fallback-тексты для scan layer.
- `tests/fb2.test.js`: node:test для парсинга XML, fallback-логики, body extraction/chunking и чтения zip.
- `tests/indexer.test.js`: node:test для SQLite indexing service, FTS population/search и unchanged-file skip behavior.
- `tests/serverApi.test.js`: node:test smoke для `/api/books`, `/api/index`, `/api/search`, `/api/ask`.
- `tests/ask.test.js`: node:test для evidence-only prompt, no-key fallback и mockable provider client behavior.
- `tests/embeddings.test.js`: node:test для chunk_embeddings schema/cache, embeddings config/client, cosine ranking и no-key semantic fallback.
- `plan.md`: продуктовый план, его нужно держать в соответствии с реальной реализацией.

## Run And Validation
- Запуск: `npm start -- /path/to/Books 3210`
- Тесты: `npm test`
- Без автооткрытия браузера: `BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210`

## Behavior And Invariants
- Сканируется только один уровень подпапок внутри переданного root path.
- На папку берётся первый подходящий файл по natural sort (`.fb2` или `.fb2.zip`).
- API возвращает записи со status: `ok`, `missing`, `error`; UI и фильтры опираются на `status`, `reason`, `hasAnnotation`.
- `/api/index` and `/api/search` require explicit `db` query parameter or `BOOKS_SELECTION_DB_PATH`; they must remain local, without AI/network calls and without reading API keys.
- `/api/semantic-search` requires `db` and `q`; it returns `needs_embedding_provider_key` with setup info without calling the network when the embeddings provider key is absent, and otherwise ranks only cached SQLite vectors by local cosine similarity.
- `/api/ask` тоже требует `db` и `q`; сначала ищет локальные FTS snippets. Если active provider key не настроен, возвращает `needs_provider_key` с evidence/setup и не вызывает сеть. Если ключ есть, отправляет только retrieved snippets/evidence в provider client, не полный текст библиотеки.
- Для machine-readable поведения используй общие constants из `src/constants.js` и не завязывай UI или тесты на точные fallback-строки backend.
- UI intentionally single-file: вся клиентская логика, тексты и локализация лежат в `public/index.html` без frontend framework.

## Change Rules
- Если меняешь формат ответа `/api/books`, сразу проверяй совместимость с рендерингом и фильтрами в `public/index.html`.
- Если меняешь ZIP/FB2 parsing в `src/fb2.js`, обновляй или добавляй node:test кейсы в `tests/fb2.test.js`.
- Если меняешь команды, ограничения платформы или архитектурные допущения, обновляй `README.md` и `plan.md` вместе с кодом.
- Не добавляй тяжёлые зависимости или frontend framework без явной причины: текущая архитектура намеренно минимальная.

## Config And Secrets
- Секреты не коммитятся. Provider config хранит только имена env-переменных (`OPENROUTER_API_KEY`, `LOCAL_OPENAI_API_KEY`), не значения.
- Основные runtime inputs: CLI args `root` и `port`, env `PORT`, env `BOOKS_SELECTION_NO_OPEN`.
