const { contextBridge, ipcRenderer } = require('electron');
const methods = ['bootstrap', 'newDocument', 'openDocument', 'openFolder', 'refreshFolder', 'updateDocument', 'saveDocument', 'closeDocument', 'importDocument', 'exportDocument', 'insertImage', 'settings', 'openExternal', 'revealDocument', 'renameDocument', 'trashDocument', 'history', 'drainPending', 'finishQuit', 'listThemes', 'readTheme', 'openThemesFolder', 'listHistory', 'readHistory', 'reloadDocument', 'zoom', 'fullscreen', 'reopenClosed', 'writeClipboard', 'readClipboardText', 'capabilities', 'copyImage', 'copyImagePath', 'newWindow'];
const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke(`inkstone:${name}`, ...args)]));
api.onCommand = callback => {
  const listener = (_event, command) => callback(command);
  ipcRenderer.on('inkstone:command', listener);
  return () => ipcRenderer.removeListener('inkstone:command', listener);
};
api.onExternalChange = callback => {
  const listener = (_event, id) => callback(id);
  ipcRenderer.on('inkstone:external-change', listener);
  return () => ipcRenderer.removeListener('inkstone:external-change', listener);
};
contextBridge.exposeInMainWorld('desktop', api);
