# Books Selection

Local desktop app for choosing FB2 book series by annotation and asking questions over a local full-text index.

Books Selection can run in two modes:

- desktop release: opens its own application window and does not require Node.js, npm, or git;
- developer/server mode: `npm start` keeps the old behavior and opens the web UI in your normal browser.

## Download desktop builds

Latest desktop release downloads:

- Linux x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-linux-x64.tar.gz
- Windows portable exe: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-win-x64.exe
- Windows folder zip: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-win-x64.zip
- macOS x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-mac-x64.zip

These links point to `releases/latest`, so they keep working for future releases as long as release assets keep the same names.

## Run the desktop app

### Linux

```bash
tar -xzf books-selection-desktop-linux-x64.tar.gz
./books-selection
```

### Windows

There are two Windows downloads:

- `books-selection-desktop-win-x64.zip` — recommended if you want a normal folder that is easy to move between devices. Extract the archive and run `Books Selection.exe` inside the extracted folder.
- `books-selection-desktop-win-x64.exe` — portable single-file executable. Download and run it directly.

Both variants include the application files and do not require Node.js, npm, git, or neighboring project files. The folder zip is usually easier to copy to another computer, USB drive, or synced folder. The single exe is simpler when the user just wants one file to download and launch.

Writable user data is created automatically on first run. Default Windows writable locations are managed by Electron/user settings, for example the app config and SQLite index are created under the user's app data area unless you choose another SQLite path in Settings.

### macOS

Extract `books-selection-desktop-mac-x64.zip` and run Books Selection.

macOS may show a warning for unsigned/not-notarized apps. If needed, allow the app in system security settings.

## Desktop behavior

In the desktop build:

- Books Selection opens as a normal application window.
- The backend/server code runs inside the Electron main process of the same app.
- No separate backend child process is spawned.
- The system browser is not opened.
- The UI is still the same accessible web interface, rendered inside the app window.
- Folder selection uses a native system directory dialog through a narrow preload API.

The renderer page does not get full Node.js access:

- `nodeIntegration` is disabled;
- `contextIsolation` is enabled;
- preload exposes only `booksSelectionDesktop.pickDirectory()` for native folder picking.

## First-run workflow

1. Start the desktop app.
2. On first launch, Settings opens automatically.
3. Press **Choose books folder** / **Выбрать папку книг**.
4. A native system folder dialog opens in the desktop app.
5. Choose the folder that contains your book series folders.
6. Keep the default SQLite path or set a custom one.
7. Optionally configure OpenRouter or a local OpenAI-compatible provider.
8. Save settings.
9. On the main page, press **Load list**.
10. Press **Prepare index for questions** when you want full-text Q&A.
11. Enter a question and press **Find answer**.

## Writable data

Default writable paths:

- config: `~/.books-selection/config.json`, or `BOOKS_SELECTION_CONFIG_PATH` if set;
- desktop SQLite index: Electron user-data directory, `data/books-selection.sqlite`, or `BOOKS_SELECTION_DB_PATH` if set;
- source / npm mode SQLite index: project-local `data/books-selection.sqlite`, or `BOOKS_SELECTION_DB_PATH` if set.

The config can contain a local API key if you enter it in Settings, so do not publish or commit your personal config file.

## Current features

- Scans a root folder with book subfolders.
- Finds `.fb2` and `.fb2.zip` files.
- Extracts title, annotation, and normalized body text.
- Shows books in an accessible local interface.
- Supports Russian and English UI.
- Searches by folder, title, and annotation.
- Can hide folders without usable annotations or with read errors.
- Has an in-app Settings page; no manual config editing is required.
- Uses native folder selection in desktop builds.
- Uses browser/fallback path behavior in normal browser mode.
- Builds a local SQLite FTS index for full-text search.
- Caches embeddings in SQLite when an embeddings provider is configured.
- Supports hybrid Ask mode over local FTS snippets, cached semantic hits, and cached derived facts.
- Sends only retrieved evidence snippets to the AI provider, not the full library.
- Supports OpenRouter and local OpenAI-compatible provider settings.
- Guards OpenRouter calls with a configurable session spend limit; default is `$1`.
- If provider keys are missing, Ask returns local evidence/setup status instead of silently failing or calling the network.

## Developer/server mode

Source development requires Node.js 22+ because the full-text index uses `node:sqlite`.

```bash
npm install
npm test
npm start
```

`npm start` intentionally keeps the old behavior:

- starts the local Node server;
- opens the normal system browser;
- serves the UI at `http://127.0.0.1:3210`.

Optional launch environment variables:

```bash
BOOKS_SELECTION_NO_OPEN=1 npm start
PORT=3210 npm start
BOOKS_SELECTION_CONFIG_PATH=/path/to/config.json npm start
BOOKS_SELECTION_DB_PATH=/path/to/books-selection.sqlite npm start
```

## Build release bundles

### Desktop app builds

This project uses Electron and `electron-builder` for full desktop app windows.

```bash
npm install
npm test
npm run build:desktop
```

The build creates:

- `dist-desktop/books-selection-desktop-linux-x64.tar.gz`
- `dist-desktop/books-selection-desktop-win-x64.exe`
- `dist-desktop/books-selection-desktop-win-x64.zip`
- `dist-desktop/books-selection-desktop-mac-x64.zip`

### Lightweight server executable builds

The older lightweight server-only executable build is still available through `pkg`:

```bash
npm run build:dist
```

Those builds start the local server and open the system browser. The desktop builds above are the recommended user-facing downloads.

## API notes

The local server exposes JSON endpoints used by the UI:

- `GET /api/config`
- `POST /api/config`
- `GET /api/books`
- `POST /api/index`
- `POST /api/embed-index`
- `GET /api/search`
- `GET /api/semantic-search`
- `GET /api/ask`
- `GET /api/extract-fact`

Annotation browsing through `/api/books` does not require AI keys. Indexing/search uses local SQLite. AI-backed answer generation and embeddings require provider configuration.

## Notes

- The app is local-first: your library index stays in your local SQLite file.
- Real API keys must never be committed to git.
- OpenRouter budget protection is checked before chat and embeddings requests.
- Windows SmartScreen and macOS Gatekeeper may warn because builds are not code-signed yet.

## License

MIT
