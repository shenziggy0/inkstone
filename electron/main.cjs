const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, session, clipboard, ClipboardItem, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DocumentStore, atomicWrite, inside, listMarkdown } = require('./store.cjs');
const { parseAssetURL, resolveAssetFile, resolveDocumentLink, imageMime, unsavedAssetsDirectory, isNetworkPath, isExecutableExtension } = require('./assets.cjs');
const { searchFolder, validateEntryName, isMarkdownFile } = require('./search.cjs');
const { WorkspaceState } = require('./session.cjs');
const { parseDocumentPaths } = require('./argv.cjs');
const run = promisify(execFile);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
if (process.env.INKSTONE_TEST_USER_DATA) app.setPath('userData', process.env.INKSTONE_TEST_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'inkstone-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let preferences = { theme: 'light', fontSize: 16, lineWidth: 860, autoSave: false, focus: false, typewriter: false, spellcheck: true, mathNumbering: false, headingNumbering: false, sidebarWidth: 240, zoomLevel: 0, windowBounds: null, windowMaximized: false, showFormatbar: true, uiMode: 'typora', sidebarVisible: false, restoreSession: true, uiDefaultsMigrated: false };
// Recent documents / folders and the session restored at startup.
const workspace = new WorkspaceState(app.getPath('userData'));
const pendingFiles = [];
const suppressed = new Set();
// External changes are reported once per disk version. A Map (instead of a Set)
// lets a later edit of the same file prompt again, and never blocks a second doc.
const notified = new Map();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] }];
// Windows / Linux draw a frameless window with a native overlay for the system
// window buttons, so the application's own topbar is the only title bar.
// macOS keeps `hiddenInset` with the traffic lights inside that topbar.
const MAC = process.platform === 'darwin';
const TITLE_BAR_HEIGHT = 38;
// One platform-dependent name for the deleted-files location, used by menus,
// the command palette, the confirmation dialog and the notifications.
const TRASH_NAME = MAC ? '废纸篓' : '回收站';
/** Overlay colours follow the paper colour of the current theme. */
const titleBarOverlay = () => ({
  color: preferences.theme === 'dark' ? '#282c34' : preferences.theme === 'sepia' ? '#fbf7ef' : '#ffffff',
  symbolColor: preferences.theme === 'dark' ? '#d7dae0' : '#3b3f46',
  height: TITLE_BAR_HEIGHT
});
// Reserved width of the native window buttons (minimise / maximise / close) so
// the renderer never puts its own controls underneath the overlay. The buttons
// are three 46 DIP captions; Electron window bounds are in DIPs too, so this
// stays the same at every display scale factor.
const WINDOW_CONTROLS_WIDTH = 138;
const windowControlsWidth = () => MAC ? 0 : WINDOW_CONTROLS_WIDTH;
// Windows cold start / "open with": document paths arrive on the command line.
pendingFiles.push(...parseDocumentPaths(process.argv, process.cwd()));

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
// Menu commands go to the focused window. When no window has focus (a menu
// invoked from the tray, another application taking focus while it was open)
// the most recently focused live window is the right target; only then does the
// first live window act as a last resort.
let lastFocused = null;
const command = (name, payload) => {
  const focused = BrowserWindow.getFocusedWindow();
  const candidates = [
    focused && contexts.get(focused.webContents.id),
    lastFocused,
    liveContexts()[0]
  ];
  const target = candidates.find(context => context?.win && !context.win.isDestroyed());
  target?.win.webContents.send('inkstone:command', name, payload);
};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const themesDirectory = () => path.join(app.getPath('userData'), 'themes');
// Shared by every window: `<userData>/history/<path hash>/`.
const historyDirectory = () => path.join(app.getPath('userData'), 'history');
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

/**
 * Where an unsaved document keeps the pictures pasted into it. The renderer
 * shows them through the asset protocol; the first save migrates the referenced
 * files next to the document and removes the folder.
 */
const unsavedAssetsFor = id => unsavedAssetsDirectory(app.getPath('userData'), id);
const resourcePath = doc => doc.path || doc.sourcePath;
const assetOptions = doc => ({ documentPath: resourcePath(doc), unsavedDirectory: unsavedAssetsFor(doc.id) });

/** Resolve a document image reference through the shared resolver. */
async function resolveAsset(doc, src) {
  return resolveAssetFile(src, assetOptions(doc));
}

/** Delete the temporary image folder of one document, if it exists. */
async function removeUnsavedAssets(id) {
  try { await fs.rm(unsavedAssetsFor(id), { recursive: true, force: true }); } catch { /* nothing to clean */ }
}

/**
 * Startup housekeeping: drop temporary image folders nobody can reference any
 * more. A folder is kept while a recovery copy still names its document id, so
 * an unsaved draft that survived a crash keeps its pictures.
 */
async function pruneUnsavedAssets() {
  const base = path.join(app.getPath('userData'), 'unsaved-assets');
  const names = await fs.readdir(base).catch(() => []);
  if (!names.length) return;
  const referenced = new Set();
  const collect = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name.startsWith('window-')) await collect(file); continue; }
      if (!entry.name.endsWith('.json')) continue;
      referenced.add(entry.name.slice(0, -'.json'.length));
      try { const record = JSON.parse(await fs.readFile(file, 'utf8')); if (record?.id) referenced.add(record.id); } catch { /* unreadable recovery copy */ }
    }
  };
  await collect(path.join(app.getPath('userData'), 'recovery'));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (referenced.has(name)) continue;
    const directory = path.join(base, name);
    const stat = await fs.stat(directory).catch(() => null);
    if (!stat || stat.mtimeMs > cutoff) continue;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
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

/** Every path of a scanned tree, used as the file-tree change signature. */
const flattenPaths = entries => entries.flatMap(entry => entry.children ? [entry.path, ...flattenPaths(entry.children)] : [entry.path]);

/**
 * Remember the tree the renderer has just been given. Without this the first
 * background scan would take a file created right after opening the folder as
 * its baseline and never report it.
 */
function rememberFolderEntries(entries) {
  const context = contextStorage.getStore() || primary;
  if (context) context.folderSignature = flattenPaths(entries || []).join('\n');
  return entries;
}

/** Resolve a pending quit request made to a window's renderer. */
function settleQuit(context, result) {
  if (!context) return;
  clearTimeout(context.quitTimer);
  context.quitTimer = null;
  context.quitting = false;
  const resolve = context.quitResolve;
  context.quitResolve = null;
  context.quitPending = null;
  if (resolve) resolve(result);
}
/**
 * The renderer answered the quit command, so it is alive and owns the close flow
 * from now on. Stop the fallback timer: a native save prompt may legitimately
 * stay open far longer than five seconds, and hanging after this point is
 * covered by the `unresponsive` / `render-process-gone` handlers instead.
 */
function acknowledgeQuit(context) {
  if (!context || !context.quitResolve) return;
  clearTimeout(context.quitTimer);
  context.quitTimer = null;
}
/**
 * Ask the renderer to save everything and close. Resolves with 'saved' when the
 * renderer answered `finishQuit`, 'cancel' when the user cancelled a prompt, or
 * 'timeout' when a renderer that never acknowledged the command stays silent
 * (unsaved text already lives in the recovery directory, so closing must not be
 * blocked forever).
 */
function requestRendererQuit(context) {
  if (!context || context.win.isDestroyed()) return Promise.resolve('saved');
  if (context.quitPending) return context.quitPending;
  context.quitting = true;
  context.quitPending = new Promise(resolve => {
    context.quitResolve = resolve;
    context.quitTimer = setTimeout(() => settleQuit(context, 'timeout'), 5000);
    context.win.webContents.send('inkstone:command', 'quit');
  });
  return context.quitPending;
}
// One application-level quit walks every window in order: the first cancel
// aborts the whole quit instead of leaving the remaining windows unasked.
let quitSequence = null;
async function quitAllWindows() {
  if (quitSequence) return quitSequence;
  quitSequence = (async () => {
    try {
      for (const context of liveContexts()) {
        if (context.win.isDestroyed()) continue;
        const result = await requestRendererQuit(context);
        if (result === 'cancel') return false;
        if (result === 'timeout' || result === 'gone') {
          context.allowClose = true;
          if (!context.win.isDestroyed()) context.win.close();
        }
      }
      // The renderers are gone, so their last session snapshot has arrived.
      await workspace.flush().catch(() => {});
      app.quit();
      return true;
    } finally { quitSequence = null; }
  })();
  return quitSequence;
}

/** Create an independent editor window with its own documents and recovery. */
function createWindow() {
  const index = windowCounter++;
  const userData = app.getPath('userData');
  const recovery = index === 0
    ? path.join(userData, 'recovery')
    : path.join(userData, 'recovery', `window-${index}`);
  const context = {
    win: null,
    // History is keyed by the document's real path and shared by all windows;
    // the legacy root keeps old per-window history folders readable. The
    // unsaved-asset root is shared too, so a recovered draft can take over the
    // image folder of the id it was saved under.
    store: new DocumentStore(recovery, { historyDirectory: path.join(userData, 'history'), legacyHistoryRoot: path.join(userData, 'recovery'), unsavedAssetsDirectory: path.join(userData, 'unsaved-assets') }),
    root: null, allowClose: false, recentlyClosed: [], misses: new Map(),
    // Folder search state: the newest query cancels the one before it.
    searchToken: null, folderSignature: null,
    rendererGone: false, unresponsive: false, quitting: false,
    quitResolve: null, quitPending: null, quitTimer: null
  };
  const frameless = MAC;
  const restored = visibleBounds(preferences.windowBounds) || {};
  const window = new BrowserWindow({
    width: 1240, height: 840, ...restored, minWidth: 720, minHeight: 480, title: 'Inkstone',
    backgroundColor: preferences.theme === 'dark' ? '#282c34' : preferences.theme === 'sepia' ? '#fbf7ef' : '#ffffff',
    ...(frameless
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: preferences.uiMode === 'workbench' ? 22 : 12 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(), autoHideMenuBar: true }),
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
  window.on('focus', () => { lastFocused = context; });
  window.on('closed', () => {
    contexts.delete(contentsId);
    if (lastFocused === context) lastFocused = null;
    if (primary === context) primary = liveContexts()[0] || null;
  });
  // Full screen hides the overlay buttons; the renderer drops its reserved
  // width and the menu button there so the topbar uses the whole screen.
  window.on('enter-full-screen', () => { if (!window.isDestroyed()) window.webContents.send('inkstone:full-screen', true); });
  window.on('leave-full-screen', () => { if (!window.isDestroyed()) window.webContents.send('inkstone:full-screen', false); });
  window.webContents.on('render-process-gone', async (_event, details) => {
    context.rendererGone = true;
    settleQuit(context, 'gone');
    // A crashed renderer can no longer answer save prompts; its unsaved text is
    // already in the recovery directory, so the window must stay closable.
    if (window.isDestroyed() || details?.reason === 'clean-exit') return;
    const { response } = await dialog.showMessageBox(window, {
      type: 'error',
      message: '编辑器窗口意外退出',
      detail: '未保存的内容已保留在恢复目录中。可以重新加载窗口继续编辑，或关闭窗口。',
      buttons: ['重新加载窗口', '关闭窗口'],
      defaultId: 0, cancelId: 1
    }).catch(() => ({ response: 1 }));
    if (window.isDestroyed()) return;
    if (response === 0) {
      context.rendererGone = false;
      window.webContents.reload();
    } else {
      context.allowClose = true;
      window.close();
    }
  });
  window.webContents.on('unresponsive', () => { context.unresponsive = true; });
  window.webContents.on('responsive', () => { context.unresponsive = false; });
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) context.rendererGone = false;
  });
  window.on('close', event => {
    // Dead or hung renderers cannot answer prompts; never block those closes.
    if (context.allowClose || context.rendererGone || context.unresponsive) return;
    event.preventDefault();
    requestRendererQuit(context).then(result => {
      if (result === 'timeout' && !window.isDestroyed()) {
        context.allowClose = true;
        window.close();
      }
    });
  });
  window.loadFile(path.join(__dirname, '../dist/index.html'));
  window.webContents.setZoomLevel(Number.isFinite(preferences.zoomLevel) ? Math.max(-3, Math.min(3, preferences.zoomLevel)) : 0);
  if (index === 0 && preferences.windowMaximized) window.maximize();
  return window;
}

/**
 * The whole application menu. Windows / Linux hide the native menu bar (the
 * window is frameless), so the same template also feeds the topbar menu button.
 */
function menuTemplate() {
  const mac = MAC;
  const item = (label, accelerator, name) => ({ label, accelerator, click: () => command(name) });
  const macKey = (key, fallback) => mac ? key : fallback;
  return [
    ...(mac ? [{ label: 'Inkstone', submenu: [{ role: 'about', label: '关于墨页' }, { type: 'separator' }, item('偏好设置…', 'CmdOrCtrl+,', 'settings'), item('打开主题文件夹…', null, 'themes-folder'), { type: 'separator' }, { role: 'services', label: '服务' }, { role: 'hide', label: '隐藏墨页' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '全部显示' }, { type: 'separator' }, { label: '退出墨页', accelerator: 'Cmd+Q', click: () => quitAllWindows() }] }] : []),
    { label: '文件', submenu: [
      item('新建文档', 'CmdOrCtrl+N', 'new'),
      item('新建标签', macKey('Cmd+T', 'CmdOrCtrl+Alt+N'), 'new'),
      item('新建窗口', 'CmdOrCtrl+Shift+N', 'new-window'),
      item('打开文档…', 'CmdOrCtrl+O', 'open'),
      item('打开文件夹…', 'CmdOrCtrl+Shift+O', 'folder'),
      item('在文件夹中搜索…', 'CmdOrCtrl+Shift+F', 'folder-search'),
      { label: '最近打开', submenu: recentMenuTemplate() },
      item('命令面板 / 快速打开…', 'CmdOrCtrl+P', 'quick-open'),
      item('重新打开已关闭文件', 'CmdOrCtrl+Shift+T', 'reopen-closed'),
      { type: 'separator' },
      item('保存', 'CmdOrCtrl+S', 'save'), item('另存为…', 'CmdOrCtrl+Shift+S', 'save-as'), item('关闭文档', 'CmdOrCtrl+W', 'close'),
      // The tab bar is hidden in the default appearance, so every document
      // action lives here and in the command palette as well.
      item('重命名 / 移动…', 'CmdOrCtrl+Shift+R', 'rename'),
      item('在文件夹中显示', null, 'reveal'),
      item(`移到${TRASH_NAME}`, null, 'trash'),
      { type: 'separator' }, item('导入…', null, 'import'), item('导出…', 'CmdOrCtrl+Shift+E', 'export'),
      item('查看保存历史…', null, 'history'),
      { type: 'separator' },
      ...(mac ? [] : [item('偏好设置…', 'CmdOrCtrl+,', 'settings'), item('打开主题文件夹…', null, 'themes-folder'), { label: '退出', click: () => quitAllWindows() }])
    ] },
    { label: '编辑', submenu: [
      item('撤销', 'CmdOrCtrl+Z', 'undo'), item('重做', 'CmdOrCtrl+Shift+Z', 'redo'),
      { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
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
      item('插入表格', macKey('Cmd+Alt+T', 'Ctrl+T'), 'table'),
      item('插入代码块', macKey('Cmd+Alt+C', 'CmdOrCtrl+Shift+K'), 'code'),
      item('插入公式块', macKey('Cmd+Alt+B', 'CmdOrCtrl+Shift+M'), 'math'),
      item('插入图表', 'CmdOrCtrl+Alt+D', 'diagram'),
      item('插入文内目录', null, 'toc'),
      item('引用', macKey('Cmd+Alt+Q', 'CmdOrCtrl+Shift+Q'), 'quote'),
      item('有序列表', macKey('Cmd+Alt+O', 'CmdOrCtrl+Shift+['), 'ordered-list'),
      item('无序列表', macKey('Cmd+Alt+U', 'CmdOrCtrl+Shift+]'), 'unordered-list'),
      item('任务列表', null, 'task'),
      item('增加缩进', 'CmdOrCtrl+]', 'indent'), item('减少缩进', 'CmdOrCtrl+[', 'outdent'),
      item('插入图片…', macKey('Cmd+Ctrl+I', 'CmdOrCtrl+Shift+I'), 'image')
    ] },
    { label: '格式', submenu: [
      item('粗体', 'CmdOrCtrl+B', 'bold'), item('斜体', 'CmdOrCtrl+I', 'italic'),
      item('下划线', 'CmdOrCtrl+U', 'underline'), item('链接', 'CmdOrCtrl+K', 'link'),
      item('行内代码', null, 'inline-code'), item('删除线', null, 'strike'),
      item('清除格式', null, 'clear-format')
    ] },
    { label: '视图', submenu: [
      item('源码模式', 'CmdOrCtrl+/', 'source'), item('切换侧边栏', 'CmdOrCtrl+Shift+L', 'sidebar'),
      item('大纲面板', macKey('Cmd+Ctrl+1', 'CmdOrCtrl+Shift+1'), 'panel-outline'),
      item('文件树面板', macKey('Cmd+Ctrl+2', 'CmdOrCtrl+Shift+2'), 'panel-files'),
      item('文章列表面板', null, 'panel-articles'),
      item('切换界面外观（Typora / 工作台）', null, 'toggle-ui'),
      item('专注模式', 'F8', 'focus'), item('打字机模式', 'F9', 'typewriter'), item('切换主题', null, 'theme'),
      { type: 'separator' },
      item('实际大小', 'CmdOrCtrl+Shift+0', 'zoom-reset'),
      item('放大', 'CmdOrCtrl+Shift+=', 'zoom-in'), item('缩小', 'CmdOrCtrl+Shift+-', 'zoom-out'),
      { role: 'togglefullscreen', label: '全屏' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [])
    ] },
    { label: '窗口', submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: mac ? '缩放' : '最大化 / 还原' },
      { type: 'separator' },
      // Ctrl+Tab / Ctrl+Shift+Tab switch documents; macOS keeps its system
      // convention (Cmd+`) for the forward direction.
      item('下一个文档', macKey('Cmd+`', 'Ctrl+Tab'), 'next-document'),
      item('上一个文档', 'Ctrl+Shift+Tab', 'previous-document'),
      ...(mac ? [{ type: 'separator' }, { role: 'front', label: '全部置于前台' }] : [])
    ] },
    { label: '帮助', submenu: [item('使用说明', null, 'help'), { label: '查看恢复文件', click: () => shell.openPath(store.recoveryDirectory) }] }
  ];
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
}

/**
 * The «文件 → 最近打开» submenu. Reading the loaded workspace state keeps the
 * menu a user pops up in step with the last open / save, and “清除记录” is the
 * only way to forget a path (nothing expires on its own).
 */
function recentMenuTemplate() {
  const files = workspace.files();
  const folders = workspace.folders();
  const entries = files.length
    ? files.map(file => ({ label: file.name, toolTip: file.path, click: () => command('open-recent', { path: file.path }) }))
    : [{ label: '暂无最近打开的文件', enabled: false }];
  if (folders.length) {
    entries.push({ type: 'separator' });
    entries.push(...folders.map(folder => ({ label: path.basename(folder) || folder, toolTip: folder, click: () => command('open-recent-folder', { path: folder }) })));
  }
  entries.push({ type: 'separator' }, {
    label: '清除记录',
    click: () => { workspace.clear().catch(() => {}); command('refresh-recent'); }
  });
  return entries;
}

// Drop every accelerator from the popup copy: the application menu already owns
// them, and registering the same shortcut twice would run the command twice.
function withoutAccelerators(entries) {
  return entries.map(entry => {
    const copy = { ...entry };
    delete copy.accelerator;
    if (copy.submenu) copy.submenu = withoutAccelerators(copy.submenu);
    return copy;
  });
}

/** The topbar «菜单» button (Windows / Linux) opens the full native menu. */
function showAppMenu(point) {
  const target = win;
  if (!target || target.isDestroyed()) return false;
  const menu = Menu.buildFromTemplate(withoutAccelerators(menuTemplate()));
  menu.popup({
    window: target,
    x: Math.max(0, Math.round(Number(point?.x) || 0)),
    y: Math.max(0, Math.round(Number(point?.y) || TITLE_BAR_HEIGHT))
  });
  return true;
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
    return Promise.all(result.filePaths.map(file => store.open(file).then(record => rememberFile(record))));
  }
  const resolved = await resolveLocalTarget(candidate, '不支持指向网络位置的文件。');
  if (!resolved) throw new Error('文件不存在。');
  if (!root || !inside(root, resolved)) throw new Error('该文件不在已打开的文件夹中。');
  return [rememberFile(await store.open(resolved))];
}

/** Remember a document for the recents menu and the OS jump list. */
function rememberFile(record) {
  if (record?.path) {
    workspace.recordFile(record.path);
    refreshMenuSoon();
    try { app.addRecentDocument(record.path); } catch { /* not supported on this platform */ }
  }
  return record;
}

// macOS keeps one application menu for the whole session, so the recents it
// lists are refreshed after the workspace state changed. The delay collapses a
// burst of opens into one rebuild.
let menuRefreshTimer = null;
function refreshMenuSoon() {
  clearTimeout(menuRefreshTimer);
  menuRefreshTimer = setTimeout(() => { try { installMenu(); } catch { /* no window yet */ } }, 250);
}

/**
 * Canonicalize a path the renderer asked for, refusing a network location
 * before and after the resolution.
 *
 * `fs.realpath()` on `\\host\share\…` already opens an SMB session, so the
 * check has to run on the raw string first; the second one covers a local path
 * that resolves onto a share (junction, mapped drive, symlink).
 */
async function resolveLocalTarget(candidate, message = '不支持指向网络位置的路径。') {
  const text = String(candidate ?? '');
  if (!text) return null;
  if (isNetworkPath(text)) throw new Error(message);
  const resolved = await fs.realpath(text).catch(() => null);
  if (!resolved) return null;
  if (isNetworkPath(resolved)) throw new Error(message);
  return resolved;
}

/**
 * Resolve a path the user asked for (recent file, document link) and make sure
 * it is a regular file inside the workspace boundary rules: an absolute path is
 * accepted, but it is always canonicalised first so a symlink cannot point the
 * editor at something else than what is shown.
 */
async function openPath(file) {
  if (typeof file !== 'string' || !file) throw new Error('文件路径无效。');
  const resolved = await resolveLocalTarget(file, '不支持指向网络位置的文件。');
  if (!resolved) throw new Error('文件不存在。');
  return rememberFile(await store.open(resolved));
}

/**
 * `candidate` after realpath, refused unless it is inside the open folder.
 * Destructive actions pass `allowRoot: false`: renaming or trashing the folder
 * that *is* the workspace would leave the window pointing at nothing.
 */
async function pathInsideRoot(candidate, { allowRoot = true } = {}) {
  if (!root) throw new Error('请先打开文件夹。');
  const resolved = await resolveLocalTarget(candidate || root, '不支持指向网络位置的路径。');
  if (!resolved) throw new Error('该文件或文件夹已不存在。');
  if (!inside(root, resolved)) throw new Error('该位置不在已打开的文件夹中。');
  if (!allowRoot && resolved === root) throw new Error('不能对已打开的文件夹本身执行此操作。');
  return resolved;
}

const findDocumentByPath = file => [...store.documents.values()].find(doc => doc.path === file);

/**
 * Move one open document to `target` and update its identity: the same work
 * «重命名 / 移动» does, reused by the file tree so the two can never disagree.
 * Only the assets the document references travel with it, and the old file goes
 * to the trash instead of being deleted outright.
 */
async function moveDocumentFile(doc, target) {
  return saveDocumentFile(doc, target, original => shell.trashItem(original));
}

async function saveDocumentFile(doc, target, moveSource) {
  suppressed.add(doc.id);
  try {
    const result = await store.save(doc.id, target, { migrateAssets: true, moveSource });
    rememberFile(result);
    notified.delete(doc.id);
    (contextStorage.getStore() || primary)?.misses.delete(doc.id);
    return result;
  } finally {
    setTimeout(() => suppressed.delete(doc.id), 1000);
  }
}

/** Collect real files before a folder move so closed documents retain history. */
async function historyPaths(source, target, directory, historyKeys) {
  if (!directory) {
    const from = store.historyKey({ path: source });
    return historyKeys.has(from) ? [{ from, source, target }] : [];
  }
  const records = [];
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    records.push(...await historyPaths(path.join(source, entry.name), path.join(target, entry.name), entry.isDirectory(), historyKeys));
  }
  return records;
}

/**
 * Move one document's file to the trash after asking, keeping unsaved text as a
 * new unsaved document. `confirmText` lets the file tree explain that the entry
 * has unsaved edits before anything is removed.
 */
async function trashDocumentFor(doc) {
  if (!doc.path) return false;
  const message = doc.dirty ? `“${doc.name}”有未保存的修改，仍要移到${TRASH_NAME}？` : `将“${doc.name}”移到${TRASH_NAME}？`;
  const { response } = await dialog.showMessageBox(win, {
    message, detail: doc.dirty ? '当前内容会保留为一个未保存的文档，可以继续编辑或另存为。' : '尚未保存的内容会保留在恢复目录中。',
    buttons: ['取消', `移到${TRASH_NAME}`], defaultId: 0, cancelId: 0
  });
  if (response !== 1) return false;
  await shell.trashItem(doc.path);
  // Keep unsaved text as a new document, and never remove its recovery copy.
  Object.assign(doc, { path: null, version: null, savedContent: '', dirty: !!doc.content });
  await store.recover(doc);
  return store.public(doc);
}
function registerHandlers() {
  handle('bootstrap', async () => {
    // The first window also collects recovery files left by secondary windows
    // from a previous crashed session. Live secondary windows keep separate
    // directories, so their active recovery records are never stolen.
    const context = contextStorage.getStore() || primary;
    const recovered = await store.recoverAll(store === primary?.store, {
      isDocumentOpen: id => liveContexts().some(context => context.store !== store && context.store.documents.has(id))
    });
    // Session restore runs before any command-line document, for the first
    // window only, and never for a file whose unsaved draft was just recovered
    // (the recovery copy takes priority and the file must not open twice).
    let restored = { folder: null, entries: null, active: null };
    if (preferences.restoreSession && context === primary) {
      const session = await workspace.restorableSession();
      if (session.folder) {
        root = session.folder;
        restored.folder = session.folder;
        restored.entries = await listMarkdown(session.folder).catch(() => []);
      }
      restored.documents = [];
      for (const file of session.files) {
        if (store.recoveredPaths?.has(file)) continue;
        try { restored.documents.push(rememberFile(await store.open(file))); } catch { /* silently skip a vanished file */ }
      }
      restored.active = session.active;
    }
    const opened = [];
    for (const file of pendingFiles.splice(0)) { try { opened.push(rememberFile(await store.open(file))); } catch {} }
    return {
      documents: [...recovered, ...(restored.documents || []), ...opened], preferences, platform: process.platform, recoveryCount: recovered.length,
      // A document named on the command line / by a double click is activated
      // after the session has been restored.
      session: {
        path: restored.folder, name: restored.folder ? path.basename(restored.folder) : null,
        entries: restored.entries, activePath: opened.at(-1)?.path || restored.active || null
      },
      // The renderer sizes the topbar and keeps its controls clear of the
      // native window buttons (Windows / Linux overlay) or the traffic lights.
      titleBar: {
        overlay: !MAC, height: TITLE_BAR_HEIGHT, controlsWidth: windowControlsWidth(), trashName: TRASH_NAME
      }
    };
  });
  handle('capabilities', async () => ({ ...(await pandoc()), platform: process.platform }));
  handle('appMenu', point => showAppMenu(point));
  handle('newWindow', () => { createWindow(); return true; });
  handle('newDocument', (content, name) => {
    // The welcome page is created by the renderer with its own title and as an
    // unmodified document, so closing it never asks to save.
    const safeName = typeof name === 'string' && name.trim() && name.length <= 200 ? name.trim() : null;
    return store.create(content || '', null, safeName ? { name: safeName, dirty: false } : {});
  });
  handle('openDocument', chooseOpen);
  handle('openPath', file => openPath(file));
  handle('openFolder', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    root = await fs.realpath(result.filePaths[0]);
    workspace.recordFolder(root);
    refreshMenuSoon();
    const context = contextStorage.getStore() || primary;
    if (context) context.searchToken = null;
    return { path: root, name: path.basename(root), entries: rememberFolderEntries(await listMarkdown(root)) };
  });
  handle('openFolderPath', async folder => {
    const resolved = await resolveLocalTarget(folder, '不支持打开网络位置的文件夹。');
    if (!resolved) throw new Error('该文件夹已不存在。');
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error('该路径不是文件夹。');
    root = resolved;
    workspace.recordFolder(root);
    refreshMenuSoon();
    const context = contextStorage.getStore() || primary;
    if (context) context.searchToken = null;
    return { path: root, name: path.basename(root), entries: rememberFolderEntries(await listMarkdown(root)) };
  });
  handle('refreshFolder', async () => {
    if (!root) return null;
    return { path: root, name: path.basename(root), entries: rememberFolderEntries(await listMarkdown(root)) };
  });
  // ── Folder-wide search ──
  handle('searchFolder', async (query, options = {}) => {
    if (!root) throw new Error('请先打开文件夹。');
    const context = contextStorage.getStore() || primary;
    // A new query interrupts the previous one instead of queueing behind it.
    if (context.searchToken) context.searchToken.cancelled = true;
    const token = { cancelled: false };
    context.searchToken = token;
    const overrides = new Map();
    // Unsaved edits are searched as the user sees them, not as the file is on disk.
    if (options.overrides && typeof options.overrides === 'object') {
      for (const [file, content] of Object.entries(options.overrides)) if (typeof content === 'string' && typeof file === 'string') overrides.set(file, content);
    }
    return searchFolder(root, query, {
      caseSensitive: !!options.caseSensitive, regex: !!options.regex,
      token, overrides, maxPerFile: options.maxPerFile, maxResults: options.maxResults
    });
  });
  handle('cancelSearch', () => {
    const context = contextStorage.getStore() || primary;
    if (context.searchToken) context.searchToken.cancelled = true;
    context.searchToken = null;
    return true;
  });
  // ── Recent documents and the restorable session ──
  handle('recentFiles', () => workspace.files());
  handle('clearRecent', () => workspace.clear());
  handle('saveSession', session => { workspace.setSession(session || {}); return true; });
  // ── File-tree operations (all confined to the opened folder) ──
  handle('createEntry', async (parent, name, kind) => {
    const directory = await pathInsideRoot(parent);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error('只能在文件夹中新建文件。');
    // A file gets the extension the rest of the tree uses, so a name typed as
    // “笔记” still opens as Markdown.
    const suggestion = kind === 'folder' || isMarkdownFile(name) ? name : `${String(name ?? '').trim()}.md`;
    const checked = validateEntryName(suggestion);
    if (!checked.ok) throw new Error(checked.error);
    const target = path.join(directory, checked.name);
    if (!inside(root, target)) throw new Error('该位置不在已打开的文件夹中。');
    if (await fs.stat(target).then(() => true).catch(() => false)) throw new Error(`“${checked.name}” 已存在。`);
    if (kind === 'folder') await fs.mkdir(target);
    else await atomicWrite(target, '');
    return { path: target, name: checked.name, kind: kind === 'folder' ? 'folder' : 'file', entries: rememberFolderEntries(await listMarkdown(root)) };
  });
  handle('renameEntry', async (target, name) => {
    const resolved = await pathInsideRoot(target, { allowRoot: false });
    const stat = await fs.stat(resolved);
    // Renaming a file keeps a Markdown extension even when the user leaves it out.
    const suggestion = stat.isDirectory() || isMarkdownFile(name) ? name : `${String(name ?? '').trim()}.md`;
    const checked = validateEntryName(suggestion);
    if (!checked.ok) throw new Error(checked.error);
    const next = path.join(path.dirname(resolved), checked.name);
    if (!inside(root, next)) throw new Error('该位置不在已打开的文件夹中。');
    if (next === resolved) return { kind: stat.isDirectory() ? 'folder' : 'file', path: resolved, entries: rememberFolderEntries(await listMarkdown(root)) };
    if (await fs.stat(next).then(() => true).catch(() => false)) throw new Error(`“${checked.name}” 已存在。`);
    // An open document is moved through the store so its path, tab name and
    // history follow the rename; anything else is a plain filesystem rename.
    if (!stat.isDirectory()) {
      const doc = findDocumentByPath(resolved);
      if (doc) return { kind: 'document', document: await moveDocumentFile(doc, next), entries: rememberFolderEntries(await listMarkdown(root)) };
    }
    const historyKeys = new Set(await fs.readdir(historyDirectory()).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }));
    const history = historyKeys.size ? await historyPaths(resolved, next, stat.isDirectory(), historyKeys) : [];
    await fs.rename(resolved, next);
    // Every document opened from inside a renamed folder keeps pointing at its
    // file: the bytes did not move relative to each other, so the text, the
    // dirty state and the disk version stay valid — only the path changes.
    const documents = [];
    const warnings = [];
    const handled = new Set();
    if (stat.isDirectory()) {
      const affected = [...store.documents.values()].filter(doc => doc.path && inside(resolved, doc.path));
      for (const open of affected) {
        handled.add(store.historyKey(open));
        const moved = await store.rekey(open.id, path.join(next, path.relative(resolved, open.path)));
        warnings.push(...(moved.warnings || []));
        notified.delete(open.id);
        (contextStorage.getStore() || primary)?.misses.delete(open.id);
        documents.push(moved);
      }
    }
    for (const entry of history) {
      if (handled.has(entry.from)) continue;
      try {
        await store.moveHistory(entry.from, store.historyKey({ path: await fs.realpath(entry.target) }));
      } catch (error) {
        warnings.push(`“${path.basename(entry.source)}”的保存历史未迁移：${error.message}`);
      }
    }
    return { kind: stat.isDirectory() ? 'folder' : 'file', from: resolved, to: next, documents, warnings, entries: rememberFolderEntries(await listMarkdown(root)) };
  });
  handle('trashEntry', async target => {
    const resolved = await pathInsideRoot(target, { allowRoot: false });
    const doc = findDocumentByPath(resolved);
    if (doc) {
      const document = await trashDocumentFor(doc);
      if (!document) return null;
      return { kind: 'document', document, entries: rememberFolderEntries(await listMarkdown(root)) };
    }
    const stat = await fs.stat(resolved);
    const { response } = await dialog.showMessageBox(win, {
      message: `将“${path.basename(resolved)}”移到${TRASH_NAME}？`,
      detail: stat.isDirectory() ? '文件夹及其中的内容都会移到' + TRASH_NAME + '。' : '可以稍后从' + TRASH_NAME + '恢复。',
      buttons: ['取消', `移到${TRASH_NAME}`], defaultId: 0, cancelId: 0
    });
    if (response !== 1) return null;
    await shell.trashItem(resolved);
    // Documents opened from that folder lose their file: keep their text as
    // unsaved documents instead of pointing at a path that is gone. The renderer
    // applies the same list, so its tabs cannot keep showing the old path.
    const documents = [];
    if (stat.isDirectory()) {
      for (const open of [...store.documents.values()]) {
        if (!open.path || !inside(resolved, open.path)) continue;
        Object.assign(open, { path: null, version: null, savedContent: '', dirty: !!open.content });
        await store.recover(open);
        documents.push(store.public(open));
      }
    }
    return { kind: stat.isDirectory() ? 'folder' : 'file', path: resolved, documents, entries: rememberFolderEntries(await listMarkdown(root)) };
  });
  handle('revealPath', async target => {
    const resolved = await pathInsideRoot(target);
    shell.showItemInFolder(resolved);
    return true;
  });
  // One native context menu for the file tree. The renderer asks for it and
  // receives the chosen action; naming and confirmations stay in its dialogs.
  handle('fileMenu', (target, isDirectory) => new Promise(resolve => {
    let picked = null;
    const choose = action => () => { picked = { action, path: target, isDirectory: !!isDirectory }; };
    const menu = Menu.buildFromTemplate([
      { label: '新建文件…', click: choose('new-file') },
      { label: '新建文件夹…', click: choose('new-folder') },
      { type: 'separator' },
      { label: '重命名…', click: choose('rename') },
      { label: '在文件夹中显示', click: choose('reveal') },
      { label: '复制路径', click: choose('copy-path') },
      { type: 'separator' },
      { label: `移到${TRASH_NAME}`, click: choose('trash') },
      { label: '刷新文件树', click: choose('refresh') }
    ]);
    menu.popup({ window: win, callback: () => resolve(picked) });
  }));
  // ── Local document links ──
  handle('resolveLink', async (id, reference) => {
    const doc = store.get(id);
    const resolved = await resolveDocumentLink(reference, assetOptions(doc));
    return { path: resolved, name: path.basename(resolved), markdown: isMarkdownFile(resolved) };
  });
  handle('openLocalFile', async target => {
    const resolved = await resolveLocalTarget(target, '不支持打开网络位置的文件。');
    if (!resolved) throw new Error('链接指向的文件不存在。');
    const stat = await fs.stat(resolved);
    // A document may only hand over plain files. A directory would be opened as
    // a folder window, and anything executable would run on one click, so both
    // are refused before the confirmation dialog is even shown.
    if (!stat.isFile()) throw new Error('出于安全考虑，不能从文档中打开可执行文件。');
    if (isExecutableExtension(resolved)) throw new Error('出于安全考虑，不能从文档中打开可执行文件。');
    const { response } = await dialog.showMessageBox(win, {
      message: `用系统默认程序打开“${path.basename(resolved)}”？`,
      detail: resolved, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0
    });
    if (response !== 1) return false;
    const error = await shell.openPath(resolved);
    if (error) throw new Error(error);
    return true;
  });
  handle('updateDocument', (id, content) => store.update(id, content));
  handle('saveDocument', async (id, saveAs = false) => {
    const doc = store.get(id);
    const file = saveAs || !doc.path ? await selectSave(doc) : doc.path;
    return file ? saveDocumentFile(doc, file) : null;
  });
  handle('closeDocument', async (id, includePath = false) => {
    const context = contextStorage.getStore() || primary;
    const doc = store.get(id);
    if (doc.dirty) {
      const result = await dialog.showMessageBox(win, { type: 'question', message: `保存“${doc.name}”的更改？`, buttons: ['保存', '取消', '不保存'], defaultId: 0, cancelId: 1 });
      if (result.response === 1) return false;
      if (result.response === 0) {
        const file = doc.path || await selectSave(doc);
        if (!file) return false;
        await saveDocumentFile(doc, file);
      }
    }
    await store.close(id);
    // Closing an unsaved document (whatever the prompt answer) leaves no images
    // behind that could never be referenced again.
    await removeUnsavedAssets(id);
    notified.delete(id);
    context?.misses.delete(id);
    // Quitting closes documents too, but those must not fill reopen history.
    if (doc.path && context && !context.quitting) context.recentlyClosed.push(doc.path);
    return includePath ? { path: doc.path } : true;
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
    // Windows / Linux: the native window-button overlay follows the paper colour
    // of the selected theme, including custom CSS themes (treated as light).
    if (patch.theme && !MAC) {
      const overlay = titleBarOverlay();
      for (const { win } of contexts.values()) {
        if (!win || win.isDestroyed() || typeof win.setTitleBarOverlay !== 'function') continue;
        win.setTitleBarOverlay(overlay);
        win.setBackgroundColor(overlay.color);
      }
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
    return moveDocumentFile(doc, target);
  });
  handle('trashDocument', async id => trashDocumentFor(store.get(id)));
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
  handle('listHistory', id => store.listHistory(id));
  handle('readHistory', async (dir, name) => store.readHistory(dir, name));
  handle('reloadDocument', async id => {
    const result = await store.reload(id);
    notified.delete(id);
    (contextStorage.getStore() || primary)?.misses.delete(id);
    return result;
  });
  // "Keep local text": adopt the current disk version so the next save may
  // overwrite it instead of being blocked forever.
  handle('acceptExternalChange', async id => {
    const result = await store.acceptDisk(id);
    notified.delete(id);
    (contextStorage.getStore() || primary)?.misses.delete(id);
    return result;
  });
  // "Keep as unsaved document" after the file was deleted elsewhere.
  handle('detachDocument', async id => {
    const result = await store.detach(id);
    notified.delete(id);
    (contextStorage.getStore() || primary)?.misses.delete(id);
    return result;
  });
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
    // Unsaved documents resolve `assets/…` inside their temporary folder.
    const image = nativeImage.createFromBuffer(await fs.readFile(await resolveAsset(doc, src)));
    if (image.isEmpty()) throw new Error('无法读取该图片。');
    clipboard.writeImage(image);
    return true;
  });
  handle('copyImagePath', async (id, src) => {
    const doc = store.get(id);
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
    const context = contextStorage.getStore() || primary;
    // One document per command, and the stack never leaks across windows.
    while (context.recentlyClosed.length) {
      const file = context.recentlyClosed.pop();
      try { return [await store.open(file)]; } catch { /* file may be gone */ }
    }
    return [];
  });
  // Poll instead of fs.watch: our saves atomically replace the file, which
  // invalidates inode-based watchers on some platforms. A file must be missing
  // twice in a row before it counts as deleted, so an atomic replace is not
  // mistaken for a deletion.
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const context of liveContexts()) {
        for (const [id, doc] of context.store.documents) {
          if (!doc.path || doc.version === null || suppressed.has(id)) continue;
          let bytes;
          try { bytes = await fs.readFile(doc.path); }
          catch (error) {
            if (error.code !== 'ENOENT') continue;
            const misses = (context.misses.get(id) || 0) + 1;
            context.misses.set(id, misses);
            if (misses < 2 || notified.get(id) === 'deleted') continue;
            notified.set(id, 'deleted');
            if (!context.win.isDestroyed()) context.win.webContents.send('inkstone:external-change', id, 'deleted');
            continue;
          }
          context.misses.delete(id);
          const current = digest(bytes);
          if (current === doc.version) continue;
          if (notified.get(id) === current) continue;
          notified.set(id, current);
          if (!context.win.isDestroyed()) context.win.webContents.send('inkstone:external-change', id, 'modified');
        }
      }
    } finally { checking = false; }
  }, 2000);
  // The file tree follows the disk as well: a file created, renamed or removed
  // by another program shows up without a manual refresh. Polling the scanned
  // tree is used for the same reason as the document check above — this app
  // writes through atomic renames, which invalidates inode watchers.
  let scanning = false;
  setInterval(async () => {
    if (scanning) return;
    scanning = true;
    try {
      for (const context of liveContexts()) {
        if (!context.root) continue;
        const entries = await listMarkdown(context.root).catch(() => null);
        if (!entries) continue;
        const signature = flattenPaths(entries).join('\n');
        // The first scan only records the baseline of a freshly opened folder.
        if (context.folderSignature === null) { context.folderSignature = signature; continue; }
        if (context.folderSignature === signature) continue;
        context.folderSignature = signature;
        if (!context.win.isDestroyed()) context.win.webContents.send('inkstone:folder-changed', { path: context.root, name: path.basename(context.root), entries });
      }
    } finally { scanning = false; }
  }, 4000);
  handle('insertImage', async (id, payload) => {
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
    // An unsaved document keeps its images in the application's temporary
    // folder until the first save moves them next to the document; either way
    // the editor gets a plain `assets/<file>` reference it can render at once.
    return store.serial(id, async () => {
      const source = resourcePath(store.get(id));
      const folder = path.join(source ? path.dirname(source) : unsavedAssetsFor(id), 'assets');
      await fs.mkdir(folder, { recursive: true });
      const file = `${name.replace(/[^\p{L}\p{N}_-]/gu, '-')}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
      await atomicWrite(path.join(folder, file), bytes);
      return `assets/${file}`;
    });
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
          const { documentId, reference } = parseAssetURL(match[1]);
          if (documentId !== id) continue;
          // The same resolver as the protocol handler: export inlines exactly
          // the files the editor is allowed to display.
          const file = await resolveAssetFile(reference, assetOptions(doc));
          html = html.replaceAll(match[1], `data:${imageMime(file)};base64,${(await fs.readFile(file)).toString('base64')}`);
        } catch { /* An unresolved image stays a visible link in the export. */ }
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
        const resource = resourcePath(doc);
        await run('pandoc', [source, '-f', 'markdown+tex_math_dollars', '--standalone', '--resource-path', resource ? path.dirname(resource) : unsavedAssetsFor(id), '-o', output], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
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
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // Relative paths are resolved against the working directory of the second
    // process, which is what a shell or `start file.md` provides.
    pendingFiles.push(...parseDocumentPaths(argv, workingDirectory || process.cwd()));
    const first = liveContexts()[0];
    if (first) { first.win.show(); first.win.focus(); command('system-open'); }
  });
  app.whenReady().then(async () => {
    try { preferences = { ...preferences, ...JSON.parse(await fs.readFile(settingsPath(), 'utf8')) }; } catch {}
    // Recent documents / folders and the previous session, before any window
    // asks for its bootstrap payload.
    await workspace.load();
    // The menu is built from the recents, so it is installed after loading them.
    installMenu();
    // One-time migration: the old 17px / 760px defaults predate Typora parity.
    if (!preferences.uiDefaultsMigrated && preferences.fontSize === 17 && preferences.lineWidth === 760) {
      preferences = { ...preferences, fontSize: 16, lineWidth: 860, uiDefaultsMigrated: true };
      await atomicWrite(settingsPath(), JSON.stringify(preferences, null, 2)).catch(() => {});
    }
    protocol.handle('inkstone-asset', async request => {
      try {
        const { documentId, reference } = parseAssetURL(request.url);
        // The document id must belong to a live window of this application; the
        // URL alone never grants access to an arbitrary file.
        const context = liveContexts().find(candidate => {
          try { return candidate.store.documents.has(documentId); } catch { return false; }
        });
        if (!context) return new Response('', { status: 404 });
        const doc = context.store.get(documentId);
        const file = await resolveAssetFile(reference, assetOptions(doc));
        return net.fetch(pathToFileURL(file).href);
      } catch { return new Response('', { status: 404 }); }
    });
    pruneUnsavedAssets().catch(() => {});
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerHandlers(); installMenu();
    handle('drainPending', async () => Promise.all(pendingFiles.splice(0).map(file => store.open(file).then(record => rememberFile(record)))));
    handle('finishQuit', async () => {
      // Only this window is finished. Closing it triggers window-all-closed
      // when it was the last one, so other windows keep their save prompts.
      const context = contextStorage.getStore() || primary;
      if (!context) return true;
      await workspace.writing;
      await workspace.flush();
      context.allowClose = true;
      settleQuit(context, 'saved');
      if (!context.win.isDestroyed()) context.win.close();
      return true;
    });
    handle('quitAck', () => {
      // The renderer is alive and will show its own save prompts.
      acknowledgeQuit(contextStorage.getStore() || primary);
      return true;
    });
    handle('cancelQuit', () => {
      // The user cancelled a save prompt: keep every window open.
      settleQuit(contextStorage.getStore() || primary, 'cancel');
      return true;
    });
    createWindow();
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  // Route every quit (dock, menu, Alt+F4) through the per-window loop so all
  // save prompts are asked; a cancel aborts the whole quit.
  if (quitSequence || !liveContexts().length) return;
  event.preventDefault();
  quitAllWindows();
});
