const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, session, clipboard, ClipboardItem, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DocumentStore, atomicWrite, inside, listMarkdown, syncAssets } = require('./store.cjs');
const run = promisify(execFile);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
if (process.env.INKSTONE_TEST_USER_DATA) app.setPath('userData', process.env.INKSTONE_TEST_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'inkstone-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let preferences = { theme: 'light', fontSize: 16, lineWidth: 860, autoSave: false, focus: false, typewriter: false, spellcheck: true, mathNumbering: false, headingNumbering: false, sidebarWidth: 240, zoomLevel: 0, windowBounds: null, windowMaximized: false, showFormatbar: true, uiMode: 'typora', sidebarVisible: false, uiDefaultsMigrated: false };
const pendingFiles = [];
const recentlyClosed = [];
const suppressed = new Set(), notified = new Set();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] }];

// Every window owns its own DocumentStore and recovery directory. The three
// legacy globals resolve through AsyncLocalStorage, so all existing IPC
// handlers automatically operate on the window that called them.
const contextStorage = new AsyncLocalStorage();
const contexts = new Map();
let primary = null, windowCounter = 0;
const active = () => contextStorage.getStore() || primary || { win: null, store: null, root: null };
Object.defineProperty(globalThis, 'win', { configurable: true, get: () => active().win });
Object.defineProperty(globalThis, 'store', { configurable: true, get: () => active().store });
Object.defineProperty(globalThis, 'root', {
  configurable: true,
  get: () => active().root,
  set: value => { active().root = value; }
});
const liveContexts = () => [...contexts.values()].filter(context => context.win && !context.win.isDestroyed());
const contextForDocument = id => {
  for (const context of contexts.values()) {
    try { if (context.store.documents.has(id)) return context; } catch { /* closed */ }
  }
  return null;
};
const command = name => {
  const focused = BrowserWindow.getFocusedWindow();
  const target = (focused && contexts.get(focused.webContents.id)) || liveContexts()[0];
  target?.win.webContents.send('inkstone:command', name);
};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const themesDirectory = () => path.join(app.getPath('userData'), 'themes');
const historyDirectory = () => path.join(store.recoveryDirectory, 'history');
const safeName = name => typeof name === 'string' && name === path.basename(name) && !/[\\/]/.test(name) && !name.startsWith('.');

/** Pandoc is optional. Probe once so the UI can explain what is available. */
let pandocCache;
async function pandoc() {
  if (pandocCache !== undefined) return pandocCache;
  try {
    const { stdout } = await run('pandoc', ['--version'], { timeout: 5000, maxBuffer: 256 * 1024 });
    pandocCache = { installed: true, version: String(stdout).split('\n')[0] || 'Pandoc' };
  } catch { pandocCache = { installed: false, version: null }; }
  return pandocCache;
}

/**
 * A deliberately small HTML→Markdown converter. It is only used when Pandoc
 * is absent, so importing an HTML page never fails outright.
 */
function htmlToMarkdown(html) {
  const text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_match, code) => `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n\n`)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, title) => `\n\n${'#'.repeat(Number(level))} ${title.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)')
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(?:p|div|section|article|ul|ol|blockquote|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return `${text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Resolve a document-relative image path, rejecting traversal and URLs. */
async function resolveAsset(doc, src) {
  if (typeof src !== 'string' || !src || /^[a-z]+:/i.test(src) || src.startsWith('//')) throw new Error('仅支持文档中的本地图片。');
  const candidate = await fs.realpath(path.resolve(path.dirname(doc.path), decodeURIComponent(src)));
  const allowedRoot = root && inside(root, doc.path) ? root : path.dirname(doc.path);
  if (!inside(allowedRoot, candidate) || !/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(candidate)) throw new Error('图片路径无效。');
  return candidate;
}

/** Never restore a window that would land off-screen on the current display. */
function visibleBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width < 720 || bounds.height < 480) return null;
  const size = { width: bounds.width, height: bounds.height };
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return size;
  try {
    const area = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, ...size }).workArea;
    if (bounds.x < area.x - 40 || bounds.y < area.y - 40 || bounds.x > area.x + area.width - 80 || bounds.y > area.y + area.height - 80) return size;
    return { x: bounds.x, y: bounds.y, ...size };
  } catch { return size; }
}

/** Create an independent editor window with its own documents and recovery. */
function createWindow() {
  const index = windowCounter++;
  const recovery = index === 0
    ? path.join(app.getPath('userData'), 'recovery')
    : path.join(app.getPath('userData'), 'recovery', `window-${index}`);
  const context = { win: null, store: new DocumentStore(recovery), root: null, allowClose: false };
  const frameless = process.platform === 'darwin';
  const restored = visibleBounds(preferences.windowBounds) || {};
  const window = new BrowserWindow({
    width: 1240, height: 840, ...restored, minWidth: 720, minHeight: 480, title: 'Inkstone',
    backgroundColor: preferences.theme === 'dark' ? '#282c34' : preferences.theme === 'sepia' ? '#fbf7ef' : '#ffffff',
    ...(frameless ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: preferences.uiMode === 'workbench' ? 22 : 12 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  context.win = window;
  const contentsId = window.webContents.id;
  contexts.set(contentsId, context);
  if (!primary) primary = context;

  let boundsTimer;
  const persistWindowState = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(async () => {
      if (window.isDestroyed() || window.isFullScreen() || index !== 0) return;
      preferences.windowMaximized = window.isMaximized();
      if (!window.isMaximized()) {
        const { x, y, width, height } = window.getBounds();
        preferences.windowBounds = { x, y, width, height };
      }
      await atomicWrite(settingsPath(), JSON.stringify(preferences, null, 2)).catch(() => {});
    }, 450);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'restore']) window.on(event, persistWindowState);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => {
    contexts.delete(contentsId);
    if (primary === context) primary = liveContexts()[0] || null;
  });
  window.on('close', event => {
    if (context.allowClose) return;
    event.preventDefault();
    window.webContents.send('inkstone:command', 'quit');
  });
  window.loadFile(path.join(__dirname, '../dist/index.html'));
  window.webContents.setZoomLevel(Number.isFinite(preferences.zoomLevel) ? Math.max(-3, Math.min(3, preferences.zoomLevel)) : 0);
  if (index === 0 && preferences.windowMaximized) window.maximize();
  return window;
}

function installMenu() {
  const mac = process.platform === 'darwin';
  const item = (label, accelerator, name) => ({ label, accelerator, click: () => command(name) });
  const macKey = (key, fallback) => mac ? key : fallback;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: 'Inkstone', submenu: [{ role: 'about' }, { type: 'separator' }, item('偏好设置…', 'CmdOrCtrl+,', 'settings'), item('打开主题文件夹…', null, 'themes-folder'), { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '文件', submenu: [
      item('新建', 'CmdOrCtrl+N', 'new'),
      item('新建标签', macKey('Cmd+T', 'CmdOrCtrl+Alt+N'), 'new'),
      item('新建窗口', 'CmdOrCtrl+Shift+N', 'new-window'),
      item('打开…', 'CmdOrCtrl+O', 'open'),
      item('打开文件夹…', 'CmdOrCtrl+Shift+O', 'folder'),
      item('命令面板 / 快速打开…', 'CmdOrCtrl+P', 'quick-open'),
      item('重新打开已关闭文件', 'CmdOrCtrl+Shift+T', 'reopen-closed'),
      { type: 'separator' },
      item('保存', 'CmdOrCtrl+S', 'save'), item('另存为…', 'CmdOrCtrl+Shift+S', 'save-as'), item('关闭文档', 'CmdOrCtrl+W', 'close'),
      { type: 'separator' }, item('导入…', null, 'import'), item('导出…', 'CmdOrCtrl+Shift+E', 'export'),
      item('查看保存历史…', null, 'history'),
      { type: 'separator' },
      ...(mac ? [] : [item('偏好设置…', 'CmdOrCtrl+,', 'settings'), item('打开主题文件夹…', null, 'themes-folder'), { role: 'quit' }])
    ] },
    { label: '编辑', submenu: [
      item('撤销', 'CmdOrCtrl+Z', 'undo'), item('重做', 'CmdOrCtrl+Shift+Z', 'redo'),
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      item('复制为 Markdown', 'CmdOrCtrl+Shift+C', 'copy-markdown'),
      item('复制为 HTML', null, 'copy-html'),
      item('粘贴为纯文本', 'CmdOrCtrl+Shift+V', 'paste-plain'),
      item('插入表情…', null, 'emoji'),
      item('选择行 / 表格行', 'CmdOrCtrl+L', 'select-line'),
      item('选择词 / 样式范围', 'CmdOrCtrl+E', 'select-scope'),
      item('删除词', 'CmdOrCtrl+Shift+D', 'delete-word'),
      item('删除行', 'CmdOrCtrl+Shift+Backspace', 'delete-line'),
      { type: 'separator' },
      item('查找与替换', 'CmdOrCtrl+F', 'find'), item('替换…', 'CmdOrCtrl+H', 'replace'),
      item('跳转到顶部', macKey('Cmd+Up', 'Ctrl+Home'), 'jump-top'),
      item('跳转到底部', macKey('Cmd+Down', 'Ctrl+End'), 'jump-bottom'),
      item('跳转到光标', 'CmdOrCtrl+J', 'jump-to-selection')
    ] },
    { label: '段落', submenu: [
      ...[1, 2, 3, 4, 5, 6].map(n => item(`${n} 级标题`, `CmdOrCtrl+${n}`, `heading-${n}`)),
      item('正文', 'CmdOrCtrl+0', 'paragraph'),
      item('提升标题级别', 'CmdOrCtrl+=', 'heading-up'), item('降低标题级别', 'CmdOrCtrl+-', 'heading-down'),
      { type: 'separator' },
      item('表格', macKey('Cmd+Alt+T', 'Ctrl+T'), 'table'),
      item('代码块', macKey('Cmd+Alt+C', 'CmdOrCtrl+Shift+K'), 'code'),
      item('公式块', macKey('Cmd+Alt+B', 'CmdOrCtrl+Shift+M'), 'math'),
      item('引用', macKey('Cmd+Alt+Q', 'CmdOrCtrl+Shift+Q'), 'quote'),
      item('有序列表', macKey('Cmd+Alt+O', 'CmdOrCtrl+Shift+['), 'ordered-list'),
      item('无序列表', macKey('Cmd+Alt+U', 'CmdOrCtrl+Shift+]'), 'unordered-list'),
      item('任务列表', null, 'task'),
      item('增加缩进', 'CmdOrCtrl+]', 'indent'), item('减少缩进', 'CmdOrCtrl+[', 'outdent'),
      item('图片…', macKey('Cmd+Ctrl+I', 'CmdOrCtrl+Shift+I'), 'image')
    ] },
    { label: '格式', submenu: [
      item('粗体', 'CmdOrCtrl+B', 'bold'), item('斜体', 'CmdOrCtrl+I', 'italic'),
      item('下划线', 'CmdOrCtrl+U', 'underline'), item('链接', 'CmdOrCtrl+K', 'link'),
      item('行内代码', null, 'inline-code'), item('删除线', null, 'strike'),
      item('清除格式', null, 'clear-format')
    ] },
    { label: '视图', submenu: [
      item('源码模式', 'CmdOrCtrl+/', 'source'), item('侧边栏', 'CmdOrCtrl+Shift+L', 'sidebar'),
      item('大纲', macKey('Cmd+Ctrl+1', 'CmdOrCtrl+Shift+1'), 'panel-outline'),
      item('文件树', macKey('Cmd+Ctrl+2', 'CmdOrCtrl+Shift+2'), 'panel-files'),
      item('专注模式', 'F8', 'focus'), item('打字机模式', 'F9', 'typewriter'), item('主题切换', null, 'theme'),
      item('切换到下一个文档', macKey('Cmd+`', 'Ctrl+Tab'), 'next-document'),
      { type: 'separator' },
      item('实际大小', 'CmdOrCtrl+Shift+0', 'zoom-reset'),
      item('放大', 'CmdOrCtrl+Shift+=', 'zoom-in'), item('缩小', 'CmdOrCtrl+Shift+-', 'zoom-out'),
      { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])
    ] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    { label: '帮助', submenu: [item('使用说明', null, 'help'), { label: '查看恢复文件', click: () => shell.openPath(store.recoveryDirectory) }] }
  ]));
}

function handle(name, action) {
  ipcMain.handle(`inkstone:${name}`, (event, ...args) => {
    const context = contexts.get(event.sender.id);
    if (!context || event.senderFrame !== context.win.webContents.mainFrame) throw new Error('无效的调用来源。');
    return contextStorage.run(context, async () => {
      try { return { ok: true, value: await action(...args) }; }
      catch (error) { return { ok: false, error: error.message || '操作失败。' }; }
    });
  });
}

async function selectSave(doc) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: doc.path || doc.name, filters });
  return canceled ? null : filePath;
}
async function chooseOpen(candidate) {
  if (!candidate) {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(file => store.open(file)));
  }
  const resolved = await fs.realpath(candidate);
  if (!root || !inside(root, resolved)) throw new Error('该文件不在已打开的文件夹中。');
  return [await store.open(resolved)];
}
function registerHandlers() {
  handle('bootstrap', async () => {
    const recovered = await store.recoverAll();
    const opened = [];
    for (const file of pendingFiles.splice(0)) { try { opened.push(await store.open(file)); } catch {} }
    return { documents: [...recovered, ...opened], preferences, platform: process.platform, recoveryCount: recovered.length };
  });
  handle('capabilities', async () => ({ ...(await pandoc()), platform: process.platform }));
  handle('newWindow', () => { createWindow(); return true; });
  handle('newDocument', content => store.create(content || ''));
  handle('openDocument', chooseOpen);
  handle('openFolder', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    root = await fs.realpath(result.filePaths[0]);
    return { path: root, name: path.basename(root), entries: await listMarkdown(root) };
  });
  handle('refreshFolder', async () => root ? { path: root, name: path.basename(root), entries: await listMarkdown(root) } : null);
  handle('updateDocument', (id, content) => store.update(id, content));
  handle('saveDocument', async (id, saveAs = false) => {
    const doc = store.get(id);
    const file = saveAs || !doc.path ? await selectSave(doc) : doc.path;
    if (!file) return null;
    const previousPath = doc.path;
    // Our own atomic write briefly replaces the file; do not report it as an
    // external change while the disk watcher polls.
    suppressed.add(id);
    try {
      const result = await store.save(id, file);
      // A Save As into another folder must carry the referenced images with it.
      await syncAssets(doc.content, previousPath, result.path);
      app.addRecentDocument(result.path);
      notified.delete(id);
      return result;
    } finally { setTimeout(() => suppressed.delete(id), 1000); }
  });
  handle('closeDocument', async id => {
    const doc = store.get(id);
    if (doc.dirty) {
      const result = await dialog.showMessageBox(win, { type: 'question', message: `保存“${doc.name}”的更改？`, buttons: ['保存', '取消', '不保存'], defaultId: 0, cancelId: 1 });
      if (result.response === 1) return false;
      if (result.response === 0) {
        const file = doc.path || await selectSave(doc);
        if (!file) return false;
        await store.save(id, file);
      }
    }
    await store.close(id);
    if (doc.path) recentlyClosed.push(doc.path);
    return true;
  });
  handle('settings', async patch => {
    if (!patch) return preferences;
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in preferences) || typeof value !== typeof preferences[key]) continue;
      if (key === 'theme' && !['light', 'dark', 'sepia'].includes(value) && !(typeof value === 'string' && value.startsWith('custom:') && safeName(value.slice(7)) && value.endsWith('.css'))) continue;
      if (key === 'uiMode' && !['typora', 'workbench'].includes(value)) continue;
      if (key === 'fontSize' && (!Number.isFinite(value) || value < 12 || value > 30)) continue;
      if (key === 'lineWidth' && (!Number.isFinite(value) || value < 560 || value > 1100)) continue;
      if (key === 'sidebarWidth' && (!Number.isFinite(value) || value < 180 || value > 480)) continue;
      if (key === 'windowBounds') {
        if (!value || typeof value !== 'object') continue;
        const bounds = {};
        for (const field of ['x', 'y', 'width', 'height']) if (Number.isFinite(value[field])) bounds[field] = Math.round(value[field]);
        if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width < 720 || bounds.height < 480) continue;
        preferences.windowBounds = bounds;
        continue;
      }
      preferences[key] = value;
    }
    // The macOS traffic lights follow the height of the active title bar.
    if (patch.uiMode && process.platform === 'darwin') {
      const position = { x: 18, y: preferences.uiMode === 'workbench' ? 22 : 12 };
      for (const { win } of contexts.values()) if (win && !win.isDestroyed() && typeof win.setTrafficLightPosition === 'function') win.setTrafficLightPosition(position);
    }
    await atomicWrite(settingsPath(), JSON.stringify(preferences, null, 2));
    return preferences;
  });
  handle('openExternal', async url => {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error('不支持打开此类链接。');
    await shell.openExternal(parsed.href);
  });
  handle('revealDocument', id => { const doc = store.get(id); if (doc.path) shell.showItemInFolder(doc.path); });
  handle('renameDocument', async id => {
    const doc = store.get(id);
    if (!doc.path) throw new Error('请先保存文档。');
    const previous = doc.path;
    const target = await selectSave(doc);
    if (!target || target === previous) return null;
    const result = await store.save(id, target);
    await syncAssets(doc.content, previous, result.path);
    await shell.trashItem(previous);
    return result;
  });
  handle('trashDocument', async id => {
    const doc = store.get(id);
    if (!doc.path) return false;
    const { response } = await dialog.showMessageBox(win, { message: `将“${doc.name}”移到废纸篓？`, detail: '尚未保存的内容会保留在恢复目录中。', buttons: ['取消', '移到废纸篓'], defaultId: 0, cancelId: 0 });
    if (response !== 1) return false;
    await shell.trashItem(doc.path);
    // Keep unsaved text as a new document, and never remove its recovery copy.
    Object.assign(doc, { path: null, version: null, savedContent: '', dirty: !!doc.content });
    await store.recover(doc);
    return store.public(doc);
  });
  handle('history', async () => {
    await fs.mkdir(historyDirectory(), { recursive: true });
    await shell.openPath(historyDirectory());
  });
  handle('listThemes', async () => {
    await fs.mkdir(themesDirectory(), { recursive: true });
    return (await fs.readdir(themesDirectory())).filter(name => name.endsWith('.css')).sort();
  });
  handle('readTheme', async name => {
    if (!safeName(name) || !name.endsWith('.css')) throw new Error('主题文件名无效。');
    const css = await fs.readFile(path.join(themesDirectory(), name), 'utf8');
    // Custom themes are local-only; never let them pull remote resources.
    return css.slice(0, 1024 * 1024).replace(/@import[^;]*;/gi, '');
  });
  handle('openThemesFolder', async () => {
    await fs.mkdir(themesDirectory(), { recursive: true });
    await shell.openPath(themesDirectory());
  });
  handle('listHistory', async id => {
    const doc = store.get(id);
    await fs.mkdir(historyDirectory(), { recursive: true });
    const result = [];
    for (const name of await fs.readdir(historyDirectory())) {
      if (!name.endsWith(`-${doc.name}`)) continue;
      const stamp = Number(name.split('-')[0]);
      const stat = await fs.stat(path.join(historyDirectory(), name)).catch(() => null);
      if (!stat?.isFile()) continue;
      const time = Number.isFinite(stamp) && stamp > 0 ? stamp : stat.mtimeMs;
      result.push({ name, time, label: new Date(time).toLocaleString('zh-CN') });
    }
    return result.sort((a, b) => b.time - a.time).slice(0, 50);
  });
  handle('readHistory', async name => {
    if (!safeName(name)) throw new Error('历史版本名无效。');
    return fs.readFile(path.join(historyDirectory(), name), 'utf8');
  });
  handle('reloadDocument', async id => { const result = await store.reload(id); notified.delete(id); return result; });
  handle('writeClipboard', async payload => {
    const text = String(payload?.text ?? '');
    // Electron 45 models the clipboard after the W3C Clipboard API.
    if (typeof payload?.html === 'string') {
      await clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([payload.html], { type: 'text/html' })
      })]);
    } else await clipboard.writeText(text);
    return true;
  });
  handle('readClipboardText', () => clipboard.readText());
  handle('copyImage', async (id, src) => {
    const doc = store.get(id);
    if (!doc.path) throw new Error('请先保存文档，再复制图片。');
    const image = nativeImage.createFromBuffer(await fs.readFile(await resolveAsset(doc, src)));
    if (image.isEmpty()) throw new Error('无法读取该图片。');
    clipboard.writeImage(image);
    return true;
  });
  handle('copyImagePath', async (id, src) => {
    const doc = store.get(id);
    if (!doc.path) throw new Error('请先保存文档。');
    const file = await resolveAsset(doc, src);
    clipboard.writeText(file);
    return file;
  });
  handle('zoom', async delta => {
    const step = Number(delta) || 0;
    const level = Math.max(-3, Math.min(3, step === 0 ? 0 : win.webContents.getZoomLevel() + Math.sign(step)));
    win.webContents.setZoomLevel(level);
    preferences.zoomLevel = level;
    await atomicWrite(settingsPath(), JSON.stringify(preferences, null, 2));
  });
  handle('fullscreen', () => { win.setFullScreen(!win.isFullScreen()); });
  handle('reopenClosed', async () => {
    const opened = [];
    while (recentlyClosed.length) {
      const file = recentlyClosed.pop();
      try { opened.push(await store.open(file)); } catch { /* file may be gone */ }
    }
    return opened;
  });
  // Poll instead of fs.watch: our saves atomically replace the file, which
  // invalidates inode-based watchers on some platforms.
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const context of liveContexts()) {
        for (const [id, doc] of context.store.documents) {
          if (!doc.path || doc.version === null || suppressed.has(id) || notified.has(id)) continue;
          try {
            const bytes = await fs.readFile(doc.path);
            if (digest(bytes) === doc.version) continue;
            notified.add(id);
            if (!context.win.isDestroyed()) context.win.webContents.send('inkstone:external-change', id);
          } catch { /* temporarily missing during an atomic write */ }
        }
      }
    } finally { checking = false; }
  }, 2000);
  handle('insertImage', async (id, payload) => {
    const doc = store.get(id);
    if (!doc.path) throw new Error('请先保存文档，再插入图片。');
    let bytes, extension, name;
    if (payload) {
      if (typeof payload.data !== 'string' || payload.data.length > 28 * 1024 * 1024 || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(payload.extension)) throw new Error('图片格式不支持或超过 20 MB。');
      bytes = Buffer.from(payload.data, 'base64'); extension = payload.extension; name = 'image';
    } else {
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if ((await fs.stat(file)).size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB。');
      bytes = await fs.readFile(file); extension = path.extname(file).slice(1); name = path.basename(file, path.extname(file));
    }
    const folder = path.join(path.dirname(doc.path), 'assets');
    await fs.mkdir(folder, { recursive: true });
    const file = `${name.replace(/[^\p{L}\p{N}_-]/gu, '-')}-${require('node:crypto').randomUUID().slice(0, 8)}.${extension}`;
    await atomicWrite(path.join(folder, file), bytes);
    return `assets/${file}`;
  });
  handle('importDocument', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '可导入文档', extensions: ['docx', 'odt', 'html', 'htm', 'epub', 'tex', 'rst', 'md', 'markdown', 'txt'] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    const extension = path.extname(file).slice(1).toLowerCase();
    // HTML and plain text need no external tools; a lightweight converter
    // keeps the import path usable on machines without Pandoc.
    if (['html', 'htm', 'txt', 'md', 'markdown'].includes(extension)) {
      const raw = await fs.readFile(file, 'utf8');
      return store.create(['html', 'htm'].includes(extension) ? htmlToMarkdown(raw) : raw);
    }
    try {
      const { stdout } = await run('pandoc', [file, '-t', 'gfm'], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
      return store.create(stdout);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('导入此格式需要安装 Pandoc（https://pandoc.org/installing.html）。HTML、TXT 和 Markdown 可直接导入。');
      throw error;
    }
  });
  handle('exportDocument', async (id, format, html) => {
    const doc = store.get(id);
    if (!['html', 'pdf', 'docx', 'odt', 'epub', 'tex', 'rst'].includes(format)) throw new Error('不支持的导出格式。');
    const result = await dialog.showSaveDialog(win, { defaultPath: doc.name.replace(/\.[^.]+$/, '') + '.' + format, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (result.canceled) return null;
    if (format === 'html') {
      if (typeof html !== 'string' || html.length > 50 * 1024 * 1024) throw new Error('导出内容无效。');
      // Export bundled math fonts and local image assets into the HTML itself.
      for (const match of [...html.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)]) {
        const ref = match[1];
        if (ref.startsWith('data:')) continue;
        const name = path.basename(ref.split(/[?#]/)[0]);
        if (!/\.(woff2?|ttf)$/.test(name)) continue;
        try {
          const bytes = await fs.readFile(path.join(__dirname, '../dist/assets', name));
          const mime = name.endsWith('woff2') ? 'font/woff2' : name.endsWith('woff') ? 'font/woff' : 'font/ttf';
          html = html.replaceAll(ref, `data:${mime};base64,${bytes.toString('base64')}`);
        } catch { /* Keep an unresolved URL visible to the HTML reader. */ }
      }
      for (const match of [...html.matchAll(/src="(inkstone-asset:\/\/[^"<>]+)"/g)]) {
        try {
          const url = new URL(match[1]);
          if (url.hostname !== id || !doc.path) continue;
          const file = await fs.realpath(path.resolve(path.dirname(doc.path), decodeURIComponent(url.pathname.slice(1))));
          const allowedRoot = root && inside(root, doc.path) ? root : path.dirname(doc.path);
          const extension = path.extname(file).slice(1).toLowerCase();
          if (!inside(allowedRoot, file) || !['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(extension)) continue;
          const mime = extension === 'svg' ? 'image/svg+xml' : extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
          html = html.replaceAll(match[1], `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`);
        } catch {}
      }
      await atomicWrite(result.filePath, html);
    } else if (format === 'pdf') {
      const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true, generateTaggedPDF: true });
      await atomicWrite(result.filePath, pdf);
    } else {
      const temporary = path.join(app.getPath('temp'), `inkstone-${require('node:crypto').randomUUID()}`);
      await fs.mkdir(temporary);
      const source = path.join(temporary, 'source.md');
      const output = path.join(temporary, `output.${format}`);
      try {
        await fs.writeFile(source, doc.content);
        await run('pandoc', [source, '-f', 'markdown+tex_math_dollars', '--standalone', '--resource-path', doc.path ? path.dirname(doc.path) : temporary, '-o', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        await atomicWrite(result.filePath, await fs.readFile(output));
      } catch (error) { if (error.code === 'ENOENT') throw new Error('导出此格式需要安装 Pandoc（https://pandoc.org/installing.html）。HTML 和 PDF 可直接导出。'); throw error; }
      finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }
    return result.filePath;
  });
}

app.on('open-file', (event, file) => {
  event.preventDefault();
  pendingFiles.push(file);
  if (liveContexts().length) command('system-open');
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    pendingFiles.push(...argv.filter(arg => /\.(md|markdown)$/i.test(arg) && path.isAbsolute(arg)));
    const first = liveContexts()[0];
    if (first) { first.win.show(); first.win.focus(); command('system-open'); }
  });
  app.whenReady().then(async () => {
    try { preferences = { ...preferences, ...JSON.parse(await fs.readFile(settingsPath(), 'utf8')) }; } catch {}
    // One-time migration: the old 17px / 760px defaults predate Typora parity.
    if (!preferences.uiDefaultsMigrated && preferences.fontSize === 17 && preferences.lineWidth === 760) {
      preferences = { ...preferences, fontSize: 16, lineWidth: 860, uiDefaultsMigrated: true };
      await atomicWrite(settingsPath(), JSON.stringify(preferences, null, 2)).catch(() => {});
    }
    protocol.handle('inkstone-asset', async request => {
      try {
        const url = new URL(request.url);
        const context = contextForDocument(url.hostname);
        if (!context) return new Response('', { status: 404 });
        const doc = context.store.get(url.hostname);
        if (!doc.path) return new Response('', { status: 404 });
        const candidate = await fs.realpath(path.resolve(path.dirname(doc.path), decodeURIComponent(url.pathname.slice(1))));
        const allowedRoot = context.root && inside(context.root, doc.path) ? context.root : path.dirname(doc.path);
        if (!inside(allowedRoot, candidate) || !/\.(png|jpg|jpeg|gif|webp|svg|avif)$/i.test(candidate)) return new Response('', { status: 403 });
        return net.fetch(pathToFileURL(candidate).href);
      } catch { return new Response('', { status: 404 }); }
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerHandlers(); installMenu();
    handle('drainPending', async () => Promise.all(pendingFiles.splice(0).map(file => store.open(file))));
    handle('finishQuit', () => {
      // Only this window is finished. Closing it triggers window-all-closed
      // when it was the last one, so other windows keep their save prompts.
      const context = contextStorage.getStore() || primary;
      if (!context) return true;
      context.allowClose = true;
      if (!context.win.isDestroyed()) context.win.close();
      return true;
    });
    createWindow();
  });
}
app.on('window-all-closed', () => app.quit());
