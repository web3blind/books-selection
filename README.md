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
- supports Russian and English UI

- сканирует корневую папку с книжными подпапками
- ищет `.fb2` и `.fb2.zip` внутри каждой папки
- извлекает `book-title` и `annotation`
- показывает список в простом локальном web-интерфейсе
- поддерживает поиск по имени папки, названию книги и тексту аннотации
- умеет одной галочкой показывать только книги с аннотацией и без ошибок
- пытается выбрать папку через браузер, с fallback на ручной ввод пути
- запоминает последний удачный путь в браузере
- поддерживает русский и английский интерфейс

## Requirements / Требования

- Node.js 18+
- `python3` in the system, used to read `.fb2.zip` without extra npm dependencies
- `python3` в системе, нужен для чтения `.fb2.zip` без лишних npm-зависимостей

## Run / Запуск

```bash
cd ai-projects/books-selection
npm start -- /path/to/Books 3210
```

Arguments / Аргументы:
- first argument / первый аргумент: path to the root books folder
- second argument / второй аргумент: optional port, default `3210`

Open / Открыть:
- `http://127.0.0.1:3210`

You can also pass the root path in the URL / Также можно передать путь в URL:
- `http://127.0.0.1:3210/?root=/path/to/Books`

## Folder selection / Выбор папки

The interface includes a browser folder picker, but browser security rules may prevent the full local path from being exposed to the page.

В интерфейсе есть выбор папки через браузер, но ограничения безопасности браузера могут не дать странице полный локальный путь.

Because of that, the app always keeps a manual path input as a reliable fallback.

Поэтому приложение всегда оставляет ручной ввод пути как надёжный fallback.

## Tests / Тесты

```bash
npm test
```

## Notes / Замечания

- if an FB2 file has no annotation, the app shows a fallback message
- if a folder has no `.fb2` or `.fb2.zip`, it can be hidden by the default filter
- the project is intentionally simple: no database, no external frontend framework, no cloud sync

- если в FB2 нет аннотации, приложение показывает fallback-сообщение
- если в папке нет `.fb2` или `.fb2.zip`, её можно скрыть фильтром по умолчанию
- проект специально сделан простым: без базы данных, без внешнего frontend framework, без облачной синхронизации

## License / Лицензия

MIT
