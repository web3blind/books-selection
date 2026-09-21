# Books Selection

Local desktop app for choosing FB2 book series by annotation, asking questions over a local full-text index, keeping a favorites rating of cycles, tracking read cycles, and watching bound Author.Today series pages for new books.

Books Selection can run in two modes:

- desktop release: opens its own application window and does not require Node.js, npm, or git;
- developer/server mode: `npm start` keeps the old behavior and opens the web UI in your normal browser.

## Guided plot search (source version; not yet in a desktop release)

Ask now plans complementary queries, retrieves locally, checks candidates, optionally refines by book/series, and produces a cited answer. It uses three chat phases and at most five query-embedding requests; existing provider budget checks and cancellation still apply. These are selective recommendations, not a proof that every passage in a series was read. Search details show the queries and saved observations. No full-library chat analysis runs during preparation.

After updating the source version, run **Prepare search and embeddings** once. SQLite now retains section headings/order and previously omitted supplemental text and notes. Existing unchanged chunk IDs and embeddings are retained; newly recovered passages may require additional embeddings, with the existing volume/consent check. The schema upgrade creates a backup before migration. Favorites and reading marks remain intact. Observations are stored with original chunk references and hashes; retrieval rechecks the original text rather than treating model-written facts as proof.

## Download desktop builds

Latest desktop release downloads:

- Linux x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-linux-x64.tar.gz
- Windows portable exe: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-win-x64.exe
- Windows folder zip: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-win-x64.zip
- macOS x64: https://github.com/web3blind/books-selection/releases/latest/download/books-selection-desktop-mac-x64.zip

These links point to `releases/latest`, so they keep working for future releases as long as release assets keep the same names.

## What is inside

- **Cycles only.** The main screen lists cycles with their annotations; individual books are not the browsing unit.
- **Ask over the library.** One question returns one block per cycle with the matching books and fragments under spoilers, so a cycle is never repeated in the result list.
- **Favorites with a rating.** Cycles added to Favorites collect points from the Ask answers where they land in the top five positions (5/4/3/2/1 for places 1-5). The same question never scores twice, order can be corrected with "move up/down", and "sort by rating" rebuilds the order.
- **Read cycles.** A cycle can be marked as read and separately as unfinished, read cycles can be hidden from the main list, and the Read section keeps a searchable list plus an "unfinished cycles" subsection.
- **Continuations from Author.Today.** A cycle can be bound to its public `https://author.today/work/series/<id>` page. Nothing is fetched automatically: pressing "Check for updates" loads that one page and compares it with the stored book list. New books (`work_id`) or a cycle that became complete appear in the "Has a continuation" block. Network errors keep the previous snapshot, an incomplete page never marks vanished books as new, and the request has a timeout with a size cap.
- **Check all unfinished cycles.** One button above the unfinished-cycles list checks every unfinished cycle that has a bound page, one cycle at a time with a short pause between requests, shows the progress ("Checking 2 of 5: …"), can be stopped, and ends with a summary of what was checked and where new books were found. Cycles without a binding are skipped and counted in the hint.
- **Fast start.** Cycle cards are cached next to the database, keyed by the composition of the books folder: while the set of cycle folders and their book files is unchanged, the app starts without reading a single book. Adding or removing a cycle parses only that folder. The "Reload" button re-reads every book on demand. Startup queries stay cheap as well: the readiness of the semantic cache is counted in SQL instead of parsing every stored vector, which used to block the window for seconds on a large corpus.
- **Interface language.** English is the default. The chosen language is stored in `config.json` next to the database, so it survives application restarts, new ports, and browser storage resets.

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

Writable user data is created automatically on first run. In v0.3.8 packaged Windows builds it lives in the `data` folder beside the portable app; earlier v0.3.7 profile data is copied there safely on first launch. Explicit path overrides and deliberately configured custom database paths remain unchanged.

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
10. Press **Prepare search and embeddings**. The same action indexes every supported FB2/FB2.ZIP file in each series and then prepares up to 1,000 missing embeddings.
11. For OpenRouter, review the destination and amount and explicitly consent before every run. Repeat until readiness reaches 100%; a local provider keeps text on the device.
12. Enter a question and press **Find answer**. Ask runs only when all indexed chunks can be ranked, then reports whole-corpus consideration separately from the bounded evidence sent to the answer provider.

## Writable data

Default writable paths:

- packaged Windows desktop builds: `data/config.json`, `data/books-selection.sqlite`, and `data/books-selection.log` beside the portable application;
- Windows folder ZIP: `data` is beside `Books Selection.exe` in the extracted folder;
- Windows portable EXE: `data` is beside the downloaded portable EXE, not in Electron's temporary extraction directory;
- packaged macOS/Linux and source/npm config: `~/.books-selection/config.json`, or `BOOKS_SELECTION_CONFIG_PATH` if set;
- packaged macOS/Linux SQLite index: the Electron user-data directory; source/npm SQLite index: project-local `data/books-selection.sqlite`; either can be overridden with `BOOKS_SELECTION_DB_PATH`;
- diagnostics can be overridden with `BOOKS_SELECTION_LOG_PATH`.

On the first packaged Windows v0.3.8 launch, Books Selection copies the earlier user-profile config, SQLite database, and diagnostic log into the portable `data` folder when the destination files do not exist. SQLite is copied through its backup API and read back before use. Legacy files are retained as a fallback and existing portable files are never overwritten. A deliberately configured custom database path remains unchanged.

The portable `data/config.json` can contain an API key entered in Settings. Keep the whole portable folder private and do not publish or commit its `data` directory.
The diagnostic log records only the failed provider stage, endpoint, safe network error code, and API route. It does not record API keys, authorization headers, questions, prompts, excerpts, or response bodies. Desktop provider requests use Electron's Chromium network stack so they follow the desktop session's proxy and VPN routing.

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
- In normal browser mode, asks for the filesystem path manually because browsers do not expose a reliable absolute folder path.
- Builds a local SQLite FTS index for full-text search.
- Caches embeddings in SQLite only after a user-confirmed combined preparation operation. OpenRouter embedding preparation can upload the selected corpus chunks; a local embeddings provider keeps them on the device.
- Supports hybrid Ask mode over local FTS snippets, cached semantic hits, and cached derived facts.
- Shows deterministic local candidate groups by series/book from the already retrieved evidence, without extra AI provider calls.
- Ask sends only retrieved evidence snippets to the answer provider. The explicitly confirmed OpenRouter embedding stage of the combined preparation action sends corpus chunks needed to build the semantic cache.
- Supports OpenRouter and local OpenAI-compatible provider settings.
- Guards OpenRouter calls with a configurable `$1` default soft stop threshold and bounded answer output. The threshold is checked before requests but is not a provider-enforced hard maximum.
- If provider keys are missing, Ask returns local evidence/setup status instead of silently failing or calling the network.
- Checks GitHub Releases on startup and shows a cross-platform update notification with Linux, Windows, and macOS download links.

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

- `GET /api/config` (saved keys are redacted)
- `POST /api/config`
- `GET /api/books`
- `POST /api/index`
- `POST /api/embed-index`
  - requires `expectedProvider` matching the saved embeddings provider;
  - OpenRouter requests additionally require explicit `cloudConsent: true`;
  - one run may split its bounded fragment set into several provider requests.
- `GET /api/search`
- `POST /api/semantic-search`
- `POST /api/ask`
- `GET /api/favorites`, `POST /api/cycle-favorite`, `POST /api/favorites/reorder`, `POST /api/favorites/clear-history`
- `GET /api/reading`, `POST /api/cycle-reading`
- `GET /api/cycle-series`, `POST /api/cycle-series` (bind/unbind), `POST /api/cycle-series/check`
- `POST /api/language`
- `POST /api/extract-fact`

Annotation browsing through `/api/books` does not require AI keys. Indexing/search uses local SQLite. AI-backed answer generation and embeddings require provider configuration.

The UI receives a random per-launch HttpOnly cookie before it can access `/api/*`. The server rejects unexpected Host/Origin values, and provider-capable or state-changing endpoints accept JSON POST requests only. OpenRouter keys are never returned by the config API after saving.

Hermes transport is not included yet, so Hermes is not shown as a working provider choice. Its internal scaffold is reserved for a future dedicated adapter.

## Notes

- The app is local-first: your library index stays in your local SQLite file.
- Real API keys must never be committed to git.
- OpenRouter's soft budget threshold is checked before chat and embeddings requests; configure a provider-side account/key cap when a hard maximum is required.
- Release download links are restricted to this repository. Published checksums should be verified before running unsigned artifacts.
- Windows SmartScreen and macOS Gatekeeper may warn because builds are not code-signed yet.

## License

MIT
