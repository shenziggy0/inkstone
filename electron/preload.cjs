const { contextBridge, ipcRenderer } = require('electron');
const methods = ['bootstrap', 'newDocument', 'openDocument', 'openPath', 'openFolder', 'openFolderPath', 'refreshFolder', 'activeFolder', 'updateDocument', 'saveDocument', 'closeDocument', 'importDocument', 'exportDocument', 'exportResultAction', 'copySelectionImage', 'insertImage', 'settings', 'openExternal', 'revealDocument', 'renameDocument', 'trashDocument', 'history', 'drainPending', 'finishQuit', 'cancelQuit', 'quitAck', 'listThemes', 'readTheme', 'openThemesFolder', 'listHistory', 'readHistory', 'reloadDocument', 'acceptExternalChange', 'detachDocument', 'zoom', 'fullscreen', 'reopenClosed', 'writeClipboard', 'readClipboardText', 'capabilities', 'copyImage', 'copyImagePath', 'chooseImageRoot', 'newWindow', 'appMenu', 'searchFolder', 'cancelSearch', 'recentFiles', 'clearRecent', 'saveSession', 'createEntry', 'renameEntry', 'trashEntry', 'revealPath', 'fileMenu', 'resolveLink', 'openLocalFile'];
methods.push('listWritingNotes', 'updateWritingNote');
const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke(`inkstone:${name}`, ...args)]));
api.onCommand = callback => {
  const listener = (_event, command, payload) => callback(command, payload);
  ipcRenderer.on('inkstone:command', listener);
  return () => ipcRenderer.removeListener('inkstone:command', listener);
};
api.onFullScreen = callback => {
  // The window overlay buttons disappear in full screen; the renderer then drops
  // the space it reserves for them.
  const listener = (_event, active) => callback(!!active);
  ipcRenderer.on('inkstone:full-screen', listener);
  return () => ipcRenderer.removeListener('inkstone:full-screen', listener);
};
api.onExternalChange = callback => {
  // `kind` is 'modified' or 'deleted'; the renderer queues prompts one by one.
  const listener = (_event, id, kind) => callback(id, kind || 'modified');
  ipcRenderer.on('inkstone:external-change', listener);
  return () => ipcRenderer.removeListener('inkstone:external-change', listener);
};
api.onFolderChanged = callback => {
  // Sent when a scan finds that the file tree on disk changed.
  const listener = (_event, folder) => callback(folder);
  ipcRenderer.on('inkstone:folder-changed', listener);
  return () => ipcRenderer.removeListener('inkstone:folder-changed', listener);
};
api.onWritingNotesChanged = callback => {
  const listener = (_event, id) => callback(id);
  ipcRenderer.on('inkstone:writing-notes-changed', listener);
  return () => ipcRenderer.removeListener('inkstone:writing-notes-changed', listener);
};
contextBridge.exposeInMainWorld('desktop', api);
