# books-selection plan

## Status
Основной план выполнен.

## Delivered
- Локальный Node.js tool без внешних npm-зависимостей.
- Сканирование корневой папки с подпапками книг.
- Поиск первого `.fb2` или `.fb2.zip` в каждой подпапке.
- Извлечение `book-title` и `annotation` из FB2.
- Чтение `.fb2.zip` через встроенный ZIP parser на Node.js, без `python3`.
- Локальный HTTP server с `GET /api/books`.
- Простой доступный web UI с поиском, reload, выбором языка RU/EN и fallback на ручной ввод пути.
- Базовые тесты на FB2 parsing и scan behavior.

## Current Architecture
- `src/fb2.js`: parsing FB2/XML, decoding encoding, чтение `.fb2.zip`.
- `src/scan.js`: обход каталога, natural sort, формирование записей со `status`, `reason`, `hasAnnotation`.
- `src/server.js`: локальный HTTP server и раздача `public/index.html`.
- `public/index.html`: single-file UI без framework.
- `tests/fb2.test.js`: тесты парсинга FB2 и zip.
- `tests/scan.test.js`: тесты scanning logic и edge cases.

## Validation
- `npm test`
- ручной запуск: `npm start -- /path/to/Books 3210`
- smoke check API: `http://127.0.0.1:3210/api/books?root=/path/to/Books`

## Notes
- UI больше не должен опираться на точные fallback-строки backend, а должен использовать machine-readable поля `status`, `reason`, `hasAnnotation`.
- Архитектура намеренно остаётся простой: без БД, без внешнего frontend framework, без облачной синхронизации.

## Next Ideas
- Добавить больше тестов на экзотические ZIP cases, если такие файлы реально встретятся.
- При желании добавить более явные machine-readable error codes и на уровне `fb2.js`.
- Если появятся большие каталоги, можно подумать о потоковом чтении или pagination, но сейчас это не требуется.
