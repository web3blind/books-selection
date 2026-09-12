const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { startServer } = require('../src/server');
const { isAllowedExternalUrl, isTrustedRendererUrl } = require('./security');

let mainWindow;
let serverHandle;

function configureDesktopEnvironment() {
  process.env.BOOKS_SELECTION_DESKTOP = '1';
  process.env.BOOKS_SELECTION_NO_OPEN = '1';

  if (!process.env.BOOKS_SELECTION_DB_PATH) {
    process.env.BOOKS_SELECTION_DB_PATH = path.join(app.getPath('userData'), 'data', 'books-selection.sqlite');
  }
}

async function ensureServer() {
  configureDesktopEnvironment();
  if (!serverHandle) {
    serverHandle = await startServer({ defaultRoot: '', port: 0, openBrowser: false, log: true });
  }
  return serverHandle;
}

async function createMainWindow() {
  await ensureServer();

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: 'Books Selection',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, serverHandle.url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  await mainWindow.loadURL(serverHandle.url);

  if (process.env.BOOKS_SELECTION_DESKTOP_SMOKE === '1') {
    const smoke = await mainWindow.webContents.executeJavaScript(`(async () => {
      const configResponse = await fetch('/api/config');
      const config = await configResponse.json();
      return {
        title: document.title,
        desktopApi: Boolean(window.booksSelectionDesktop?.isDesktop),
        nativePicker: typeof window.booksSelectionDesktop?.pickDirectory === 'function',
        configStatus: configResponse.status,
        dbPath: config.config?.dbPath || '',
      };
    })()`);
    console.log(`Books Selection desktop smoke: ${JSON.stringify(smoke)}`);
    app.quit();
  }
}

ipcMain.handle('books-selection:pick-directory', async (event) => {
  if (!serverHandle || !isTrustedRendererUrl(event.senderFrame?.url, serverHandle.url)) {
    throw new Error('Directory picker request came from an untrusted renderer.');
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose books folder',
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true, path: '' };
  }

  return { canceled: false, path: result.filePaths[0] };
});

app.whenReady().then(createMainWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow().catch((error) => {
      console.error(error);
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverHandle?.server) {
    serverHandle.server.close();
    serverHandle = null;
  }
});
