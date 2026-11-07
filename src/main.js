import './styles.css';
import 'katex/dist/katex.min.css';
import { createEditor } from './editor.js';
import { escapeHTML, headings, statistics, renderMarkdown, renderDiagrams, refreshDiagrams } from './markdown.js';
import { parseTables, serializeTable, setCell, insertRow, removeRow, insertColumn, removeColumn, setAlignment, columnWidthEdit } from './table.js';
import { diffHTML } from './diff.js';
import { parseSections, moveSection } from './outline.js';
import { welcome } from './welcome.js';
import { browserBridge } from './browser.js';
import { EMOJI } from './emoji.js';

const native = !!window.desktop;
const bridge = window.desktop || browserBridge();
const documents = new Map();
let activeId, folder, prefs, sideMode = 'outline', sourceMode = false, busy = false;
let customThemes = [], selectedHistory = null, externalId = null, lastThemeKey = null;
let capabilities = { installed: false, version: null, platform: '' }, imageContext = null;
let pendingTable = null, quickFiles = [];
const $ = selector => document.querySelector(selector);
const icons = {
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  arrow: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v6h16v-6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  moon: '<path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  focus: '<path d="M3 8V3h5m8 0h5v5m0 8v5h-5m-8 0H3v-5"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>'
};
const icon = name => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const button = (command, label, glyph) => `<button class="icon-button" data-command="${command}" aria-label="${label}" title="${label}">${icon(glyph)}</button>`;

$('#app').innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">墨</span><span>墨页 <small>INKSTONE</small></span></div>
    <div class="top-actions">${button('sidebar', '切换侧边栏', 'panel')}${button('new', '新建文档', 'plus')}${button('open', '打开文档', 'folder')}</div>
    <div class="document-location" id="location">未命名.md</div>
    <div class="top-actions">${button('find', '查找与替换', 'search')}${button('source', '切换源码模式', 'code')}${button('save', '保存文档', 'save')}<button class="export-button" data-command="export">${icon('arrow')}<span>导出</span></button>${button('settings', '偏好设置', 'settings')}</div>
  </header>
  <div class="workspace">
    <aside class="sidebar" aria-label="文件与大纲">
      <div class="sidebar-tabs" role="tablist"><button role="tab" data-side="outline" aria-selected="true">大纲</button><button role="tab" data-side="files" aria-selected="false">文件</button><button role="tab" data-side="articles" aria-selected="false">文章</button></div>
      <div class="sidebar-context"><span id="side-title">文档结构</span>${button('folder', '打开文件夹', 'folder')}</div>
      <label class="filter-label" hidden><span class="sr-only">筛选文件</span><input id="file-filter" placeholder="筛选文件…" type="search"></label>
      <nav id="side-content" aria-label="文档大纲"></nav>
      <div class="sidebar-footer"><button data-command="help">使用说明 <span>↗</span></button><span>${native ? '本地工作空间' : '浏览器开发预览'}</span></div>
    </aside>
    <div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-label="调整侧边栏宽度"></div>
    <main class="main-pane">
      <div class="tabbar"><div id="document-tabs" role="tablist" aria-label="打开的文档"></div>${button('new', '新建文档', 'plus')}${button('document-menu', '文档操作', 'more')}</div>
      <div class="formatbar" role="toolbar" aria-label="排版工具">
        <button data-command="heading-1" title="一级标题">H1</button><button data-command="heading-2" title="二级标题">H2</button><span class="divider"></span><button data-command="bold" aria-label="粗体"><b>B</b></button><button data-command="italic" aria-label="斜体"><i>I</i></button><button data-command="strike" aria-label="删除线"><s>S</s></button><button data-command="inline-code" aria-label="行内代码">&lt;/&gt;</button><span class="divider"></span><button data-command="link">链接</button><button data-command="table">表格</button><button data-command="code">代码</button><button data-command="math">公式</button><button data-command="diagram">图表</button>${button('image', '插入图片', 'image')}<span class="format-spacer"></span><span id="mode-label">即时渲染</span>
      </div>
      <div id="editor-host"></div>
      <footer class="statusbar"><span id="save-status" role="status">就绪</span><span id="breadcrumb" class="status-breadcrumb"></span><span class="status-spacer"></span><span id="selection-status"></span><span id="position">行 1，列 1</span><span id="statistics"></span><span id="encoding"></span><button data-command="focus" title="专注模式" aria-label="专注模式">${icon('focus')}</button><button data-command="theme" title="切换主题" aria-label="切换主题">${icon('moon')}</button></footer>
    </main>
  </div>
  <div id="notification" role="alert" hidden></div>
  <div id="context-menu" class="context-menu" role="menu" hidden></div>
  <dialog id="dialog" aria-labelledby="dialog-title"><div id="dialog-content"></div></dialog>
  <article class="print-document prose" id="print-document"></article>
`;

function notify(message, error = false) {
  const node = $('#notification'); node.textContent = message; node.classList.toggle('error', error); node.hidden = false;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => { node.hidden = true; }, error ? 10000 : 4500);
}
async function api(name, ...args) {
  const result = await bridge[name](...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const current = () => documents.get(activeId);
async function flush(doc = current()) {
  if (!doc) return;
  clearTimeout(doc.timer);
  await api('updateDocument', doc.id, doc.content);
}
function updateChrome() {
  const doc = current(); if (!doc) return;
  document.title = `${doc.dirty ? '• ' : ''}${doc.name} — 墨页`;
  $('#location').textContent = doc.path || doc.name;
  $('#location').title = doc.path || doc.name;
  $('#save-status').textContent = doc.error ? doc.error : doc.dirty ? '有未保存的更改' : doc.path ? '已保存' : '未保存到文件';
  $('#save-status').classList.toggle('status-error', !!doc.error);
  $('#document-tabs').innerHTML = [...documents.values()].map(d => `<div class="document-tab ${d.id === activeId ? 'active' : ''}"><button role="tab" aria-selected="${d.id === activeId}" data-document="${d.id}" title="${escapeHTML(d.path || d.name)}">${icon('file')}<span>${escapeHTML(d.name)}</span>${d.dirty ? '<span class="dirty-mark" aria-label="未保存">●</span>' : ''}</button><button class="close-tab" data-close="${d.id}" aria-label="关闭 ${escapeHTML(d.name)}">${icon('close')}</button></div>`).join('');
}
function updateStats() {
  const doc = current(); if (!doc) return;
  const stats = statistics(doc.content);
  $('#statistics').textContent = `${stats.words} 字词 · ${stats.characters} 字符`;
  $('#statistics').title = `${stats.lines} 行 · 不含空格 ${stats.nonWhitespace} 字符 · 约 ${stats.minutes} 分钟阅读`;
  $('#encoding').textContent = `UTF-8${doc.content.startsWith('\uFEFF') ? ' BOM' : ''} · ${doc.content.includes('\r\n') ? 'CRLF' : 'LF'}`;
}
function drawSidebar() {
  const container = $('#side-content');
  $('.filter-label').hidden = sideMode !== 'files' && sideMode !== 'articles';
  $('#side-title').textContent = sideMode === 'outline' ? '文档结构' : sideMode === 'articles' ? '全部文章' : (folder?.name || '文件工作空间');
  for (const el of document.querySelectorAll('[data-side]')) el.setAttribute('aria-selected', String(el.dataset.side === sideMode));
  if (sideMode === 'articles') {
    const query = $('#file-filter').value.toLowerCase();
    const articles = folder ? flattenFiles(folder.entries) : [];
    const opened = [...documents.values()].filter(d => !d.path).map(d => ({ name: d.name, path: '', recent: true }));
    const all = [...opened, ...articles.map(a => ({ ...a, recent: false }))];
    const matches = all.filter(a => !query || a.name.toLowerCase().includes(query));
    container.setAttribute('aria-label', '文章列表');
    container.innerHTML = matches.length
      ? matches.map(a => `<button class="article-item ${a.recent ? 'unsaved' : ''} ${a.path && a.path === current()?.path ? 'current' : ''}" ${a.path ? `data-path="${escapeHTML(a.path)}"` : 'disabled'}><strong>${escapeHTML(a.name.replace(/\.(md|markdown|mdown|txt)$/i, ''))}</strong><span>${a.recent ? '未保存的文档' : escapeHTML(a.path.replace(/[\\/][^\\/]*$/, ''))}</span></button>`).join('')
      : '<div class="empty-state"><p>还没有文章</p><small>打开一个文件夹，即可在这里浏览全部 Markdown 文档。</small><button class="primary" data-command="folder">打开文件夹</button></div>';
  } else if (sideMode === 'outline') {
    const content = current()?.content || '';
    const outline = headings(content);
    const { owners } = parseSections(content);
    container.setAttribute('aria-label', '文档大纲');
    container.innerHTML = outline.length ? outline.map((h, index) => `<button class="outline-item level-${h.level}" data-line="${h.line}" data-section="${owners[index] ?? index}" draggable="true" title="拖动可重排整个章节" style="--indent:${Math.max(0, h.level - 1) * 12}px"><span>${escapeHTML(h.title)}</span></button>`).join('') : '<div class="empty-state"><p>还没有标题</p><small>输入 # 加空格，为文档建立结构。</small></div>';
  } else {
    const query = $('#file-filter').value.toLowerCase();
    const renderEntries = (entries, depth = 0) => entries.map(entry => {
      if (entry.children) {
        const children = renderEntries(entry.children, depth + 1);
        return children ? `<details open><summary style="padding-left:${12 + depth * 12}px">${icon('folder')}${escapeHTML(entry.name)}</summary>${children}</details>` : '';
      }
      if (query && !entry.name.toLowerCase().includes(query)) return '';
      return `<button class="file-item" style="padding-left:${12 + depth * 12}px" data-path="${escapeHTML(entry.path)}">${icon('file')}<span>${escapeHTML(entry.name)}</span></button>`;
    }).join('');
    container.setAttribute('aria-label', '文件列表');
    container.innerHTML = folder ? renderEntries(folder.entries) || '<div class="empty-state">没有匹配的 Markdown 文件</div>' : '<div class="empty-state"><p>让文件留在自己的位置</p><small>打开一个文件夹，浏览其中的 Markdown 文档。</small><button class="primary" data-command="folder">打开文件夹</button></div>';
  }
}
let outlineCache = { key: '', items: [] };
function outlineFor(content) {
  if (outlineCache.key !== content) outlineCache = { key: content, items: headings(content) };
  return outlineCache.items;
}
function selectionChanged(update) {
  if (update.view !== current()?.editor.view) return;
  const state = update.state, range = state.selection.main;
  const pos = range.head, line = state.doc.lineAt(pos);
  $('#position').textContent = `行 ${line.number}，列 ${pos - line.from + 1}`;
  $('#selection-status').textContent = range.empty ? '' : `已选 ${[...state.sliceDoc(range.from, range.to)].length} 字`;
  const section = outlineFor(current()?.content || '').reduce((found, item) => item.line <= line.number ? item.title : found, '');
  $('#breadcrumb').textContent = section ? `§ ${section}` : '';
  // Only a naked caret should recentre the viewport. Recentring on a growing
  // selection makes drag-select fight the scrolling underneath the pointer.
  if (prefs?.typewriter && update.selectionSet && update.state.selection.main.empty) queueMicrotask(() => { if (update.view.dom.isConnected) update.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); });
}
// Imported here to keep the editor implementation's public API small.
import { EditorView } from '@codemirror/view';

async function addDocument(record) {
  if (documents.has(record.id)) { activate(record.id); return; }
  const doc = { ...record, savedContent: record.dirty ? '' : record.content };
  documents.set(doc.id, doc);
  const mount = document.createElement('div'); mount.className = 'editor-mount';
  doc.mount = mount;
  doc.editor = createEditor(mount, doc, content => {
    doc.content = content; doc.dirty = content !== doc.savedContent; doc.error = '';
    clearTimeout(doc.timer);
    doc.timer = setTimeout(async () => {
      try {
        await flush(doc);
        if (prefs.autoSave && doc.path && doc.dirty) await save(doc);
      } catch (error) { doc.error = '保存失败'; notify(error.message, true); }
      updateChrome();
    }, 500);
    updateChrome();
    clearTimeout(doc.statsTimer); doc.statsTimer = setTimeout(() => { if (doc.id === activeId) { updateStats(); drawSidebar(); } }, 180);
  }, selectionChanged, command => runCommand(command), file => insertImage(file));
  doc.editor.setSpellcheck(prefs.spellcheck);
  activate(doc.id);
}
function activate(id) {
  activeId = id;
  const doc = current();
  $('#editor-host').replaceChildren(doc.mount);
  doc.editor.setSource(sourceMode);
  doc.editor.view.requestMeasure();
  updateChrome(); updateStats(); drawSidebar();
}
async function save(doc = current(), saveAs = false) {
  if (!doc || doc.saving) return;
  doc.saving = true;
  try {
    await flush(doc);
    const saved = await api('saveDocument', doc.id, saveAs);
    if (!saved) return;
    doc.path = saved.path; doc.name = saved.name; doc.savedContent = saved.content;
    doc.dirty = doc.content !== saved.content; doc.error = '';
    if (doc.dirty) await flush(doc);
    doc.editor.view.dispatch({ effects: [] });
    if (folder) { folder = await api('refreshFolder'); drawSidebar(); }
  } finally { doc.saving = false; updateChrome(); }
}
async function closeDocument(id, createReplacement = true) {
  const doc = documents.get(id); if (!doc) return true;
  await flush(doc);
  if (!await api('closeDocument', id)) return false;
  clearTimeout(doc.timer); clearTimeout(doc.statsTimer); doc.editor.view.destroy(); documents.delete(id);
  if (documents.size) activate([...documents.keys()].at(-1));
  else if (createReplacement) await addDocument(await api('newDocument', ''));
  return true;
}
async function applyCustomTheme(value) {
  const custom = String(value).startsWith('custom:') ? value.slice(7) : '';
  if (!custom) { document.getElementById('custom-theme')?.remove(); return; }
  const css = await api('readTheme', custom);
  const node = document.getElementById('custom-theme') || Object.assign(document.createElement('style'), { id: 'custom-theme' });
  node.textContent = css;
  if (!node.isConnected) document.head.append(node);
}
function applyPreferences() {
  const custom = String(prefs.theme).startsWith('custom:');
  document.documentElement.dataset.theme = custom ? 'light' : prefs.theme;
  document.documentElement.style.setProperty('--editor-size', `${prefs.fontSize}px`);
  document.documentElement.style.setProperty('--editor-width', `${prefs.lineWidth}px`);
  document.documentElement.style.setProperty('--sidebar-width', `${Number(prefs.sidebarWidth) || 240}px`);
  document.body.classList.toggle('focus-mode', prefs.focus);
  document.body.classList.toggle('typewriter-mode', prefs.typewriter);
  document.body.classList.toggle('math-numbering', !!prefs.mathNumbering);
  document.body.classList.toggle('heading-numbering', !!prefs.headingNumbering);
  document.body.classList.toggle('hide-formatbar', prefs.showFormatbar === false);
  applyCustomTheme(prefs.theme).catch(error => notify(error.message, true));
  const themeKey = custom ? prefs.theme : String(prefs.theme);
  if (lastThemeKey !== null && lastThemeKey !== themeKey) refreshDiagrams(document).catch(() => {});
  lastThemeKey = themeKey;
  for (const doc of documents.values()) doc.editor.setSpellcheck(prefs.spellcheck);
}
async function setPreferences(patch) { prefs = { ...prefs, ...patch }; applyPreferences(); await api('settings', patch); }
function dialogContent(title, body) {
  $('#dialog-content').innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-dismiss aria-label="关闭对话框">${icon('close')}</button></div>${body}`;
}
function showDialog(title, body) {
  dialogContent(title, body);
  $('#dialog').showModal();
}
const flattenFiles = entries => entries.flatMap(entry => entry.children ? flattenFiles(entry.children) : [entry]);
const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
// One palette for both files and actions: quicker than hunting through menus,
// and it doubles as a discoverable shortcut reference.
const PALETTE_COMMANDS = [
  ['新建文档', 'new', '文件', `${modKey}N`],
  ['新建窗口', 'new-window', '文件', `${modKey}⇧N`],
  ['打开文档…', 'open', '文件', `${modKey}O`],
  ['打开文件夹…', 'folder', '文件', `${modKey}⇧O`],
  ['保存', 'save', '文件', `${modKey}S`],
  ['另存为…', 'save-as', '文件', `${modKey}⇧S`],
  ['导出…', 'export', '文件', `${modKey}⇧E`],
  ['查看保存历史', 'history', '文件', ''],
  ['重新打开已关闭文件', 'reopen-closed', '文件', `${modKey}⇧T`],
  ['查找与替换', 'find', '编辑', `${modKey}F`],
  ['复制为 Markdown', 'copy-markdown', '编辑', `${modKey}⇧C`],
  ['复制为 HTML', 'copy-html', '编辑', ''],
  ['粘贴为纯文本', 'paste-plain', '编辑', `${modKey}⇧V`],
  ['清除格式', 'clear-format', '编辑', `${modKey}\\`],
  ['插入表格', 'table', '段落', `${modKey}T`],
  ['表格图形化编辑…', 'edit-table', '段落', ''],
  ['插入表情…', 'emoji', '编辑', ''],
  ['插入代码块', 'code', '段落', `${modKey}⇧K`],
  ['插入公式块', 'math', '段落', `${modKey}⇧M`],
  ['插入文内目录', 'toc', '段落', ''],
  ['插入图片…', 'image', '段落', ''],
  ['源码模式', 'source', '视图', `${modKey}/`],
  ['切换侧边栏', 'sidebar', '视图', `${modKey}⇧L`],
  ['大纲面板', 'panel-outline', '视图', ''],
  ['文件树面板', 'panel-files', '视图', ''],
  ['文章列表面板', 'panel-articles', '视图', ''],
  ['专注模式', 'focus', '视图', 'F8'],
  ['打字机模式', 'typewriter', '视图', 'F9'],
  ['切换主题', 'theme', '视图', ''],
  ['偏好设置…', 'settings', '视图', `${modKey},`],
  ['使用说明', 'help', '帮助', '']
].map(([label, command, group, keys]) => ({ label, command, group, keys }));
let quickIndex = 0;
const quickItems = () => [...document.querySelectorAll('#quick-results .quick-item')];
function highlightQuick() {
  const items = quickItems();
  quickIndex = Math.max(0, Math.min(items.length - 1, quickIndex));
  items.forEach((el, index) => el.classList.toggle('selected', index === quickIndex));
  items[quickIndex]?.scrollIntoView({ block: 'nearest' });
}
function quickOpenResults(query = '') {
  const node = $('#quick-results'); if (!node) return;
  const needle = query.trim().toLowerCase();
  const commands = PALETTE_COMMANDS.filter(c => !needle || c.label.toLowerCase().includes(needle) || c.group.includes(needle)).slice(0, 14);
  const files = quickFiles.filter(file => !needle || file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle)).slice(0, 20);
  const rows = [
    ...commands.map(c => `<button class="quick-item" data-quick-command="${c.command}"><strong>${escapeHTML(c.label)}</strong><span>${escapeHTML(c.group)}${c.keys ? ` · ${escapeHTML(c.keys)}` : ''}</span></button>`),
    ...files.map(file => `<button class="quick-item" data-quick-path="${escapeHTML(file.path)}"><strong>${escapeHTML(file.name)}</strong><span>${escapeHTML(file.path)}</span></button>`)
  ];
  node.innerHTML = rows.length ? rows.join('') : '<div class="empty-state"><p>没有匹配项</p><small>输入命令名或文件名；打开文件夹后可以搜索全部 Markdown 文档。</small></div>';
  quickIndex = 0;
  highlightQuick();
}
async function runQuickItem(element) {
  try {
    if (element.dataset.quickPath) for (const doc of await api('openDocument', element.dataset.quickPath)) await addDocument(doc);
    else if (element.dataset.quickCommand) await runCommand(element.dataset.quickCommand);
  } catch (error) { notify(error.message, true); }
}
function collectTableCells() {
  const inputs = [...document.querySelectorAll('[data-cell]')];
  if (!pendingTable || !inputs.length) return;
  for (const input of inputs) {
    const [row, column] = input.dataset.cell.split('-').map(Number);
    pendingTable.table = setCell(pendingTable.table, row, column, input.value);
  }
}
function renderTableDialog() {
  if (!pendingTable) return;
  const table = pendingTable.table;
  const alignLabels = [['', '默认'], ['left', '左对齐'], ['center', '居中'], ['right', '右对齐']];
  const header = table.rows[0].map((cell, column) => `<th><input data-cell="0-${column}" value="${escapeHTML(cell)}" aria-label="表头第 ${column + 1} 列"><button class="table-cell-action" data-table-op="remove-column" data-index="${column}" ${table.aligns.length <= 1 ? 'disabled' : ''} aria-label="删除第 ${column + 1} 列">×</button></th>`).join('');
  const aligns = table.aligns.map((align, column) => `<td><select data-align="${column}" aria-label="第 ${column + 1} 列对齐">${alignLabels.map(([value, label]) => `<option value="${value}" ${align === (value || null) ? 'selected' : ''}>${label}</option>`).join('')}</select></td>`).join('');
  const rows = table.rows.slice(1).map((row, index) => `<tr><th>第 ${index + 1} 行</th>${row.map((cell, column) => `<td><input data-cell="${index + 1}-${column}" value="${escapeHTML(cell)}" aria-label="第 ${index + 1} 行第 ${column + 1} 列"></td>`).join('')}<td><button class="table-cell-action" data-table-op="remove-row" data-index="${index + 1}" aria-label="删除第 ${index + 1} 行">×</button></td></tr>`).join('');
  dialogContent('编辑表格', `<p class="dialog-description">修改单元格、增删行列或设置对齐；应用后只重写这段表格的 Markdown 源码。</p>
    <div class="table-editor-actions"><button data-table-op="add-row">＋ 添加行</button><button data-table-op="add-column">＋ 添加列</button></div>
    <div class="table-editor-scroll"><table class="table-editor"><thead><tr><th></th>${header}<th></th></tr><tr class="table-align-row"><th>对齐</th>${aligns}<th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="dialog-actions"><button data-table-op="cancel">取消</button><button class="primary" data-table-op="apply">应用更改</button></div>`);
}
const selectedSource = () => current()?.editor.selectedText() ?? '';
function tableOperation(op, index) {
  if (op === 'cancel') { pendingTable = null; $('#dialog').close(); return; }
  collectTableCells();
  if (!pendingTable) return;
  if (op === 'apply') {
    const { from, to, table } = pendingTable;
    current()?.editor.replaceRange(from, to, serializeTable(table));
    pendingTable = null;
    $('#dialog').close();
    return;
  }
  if (op === 'add-row') pendingTable.table = insertRow(pendingTable.table);
  if (op === 'remove-row') pendingTable.table = removeRow(pendingTable.table, index);
  if (op === 'add-column') pendingTable.table = insertColumn(pendingTable.table);
  if (op === 'remove-column') pendingTable.table = removeColumn(pendingTable.table, index);
  renderTableDialog();
}
async function insertImage(file) {
  const doc = current(); if (!doc) return;
  try {
    let payload;
    if (file) {
      if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB。');
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      payload = { data, extension: file.type.split('/')[1].replace('jpeg', 'jpg') };
    }
    const relative = await api('insertImage', doc.id, payload);
    if (relative) doc.editor.insert(`![图片](${relative})`);
  } catch (error) { notify(error.message, true); }
}
async function exportDocument(format) {
  const doc = current(); await flush(doc);
  const target = $('#print-document'); target.innerHTML = renderMarkdown(doc.content, doc.id);
  await renderDiagrams(target);
  await document.fonts.ready;
  await Promise.all([...target.querySelectorAll('img')].map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); }));
  const css = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(rule => rule.cssText); } catch { return []; } }).join('\n');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(doc.name)}</title><style>${css}\nbody{overflow:auto!important;display:block!important;height:auto!important;padding:48px!important}.prose{max-width:800px;margin:auto}</style><body><article class="prose">${target.innerHTML}</article></body></html>`;
  const result = await api('exportDocument', doc.id, format, html);
  if (result) notify(`已导出：${result}`);
}
async function runCommand(command, detail) {
  const editor = current()?.editor;
  try {
    if (command.startsWith('heading-')) { editor?.prefix('#'.repeat(Number(command.slice(-1))) + ' '); return; }
    const wrap = { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], 'inline-code': ['`', '`'], link: ['[', '](https://)', '链接文字'] };
    if (wrap[command]) { editor?.wrap(...wrap[command]); return; }
    const inserts = { code: '\n```typescript\n\n```\n', math: '\n$$\nE = mc^2\n$$\n', table: '\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n', diagram: '\n```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```\n', toc: '\n[TOC]\n' };
    if (inserts[command]) { editor?.insert(inserts[command]); return; }
    const simple = {
      'paragraph': () => editor?.heading(0),
      'heading-up': () => editor?.heading(-1),
      'heading-down': () => editor?.heading(1),
      'ordered-list': () => editor?.list('ordered'),
      'unordered-list': () => editor?.list('unordered'),
      indent: () => editor?.indent(),
      outdent: () => editor?.outdent(),
      'select-line': () => editor?.selectLine(),
      'select-scope': () => editor?.selectScope(),
      'delete-line': () => editor?.deleteLine(),
      'delete-word': () => editor?.deleteWord(),
      'jump-top': () => editor?.jumpTop(),
      'jump-bottom': () => editor?.jumpBottom(),
      'jump-to-selection': () => editor?.jumpToSelection(),
      replace: () => editor?.find(),
      'clear-format': () => editor?.clearFormat(),
      underline: () => editor?.wrap('<u>', '</u>', '文字'),
      'copy-markdown': () => api('writeClipboard', { text: selectedSource() }),
      'copy-html': () => api('writeClipboard', { text: selectedSource(), html: renderMarkdown(selectedSource(), activeId) }),
      'paste-plain': async () => { const text = await api('readClipboardText'); editor?.insert(String(text).replace(/\r\n/g, '\n')); },
      'panel-outline': () => { sideMode = 'outline'; document.body.classList.remove('sidebar-hidden'); drawSidebar(); },
      'panel-files': () => { sideMode = 'files'; document.body.classList.remove('sidebar-hidden'); drawSidebar(); },
      'panel-articles': () => { sideMode = 'articles'; document.body.classList.remove('sidebar-hidden'); drawSidebar(); },
      'zoom-in': () => api('zoom', 1),
      'zoom-out': () => api('zoom', -1),
      'zoom-reset': () => api('zoom', 0),
      fullscreen: () => api('fullscreen'),
      'themes-folder': () => api('openThemesFolder'),
      'history-folder': () => api('history'),
      'keep-local': () => { externalId = null; },
      'next-document': () => {
        const ids = [...documents.keys()];
        if (ids.length > 1) activate(ids[(ids.indexOf(activeId) + 1) % ids.length]);
      }
    };
    if (simple[command]) { await simple[command](); return; }
    switch (command) {
      case 'undo': editor?.undo(); break;
      case 'redo': editor?.redo(); break;
      case 'new': await addDocument(await api('newDocument', '')); break;
      case 'new-window': await api('newWindow'); break;
      case 'open': for (const doc of await api('openDocument')) await addDocument(doc); break;
      case 'folder': { const selected = await api('openFolder'); if (selected) { folder = selected; sideMode = 'files'; drawSidebar(); } break; }
      case 'save': await save(); break;
      case 'save-as': await save(current(), true); break;
      case 'close': await closeDocument(activeId); break;
      case 'find': editor?.find(); break;
      case 'source': sourceMode = !sourceMode; editor?.setSource(sourceMode); editor?.view.focus(); $('#mode-label').textContent = sourceMode ? 'Markdown 源码' : '即时渲染'; $('[data-command="source"]').setAttribute('aria-pressed', String(sourceMode)); break;
      case 'sidebar': document.body.classList.toggle('sidebar-hidden'); break;
      case 'focus': await setPreferences({ focus: !prefs.focus }); break;
      case 'typewriter': await setPreferences({ typewriter: !prefs.typewriter }); break;
      case 'theme': await setPreferences({ theme: ['light', 'dark', 'sepia'][(['light', 'dark', 'sepia'].indexOf(prefs.theme) + 1) % 3] }); break;
      case 'quote': editor?.prefix('> '); break;
      case 'task': editor?.prefix('- [ ] '); break;
      case 'image': await insertImage(); break;
      case 'import': { const doc = await api('importDocument'); if (doc) await addDocument(doc); break; }
      case 'export': {
        const external = ['docx', 'odt', 'epub', 'tex', 'rst'];
        const options = ['pdf', 'html', ...external].map(format => {
          const needsPandoc = external.includes(format);
          const locked = needsPandoc && !capabilities.installed;
          return `<button data-export="${format}" ${locked ? 'disabled aria-disabled="true"' : ''}><strong>${format.toUpperCase()}</strong><span>${!needsPandoc ? '直接导出' : locked ? '需要 Pandoc（未安装）' : 'Pandoc 可用'}</span></button>`;
        }).join('');
        const note = capabilities.installed
          ? `已检测到 ${escapeHTML(capabilities.version || 'Pandoc')}，全部格式可用。`
          : '未检测到 Pandoc。DOCX / ODT / EPUB / LaTeX / RST 需要安装 Pandoc（macOS 可执行 <code>brew install pandoc</code>，或访问 pandoc.org/installing.html），安装后重启墨页即可解锁。HTML 与 PDF 始终可用，HTML / TXT / Markdown 也可直接导入。';
        showDialog('导出文档', `<p class="dialog-description">选择要分享的文档格式。</p><div class="export-options">${options}</div><p class="dialog-description">${note}</p>`);
        break;
      }
      case 'settings': {
        customThemes = await api('listThemes');
        const options = [['light', '浅色'], ['dark', '深色'], ['sepia', '纸张'], ...customThemes.map(name => [`custom:${name}`, `自定义 · ${name.replace(/\.css$/i, '')}`])];
        showDialog('偏好设置', `<form id="preferences"><label>外观<select name="theme">${options.map(([value, label]) => `<option value="${escapeHTML(value)}" ${prefs.theme === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label><label>正文字号<input name="fontSize" type="number" min="12" max="30" value="${prefs.fontSize}"></label><label>正文宽度<input name="lineWidth" type="number" min="560" max="1100" step="20" value="${prefs.lineWidth}"></label>${[['autoSave', '自动保存已命名的文件'], ['spellcheck', '拼写检查'], ['focus', '专注模式'], ['typewriter', '打字机模式'], ['mathNumbering', '公式自动编号'], ['headingNumbering', '标题自动编号'], ['showFormatbar', '显示排版工具栏']].map(([key, label]) => `<label class="checkbox-label"><span>${label}</span><input type="checkbox" name="${key}" ${prefs[key] ? 'checked' : ''}></label>`).join('')}<div class="dialog-actions"><button type="button" data-menu-command="themes-folder">打开主题文件夹</button><button class="primary" type="submit">保存设置</button></div></form>`);
        break;
      }
      case 'document-menu': showDialog('文档操作', `<div class="menu-list">${[['save-as', '另存为…'], ['rename', '重命名 / 移动…'], ['reveal', '在系统文件管理器中显示'], ['history', '查看保存历史'], ['toc', '插入文内目录'], ['task', '插入任务项'], ['quote', '插入引用'], ['trash', '移到废纸篓']].map(([key, label]) => `<button data-menu-command="${key}">${label}</button>`).join('')}</div>`); break;
      case 'edit-table': {
        if (!detail?.source) {
          // Invoked from the palette / menu: operate on the table at the caret.
          const head = editor?.caretOffset() ?? 0;
          const tables = parseTables(current()?.content || '');
          const found = tables.find(table => table.start <= head && head <= table.end);
          if (!found) { notify('请先把光标放到表格中，或右键点击表格。', true); break; }
          pendingTable = { from: found.start, to: found.end, table: found };
        } else {
          const tables = parseTables(detail.source);
          const table = tables[detail.index ?? 0];
          if (!table) { notify('未找到可编辑的表格。', true); break; }
          // Widget source is LF-normalized; convert offsets back to real CRLF positions.
          const extra = detail.eolExtra || 0;
          const toDoc = offset => detail.from + offset + extra * (detail.source.slice(0, offset).split('\n').length - 1);
          pendingTable = { from: toDoc(table.start), to: toDoc(table.end), table };
        }
        renderTableDialog();
        if (!$('#dialog').open) $('#dialog').showModal();
        break;
      }
      case 'focus-table-cell': editor?.focusTableCell(detail); break;
      case 'emoji': {
        const rows = EMOJI.map(([code, glyph]) => `<button class="emoji-item" data-emoji="${escapeHTML(glyph)}" title="${escapeHTML(code)}" aria-label="${escapeHTML(code)}">${escapeHTML(glyph)}</button>`).join('');
        showDialog('插入表情', `<p class="dialog-description">正文中输入 <code>:smile:</code> 会自动补全为表情；也可以在这里直接挑选。</p><label class="quick-filter"><span class="sr-only">搜索表情</span><input id="emoji-filter" type="search" placeholder="搜索表情名称…" autocomplete="off"></label><div class="emoji-grid" id="emoji-grid">${rows}</div>`);
        $('#emoji-filter').focus();
        break;
      }
      case 'quick-open': {
        const info = folder ? await api('refreshFolder') : null;
        const files = info ? flattenFiles(info.entries) : [];
        const opened = [...documents.values()].filter(doc => doc.path).map(doc => ({ name: doc.name, path: doc.path }));
        quickFiles = [...new Map([...opened, ...files].map(file => [file.path, file])).values()];
        showDialog('命令面板', '<label class="quick-filter"><span class="sr-only">搜索命令或文件</span><input id="quick-filter" type="search" placeholder="搜索命令或文件…" autocomplete="off"></label><div class="menu-list quick-list" id="quick-results"></div><p class="palette-hint">↑ ↓ 选择 · Enter 执行 · Esc 关闭</p>');
        quickOpenResults();
        $('#quick-filter').focus();
        break;
      }
      case 'rename': { await flush(); const result = await api('renameDocument', activeId); if (result) { const doc = current(); doc.path = result.path; doc.name = result.name; doc.savedContent = result.content; doc.dirty = doc.content !== result.content; updateChrome(); } break; }
      case 'reveal': await api('revealDocument', activeId); break;
      case 'history': {
        const entries = await api('listHistory', activeId);
        selectedHistory = null;
        const list = entries.length
          ? entries.map(entry => `<button class="history-item" data-history="${escapeHTML(entry.name)}"><strong>${escapeHTML(entry.label)}</strong><span>${escapeHTML(entry.name.split('-').slice(2).join('-'))}</span></button>`).join('')
          : '<div class="empty-state"><p>暂无历史版本</p><small>对已保存文档做修改并再次保存时，会自动保留上一版本。</small></div>';
        showDialog('保存历史', `<p class="dialog-description">选择版本可预览内容；恢复会替换当前文档并标记为未保存，确认后请自行保存。</p><div class="history-list">${list}</div><pre class="history-preview" id="history-preview" hidden></pre><div class="dialog-actions"><button data-menu-command="history-folder">在文件管理器中查看</button><button id="compare-history" data-menu-command="compare-history" disabled>与当前版本对比</button><button class="primary" id="restore-history" data-menu-command="restore-history" disabled>恢复此版本</button></div>`);
        break;
      }
      case 'restore-history': {
        if (!selectedHistory) break;
        const content = await api('readHistory', selectedHistory);
        current()?.editor.setContent(content);
        selectedHistory = null;
        break;
      }
      case 'compare-history': {
        if (!selectedHistory) break;
        const previous = await api('readHistory', selectedHistory);
        const now = current()?.content || '';
        showDialog('版本对比', `<p class="dialog-description">− 表示历史版本独有，+ 表示当前版本新增。差异按行计算，可直接看到改动位置。</p>${diffHTML(previous, now)}<div class="dialog-actions"><button data-menu-command="history">返回历史列表</button><button class="primary" data-dismiss>关闭</button></div>`);
        break;
      }
      case 'reload-external': {
        if (!externalId) break;
        const record = await api('reloadDocument', externalId);
        const doc = documents.get(externalId);
        if (doc && record) {
          doc.savedContent = record.content;
          doc.editor.setContent(record.content);
          updateChrome(); updateStats(); drawSidebar();
        }
        externalId = null;
        break;
      }
      case 'reopen-closed': for (const doc of await api('reopenClosed')) await addDocument(doc); break;
      case 'trash': { await flush(); const result = await api('trashDocument', activeId); if (result) { Object.assign(current(), result, { savedContent: '' }); updateChrome(); } break; }
      case 'help': showDialog('写作从这里开始', '<div class="help-text"><p>输入 Markdown。离开当前段落后，文字会显示排版；点击排版内容可以继续编辑。正在编辑的段落也保持排版外观，只有把光标移到 <code>#</code>、<code>**</code> 等语法字符旁边时，它们才会显现以便修改。</p><p><kbd>⌘ / Ctrl + S</kbd> 保存 · <kbd>⌘ / Ctrl + F</kbd> 查找与替换 · <kbd>⌘ / Ctrl + /</kbd> 源码模式。</p><p>单击表格单元格即可直接输入，<kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> 在单元格间跳转，<kbd>Enter</kbd> 新增一行；拖动表头右边缘可调整列宽并随文档保存。右键或 <kbd>Alt</kbd> + 单击表格可打开图形化编辑器，命令面板中也能搜索「表格图形化编辑」。</p><p>图片会复制到文档旁的 assets 文件夹。文件保存时会检查磁盘版本，避免覆盖其他程序的修改。</p><p>HTML、PDF 可直接导出，其他格式需要系统中安装 Pandoc。</p><p>已支持整篇上下文渲染（脚注、引用式链接、文内目录、YAML 属性、警示块）、点击排版内容定位到源码字符、跨块拖选、复制为 Markdown / HTML、命令面板、文章列表、自定义 CSS 主题、公式与标题编号、保存历史与外部修改提示。按 ⌘/Ctrl+P 打开命令面板，可搜索命令与文件；双击图片可放大查看；代码块右上角可一键复制。Windows 实机、真实中文输入法和发行签名仍需专项验收。</p></div>'); break;
      case 'system-open': for (const doc of await api('drainPending')) await addDocument(doc); break;
      case 'quit':
        for (const id of [...documents.keys()]) if (!await closeDocument(id, false)) return;
        await api('finishQuit'); break;
    }
  } catch (error) { notify(error.message, true); }
}

document.addEventListener('click', async event => {
  const command = event.target.closest('[data-command]'); if (command) { await runCommand(command.dataset.command); return; }
  const tableOp = event.target.closest('[data-table-op]');
  if (tableOp) { tableOperation(tableOp.dataset.tableOp, Number(tableOp.dataset.index)); return; }
  const copy = event.target.closest('[data-copy-code]');
  if (copy) {
    const code = copy.closest('pre')?.querySelector('code')?.textContent || '';
    try {
      await api('writeClipboard', { text: code });
      copy.textContent = '已复制';
      notify('代码已复制到剪贴板');
      setTimeout(() => { if (copy.isConnected) copy.textContent = '复制'; }, 1600);
    } catch (error) { notify(error.message, true); }
    return;
  }
  const quick = event.target.closest('[data-quick-path], [data-quick-command]');
  if (quick) { $('#dialog').close(); await runQuickItem(quick); return; }
  const emoji = event.target.closest('[data-emoji]');
  if (emoji) { $('#dialog').close(); current()?.editor.insert(emoji.dataset.emoji); return; }
  const imageAction = event.target.closest('[data-image-action]');
  if (imageAction) {
    $('#context-menu').hidden = true;
    if (!imageContext) return;
    const { src, alt, id, renderedSrc } = imageContext;
    try {
      switch (imageAction.dataset.imageAction) {
        case 'copy-image': await api('copyImage', id, src); notify('图片已复制到剪贴板'); break;
        case 'copy-path': await api('copyImagePath', id, src); notify('图片路径已复制到剪贴板'); break;
        case 'copy-markdown': await api('writeClipboard', { text: `![${alt}](${src})` }); notify('Markdown 图片语法已复制'); break;
        case 'preview': showDialog('图片预览', `<img class="lightbox-image" src="${escapeHTML(renderedSrc)}" alt="${escapeHTML(alt)}">`); break;
      }
    } catch (error) { notify(error.message, true); }
    return;
  }
  const menu = event.target.closest('[data-menu-command]'); if (menu) { $('#dialog').close(); await runCommand(menu.dataset.menuCommand); return; }
  const dismiss = event.target.closest('[data-dismiss]'); if (dismiss) { $('#dialog').close(); return; }
  const historyItem = event.target.closest('[data-history]');
  if (historyItem) {
    try {
      selectedHistory = historyItem.dataset.history;
      const content = await api('readHistory', selectedHistory);
      const preview = $('#history-preview');
      preview.hidden = false;
      preview.textContent = content.slice(0, 4000);
      $('#restore-history').disabled = false;
      $('#compare-history').disabled = false;
      for (const el of document.querySelectorAll('[data-history]')) el.classList.toggle('selected', el === historyItem);
    } catch (error) { notify(error.message, true); }
    return;
  }
  const exported = event.target.closest('[data-export]');
  if (exported) {
    if (busy) return; busy = true; exported.disabled = true; exported.setAttribute('aria-busy', 'true');
    try { await exportDocument(exported.dataset.export); $('#dialog').close(); } catch (error) { notify(error.message, true); } finally { busy = false; exported.disabled = false; exported.removeAttribute('aria-busy'); } return;
  }
  const side = event.target.closest('[data-side]'); if (side) { sideMode = side.dataset.side; drawSidebar(); return; }
  const close = event.target.closest('[data-close]'); if (close) { try { await closeDocument(close.dataset.close); } catch (error) { notify(error.message, true); } return; }
  const tab = event.target.closest('[data-document]'); if (tab) { activate(tab.dataset.document); return; }
  const file = event.target.closest('[data-path]'); if (file) { try { for (const doc of await api('openDocument', file.dataset.path)) await addDocument(doc); } catch (error) { notify(error.message, true); } return; }
  const line = event.target.closest('[data-line]'); if (line) { event.preventDefault(); current()?.editor.jump(Number(line.dataset.line)); return; }
  const anchor = event.target.closest('.prose a');
  if (anchor) {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) {
      const href = anchor.getAttribute('href');
      if (href?.startsWith('#')) {
        const heading = headings(current().content).find(h => h.title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') === decodeURIComponent(href.slice(1)));
        if (heading) current().editor.jump(heading.line);
      } else try { await api('openExternal', anchor.href); } catch (error) { notify(error.message, true); }
    }
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'preferences') return;
  event.preventDefault(); const data = new FormData(event.target);
  const patch = { theme: data.get('theme'), fontSize: Number(data.get('fontSize')), lineWidth: Number(data.get('lineWidth')) };
  for (const key of ['autoSave', 'spellcheck', 'focus', 'typewriter', 'mathNumbering', 'headingNumbering', 'showFormatbar']) patch[key] = data.has(key);
  try { await setPreferences(patch); $('#dialog').close(); } catch (error) { notify(error.message, true); }
});
$('#file-filter').addEventListener('input', drawSidebar);
document.addEventListener('input', event => {
  if (event.target.id === 'quick-filter') quickOpenResults(event.target.value);
  if (event.target.id === 'emoji-filter') {
    const needle = event.target.value.trim().toLowerCase();
    for (const item of document.querySelectorAll('[data-emoji]')) item.hidden = !!needle && !item.title.toLowerCase().includes(needle);
  }
});
document.addEventListener('change', event => {
  const select = event.target.closest?.('[data-align]');
  if (!select || !pendingTable) return;
  collectTableCells();
  pendingTable.table = setAlignment(pendingTable.table, Number(select.dataset.align), select.value || null);
  renderTableDialog();
});
document.addEventListener('inkstone:table-edit', event => runCommand('edit-table', event.detail));
document.addEventListener('inkstone:table-cell', event => runCommand('focus-table-cell', event.detail));
document.addEventListener('inkstone:table-width', event => {
  const doc = current();
  const detail = event.detail;
  if (!doc || !detail) return;
  const tables = parseTables(doc.content);
  const index = tables.findIndex(table => table.start <= detail.absoluteStart && detail.absoluteStart < table.end);
  if (index < 0) return;
  doc.editor.applyChange(columnWidthEdit(doc.content, index, detail.widths));
});
// Command palette keyboard navigation.
document.addEventListener('keydown', event => {
  if (!$('#dialog').open || !$('#quick-results')) return;
  const items = quickItems();
  if (event.key === 'ArrowDown') { event.preventDefault(); quickIndex = Math.min(items.length - 1, quickIndex + 1); highlightQuick(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); quickIndex = Math.max(0, quickIndex - 1); highlightQuick(); }
  else if (event.key === 'Tab' && items.length) { event.preventDefault(); quickIndex = (quickIndex + (event.shiftKey ? -1 : 1) + items.length) % items.length; highlightQuick(); }
  else if (event.key === 'Enter' && items.length) {
    event.preventDefault();
    const chosen = items[quickIndex];
    if (chosen) { $('#dialog').close(); runQuickItem(chosen); }
  }
});
// A draggable divider, like Typora's resizable sidebar.
$('#sidebar-resizer').addEventListener('mousedown', event => {
  if (!prefs) return;
  event.preventDefault();
  const startX = event.clientX, startWidth = Number(prefs.sidebarWidth) || 240;
  let width = startWidth;
  const onMove = move => {
    width = Math.max(180, Math.min(480, startWidth + move.clientX - startX));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    setPreferences({ sidebarWidth: Math.round(width) }).catch(error => notify(error.message, true));
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp, { once: true });
});
$('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) $('#dialog').close(); });
// Right-clicking a rendered image exposes Typora-style copy actions.
document.addEventListener('contextmenu', event => {
  const image = event.target.closest('.md-widget img');
  const menu = $('#context-menu');
  if (!image) { menu.hidden = true; return; }
  event.preventDefault();
  imageContext = {
    src: image.dataset.mdSrc || '', alt: image.alt || '', id: activeId,
    renderedSrc: image.getAttribute('src') || ''
  };
  menu.innerHTML = [
    ['copy-image', '复制图片'], ['copy-path', '复制图片路径'],
    ['copy-markdown', '复制 Markdown 图片语法'], ['preview', '放大预览']
  ].map(([action, label]) => `<button role="menuitem" data-image-action="${action}">${label}</button>`).join('');
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 170)}px`;
  menu.hidden = false;
});
document.addEventListener('mousedown', event => {
  if (!event.target.closest('#context-menu')) $('#context-menu').hidden = true;
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#context-menu').hidden = true; });
document.addEventListener('dblclick', event => {
  const image = event.target.closest('.md-widget img');
  if (!image) return;
  const src = image.getAttribute('src') || '';
  showDialog('图片预览', `<img class="lightbox-image" src="${escapeHTML(src)}" alt="${escapeHTML(image.alt || '')}">`);
});
// Dragging an outline entry reorders the whole section in the source, so the
// change stays undoable and never leaves the rendered view out of sync.
let draggedSection = null;
const clearDragMarks = () => { for (const el of document.querySelectorAll('.outline-item.dragging, .outline-item.drop-target')) el.classList.remove('dragging', 'drop-target'); };
document.addEventListener('dragstart', event => {
  const item = event.target.closest('[data-section]');
  if (!item) return;
  draggedSection = Number(item.dataset.section);
  item.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(draggedSection));
});
document.addEventListener('dragend', () => { draggedSection = null; clearDragMarks(); });
document.addEventListener('dragover', event => {
  const item = event.target.closest('[data-section]');
  if (!item || draggedSection === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  for (const el of document.querySelectorAll('.outline-item.drop-target')) el.classList.remove('drop-target');
  item.classList.add('drop-target');
});
document.addEventListener('drop', event => {
  const item = event.target.closest('[data-section]');
  if (!item || draggedSection === null) return;
  event.preventDefault();
  const target = Number(item.dataset.section);
  const doc = current();
  if (doc && target !== draggedSection) {
    const next = moveSection(doc.content, draggedSection, target);
    if (next !== doc.content) { doc.editor.setContent(next); notify('章节顺序已调整，可用 ⌘/Ctrl+Z 撤销'); }
  }
  draggedSection = null;
  clearDragMarks();
});
document.addEventListener('keydown', event => {
  if (native || !(event.metaKey || event.ctrlKey) || event.isComposing || $('#dialog').open) return;
  const command = { s: event.shiftKey ? 'save-as' : 'save', o: event.shiftKey ? 'folder' : 'open', n: 'new', '/': 'source', ',': 'settings' }[event.key.toLowerCase()];
  if (command) { event.preventDefault(); runCommand(command); }
});
bridge.onCommand(runCommand);
bridge.onExternalChange(id => {
  if (!documents.has(id)) return;
  externalId = id;
  showDialog('文件已在编辑器外修改', `<p class="dialog-description">磁盘上的“${escapeHTML(documents.get(id).name)}”已发生变化。重新加载会读取磁盘版本，当前未保存内容仍保留在恢复副本中；也可以保留本地内容。</p><div class="dialog-actions"><button data-menu-command="keep-local">保留本地内容</button><button class="primary" data-menu-command="reload-external">重新加载磁盘版本</button></div>`);
});
window.addEventListener('beforeunload', event => { if (!native && [...documents.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; } });
try {
  const initial = await api('bootstrap'); prefs = initial.preferences; applyPreferences();
  capabilities = await api('capabilities').catch(() => capabilities);
  document.body.classList.toggle('frameless', native && initial.platform === 'darwin');
  for (const doc of initial.documents) await addDocument(doc);
  if (!documents.size) { const doc = await api('newDocument', welcome); doc.name = '欢迎使用.md'; await addDocument(doc); }
  if (initial.recoveryCount) notify(`已恢复 ${initial.recoveryCount} 篇未保存文档，请检查并另存为。`);
} catch (error) { notify(`启动失败：${error.message}`, true); }
