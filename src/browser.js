// Development preview only. Native filesystem features are implemented in Electron.
export function browserBridge() {
  const docs = new Map();
  const create = content => {
    const doc = { id: crypto.randomUUID(), content, name: '未命名.md', path: null, dirty: !!content };
    docs.set(doc.id, doc); return { ...doc };
  };
  const unavailable = () => { throw new Error('此功能需要桌面版。请运行 npm start。'); };
  const download = (content, name, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const actions = {
    bootstrap: () => ({ documents: [], preferences: { theme: 'light', fontSize: 17, lineWidth: 760, autoSave: false, focus: false, typewriter: false, spellcheck: true, mathNumbering: false, headingNumbering: false, sidebarWidth: 240, zoomLevel: 0, windowBounds: null, windowMaximized: false, showFormatbar: true }, platform: navigator.platform.includes('Mac') ? 'darwin' : 'win32' }),
    newDocument: create,
    updateDocument(id, content) { const doc = docs.get(id); doc.content = content; doc.dirty = true; return { ...doc }; },
    async openDocument() {
      return new Promise(resolve => {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.md,.markdown,.txt'; input.multiple = true;
        input.oncancel = () => resolve([]);
        input.onchange = async () => {
          const opened = [];
          for (const file of input.files) { const doc = create(await file.text()); doc.name = file.name; doc.dirty = false; Object.assign(docs.get(doc.id), doc); opened.push(doc); }
          resolve(opened);
        };
        input.click();
      });
    },
    saveDocument(id) { const doc = docs.get(id); download(doc.content, doc.name, 'text/markdown'); doc.dirty = false; return { ...doc }; },
    closeDocument(id) { const doc = docs.get(id); if (doc.dirty && !confirm('关闭此文档？浏览器预览中的未保存内容会丢失。')) return false; docs.delete(id); return true; },
    settings: patch => patch,
    openExternal: url => { if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
    exportDocument(id, format, html) {
      if (format !== 'html' && format !== 'pdf') return unavailable();
      if (format === 'pdf') { window.print(); return '打印对话框'; }
      const name = docs.get(id).name.replace(/\.[^.]+$/, '') + '.html'; download(html, name, 'text/html'); return name;
    },
    openFolder: unavailable, refreshFolder: () => null, insertImage: unavailable, importDocument: unavailable,
    revealDocument: unavailable, renameDocument: unavailable, trashDocument: unavailable, history: unavailable,
    drainPending: () => [], finishQuit: () => {},
    listThemes: () => [], readTheme: () => '', openThemesFolder: unavailable,
    listHistory: () => [], readHistory: unavailable, reloadDocument: unavailable,
    zoom: () => {}, fullscreen: () => {}, reopenClosed: () => [],
    writeClipboard: ({ text, html }) => {
      if (html && navigator.clipboard?.write) return navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      return navigator.clipboard?.writeText(text) ?? Promise.resolve();
    },
    readClipboardText: () => navigator.clipboard?.readText() ?? Promise.resolve(''),
    capabilities: () => ({ installed: false, version: null, platform: navigator.platform }),
    copyImage: unavailable, copyImagePath: unavailable, newWindow: () => { window.open(location.href, '_blank'); return true; },
  };
  const bridge = Object.fromEntries(Object.entries(actions).map(([key, fn]) => [key, async (...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error: error.message }; }
  }]));
  bridge.onCommand = () => {};
  bridge.onExternalChange = () => {};
  return bridge;
}
