const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booksSelectionDesktop', {
  isDesktop: true,
  pickDirectory: () => ipcRenderer.invoke('books-selection:pick-directory'),
});
