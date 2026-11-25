import './styles.css';
import './workspace.css';
import { workspaceHTML, toolbarMenuHTML, preferencesHTML, installGlassHighlights, installSheetDrag } from './workspace.js';
import { icon } from './icons.js';
import 'katex/dist/katex.min.css';
import { createEditor } from './editor.js';
import { escapeHTML, headings, statistics, draftTitleFromSource, renderMarkdown, renderSelectedMarkdown, renderDiagrams, refreshDiagrams, tableSourceRanges, setMathNumbering, setImageRootSetting, setFrontMatterImageRoot } from './markdown.js';
import { replaceFrontMatterImageRoot } from '../electron/front-matter.mjs';
import { parseTables, serializeTable, setCell, insertRow, removeRow, insertColumn, removeColumn, setAlignment, columnWidthEdit, tableMoveEdit } from './table.js';
import { compareLines, renderDiffRows, POSITIONAL_DIFF_NOTE } from './diff.js';
import { rewriteAssetReferences } from '../electron/asset-references.mjs';
import { parseSections, moveSection } from './outline.js';
import { welcome } from './welcome.js';
import { ensureLanguages } from './highlight.js';
import { splitLinkTarget, headingForAnchor, safeDecode } from './links.js';
import { browserBridge } from './browser.js';
import { styledHTML, unstyledHTML, pngHTML, printHTML } from './export.js';
import { EMOJI } from './emoji.js';

const native = !!window.desktop;
const bridge = window.desktop || browserBridge();
const documents = new Map();
let activeId, folder, prefs, sideMode = 'outline', sourceMode = false, busy = false;
let customThemes = [], selectedHistory = null, customThemeSeq = 0;
let capabilities = { installed: false, version: null, platform: '' }, imageContext = null;
let pendingTable = null, quickFiles = [];
// Folder-wide search state. The query survives a sidebar redraw so results can
// be updated without the input losing focus mid-typing.
let searchState = { query: '', caseSensitive: false, regex: false, includeDrafts: true, results: null, busy: false, seq: 0, error: '' };
let searchTimer = 0;
// Recent documents (menu + palette) and the debounced session snapshot.
let recentFiles = [], lastSessionKey = '', quitting = false;
// The welcome page is an unmodified document: it never prompts to save, and the
// first file opened in its place replaces it instead of adding a second tab.
let welcomeId = null;
// Filled from bootstrap: which title bar the main process draws, and the
// platform-specific name of the deleted-files location.
let titleBarInfo = { overlay: false, height: 64, controlsWidth: 0, trashName: '废纸篓' };
let appPlatform = '';
const trashName = () => titleBarInfo.trashName || '废纸篓';
const $ = selector => document.querySelector(selector);
$('#app').innerHTML = workspaceHTML(native);
installGlassHighlights($('.topbar'));
installSheetDrag($('#dialog'));
const compactLayout = matchMedia('(max-width: 760px)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let compactSidebarOpen = false;
let lastToolbarScroll = 0;
let navigationKey = '', draftNumber = 0;
let selectionTimer = 0, selectingWithPointer = false, selectionComposing = false;
let dismissedSelection;
const selectionTools = $('#selection-tools');

function notify(message, error = false, exportPath) {
  const node = $('#notification');
  if (notify.exportPath && notify.exportPath !== exportPath) {
    api('exportResultAction', notify.exportPath, 'dismiss').catch(() => {});
  }
  notify.exportPath = native ? exportPath : undefined;
  node.classList.toggle('has-export-actions', !!notify.exportPath);
  node.textContent = message; node.classList.toggle('error', error); node.hidden = false;
  clearTimeout(notify.timer);
  if (exportPath && native) {
    const actions = document.createElement('div');
    actions.className = 'export-result-actions';
    for (const [action, label] of [['open', '打开文件'], ['reveal', '在文件夹中显示'], ['dismiss', '关闭']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        if (action === 'dismiss') {
          node.hidden = true;
          notify.exportPath = undefined;
          await api('exportResultAction', exportPath, 'dismiss').catch(() => {});
          return;
        }
        try { await api('exportResultAction', exportPath, action); }
        catch (failure) { notify(failure.message, true); }
      });
      actions.append(button);
    }
    node.append(actions);
  } else notify.timer = setTimeout(() => { node.hidden = true; }, error ? 10000 : 4500);
}
async function api(name, ...args) {
  const result = await bridge[name](...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const current = () => documents.get(activeId);
const cleanWelcome = doc => doc && doc.id === welcomeId && !doc.dirty && !doc.path;
function draftTitle(doc) {
  if (doc.path || doc.name !== '未命名.md') return doc.name;
  if (doc.titleSource === doc.content) return doc.title;
  const title = draftTitleFromSource(doc.content);
  doc.titleSource = doc.content;
  doc.title = title ? [...title].slice(0, 100).join('') : doc.name;
  return doc.title;
}
function displayName(doc) {
  const title = draftTitle(doc);
  if (doc.path) return title;
  const peers = [...documents.values()].filter(peer => !peer.path && draftTitle(peer) === title);
  if (peers.length > 1) {
    for (const peer of peers) peer.disambiguatedTitle = title;
  }
  return doc.disambiguatedTitle === title ? `${title}（${doc.draftNumber}）` : title;
}
function refreshSearch() {
  if (!searchState.query.trim()) return;
  scheduleSearch();
}

async function flush(doc = current()) {
  if (!doc) return;
  clearTimeout(doc.timer);
  const proposedName = !doc.path && doc.name === '未命名.md' ? displayName(doc) : undefined;
  const anchors = doc.path ? [...(doc.pendingNoteAnchors?.values() || [])] : undefined;
  await api('updateDocument', doc.id, doc.content, proposedName, anchors);
  if (!doc.path || !doc.dirty) await persistWritingAnchors(doc);

}
function updateChrome() {
  const doc = current(); if (!doc) return;
  const title = displayName(doc);
  $('#welcome-actions').hidden = !cleanWelcome(doc);
  document.title = `${doc.dirty ? '• ' : ''}${title} — 墨页`;
  // The filename remains visible even when the tab strip is folded away.
  $('#location').textContent = `${doc.dirty ? '• ' : ''}${title}`;
  $('#location').title = doc.path || title;
  $('#save-status').textContent = doc.error ? doc.error : doc.dirty ? '有未保存的更改' : doc.path ? '已保存' : '未保存到文件';
  $('#save-status').classList.toggle('status-error', !!doc.error);
  $('#save-status').dataset.state = doc.error ? 'error' : doc.dirty ? 'dirty' : doc.path ? 'saved' : 'draft';
  // Typing changes the body far more often than it changes a tab. Keep the
  // buttons (and keyboard focus on them) when only the manuscript changed.
  const key = JSON.stringify([activeId, ...[...documents.values()].map(d => [d.id, displayName(d), d.path, d.dirty])]);
  if (key === navigationKey) return;
  navigationKey = key;
  drawOpenDocuments();
  $('#document-tabs').innerHTML = [...documents.values()].map(d => `<div class="document-tab ${d.id === activeId ? 'active' : ''}"><button role="tab" tabindex="${d.id === activeId ? 0 : -1}" aria-selected="${d.id === activeId}" aria-controls="editor-host" data-document="${d.id}" title="${escapeHTML(d.path || displayName(d))}">${icon('file')}<span>${escapeHTML(displayName(d))}</span>${d.dirty ? '<span class="dirty-mark" aria-label="未保存">●</span>' : ''}</button><button class="close-tab" data-close="${d.id}" aria-label="关闭 ${escapeHTML(displayName(d))}">${icon('close')}</button></div>`).join('');
}
function updateStats() {
  const doc = current(); if (!doc) return;
  const stats = statistics(doc.content);
  $('#statistics').textContent = `${stats.words} 字词 · ${stats.characters} 字符`;
  $('#statistics').title = `${stats.lines} 行 · 不含空格 ${stats.nonWhitespace} 字符 · 约 ${stats.minutes} 分钟阅读`;
  $('#encoding').textContent = `UTF-8${doc.content.startsWith('\uFEFF') ? ' BOM' : ''} · ${doc.content.includes('\r\n') ? 'CRLF' : 'LF'}`;
}
/**
 * The tab strip is hidden in the default appearance, so the sidebar lists every
 * open document: name, unsaved marker, current item, and a close button that
 * runs the same save prompt as the tabs.
 */
function drawOpenDocuments() {
  const container = $('#open-documents');
  if (!container) return;
  container.innerHTML = [...documents.values()].map(d => `<div class="open-document" role="listitem">
      <button class="open-document-name" data-document="${d.id}" aria-current="${d.id === activeId}" aria-label="切换到 ${escapeHTML(displayName(d))}" title="${escapeHTML(d.path || displayName(d))}">${icon('file')}<span>${escapeHTML(displayName(d))}</span>${d.dirty ? '<span class="dirty-mark" aria-label="未保存">●</span>' : ''}</button>
      <button class="open-document-close" data-close="${d.id}" aria-label="关闭 ${escapeHTML(displayName(d))}">${icon('close')}</button>
    </div>`).join('');
}
function drawSidebar() {
  const container = $('#side-content');
  $('.filter-label').hidden = sideMode !== 'files' && sideMode !== 'articles';
  $('#side-title').textContent = sideMode === 'outline' ? '文档结构' : sideMode === 'articles' ? '全部文章' : (folder?.name || '文件工作空间');
  container.setAttribute('aria-labelledby', `side-${sideMode}`);
  for (const [index, tab] of [...document.querySelectorAll('[data-side]')].entries()) {
    const selected = tab.dataset.side === sideMode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) $('.sidebar-tabs').style.setProperty('--tab-index', index);
  }
  if (sideMode === 'articles') {
    const query = $('#file-filter').value.toLowerCase();
    const articles = folder ? flattenFiles(folder.entries) : [];
    const opened = [...documents.values()].filter(d => !d.path && !cleanWelcome(d)).map(d => ({ name: displayName(d), id: d.id, recent: true }));
    const all = [...opened, ...articles.map(a => ({ ...a, recent: false }))];
    const matches = all.filter(a => !query || a.name.toLowerCase().includes(query));
    container.innerHTML = matches.length
      ? matches.map(a => `<button class="article-item ${a.recent ? 'unsaved' : ''} ${(a.id === activeId || (a.path && a.path === current()?.path)) ? 'current' : ''}" ${a.path ? `data-path="${escapeHTML(a.path)}"` : `data-document="${escapeHTML(a.id)}"`}><strong>${escapeHTML(a.name.replace(/\.(md|markdown|mdown|txt)$/i, ''))}</strong><span>${a.recent ? '未保存的文档' : escapeHTML(a.path.replace(/[\\/][^\\/]*$/, ''))}</span></button>`).join('')
      : '<div class="empty-state"><p>还没有文章</p><small>打开一个文件夹，即可在这里浏览全部 Markdown 文档。</small><button class="primary" data-command="folder">打开文件夹</button></div>';
  } else if (sideMode === 'search') {
    // The panel is only built once, so typing in the search box is not
    // interrupted by the sidebar being redrawn after every result update.
    if (!container.querySelector('#folder-search-input')) {
      container.innerHTML = `<div class="folder-search">
        <label class="filter-label"><span class="sr-only">搜索文档</span><input id="folder-search-input" type="search" placeholder="搜索文档…" autocomplete="off"></label>
        <div class="folder-search-options">
          <label class="checkbox-label"><input type="checkbox" data-search-option="caseSensitive"><span>区分大小写</span></label>
          <label class="checkbox-label"><input type="checkbox" data-search-option="regex"><span>正则</span></label>
          <label class="checkbox-label"><input type="checkbox" data-search-option="includeDrafts"><span>包含本窗口草稿</span></label>
        </div>
        <p class="folder-search-summary" id="folder-search-summary"></p>
      </div><div class="folder-search-results" id="folder-search-results" role="list"></div>`;
      container.querySelector('#folder-search-input').value = searchState.query;
      for (const box of container.querySelectorAll('[data-search-option]')) box.checked = !!searchState[box.dataset.searchOption];
      if (!$('#writing-sidebar').inert) container.querySelector('#folder-search-input').focus();
    }
    drawSearchResults();
  } else if (sideMode === 'outline') {
    const content = current()?.content || '';
    const outline = headings(content);
    const { owners } = parseSections(content);
    container.innerHTML = (outline.length ? outline.map((h, index) => `<button class="outline-item level-${h.level}" data-line="${h.line}" data-section="${owners[index] ?? index}" draggable="true" title="拖动可重排整个章节" style="--indent:${Math.max(0, h.level - 1) * 12}px"><small aria-hidden="true">H${h.level}</small><span>${escapeHTML(h.title)}</span></button>`).join('') : '<div class="empty-state"><p>还没有标题</p><small>输入 # 加空格，为文档建立结构。</small></div>') + writingNotesHTML(current());
  } else {
    const query = $('#file-filter').value.toLowerCase();
    const renderEntries = (entries, depth = 0) => entries.map(entry => {
      if (entry.children) {
        const children = renderEntries(entry.children || [], depth + 1);
        return `<details open><summary data-tree-path="${escapeHTML(entry.path)}" data-tree-kind="folder" style="padding-left:${12 + depth * 12}px">${icon('folder')}${escapeHTML(entry.name)}</summary>${children}</details>`;
      }
      if (query && !entry.name.toLowerCase().includes(query)) return '';
      return `<button class="file-item" style="padding-left:${12 + depth * 12}px" data-path="${escapeHTML(entry.path)}" data-tree-path="${escapeHTML(entry.path)}" data-tree-kind="file">${icon('file')}<span>${escapeHTML(entry.name)}</span></button>`;
    }).join('');
    // The tree owns the create / rename / trash actions: a small toolbar for the
    // common ones, and a native context menu on every entry.
    const toolbar = folder ? `<div class="file-tree-toolbar">
      <button data-file-op="new-file" title="新建文件" aria-label="新建文件">${icon('filePlus')}</button>
      <button data-file-op="new-folder" title="新建文件夹" aria-label="新建文件夹">${icon('folderPlus')}</button>
      <button data-file-op="refresh" title="刷新文件树" aria-label="刷新文件树">${icon('refresh')}</button>
    </div>` : '';
    container.innerHTML = toolbar + (folder ? renderEntries(folder.entries) || '<div class="empty-state">没有匹配的 Markdown 文件</div>' : '<div class="empty-state"><p>让文件留在自己的位置</p><small>打开一个文件夹，浏览其中的 Markdown 文档。</small><button class="primary" data-command="folder">打开文件夹</button></div>');
  }
  updateCurrentSection();
}
// ── Folder-wide search ─────────────────────────────────────────────────────
// The main process walks the folder and returns grouped matches; the renderer
// only draws them. Unsaved documents are searched as the editor shows them.
function scheduleSearch(delay = 220) {
  clearTimeout(searchTimer);
  searchState.seq++;
  searchTimer = setTimeout(() => { runFolderSearch().catch(error => notify(error.message, true)); }, delay);
}

async function runFolderSearch() {
  const query = searchState.query;
  const seq = ++searchState.seq;
  if ((!folder && !searchState.includeDrafts) || !query.trim()) {
    searchState.results = null; searchState.busy = false; searchState.error = '';
    drawSearchResults();
    return;
  }
  searchState.busy = true;
  drawSearchResults();
  const overrides = {};
  const drafts = [];
  for (const doc of documents.values()) {
    if (doc.path && doc.dirty) overrides[doc.path] = doc.editor.text();
    if (!doc.path && !cleanWelcome(doc) && searchState.includeDrafts) {
      drafts.push({ documentId: doc.id, name: displayName(doc), content: doc.editor.text() });
    }
  }
  try {
    const results = await api('searchFolder', query, {
      caseSensitive: searchState.caseSensitive, regex: searchState.regex, overrides, drafts
    });
    // A newer query owns the panel; a stale answer is dropped, never merged.
    if (seq !== searchState.seq) return;
    searchState.results = results; searchState.error = ''; searchState.busy = false;
  } catch (error) {
    if (seq !== searchState.seq) return;
    searchState.results = null; searchState.error = error.message; searchState.busy = false;
  }
  drawSearchResults();
}

/** One context snippet with the matched ranges marked and everything escaped. */
function snippetHTML(match) {
  const text = String(match.text || '');
  let html = '', cursor = 0;
  for (const [from, to] of match.ranges || []) {
    if (from < cursor) continue;
    html += escapeHTML(text.slice(cursor, from)) + `<mark>${escapeHTML(text.slice(from, to))}</mark>`;
    cursor = to;
  }
  return html + escapeHTML(text.slice(cursor));
}

function drawSearchResults() {
  const list = $('#folder-search-results');
  const summary = $('#folder-search-summary');
  if (!list || !summary) return;
  if (!folder && !searchState.includeDrafts) {
    summary.textContent = '';
    list.innerHTML = '<div class="empty-state"><p>先打开一个文件夹</p><small>搜索会在当前文件夹的 Markdown 文档中进行。</small><button class="primary" data-command="folder">打开文件夹</button></div>';
    return;
  }
  const { results, busy, error, query } = searchState;
  summary.textContent = busy ? '正在搜索…'
    : error ? error
    : !query.trim() ? '输入关键词开始搜索。'
    : !results ? ''
    : results.total ? `在 ${results.files.length} ${results.files.some(file => file.documentId) ? '篇文稿' : '个文件'}中找到 ${results.total} 处${results.truncated ? '（结果已截断）' : ''}`
    : '没有找到匹配的内容。';
  if (!results || !results.files.length) { list.innerHTML = ''; return; }
  list.innerHTML = results.files.map(file => `<div class="search-file" role="listitem">
    <div class="search-file-heading"><strong>${escapeHTML(file.name)}</strong><span>${escapeHTML(file.relative)}</span></div>
    ${file.matches.map(match => `<button class="search-hit" data-search-hit ${file.documentId ? `data-search-document="${escapeHTML(file.documentId)}"` : `data-search-path="${escapeHTML(file.path)}"`} data-search-line="${match.line}" data-search-column="${match.column}" data-search-length="${(match.ranges[0]?.[1] ?? 1) - (match.ranges[0]?.[0] ?? 0)}">
      <span class="search-line">${match.line}</span><span class="search-text">${snippetHTML(match)}</span>
    </button>`).join('')}
  </div>`).join('');
}

/** Open a search hit and put the caret on the match. */
async function openSearchHit(element) {
  const { searchPath: path, searchDocument: id } = element.dataset;
  const line = Number(element.dataset.searchLine) || 1;
  const column = Number(element.dataset.searchColumn) || 1;
  const length = Number(element.dataset.searchLength) || 0;
  let doc = id ? documents.get(id) : [...documents.values()].find(candidate => candidate.path === path);
  if (id && !doc) { refreshSearch(); return; }
  if (!doc) {
    try { await openDocuments(await api('openPath', path)); }
    catch (error) { notify(error.message, true); return; }
    doc = [...documents.values()].find(candidate => candidate.path === path);
  }
  if (!doc) return;
  activate(doc.id);
  // Jumping makes the block holding the match the active one, so the hit is
  // visible even in the typeset view.
  requestAnimationFrame(() => { if (doc.editor.view.dom.isConnected) doc.editor.jumpTo(line, column, length); });
}

// ── File-tree operations ───────────────────────────────────────────────────
const parentFolderOf = file => String(file || '').replace(/[\\/][^\\/]*$/, '') || folder?.path || '';

/** A small modal prompt for the file-tree create / rename actions. */
function askEntryName(title, initial, hint, label = '名称') {
  return new Promise(resolve => {
    showDialog(title, `<label class="quick-filter"><span class="sr-only">${escapeHTML(label)}</span><input id="entry-name" type="text" value="${escapeHTML(initial || '')}" autocomplete="off"></label><p class="dialog-description">${escapeHTML(hint || '文件名会自动补上 .md 扩展名。')}</p><div class="dialog-actions"><button data-dismiss>取消</button><button class="primary" id="entry-name-confirm">确定</button></div>`);
    const input = $('#entry-name');
    input.focus();
    input.select();
    let settled = false;
    const finish = value => { if (settled) return; settled = true; if ($('#dialog').open) $('#dialog').close(); resolve(value); };
    const confirm = () => {
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      finish(value);
    };
    $('#entry-name-confirm').addEventListener('click', confirm);
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); confirm(); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(null); }
    });
    $('#dialog').addEventListener('close', () => finish(null), { once: true });
  });
}

/**
 * Apply the document identities the main process changed while it touched the
 * filesystem (a folder rename moved the files, a folder trash removed them).
 * Only the path and the name come from the main process — the text stays what
 * the editor shows, so a dirty document keeps its unsaved state.
 */
function applyPathUpdates(records) {
  if (!Array.isArray(records) || !records.length) return false;
  for (const record of records) {
    const doc = documents.get(record?.id);
    if (!doc) continue;
    doc.path = record.path;
    doc.name = record.name || doc.name;
    // A file that went to the trash leaves the document unsaved, so its
    // baseline becomes empty and the next save asks for a location.
    if (!record.path) doc.savedContent = '';
    updateDirty(doc);
  }
  updateChrome();
  saveSession();
  return true;
}

/**
 * Run one file-tree action. Creation and renaming ask for a name here; the main
 * process validates it and performs the filesystem work inside the folder.
 */
async function runFileOperation(action, target, isDirectory) {
  if (!folder) { notify('请先打开文件夹。', true); return; }
  try {
    if (action === 'refresh') {
      folder = (await api('refreshFolder')) || folder;
      drawSidebar();
      return;
    }
    if (action === 'reveal') { await api('revealPath', target || folder.path); return; }
    if (action === 'copy-path') { await api('writeClipboard', { text: target || folder.path }); notify('路径已复制到剪贴板'); return; }
    if (action === 'new-file' || action === 'new-folder') {
      const parent = target ? (isDirectory ? target : parentFolderOf(target)) : folder.path;
      const name = await askEntryName(action === 'new-file' ? '新建文件' : '新建文件夹', '', action === 'new-folder' ? '新文件夹会创建在所选位置。' : '文件名会自动补上 .md 扩展名。');
      if (!name) return;
      const result = await api('createEntry', parent, name, action === 'new-file' ? 'file' : 'folder');
      folder = { ...folder, entries: result.entries };
      drawSidebar();
      if (action === 'new-file') {
        await openDocuments(await api('openPath', result.path));
        notify(`已新建“${result.name}”。`);
      } else notify(`已新建文件夹“${result.name}”。`);
      return;
    }
    if (action === 'rename') {
      const before = String(target || '').replace(/^.*[\\/]/, '');
      const name = await askEntryName('重命名', before, '重命名 *.md 时可以省略扩展名，会自动补上。');
      if (!name || name === before) return;
      const normalizePath = value => {
        const normalized = value.replaceAll('\\', '/');
        return appPlatform === 'win32' ? normalized.toLowerCase() : normalized;
      };
      const source = normalizePath(target);
      const affected = [...documents.values()].filter(doc => {
        if (!doc.path) return false;
        const file = normalizePath(doc.path);
        return isDirectory ? file.startsWith(source + '/') : file === source;
      }).sort((a, b) => a.id.localeCompare(b.id));
      const rename = async () => {
        if (!isDirectory && affected.length) await flush(affected[0]);
        const result = await api('renameEntry', target, name);
        if (!result) return;
        applyPathUpdates(result.documents);
        const doc = documents.get(result.document?.id);
        if (doc) await applySavedDocument(doc, result.document);
        return result;
      };
      const operation = affected.reduceRight((next, doc) => () => documentOperation(doc, next), rename);
      const result = await operation();
      if (!result) return;
      if (result.entries) folder = { ...folder, entries: result.entries };
      drawSidebar();
      const warnings = result.warnings || result.document?.warnings;
      notify(warnings?.length ? warnings.join('\n') : '已重命名。', !!warnings?.length);
      return;
    }
    if (action === 'trash') {
      const result = await api('trashEntry', target);
      if (!result) return;
      if (result.entries) folder = { ...folder, entries: result.entries };
      // Trashing a folder makes every document opened from inside it unsaved.
      applyPathUpdates(result.documents);
      if (result.kind === 'document' && result.document) {
        const doc = documents.get(result.document.id);
        if (doc) { Object.assign(doc, { path: null, savedContent: '' }); updateChrome(); }
      }
      drawSidebar();
      notify(`已移到${trashName()}。`);
    }
  } catch (error) { notify(error.message, true); }
}

// ── Local link navigation ──────────────────────────────────────────────────
/** Jump to a heading (or any rendered element) with the given anchor id. */
function jumpToAnchor(doc, anchor) {
  if (!doc) return false;
  const wanted = safeDecode(anchor);
  const heading = headingForAnchor(headings(doc.content), wanted);
  if (heading) { doc.editor.jump(heading.line); return true; }
  // Footnote references and their back-links are elements, not headings.
  const element = document.getElementById(wanted) || document.querySelector(`[name="${CSS.escape(wanted)}"]`);
  if (element) { element.scrollIntoView({ block: 'center' }); return true; }
  return false;
}

/**
 * Follow one link from rendered content or from the active block.
 * Local Markdown files open in the app (with their anchor), other local files
 * go to the system after a confirmation, and web links leave through the
 * main-process allow-list.
 */
async function navigateLink(href) {
  const target = splitLinkTarget(href);
  if (target.kind === 'empty') return;
  if (target.kind === 'anchor') {
    if (!jumpToAnchor(current(), target.anchor)) notify(`找不到锚点“${target.anchor}”。`, true);
    return;
  }
  if (target.kind === 'external') {
    try { await api('openExternal', target.href); } catch (error) { notify(error.message, true); }
    return;
  }
  let resolved;
  try { resolved = await api('resolveLink', current().id, target.path); }
  catch (error) { notify(error.message, true); return; }
  if (!resolved.markdown) {
    try { await api('openLocalFile', resolved.path); } catch (error) { notify(error.message, true); }
    return;
  }
  let doc = [...documents.values()].find(candidate => candidate.path === resolved.path);
  if (doc) activate(doc.id);
  else {
    try { await openDocuments(await api('openPath', resolved.path)); }
    catch (error) { notify(error.message, true); return; }
    doc = [...documents.values()].find(candidate => candidate.path === resolved.path);
  }
  if (doc && target.anchor) {
    requestAnimationFrame(() => { if (doc.editor.view.dom.isConnected && !jumpToAnchor(doc, target.anchor)) notify(`找不到锚点“${target.anchor}”。`, true); });
  }
}

/** Persist the restorable session (folder, saved documents, current document). */
function saveSession(force = false) {
  if (quitting && !force) return;
  const files = [...documents.values()].filter(doc => doc.path).map(doc => doc.path);
  const key = JSON.stringify([folder?.path || null, files, current()?.path || null]);
  if (!force && key === lastSessionKey) return;
  lastSessionKey = key;
  // Sent right away: the key only changes when the document list does, and the
  // main process coalesces the writes. A debounce here could lose the session
  // when the window closes immediately after closing a document.
  return api('saveSession', { folder: folder?.path || null, files, active: current()?.path || null }).catch(() => {
    if (lastSessionKey === key) lastSessionKey = '';
  });
}

// headings() keeps the outline of the parse that rendered the current version,
// so the breadcrumb, the sidebar and [TOC] never run markdown-it a second time.
const outlineFor = content => headings(content);
function updateCurrentSection(lineNumber) {
  const doc = current();
  if (!doc?.editor) return;
  const state = doc.editor.view.state;
  const line = lineNumber ?? state.doc.lineAt(state.selection.main.head).number;
  const section = outlineFor(doc.content).findLast(item => item.line <= line);
  $('#breadcrumb').textContent = section?.title || '';
  const active = $('#side-content .outline-item[aria-current]');
  const target = section && $(`#side-content .outline-item[data-line="${section.line}"]`);
  if (active !== target) {
    active?.removeAttribute('aria-current');
    target?.setAttribute('aria-current', 'location');
  }
}
function captureSelection(doc = current()) {
  if (!doc) return null;
  const { from, to, empty } = doc.editor.view.state.selection.main;
  if (empty) return null;
  return { doc, from, to, source: doc.editor.text() };
}

function hideSelectionTools() {
  clearTimeout(selectionTimer);
  selectionTools.hidden = true;
}
function scheduleSelectionTools() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selection = captureSelection();
    const focused = document.activeElement;
    const view = selection?.doc.editor.view;
    const main = $('.main-pane');
    const showFormat = prefs?.uiMode !== 'workbench';
    if (!selection || (!showFormat && !native) || selectionComposing || view.composing
      || selectingWithPointer || main.inert || $('#dialog').open
      || (focused !== view.contentDOM && !selectionTools.contains(focused))
      || (dismissedSelection?.doc === selection.doc && dismissedSelection.source === selection.source
          && dismissedSelection.from === selection.from && dismissedSelection.to === selection.to)) {
      selectionTools.hidden = true;
      return;
    }
    const edge = view.coordsAtPos(selection.to, -1);
    const bounds = $('#editor-host').getBoundingClientRect();
    if (!edge || edge.bottom < bounds.top || edge.top > bounds.bottom) {
      selectionTools.hidden = true;
      return;
    }
    for (const button of selectionTools.querySelectorAll('[data-selection-format]')) button.hidden = !showFormat;
    selectionTools.hidden = false;
    const { offsetWidth: width, offsetHeight: height } = selectionTools;
    const left = Math.max(bounds.left + 4, Math.min(edge.left - width / 2, bounds.right - width - 4));
    const top = edge.top - height - 6 >= bounds.top ? edge.top - height - 6 : Math.min(edge.bottom + 6, bounds.bottom - height - 4);
    selectionTools.style.left = `${left}px`;
    selectionTools.style.top = `${top}px`;
  }, 120);
}
selectionTools.addEventListener('pointerdown', event => event.preventDefault());
document.addEventListener('pointerdown', event => {
  if (!selectionTools.contains(event.target)) hideSelectionTools();
  selectingWithPointer = !!event.target.closest?.('#editor-host');
  if (selectingWithPointer) dismissedSelection = null;
}, true);
for (const event of ['pointerup', 'pointercancel']) document.addEventListener(event, () => {
  if (!selectingWithPointer) return;
  selectingWithPointer = false;
  scheduleSelectionTools();
}, true);
document.addEventListener('focusin', event => {
  if (event.target === current()?.editor.view.contentDOM) scheduleSelectionTools();
  else if (!selectionTools.contains(event.target)) hideSelectionTools();
});
document.addEventListener('compositionstart', event => {
  if (!event.target.closest?.('#editor-host')) return;
  selectionComposing = true;
  hideSelectionTools();
});
document.addEventListener('compositionend', () => { selectionComposing = false; scheduleSelectionTools(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || selectionTools.hidden) return;
  dismissedSelection = captureSelection();
  const inTools = selectionTools.contains(document.activeElement);
  hideSelectionTools();
  if (inTools) current()?.editor.view.focus();
}, true);
window.addEventListener('resize', scheduleSelectionTools);

async function linkSelection() {
  const selection = captureSelection();
  if (!selection) return;
  const href = await askEntryName('插入链接', 'https://', '输入网址、文档相对路径或文内锚点。', '链接地址');
  if (!href || selection.doc !== current() || selection.source !== selection.doc.editor.text()) return;
  if (/[<>\r\n]/.test(href)) throw new Error('链接地址不能包含尖括号或换行。');
  const view = selection.doc.editor.view;
  view.dispatch({ selection: { anchor: selection.from, head: selection.to } });
  selection.doc.editor.wrap('[', `](<${href.replaceAll(' ', '%20')}>)`);
}

async function copySelectionImage() {
  const selection = captureSelection();
  if (!native || !selection || busy) return;
  const { doc, from, to, source } = selection;
  const name = displayName(doc);
  const mathNumbering = !!prefs.mathNumbering;
  busy = true;
  const target = document.createElement('article');
  target.className = 'print-document prose write-surface';
  try {
    await flush(doc);
    await ensureLanguages(source);
    const html = renderSelectedMarkdown(source, doc.id, { from, to }, { chrome: false, mathNumbering });
    if (!html.trim()) throw new Error('选区没有可显示的内容。');
    target.innerHTML = html;
    document.body.append(target);
    await renderDiagrams(target);
    await api('copySelectionImage', doc.id, pngRequest(name, target));
    notify('选区已复制为图片');
  } finally {
    target.remove();
    busy = false;
  }
}

function writingAnchor(source, from, to) {
  return { from, to, quote: source.slice(from, to), prefix: source.slice(Math.max(0, from - 48), from), suffix: source.slice(to, to + 48) };
}

function findWritingAnchor(source, anchor) {
  if (anchor.orphaned) return null;
  const matchesContext = (from, to) => from >= anchor.prefix.length
    && source.startsWith(anchor.prefix, from - anchor.prefix.length) && source.startsWith(anchor.suffix, to);
  const samePosition = source.slice(anchor.from, anchor.to) === anchor.quote;
  if (samePosition && matchesContext(anchor.from, anchor.to)) return anchor;
  let first = -1, contextMatch = -1, multiple = false;
  for (let from = source.indexOf(anchor.quote); from >= 0; from = source.indexOf(anchor.quote, from + 1)) {
    if (first === -1) first = from;
    else multiple = true;
    if (!matchesContext(from, from + anchor.quote.length)) continue;
    if (contextMatch !== -1) return null;
    contextMatch = from;
  }
  const from = contextMatch !== -1 ? contextMatch : multiple ? -1 : first;
  return from === -1 ? null : writingAnchor(source, from, from + anchor.quote.length);
}

function writingNotesRows(doc) {
  if (doc.notes === undefined) return '';
  const source = doc.editor.text();
  const rows = doc.notes.map(note => {
    const found = findWritingAnchor(source, note.anchor);
    return `<div class="writing-note" data-note-id="${escapeHTML(note.id)}">
      <button type="button" class="writing-note-jump" data-writing-note-action="jump" ${found ? '' : 'disabled'}>${escapeHTML(note.text)}</button>
      <small>${found ? (note.done ? '已完成' : escapeHTML([...note.anchor.quote].slice(0, 40).join(''))) : '需重新定位'}</small>
      <div class="writing-note-actions">
        <button type="button" data-writing-note-action="edit">编辑</button>
        <button type="button" data-writing-note-action="relocate" title="选中新文字后重新定位">重新定位</button>
        <button type="button" data-writing-note-action="toggle">${note.done ? '重新打开提示' : '完成'}</button>
      </div></div>`;
  }).join('');
  return rows ? `<h3>续写提示</h3>${rows}` : '';
}

function writingNotesHTML(doc) {
  return native && doc ? `<section id="writing-notes" aria-label="续写提示">${writingNotesRows(doc)}</section>` : '';
}

function drawWritingNotes(doc) {
  const panel = $('#writing-notes');
  if (current() === doc && panel) panel.innerHTML = writingNotesRows(doc);
}
async function loadWritingNotes(doc) {
  const seq = doc.noteLoad = (doc.noteLoad || 0) + 1;
  const notes = await api('listWritingNotes', doc.id);
  if (!documents.has(doc.id) || seq !== doc.noteLoad) return;
  doc.notes = notes.map(note => {
    const pending = doc.pendingNoteAnchors?.get(note.id);
    return pending ? { ...note, anchor: pending.anchor } : note;
  });
  drawWritingNotes(doc);
}

function mapWritingNotes(doc, update) {
  if (!doc.notes?.length) return;
  const previousText = update.startState.doc.toString(), source = update.state.doc.toString();
  doc.pendingNoteAnchors ||= new Map();
  doc.notes = doc.notes.map(note => {
    if (note.anchor.orphaned) {
      const { orphaned, ...original } = note.anchor;
      const restored = findWritingAnchor(source, original);
      if (!restored || !source.includes(original.prefix + original.quote + original.suffix)) return note;
      const previousAnchor = doc.pendingNoteAnchors.get(note.id)?.previousAnchor || note.anchor;
      doc.pendingNoteAnchors.set(note.id, { type: 'relocate', id: note.id, previousAnchor, anchor: restored });
      return { ...note, anchor: restored };
    }
    const anchor = findWritingAnchor(previousText, note.anchor);
    if (!anchor) return note;
    const from = update.changes.mapPos(anchor.from, 1), to = update.changes.mapPos(anchor.to, -1);
    const mapped = source.slice(from, to) === anchor.quote ? writingAnchor(source, from, to)
      : from < to ? findWritingAnchor(source, anchor) : null;
    const next = mapped || { ...anchor, orphaned: true };
    if (JSON.stringify(next) === JSON.stringify(note.anchor)) return note;
    const previousAnchor = doc.pendingNoteAnchors.get(note.id)?.previousAnchor || note.anchor;
    doc.pendingNoteAnchors.set(note.id, { type: 'relocate', id: note.id, previousAnchor, anchor: next });
    return { ...note, anchor: next };
  });
}

function saveWritingAnchors(doc) {
  if (!doc.pendingNoteAnchors?.size) return doc.noteWrite;
  if (doc.noteWrite) return doc.noteWrite.then(() => saveWritingAnchors(doc));
  doc.noteWrite = (async () => {
    for (const [id, change] of [...doc.pendingNoteAnchors]) {
      const saved = await api('updateWritingNote', doc.id, change);
      const pending = doc.pendingNoteAnchors.get(id);
      if (pending === change) {
        doc.pendingNoteAnchors.delete(id);
        doc.notes = doc.notes.map(note => note.id === id ? saved : note);
      } else if (pending && JSON.stringify(saved.anchor) === JSON.stringify(change.anchor)) {
        pending.previousAnchor = saved.anchor;
      } else if (pending) {
        doc.pendingNoteAnchors.delete(id);
        doc.notes = doc.notes.map(note => note.id === id ? saved : note);
      }
    }
  })().finally(() => { doc.noteWrite = null; });
  return doc.noteWrite;
}

async function persistWritingAnchors(doc) {
  try { await saveWritingAnchors(doc); }
  catch (error) { notify(`续写提示的位置还未保存：${error.message}`, true); }
}

async function changeWritingNote(doc, change) {
  if (!doc.path || !doc.dirty) await saveWritingAnchors(doc);
  if (change.type === 'relocate') doc.pendingNoteAnchors?.delete(change.id);
  await api('updateWritingNote', doc.id, change);
  await loadWritingNotes(doc);
}
async function addWritingNote() {
  const selection = captureSelection();
  if (!native || !selection) return;
  const { doc, source, from, to } = selection;
  const text = await askEntryName('留个续写提示', '', '下次打开这篇文稿时，可以从大纲跳回这段文字。', '续写提示');
  if (!text || current() !== doc || doc.editor.text() !== source) return;
  await flush(doc);
  await changeWritingNote(doc, { type: 'add', id: crypto.randomUUID(), text, anchor: writingAnchor(source, from, to) });
  sideMode = 'outline';
  if (!compactLayout.matches) setSidebarVisible(true);
  drawSidebar();
  notify('续写提示已保存');
}

async function writingNoteAction(button) {
  const doc = current();
  const note = doc?.notes?.find(record => record.id === button.closest('[data-note-id]').dataset.noteId);
  if (!note) return;
  const action = button.dataset.writingNoteAction;
  if (action === 'jump') {
    const anchor = findWritingAnchor(doc.editor.text(), note.anchor);
    if (!anchor) { drawWritingNotes(doc); return; }
    dismissCompactSidebar();
    const view = doc.editor.view;
    view.dispatch({ selection: { anchor: anchor.from, head: anchor.to }, scrollIntoView: true });
    view.focus();
  } else if (action === 'edit') {
    const text = await askEntryName('编辑续写提示', note.text, '更新这段文字的续写提示。', '续写提示');
    if (text && current() === doc) await changeWritingNote(doc, { type: 'edit', id: note.id, text });
  } else if (action === 'toggle') {
    await changeWritingNote(doc, { type: 'complete', id: note.id, done: !note.done });
  } else if (action === 'relocate') {
    const selection = captureSelection(doc);
    if (!selection) { notify('先在稿件中选中新位置的文字。'); return; }
    await changeWritingNote(doc, { type: 'relocate', id: note.id, anchor: writingAnchor(selection.source, selection.from, selection.to) });
  }
}
bridge.onWritingNotesChanged?.(id => {
  const doc = documents.get(id);
  if (doc) loadWritingNotes(doc).catch(error => notify(error.message, true));
});

function updateSelectionStatus(state) {
  const range = state.selection.main;
  const pos = range.head, line = state.doc.lineAt(pos);
  $('#position').textContent = `行 ${line.number}，列 ${pos - line.from + 1}`;
  $('#selection-status').textContent = range.empty ? '' : `已选 ${[...state.sliceDoc(range.from, range.to)].length} 字`;
  updateCurrentSection(line.number);
}
function selectionChanged(doc, update) {
  if (update.docChanged) mapWritingNotes(doc, update);
  if (doc !== current()) return;
  updateSelectionStatus(update.state);
  if (update.selectionSet || update.docChanged) scheduleSelectionTools();
  const pos = update.state.selection.main.head;
  // Only a naked caret should recentre the viewport. Recentring on a growing
  // selection makes drag-select fight the scrolling underneath the pointer.
  if (prefs?.typewriter && update.selectionSet && update.state.selection.main.empty) queueMicrotask(() => { if (update.view.dom.isConnected) update.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); });
}
// Imported here to keep the editor implementation's public API small.
import { EditorView } from '@codemirror/view';

async function addDocument(record, focusEditor) {
  if (documents.has(record.id)) { activate(record.id, focusEditor); return; }
  const doc = { ...record, draftNumber: record.path ? 0 : ++draftNumber, savedContent: record.dirty ? '' : record.content };
  documents.set(doc.id, doc);
  const mount = document.createElement('div'); mount.className = 'editor-mount';
  doc.mount = mount;
  doc.editor = createEditor(mount, doc, content => {
    doc.content = content; updateDirty(doc); doc.error = '';
    clearTimeout(doc.timer);
    doc.timer = setTimeout(async () => {
      try {
        await flush(doc);
        if (prefs.autoSave && doc.path && doc.dirty) await save(doc);
      } catch (error) { doc.error = '保存失败'; notify(error.message, true); }
      updateChrome();
    }, 500);
    updateChrome();
    refreshSearch();
    clearTimeout(doc.statsTimer); doc.statsTimer = setTimeout(() => { if (doc.id === activeId) { updateStats(); drawSidebar(); } }, 180);
  }, update => selectionChanged(doc, update), command => runCommand(command), file => insertImage(file, doc), href => navigateLink(href));
  doc.editor.setSpellcheck(prefs.spellcheck);
  doc.editor.view.scrollDOM.addEventListener('scroll', () => {
    if (doc.id === activeId) { updateScrollEdge(doc); scheduleSelectionTools(); }
  }, { passive: true });
  activate(doc.id, focusEditor);
}
function updateScrollEdge(doc, reset = false) {
  const top = doc.editor.view.scrollDOM.scrollTop;
  $('#editor-host').classList.toggle('has-scroll', top > 4);
  if (reset || !compactLayout.matches || top < 12) {
    $('.main-pane').classList.remove('tools-folded');
  } else {
    if (Math.abs(top - lastToolbarScroll) < 16) return;
    if (!$('.reading-controls').contains(document.activeElement)) {
      $('.main-pane').classList.toggle('tools-folded', top > 80 && top > lastToolbarScroll);
    }
  }
  lastToolbarScroll = top;
}
/**
 * Open documents requested from the menu, the palette, the sidebar, a dropped
 * file or the command line. A pristine welcome page is closed first so the
 * opened document takes its place instead of leaving an extra tab behind.
 */
async function openDocuments(records) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (!list.length) return null;
  const welcome = welcomeId ? documents.get(welcomeId) : null;
  if (welcome && documents.size === 1 && !welcome.dirty && !welcome.path) {
    welcomeId = null;
    await closeDocument(welcome.id, false);
  }
  for (const record of list) await addDocument(record);
  await adoptFolderFromMain();
  return list.at(-1).id;
}
/**
 * A file opened while no workspace is open makes its own directory the file
 * tree root in the main process. Mirror that here so the tree lists the
 * neighbours of the file that was just opened. The sidebar keeps its current
 * show / hide state (hidden by default, like Typora) and the main process is the
 * only place that decides which folder is current.
 */
async function adoptFolderFromMain() {
  if (!native || folder) return;
  const info = await api('activeFolder').catch(() => null);
  if (!info?.path || folder) return;
  folder = info;
  // The file tree is what the sidebar should offer next time it opens. A panel
  // the user already has in front of them stays as it is, and the sidebar's
  // visibility is never changed here.
  if (document.body.classList.contains('sidebar-hidden')) sideMode = 'files';
  drawSidebar();
  saveSession();
}
function activate(id, focusEditor = current()?.mount?.contains(document.activeElement)) {
  // An in-cell draft belongs to the outgoing document. Commit it before its
  // mount is detached; the background flush / autosave path never does this.
  if (activeId && activeId !== id) documents.get(activeId)?.editor?.commitActiveCell();
  if (activeId !== id) {
    hideSelectionTools();
    dismissedSelection = null;
    selectionComposing = false;
  }
  activeId = id;
  const doc = current();
  const host = $('#editor-host');
  const remounted = doc.mount.parentNode !== host;
  if (remounted) host.replaceChildren(doc.mount);
  doc.editor.setSource(sourceMode);
  updateScrollEdge(doc, true);
  doc.editor.view.requestMeasure();
  updateChrome(); updateStats(); drawSidebar(); updateSelectionStatus(doc.editor.view.state); saveSession();
  if (focusEditor) focusActiveEditor(id);
  if (remounted && !sourceMode) {
    renderDiagrams(doc.mount).then(() => {
      if (current() === doc && doc.mount.isConnected) doc.editor.view.requestMeasure();
    }).catch(() => {});
  }
  if (native && !cleanWelcome(doc)) loadWritingNotes(doc).catch(error => notify(error.message, true));
}

function focusActiveEditor(id) {
  if (id === activeId && !$('.main-pane').inert && !$('#dialog').open) current()?.editor.view.focus();
}
/**
 * Mirror asset-reference rewrites made by the main process (a Save As into a
 * folder that already owns a different image with the same name) into the live
 * editor. Starting from the editor's own text keeps anything typed while the
 * save was in flight, and one minimal replacement stays undoable.
 */
function applyAssetRewrites(doc, rewritten) {
  if (!doc?.editor || !Array.isArray(rewritten) || !rewritten.length) return;
  const before = doc.editor.text();
  const after = rewriteAssetReferences(before, rewritten);
  if (after === before) return;
  // Trim the untouched head and tail so only the reference itself changes.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  doc.editor.applyChange({ from: start, to: endBefore, insert: after.slice(start, endAfter) });
}
/**
 * Mirror a Save As / rename image-root relocation into the live text. The main
 * process edits only the actual leading front matter key; the renderer applies
 * the same edit to the current buffer, and only while that key still holds the
 * value the save started from. Text typed during the save is therefore kept,
 * and a code fence or body line with the same spelling is never touched.
 */
function applyImageRootRewrite(doc, rewrite) {
  if (!doc?.editor || !rewrite || typeof rewrite.expected !== 'string' || typeof rewrite.value !== 'string') return;
  const change = replaceFrontMatterImageRoot(doc.editor.text(), rewrite.expected, rewrite.value);
  if (change) doc.editor.applyChange(change);
}

function updateDirty(doc) {
  doc.dirty = !!doc.recovered || doc.content !== doc.savedContent;
}

function documentOperation(doc, action) {
  const pending = (doc.operation || Promise.resolve()).catch(() => {}).then(() => {
    if (documents.get(doc.id) === doc) return action();
  });
  doc.operation = pending;
  return pending.finally(() => {
    if (doc.operation === pending) delete doc.operation;
  });
}

async function applySavedDocument(doc, saved) {
  applyAssetRewrites(doc, saved.rewritten);
  applyImageRootRewrite(doc, saved.imageRootRewrite);
  doc.path = saved.path;
  doc.name = saved.name;
  doc.savedContent = saved.content;
  doc.recovered = !!saved.recovered;
  doc.error = '';
  updateDirty(doc);
  if (doc.dirty) await flush(doc);
  else await persistWritingAnchors(doc);
  if (saved.warnings?.length) notify(saved.warnings.join('\n'), true);
  doc.editor.view.dispatch({ effects: [] });
  updateChrome();
  saveSession();
}

function save(doc = current(), saveAs = false, { commitCell = false } = {}) {
  if (doc) return documentOperation(doc, () => saveNow(doc, saveAs, { commitCell }));
}

async function saveNow(doc, saveAs, { commitCell = false } = {}) {
  doc.saving = true;
  try {
    // An explicit save reads the document immediately. A cell draft lives only
    // in the in-cell editor until it is committed, so commit it first. Autosave
    // and background flushes call here without the flag and must leave the
    // active cell (and its focus) alone.
    if (commitCell) doc.editor.commitActiveCell({ focus: true });
    await flush(doc);
    const saved = await api('saveDocument', doc.id, saveAs);
    if (!saved) return;
    // Clashing images may have been renamed to a free name: apply the rewrite to
    // the live text before touching savedContent, otherwise the stale reference
    // would be flushed back into the store on the next save.
    await applySavedDocument(doc, saved);
    await adoptFolderFromMain();
    refreshSearch();
    if (folder) { folder = await api('refreshFolder'); drawSidebar(); }
  } finally { doc.saving = false; updateChrome(); }
}
async function closeDocument(id, createReplacement = true, includePath = false) {
  const doc = documents.get(id);
  if (!doc) return true;
  return (await documentOperation(doc, () => closeDocumentNow(doc, createReplacement, includePath))) ?? true;
}
async function closeDocumentNow(doc, createReplacement, includePath) {
  const { id } = doc;
  // Closing (or quitting) reads the document for the save prompt; a dirty cell
  // draft must be part of it. `closeDocument` is only reached from an explicit
  // close / quit loop, never from the background flush.
  doc.editor.commitActiveCell();
  await flush(doc);
  const pending = [...(doc.pendingNoteAnchors?.values() || [])];
  const closed = await api('closeDocument', id, true, pending);
  if (!closed) return false;
  if (closed.warnings?.length) notify(closed.warnings.join('\n'), true);
  const wasActive = activeId === id;
  const wasEditing = doc.mount.contains(document.activeElement);
  clearTimeout(doc.timer); clearTimeout(doc.statsTimer); doc.editor.destroy(); documents.delete(id); refreshSearch();
  if (!wasActive) {
    updateChrome(); drawSidebar(); saveSession();
  } else if (documents.size) {
    activate([...documents.keys()].at(-1), wasEditing);
  } else {
    activeId = undefined;
    if (createReplacement) await addDocument(await api('newDocument', ''), wasEditing);
    else saveSession();
  }
  return includePath ? closed : true;
}
// External changes are shown one at a time: the queue keeps a second prompt
// from silently replacing the first, and waits while another dialog is open.
const externalQueue = [];
let externalPrompt = null, dialogPurpose = null, closingForAction = false;
/** Put the prompt that is currently on screen back in front of the queue. */
function deferExternalPrompt() {
  if (!externalPrompt) return;
  const key = externalPrompt;
  externalPrompt = null;
  if (!externalQueue.includes(key)) externalQueue.unshift(key);
}
function queueExternalPrompt(id, kind = 'modified') {
  if (!documents.has(id)) return;
  const key = `${id}:${kind}`;
  if (externalPrompt === key || externalQueue.includes(key)) return;
  externalQueue.push(key);
  showNextExternalPrompt();
}
function showNextExternalPrompt() {
  if (externalPrompt || !externalQueue.length) return;
  if ($('#dialog').open) return;
  const key = externalQueue.shift();
  const [id, kind] = key.split(':');
  const doc = documents.get(id);
  if (!doc) { showNextExternalPrompt(); return; }
  externalPrompt = key;
  const safe = escapeHTML(doc.name);
  if (kind === 'deleted') {
    showDialog('文件已被删除', `<p class="dialog-description">磁盘上的“${safe}”已被其他程序删除。可以另存为新的文件，或保留为未保存的文档继续编辑。</p><div class="dialog-actions"><button data-external-action="detach">保留为未保存文档</button><button class="primary" data-external-action="save-as">另存为…</button></div>`, 'external');
    return;
  }
  showDialog('文件已在编辑器外修改', `<p class="dialog-description">磁盘上的“${safe}”已发生变化。重新加载会读取磁盘版本，当前的未保存内容会另存为恢复副本（不会自动删除）；保留本地内容后，下一次保存会覆盖磁盘版本，磁盘版本会先写入保存历史。</p><div class="dialog-actions"><button data-external-action="keep-local">保留本地内容</button><button class="primary" data-external-action="reload">重新加载磁盘版本</button></div>`, 'external');
}
async function applyDiskVersion(id, record) {
  const doc = documents.get(id);
  if (!doc) return;
  doc.savedContent = record.content;
  doc.error = '';
  doc.editor.setContent(record.content);
  doc.dirty = doc.content !== record.content;
  updateChrome(); updateStats(); drawSidebar();
}
async function handleExternalChange(id, kind = 'modified') {
  const doc = documents.get(id);
  if (!doc) return;
  // A clean document is replaced silently, the way Typora does it; only local
  // edits need a decision from the user.
  if (kind !== 'deleted' && !doc.dirty && !doc.saving) {
    try {
      await applyDiskVersion(id, await api('reloadDocument', id));
      notify(`“${doc.name}”已在磁盘上更新，已自动重新加载。`);
    } catch (error) { notify(error.message, true); }
    return;
  }
  queueExternalPrompt(id, kind);
}
async function resolveExternalPrompt(action) {
  const key = externalPrompt;
  if (!key) return;
  const [id] = key.split(':');
  // Cleared before closing so the dialog's own close handler only advances the
  // queue and never treats this as a dismissal.
  externalPrompt = null;
  const doc = documents.get(id);
  try {
    if (!doc) {
      // The document was closed while the prompt was on screen.
    } else if (action === 'keep-local') {
      await api('acceptExternalChange', id);
      notify(`已保留本地内容。下一次保存“${doc.name}”会覆盖磁盘版本，被覆盖的磁盘版本已写入保存历史。`);
    } else if (action === 'reload') {
      const record = await api('reloadDocument', id);
      await applyDiskVersion(id, record);
      notify(record.discarded ? `已重新加载磁盘版本。本地内容已另存为：${record.discarded}` : '已重新加载磁盘版本。');
    } else if (action === 'save-as') {
      await save(doc, true, { commitCell: true });
    } else if (action === 'detach') {
      const record = await api('detachDocument', id);
      Object.assign(doc, { path: null, name: record.name, savedContent: '' });
      doc.error = '';
      updateChrome(); drawSidebar();
      notify('该文档已保留为未保存文档，请选择位置另存为。');
    }
  } catch (error) { notify(error.message, true); }
  const node = $('#dialog');
  if (node.open) {
    // The dialog's `close` event arrives asynchronously; remember that this
    // close belongs to the action so it cannot dismiss the next prompt.
    closingForAction = true;
    node.close();
  }
  showNextExternalPrompt();
}
async function applyCustomTheme(value) {
  // Theme reads are asynchronous. A slower older read must not overwrite the
  // theme the user selected afterwards, including a switch back to built-in.
  const request = ++customThemeSeq;
  const custom = String(value).startsWith('custom:') ? value.slice(7) : '';
  if (!custom) { document.getElementById('custom-theme')?.remove(); return; }
  let css;
  try { css = await api('readTheme', custom); }
  catch (error) { if (request === customThemeSeq) throw error; return; }
  if (request !== customThemeSeq) return;
  const node = document.getElementById('custom-theme') || Object.assign(document.createElement('style'), { id: 'custom-theme' });
  node.textContent = css;
  if (!node.isConnected) document.head.append(node);
}
function applyPreferences() {
  const custom = String(prefs.theme).startsWith('custom:');
  const theme = prefs.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : custom ? 'light' : prefs.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--editor-size', `${prefs.fontSize}px`);
  document.documentElement.style.setProperty('--editor-width', `${prefs.lineWidth}px`);
  document.documentElement.style.setProperty('--sidebar-width', `${Number(prefs.sidebarWidth) || 240}px`);
  $('#sidebar-resizer').setAttribute('aria-valuenow', Number(prefs.sidebarWidth) || 240);
  // Retain the stored layout IDs for existing installations and custom themes.
  const ui = prefs.uiMode === 'workbench' ? 'workbench' : 'typora';
  document.documentElement.dataset.ui = ui;
  syncSidebar();
  $('[data-command="focus"]').setAttribute('aria-pressed', String(!!prefs.focus));
  const themeButton = $('.status-actions [data-command="theme"]');
  themeButton.innerHTML = icon(theme === 'dark' ? 'moon' : theme === 'sepia' ? 'sun' : 'theme');
  themeButton.title = `切换主题（当前${{ dark: '深色', sepia: '纸张', light: '浅色' }[theme]}）`;
  $('.topbar [data-command="source"]').setAttribute('aria-pressed', String(sourceMode));
  document.body.classList.toggle('focus-mode', prefs.focus);
  document.body.classList.toggle('typewriter-mode', prefs.typewriter);
  document.body.classList.toggle('math-numbering', !!prefs.mathNumbering);
  // Auto-numbering is now part of the rendered KaTeX tree (so `\ref` and the
  // HTML export agree with the screen). A preference change must therefore
  // invalidate the per-document block cache and refresh every open editor.
  if (setMathNumbering(!!prefs.mathNumbering)) {
    for (const doc of documents.values()) doc.editor.refreshRendered();
  }
  // The optional global image root is baked into every root-relative asset
  // URL, so changing it has to rebuild the blocks that carry one as well.
  if (setImageRootSetting(prefs.imageRoot || '')) {
    for (const doc of documents.values()) doc.editor.refreshRendered();
  }
  document.body.classList.toggle('heading-numbering', !!prefs.headingNumbering);
  document.body.classList.toggle('hide-formatbar', prefs.showFormatbar === false);
  const themeKey = custom ? prefs.theme : theme;
  const themeUpdate = applyCustomTheme(prefs.theme);
  const request = customThemeSeq;
  themeUpdate.then(() => {
    if (request !== customThemeSeq) return;
    return refreshDiagrams(document, themeKey);
  }).catch(error => notify(error.message, true));
  for (const doc of documents.values()) doc.editor.setSpellcheck(prefs.spellcheck);
}
async function setPreferences(patch) { prefs = { ...prefs, ...patch }; applyPreferences(); await api('settings', patch); }
const sidebarPreference = () => prefs?.uiMode === 'workbench' ? 'workbenchSidebarVisible' : 'sidebarVisible';
function syncSidebar() {
  const drawer = compactLayout.matches && compactSidebarOpen;
  const visible = compactLayout.matches ? drawer : !!prefs?.[sidebarPreference()];
  const sidebar = $('#writing-sidebar');
  const toggle = $('.topbar [data-command="sidebar"]');
  toggle.setAttribute('aria-controls', sidebar.id);
  toggle.setAttribute('aria-expanded', String(visible));
  document.body.classList.toggle('sidebar-hidden', !visible);
  sidebar.inert = !visible;
  if (drawer) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
  }
  $('.topbar').inert = drawer;
  $('.main-pane').inert = drawer;
}
function setSidebarVisible(visible) {
  if (compactLayout.matches) {
    document.body.classList.add('drawer-animated');
    compactSidebarOpen = visible;
    syncSidebar();
    $(visible ? '.sidebar-tabs [aria-selected="true"]' : '.topbar [data-command="sidebar"]').focus();
    return;
  }
  const pane = $('.main-pane');
  const previousX = pane.getBoundingClientRect().left;
  // Applying the preference lays out the new width before the write to disk.
  setPreferences({ [sidebarPreference()]: visible }).catch(error => notify(error.message, true));
  const delta = previousX - pane.getBoundingClientRect().left;
  if (delta && !reduceMotion.matches) {
    pane.animate([{ transform: `translateX(${delta}px)` }, { transform: 'none' }], {
      duration: 240, easing: 'cubic-bezier(.18,.75,.24,1)'
    });
  }
}
function dismissCompactSidebar() {
  if (compactLayout.matches && compactSidebarOpen) setSidebarVisible(false);
}
compactLayout.addEventListener('change', () => {
  const inside = $('#writing-sidebar').contains(document.activeElement);
  document.body.classList.remove('drawer-animated');
  compactSidebarOpen = false;
  syncSidebar();
  if (current()) updateScrollEdge(current(), true);
  if (inside && $('#writing-sidebar').inert) $('.topbar [data-command="sidebar"]').focus();
});
systemDark.addEventListener('change', () => { if (prefs?.theme === 'system') applyPreferences(); });
function dialogContent(title, body) {
  // Any dialog that is not an external-change prompt takes over the screen.
  dialogPurpose = 'other';
  $('#dialog').style.removeProperty('--sheet-drag');
  $('#dialog-content').innerHTML = `<div class="sheet-grabber" aria-hidden="true"></div><div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-dismiss aria-label="关闭对话框">${icon('close')}</button></div>${body}`;
}
function showDialog(title, body, purpose = 'other') {
  if (purpose !== 'external') deferExternalPrompt();
  dialogContent(title, body);
  dialogPurpose = purpose;
  const node = $('#dialog');
  // Never throw when a queued prompt still owns the dialog: the newest content
  // wins and the prompt is put back in the queue instead of being lost.
  if (!node.open) node.showModal();
}
const flattenFiles = entries => entries.flatMap(entry => entry.children ? flattenFiles(entry.children) : [entry]);
const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
// Typora's own file shortcuts: macOS uses ⌘⇧O for quick open and leaves folder
// opening to its menu item / sidebar button; Windows / Linux keep Ctrl+P for
// quick open and Ctrl+Shift+O for a folder.
const macDesktop = () => native && appPlatform === 'darwin';
// One palette for both files and actions: quicker than hunting through menus,
// and it doubles as a discoverable shortcut reference.
const paletteCommands = () => [
  ['新建文档', 'new', '文件', `${modKey}N`],
  ['新建窗口', 'new-window', '文件', `${modKey}⇧N`],
  ['打开文档…', 'open', '文件', `${modKey}O`],
  ['打开文件夹…', 'folder', '文件', macDesktop() ? '' : `${modKey}⇧O`],
  ['搜索文档…', 'folder-search', '文件', `${modKey}⇧F`],
  ['最近打开的文件…', 'recent-files', '文件', ''],
  ['命令面板 / 快速打开…', 'quick-open', '文件', macDesktop() ? `${modKey}⇧O` : `${modKey}P`],
  ['保存', 'save', '文件', `${modKey}S`],
  ['另存为…', 'save-as', '文件', `${modKey}⇧S`],
  ['导出…', 'export', '文件', `${modKey}⇧E`],
  ['重命名 / 移动…', 'rename', '文件', `${modKey}⇧R`],
  ['在文件夹中显示', 'reveal', '文件', ''],
  [`移到${trashName()}`, 'trash', '文件', ''],
  ['查看保存历史…', 'history', '文件', ''],
  ['重新打开已关闭文件', 'reopen-closed', '文件', `${modKey}⇧T`],
  ['查找与替换', 'find', '编辑', `${modKey}F`],
  ['复制为 Markdown', 'copy-markdown', '编辑', `${modKey}⇧C`],
  ['复制为 HTML', 'copy-html', '编辑', ''],
  ...(native ? [['复制选区为图片', 'copy-selection-image', '编辑', ''], ['留个续写提示', 'writing-note-add', '编辑', '']] : []),
  ['粘贴为纯文本', 'paste-plain', '编辑', `${modKey}⇧V`],
  ['清除格式', 'clear-format', '编辑', `${modKey}\\`],
  ['插入表格', 'table', '段落', `${modKey}T`],
  ['表格图形化编辑…', 'edit-table', '段落', ''],
  ['插入表情…', 'emoji', '编辑', ''],
  ['插入代码块', 'code', '段落', `${modKey}⇧K`],
  ['插入公式块', 'math', '段落', `${modKey}⇧M`],
  ['插入图表', 'diagram', '段落', `${modKey}Alt+D`],
  ['插入文内目录', 'toc', '段落', ''],
  ['插入图片…', 'image', '段落', ''],
  ['设置文档图片根目录…', 'image-root', '段落', ''],
  ['源码模式', 'source', '视图', `${modKey}/`],
  ['切换侧边栏', 'sidebar', '视图', `${modKey}⇧L`],
  ['切换布局（简洁写作 / 完整工作台）', 'toggle-ui', '视图', ''],
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
  const commands = paletteCommands().filter(c => !needle || c.label.toLowerCase().includes(needle) || c.group.includes(needle)).slice(0, 14);
  const files = quickFiles.filter(file => !needle || file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle)).slice(0, 20);
  const rows = [
    ...commands.map(c => `<button class="quick-item" data-quick-command="${c.command}"><strong>${escapeHTML(c.label)}</strong><span>${escapeHTML(c.group)}${c.keys ? ` · ${escapeHTML(c.keys)}` : ''}</span></button>`),
    // An already-open document switches tabs; it must work with no folder open.
    ...files.map(file => file.id
      ? `<button class="quick-item" data-quick-document="${escapeHTML(file.id)}"><strong>${escapeHTML(file.name)}</strong><span>已打开${file.path ? ` · ${escapeHTML(file.path)}` : ' · 未保存'}</span></button>`
      : `<button class="quick-item" data-quick-path="${escapeHTML(file.path)}"><strong>${escapeHTML(file.name)}</strong><span>${file.recent ? '最近打开 · ' : ''}${escapeHTML(file.path)}</span></button>`)
  ];
  node.innerHTML = rows.length ? rows.join('') : '<div class="empty-state"><p>没有匹配项</p><small>输入命令名或文件名；打开文件夹后可以搜索全部 Markdown 文档。</small></div>';
  quickIndex = 0;
  highlightQuick();
}
async function runQuickItem(element) {
  dismissCompactSidebar();
  try {
    if (element.dataset.quickDocument) activate(element.dataset.quickDocument, true);
    else if (element.dataset.quickPath) await openDocuments(await api('openPath', element.dataset.quickPath));
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
  deferExternalPrompt();
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
function insertImage(file, doc = current()) {
  if (doc) return documentOperation(doc, () => insertImageNow(file, doc));
}
async function insertImageNow(file, doc) {
  try {
    let payload;
    if (file) {
      if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB。');
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      payload = { data, extension: file.type.split('/')[1].replace('jpeg', 'jpg') };
    }
    const relative = await api('insertImage', doc.id, payload);
    if (relative) {
      doc.editor.insert(`![图片](${relative})`);
      await flush(doc);
    }
  } catch (error) { notify(error.message, true); }
}
const defaultPdfExport = () => ({ header: '', footer: '', pageNumbers: false, pageSize: 'css', landscape: false, margins: 'css' });
const pdfExportConfig = () => ({ ...defaultPdfExport(), ...(prefs?.pdfExport || {}) });
const pdfPresets = () => Array.isArray(prefs?.pdfPresets) ? prefs.pdfPresets : [];

/** Read the PDF option fields, or fall back to the persisted last-used values. */
function currentPdfExport() {
  const root = $('#pdf-export-options');
  if (!root) return pdfExportConfig();
  return {
    header: $('#pdf-header')?.value || '',
    footer: $('#pdf-footer')?.value || '',
    pageNumbers: !!$('#pdf-page-numbers')?.checked,
    pageSize: $('#pdf-page-size')?.value || 'css',
    landscape: !!$('#pdf-landscape')?.checked,
    margins: $('#pdf-margins')?.value || 'css'
  };
}

const pdfPresetSelectOptions = selected => ['<option value="">自定义</option>', ...pdfPresets().map((preset, index) => `<option value="${index}" ${preset.name === selected ? 'selected' : ''}>${escapeHTML(preset.name)}</option>`)].join('');

function pdfExportOptionsHTML(config = pdfExportConfig()) {
  const pageSizes = [['css', '跟随打印样式（A4）'], ['A0', 'A0'], ['A1', 'A1'], ['A2', 'A2'], ['A3', 'A3'], ['A4', 'A4'], ['A5', 'A5'], ['A6', 'A6'], ['Letter', 'Letter'], ['Legal', 'Legal'], ['Tabloid', 'Tabloid'], ['Ledger', 'Ledger']];
  const margins = [['css', '与打印样式一致（20 / 18 mm）'], ['normal', '常规（1 in）'], ['narrow', '窄（0.5 in）'], ['wide', '宽（1.5 in）']];
  return `<div class="pdf-export-options" id="pdf-export-options">
    <div class="pdf-export-heading"><strong>PDF 选项</strong><span>页眉页脚按纯文本处理；可用 \${pageNo}、\${pageCount} 或 \${totalPages} 插入页码。留空并使用“跟随打印样式”时保持原有默认输出。</span></div>
    <label class="pdf-wide">预设<select id="pdf-preset-select">${pdfPresetSelectOptions('')}</select></label>
    <div class="pdf-grid">
      <label>页眉<input id="pdf-header" type="text" maxlength="500" value="${escapeHTML(config.header || '')}" placeholder="例如：\${pageNo} / \${pageCount}"></label>
      <label>页脚<input id="pdf-footer" type="text" maxlength="500" value="${escapeHTML(config.footer || '')}" placeholder="例如：第 \${pageNo} 页"></label>
      <label>纸张<select id="pdf-page-size">${pageSizes.map(([value, label]) => `<option value="${value}" ${config.pageSize === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>页边距<select id="pdf-margins">${margins.map(([value, label]) => `<option value="${value}" ${config.margins === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <label class="checkbox-label"><span>显示页码（页脚没有页码占位符时自动追加 \${pageNo} / \${pageCount}）</span><input id="pdf-page-numbers" type="checkbox" ${config.pageNumbers ? 'checked' : ''}></label>
    <label class="checkbox-label"><span>横向纸张</span><input id="pdf-landscape" type="checkbox" ${config.landscape ? 'checked' : ''}></label>
    <div class="pdf-preset-row"><input id="pdf-preset-name" type="text" maxlength="40" placeholder="预设名称"><button type="button" data-pdf-preset-action="save">保存预设</button><button type="button" data-pdf-preset-action="delete">删除预设</button><button type="button" data-pdf-preset-action="reset">恢复默认</button></div>
  </div>`;
}

function refreshPdfPresetSelect(selected = '') {
  const select = $('#pdf-preset-select');
  if (select) select.innerHTML = pdfPresetSelectOptions(selected);
}

/** Fill the PDF form from one saved preset; keeping the name lets «保存预设» replace it. */
function applyPdfPreset(index) {
  if (index === '' || index === undefined || index === null) return;
  const preset = pdfPresets()[Number(index)];
  if (!preset) return;
  $('#pdf-header').value = preset.header || '';
  $('#pdf-footer').value = preset.footer || '';
  $('#pdf-page-numbers').checked = !!preset.pageNumbers;
  $('#pdf-page-size').value = preset.pageSize || 'css';
  $('#pdf-landscape').checked = !!preset.landscape;
  $('#pdf-margins').value = preset.margins || 'css';
  $('#pdf-preset-name').value = preset.name;
}

async function savePdfPreset() {
  const name = ($('#pdf-preset-name')?.value || '').trim();
  if (!name) { notify('请先填写预设名称。', true); return; }
  const config = currentPdfExport();
  const next = pdfPresets().filter(preset => preset.name.toLowerCase() !== name.toLowerCase());
  next.unshift({ name, ...config });
  const bounded = next.slice(0, 20);
  try {
    const saved = await api('settings', { pdfPresets: bounded });
    Object.assign(prefs, saved);
    refreshPdfPresetSelect(name);
    $('#pdf-preset-name').value = name;
    notify(`已保存 PDF 预设：${name}`);
  } catch (error) { notify(error.message, true); }
}

async function deletePdfPreset() {
  const selected = $('#pdf-preset-select');
  if (!selected || selected.value === '') { notify('请先选择一个预设。', true); return; }
  const preset = pdfPresets()[Number(selected.value)];
  if (!preset) { notify('请先选择一个预设。', true); return; }
  try {
    const saved = await api('settings', { pdfPresets: pdfPresets().filter(entry => entry.name !== preset.name) });
    Object.assign(prefs, saved);
    refreshPdfPresetSelect('');
    $('#pdf-preset-name').value = '';
    notify(`已删除 PDF 预设：${preset.name}`);
  } catch (error) { notify(error.message, true); }
}

function exportCSS() {
  const chromeRule = /\.(?:code-copy|table-column-resizer)\b/;
  return [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].filter(rule => !chromeRule.test(rule.selectorText || '')).map(rule => rule.cssText); } catch { return []; } }).join('\n');
}
function pngRequest(name, target, css = exportCSS()) {
  const width = Math.round((Number(prefs.lineWidth) || 860) + 96);
  // A Typora theme paints its paper on #write/body, which the loader scopes
  // to .prose. Use that computed paper for the capture background so the
  // PNG margins match the themed document instead of the app chrome.
  const pagePaper = getComputedStyle(target).backgroundColor;
  const background = pagePaper && pagePaper !== 'rgba(0, 0, 0, 0)' && pagePaper !== 'transparent'
    ? pagePaper
    : (getComputedStyle(document.body).backgroundColor || '#ffffff');
  return {
    html: pngHTML(name, target.innerHTML, css, {
      width, background,
      theme: document.documentElement.dataset.theme || 'light',
      ui: document.documentElement.dataset.ui || 'typora',
      headingNumbering: !!prefs.headingNumbering
    }),
    width,
    pixelRatio: window.devicePixelRatio || 1
  };
}

async function exportDocument(format) {
  const doc = current(); if (!doc) return;
  doc.editor.commitActiveCell();
  const source = doc.content, name = displayName(doc);
  const pdfConfig = format === 'pdf' ? currentPdfExport() : null;
  await flush(doc);
  if (format === 'zip') {
    const result = await api('exportDocument', doc.id, format);
    if (result) notify(`已导出：${result}`, false, result);
    return;
  }
  // `chrome: false` drops the editor-only affordances (code copy buttons,
  // front-matter / alert decorations) so the serialized HTML and the printed
  // PDF carry the document body only.
  // Every language the document fences must be registered before the export is
  // serialised, otherwise a lazily loaded language would export unstyled.
  await ensureLanguages(source);
  const target = $('#print-document'); target.innerHTML = renderMarkdown(source, doc.id, { chrome: false, mathNumbering: !!prefs.mathNumbering });
  await renderDiagrams(target);
  await document.fonts.ready;
  await Promise.all([...target.querySelectorAll('img')].map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); }));

  let request;
  if (format === 'html' || format === 'png') {
    // Editor-only affordances have no meaning in a shared file: drop the copy
    // button and column-resize rules from the inlined stylesheet, so an export
    // carries neither the button nor a trace of it.
    const css = exportCSS();
    if (format === 'html') request = { html: styledHTML(name, target.innerHTML, css) };
    else request = pngRequest(name, target, css);
  } else if (format === 'html-unstyled') {
    request = { html: unstyledHTML(name, target) };
  } else if (format === 'pdf') {
    const css = exportCSS();
    request = {
      pdf: pdfConfig,
      html: printHTML(name, target.innerHTML, css, {
        theme: document.documentElement.dataset.theme || 'light',
        ui: document.documentElement.dataset.ui || 'typora',
        headingNumbering: !!prefs.headingNumbering
      })
    };
  }

  const result = await api('exportDocument', doc.id, format, request);
  if (result) {
    // Remembering the last successful configuration makes the next export
    // repeatable, but only after the save succeeded: cancelling the dialog must
    // not change a preset or another document's defaults.
    if (format === 'pdf') {
      try { const saved = await api('settings', { pdfExport: pdfConfig }); Object.assign(prefs, saved); } catch { /* the file is already saved */ }
    }
    notify(`已导出：${result}`, false, result);
  }
}
async function runCommand(command, detail) {
  const editor = current()?.editor;
  try {
    if (/^heading-[1-6]$/.test(command)) { editor?.prefix('#'.repeat(Number(command.slice(-1))) + ' '); return; }
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
      'copy-html': async () => {
        const source = selectedSource();
        // The export path waits for on-demand languages too, so the clipboard
        // copy matches what the editor shows.
        await ensureLanguages(source);
        await api('writeClipboard', { text: source, html: renderMarkdown(source, activeId, { chrome: false, mathNumbering: !!prefs.mathNumbering }) });
      },
      'paste-plain': async () => { const text = await api('readClipboardText'); editor?.insert(String(text).replace(/\r\n/g, '\n')); },
      'panel-outline': () => { sideMode = 'outline'; setSidebarVisible(true); drawSidebar(); },
      'panel-files': () => { sideMode = 'files'; setSidebarVisible(true); drawSidebar(); },
      'panel-articles': () => { sideMode = 'articles'; setSidebarVisible(true); drawSidebar(); },
      'zoom-in': () => api('zoom', 1),
      'zoom-out': () => api('zoom', -1),
      'zoom-reset': () => api('zoom', 0),
      fullscreen: () => api('fullscreen'),
      'themes-folder': () => api('openThemesFolder'),
      'history-folder': () => api('history'),
      'next-document': () => {
        const ids = [...documents.keys()];
        if (ids.length > 1) activate(ids[(ids.indexOf(activeId) + 1) % ids.length]);
      },
      'previous-document': () => {
        const ids = [...documents.keys()];
        if (ids.length > 1) activate(ids[(ids.indexOf(activeId) - 1 + ids.length) % ids.length]);
      },
      'app-menu': async () => {
        // Windows / Linux: pop the full native menu from the topbar button.
        const rect = $('.app-menu-button')?.getBoundingClientRect();
        await api('appMenu', { x: Math.round(rect?.left || 0), y: Math.round(rect?.bottom || 38) });
      }
    };
    if (simple[command]) { await simple[command](); return; }
    switch (command) {
      case 'selection-link': await linkSelection(); break;
      case 'copy-selection-image': await copySelectionImage(); break;
      case 'writing-note-add': await addWritingNote(); break;
      case 'undo': editor?.undo(); break;
      case 'redo': editor?.redo(); break;
      case 'welcome-new': {
        const example = current();
        const record = await api('newDocument', '');
        if (cleanWelcome(example)) {
          welcomeId = null;
          await closeDocument(example.id, false);
        }
        await addDocument(record, true);
        break;
      }
      case 'new': await addDocument(await api('newDocument', ''), true); break;
      case 'new-window': await api('newWindow'); break;
      case 'welcome-open':
      case 'open': await openDocuments(await api('openDocument')); break;
      case 'folder': { const selected = await api('openFolder'); if (selected) { folder = selected; refreshSearch(); sideMode = 'files'; setSidebarVisible(true); drawSidebar(); } saveSession(); break; }
      case 'open-recent': {
        if (!detail?.path) break;
        await openDocuments(await api('openPath', detail.path));
        break;
      }
      case 'open-recent-folder': {
        if (!detail?.path) break;
        const info = await api('openFolderPath', detail.path);
        if (info) { folder = info; refreshSearch(); sideMode = 'files'; setSidebarVisible(true); drawSidebar(); saveSession(); }
        break;
      }
      case 'refresh-recent': recentFiles = await api('recentFiles'); break;
      case 'folder-search': {
        sideMode = 'search';
        setSidebarVisible(true);
        drawSidebar();
        $('#folder-search-input')?.focus();
        break;
      }
      case 'recent-files': {
        recentFiles = await api('recentFiles');
        const rows = recentFiles.length
          ? recentFiles.map(file => `<button class="quick-item" data-quick-path="${escapeHTML(file.path)}"><strong>${escapeHTML(file.name)}</strong><span>${escapeHTML(file.path)}</span></button>`).join('')
          : '<div class="empty-state"><p>还没有最近打开的文件</p><small>打开或保存文档后，它会出现在这里和“文件 → 最近打开”菜单中。</small></div>';
        showDialog('最近打开', `<p class="dialog-description">最多保留 20 个文件；已删除的文件会自动移除。</p><div class="menu-list">${rows}</div>`);
        break;
      }
      case 'save': await save(current(), false, { commitCell: true }); break;
      case 'save-as': await save(current(), true, { commitCell: true }); break;
      case 'close': await closeDocument(activeId); break;
      case 'find': editor?.find(); break;
      case 'source':
        sourceMode = !sourceMode;
        editor?.setSource(sourceMode); editor?.view.focus();
        $('#mode-label').textContent = sourceMode ? 'Markdown 源码' : '即时渲染';
        $('[data-command="source"]').setAttribute('aria-pressed', String(sourceMode));
        break;
      case 'toolbar-menu': showDialog('更多操作', toolbarMenuHTML(sourceMode)); break;
      case 'expand-tools':
        $('.main-pane').classList.remove('tools-folded');
        $('.status-actions [data-command="focus"]').focus({ preventScroll: true });
        break;
      case 'sidebar': setSidebarVisible(document.body.classList.contains('sidebar-hidden')); break;
      case 'focus': await setPreferences({ focus: !prefs.focus }); break;
      case 'typewriter': await setPreferences({ typewriter: !prefs.typewriter }); break;
      case 'theme': await setPreferences({ theme: ['light', 'dark', 'sepia'][(['light', 'dark', 'sepia'].indexOf(prefs.theme) + 1) % 3] }); break;
      case 'toggle-ui': await setPreferences({ uiMode: prefs.uiMode === 'workbench' ? 'typora' : 'workbench' }); break;
      case 'quote': editor?.prefix('> '); break;
      case 'task': editor?.prefix('- [ ] '); break;
      case 'image': await insertImage(); break;
      case 'image-root': {
        // The explicit local entry for typora-root-url. The chosen folder is
        // written into the document's own front matter, not into hidden state,
        // so the preview, exports and a later reopen all read the same value.
        const doc = current();
        if (!doc) break;
        const picked = await api('chooseImageRoot', doc.id);
        if (!picked) break;
        const change = setFrontMatterImageRoot(doc.editor.text(), picked.value);
        if (!change) { notify('无法写入文档属性。', true); break; }
        doc.editor.applyChange(change);
        notify(`图片根目录已设为：${picked.value}`);
        break;
      }
      case 'import': { const doc = await api('importDocument'); if (doc) await openDocuments(doc); break; }
      case 'export': {
        // Presets are stored in the main process and shared by windows. Refresh
        // before drawing the dialog so another window's saved preset and the
        // last successful PDF defaults are visible here too.
        const latestSettings = await api('settings').catch(() => null);
        if (latestSettings && typeof latestSettings === 'object') Object.assign(prefs, latestSettings);
        const external = ['docx', 'odt', 'epub', 'tex', 'rst'];
        // The browser preview only knows the browser's print dialog and a
        // download; it must not advertise PNG or the main-process PDF options.
        const formats = native ? ['pdf', 'png', 'html'] : ['pdf', 'html'];
        const descriptions = {
          pdf: '适合打印或发送',
          html: '自包含样式与图片',
          'html-unstyled': '无样式 · 语义 HTML',
          png: '整篇长图 · 离线捕获',
          zip: 'Markdown 原稿与本地图片'
        };
        const formatButton = format => {
          const needsPandoc = external.includes(format);
          const locked = needsPandoc && !capabilities.installed;
          const label = ({ html: '网页 · HTML', png: '长图 · PNG', 'html-unstyled': '无样式 HTML' })[format] || format.toUpperCase();
          const description = descriptions[format] || (!needsPandoc ? '直接导出' : locked ? '需要 Pandoc（未安装）' : 'Pandoc 可用');
          return `<button data-export="${format}" ${locked ? 'disabled aria-disabled="true"' : ''}><strong>${label}</strong><span>${description}</span></button>`;
        };
        const options = formats.map(formatButton).join('');
        const note = !native
          ? '浏览器预览只支持 HTML 与 PDF（使用系统打印对话框）。PNG、HTML（无样式）和 PDF 页眉页脚需要桌面版。'
          : capabilities.installed
            ? `已检测到 ${escapeHTML(capabilities.version || 'Pandoc')}，全部格式可用。`
            : '未检测到 Pandoc。DOCX / ODT / EPUB / LaTeX / RST 需要安装 Pandoc（macOS 可执行 <code>brew install pandoc</code>，或访问 pandoc.org/installing.html），安装后重启墨页即可解锁。HTML、HTML（无样式）、PNG 与 PDF 始终可用，HTML / TXT / Markdown 也可直接导入。';
        const advanced = native ? `<details class="export-details" id="pdf-settings"><summary>PDF 设置</summary>${pdfExportOptionsHTML(pdfExportConfig())}</details>
          <details class="export-details" id="more-export-formats"><summary>更多格式</summary>
          <div class="export-options">${['html-unstyled', 'zip', ...external].map(formatButton).join('')}</div><p class="dialog-description">${note}</p></details>`
          : `<p class="dialog-description">${note}</p>`;
        showDialog('导出文档', `<div class="export-options">${options}</div>${advanced}`);
        break;
      }
      case 'settings': {
        customThemes = await api('listThemes');
        const options = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色'], ['sepia', '纸张'], ...customThemes.map(name => [`custom:${name}`, `自定义 · ${name.replace(/\.css$/i, '')}`])];
        showDialog('偏好设置', preferencesHTML(prefs, options));
        break;
      }
      case 'document-menu': showDialog('文档操作', `<div class="menu-list">${[['save-as', '另存为…'], ['rename', '重命名 / 移动…'], ['image-root', '设置图片根目录…'], ['reveal', '在文件夹中显示'], ['history', '查看保存历史…'], ['toc', '插入文内目录'], ['task', '插入任务项'], ['quote', '插入引用'], ['trash', `移到${trashName()}`]].map(([key, label]) => `<button data-menu-command="${key}">${label}</button>`).join('')}</div>`); break;
      case 'edit-table': {
        if (!detail?.source) {
          // Invoked from the palette / menu: operate on the table at the caret.
          const head = editor?.caretOffset() ?? 0;
          // Table offsets come from the editor's LF text, which shares its
          // coordinate system with CodeMirror positions (doc.content is the
          // on-disk form and may use CRLF).
          const tables = parseTables(editor?.text() || '');
          const found = tables.find(table => table.start <= head && head <= table.end);
          if (!found) { notify('请先把光标放到表格中，或右键点击表格。', true); break; }
          pendingTable = { from: found.start, to: found.end, table: found };
        } else {
          const tables = parseTables(detail.source);
          const table = tables[detail.index ?? 0];
          if (!table) { notify('未找到可编辑的表格。', true); break; }
          // Widget source and CodeMirror document positions both use one
          // internal character per line break, including CRLF files.
          const toDoc = offset => detail.from + offset;
          pendingTable = { from: toDoc(table.start), to: toDoc(table.end), table };
        }
        renderTableDialog();
        if (!$('#dialog').open) $('#dialog').showModal();
        break;
      }
      case 'emoji': {
        const rows = EMOJI.map(([code, glyph]) => `<button class="emoji-item" data-emoji="${escapeHTML(glyph)}" title="${escapeHTML(code)}" aria-label="${escapeHTML(code)}">${escapeHTML(glyph)}</button>`).join('');
        showDialog('插入表情', `<p class="dialog-description">正文中输入 <code>:smile:</code> 会自动补全为表情；也可以在这里直接挑选。</p><label class="quick-filter"><span class="sr-only">搜索表情</span><input id="emoji-filter" type="search" placeholder="搜索表情名称…" autocomplete="off"></label><div class="emoji-grid" id="emoji-grid">${rows}</div>`);
        $('#emoji-filter').focus();
        break;
      }
      case 'quick-open': {
        const info = folder ? await api('refreshFolder') : null;
        if (info) { folder = info; }
        recentFiles = await api('recentFiles');
        const files = info ? flattenFiles(info.entries) : [];
        // Every open document is listed, saved or not, and wins over the copy
        // of the same file the folder tree would offer.
        const opened = [...documents.values()].map(doc => ({ name: doc.name, path: doc.path || '', id: doc.id }));
        const openedPaths = new Set(opened.map(doc => doc.path).filter(Boolean));
        // Recent files are searchable too, including ones outside the folder.
        const recent = recentFiles.filter(file => !openedPaths.has(file.path) && !files.some(entry => entry.path === file.path));
        quickFiles = [...opened, ...recent.map(file => ({ ...file, recent: true })), ...files.filter(file => !openedPaths.has(file.path))];
        showDialog('命令面板', '<label class="quick-filter"><span class="sr-only">搜索命令或文件</span><input id="quick-filter" type="search" placeholder="搜索命令或文件…" autocomplete="off"></label><div class="menu-list quick-list" id="quick-results"></div><p class="palette-hint">↑ ↓ 选择 · Enter 执行 · Esc 关闭</p>');
        quickOpenResults();
        $('#quick-filter').focus();
        break;
      }
      case 'rename': {
        const doc = current();
        if (!doc) break;
        await documentOperation(doc, async () => {
          await flush(doc);
          const result = await api('renameDocument', doc.id);
          if (!result) return;
          await applySavedDocument(doc, result);
          if (result.warnings?.length) notify(result.warnings.join('\n'), true);
        });
        break;
      }
      case 'reveal': await api('revealDocument', activeId); break;
      case 'history': {
        const entries = await api('listHistory', activeId);
        selectedHistory = null;
        const list = entries.length
          ? entries.map(entry => `<button class="history-item" data-history="${escapeHTML(entry.name)}" data-history-dir="${escapeHTML(entry.dir)}"><strong>${escapeHTML(entry.label)}</strong><span>${escapeHTML(entry.hint || (entry.legacy ? '旧版历史记录' : '当前文件'))}</span></button>`).join('')
          : '<div class="empty-state"><p>暂无历史版本</p><small>对已保存文档做修改并再次保存时，会自动保留上一版本。</small></div>';
        showDialog('保存历史', `<p class="dialog-description">选择版本可预览内容；恢复会替换当前文档并标记为未保存，确认后请自行保存。</p><div class="history-list">${list}</div><pre class="history-preview" id="history-preview" hidden></pre><div class="dialog-actions"><button data-menu-command="history-folder">在文件管理器中查看</button><button id="compare-history" data-menu-command="compare-history" disabled>与当前版本对比</button><button class="primary" id="restore-history" data-menu-command="restore-history" disabled>恢复此版本</button></div>`);
        break;
      }
      case 'restore-history': {
        if (!selectedHistory) break;
        const content = await api('readHistory', selectedHistory.dir, selectedHistory.name);
        current()?.editor.setContent(content);
        selectedHistory = null;
        break;
      }
      case 'compare-history': {
        if (!selectedHistory) break;
        const previous = await api('readHistory', selectedHistory.dir, selectedHistory.name);
        const now = current()?.content || '';
        const { rows, approximate } = compareLines(previous, now);
        showDialog('版本对比', `<p class="dialog-description">− 表示历史版本独有，+ 表示当前版本新增。${approximate ? POSITIONAL_DIFF_NOTE : ''}</p><div class="diff-view" role="table" aria-label="版本差异"></div><p id="diff-progress" role="status"></p><div class="dialog-actions"><button id="diff-more">继续显示</button><button data-menu-command="history">返回历史列表</button><button class="primary" data-dismiss>关闭</button></div>`);
        const list = $('#dialog .diff-view');
        const progress = $('#dialog #diff-progress');
        const more = $('#dialog #diff-more');
        let shown = 0;
        const append = () => {
          const next = Math.min(shown + 3000, rows.length);
          list.insertAdjacentHTML('beforeend', renderDiffRows(rows, shown, next));
          shown = next;
          progress.textContent = `已显示 ${shown} / ${rows.length} 条`;
          more.hidden = shown === rows.length;
        };
        more.addEventListener('click', append);
        append();
        break;
      }
      case 'reopen-closed': await openDocuments(await api('reopenClosed')); break;
      case 'trash': { await flush(); const result = await api('trashDocument', activeId); if (result) { Object.assign(current(), result, { savedContent: '' }); updateChrome(); } break; }
      case 'help': showDialog('写作从这里开始', '<div class="help-text"><p>输入 Markdown。离开当前段落后，文字会显示排版；点击排版内容可以继续编辑。正在编辑的段落也保持排版外观，只有把光标移到 <code>#</code>、<code>**</code> 等语法字符旁边时，它们才会显现以便修改。</p><p><kbd>⌘ / Ctrl + S</kbd> 保存 · <kbd>⌘ / Ctrl + F</kbd> 查找与替换 · <kbd>⌘ / Ctrl + /</kbd> 源码模式。</p><p>单击表格单元格即可直接输入，<kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> 在单元格间跳转，<kbd>Enter</kbd> 新增一行；拖动表头右边缘可调整列宽并随文档保存。右键或 <kbd>Alt</kbd> + 单击表格可打开图形化编辑器，命令面板中也能搜索「表格图形化编辑」。</p><p>图片会复制到文档旁的 assets 文件夹。文件保存时会检查磁盘版本，避免覆盖其他程序的修改。</p><p>HTML、HTML（无样式）、PNG 与 PDF 可直接导出；PDF 可配置页眉页脚、页码、纸张和页边距预设。其他格式需要系统中安装 Pandoc。</p><p>已支持整篇上下文渲染（脚注、引用式链接、文内目录、YAML 属性、警示块）、点击排版内容定位到源码字符、跨块拖选、复制为 Markdown / HTML、命令面板、文章列表、自定义 CSS 主题、公式与标题编号、保存历史与外部修改提示。按 ⌘/Ctrl+P 打开命令面板，可搜索命令与文件；双击图片可放大查看；代码块右上角可一键复制。Windows 实机、真实中文输入法和发行签名仍需专项验收。</p></div>'); break;
      case 'system-open': await openDocuments(await api('drainPending')); break;
      case 'quit': {
        // Acknowledge first: the main process then stops its five second
        // fallback, so a native save prompt may wait for the user indefinitely.
        if (quitting) break;
        quitting = true;
        let finished = false;
        try {
          await api('quitAck');
          await saveSession(true);
          const active = activeId;
          const files = [];
          let activePath = null;
          for (const id of [...documents.keys()]) {
            const closed = await closeDocument(id, false, true);
            if (!closed) return;
            if (closed.path) {
              files.push(closed.path);
              if (id === active) activePath = closed.path;
            }
          }
          await api('saveSession', { folder: folder?.path || null, files, active: activePath });
          await api('finishQuit');
          finished = true;
        } finally {
          if (!finished) {
            quitting = false;
            await saveSession(true);
            await api('cancelQuit').catch(() => {});
          }
        }
        break;
      }
    }
  } catch (error) { notify(error.message, true); }
}

// Rendered Markdown is document content, not application chrome.
document.addEventListener('click', async event => {
  const target = event.target;
  const fromDocument = !!target?.closest?.('.md-widget, .prose');
  // The code block copy button is the only application control that lives
  // inside rendered Markdown. Document content cannot forge it: the reserved
  // attributes are stripped from the sanitized HTML (src/markdown.js) before
  // this button is inserted, so the check below is a second layer only.
  const copy = target?.closest?.('[data-copy-code]');
  if (copy) {
    if (!(copy instanceof HTMLButtonElement) || !copy.classList.contains('code-copy')) return;
    const code = copy.closest('pre')?.querySelector('code')?.textContent || '';
    try {
      await api('writeClipboard', { text: code });
      copy.textContent = '已复制';
      notify('代码已复制到剪贴板');
      setTimeout(() => { if (copy.isConnected) copy.textContent = '复制'; }, 1600);
    } catch (error) { notify(error.message, true); }
    return;
  }
  // A rendered document may only navigate its own source: [TOC] / footnote
  // links carry data-line, and Cmd/Ctrl+click opens a real link. Everything
  // else (data-command, data-menu-command, data-path, data-export, …) is
  // ignored there, so a document can never drive the application.
  if (fromDocument) {
    const line = target.closest('[data-line]');
    if (line) { event.preventDefault(); current()?.editor.jump(Number(line.dataset.line)); return; }
    const anchor = target.closest('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') || '';
    const parsed = splitLinkTarget(href);
    // A local document link or a `#anchor` follows the click, the way a link on
    // a page does; an external URL still needs the modifier so a stray click in
    // the text cannot launch a browser.
    if (parsed.kind === 'anchor' || parsed.kind === 'local') await navigateLink(href);
    else if (event.metaKey || event.ctrlKey) await navigateLink(href);
    return;
  }
  if (target.closest('[data-sidebar-dismiss]')) { dismissCompactSidebar(); return; }
  const command = target?.closest?.('[data-command]'); if (command) { await runCommand(command.dataset.command); return; }
  const tableOp = target?.closest?.('[data-table-op]');
  if (tableOp) { tableOperation(tableOp.dataset.tableOp, Number(tableOp.dataset.index)); return; }
  const quick = target?.closest?.('[data-quick-path], [data-quick-command], [data-quick-document]');
  if (quick) { $('#dialog').close(); await runQuickItem(quick); return; }
  const emoji = event.target.closest('[data-emoji]');
  if (emoji) { $('#dialog').close(); current()?.editor.insert(emoji.dataset.emoji); return; }
  const imageAction = event.target.closest('[data-image-action]');
  if (imageAction) {
    $('#context-menu').hidden = true;
    if (!imageContext) return;
    const { src, alt, id, renderedSrc, imageRoot } = imageContext;
    try {
      switch (imageAction.dataset.imageAction) {
        case 'copy-image': await api('copyImage', id, src, imageRoot); notify('图片已复制到剪贴板'); break;
        case 'copy-path': await api('copyImagePath', id, src, imageRoot); notify('图片路径已复制到剪贴板'); break;
        case 'copy-markdown': await api('writeClipboard', { text: `![${alt}](${src})` }); notify('Markdown 图片语法已复制'); break;
        case 'preview': showDialog('图片预览', `<img class="lightbox-image" src="${escapeHTML(renderedSrc)}" alt="${escapeHTML(alt)}">`); break;
      }
    } catch (error) { notify(error.message, true); }
    return;
  }
  // The preferences picker fills the field in place instead of closing the
  // dialog, so a chosen folder can still be confirmed with the form.
  const pickImageRoot = event.target.closest('[data-pick-image-root]');
  if (pickImageRoot) {
    try {
      const picked = await api('chooseImageRoot');
      const input = document.querySelector('#preferences [name="imageRoot"]');
      if (picked && input) input.value = picked.directory;
    } catch (error) { notify(error.message, true); }
    return;
  }
  const menu = event.target.closest('[data-menu-command]'); if (menu) { $('#dialog').close(); await runCommand(menu.dataset.menuCommand); return; }
  const externalAction = event.target.closest('[data-external-action]');
  if (externalAction) { await resolveExternalPrompt(externalAction.dataset.externalAction); return; }
  const dismiss = event.target.closest('[data-dismiss]'); if (dismiss) { $('#dialog').close(); return; }
  const historyItem = event.target.closest('[data-history]');
  if (historyItem) {
    try {
      selectedHistory = { dir: historyItem.dataset.historyDir, name: historyItem.dataset.history };
      const content = await api('readHistory', selectedHistory.dir, selectedHistory.name);
      const preview = $('#history-preview');
      preview.hidden = false;
      preview.textContent = content.slice(0, 4000);
      $('#restore-history').disabled = false;
      $('#compare-history').disabled = false;
      for (const el of document.querySelectorAll('[data-history]')) el.classList.toggle('selected', el === historyItem);
    } catch (error) { notify(error.message, true); }
    return;
  }
  const pdfPresetAction = target?.closest?.('[data-pdf-preset-action]');
  if (pdfPresetAction) {
    const action = pdfPresetAction.dataset.pdfPresetAction;
    if (action === 'save') await savePdfPreset();
    else if (action === 'delete') await deletePdfPreset();
    else if (action === 'reset') {
      const defaults = defaultPdfExport();
      $('#pdf-header').value = defaults.header;
      $('#pdf-footer').value = defaults.footer;
      $('#pdf-page-numbers').checked = defaults.pageNumbers;
      $('#pdf-page-size').value = defaults.pageSize;
      $('#pdf-landscape').checked = defaults.landscape;
      $('#pdf-margins').value = defaults.margins;
      $('#pdf-preset-name').value = '';
      refreshPdfPresetSelect('');
    }
    return;
  }
  const exported = target?.closest?.('[data-export]');
  if (exported) {
    if (busy) return; busy = true; exported.disabled = true; exported.setAttribute('aria-busy', 'true');
    try { await exportDocument(exported.dataset.export); $('#dialog').close(); } catch (error) { notify(error.message, true); } finally { busy = false; exported.disabled = false; exported.removeAttribute('aria-busy'); } return;
  }
  const writingNote = target?.closest?.('[data-writing-note-action]');
  if (writingNote) {
    try { await writingNoteAction(writingNote); } catch (error) { notify(error.message, true); }
    return;
  }
  const side = target?.closest?.('[data-side]'); if (side) { sideMode = side.dataset.side; drawSidebar(); return; }
  const close = target?.closest?.('[data-close]');
  if (close) {
    const list = close.closest('#open-documents, #document-tabs');
    try {
      const closed = await closeDocument(close.dataset.close);
      if (closed && document.activeElement === document.body) {
        if (event.detail === 0 || $('.main-pane').inert) list?.querySelector('[aria-selected="true"], [aria-current="true"]')?.focus();
        else current()?.editor.view.focus();
      }
    } catch (error) { notify(error.message, true); }
    return;
  }
  const tab = target?.closest?.('[data-document]');
  if (tab) {
    const stayInTablist = event.detail === 0 && tab.getAttribute('role') === 'tab';
    dismissCompactSidebar();
    activate(tab.dataset.document, !stayInTablist);
    if (stayInTablist) $('#document-tabs [aria-selected="true"]').focus();
    return;
  }
  const searchHit = target?.closest?.('[data-search-hit]'); if (searchHit) { dismissCompactSidebar(); await openSearchHit(searchHit); return; }
  const fileOp = target?.closest?.('[data-file-op]');
  if (fileOp) { await runFileOperation(fileOp.dataset.fileOp, null, true); return; }
  const file = target?.closest?.('[data-path]');
  if (file) {
    try {
      const openedId = await openDocuments(await api('openDocument', file.dataset.path));
      if (openedId && openedId === activeId) {
        dismissCompactSidebar();
        focusActiveEditor(openedId);
      }
    } catch (error) { notify(error.message, true); }
    return;
  }
  const line = target?.closest?.('[data-line]'); if (line) { event.preventDefault(); dismissCompactSidebar(); current()?.editor.jump(Number(line.dataset.line)); return; }
});
document.addEventListener('submit', async event => {
  // Document content cannot forge the preferences form and change app settings.
  if (event.target.id !== 'preferences' || event.target.closest('.prose')) return;
  event.preventDefault(); const data = new FormData(event.target);
  const patch = { theme: data.get('theme'), uiMode: data.get('uiMode'), fontSize: Number(data.get('fontSize')), lineWidth: Number(data.get('lineWidth')), imageRoot: String(data.get('imageRoot') ?? '').trim() };
  for (const key of ['autoSave', 'restoreSession', 'spellcheck', 'focus', 'typewriter', 'mathNumbering', 'headingNumbering', 'showFormatbar']) patch[key] = data.has(key);
  try { await setPreferences(patch); $('#dialog').close(); } catch (error) { notify(error.message, true); }
});
$('#file-filter').addEventListener('input', drawSidebar);
document.addEventListener('input', event => {
  if (event.target.id === 'folder-search-input') {
    searchState.query = event.target.value;
    scheduleSearch();
    return;
  }
  if (event.target.id === 'quick-filter') quickOpenResults(event.target.value);
  if (event.target.id === 'emoji-filter') {
    const needle = event.target.value.trim().toLowerCase();
    for (const item of document.querySelectorAll('[data-emoji]')) item.hidden = !!needle && !item.title.toLowerCase().includes(needle);
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'pdf-preset-select') {
    applyPdfPreset(event.target.value);
    return;
  }
  const option = event.target.closest?.('[data-search-option]');
  if (option) {
    searchState[option.dataset.searchOption] = option.checked;
    scheduleSearch(0);
    return;
  }
  const select = event.target.closest?.('[data-align]');
  if (!select || !pendingTable || !select.closest('#dialog')) return;
  collectTableCells();
  pendingTable.table = setAlignment(pendingTable.table, Number(select.dataset.align), select.value || null);
  renderTableDialog();
});
document.addEventListener('inkstone:table-edit', event => runCommand('edit-table', event.detail));
// A link inside a rendered block. The widget sends this instead of relying on
// the `click` event, because clicking it already turned the block into source
// lines. Web links keep needing Cmd/Ctrl so a stray click cannot open a browser.
document.addEventListener('inkstone:open-link', event => {
  const detail = event.detail || {};
  if (splitLinkTarget(detail.href).kind === 'external' && !detail.modifier) return;
  navigateLink(detail.href).catch(error => notify(error.message, true));
});
document.addEventListener('inkstone:table-width', event => {
  const doc = current();
  const detail = event.detail;
  if (!doc || !detail) return;
  // Same reason as edit-table: widths and the caret share the editor's LF
  // coordinates, never the CRLF ones of the serialized disk text.
  const text = doc.editor.text();
  const tables = parseTables(text);
  const index = tables.findIndex(table => table.start <= detail.absoluteStart && detail.absoluteStart < table.end);
  if (index < 0) return;
  doc.editor.applyChange(columnWidthEdit(text, index, detail.widths));
});
// Dragging a row grip or a column grip rewrites that table (and its stored
// widths) in one transaction, so a single undo puts the original back. The
// event may arrive long after the drag started, so it is applied only to the
// document and block it was measured in.
document.addEventListener('inkstone:table-move', event => {
  const doc = current();
  const detail = event.detail;
  if (!doc || !detail) return;
  // Another document became active while the pointer was down.
  if (!detail.documentId || detail.documentId !== doc.id) return;
  const text = doc.editor.text();
  const blockEnd = detail.blockFrom + String(detail.blockSource ?? '').length;
  // The block moved or changed since it was typeset (typing, reload, undo).
  if (text.slice(detail.blockFrom, blockEnd) !== detail.blockSource) return;
  // Table boundaries come from the renderer's own token map, not from the
  // row scan: a heading such as `# H | Q` under a table is a separate block.
  const ranges = tableSourceRanges(text);
  const inBlock = ranges.filter(range => range.start >= detail.blockFrom && range.end <= blockEnd);
  // A block can hold native HTML tables, which render as `<table>` but have no
  // Markdown source. When the widget's DOM table count differs from the block's
  // GFM table count the two index spaces cannot be matched safely, so a drag on
  // any table of that block is refused instead of editing its neighbour.
  if (inBlock.length !== detail.domTables) return;
  const block = inBlock[detail.tableIndex];
  if (!block) return;
  const index = ranges.indexOf(block);
  if (index < 0) return;
  const changes = tableMoveEdit(text, index, detail.kind, detail.from, detail.slot, block);
  if (!changes.length) return;
  doc.editor.applyReorder(changes);
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
function moveTabFocus(event) {
  const list = event.currentTarget;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
  if (index < 0 || next === undefined) return;
  event.preventDefault();
  if (tabs[next].dataset.side) {
    sideMode = tabs[next].dataset.side;
    drawSidebar();
  } else activate(tabs[next].dataset.document);
  list.querySelector('[aria-selected="true"]').focus();
}
$('.sidebar-tabs').addEventListener('keydown', moveTabFocus);
$('#document-tabs').addEventListener('keydown', moveTabFocus);
$('#writing-sidebar').addEventListener('keydown', event => {
  if (!compactSidebarOpen || $('#dialog').open || event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); dismissCompactSidebar(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll('button, input, summary, [tabindex]')]
    .filter(node => node.tabIndex >= 0 && !node.disabled && node.checkVisibility());
  const boundary = event.shiftKey ? controls[0] : controls.at(-1);
  if (document.activeElement === boundary) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
  }
});
$('#sidebar-resizer').addEventListener('keydown', event => {
  const delta = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
  if (!delta || !prefs) return;
  event.preventDefault();
  setPreferences({ sidebarWidth: Math.max(180, Math.min(480, prefs.sidebarWidth + delta)) }).catch(error => notify(error.message, true));
});
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
$('#dialog').addEventListener('click', event => {
  if (event.target !== event.currentTarget) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
});
// Any dialog closing is the moment a queued external-change prompt may appear.
$('#dialog').addEventListener('close', () => {
  const purpose = dialogPurpose;
  dialogPurpose = null;
  if (closingForAction) { closingForAction = false; showNextExternalPrompt(); return; }
  if (purpose === 'external' && externalPrompt) {
    // Dismissed without choosing: keep the local text (the next save overwrites).
    const [id] = externalPrompt.split(':');
    externalPrompt = null;
    api('acceptExternalChange', id).catch(() => {});
    notify('已保留本地内容。下一次保存会覆盖磁盘版本。');
  }
  showNextExternalPrompt();
});
// Right-clicking a rendered image exposes Typora-style copy actions.
const assetRootOf = url => {
  try { return new URL(url).searchParams.get('root'); } catch { return null; }
};
document.addEventListener('contextmenu', event => {
  const image = event.target.closest('.md-widget img');
  const menu = $('#context-menu');
  const tree = event.target.closest('[data-tree-path]');
  if (!image && tree && !tree.closest('.prose')) {
    // The file tree owns a native menu; naming and confirmations stay in the
    // renderer's dialogs because a native menu cannot take text input.
    event.preventDefault();
    menu.hidden = true;
    const target = tree.dataset.treePath;
    const isDirectory = tree.dataset.treeKind === 'folder';
    api('fileMenu', target, isDirectory)
      .then(result => { if (result) return runFileOperation(result.action, result.path, result.isDirectory); return null; })
      .catch(error => notify(error.message, true));
    return;
  }
  if (!image) { menu.hidden = true; return; }
  event.preventDefault();
  imageContext = {
    src: image.dataset.mdSrc || '', alt: image.alt || '', id: activeId,
    renderedSrc: image.getAttribute('src') || '',
    // The root that this exact image was rendered with. An edit to the front
    // matter reaches the picture before the 500 ms document flush.
    imageRoot: assetRootOf(image.getAttribute('src') || '')
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
  if (!item || item.closest('.prose')) return;
  draggedSection = Number(item.dataset.section);
  item.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(draggedSection));
});
document.addEventListener('dragend', () => { draggedSection = null; clearDragMarks(); });
document.addEventListener('dragover', event => {
  const item = event.target.closest('[data-section]');
  if (!item || item.closest('.prose') || draggedSection === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  for (const el of document.querySelectorAll('.outline-item.drop-target')) el.classList.remove('drop-target');
  item.classList.add('drop-target');
});
document.addEventListener('drop', event => {
  const item = event.target.closest('[data-section]');
  if (!item || item.closest('.prose') || draggedSection === null) return;
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
  const command = { s: event.shiftKey ? 'save-as' : 'save', o: event.shiftKey ? 'folder' : 'open', p: 'quick-open', n: 'new', '/': 'source', ',': 'settings' }[event.key.toLowerCase()];
  if (command) { event.preventDefault(); runCommand(command); }
});
bridge.onCommand(runCommand);
bridge.onExternalChange((id, kind) => { handleExternalChange(id, kind).catch(error => notify(error.message, true)); });
window.addEventListener('beforeunload', event => { if (!native && [...documents.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; } });
try {
  const initial = await api('bootstrap'); prefs = initial.preferences; applyPreferences();
  capabilities = await api('capabilities').catch(() => capabilities);
  appPlatform = initial.platform;
  if (initial.titleBar) titleBarInfo = { ...titleBarInfo, ...initial.titleBar };
  document.documentElement.style.setProperty('--titlebar-height', `${titleBarInfo.height}px`);
  document.documentElement.style.setProperty('--titlebar-controls-width', `${titleBarInfo.controlsWidth || 0}px`);
  document.body.classList.toggle('frameless', native && appPlatform === 'darwin');
  // Windows / Linux: the topbar is the title bar, and the menu button replaces
  // the hidden native menu bar.
  document.body.classList.toggle('titlebar-overlay', native && !!titleBarInfo.overlay);
  bridge.onFullScreen?.(active => document.body.classList.toggle('is-fullscreen', !!active));
  // The session restored by the main process: its folder, the saved documents
  // it reopened and the document that was active. A restored document means the
  // welcome page stays away, exactly like opening a file on the command line.
  if (initial.session?.path) {
    folder = { path: initial.session.path, name: initial.session.name, entries: initial.session.entries || [] };
  }
  for (const doc of initial.documents) await addDocument(doc);
  const sessionActive = initial.session?.activePath
    ? [...documents.values()].find(doc => doc.path === initial.session.activePath)
    : null;
  if (sessionActive) activate(sessionActive.id);
  if (!documents.size) { const doc = await api('newDocument', welcome, '欢迎使用.md'); welcomeId = doc.id; await addDocument(doc); }
  drawSidebar();
  recentFiles = await api('recentFiles').catch(() => []);
  // Another program creating / renaming / deleting a file refreshes the tree.
  bridge.onFolderChanged?.(info => {
    if (!info || !folder || info.path !== folder.path) return;
    folder = info;
    refreshSearch();
    if (sideMode === 'files') drawSidebar();
  });
  if (initial.recoveryCount) notify(`已恢复 ${initial.recoveryCount} 篇未保存文档，请检查并另存为。`);
  else if (folder) notify(`已恢复上次的文件夹“${folder.name}”。`);
} catch (error) { notify(`启动失败：${error.message}`, true); }
