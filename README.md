# books-selection

Local tool for browsing FB2 book folders by annotation.

Локальный инструмент для просмотра папок с книгами FB2 по аннотациям.

## Why / Зачем

Use it when you have a large folder with book series and want to quickly see which first books look interesting before opening them.

Полезно, когда у тебя большая папка с книжными циклами и хочется быстро посмотреть аннотации первых книг перед выбором, что читать дальше.

## Features / Возможности

- scans a root folder with book subfolders
- finds `.fb2` and `.fb2.zip` files inside each subfolder
- extracts `book-title` and `annotation`
- shows the list in a simple local web interface
- supports search by folder name, book title, and annotation text
- has one checkbox to show only books with annotations and without errors
- can try folder selection in the browser, with manual path fallback
- remembers the last successful folder path in the browser
- supports English and Russian UI, with English as the default
- includes first AI-search foundation modules: provider config defaults, FB2 body extraction/chunking helpers, a local SQLite schema/adapter scaffold with FTS5/fact tables, indexing service, and minimal local FTS endpoints

- сканирует корневую папку с книжными подпапками
- ищет `.fb2` и `.fb2.zip` внутри каждой папки
- извлекает `book-title` и `annotation`
- показывает список в простом локальном web-интерфейсе
- поддерживает поиск по имени папки, названию книги и тексту аннотации
- умеет одной галочкой показывать только книги с аннотацией и без ошибок
- пытается выбрать папку через браузер, с fallback на ручной ввод пути
- запоминает последний удачный путь в браузере
- поддерживает английский и русский интерфейс, по умолчанию английский

## Requirements / Требования

- Node.js 18+ for annotation browsing / для просмотра аннотаций
- Node.js runtime with `node:sqlite` support for local FTS index endpoints / runtime с `node:sqlite` для локального FTS-индекса

## Run / Запуск

```bash
cd ai-projects/books-selection
npm start -- /path/to/Books 3210
```

Arguments / Аргументы:
- first argument / первый аргумент: path to the root books folder
- second argument / второй аргумент: optional port, default `3210`

Open / Открыть:
- the app will try to open your browser automatically
- if it cannot, open `http://127.0.0.1:3210` manually

Приложение попробует открыть браузер автоматически.
Если это не получится, открой `http://127.0.0.1:3210` вручную.

You can also pass the root path in the URL / Также можно передать путь в URL:
- `http://127.0.0.1:3210/?root=/path/to/Books`

## Local FTS index API / Локальный FTS index API

Annotation browsing still works through `/api/books` without a database. For local full-text search, use a user-local SQLite file with a Node.js runtime that supports `node:sqlite`:

```bash
BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210
curl -X POST "http://127.0.0.1:3210/api/index?root=/path/to/Books&db=/tmp/books-selection.sqlite"
curl "http://127.0.0.1:3210/api/search?q=фонарь&db=/tmp/books-selection.sqlite"
```

The index stores extracted FB2 body chunks locally and uses SQLite FTS5 only; these endpoints do not make AI/network calls and do not read provider API keys.

## Folder selection / Выбор папки

The interface includes a browser folder picker, but browser security rules may prevent the full local path from being exposed to the page.

В интерфейсе есть выбор папки через браузер, но ограничения безопасности браузера могут не дать странице полный локальный путь.

Because of that, the app always keeps a manual path input as a reliable fallback.

Поэтому приложение всегда оставляет ручной ввод пути как надёжный fallback.

## Tests / Тесты

```bash
npm test
```

To disable auto-open / Чтобы отключить автооткрытие браузера:

```bash
BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210
```

On Windows PowerShell:

```powershell
$env:BOOKS_SELECTION_NO_OPEN=1
npm start -- "C:\path\to\Books" 3210
```

## Notes / Замечания

- if an FB2 file has no annotation, the app shows a fallback message
- if a folder has no `.fb2` or `.fb2.zip`, it can be hidden by the default filter
- the project is still local-first: annotation browsing requires no database, cloud, or AI API; AI-search foundation adds local SQLite/FTS5 modules and provider config scaffolding without network calls

- если в FB2 нет аннотации, приложение показывает fallback-сообщение
- если в папке нет `.fb2` или `.fb2.zip`, её можно скрыть фильтром по умолчанию
- проект всё ещё локальный: annotation browsing не требует базы, облака или AI API; AI-search foundation добавляет только конфигурационные и SQLite/FTS5 scaffold-модули без сетевых вызовов

## License / Лицензия

MIT
