# AGENTS.md

## Project Context
- Что это: локальный Node.js tool для выбора FB2-книг по аннотациям из каталога с подпапками.
- Стек: CommonJS, без внешних npm-зависимостей, Node.js 18+.
- Главные entrypoints: `src/server.js` для HTTP-сервера, `public/index.html` для всего UI.

## Structure
- `src/server.js`: локальный HTTP server, раздача `public/index.html`, API `GET /api/books`.
- `src/scan.js`: обход корневой папки, natural sort, поиск первого `.fb2` или `.fb2.zip` в каждой подпапке.
- `src/fb2.js`: чтение FB2/XML, decoding по XML encoding, извлечение `book-title` и `annotation`, чтение `.fb2.zip` через встроенный ZIP parser на Node.js.
- `src/constants.js`: общие status/reason constants и fallback-тексты для scan layer.
- `tests/fb2.test.js`: node:test для парсинга XML, fallback-логики и чтения zip.
- `plan.md`: продуктовый план, его нужно держать в соответствии с реальной реализацией.

## Run And Validation
- Запуск: `npm start -- /path/to/Books 3210`
- Тесты: `npm test`
- Без автооткрытия браузера: `BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210`

## Behavior And Invariants
- Сканируется только один уровень подпапок внутри переданного root path.
- На папку берётся первый подходящий файл по natural sort (`.fb2` или `.fb2.zip`).
- API возвращает записи со status: `ok`, `missing`, `error`; UI и фильтры опираются на `status`, `reason`, `hasAnnotation`.
- Для machine-readable поведения используй общие constants из `src/constants.js` и не завязывай UI или тесты на точные fallback-строки backend.
- UI intentionally single-file: вся клиентская логика, тексты и локализация лежат в `public/index.html` без frontend framework.

## Change Rules
- Если меняешь формат ответа `/api/books`, сразу проверяй совместимость с рендерингом и фильтрами в `public/index.html`.
- Если меняешь ZIP/FB2 parsing в `src/fb2.js`, обновляй или добавляй node:test кейсы в `tests/fb2.test.js`.
- Если меняешь команды, ограничения платформы или архитектурные допущения, обновляй `README.md` и `plan.md` вместе с кодом.
- Не добавляй тяжёлые зависимости или frontend framework без явной причины: текущая архитектура намеренно минимальная.

## Config And Secrets
- Секретов и внешних сервисов нет.
- Основные runtime inputs: CLI args `root` и `port`, env `PORT`, env `BOOKS_SELECTION_NO_OPEN`.
