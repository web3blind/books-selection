const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booksSelectionDesktop', {
  isDesktop: true,
  pickDirectory: (locale = 'en') => ipcRenderer.invoke('books-selection:pick-directory', locale),
});
