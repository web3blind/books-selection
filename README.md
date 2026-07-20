# Books Selection

Local app for choosing FB2 book series by annotation and asking questions over a local full-text index.

The app runs as a small local web server and opens in your browser. It is designed to work without requiring users to install Node.js, npm, or git when they download a release build.

## Download executable builds

Latest release downloads:

- Linux x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-linux-x64.tar.gz
- Windows x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-windows-x64.tar.gz
- macOS x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-macos-x64.tar.gz

These links point to `releases/latest`, so they keep working for future releases as long as release assets keep the same names.

## Run a downloaded build

1. Download the archive for your system.
2. Extract it.
3. Run the executable inside the extracted folder:
   - Linux/macOS: `./books-selection`
   - Windows: `books-selection.exe`
4. If the browser does not open automatically, open `http://127.0.0.1:3210`.
5. On first launch, open Settings and save at least the books folder path.

Each bundle includes:

- the executable app;
- `data/` folder for the default SQLite database;
- `README.txt` with local launch notes.

Default writable paths:

- config: `~/.books-selection/config.json`, or `BOOKS_SELECTION_CONFIG_PATH` if set;
- SQLite index: `data/books-selection.sqlite` beside the executable, or `BOOKS_SELECTION_DB_PATH` if set.

The config can contain a local API key if you enter it in Settings, so do not publish or commit your personal config file.

## Current features

- Scans a root folder with book subfolders.
- Finds `.fb2` and `.fb2.zip` files.
- Extracts title, annotation, and normalized body text.
- Shows books in an accessible local web interface.
- Supports Russian and English UI.
- Searches by folder, title, and annotation.
- Can hide folders without usable annotations or with read errors.
- Has an in-app Settings page; no manual config editing is required.
- Stores local settings in JSON.
- Uses a project-local `data/books-selection.sqlite` database by default.
- Builds a local SQLite FTS index for full-text search.
- Caches embeddings in SQLite when an embeddings provider is configured.
- Supports hybrid Ask mode over local FTS snippets, cached semantic hits, and cached derived facts.
- Sends only retrieved evidence snippets to the AI provider, not the full library.
- Supports OpenRouter and local OpenAI-compatible provider settings.
- Guards OpenRouter calls with a configurable session spend limit; default is `$1`.
- If provider keys are missing, Ask returns local evidence/setup status instead of silently failing or calling the network.

## Main workflow

1. Open Settings.
2. Set the books folder path.
3. Keep the default SQLite path or choose another one.
4. Optionally set OpenRouter/local provider fields and API key.
5. Save settings.
6. On the main page, press **Load list** to browse annotations.
7. Press **Prepare index for questions** to build/update the local index.
8. Enter a question in **Question about series** and press **Find answer**.

## Build from source

Source development requires Node.js 22+ because the full-text index uses `node:sqlite`.

```bash
npm install
npm test
npm start
```

Optional launch environment variables:

```bash
BOOKS_SELECTION_NO_OPEN=1 npm start
PORT=3210 npm start
BOOKS_SELECTION_CONFIG_PATH=/path/to/config.json npm start
BOOKS_SELECTION_DB_PATH=/path/to/books-selection.sqlite npm start
```

## Build release bundles

This project uses the popular `pkg` CLI from `@yao-pkg/pkg` to produce standalone executables with Node.js bundled in.

```bash
npm install
npm test
npm run build:dist
```

The build creates:

- `dist/books-selection-linux-x64/`
- `dist/books-selection-windows-x64/`
- `dist/books-selection-macos-x64/`
- `dist/books-selection-linux-x64.tar.gz`
- `dist/books-selection-windows-x64.tar.gz`
- `dist/books-selection-macos-x64.tar.gz`

The `dist/` folder is ignored by git. Release archives are uploaded to GitHub Releases.

## API notes

The browser UI is the main interface, but the local server also exposes JSON endpoints:

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
- macOS may require allowing the downloaded executable in system security settings because the build is not notarized.

## License

MIT
