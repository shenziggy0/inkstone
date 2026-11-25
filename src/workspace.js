import { icon } from './icons.js';
import { escapeHTML } from './markdown.js';
import brandLogo from '../docs/assets/logo-256.png';

const button = (command, label, glyph) => `<button type="button" class="icon-button" data-command="${command}" aria-label="${label}" title="${label}">${icon(glyph)}</button>`;
const sideTabs = [['outline', '大纲', 'outline'], ['files', '文件', 'folder'], ['articles', '文章', 'articles'], ['search', '搜索', 'search']];
const formatGroups = [
  [['heading-1', '一级标题', 'h1'], ['heading-2', '二级标题', 'h2']],
  [['bold', '粗体', 'bold'], ['italic', '斜体', 'italic'], ['strike', '删除线', 'strike'], ['inline-code', '行内代码', 'code']],
  [['link', '插入链接', 'link'], ['table', '插入表格', 'table'], ['code', '插入代码块', 'braces'], ['math', '插入公式', 'math'], ['diagram', '插入图表', 'diagram'], ['image', '插入图片', 'image']]
];

export function workspaceHTML(native, modKey) {
  return `<header class="topbar">
    <button class="app-menu-button" data-command="app-menu" aria-label="菜单" title="菜单">菜单</button>
    <div class="brand"><img class="brand-mark" src="${brandLogo}" width="34" height="34" alt="墨页" draggable="false"><span class="brand-name">Inkstone</span></div>
    <div class="library-actions">${button('sidebar', '切换侧边栏', 'panel')}</div>
    <div class="document-location"><span id="location">未命名.md</span></div>
    <div class="top-actions">
      <div class="glass-group milk-glass document-tools">
        ${button('new', '新建文档', 'compose')}${button('open', '打开文档', 'open')}
        <div class="editor-actions">${button('find', '查找与替换', 'search')}${button('source', '切换源码模式', 'code')}${button('save', '保存文档', 'save')}</div>
      </div>
      <button class="export-button" data-command="export" aria-label="导出" title="导出文档">${icon('arrow')}<span>导出</span></button>
      <div class="settings-action">${button('settings', '偏好设置', 'settings')}</div>
      <div class="overflow-action">${button('toolbar-menu', '更多操作', 'more')}</div>
    </div>
  </header>
  <div class="workspace">
    <div class="sidebar-scrim" data-sidebar-dismiss aria-hidden="true"></div>
    <aside class="sidebar" id="writing-sidebar" aria-label="文稿库">
      <div class="library-heading"><h2>文稿库</h2>${button('quick-open', '命令面板', 'command')}<button class="icon-button drawer-close" data-sidebar-dismiss aria-label="关闭文稿库">${icon('close')}</button></div>
      <div class="sidebar-tabs" role="tablist" aria-label="浏览文稿库">${sideTabs.map(([id, label, glyph]) => `<button role="tab" id="side-${id}" data-side="${id}" aria-selected="${id === 'outline'}" tabindex="${id === 'outline' ? 0 : -1}" aria-controls="side-content" aria-label="${label}" title="${label}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div>
      <section class="open-documents" aria-label="已打开文档"><div class="open-documents-heading">已打开文档</div><div id="open-documents" role="list" aria-label="已打开文档列表"></div></section>
      <div class="sidebar-context"><span id="side-title">文档结构</span>${button('folder', '打开文件夹', 'folder')}</div>
      <label class="filter-label" hidden><span class="sr-only">筛选文件</span><input id="file-filter" placeholder="筛选文件…" type="search"></label>
      <div id="side-content" role="tabpanel" aria-labelledby="side-outline"></div>
      <div class="sidebar-footer"><button data-command="help">${icon('help')}使用说明${icon('out')}</button><span>${native ? '本地工作空间' : '浏览器预览'}</span></div>
    </aside>
    <div class="sidebar-resizer" id="sidebar-resizer" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="writing-sidebar" aria-label="调整侧边栏宽度" aria-valuemin="180" aria-valuemax="480"></div>
    <main class="main-pane" aria-label="写作区">
      <div class="tabbar"><div id="document-tabs" role="tablist" aria-label="打开的文档"></div>${button('new', '新建文档', 'plus')}${button('document-menu', '文档操作', 'more')}</div>
      <div class="formatbar" role="toolbar" aria-label="排版工具"><div class="format-tools">${formatGroups.map(group => group.map(args => button(...args)).join('')).join('<span class="divider" aria-hidden="true"></span>')}</div><span id="mode-label">即时渲染</span></div>
      <div class="welcome-actions" id="welcome-actions" role="group" aria-label="开始写作" hidden>
        <button data-command="welcome-new">${icon('compose')}写第一篇<kbd aria-hidden="true">${modKey}N</kbd></button>
        <button data-command="welcome-open">${icon('open')}打开已有文档<kbd aria-hidden="true">${modKey}O</kbd></button>
      </div>
      <div id="editor-host"></div>
      <div id="notification" class="milk-glass" role="alert" hidden></div>
      <footer class="statusbar"><div class="document-status"><span id="save-status" role="status">就绪</span><span id="breadcrumb" class="status-breadcrumb"></span></div><div class="reading-controls"><span id="selection-status"></span><span id="position">行 1，列 1</span><span id="statistics"></span><span id="encoding"></span><div class="status-actions">${button('focus', '专注模式', 'focus')}${button('theme', '切换主题', 'theme')}</div><button class="restore-tools icon-button" data-command="expand-tools" aria-label="展开写作工具" title="展开写作工具">${icon('more')}</button></div></footer>
      <div id="selection-tools" class="selection-tools milk-glass" role="toolbar" aria-label="选区操作" hidden>
        <button type="button" data-command="bold" data-selection-format>粗体</button>
        <button type="button" data-command="selection-link" data-selection-format>链接</button>
        <button type="button" data-command="heading-1" data-selection-format>标题</button>
        ${native ? '<button type="button" data-command="writing-note-add">留个续写提示</button><button type="button" data-command="copy-selection-image">复制为图片</button>' : ''}
      </div>
    </main>
  </div>
  <div id="context-menu" class="context-menu milk-glass" role="menu" hidden></div>
  <dialog id="dialog" class="milk-glass" aria-labelledby="dialog-title"><div id="dialog-content"></div></dialog>
  <article class="print-document prose write-surface" id="print-document"></article>`;
}

export function installSheetDrag(dialog) {
  let drag = null;
  dialog.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !event.target.closest('.sheet-grabber')) return;
    drag = { id: event.pointerId, start: event.clientY, time: event.timeStamp };
    dialog.setPointerCapture(event.pointerId);
    dialog.classList.add('sheet-dragging');
  });
  dialog.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) dialog.style.setProperty('--sheet-drag', `${Math.max(0, event.clientY - drag.start)}px`);
  });
  function finish(event) {
    if (drag?.id !== event.pointerId) return;
    const distance = event.clientY - drag.start;
    const velocity = distance / Math.max(1, event.timeStamp - drag.time);
    drag = null;
    dialog.classList.remove('sheet-dragging');
    if (event.type === 'pointerup' && (distance > Math.min(100, dialog.offsetHeight / 4) || (distance > 32 && velocity > .55))) dialog.close();
    else dialog.style.removeProperty('--sheet-drag');
  }
  dialog.addEventListener('pointerup', finish);
  dialog.addEventListener('lostpointercapture', finish);
}

export function toolbarMenuHTML(sourceMode) {
  const commands = [['open', '打开文档', 'open'], ['find', '查找与替换', 'search'], ['source', sourceMode ? '返回排版视图' : '查看 Markdown 源码', 'code'], ['save', '保存文档', 'save'], ['quick-open', '命令面板', 'command'], ['document-menu', '文档操作', 'file'], ['settings', '偏好设置', 'settings']];
  return `<div class="menu-list action-list">${commands.map(([cmd, label, glyph]) => `<button data-menu-command="${cmd}">${icon(glyph)}<span>${label}</span>${icon('chevron')}</button>`).join('')}</div>`;
}

export function preferencesHTML(prefs, themes) {
  const switches = pairs => pairs.map(([key, label]) => `<label class="setting-row"><span>${label}</span><input type="checkbox" role="switch" name="${key}" ${prefs[key] ? 'checked' : ''}></label>`).join('');
  const group = (name, glyph, rows) => `<fieldset><legend>${icon(glyph)}${name}</legend><div class="setting-list">${rows}</div></fieldset>`;
  return `<form id="preferences"><div class="preferences-scroll">
    ${group('外观', 'appearance', `<label class="setting-row">主题<select name="theme">${themes.map(([value, label]) => `<option value="${escapeHTML(value)}" ${prefs.theme === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label>
      <label class="setting-row">布局<select name="uiMode"><option value="typora" ${prefs.uiMode !== 'workbench' ? 'selected' : ''}>简洁写作</option><option value="workbench" ${prefs.uiMode === 'workbench' ? 'selected' : ''}>完整工作台</option></select></label>
      <label class="setting-row">正文字号<span class="setting-number"><input name="fontSize" type="number" min="12" max="30" value="${prefs.fontSize}" required>px</span></label>
      <label class="setting-row">正文宽度<span class="setting-number"><input name="lineWidth" type="number" min="560" max="1100" step="20" value="${prefs.lineWidth}" required>px</span></label>`)}
    ${group('写作', 'type', switches([['focus', '专注模式'], ['typewriter', '打字机模式'], ['showFormatbar', '工作台排版工具栏'], ['spellcheck', '拼写检查'], ['headingNumbering', '标题自动编号'], ['mathNumbering', '公式自动编号']]))}
    ${group('文件', 'folder', switches([['autoSave', '自动保存已命名的文件'], ['restoreSession', '启动时恢复上次的工作区']]) + `<div class="setting-path"><label for="pref-image-root">默认图片根目录</label><div><input id="pref-image-root" name="imageRoot" value="${escapeHTML(prefs.imageRoot || '')}" placeholder="使用文档中的图片根目录"><button type="button" data-pick-image-root>选择文件夹…</button></div></div>`)}
  </div><div class="dialog-actions"><button type="button" data-menu-command="themes-folder">打开主题文件夹</button><button class="primary" type="submit">保存设置</button></div></form>`;
}
