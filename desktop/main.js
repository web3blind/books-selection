const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, dialog, ipcMain, net, shell } = electron;
const { startServer } = require('../src/server');
const { isAllowedExternalUrl, isTrustedRendererUrl } = require('./security');
const { readAppConfig } = require('../src/appConfig');
const {
  configurePortableEnvironment,
  migrateLegacyData,
  resolvePortablePaths,
  shouldMigratePortableDatabase,
} = require('./portableData');

let mainWindow;
let serverHandle;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

async function configureDesktopEnvironment() {
  process.env.BOOKS_SELECTION_DESKTOP = '1';
  process.env.BOOKS_SELECTION_NO_OPEN = '1';

  if (app.isPackaged && process.platform === 'win32') {
    const explicitConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH || '';
    const explicitDbPath = process.env.BOOKS_SELECTION_DB_PATH || '';
    const explicitLogPath = process.env.BOOKS_SELECTION_LOG_PATH || '';
    const portablePaths = resolvePortablePaths({
      isPackaged: true,
      platform: process.platform,
      execPath: process.execPath,
      env: { PORTABLE_EXECUTABLE_DIR: process.env.PORTABLE_EXECUTABLE_DIR },
      userDataPath: app.getPath('userData'),
      homeDir: app.getPath('home'),
    });
    configurePortableEnvironment(process.env, portablePaths);
    let configuredDbPath = explicitDbPath;
    if (explicitConfigPath && !explicitDbPath) {
      configuredDbPath = (await readAppConfig(process.env)).config.dbPath;
    }
    const migrateDatabase = shouldMigratePortableDatabase({
      explicitConfigPath,
      explicitDbPath,
      configuredDbPath,
      portableDbPath: portablePaths.dbPath,
      platform: process.platform,
    });
    await migrateLegacyData(portablePaths, {
      migrateConfig: !explicitConfigPath,
      migrateDatabase,
      migrateLog: !explicitLogPath,
      configuredDbPath,
      platform: process.platform,
    });
  } else if (!process.env.BOOKS_SELECTION_DB_PATH) {
    process.env.BOOKS_SELECTION_DB_PATH = path.join(app.getPath('userData'), 'data', 'books-selection.sqlite');
  }
}

async function ensureServer() {
  await configureDesktopEnvironment();
  if (!serverHandle) {
    serverHandle = await startServer({
      defaultRoot: '',
      port: 0,
      openBrowser: false,
      log: true,
      providerFetchImpl: net.fetch,
    });
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
        configPath: config.path || '',
        dbPath: config.config?.dbPath || '',
      };
    })()`);
    console.log(`Books Selection desktop smoke: ${JSON.stringify(smoke)}`);
    app.quit();
  }
}

function registerAppLifecycle() {
  ipcMain.handle('books-selection:pick-directory', async (event, locale = 'en') => {
    if (!serverHandle || !isTrustedRendererUrl(event.senderFrame?.url, serverHandle.url)) {
      throw new Error('Directory picker request came from an untrusted renderer.');
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: String(locale).toLowerCase().startsWith('ru') ? 'Выбрать папку книг' : 'Choose books folder',
      properties: ['openDirectory'],
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, path: '' };
    }

    return { canceled: false, path: result.filePaths[0] };
  });

  app.whenReady().then(createMainWindow).catch((error) => {
    console.error(error);
    const prefix = app.getLocale().toLowerCase().startsWith('ru')
      ? 'Не удалось запустить приложение'
      : 'Could not start the application';
    dialog.showErrorBox('Books Selection', `${prefix}: ${error.message}`);
    app.quit();
  });

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
}

if (hasSingleInstanceLock) {
  registerAppLifecycle();
} else {
  app.quit();
}
