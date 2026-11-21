import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-desktop-'));
const project = path.resolve(import.meta.dirname, '..');
// Hosts that embed Electron may export ELECTRON_RUN_AS_NODE; that makes the
// child reject Chromium's remote-debugging flags, so drop it for the app only.
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
// --no-sandbox / --disable-gpu keep the renderer alive in hosted CI shells,
// where the Chromium sandbox and GPU process are unavailable.
const app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content').waitFor();
  // ── Iteration 10: the default shell must look like Typora, not an IDE ──
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ui), 'typora', '默认应为 Typora 极简外观');
  assert.equal(await page.locator('.brand').isVisible(), false, '品牌栏不应占据标题栏');
  assert.equal(await page.locator('.tabbar').isVisible(), false, '默认不应有标签栏');
  assert.equal(await page.locator('.formatbar').isVisible(), false, '默认不应有排版工具栏');
  assert.equal(await page.locator('.sidebar').isVisible(), false, '侧栏默认隐藏，像 Typora 首次打开');
  assert.ok(await page.locator('#statistics').isVisible(), '右下角字数仍应可见');
  const shell = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      topbar: document.querySelector('.topbar').getBoundingClientRect().height,
      contentWidth: document.querySelector('.cm-content').getBoundingClientRect().width,
      fontSize: getComputedStyle(document.querySelector('.cm-editor')).fontSize,
      leading: getComputedStyle(document.querySelector('.cm-scroller')).lineHeight,
      paper: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor,
      editorSize: root.getPropertyValue('--editor-size').trim(),
      editorWidth: root.getPropertyValue('--editor-width').trim()
    };
  });
  assert.equal(shell.topbar, 38, '极简标题栏应为 38px');
  assert.equal(shell.fontSize, '16px', '正文默认字号应为 16px');
  assert.ok(Math.abs(parseFloat(shell.leading) - 25.6) < 0.6, `正文行高应为 1.6，实际 ${shell.leading}`);
  assert.equal(shell.paper, 'rgb(255, 255, 255)', '浅色主题应为纯白纸面');
  assert.equal(shell.editorSize, '16px');
  assert.equal(shell.editorWidth, '860px');
  assert.ok(shell.contentWidth <= 860 && shell.contentWidth >= 800, `正文列宽应约 860px，实际 ${shell.contentWidth}`);
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 3);
  assert.equal(await page.locator('.cm-live-line').count(), 0, '刚打开且未交互的文档应整篇渲染，不展开活跃块源码');
  await page.locator('.topbar [data-command="sidebar"]').click();
  assert.ok(await page.locator('.sidebar').isVisible(), '侧栏仍应能一键打开');
  await page.locator('.topbar [data-command="sidebar"]').click();
  assert.equal(await page.locator('.sidebar').isVisible(), false, '侧栏仍应能一键收起');
  console.log('STEP default Typora-like chrome (title bar, typography, paper, sidebar toggle)');
  // The welcome page is a pristine document, not an unsaved draft.
  const welcomeShell = await page.evaluate(() => ({
    location: document.querySelector('#location').textContent,
    title: document.title,
    listed: [...document.querySelectorAll('#open-documents .open-document-name span')].map(node => node.textContent)
  }));
  assert.equal(welcomeShell.location, '欢迎使用.md', '欢迎页在标题栏里不应带未保存标记');
  assert.ok(welcomeShell.title && !welcomeShell.title.startsWith('•'), `窗口标题不应标记未保存，实际 ${welcomeShell.title}`);
  assert.deepEqual(welcomeShell.listed, ['欢迎使用.md'], '欢迎页应出现在侧栏的已打开文档中');
  console.log('STEP welcome page starts unmodified as 欢迎使用.md');
  if (process.platform !== 'darwin') {
    // One 38px row: the application topbar is the title bar, the native menu bar
    // is hidden and the system window buttons sit in a theme-aware overlay.
    const shellInfo = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { bounds: win.getBounds(), content: win.getContentBounds(), autoHideMenuBar: win.isMenuBarAutoHide() };
    });
    assert.equal(shellInfo.content.y, shellInfo.bounds.y, `不应再有原生标题栏占位（内容区顶部等于窗口顶部），实际 ${JSON.stringify(shellInfo)}`);
    assert.ok(shellInfo.content.height >= shellInfo.bounds.height - 2, `内容区应占满窗口高度，实际 ${JSON.stringify(shellInfo)}`);
    assert.equal(shellInfo.autoHideMenuBar, true, 'Windows / Linux 上应隐藏原生菜单栏');
    const bar = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      const style = getComputedStyle(topbar);
      return {
        height: topbar.getBoundingClientRect().height,
        paddingRight: parseFloat(style.paddingRight),
        drag: style.webkitAppRegion,
        interactive: getComputedStyle(topbar.querySelector('.icon-button')).webkitAppRegion,
        menuDisplay: getComputedStyle(document.querySelector('.app-menu-button')).display,
        controls: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-controls-width'))
      };
    });
    assert.equal(bar.height, 38, '应用 topbar 就是标题栏，高度应为 38px');
    assert.equal(bar.drag, 'drag', '标题栏必须是窗口拖动区域');
    assert.equal(bar.interactive, 'no-drag', '标题栏按钮不得落在拖动区域');
    assert.notEqual(bar.menuDisplay, 'none', 'Windows / Linux 上应显示“菜单”按钮');
    assert.ok(bar.controls >= 120, `应为系统窗口按钮预留宽度，实际 ${bar.controls}`);
    assert.ok(bar.paddingRight >= bar.controls, `右侧按钮必须避开系统窗口按钮，实际 ${bar.paddingRight} / ${bar.controls}`);
    await app.evaluate(({ Menu }) => {
      globalThis.__menuPopups = 0;
      globalThis.__originalPopup = Menu.prototype.popup;
      Menu.prototype.popup = function () { globalThis.__menuPopups++; };
    });
    await page.locator('.app-menu-button').click();
    assert.equal(await app.evaluate(() => globalThis.__menuPopups), 1, '菜单按钮必须弹出完整原生菜单（Menu.popup）');
    await app.evaluate(({ Menu }) => { if (globalThis.__originalPopup) Menu.prototype.popup = globalThis.__originalPopup; });
    // The overlay colours follow the paper colour of the active theme.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      globalThis.__overlays = [];
      const original = win.setTitleBarOverlay.bind(win);
      globalThis.__originalOverlay = original;
      win.setTitleBarOverlay = options => { globalThis.__overlays.push(options); return original(options); };
    });
    await page.locator('[data-command="theme"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.waitForTimeout(200);
    const darkOverlay = await app.evaluate(() => globalThis.__overlays.at(-1) || null);
    assert.ok(darkOverlay, '切换主题后必须调用 setTitleBarOverlay');
    assert.equal(darkOverlay.height, 38, '标题栏覆盖层高度应保持 38px');
    assert.equal(darkOverlay.color, '#282c34', `深色主题下窗口按钮区应改为深色，实际 ${JSON.stringify(darkOverlay)}`);
    assert.ok(darkOverlay.symbolColor && darkOverlay.symbolColor !== '#3b3f46', '深色模式下窗口按钮符号必须换色才可见');
    await page.locator('[data-command="theme"]').click();
    await page.locator('[data-command="theme"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const lightOverlay = await app.evaluate(() => globalThis.__overlays.at(-1));
    assert.equal(lightOverlay.color, '#ffffff', '回到浅色主题后窗口按钮区颜色也要跟着回来');
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (globalThis.__originalOverlay) win.setTitleBarOverlay = globalThis.__originalOverlay;
    });
    // Full screen hides the overlay buttons, so the reserved space goes away.
    await page.evaluate(() => window.desktop.fullscreen());
    await page.waitForFunction(() => document.body.classList.contains('is-fullscreen'), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).paddingRight), '10px', '全屏下不应再为窗口按钮留出空间');
    await page.evaluate(() => window.desktop.fullscreen());
    await page.waitForFunction(() => !document.body.classList.contains('is-fullscreen'), null, { timeout: 10000 });
    assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.topbar')).paddingRight)) >= bar.controls, '退出全屏后必须重新让出窗口按钮的位置');
    console.log('STEP Windows title bar: one 38px row, native menu popup, theme-aware overlay');
  }
  // The dense workbench stays available for users who want tabs / toolbar.
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences [name="uiMode"]').selectOption('workbench');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.ui === 'workbench');
  assert.ok(await page.locator('.tabbar').isVisible(), '工作台应恢复标签栏');
  assert.ok(await page.locator('.formatbar').isVisible(), '工作台应恢复排版工具栏');
  assert.ok(await page.locator('.sidebar').isVisible(), '工作台应恢复侧栏');
  console.log('STEP switch back to the full workbench');
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const sample = '# Desktop verification\n\n中文与 **Markdown**。\n\n$$\nE=mc^2\n$$\n\n```mermaid\nflowchart LR\n A[Input] --> B[Output]\n```\n\n- [ ] pending\n';
  await page.keyboard.insertText(sample);
  await page.locator('.outline-item').filter({ hasText: 'Desktop verification' }).waitFor();
  await page.locator('[data-command="source"]').click();
  console.log('STEP edit + source');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await page.locator('.cm-placeholder').count(), 1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('Desktop verification'));
  console.log('STEP undo + redo');
  await page.locator('[data-command="source"]').click();
  // Clicking rendered text must place the caret on the clicked source
  // character, not at the start of the block (the old fallback behaviour).
  const headingPoint = index => page.evaluate(offset => {
    const heading = document.querySelector('.md-widget h1');
    const range = document.createRange();
    range.setStart(heading.firstChild, offset);
    range.setEnd(heading.firstChild, offset);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2 };
  }, index);
  const caretColumn = () => page.evaluate(() => Number(/列 (\d+)/.exec(document.querySelector('#position').textContent)[1]));
  await page.locator('.md-widget h1').scrollIntoViewIfNeeded();
  let point = await headingPoint(2);
  await page.mouse.click(point.x, point.y);
  const earlyColumn = await caretColumn();
  assert.ok(earlyColumn >= 3 && earlyColumn <= 7, `点击标题前段应落在第 3~7 列，实际 ${earlyColumn}`);
  await page.locator('.md-widget p').first().click();
  await page.locator('.md-widget h1').waitFor();
  point = await headingPoint(16);
  await page.mouse.click(point.x, point.y);
  const lateColumn = await caretColumn();
  assert.ok(lateColumn >= 16 && lateColumn <= 21 && lateColumn > earlyColumn + 8,
    `点击标题后段应落在第 16~21 列且明显靠后，实际 ${lateColumn}（前段 ${earlyColumn}）`);
  console.log('STEP character-level click positioning');
  const savePath = path.join(root, 'note.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, savePath);
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  assert.equal(await fs.readFile(savePath, 'utf8'), sample);
  console.log('STEP save');
  assert.ok(await page.locator('.katex').count() >= 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.mermaid svg text')].some(x => x.textContent.includes('Input')));
  console.log('STEP math + Mermaid');
  const checkbox = page.locator('.md-widget input[type="checkbox"]');
  await checkbox.click();
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  assert.match(await fs.readFile(savePath, 'utf8'), /- \[x\] pending/);
  // Only a dirty document asks the user; a clean one is reloaded silently.
  await page.locator('.md-widget').first().click();
  await page.keyboard.insertText('本地未保存改动');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  await fs.writeFile(savePath, 'changed externally');
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#notification').textContent.includes('其他程序'));
  assert.equal(await fs.readFile(savePath, 'utf8'), 'changed externally');
  // The disk watcher should also report the external edit without a save.
  await page.locator('#dialog').getByText('文件已在编辑器外修改').waitFor({ timeout: 10000 });
  await page.locator('[data-external-action="keep-local"]').click();
  console.log('STEP external change notification');
  const htmlPath = path.join(root, 'note.html');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, htmlPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="html"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.match(html, /Desktop verification/); assert.match(html, /data:font\/woff2;base64/);
  const pdfPath = path.join(root, 'note.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="pdf"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.equal((await fs.readFile(pdfPath)).subarray(0, 4).toString(), '%PDF');
  // Version history is a real dialog, not just an OS folder reveal.
  await page.locator('[data-command="document-menu"]').click();
  await page.locator('[data-menu-command="history"]').click();
  await page.locator('.history-item').first().waitFor();
  assert.ok(await page.locator('.history-item').count() >= 1);
  await page.locator('.history-item').first().click();
  assert.match(await page.locator('#history-preview').textContent(), /Desktop verification/);
  await page.locator('#compare-history').click();
  await page.locator('.diff-view').waitFor();
  assert.ok(await page.locator('.diff-line').count() >= 1, '版本对比应渲染逐行差异');
  await page.locator('[data-dismiss]').last().click();
  console.log('STEP version history dialog + line diff');
  await page.locator('[data-command="settings"]').click();
  assert.ok(await page.locator('#preferences select[name="theme"] option').count() >= 3);
  assert.equal(await page.locator('#preferences [name="mathNumbering"]').count(), 1);
  await page.locator('[name="typewriter"]').check();
  await page.locator('[name="mathNumbering"]').check();
  await page.locator('#preferences button[type="submit"]').click();
  assert.ok(await page.evaluate(() => document.body.classList.contains('math-numbering')));
  await page.locator('.cm-content').click();
  await page.keyboard.press('ArrowDown');
  await page.locator('[data-command="theme"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  // Cross-block features need one parse of the whole document, not per-block parsing.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const parity = '---\ntitle: 对照样例\n---\n\n[TOC]\n\n# 标题\n\n引用[^a] 与 [链接][ref]。\n\n[^a]: 脚注内容\n\n[ref]: https://example.com/ref\n\n> [!NOTE]\n> 警示内容\n\n行内公式 \\(x^2\\) 与 $y=1$。\n\n# 标题\n\n结尾段落。\n';
  await page.keyboard.insertText(parity);
  await page.locator('.md-widget .front-matter').waitFor();
  assert.match(await page.locator('.md-widget .front-matter').textContent(), /title/);
  const tocEntries = await page.locator('.md-widget .toc li').count();
  assert.ok(tocEntries >= 2, `[TOC] 应列出全文标题，实际 ${tocEntries}`);
  assert.deepEqual(await page.locator('.md-widget .toc a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['#标题', '#标题-1']);
  assert.equal(await page.locator('.md-widget .footnote-ref').count(), 1);
  assert.match(await page.locator('.md-widget .footnote-ref a').getAttribute('title'), /脚注内容/);
  assert.equal(await page.locator('.md-widget a[href="https://example.com/ref"]').count(), 1);
  assert.equal(await page.locator('.md-widget blockquote.alert-note').count(), 1);
  assert.deepEqual(await page.locator('.md-widget h1').evaluateAll(nodes => nodes.map(node => node.id)), ['标题', '标题-1']);
  assert.ok(await page.locator('.md-widget .katex').count() >= 2, '应同时支持 \\(…\\) 与 $…$ 公式');
  console.log('STEP cross-block rendering parity');
  // User CSS themes live in the app's userData/themes directory.
  await fs.mkdir(path.join(root, 'profile', 'themes'), { recursive: true });
  await fs.writeFile(path.join(root, 'profile', 'themes', 'parity.css'), ':root { --color-paper: rgb(1, 2, 3); }');
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('custom:parity.css');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => !!document.getElementById('custom-theme'));
  assert.match(await page.locator('#custom-theme').textContent(), /color-paper/);
  const themedHtmlPath = path.join(root, 'themed.html');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, themedHtmlPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="html"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.match(await fs.readFile(themedHtmlPath, 'utf8'), /color-paper/, '导出 HTML 应内联自定义主题 CSS');
  console.log('STEP custom CSS theme + themed HTML export');
  // Right-clicking a rendered table opens the grid editor and rewrites only
  // that table's source range, leaving surrounding paragraphs untouched.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('[data-command="source"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('前言不变\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n结尾不变\n');
  await page.locator('[data-command="source"]').click();
  const cell = page.locator('.md-widget table td').first();
  await cell.waitFor();
  await cell.click({ button: 'right' });
  await page.locator('.table-editor').waitFor();
  await page.locator('[data-cell="1-0"]').fill('99');
  await page.locator('[data-table-op="add-row"]').click();
  assert.equal(await page.locator('[data-cell="2-0"]').count(), 1);
  await page.locator('[data-align="1"]').selectOption('center');
  await page.locator('[data-table-op="apply"]').click();
  const tablePath = path.join(root, 'table.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, tablePath);
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  const tableSource = await fs.readFile(tablePath, 'utf8');
  assert.match(tableSource, /\| 99/);
  assert.match(tableSource, /:---:/);
  assert.match(tableSource, /^\| {2,}\| {2,}\|$/m, '新增的空行应保留在表格中');
  assert.match(tableSource, /前言不变[\s\S]*结尾不变/);
  console.log('STEP graphical table editing');
  // A single click edits the rendered cell in place instead of exposing the
  // whole Markdown table as source.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
  await page.locator('.md-widget table td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.md-widget table td.table-cell-editing .cm-content'));
  assert.equal(await page.locator('.md-widget table td.table-cell-editing .cm-content').count(), 1, '单击单元格应打开就地 Markdown 编辑器');
  assert.equal(await page.locator('.cm-live-line').count(), 0, '编辑表格单元格时不能把整块表格展开成源码');
  await page.keyboard.insertText('99');
  await page.keyboard.press('Enter');
  await page.locator('.md-widget table').waitFor();
  assert.match(await page.locator('.md-widget table').textContent(), /99/, '提交单元格后表格应保持渲染态');
  await page.locator('[data-command="source"]').click();
  assert.match(await page.locator('.cm-content').textContent(), /\| 99 \| 2 \|/, '就地输入必须写回真实表格源码');
  await page.locator('[data-command="source"]').click();
  console.log('STEP in-place table cell editing');
  // Enter inside a GFM table appends a row instead of splitting the table.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.locator('[data-command="source"]').click();
  assert.match(await page.locator('.cm-content').textContent(), /\| {2}\| {2}\|/, '回车应在表格中新增一行');
  await page.locator('[data-command="source"]').click();
  console.log('STEP Enter appends a table row');
  // Dragging a column edge writes one invisible comment and re-renders with
  // a colgroup, so the width survives reload and export. Pixel dragging needs
  // a still viewport: typewriter centring and a stale zoom move the widget
  // between measuring its header and pressing the mouse.
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="typewriter"]').uncheck();
  await page.locator('#preferences button[type="submit"]').click();
  await page.evaluate(() => window.desktop.zoom(0));
  await page.waitForTimeout(300);
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
  await page.locator('.md-widget .table-column-resizer').first().waitFor();
  await page.waitForTimeout(250);
  const headerBox = await page.locator('.md-widget table th').first().boundingBox();
  const startX = headerBox.x + headerBox.width - 5, startY = headerBox.y + headerBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 60, startY, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.md-widget table colgroup col').length >= 2);
  await page.locator('[data-command="source"]').click();
  assert.match(await page.locator('.cm-content').textContent(), /inkstone:columns/, '列宽应持久化到文档');
  await page.locator('[data-command="source"]').click();
  console.log('STEP draggable table column widths');
  // Copy as HTML / Markdown goes through the native clipboard bridge.
  // Electron 45 uses the W3C-style clipboard API in the main process.
  const pollClipboard = async (kind, expected) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const value = await app.evaluate(async ({ clipboard }, which) => {
        if (which === 'html') {
          for (const item of await clipboard.read()) {
            if (item.types.includes('text/html')) return (await item.getType('text/html')).text();
          }
          return '';
        }
        return clipboard.readText();
      }, kind);
      if (expected.test(value)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`剪贴板未出现预期内容：${expected}`);
  };
  await app.evaluate(async ({ clipboard, BrowserWindow }) => { await clipboard.clear(); BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'copy-html'); });
  await pollClipboard('html', /<table/);
  await app.evaluate(async ({ clipboard, BrowserWindow }) => { await clipboard.clear(); BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'copy-markdown'); });
  await pollClipboard('text', /甲|inkstone:columns|前言不变/);
  console.log('STEP copy as HTML / Markdown');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'quick-open'));
  await page.locator('#quick-filter').waitFor();
  await page.locator('#quick-filter').fill('table.md');
  assert.ok(await page.locator('.quick-item').count() >= 1);
  await page.locator('[data-dismiss]').click();
  console.log('STEP quick open');
  // Dragging a data-row grip or a column grip reorders the rendered table in
  // one transaction: header and delimiter stay put, a moved column carries its
  // alignment, cells and stored width, and one undo restores the original.
  // Pixel dragging needs the still viewport set up by the width-drag step.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText([
    '前言段落', '',
    '| 名称 | 数量 |',
    '| :--- | ---: |',
    '| 苹果 \\| 红 | 3 |',
    '| 梨 | 5 |', '',
    '第二张表：', '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |', '',
    '<!-- inkstone:columns 30.0,70.0;60.0,40.0 -->',
    '结尾段落', ''
  ].join('\n'));
  await page.locator('.md-widget .table-row-handle').first().waitFor();
  await page.waitForTimeout(300);
  const readReorderSource = async () => {
    if (await page.locator('[data-command="source"]').getAttribute('aria-pressed') !== 'true') await page.locator('[data-command="source"]').click();
    await page.waitForTimeout(120);
    const text = await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n'));
    await page.locator('[data-command="source"]').click();
    await page.waitForTimeout(120);
    return text;
  };
  const tableWidths = () => page.evaluate(() => [...document.querySelectorAll('.md-widget table col')].map(col => col.style.width));
  const dragGrip = async (grip, dx, dy) => {
    const box = await grip.boundingBox();
    assert.ok(box, '行列拖动入口必须可见');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(350);
  };
  const reorderOriginal = await readReorderSource();
  assert.deepEqual((await tableWidths()).slice(0, 2), ['30%', '70%']);
  await dragGrip(page.locator('.md-widget tbody tr').first().locator('.table-row-handle'), 0, 46);
  let reorderSource = await readReorderSource();
  assert.ok(reorderSource.indexOf('梨') < reorderSource.indexOf('苹果 \\| 红'), `数据行应下移，实际\n${reorderSource}`);
  assert.ok(reorderSource.includes('| 名称'), '表头不得被拖走');
  assert.match(reorderSource, /\| :--- +\| ---: +\|/, '分隔行与对齐必须保持');
  assert.ok(reorderSource.includes('<!-- inkstone:columns 30.0,70.0;60.0,40.0 -->'), '行移动不得改动宽度注释');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(400);
  assert.equal(await readReorderSource(), reorderOriginal, '单次撤销应恢复原文');
  const headers = await page.locator('.md-widget table').first().locator('th').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, width: box.width };
  }));
  const lastColumn = headers[headers.length - 1];
  await dragGrip(page.locator('.md-widget table').first().locator('th').first().locator('.table-column-handle'),
    lastColumn.left + lastColumn.width * 0.8 - (headers[0].left + headers[0].width / 2), 0);
  reorderSource = await readReorderSource();
  const reorderHeader = reorderSource.split('\n').find(line => line.startsWith('| 名称') || line.startsWith('| 数量'));
  assert.ok(reorderHeader?.startsWith('| 数量'), `表头应换位，实际 ${reorderHeader}\n${reorderSource}`);
  assert.match(reorderSource, /\| ---: +\| :---/, '列对齐必须跟随列移动');
  assert.match(reorderSource, /\| +3 +\| +苹果 \\\| 红/, '单元格内容必须跟随列移动');
  assert.ok(reorderSource.includes('<!-- inkstone:columns 70.0,30.0;60.0,40.0 -->'), `被移动列的宽度必须换位，第二张表不变，实际\n${reorderSource}`);
  assert.deepEqual((await tableWidths()).slice(0, 2), ['70%', '30%'], '渲染列宽应跟随列移动');
  assert.ok(reorderSource.includes('| A | B |') && reorderSource.includes('| 1 | 2 |'), '第二张表不得被改写');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(400);
  assert.equal(await readReorderSource(), reorderOriginal, '单次撤销应恢复列顺序与列宽');
  // Escape and a same-place drop must not create a document change at all.
  const cancelGrip = page.locator('.md-widget tbody tr').nth(1).locator('.table-row-handle');
  const cancelBox = await cancelGrip.boundingBox();
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2 + 30, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await readReorderSource(), reorderOriginal, 'Escape 取消不得写入文档');
  await dragGrip(cancelGrip, 0, 8);
  assert.equal(await readReorderSource(), reorderOriginal, '同位放下不得写入文档');
  // A window blur (app switched away, a native menu) abandons the drag.
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2 + 30, { steps: 6 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await readReorderSource(), reorderOriginal, '窗口失焦必须取消拖动');
  // Typing next to the table and the reorder itself stay separate undo steps.
  // Focus the content element directly: the previous step's last interaction was
  // a toolbar click, and a click on the page could open a table cell instead.
  await page.locator('.cm-content').evaluate(node => node.focus());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('追加');
  await page.waitForTimeout(250);
  const typedTail = await readReorderSource();
  assert.ok(/结尾段落\s*追加\s*$/.test(typedTail), `输入应写入文档末尾：${typedTail}`);
  await dragGrip(page.locator('.md-widget tbody tr').first().locator('.table-row-handle'), 0, 46);
  const typedThenReordered = await readReorderSource();
  assert.notEqual(typedThenReordered, typedTail, '拖动应改变顺序');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(350);
  assert.equal(await readReorderSource(), typedTail, '一次撤销只退回重排，保留刚才的输入');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(350);
  assert.equal(await readReorderSource(), reorderOriginal, '再撤销一次才移除输入');
  // Two consecutive reorders are separate undo steps, not one grouped edit.
  await dragGrip(page.locator('.md-widget tbody tr').first().locator('.table-row-handle'), 0, 46);
  const afterFirstReorder = await readReorderSource();
  await dragGrip(page.locator('.md-widget tbody tr').first().locator('.table-row-handle'), 0, 46);
  const afterSecondReorder = await readReorderSource();
  assert.notEqual(afterSecondReorder, afterFirstReorder, '第二次拖动应再次改顺序');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(350);
  assert.equal(await readReorderSource(), afterFirstReorder, '第一次撤销只应退回第二次重排');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(350);
  assert.equal(await readReorderSource(), reorderOriginal, '第二次撤销恢复原文');
  console.log('STEP table row / column drag reorder, atomic widths and single-step undo');
  // ── Table reorder source boundaries ────────────────────────────────────
  // Three reproducible edges. A document BOM must stay at the head (copying the
  // first line's prefix onto every row used to write one BOM per line and the
  // table stopped rendering), identical columns must still swap their stored
  // widths, and a heading such as `# H | Q` under a table is a separate block.
  const saveCurrent = async () => {
    await page.locator('[data-command="save"]').click();
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  };
  const openBoundary = async (file, content) => {
    await fs.writeFile(file, content);
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, file);
    await page.locator('[data-command="open"]').click();
    await page.waitForFunction(name => document.querySelector('#location').textContent.includes(name), path.basename(file));
    await page.locator('.md-widget table').first().waitFor();
    await page.waitForTimeout(280);
  };
  const closeCurrent = async name => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'close'));
    await page.waitForFunction(target => !document.querySelector('#location').textContent.includes(target), name);
  };
  // The last interaction was a toolbar click, so undo has to go back to the
  // editor first: Meta+Z on a focused button is not the editor's history.
  const undoBoundary = async () => {
    await page.locator('.cm-content').evaluate(node => node.focus());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(400);
  };
  const bomFile = path.join(root, 'boundary-bom.md');
  const bomSecond = ['| W | K |', '| --- | --- |', '| 1 | 2 |'];
  const bomOriginal = '\uFEFF' + ['| H | I |', '| --- | --- |', '| a | b |', '| c | d |', '', ...bomSecond, ''].join('\r\n');
  await openBoundary(bomFile, bomOriginal);
  // The table is the first block, so the caret sits inside it: the drop must keep
  // the table typeset instead of revealing the caret's source block.
  await dragGrip(page.locator('.md-widget tbody tr').first().locator('.table-row-handle'), 0, 46);
  assert.equal(await page.locator('.cm-live-line').count(), 0, '从首块拖放后仍应保持整篇排版');
  assert.match(await page.locator('.md-widget table').first().textContent(), /c[\s\S]*a/, '标题行下的数据行已下移');
  await saveCurrent();
  const bomSaved = await fs.readFile(bomFile, 'utf8');
  assert.equal((bomSaved.match(/\uFEFF/g) || []).length, 1, 'BOM 只能出现在文档头一次');
  assert.doesNotMatch(bomSaved.replace(/\r\n/g, ''), /\n/, '重排后必须仍是 CRLF');
  assert.ok(bomSaved.includes(bomSecond.join('\r\n')), '第二张表不得被改写');
  assert.equal(await page.locator('.md-widget table').count(), 2, 'BOM + CRLF 表格必须仍渲染');
  await undoBoundary();
  await saveCurrent();
  assert.equal(await fs.readFile(bomFile, 'utf8'), bomOriginal, '单次撤销应恢复带 BOM 的原文');
  await closeCurrent('boundary-bom.md');
  const sameFile = path.join(root, 'boundary-same.md');
  const sameOriginal = ['| A | A |', '| --- | --- |', '| B | B |', '', '<!-- inkstone:columns 15,85 -->', ''].join('\n');
  await openBoundary(sameFile, sameOriginal);
  assert.deepEqual((await tableWidths()).slice(0, 2), ['15%', '85%']);
  const sameHeaders = await page.locator('.md-widget table').first().locator('th').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, width: box.width };
  }));
  await dragGrip(page.locator('.md-widget table').first().locator('th').first().locator('.table-column-handle'),
    sameHeaders[1].left + sameHeaders[1].width * 0.8 - (sameHeaders[0].left + sameHeaders[0].width / 2), 0);
  assert.deepEqual((await tableWidths()).slice(0, 2), ['85%', '15%'], '内容相同的两列也必须换宽度');
  await saveCurrent();
  assert.match(await fs.readFile(sameFile, 'utf8'), /<!-- inkstone:columns 85(?:\.0)?,15(?:\.0)? -->/, '宽度必须随列写回');
  await undoBoundary();
  await saveCurrent();
  assert.equal(await fs.readFile(sameFile, 'utf8'), sameOriginal, '撤销应恢复原列宽');
  await closeCurrent('boundary-same.md');
  const adjacentFile = path.join(root, 'boundary-adjacent.md');
  const adjacentOriginal = ['| A | B |', '| --- | --- |', '| x | y |', '# H | Q', '', '| W | K |', '| --- | --- |', '| 1 | 2 |', ''].join('\n');
  await openBoundary(adjacentFile, adjacentOriginal);
  assert.equal(await page.locator('.md-widget h1').textContent(), 'H | Q', '紧邻标题应单独渲染');
  assert.equal(await page.locator('.md-widget table').first().locator('tbody tr').count(), 1, '标题不得被并入表格');
  const adjacentHeaders = await page.locator('.md-widget table').first().locator('th').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, width: box.width };
  }));
  await dragGrip(page.locator('.md-widget table').first().locator('th').first().locator('.table-column-handle'),
    adjacentHeaders[1].left + adjacentHeaders[1].width * 0.8 - (adjacentHeaders[0].left + adjacentHeaders[0].width / 2), 0);
  const adjacentSaved = await (async () => { await saveCurrent(); return fs.readFile(adjacentFile, 'utf8'); })();
  assert.ok(adjacentSaved.includes('# H | Q\n'), '重排不得改写紧邻标题');
  assert.equal(await page.locator('.md-widget h1').textContent(), 'H | Q');
  assert.ok(adjacentSaved.includes('| W | K |'), '后面的表格不得被改写');
  await undoBoundary();
  await saveCurrent();
  assert.equal(await fs.readFile(adjacentFile, 'utf8'), adjacentOriginal, '撤销应恢复原文');
  await closeCurrent('boundary-adjacent.md');
  console.log('STEP table reorder boundaries: BOM / CRLF, identical columns, adjacent heading');
  await page.evaluate(() => window.desktop.zoom(1));
  const settings = await page.evaluate(() => window.desktop.settings());
  assert.equal(settings.value.zoomLevel, 1);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()), 1);
  console.log('STEP persisted zoom level');
  // ── Live-preview editing parity ────────────────────────────────────────
  // Reset the zoom used by the previous step: CDP mouse coordinates and page
  // CSS coordinates only agree at zoom level 0.
  // Typewriter centring and zoom both move the viewport under the pointer;
  // this step needs stable geometry to exercise literal pixel dragging.
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="typewriter"]').uncheck();
  await page.locator('#preferences button[type="submit"]').click();
  await page.evaluate(() => window.desktop.zoom(0));
  await page.waitForTimeout(350);
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('第一段 **加粗** 文字。\n\n第二段普通文字内容。\n\n第三段结尾内容。\n');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 2, { timeout: 8000 });
  // Entering a rendered block now reveals TYPESET text: syntax characters are
  // removed from the layout, content keeps real typography, and syntax comes
  // back as dim editable text as soon as the caret approaches it.
  await page.locator('.md-widget').first().click();
  assert.ok(await page.locator('.cm-live-line').count() >= 1, '活跃块应以正文字体显示');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelectorAll('.cm-hidden-mark').length >= 2);
  const strong = page.locator('.cm-lv-strong');
  assert.ok(await strong.count() >= 1, '加粗内容应获得真实排版样式');
  assert.equal(await strong.first().textContent(), '加粗');
  assert.ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('.cm-lv-strong')).fontWeight) >= 600), '排版态粗体必须有真实字重');
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('**加粗**'), '语法字符不应出现在可见文本中');
  // Move onto the opening `**`: exactly that syntax must reappear for editing.
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelectorAll('.cm-md-mark').length >= 1);
  assert.ok(await page.locator('.cm-md-mark').count() >= 1, '光标靠近时语法应显现为可编辑的淡化文字');
  await page.keyboard.press('End');
  console.log('STEP typeset live preview + syntax reveal on caret approach');
  await page.waitForTimeout(300);
  // ── Cross-block selection (RFC 0001 batch 2A) ──────────────────────────
  // The selection is a Markdown source range in EditorSelection. Only the two
  // blocks that own an endpoint reveal their source; every block in between
  // keeps its typeset layout and is only tinted. Copy, delete and undo all
  // consume that same source range, so Markdown markers and block separators
  // are reproduced exactly instead of being reconstructed from the DOM.
  const crossBlockSample = '# 标题甲\n\n- 列表一\n- 列表二\n\n```js\nconst x = 1;\n```\n\n段落 **加粗** 结尾。\n';
  const crossBlockLines = crossBlockSample.split('\n');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const caretPosition = async () => {
    const text = await page.locator('#position').textContent();
    const match = /行 (\d+)，列 (\d+)/.exec(text || '');
    assert.ok(match, `状态栏缺少光标位置：${text}`);
    return { line: Number(match[1]), column: Number(match[2]) };
  };
  const sourceOffset = ({ line, column }) =>
    crossBlockLines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0) + column - 1;
  // A `.cm-line` is one document line; joining them back restores the LF source.
  const crossBlockSource = () => page.evaluate(() =>
    [...document.querySelectorAll('.cm-content .cm-line')].map(node => node.textContent).join('\n'));
  const crossBlockHighlight = () => page.evaluate(() => [...document.querySelectorAll('.md-widget.cm-block-selected')].map(node => ({
    list: !!node.querySelector('ul'),
    code: !!node.querySelector('pre'),
    paragraph: !!node.querySelector('p'),
    text: node.textContent,
    tint: getComputedStyle(node, '::after').backgroundColor
  })));
  const copyMarkdown = async () => {
    await app.evaluate(async ({ clipboard, BrowserWindow }) => {
      await clipboard.clear();
      BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'copy-markdown');
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await app.evaluate(({ clipboard }) => clipboard.readText());
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return '';
  };
  const newCrossDoc = async () => {
    if (await page.locator('[data-command="source"]').getAttribute('aria-pressed') === 'true') {
      await page.locator('[data-command="source"]').click();
    }
    await page.locator('.topbar [data-command="new"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(crossBlockSample);
    await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 4, null, { timeout: 8000 });
    await page.waitForTimeout(200);
  };
  // Rects of the first heading glyph, the bold glyph and the paragraph's last
  // glyph as currently typeset. Used only while every block is rendered.
  const crossBlockGeometry = () => page.evaluate(() => {
    const textNodes = root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) if (node.nodeValue.trim()) nodes.push(node);
      return nodes;
    };
    const charRect = (node, from, to) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    };
    const heading = document.querySelector('.md-widget h1');
    const paragraph = [...document.querySelectorAll('.md-widget p')].at(-1);
    const paragraphText = textNodes(paragraph).at(-1);
    const strong = document.querySelector('.md-widget strong')?.firstChild;
    return {
      heading: charRect(textNodes(heading)[0], 0, 1),
      strong: strong ? charRect(strong, 0, 1) : null,
      paragraphLast: charRect(paragraphText, paragraphText.nodeValue.length - 1, paragraphText.nodeValue.length)
    };
  });

  await newCrossDoc();
  assert.equal(await page.locator('.cm-live-line').count(), 0, '三个以上渲染块未交互时应全部排版');
  const headingGeometry = await crossBlockGeometry();
  await page.mouse.click(headingGeometry.heading.x + 1, headingGeometry.heading.y + headingGeometry.heading.height / 2);
  await page.waitForTimeout(200);
  assert.deepEqual(await caretPosition(), { line: 1, column: 3 }, '点击标题文字应定位到 # 之后的源码字符');
  assert.ok(await page.locator('.cm-live-line').count() >= 1, '点击后端点块应以源码显示光标');
  // A paragraph containing Markdown markers maps rendered glyphs to their own
  // source characters: the first glyph of 加粗 is after the opening `**`.
  await newCrossDoc();
  const boldGeometry = await crossBlockGeometry();
  assert.ok(boldGeometry.strong, '样例应包含渲染后的粗体文字');
  await page.mouse.click(boldGeometry.strong.x + 1, boldGeometry.strong.y + boldGeometry.strong.height / 2);
  await page.waitForTimeout(200);
  assert.deepEqual(await caretPosition(), { line: 10, column: 6 }, '点击渲染后的粗体应映射到源码中的粗体文字');
  assert.ok((await page.locator('.cm-live-line').last().textContent()).includes('**加粗**'), '光标进入元素后源码标记必须可见');
  console.log('STEP cross-block caret mapping through heading and inline markers');

  // Forward drag: heading start → paragraph. The captured anchor is the same
  // offset verified by the click above; the head is read back from the status
  // bar, so the assertion covers the exact source range the editor reports.
  await newCrossDoc();
  const forward = await crossBlockGeometry();
  const forwardStart = { x: forward.heading.x + 1, y: forward.heading.y + forward.heading.height / 2 };
  const forwardEnd = { x: forward.paragraphLast.x + forward.paragraphLast.width - 1, y: forward.paragraphLast.y + forward.paragraphLast.height / 2 };
  await page.mouse.move(forwardStart.x, forwardStart.y);
  await page.mouse.down();
  await page.mouse.move(forwardEnd.x, forwardEnd.y, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const forwardHead = await caretPosition();
  const forwardHeadOffset = sourceOffset(forwardHead);
  assert.ok(forwardHeadOffset > crossBlockSample.indexOf('```js'), `正向拖选应越过列表和代码块，实际停在 ${JSON.stringify(forwardHead)}`);
  const forwardExpected = crossBlockSample.slice(2, forwardHeadOffset);
  assert.match(await page.locator('#selection-status').textContent(), new RegExp(`已选 ${[...forwardExpected].length} 字`), '选区状态必须统计同一源码区间');
  const forwardMiddle = await crossBlockHighlight();
  assert.ok(forwardMiddle.some(block => block.list), '选区中间的列表必须保持渲染并高亮');
  assert.ok(forwardMiddle.every(block => block.tint !== 'rgba(0, 0, 0, 0)' && block.tint !== 'transparent'), '渲染块高亮必须可见');
  assert.ok(forwardMiddle.map(block => block.text).join('').includes('列表一'), '中间块内容仍应可见');
  assert.ok(!forwardMiddle.map(block => block.text).join('').includes('- 列表'), '中间块不得展开 Markdown 源码');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.md-widget.cm-block-selected'), '::after').pointerEvents), 'none', '高亮层不得拦截点击');
  assert.ok((await page.locator('.cm-live-line').count()) >= 1, '端点块仍应以源码显示选区端点');
  assert.ok(await page.locator('.cm-selectionBackground').count() >= 1, '跨块选区必须产生可见选区');
  assert.equal(await copyMarkdown(), forwardExpected, '复制必须给出精确的 Markdown 源码区间');
  await app.evaluate(async ({ clipboard }) => { await clipboard.clear(); });
  await page.keyboard.press(`${mod}+c`);
  await page.waitForTimeout(250);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), forwardExpected, '原生复制必须使用同一源码区间');
  await page.screenshot({ path: path.join(root, 'cross-block-forward.png') });
  // Delete removes only the selected source; a single undo restores it.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await page.locator('[data-command="source"]').click();
  await page.waitForTimeout(200);
  assert.equal(await crossBlockSource(), crossBlockSample.slice(0, 2) + crossBlockSample.slice(forwardHeadOffset), '删除必须只移除选区源码');
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(300);
  assert.equal(await crossBlockSource(), crossBlockSample, '单次撤销必须恢复整个选区源码');
  await page.locator('[data-command="source"]').click();
  console.log('STEP cross-block drag selection: rendered middle blocks, exact copy / delete / undo');

  // Reverse drag: paragraph end → heading start. The paragraph end was
  // verified on a pristine copy; the heading is the topmost block, so its
  // coordinates cannot move while lower blocks expand.
  await newCrossDoc();
  const reverseGeometry = await crossBlockGeometry();
  const reverseStart = { x: reverseGeometry.paragraphLast.x + reverseGeometry.paragraphLast.width - 1, y: reverseGeometry.paragraphLast.y + reverseGeometry.paragraphLast.height / 2 };
  await page.mouse.click(reverseStart.x, reverseStart.y);
  await page.waitForTimeout(200);
  const anchorPosition = await caretPosition();
  assert.equal(anchorPosition.line, 10, '点击段落末尾应落在段落的源码行');
  assert.equal(crossBlockSample.slice(sourceOffset(anchorPosition)), '\n', '点击段落末尾应定位到最后一个源码字符之后');
  await newCrossDoc();
  await page.mouse.move(reverseStart.x, reverseStart.y);
  await page.mouse.down();
  await page.mouse.move(reverseGeometry.heading.x + 1, reverseGeometry.heading.y + reverseGeometry.heading.height / 2, { steps: 24 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.deepEqual(await caretPosition(), { line: 1, column: 3 }, '反向拖选应停在标题源码起点');
  assert.equal(await copyMarkdown(), crossBlockSample.slice(2, sourceOffset(anchorPosition)), '反向拖选复制同一源码区间');
  const reverseMiddle = await crossBlockHighlight();
  assert.ok(reverseMiddle.some(block => block.list) && reverseMiddle.some(block => block.code), '反向选区中间的列表和代码块必须保持渲染');
  assert.equal(await page.locator('.cm-live-line').count(), 2, '反向选区只应展开两个端点块');
  assert.equal(await page.locator('.md-widget').count(), 2, '反向选区中间块不得展开为源码');
  console.log('STEP reverse cross-block drag selection');

  // Keyboard extension uses the same source selection and the same split
  // between endpoint blocks and rendered middle blocks.
  await newCrossDoc();
  const keyboardGeometry = await crossBlockGeometry();
  await page.mouse.click(keyboardGeometry.heading.x + 1, keyboardGeometry.heading.y + keyboardGeometry.heading.height / 2);
  await page.waitForTimeout(200);
  for (let step = 0; step < 16; step++) await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(300);
  const keyboardHead = await caretPosition();
  assert.equal(keyboardHead.line, crossBlockLines.length, `Shift+Down 应扩选到文档末尾，实际 ${JSON.stringify(keyboardHead)}`);
  assert.equal(await copyMarkdown(), crossBlockSample.slice(2), 'Shift 扩选复制必须覆盖完整源码区间');
  const keyboardMiddle = await crossBlockHighlight();
  assert.equal(keyboardMiddle.length, 3, '标题之外的三个渲染块都应保持排版并高亮');
  assert.ok(keyboardMiddle.every(block => block.tint !== 'rgba(0, 0, 0, 0)'), '键盘扩选的渲染块高亮必须可见');
  assert.equal(await page.locator('.cm-live-line').count(), 1, '键盘扩选只应展开锚点块');
  await page.screenshot({ path: path.join(root, 'cross-block-keyboard.png') });
  // Reverse keyboard: paragraph end → document start.
  await newCrossDoc();
  const reverseKeyboardGeometry = await crossBlockGeometry();
  await page.mouse.click(reverseKeyboardGeometry.paragraphLast.x + reverseKeyboardGeometry.paragraphLast.width - 1, reverseKeyboardGeometry.paragraphLast.y + reverseKeyboardGeometry.paragraphLast.height / 2);
  await page.waitForTimeout(200);
  for (let step = 0; step < 16; step++) await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(300);
  assert.deepEqual(await caretPosition(), { line: 1, column: 1 }, 'Shift+Up 应扩选到文档开头');
  assert.equal(await copyMarkdown(), crossBlockSample.slice(0, sourceOffset(anchorPosition)), '反向 Shift 扩选复制必须覆盖完整源码区间');
  assert.deepEqual((await crossBlockHighlight()).map(block => block.list || block.code), [true, true], '反向 Shift 扩选的两个中间块必须保持渲染');
  console.log('STEP Shift keyboard cross-block extension (forward + reverse)');
  // A continuous typing burst is one undo step; redo restores it.
  await page.locator('[data-command="source"]').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  const sourceText = () => page.evaluate(() => document.querySelector('.cm-content').textContent);
  await page.keyboard.insertText('AAA');
  await page.keyboard.insertText('BBB');
  assert.match(await sourceText(), /AAABBB/);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.ok(!(await sourceText()).includes('AAABBB'), '连续输入应合并为一次撤销');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  assert.match(await sourceText(), /AAABBB/, '重做应恢复整段连续输入');
  console.log('STEP grouped undo / redo across rendered blocks');
  // ── Iteration 2: command palette, panels, status bar, prose affordances ──
  await page.locator('[data-command="source"]').click();
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# 章节标题\n\n```js\nconst answer = 42;\n```\n\n## 小节标题\n\n一段正文内容。\n');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 2, { timeout: 8000 });
  if (process.platform === 'darwin') assert.ok(await page.evaluate(() => document.body.classList.contains('frameless')), 'macOS 应使用沉浸式标题栏');
  assert.match(await page.locator('#encoding').textContent(), /UTF-8 · LF/);
  assert.match(await page.locator('#breadcrumb').textContent(), /§\s*(章节标题|小节标题)/, '状态栏应显示当前章节面包屑');
  console.log('STEP frameless chrome + enhanced status bar');
  // Code blocks expose a one-click copy affordance.
  await app.evaluate(async ({ clipboard }) => clipboard.clear());
  await page.locator('.md-widget .code-copy').first().hover();
  await page.locator('.md-widget .code-copy').first().click();
  await pollClipboard('text', /const answer = 42/);
  console.log('STEP copy code button');
  // Command palette searches actions and runs the highlighted one with Enter.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'quick-open'));
  await page.locator('#quick-filter').waitFor();
  await page.locator('#quick-filter').fill('源码模式');
  assert.equal(await page.locator('.quick-item[data-quick-command="source"]').count(), 1);
  assert.equal(await page.locator('.quick-item.selected').count(), 1);
  const modeBefore = await page.locator('#mode-label').textContent();
  await page.keyboard.press('Enter');
  await page.waitForFunction(previous => document.querySelector('#mode-label').textContent !== previous, modeBefore);
  console.log('STEP command palette keyboard execution');
  await page.locator('[data-command="source"]').click();
  // Article panel and resizable sidebar are part of the new chrome.
  await page.locator('[data-side="articles"]').click();
  assert.ok((await page.locator('#side-content').textContent()).length > 0);
  const resizer = await page.locator('#sidebar-resizer').boundingBox();
  await page.mouse.move(resizer.x + 2, resizer.y + 120);
  await page.mouse.down();
  await page.mouse.move(resizer.x + 46, resizer.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(async () => (await window.desktop.settings()).value.sidebarWidth > 240, null, { timeout: 8000 });
  console.log('STEP article panel + resizable sidebar');
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="headingNumbering"]').check();
  await page.locator('#preferences button[type="submit"]').click();
  assert.ok(await page.evaluate(() => document.body.classList.contains('heading-numbering')));
  console.log('STEP heading auto-numbering');
  // ── Iteration 3: outline reordering and persisted window geometry ──────
  await page.locator('[data-side="outline"]').click();
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# 一\n\n甲内容\n\n# 二\n\n乙内容\n\n# 三\n\n丙内容\n');
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length >= 3, null, { timeout: 8000 });
  await page.locator('.outline-item').nth(0).dragTo(page.locator('.outline-item').nth(2));
  await page.waitForTimeout(250);
  await page.locator('[data-command="source"]').click();
  const reordered = await sourceText();
  assert.ok(reordered.indexOf('# 二') < reordered.indexOf('# 三') && reordered.indexOf('# 三') < reordered.indexOf('# 一'),
    `大纲拖拽应把第一节移到末尾，实际：${reordered}`);
  for (const text of ['甲内容', '乙内容', '丙内容']) assert.ok(reordered.includes(text), `重排不得丢失正文：${text}`);
  console.log('STEP outline drag reorders whole sections');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 90, width: 1000, height: 720 }));
  await page.waitForFunction(async () => (await window.desktop.settings()).value.windowBounds?.width === 1000, null, { timeout: 8000 });
  console.log('STEP persisted window bounds');
  // ── Iteration 4: table cell navigation and large-document fallback ─────
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('| 苹果 | 3 |\n| --- | --- |\n| 梨 | 5 |\n');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home');
  await page.keyboard.press('Tab');
  assert.match(await page.locator('#selection-status').textContent(), /已选 1 字/, 'Tab 应选中第二个单元格');
  await page.keyboard.press('Shift+Tab');
  assert.match(await page.locator('#selection-status').textContent(), /已选 2 字/, 'Shift+Tab 应回到第一个单元格');
  console.log('STEP Tab / Shift+Tab table cell navigation');
  // A 220k document stays on the live layout: the benchmark measured it well
  // inside the 150 ms/key budget, so the old 200k fallback moved up. The
  // fixture deliberately carries duplicate headings, a reference definition
  // and a footnote definition at the end; document-wide state has to survive a
  // parse this large and the active block must still be the only source line.
  page.setDefaultTimeout(180000);
  const big = (() => {
    const fragment = n => `## 重复标题\n\n第 ${n} 段含 **粗体**、[引用链接][ref] 与脚注[^note]。\n\n- 列表项 ${n}\n\n`;
    let text = '# 大文档\n\n';
    for (let n = 1; text.length < 220000; n++) text += fragment(n);
    return `${text}\n[ref]: https://example.com/ref\n\n[^note]: 脚注内容\n`;
  })();
  // The outline step above switches to source mode to read the reordered text.
  // Large-document coverage is about the live layout, so return to it first.
  if (await page.locator('[data-command="source"]').getAttribute('aria-pressed') === 'true') {
    await page.locator('[data-command="source"]').click();
  }
  // Open a file instead of pasting 220k characters into the editor: pasting a
  // live document would run the whole-document layout once per input chunk,
  // which measures insertion, not the layout a user actually reads. File open
  // is also the real path for a large document and is what test/perf.mjs does.
  const bigPath = path.join(root, 'large-220k.md');
  await fs.writeFile(bigPath, big);
  const openedAt = Date.now();
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, bigPath);
  await page.locator('[data-command="open"]').click();
  await page.waitForFunction(name => document.querySelector('#location').textContent.includes(name), path.basename(bigPath));
  await page.waitForFunction(() => document.querySelector('.cm-editor')?.dataset.inkstoneLayout === 'typeset', null, { timeout: 120000 });
  await page.locator('.md-widget').first().waitFor({ timeout: 120000 });
  assert.equal(Number(await page.evaluate(() => document.querySelector('.cm-editor').dataset.inkstoneLength)), big.length,
    '220k 文档必须完整进入实时排版');
  assert.ok(await page.locator('.md-widget').count() > 0);
  console.log(`STEP 220k characters stay typeset (open + first render ${Date.now() - openedAt} ms)`);
  // Land on a blank line after the first heading so every visible block is
  // typeset, then check the two duplicate anchors, the reference link and the
  // footnote tooltip that all depend on definitions at the end of the file.
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod}+Home`);
  await page.waitForFunction(() => /^行 1，/.test(document.querySelector('#position').textContent), null, { timeout: 60000 });
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget h2').length >= 2, null, { timeout: 60000 });
  const bigTop = await page.evaluate(() => ({
    headings: [...document.querySelectorAll('.md-widget h2')].slice(0, 2).map(node => node.id),
    reference: document.querySelector('.md-widget a[href="https://example.com/ref"]')?.textContent || '',
    footnote: document.querySelector('.md-widget sup.footnote-ref a')?.getAttribute('title') || ''
  }));
  assert.deepEqual(bigTop.headings, ['重复标题', '重复标题-1'], `220k 文档的重复标题锚点必须保持编号，实际 ${JSON.stringify(bigTop.headings)}`);
  assert.equal(bigTop.reference, '引用链接', '220k 文档必须解析文末的引用式链接定义');
  assert.equal(bigTop.footnote, '脚注内容', '220k 文档的脚注提示必须带出文末定义');
  // The end of the file must be reachable and still render blocks around the
  // caret; a selection there must update the status bar from the same source.
  const bottomAt = Date.now();
  await page.keyboard.press(`${mod}+End`);
  await page.waitForFunction(() => {
    const editor = document.querySelector('.cm-editor');
    const total = Number(editor?.dataset.inkstoneLines || 0);
    const line = Number(/行 (\d+)/.exec(document.querySelector('#position')?.textContent || '')?.[1] || 0);
    return total > 0 && line === total;
  }, null, { timeout: 60000 });
  const bottomVisible = await page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    const last = [...document.querySelectorAll('.cm-line')].at(-1);
    const view = scroller.getBoundingClientRect();
    const rect = last?.getBoundingClientRect();
    return !!rect && rect.top < view.bottom && rect.bottom > view.top;
  });
  assert.ok(bottomVisible, '220k 文档必须能滚动到最后一行');
  const bottomMs = Date.now() - bottomAt;
  await page.keyboard.press('Shift+ArrowUp');
  assert.match(await page.locator('#selection-status').textContent(), /已选 \d+ 字/, '220k 文档中仍应能正常扩选');
  const headAt = Date.now();
  await page.keyboard.press(`${mod}+Home`);
  await page.waitForFunction(() => /^行 1，/.test(document.querySelector('#position').textContent), null, { timeout: 60000 });
  console.log(`STEP 220k typeset: duplicate headings, reference + footnote definitions, scroll and selection (bottom ${bottomMs} ms, head ${Date.now() - headAt} ms)`);
  // Above the new limit the live renderer must stand down completely. The
  // source remains a single CodeMirror document, still scrollable end to end;
  // typing there must not build a widget or a live line.
  const fallback = (() => {
    let text = '# 大文档\n\n';
    for (let n = 1; text.length < 275000; n++) text += `## 重复标题\n\n第 ${n} 段含 [引用链接][ref] 与脚注[^note]。\n\n`;
    return `${text}\n[ref]: https://example.com/ref\n\n[^note]: 脚注内容\n`;
  })();
  const fallbackPath = path.join(root, 'large-275k.md');
  await fs.writeFile(fallbackPath, fallback);
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, fallbackPath);
  await page.locator('[data-command="open"]').click();
  await page.waitForFunction(name => document.querySelector('#location').textContent.includes(name), path.basename(fallbackPath));
  await page.waitForFunction(() => document.querySelector('.cm-editor')?.dataset.inkstoneLayout === 'source-fallback', null, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length === 0, null, { timeout: 60000 });
  assert.equal(await page.locator('.cm-live-line').count(), 0, '超过上限后不应保留排版行');
  assert.equal(Number(await page.evaluate(() => document.querySelector('.cm-editor').dataset.inkstoneLength)), fallback.length,
    '源码兜底文档必须完整保留');
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${mod}+Home`);
  await page.waitForFunction(() => /^行 1，/.test(document.querySelector('#position').textContent), null, { timeout: 60000 });
  await page.keyboard.press(`${mod}+End`);
  await page.waitForFunction(() => {
    const total = Number(document.querySelector('.cm-editor')?.dataset.inkstoneLines || 0);
    const line = Number(/行 (\d+)/.exec(document.querySelector('#position')?.textContent || '')?.[1] || 0);
    return total > 0 && line === total;
  }, null, { timeout: 60000 });
  await page.keyboard.press('Shift+ArrowUp');
  assert.match(await page.locator('#selection-status').textContent(), /已选 \d+ 字/, '源码兜底文档中仍应能正常扩选');
  page.setDefaultTimeout(15000);
  console.log('STEP above-limit plain-source fallback: document intact, scrolls end to end, selection works');
  // A Typora-like toolbar-free layout is opt-in from preferences.
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="showFormatbar"]').uncheck();
  await page.locator('#preferences button[type="submit"]').click();
  assert.ok(await page.evaluate(() => document.body.classList.contains('hide-formatbar')));
  assert.equal(await page.locator('.formatbar').isVisible(), false);
  console.log('STEP optional toolbar-free layout');
  // Hidden syntax must never corrupt the source: typing into a typeset active
  // block writes to the real Markdown characters.
  if (await page.locator('[data-command="source"]').getAttribute('aria-pressed') === 'true') {
    await page.locator('[data-command="source"]').click();
  }
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('前缀 **加粗** 后缀。\n\n另一段。\n');
  await page.locator('.md-widget').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('XY');
  await page.locator('[data-command="source"]').click();
  assert.match(await sourceText(), /前缀 \*\*加粗\*\* 后缀。XY/, '排版态输入必须落回真实 Markdown 源码');
  console.log('STEP typing in typeset mode keeps Markdown source intact');
  // Typora's contract: a completed syntax becomes typeset IMMEDIATELY, while
  // the caret is still right after the closing delimiter. It must not wait for
  // the user to leave the block or the "syntax state".
  const ensureLive = async () => {
    if (await page.locator('[data-command="source"]').getAttribute('aria-pressed') === 'true') {
      await page.locator('[data-command="source"]').click();
    }
  };
  const fresh = async () => {
    await ensureLive();
    await page.locator('.topbar [data-command="new"]').click();
    await page.locator('.cm-content').click();
  };
  await fresh();
  await page.keyboard.type('**加粗**', { delay: 25 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-hidden-mark').length >= 2);
  assert.ok(await page.locator('.cm-lv-strong').count() >= 1, '闭合 ** 后应立即显示真实粗体');
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('**'), '刚敲完闭合标记不应再裸露语法字符');
  // Entering the element (not the whole block) is what brings syntax back.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('.cm-md-mark').length >= 2);
  await page.keyboard.press('End');
  await page.keyboard.type('XY', { delay: 25 });
  await ensureLive();
  await page.locator('[data-command="source"]').click();
  assert.match(await sourceText(), /\*\*加粗\*\*XY/, '隐藏语法后继续输入不得破坏源码');
  await ensureLive();
  console.log('STEP immediate typeset on closing delimiter + reveal only inside element');
  await fresh();
  await page.keyboard.type('#', { delay: 25 });
  assert.equal(await page.locator('.cm-lv-h1').count(), 0, '输入 # 在空格前保持普通字号');
  await page.keyboard.type(' ', { delay: 25 });
  await page.locator('.cm-lv-h1').waitFor();
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('# '), '输入 # 加空格后标题前缀立即隐藏');
  await page.keyboard.type('标题', { delay: 25 });
  assert.ok(await page.locator('.cm-lv-h1').count() >= 1, '输入标题内容期间保持标题排版');
  await page.keyboard.press('Enter');
  await page.locator('.md-widget h1').waitFor();
  await fresh();
  await page.keyboard.type('- ', { delay: 25 });
  await page.locator('.cm-prefix-bullet').waitFor();
  assert.equal(await page.locator('.cm-md-mark').count(), 0, '输入 - 加空格后应立即显示项目符号');
  await fresh();
  await page.keyboard.type('1. ', { delay: 25 });
  await page.locator('.cm-prefix-ordered').waitFor();
  assert.equal(await page.locator('.cm-prefix-ordered').textContent(), '1.', '有序列表前缀应立即排版');
  await fresh();
  await page.keyboard.type('`代码`', { delay: 25 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-hidden-mark').length >= 2);
  assert.ok(await page.locator('.cm-lv-code').count() >= 1, '闭合反引号后应立即显示行内代码样式');
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('`'), '闭合反引号后不应裸露反引号');
  console.log('STEP heading typesetting after Enter; immediate bullet, ordered list and code span typesetting');
  // Typing the separator activates each block prefix, even without body text.
  for (const [marker, widget] of [
    ['-', '.cm-prefix-bullet'], ['*', '.cm-prefix-bullet'], ['+', '.cm-prefix-bullet'],
    ['1.', '.cm-prefix-ordered'], ['1)', '.cm-prefix-ordered'],
    ['>', '.cm-lv-quote'], ['>>', '.cm-lv-quote'], ['- [ ]', '.cm-prefix-task']
  ]) {
    await fresh();
    await page.keyboard.type(marker, { delay: 25 });
    assert.equal(await page.locator(widget).count(), 0, `${marker} 在空格前不应排版`);
    await page.keyboard.type(' ');
    await page.locator(widget).waitFor();
  }
  console.log('STEP list, task and quote prefixes wait for the separator');
  // Nested containers must typeset every layer, not only the outermost marker.
  // The same line may mix an already typeset outer quote with an inner bullet,
  // ordered marker or task box.
  const nestedPrefixes = [
    ['> - 项目', '•项目', { quotes: 1, bullets: 1 }],
    ['- > 引用', '•引用', { quotes: 1, bullets: 1 }],
    ['> > 引用', '引用', { quotes: 2 }],
    ['>> 引用', '引用', { quotes: 2 }],
    ['> 1. 项目', '1.项目', { quotes: 1, ordered: '1.' }],
    ['> - [ ] 任务', '☐任务', { quotes: 1, tasks: 1 }]
  ];
  for (const [sample, visible, expected] of nestedPrefixes) {
    await fresh();
    await page.keyboard.type(sample, { delay: 20 });
    const line = page.locator('.cm-live-line').first();
    assert.equal(await line.textContent(), visible, `${sample}: 可见正文`);
    assert.equal(await line.locator('.cm-prefix-quote').count(), expected.quotes || 0, `${sample}: 引用层`);
    assert.equal(await line.locator('.cm-prefix-bullet').count(), expected.bullets || 0, `${sample}: 项目符号层`);
    assert.equal(await line.locator('.cm-prefix-task').count(), expected.tasks || 0, `${sample}: 任务框层`);
    if (expected.ordered) assert.equal(await line.locator('.cm-prefix-ordered').textContent(), expected.ordered);
    assert.equal(await line.locator('.cm-md-mark').count(), 0, `${sample}: 不应残留前缀源码`);
  }
  // The outer quote typesets first; the inner marker stays raw until its own
  // separator is typed. Enter on the empty inner item exits only that layer.
  await fresh();
  await page.keyboard.type('> -', { delay: 20 });
  assert.equal(await page.locator('.cm-prefix-quote').count(), 1, '外层引用应在空格后立即排版');
  assert.equal(await page.locator('.cm-prefix-bullet').count(), 0, '内层项目符号仍在等待空格');
  assert.ok((await page.locator('.cm-live-line').first().textContent()).includes('-'), '缺少空格的内层标记应保持源码可见');
  await page.keyboard.type(' ', { delay: 20 });
  await page.locator('.cm-prefix-bullet').waitFor();
  assert.equal(await page.locator('.cm-live-line').first().textContent(), '•', '空格后内层项目符号排版');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.cm-prefix-bullet').count(), 0, '空项 Enter 只退出内层列表');
  assert.equal(await page.locator('.cm-prefix-quote').count(), 1, '退出列表后外层引用仍保留');
  // A task checkbox nested under quote and list toggles only the checkbox.
  await fresh();
  await page.keyboard.type('> - [ ] 任务', { delay: 20 });
  await page.locator('.cm-prefix-task').click();
  assert.equal(await page.locator('.cm-prefix-task').getAttribute('aria-checked'), 'true', '嵌套任务框应可勾选');
  assert.equal(await page.locator('.cm-prefix-quote').count(), 1, '勾选不得破坏外层引用');
  assert.equal(await page.locator('.cm-prefix-task').count(), 1, '任务框仍是单一复选框');
  assert.equal(await page.locator('.cm-prefix-bullet').count(), 0, '任务框不得再残留直属项目符号');
  console.log('STEP nested quote/list/task prefixes typeset by layer and exit one level');
  // A thematic break is whatever the parse says it is: the spaced spellings
  // and rules nested in a quote or list typeset, every container layer stays
  // visible, and the rule source is one ArrowLeft away from editing.
  const ruleSamples = [
    ['* * *', 0],
    ['___', 0],
    ['- - -', 0],
    ['> ---', 1],
    ['> > * * *', 2]
  ];
  for (const [sample, quotes] of ruleSamples) {
    await fresh();
    await page.keyboard.type(sample, { delay: 20 });
    const ruleLine = page.locator('.cm-live-line').first();
    await ruleLine.locator('.cm-prefix-hr').waitFor();
    assert.equal(await ruleLine.locator('.cm-prefix-hr').count(), 1, `${sample}: 应显示分隔线`);
    assert.equal(await ruleLine.locator('.cm-prefix-quote').count(), quotes, `${sample}: 引用层级`);
    assert.equal(await ruleLine.locator('.cm-md-mark').count(), 0, `${sample}: 分隔线源码应隐藏`);
    // Entering the rule brings its Markdown source back, leaving re-typesets.
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('.cm-live-line .cm-prefix-hr').length === 0);
    const ruleSource = sample.replace(/^(?:> )+/, '');
    assert.ok((await ruleLine.textContent()).endsWith(ruleSource),
      `${sample}: 光标进入后应显示分隔线源码，实际 ${JSON.stringify(await ruleLine.textContent())}`);
    await page.keyboard.press('ArrowRight');
    await ruleLine.locator('.cm-prefix-hr').waitFor();
    // Rendering never rewrites the source: a rule keeps its original spelling.
    await page.locator('[data-command="source"]').click();
    assert.equal((await sourceText()).trim(), sample, `${sample}: 源码必须原样保留`);
    await page.locator('[data-command="source"]').click();
  }
  // Typing inside the revealed rule writes real Markdown characters at the
  // caret the user actually has. ArrowLeft crosses the hidden syntax as one
  // atomic step, so the caret lands left of the last `*` — the assertion is
  // derived from the reported caret position instead of assuming an offset.
  await fresh();
  const ruleText = '* * *';
  await page.keyboard.type(ruleText, { delay: 20 });
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line .cm-prefix-hr').length === 0);
  assert.equal(await page.locator('.cm-live-line').first().textContent(), ruleText, '光标进入后应显示分隔线源码以便编辑');
  const ruleCaret = await caretPosition();
  assert.equal(ruleCaret.line, 1, '分隔线仍在第一行');
  const insertAt = ruleCaret.column - 1;
  assert.ok(insertAt >= 0 && insertAt < ruleText.length, `光标必须落在分隔线源码内，实际 ${JSON.stringify(ruleCaret)}`);
  await page.keyboard.type('X', { delay: 20 });
  await page.locator('[data-command="source"]').click();
  assert.equal((await sourceText()).trim(), ruleText.slice(0, insertAt) + 'X' + ruleText.slice(insertAt),
    '在分隔线源码中输入的字符必须写回真实 Markdown 的光标位置');
  await page.locator('[data-command="source"]').click();
  // The block leaves the active state as a real `<hr>`, nested containers kept.
  await fresh();
  await page.keyboard.insertText('> > * * *\n\n尾段');
  await page.locator('.md-widget hr').first().waitFor();
  assert.equal(await page.locator('.md-widget blockquote blockquote hr').count(), 1, '渲染态应保留两层引用内的分隔线');
  assert.equal(await page.locator('.cm-prefix-hr').count(), 0, '离开块后不应再有活跃分隔线');
  // The same characters are a Setext underline when they follow a paragraph,
  // and a table delimiter row or a fence line when the block says so.
  await fresh();
  await page.keyboard.insertText('标题\n---\n\n尾段');
  await page.locator('.md-widget h2').first().waitFor();
  assert.equal(await page.locator('.md-widget hr').count(), 0, 'Setext 必须渲染为标题');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length === 2);
  assert.equal(await page.locator('.cm-live-line .cm-prefix-hr').count(), 0, 'Setext 下划线不得变成分隔线');
  await fresh();
  await page.keyboard.insertText('> 标题\n> ---\n\n尾段');
  await page.locator('.md-widget h2').first().waitFor();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length === 2);
  assert.equal(await page.locator('.cm-live-line .cm-prefix-hr').count(), 0, '引用内的 Setext 下划线不得变成分隔线');
  await fresh();
  await page.keyboard.insertText('| A | B |\n| --- | --- |\n\n尾段');
  await page.locator('.md-widget table').first().waitFor();
  assert.equal(await page.locator('.md-widget hr').count(), 0, '表格分隔行不得变成分隔线');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length === 2);
  assert.equal(await page.locator('.cm-live-line .cm-prefix-hr').count(), 0, '活跃块内的表格分隔行不得变成分隔线');
  await fresh();
  await page.keyboard.insertText('```\n---\n```\n\n尾段');
  await page.locator('.md-widget pre').first().waitFor();
  assert.equal(await page.locator('.md-widget hr').count(), 0, '代码围栏内不得生成分隔线');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length === 3);
  assert.equal(await page.locator('.cm-live-line .cm-prefix-hr').count(), 0, '代码围栏内的 --- 仍应为字面量');
  assert.ok((await page.locator('.cm-live-line').allTextContents()).includes('---'), '代码围栏内容应完整可见');
  await fresh();
  await page.keyboard.insertText('---\ntitle: 墨页\n---\n\n尾段');
  await page.locator('.md-widget .front-matter').first().waitFor();
  assert.equal(await page.locator('.md-widget hr').count(), 0, 'front matter 不得变成分隔线');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length === 3);
  assert.equal(await page.locator('.cm-live-line .cm-prefix-hr').count(), 0, '活跃块内的 front matter 不得变成分隔线');
  // A rule nested in a list item keeps the list marker of its container.
  await fresh();
  await page.keyboard.insertText('- 项目\n\n  * * *');
  await page.locator('.cm-prefix-hr').waitFor();
  assert.equal(await page.locator('.cm-prefix-bullet').count(), 1, '列表内的分隔线应保留外层列表');
  assert.equal(await page.locator('.cm-prefix-hr').count(), 1);
  console.log('STEP parsed thematic breaks: spaced and nested rules typeset, setext/table/fence/front matter stay literal');
  // Ordinary characters are not syntax. These lines used to lose the `*`, the
  // `==`, the `~` and the `$` while the block was active, because the previous
  // layer matched delimiters with regular expressions instead of parsing.
  const plainLines = [
    '2 * 3 * 4 = 24',
    '判断 a == b 和 c == d',
    '路径 ~/.bashrc 和 ~/.zshrc',
    '价格 $5 和 $6',
    'x^2 + y^2 = z^2'
  ];
  for (const sample of plainLines) {
    await fresh();
    await page.keyboard.type(sample, { delay: 15 });
    const active = await page.locator('.cm-live-line').first().textContent();
    assert.equal(active, sample, `活跃块不得吞掉普通字符：${sample}`);
    // Leaving the block must keep the same text in the rendered view.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('尾段', { delay: 15 });
    await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 1);
    const rendered = await page.locator('.md-widget p').first().textContent();
    assert.equal(rendered.trim(), sample, `活跃块与渲染文本不一致：${sample}`);
  }
  console.log('STEP ordinary characters stay visible in the active block');
  // Nested emphasis: the inner markers are hidden like every other completed
  // syntax, so no asterisk is left on screen while the caret is outside.
  await fresh();
  // The trailing `X` keeps the caret outside the element: pressing End right
  // after a hidden marker lands in front of it, because the zero-width widget
  // is atomic for cursor movement.
  await page.keyboard.type('**粗 *斜* 字**X', { delay: 15 });
  assert.equal(await page.locator('.cm-live-line').first().textContent(), '粗 斜 字X', '嵌套强调的内层标记也应隐藏');
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('*'), '嵌套强调不应留下星号');
  assert.equal(await page.locator('.cm-lv-strong').count(), 1, '外层仍是粗体');
  assert.equal(await page.locator('.cm-lv-em').count(), 1, '内层仍是斜体');
  console.log('STEP nested emphasis hides every marker');
  // A code block nested in a list item and a `$$` formula block are literal:
  // clicking into them shows the source exactly as written.
  await fresh();
  await page.keyboard.insertText('- 列表\n  ```sh\n  rm *.txt && echo *\n  ```');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  let literalLines = await page.locator('.cm-live-line').allTextContents();
  assert.ok(literalLines.includes('  rm *.txt && echo *'), `列表内代码块应完整可见，实际 ${JSON.stringify(literalLines)}`);
  assert.ok(literalLines.includes('  ```sh'), '代码围栏应按源码显示');
  await fresh();
  await page.keyboard.insertText('$$\n\\sum_{i=1}^{m} x_i^2\n$$\n\n尾段');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  literalLines = await page.locator('.cm-live-line').allTextContents();
  assert.ok(literalLines.includes('\\sum_{i=1}^{m} x_i^2'), `公式块内容应保持字面量，实际 ${JSON.stringify(literalLines)}`);
  assert.ok(literalLines.includes('$$'), '公式分隔符应按源码显示');
  console.log('STEP literal code and formula blocks show their full source');
  // Leaving the block must not bring the raw `[ ]` back: the rendered widget
  // has to agree with the checkbox shown while the line was being typed.
  await fresh();
  await page.keyboard.insertText('- [ ]\n-\n>\n\n尾段');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 2);
  assert.equal(await page.locator('.md-widget input[type="checkbox"]').count(), 1, '离开块后空任务项仍应渲染为复选框');
  assert.ok(!(await page.locator('.md-widget').first().textContent()).includes('[ ]'), '渲染态不应出现裸 [ ]');
  assert.equal(await page.locator('.md-widget blockquote').count(), 1, '空引用行应保留可见的引用容器');
  await page.locator('.md-widget input[type="checkbox"]').first().click();
  await page.locator('[data-command="source"]').click();
  assert.match(await sourceText(), /- \[x\]/, '点击渲染态复选框应写回真实源码');
  await ensureLive();
  console.log('STEP rendered empty task item stays a checkbox and toggles source');
  // `:shortcode` autocompletion writes the Unicode glyph into the source.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type(':smi');
  await page.locator('.cm-tooltip-autocomplete').waitFor();
  // Wait for the accepted option itself: the tooltip element can exist one
  // frame before its list is populated, and Enter would then insert a newline.
  // Wait for the accepted option itself: the tooltip element can exist one
  // frame before its list is populated, and Enter would then insert a newline.
  await page.locator('.cm-tooltip-autocomplete li').first().waitFor();
  // CodeMirror ignores the accept key for `interactionDelay` (75ms) after a
  // completion opens, so a machine-speed Enter press lands on the plain keymap.
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('😄'));
  assert.match(await sourceText(), /😄/, '短代码补全应写入 Unicode 表情');
  console.log('STEP emoji shortcode autocomplete');
  // The picker is searchable and inserts at the caret.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'emoji'));
  await page.locator('.emoji-grid').waitFor();
  await page.locator('#emoji-filter').fill('rocket');
  await page.waitForFunction(() => [...document.querySelectorAll('.emoji-item')].filter(item => !item.hidden).length === 1);
  await page.locator('.emoji-item:visible').first().click();
  assert.match(await sourceText(), /🚀/);
  console.log('STEP searchable emoji picker');
  // Export options reflect the real Pandoc capability instead of failing late.
  const caps = await page.evaluate(async () => (await window.desktop.capabilities()).value);
  await page.locator('[data-command="export"]').click();
  assert.equal(await page.locator('[data-export="html"]').isDisabled(), false);
  assert.equal(await page.locator('[data-export="docx"]').isDisabled(), !caps.installed);
  await page.locator('#dialog [data-dismiss]').click();
  console.log('STEP Pandoc capability gating in export dialog');
  // A rendered image has a right-click menu with real copy actions.
  await ensureLive();
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('![示例](assets/demo.png)\n');
  await page.locator('.md-widget img').first().waitFor();
  await app.evaluate(async ({ clipboard }) => clipboard.clear());
  await page.evaluate(() => {
    const image = document.querySelector('.md-widget img');
    image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 260, clientY: 260, button: 2 }));
  });
  await page.locator('#context-menu').waitFor({ state: 'visible' });
  await page.locator('[data-image-action="copy-markdown"]').click();
  await pollClipboard('text', /!\[示例\]\(assets\/demo\.png\)/);
  console.log('STEP image context menu copy');
  // A second window owns an independent document store, not a shared one.
  const beforeWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const windowOpened = app.waitForEvent('window', { timeout: 15000 });
  await page.evaluate(() => window.desktop.newWindow());
  const second = await windowOpened;
  second.on('pageerror', error => errors.push(error.message));
  await second.locator('.cm-content').waitFor();
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) > beforeWindows);
  await second.locator('.cm-content').click();
  await second.keyboard.insertText('第二窗口独立文档');
  assert.match(await second.locator('.cm-content').textContent(), /第二窗口独立文档/);
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('第二窗口独立文档'), '不同窗口的文档必须相互独立');
  console.log('STEP independent new window with its own document store');
  // CDP drives real compositionstart/update/end events into the contenteditable.
  // An IME session must never tear down typesetting for the whole document.
  await page.bringToFront();
  await fresh();
  await page.keyboard.insertText('# 标题\n\n第一段含 **加粗** 与 `代码`。\n\n- 列表项\n\n> 引用文字\n\n结尾段落。');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 4);
  const imeState = () => page.evaluate(() => ({
    widgets: document.querySelectorAll('.md-widget').length,
    live: document.querySelectorAll('.cm-live-line').length,
    strong: document.querySelectorAll('.md-widget strong').length,
    heading: document.querySelectorAll('.md-widget h1').length,
    bare: /\*\*|`|^# |^- /m.test(document.querySelector('.cm-content').textContent)
  }));
  const beforeIme = await imeState();
  assert.ok(beforeIme.widgets >= 4 && beforeIme.strong >= 1 && !beforeIme.bare, '组合输入前应是完整排版态');
  // Focus without clicking the middle of the viewport (that would turn a
  // rendered block into the active one and legitimately remove one widget).
  await page.locator('.cm-content').focus();
  await page.keyboard.press('End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await page.waitForTimeout(180);
  const duringIme = await imeState();
  assert.ok(duringIme.widgets >= 1 && duringIme.live >= 1 && !duringIme.bare,
    `组合输入期间整篇排版不得退回源码: ${JSON.stringify(duringIme)}`);
  assert.ok(duringIme.strong + duringIme.heading >= 1,
    `组合输入期间渲染块样式必须保留: ${JSON.stringify(duringIme)}`);
  assert.equal(duringIme.bare, false, '组合输入期间不得裸露 Markdown 语法');
  assert.match(await page.locator('.cm-content').textContent(), /zhong/, '拼音组合文本应进入活跃块');
  await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  await page.waitForTimeout(120);
  await cdp.send('Input.insertText', { text: '中文' });
  await page.waitForTimeout(320);
  const afterIme = await imeState();
  assert.ok(afterIme.widgets >= 4 && !afterIme.bare, '组合结束后应保持排版');
  const imeText = await page.locator('.cm-content').textContent();
  assert.match(imeText, /结尾段落。中文/);
  assert.ok(!imeText.includes('zhong'), '拼音组合文本不得留在文档里');
  await page.locator('[data-command="source"]').click();
  const imeLines = await page.evaluate(() => [...document.querySelectorAll('.cm-line')].map(l => l.textContent));
  assert.ok(imeLines.includes('第一段含 **加粗** 与 `代码`。'), '组合输入不得破坏已有语法源码');
  assert.equal(imeLines.at(-1), '结尾段落。中文', '候选确认必须只写入一次中文，不丢字不重复');
  await ensureLive();
  // The active block's own hidden inline syntax must also survive composition.
  await fresh();
  await page.keyboard.type('**加粗**', { delay: 20 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-hidden-mark').length >= 2);
  const hiddenBefore = await page.locator('.cm-hidden-mark').count();
  const cdp2 = await page.context().newCDPSession(page);
  await cdp2.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.cm-hidden-mark').count(), hiddenBefore, '组合输入期间活跃块隐藏的语法标记不得消失');
  assert.equal(await page.locator('.cm-lv-strong').count(), 1, '组合输入期间活跃块粗体样式不得消失');
  await cdp2.send('Input.insertText', { text: '中文' });
  await page.waitForTimeout(300);
  await page.locator('[data-command="source"]').click();
  assert.equal(await page.locator('.cm-content').textContent(), '**加粗**中文', '活跃块组合输入后源码必须完整');
  await ensureLive();
  console.log('STEP IME composition keeps typesetting across the document');
  // Return creates a paragraph like Typora; Shift+Return keeps one soft break.
  await fresh();
  await page.keyboard.insertText('第一段');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('第二段');
  await page.locator('[data-command="source"]').click();
  assert.equal(await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n')), '第一段\n\n第二段');
  await ensureLive();
  await fresh();
  await page.keyboard.insertText('第一行');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.insertText('第二行');
  await page.locator('[data-command="source"]').click();
  assert.equal(await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n')), '第一行\n第二行');
  await ensureLive();
  console.log('STEP Typora paragraph and soft-break Enter behavior');
  // Heading level shortcuts must reach heading(), not the heading-N command branch.
  await fresh();
  await page.keyboard.insertText('## 标题');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+=' : 'Control+=');
  await page.locator('[data-command="source"]').click();
  assert.equal(await sourceText(), '# 标题');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+-' : 'Control+-');
  assert.equal(await sourceText(), '## 标题');
  await ensureLive();
  console.log('STEP heading level shortcuts');
  // Pipes inside fenced code are never table rows.
  await fresh();
  await page.keyboard.insertText('```js\n| a | b |\n| --- | --- |\n```');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('code');
  await page.locator('[data-command="source"]').click();
  const fencedSource = await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n'));
  assert.doesNotMatch(fencedSource, /\| {2}\| {2}\|/, '代码块内的管道符不能触发表格新增行');
  assert.match(fencedSource, /\| a \| b \|\ncode\n\| --- \| --- \|/);
  await ensureLive();
  console.log('STEP fenced-code Enter is not treated as a table');
  // CRLF affects serialization only; rendered click positions stay in the
  // normalized CodeMirror coordinate system.
  const crlfPath = path.join(root, 'crlf-tasks.md');
  await fs.writeFile(crlfPath, '- [ ] first\r\n- [ ] second\r\n');
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, crlfPath);
  await page.locator('[data-command="open"]').click();
  await page.locator('.md-widget input[type="checkbox"]').nth(1).click();
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  assert.equal(await fs.readFile(crlfPath, 'utf8'), '- [ ] first\r\n- [x] second\r\n');
  console.log('STEP CRLF rendered task coordinates');
  // ── Newline fidelity and rendered-table fixes ───────────────────────────
  const openFile = async filePath => {
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, filePath);
    await page.locator('[data-command="open"]').click();
    // Opening is asynchronous: wait for the new tab to become the active one.
    await page.waitForFunction(name => document.querySelector('#location').textContent.includes(name), path.basename(filePath));
    await page.locator('.cm-content').waitFor();
  };
  // A second window may own index 0 in getAllWindows(); broadcast so the
  // assertion always sees the effect in the window this test drives.
  const broadcast = command => app.evaluate(({ BrowserWindow }, name) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('inkstone:command', name);
  }, command);
  const saveOpenFile = async () => {
    await page.locator('[data-command="save"]').click();
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  };
  const sourceLines = () => page.locator('.cm-line').allTextContents();
  const onlyCrlf = text => !text.replace(/\r\n/g, '').includes('\n');
  // A CRLF file must stay CRLF after every kind of inserted line break, and
  // the whole document must keep rendering (the old bug left "\r" characters
  // inside line contents, which broke every block).
  const crlfBlocks = path.join(root, 'crlf-blocks.md');
  await fs.writeFile(crlfBlocks, '第一段\r\n\r\n第二段\r\n');
  await openFile(crlfBlocks);
  await page.locator('.md-widget p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('新段落', { delay: 20 });
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('软换行', { delay: 20 });
  // A blank line is what lets the inserted table start its own block.
  await page.keyboard.press('Enter');
  // The app's "insert table" inserts exactly this text at the caret.
  await broadcast('table');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget table').length >= 1);
  await saveOpenFile();
  const crlfBlocksText = await fs.readFile(crlfBlocks, 'utf8');
  assert.equal(onlyCrlf(crlfBlocksText), true, `CRLF 文档不得写入裸 LF：${JSON.stringify(crlfBlocksText)}`);
  assert.match(crlfBlocksText, /第一段\r\n新段落\r\n软换行\r\n/);
  assert.match(crlfBlocksText, /\| 列一 \| 列二 \|/);
  assert.ok(await page.locator('.md-widget').count() >= 1, 'CRLF 文档仍应渲染块');
  assert.equal(await page.locator('.md-widget table').count(), 1, '插入的表格应渲染');
  console.log('STEP CRLF Enter / Shift+Enter / inserted table stay CRLF and render');
  // Dragging a column edge on a CRLF table must write the width comment at the
  // right place: table offsets come from the LF document, not from the CRLF text.
  const crlfTable = path.join(root, 'crlf-table.md');
  await fs.writeFile(crlfTable, '前言\r\n\r\n| 甲 | 乙 |\r\n| --- | --- |\r\n| 1 | 2 |\r\n');
  await openFile(crlfTable);
  await page.locator('.md-widget .table-column-resizer').first().waitFor();
  await page.waitForTimeout(250);
  const crlfHeader = await page.locator('.md-widget table th').first().boundingBox();
  const crlfX = crlfHeader.x + crlfHeader.width - 5, crlfY = crlfHeader.y + crlfHeader.height / 2;
  await page.mouse.move(crlfX, crlfY);
  await page.mouse.down();
  await page.mouse.move(crlfX + 60, crlfY, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.md-widget table colgroup col').length >= 2);
  await saveOpenFile();
  const crlfTableText = await fs.readFile(crlfTable, 'utf8');
  assert.match(crlfTableText, /inkstone:columns/, 'CRLF 文档拖列宽必须写入注释');
  assert.equal(onlyCrlf(crlfTableText), true, `列宽注释不得写入裸 LF：${JSON.stringify(crlfTableText)}`);
  assert.match(crlfTableText, /\| 1 \| 2 \|\r\n\r\n<!-- inkstone:columns [\d.,]+ -->\r\n$/, '注释应在文档末尾，不得切断表格');
  assert.match(crlfTableText, /^前言\r\n/, '拖动列宽不得动到前面的段落');
  // The grid editor also takes its replacement range from the LF document.
  await page.locator('.md-widget table td').first().click({ button: 'right' });
  await page.locator('.table-editor').waitFor();
  await page.locator('[data-cell="1-0"]').fill('7');
  await page.locator('[data-table-op="apply"]').click();
  await saveOpenFile();
  const crlfGridText = await fs.readFile(crlfTable, 'utf8');
  assert.match(crlfGridText, /^\| 7 +\| 2 +\|$/m, '图形化编辑器在 CRLF 文档中必须改到正确的表格');
  assert.match(crlfGridText, /^前言\r\n\r\n\| 甲 +\| 乙 +\|$/m, '图形化编辑器不得吃掉前面的段落');
  assert.equal(onlyCrlf(crlfGridText), true, '图形化编辑后仍是纯 CRLF');
  console.log('STEP CRLF column drag writes the width comment in place');
  // Mixed endings: only the edited line changes, and an untouched save is
  // byte-for-byte identical.
  const mixedPath = path.join(root, 'mixed-eol.md');
  const mixed = '第一行\r\n\r\n第二行\n\n第三行\n\n第四行\r\n';
  await fs.writeFile(mixedPath, mixed);
  await openFile(mixedPath);
  await page.locator('.md-widget p').filter({ hasText: '第三行' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await saveOpenFile();
  assert.equal(await fs.readFile(mixedPath, 'utf8'), mixed.replace('第三行\n', '第三行X\n'),
    '混合换行文件只应改动被编辑的那一行');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(150);
  await saveOpenFile();
  assert.equal(await fs.readFile(mixedPath, 'utf8'), mixed, '混合换行文件未修改保存必须逐字节一致');
  console.log('STEP mixed newline file keeps per-line endings on edit and unchanged save');
  // Clicking a rendered cell without typing must never rewrite it. The old
  // code copied the *rendered* text back, so `**b**` and links were lost.
  const cellPath = path.join(root, 'cells.md');
  const cellSource = '| a **b** c | [链接](https://x.y) |\n| --- | --- |\n| 1 | 2 |\n';
  await fs.writeFile(cellPath, cellSource);
  await openFile(cellPath);
  await page.locator('.md-widget table th').first().click();
  await page.waitForFunction(() => !!document.querySelector('.md-widget table th.table-cell-editing .cm-content'));
  assert.equal(await page.locator('.md-widget table th').first().textContent(), 'a **b** c', '编辑时应显示单元格的 Markdown 源码');
  await page.locator('.md-widget table th').nth(1).click();
  await page.waitForFunction(() => document.activeElement?.closest?.('td, th')?.textContent === '[链接](https://x.y)');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.md-widget table strong').count(), 1, '未修改时应恢复原渲染 DOM');
  assert.equal(await page.locator('.md-widget table a').count(), 1);
  await page.locator('[data-command="source"]').click();
  assert.deepEqual(await sourceLines(), cellSource.split('\n'), '只点击单元格不得改动文档');
  await page.locator('[data-command="source"]').click();
  await saveOpenFile();
  await page.waitForTimeout(150);
  assert.equal(await fs.readFile(cellPath, 'utf8'), cellSource, '只点击单元格再离开，文件必须不变');
  console.log('STEP clicking a rendered cell without editing leaves the file untouched');
  // Editing that cell keeps its inline Markdown syntax intact.
  await page.locator('.md-widget table th').first().click();
  await page.waitForFunction(() => !!document.querySelector('.md-widget table th.table-cell-editing .cm-content'));
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.closest?.('td, th')?.textContent === '[链接](https://x.y)', { timeout: 8000 });
  assert.equal(await page.locator('.md-widget table th').nth(1).locator('.table-cell-editor .cm-content').count(), 1, 'Tab 提交后应进入下一格继续编辑');
  await page.keyboard.press('Escape');
  await page.locator('[data-command="source"]').click();
  assert.deepEqual(await sourceLines(), ['| a **b** c X | [链接](https://x.y) |', '| --- | --- |', '| 1 | 2 |', ''],
    '修改含粗体的单元格必须保留 Markdown 语法');
  await page.locator('[data-command="source"]').click();
  assert.equal(await page.locator('.md-widget table strong').first().textContent(), 'b');
  console.log('STEP editing a bold cell preserves its Markdown syntax');
  // A cell keeps its inline Markdown typeset while it is edited: bold, italic,
  // inline code and link text stay styled, the markers stay visible (dimmed) so
  // they can be changed, and the commit writes only the cell's own source range.
  // One undo reverts the whole edit; Escape and an empty commit add no history.
  const richCellSource = '| 样式 | 说明 |\n| --- | --- |\n| **粗体** *斜体* `code` [链接](https://x.y) a \\| b | 普通 |\n\n结尾段落。\n';
  const richCellPath = path.join(root, 'rich-cells.md');
  await fs.writeFile(richCellPath, richCellSource);
  await openFile(richCellPath);
  await page.locator('.md-widget table tbody td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.table-cell-editing .cm-content'));
  const richCell = await page.evaluate(() => {
    const cell = document.querySelector('.table-cell-editing');
    const text = selector => [...cell.querySelectorAll(selector)].map(node => node.textContent).join('');
    return {
      strong: text('.cm-lv-strong'), em: text('.cm-lv-em'), code: text('.cm-lv-code'),
      link: text('.cm-lv-link'), marks: text('.cm-md-mark'),
      source: cell.querySelector('.cm-content').textContent
    };
  });
  assert.deepEqual(
    { strong: richCell.strong, em: richCell.em, code: richCell.code, link: richCell.link },
    { strong: '粗体', em: '斜体', code: 'code', link: '链接' },
    '编辑单元格时必须保留粗体/斜体/行内代码/链接正文的可见样式'
  );
  assert.ok(richCell.marks.includes('**') && richCell.marks.includes('`') && richCell.marks.includes('\\'),
    `语法标记必须可见以便修改：${richCell.marks}`);
  assert.ok(richCell.source.includes('a \\| b'), `编辑内容必须是单元格的 Markdown 源码：${richCell.source}`);
  assert.equal(await page.locator('.cm-live-line').count(), 0, '编辑单元格时整表不得展开成源码');
  assert.equal(await page.locator('.md-widget table').count(), 1, '编辑单元格时其它单元格与整表必须保持排版');
  await page.keyboard.press('End');
  await page.keyboard.type(' 新增');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.closest?.('td, th')?.textContent === '普通', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.locator('[data-command="source"]').click();
  assert.deepEqual((await sourceLines()).slice(0, 3), [
    '| 样式 | 说明 |',
    '| --- | --- |',
    '| **粗体** *斜体* `code` [链接](https://x.y) a \\| b 新增 | 普通 |'
  ], '局部修改必须保留原有 Markdown 标记与转义竖线');
  await page.locator('[data-command="source"]').click();
  // Escape writes nothing, and the next undo still reverts the real commit.
  await page.locator('.md-widget table tbody td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.table-cell-editing .cm-content'));
  await page.keyboard.type('ZZZ');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.table-cell-editing').count(), 0, 'Escape 必须关闭单元格编辑器');
  assert.equal(await page.locator('.md-widget table strong').count(), 1, 'Escape 后必须恢复原渲染 DOM');
  await page.locator('[data-command="source"]').click();
  assert.ok(!(await sourceLines())[2].includes('ZZZ'), 'Escape 不得写入文档');
  await page.locator('[data-command="source"]').click();
  // Tab without typing is an empty commit: it must not consume the undo step.
  await page.locator('.md-widget table tbody td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.table-cell-editing .cm-content'));
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.closest?.('td, th')?.textContent === '普通', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(150);
  await page.locator('[data-command="source"]').click();
  assert.deepEqual(await sourceLines(), richCellSource.split('\n'), '一次撤销必须撤销整次单元格提交，Escape 与空提交不得增加历史');
  await page.locator('[data-command="source"]').click();
  console.log('STEP in-cell Markdown keeps inline styles, markers, single-step undo and empty history');
  // GFM allows missing outer pipes, and a pipe preceded by a backslash is text
  // for markdown-it (which looks at the character right before the pipe, not at
  // the parity of a backslash run). Both must map the DOM column to the exact
  // source range without touching the neighbouring cell.
  const slash = '\\';
  const optionalSource = 'A | B\r\n--- | ---\r\n| a ' + slash + slash + '| b | c\r\n';
  const optionalPath = path.join(root, 'optional-pipes.md');
  await fs.writeFile(optionalPath, optionalSource);
  await openFile(optionalPath);
  await page.locator('.md-widget table tbody td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.table-cell-editing .cm-content'));
  assert.equal(await page.locator('.table-cell-editing .cm-content').textContent(), 'a ' + slash + slash + '| b',
    '反斜杠后的竖线必须留在第一个单元格');
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.closest?.('td, th')?.cellIndex === 1);
  assert.equal(await page.locator('.table-cell-editing .cm-content').textContent(), 'c', 'Tab 必须进入真正渲染的第二列');
  await page.keyboard.press('Escape');
  await page.locator('[data-command="source"]').click();
  assert.equal((await sourceLines())[2], '| a ' + slash + slash + '| bX | c', '写入位置不得越过转义竖线');
  await page.locator('[data-command="source"]').click();
  await saveOpenFile();
  assert.equal(await fs.readFile(optionalPath, 'utf8'),
    'A | B\r\n--- | ---\r\n| a ' + slash + slash + '| bX | c\r\n',
    '缺省外侧竖线的 CRLF 表格只改目标单元格');
  console.log('STEP optional outer pipes and consecutive backslashes map to the rendered cell');
  // A quoted heading with a pipe is a separate block, not a row: Enter must be
  // inserted before it. A raw HTML table in the same block makes the DOM and
  // GFM index spaces ambiguous, so cell entry and the grid editor must refuse.
  const headingSource = '> | A | B |\n> | --- | --- |\n> | x | y |\n> # H | Q\n';
  const headingPath = path.join(root, 'heading-pipe.md');
  await fs.writeFile(headingPath, headingSource);
  await openFile(headingPath);
  await page.locator('.md-widget blockquote table tbody td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.table-cell-editing .cm-content'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget blockquote table tbody tr').length === 2);
  await page.keyboard.press('Escape');
  await page.locator('[data-command="source"]').click();
  assert.deepEqual((await sourceLines()).slice(0, 5), ['> | A | B |', '> | --- | --- |', '> | x | y |', '> |  |  |', '> # H | Q'],
    '新增行必须在表格内、标题前');
  await page.locator('[data-command="source"]').click();
  const mixedSource = [
    '> <table><tbody><tr><td>html</td></tr></tbody></table>', '>',
    '> | A | B |', '> | --- | --- |', '> | x | y |', '>',
    '> | C | D |', '> | --- | --- |', '> | p | q |', ''
  ].join('\n');
  const mixedTablePath = path.join(root, 'mixed-tables.md');
  await fs.writeFile(mixedTablePath, mixedSource);
  await openFile(mixedTablePath);
  await page.waitForFunction(() => document.querySelectorAll('.md-widget blockquote table').length === 3);
  await page.locator('.md-widget blockquote table').nth(1).locator('tbody td').first().click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.table-cell-editing').count(), 0, '混合 HTML/GFM 表格不得猜测单元格源码');
  await page.locator('.md-widget blockquote table').nth(1).locator('tbody td').first().click({ button: 'right' });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#dialog[open] .table-editor').count(), 0, '混合表格不得打开相邻表格的图形化编辑器');
  await saveOpenFile();
  assert.equal(await fs.readFile(mixedTablePath, 'utf8'), mixedSource, '拒绝编辑后文件必须逐字节不变');
  console.log('STEP quoted pipe heading and mixed HTML/GFM tables stay outside the cell range');
  // IME candidate keys never append a row / close the cell, and an explicit
  // native Save flushes the draft even though the cell never loses focus.
  const saveDraftPath = path.join(root, 'save-draft.md');
  await fs.writeFile(saveDraftPath, '| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  await openFile(saveDraftPath);
  await page.locator('.md-widget table tbody td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.table-cell-editing .cm-content'));
  for (const key of ['Enter', 'Tab', 'Escape']) {
    await page.locator('.table-cell-editing .cm-content').evaluate((node, name) => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
    }, key);
  }
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.md-widget table tbody tr').count(), 1, 'IME 候选按键不得追加表格行');
  assert.equal(await page.locator('.table-cell-editing .cm-content').count(), 1, 'IME 候选按键不得提交或取消单元格');
  await page.keyboard.press('End');
  await page.keyboard.type('存');
  await app.evaluate(({ BrowserWindow }) => {
    // An independent second window from an earlier step may own index 0.
    const win = BrowserWindow.getAllWindows().find(window => window.webContents.getTitle().includes('save-draft.md'));
    win?.webContents.send('inkstone:command', 'save');
  });
  await page.waitForFunction(() => !document.querySelector('.table-cell-editing'), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存', null, { timeout: 8000 });
  assert.match(await fs.readFile(saveDraftPath, 'utf8'), /\| 1存 \| 2 \|/, '原生命令保存必须提交活动单元格草稿');
  console.log('STEP IME candidate keys are ignored and native Save commits the active cell');
  // Tab walks cells and Enter appends a row, both from the rendered table.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
  await page.locator('.md-widget table td').first().click();
  await page.waitForFunction(() => !!document.querySelector('.md-widget table td.table-cell-editing .cm-content'));
  await page.keyboard.type('9');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.closest?.('td, th')?.textContent === '2', { timeout: 8000 });
  const rowsBefore = await page.locator('.md-widget table tr').count();
  await page.keyboard.press('Enter');
  await page.waitForFunction(rows => document.querySelectorAll('.md-widget table tr').length === rows + 1, rowsBefore, { timeout: 8000 });
  const focusedCell = await page.evaluate(() => {
    const cell = document.activeElement?.closest?.('td, th');
    return cell ? { editable: !!cell.querySelector('.table-cell-editing .cm-content'), index: cell.cellIndex, last: cell.parentElement === cell.closest('table').rows[cell.closest('table').rows.length - 1] } : null;
  });
  assert.deepEqual(focusedCell, { editable: true, index: 0, last: true }, 'Enter 提交后应追加一行并进入新行第一格');
  await page.keyboard.press('Escape');
  await page.locator('[data-command="source"]').click();
  assert.deepEqual(await sourceLines(), ['| 甲 | 乙 |', '| --- | --- |', '| 9 | 2 |', '|  |  |', ''],
    '渲染单元格内 Tab / Enter 应写回真实源码');
  await page.locator('[data-command="source"]').click();
  console.log('STEP rendered cell Tab / Enter navigation and row append');
  // A table inside a blockquote is editable and keeps its container prefix.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n');
  await page.locator('.md-widget blockquote table th').first().waitFor();
  await page.locator('.md-widget blockquote table th').first().click();
  await page.waitForFunction(() => !!document.querySelector('.md-widget blockquote table th.table-cell-editing .cm-content'));
  assert.equal(await page.locator('.md-widget blockquote table th.table-cell-editing .cm-content').count(), 1, '引用内的表格也要能就地编辑');
  await page.keyboard.press('End');
  await page.keyboard.type('Q');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.locator('[data-command="source"]').click();
  assert.deepEqual(await sourceLines(), ['> | aQ | b |', '> | --- | --- |', '> | 1 | 2 |', ''],
    '引用内表格的改动只影响单元格文本，不破坏 "> " 前缀');
  await page.locator('[data-command="source"]').click();
  assert.match(await page.locator('.md-widget blockquote table').textContent(), /aQ/);
  console.log('STEP table inside a blockquote is editable');
  // ── Iteration 11: incremental block rendering ───────────────────────────
  // Typing may only re-render the block that changed. Everything else must keep
  // its DOM (so Mermaid, KaTeX and images are never re-created) and every click
  // that resolves through a widget must still hit the right source character
  // even though the block moved.
  const incrementalPath = path.join(root, 'incremental.md');
  const incrementalSource = [
    '# 增量渲染', '', '[TOC]', '',
    '图表上方的段落。', '',
    '```mermaid', 'flowchart LR', '  A[输入] --> B[输出]', '```', '',
    '## 重复标题', '', '图表下方的段落文字。', '',
    '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '',
    '- [ ] 下方任务', '',
    '引用脚注[^a] 与 [链接][ref]。', '',
    '## 重复标题', '',
    '[^a]: 脚注定义', '',
    '[ref]: https://example.com/ref', ''
  ].join('\n');
  await fs.writeFile(incrementalPath, incrementalSource);
  await openFile(incrementalPath);
  await ensureLive();
  await page.waitForFunction(() => document.querySelectorAll('#editor-host .mermaid svg').length === 1);
  // Make the block above the diagram active first, so the typing below happens
  // inside an editable block instead of the pristine reading view.
  await page.locator('#editor-host .md-widget p').filter({ hasText: '图表上方的段落' }).click();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget').length >= 4);
  // Everything is scoped to #editor-host: documents that are no longer active
  // keep their rendered DOM elsewhere in the page.
  const beforeTyping = await page.evaluate(() => {
    const host = document.querySelector('#editor-host');
    const widgets = [...host.querySelectorAll('.md-widget')];
    widgets.forEach(widget => { widget.dataset.keep = widget.dataset.from; });
    host.querySelector('.mermaid svg').dataset.keep = 'diagram';
    return {
      widgets: widgets.length,
      toc: [...host.querySelectorAll('.toc a')].map(link => link.getAttribute('href')),
      duplicate: !!host.querySelector('[id="重复标题-1"]'),
      footnote: host.querySelector('sup.footnote-ref a')?.getAttribute('title') || '',
      reference: host.querySelector('.md-widget a[href="https://example.com/ref"]')?.textContent || ''
    };
  });
  assert.deepEqual(beforeTyping.toc, ['#增量渲染', '#重复标题', '#重复标题-1'], `[TOC] 应列出全部标题：${JSON.stringify(beforeTyping.toc)}`);
  assert.equal(beforeTyping.duplicate, true, '重复标题应有编号锚点');
  assert.equal(beforeTyping.footnote, '脚注定义', '脚注引用应带上定义文本作为悬浮提示');
  assert.equal(beforeTyping.reference, '链接', '引用式链接应跨块解析');
  await page.keyboard.insertText('XYZ');
  await page.waitForTimeout(150);
  const afterTyping = await page.evaluate(() => {
    const host = document.querySelector('#editor-host');
    const widgets = [...host.querySelectorAll('.md-widget')];
    const svg = host.querySelector('.mermaid svg');
    return {
      svgKept: svg?.dataset.keep === 'diagram',
      diagrams: host.querySelectorAll('.mermaid svg').length,
      widgets: widgets.length,
      marked: widgets.filter(widget => widget.dataset.keep).length,
      unmarked: widgets.filter(widget => !widget.dataset.keep).map(widget => widget.textContent.slice(0, 12)),
      toc: [...host.querySelectorAll('.toc a')].map(link => link.getAttribute('href'))
    };
  });
  assert.equal(afterTyping.svgKept, true, '在上方段落输入不得重建 Mermaid SVG 节点');
  assert.equal(afterTyping.diagrams, 1);
  assert.equal(afterTyping.marked, afterTyping.widgets, `除被编辑的块外，其余 widget 必须复用 DOM：${JSON.stringify(afterTyping.unmarked)}`);
  assert.deepEqual(afterTyping.toc, beforeTyping.toc, '[TOC] 在输入后仍应列出同样的锚点');
  // A block that moved must still resolve clicks to the correct source column,
  // which is the whole trap of reusing widget DOM: its handlers captured the
  // old document positions.
  const paragraphPoint = offset => page.evaluate(at => {
    const paragraph = [...document.querySelectorAll('#editor-host .md-widget p')].find(node => (node.textContent || '').includes('图表下方的段落文字'));
    const text = [...paragraph.childNodes].find(node => node.nodeType === 3);
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2 };
  }, offset);
  const caretAfterTyping = await page.locator('#position').textContent();
  const paragraphClick = await paragraphPoint(6);
  await page.mouse.click(paragraphClick.x, paragraphClick.y);
  const clicked = await page.locator('#position').textContent();
  assert.match(caretAfterTyping, /^行 5，列 \d+$/, `输入后光标应停在第 5 行的段落里，实际 ${caretAfterTyping}`);
  assert.match(clicked, /^行 14，列 [78]$/, `点击图表下方段落第 7 个字符应落到第 14 行第 7 列，实际 ${clicked}`);
  // The same applies to a cell edit and a task toggle further down: both write
  // back through the (now shifted) positions of their block.
  await ensureLive();
  await page.locator('#editor-host .md-widget table td').first().click();
  await page.waitForFunction(() => !!document.querySelector('#editor-host .md-widget table td.table-cell-editing .cm-content'));
  assert.equal(await page.locator('#editor-host .md-widget table td.table-cell-editing .cm-content').count(), 1);
  await page.keyboard.insertText('9');
  // Tab commits the cell and enters the next one; Escape leaves that edit
  // untouched, so the task checkbox below is clicked from a clean state.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.locator('#editor-host .md-widget input[type="checkbox"]').first().click();
  await saveOpenFile();
  const incrementalSaved = await fs.readFile(incrementalPath, 'utf8');
  assert.match(incrementalSaved, /图表上方的段落。XYZ/, '输入必须落在上方段落');
  assert.match(incrementalSaved, /^\| 9 +\| 2 +\|$/m, `单元格写回位置必须正确：${incrementalSaved}`);
  assert.match(incrementalSaved, /- \[x\] 下方任务/, '任务勾选写回位置必须正确');
  assert.match(incrementalSaved, /^\| 甲 +\| 乙 +\|$/m, '写回不得破坏表头或其它行');
  assert.match(incrementalSaved, /引用脚注\[\^a\] 与 \[链接\]\[ref\]。/, '引用式链接与脚注源码不得被改写');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#editor-host .mermaid svg').length), 1);
  console.log('STEP incremental block rendering keeps widget DOM and click positions');
  // A Save As into a folder that already owns a different image with the same
  // name renames the copy; the editor must follow that rewrite, or the next save
  // silently points the document at the wrong image again.
  const logoFrom = path.join(root, 'logo-from'), logoTo = path.join(root, 'logo-to');
  await fs.mkdir(path.join(logoFrom, 'assets'), { recursive: true });
  await fs.mkdir(path.join(logoTo, 'assets'), { recursive: true });
  await fs.writeFile(path.join(logoFrom, 'assets', 'logo.png'), 'logo-from-a');
  await fs.writeFile(path.join(logoTo, 'assets', 'logo.png'), 'logo-from-b');
  const logoPath = path.join(logoFrom, 'doc.md');
  await fs.writeFile(logoPath, '图片引用：\n\n![图](assets/logo.png)\n');
  await openFile(logoPath);
  await ensureLive();
  // Make the document dirty so the Save As below really writes (and so a local
  // edit is proven to survive the reference rewrite).
  await page.locator('.md-widget p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('A');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  const logoTarget = path.join(logoTo, 'doc.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, logoTarget);
  await page.locator('[data-command="document-menu"]').click();
  await page.locator('[data-menu-command="save-as"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  assert.match(await fs.readFile(logoTarget, 'utf8'), /assets\/logo-1\.png/, '磁盘上的引用应改成不冲突的新名字');
  assert.match(await fs.readFile(logoTarget, 'utf8'), /图片引用：A/, '本地编辑不得因引用改写而丢失');
  assert.equal(await fs.readFile(path.join(logoTo, 'assets', 'logo.png'), 'utf8'), 'logo-from-b', '不得覆盖目标目录已有的同名图片');
  assert.equal(await fs.readFile(path.join(logoTo, 'assets', 'logo-1.png'), 'utf8'), 'logo-from-a');
  await page.locator('[data-command="source"]').click();
  assert.match(await sourceText(), /assets\/logo-1\.png/, '编辑器源码必须跟上引用改写');
  assert.ok(!(await sourceText()).includes('](assets/logo.png)'), '编辑器不得保留旧引用');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#save-status').textContent(), '已保存', '改写引用后文档不得变成未保存状态');
  // The next save must not put the stale reference back on disk.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('X');
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  const logoAfter = await fs.readFile(logoTarget, 'utf8');
  assert.match(logoAfter, /assets\/logo-1\.png/, '再次保存不得把图片引用改回去');
  assert.ok(!logoAfter.includes('](assets/logo.png)'), `再次保存后引用仍必须指向新名字：${logoAfter}`);
  assert.match(logoAfter, /X/);
  await page.locator('[data-command="source"]').click();
  console.log('STEP Save As keeps rewritten asset references in the editor');
  // ── Image references, document HTML, export residue ────────────────────
  // Real PNG bytes so a loaded <img> proves the asset protocol found the file.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAaklEQVR4nAXB0QAAAAhDwZGMJJJI+nwUkYwkou4kYVGixYgVESckY1OmzZg1MWekwkUVXUyxRYorpMZNNd1Ms02aa6TBQw09zLBDhhukxUstvcyyS5ZbpOBQocOEDQkXpMNHHX3MsUeOOx6wLFSBm6x5zwAAAABJRU5ErkJggg==', 'base64');
  const exists = file => fs.access(file).then(() => true, () => false);
  const imagesRoot = path.join(root, 'images');
  const imageDoc = path.join(imagesRoot, 'docs', 'images.md');
  await fs.mkdir(path.join(imagesRoot, 'docs', 'assets'), { recursive: true });
  await fs.mkdir(path.join(imagesRoot, 'shared'), { recursive: true });
  await fs.writeFile(path.join(imagesRoot, 'docs', 'assets', '图片.png'), png);
  await fs.writeFile(path.join(imagesRoot, 'docs', 'assets', 'my pic.png'), png);
  await fs.writeFile(path.join(imagesRoot, 'shared', '上级.png'), png);
  await fs.writeFile(path.join(imagesRoot, 'absolute.png'), png);
  // A real local server proves `http:` images are displayed and kept verbatim.
  const imageServer = http.createServer((request, response) => {
    if (request.url === '/a.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); return; }
    response.writeHead(404).end();
  });
  await new Promise(resolve => imageServer.listen(0, '127.0.0.1', resolve));
  imageServer.unref();
  const imagePort = imageServer.address().port;
  // Several windows exist by now, so test commands are addressed to the window
  // this test drives instead of relying on window order or focus.
  await page.evaluate(() => { window.__inkstoneTestMarker = 'target'; });
  const sendTestCommand = name => app.evaluate(async ({ BrowserWindow }, commandName) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const mine = await window.webContents.executeJavaScript('window.__inkstoneTestMarker === "target"').catch(() => false);
      if (mine) { window.webContents.send('inkstone:command', commandName); return true; }
    }
    return false;
  }, name);
  try {
    const absoluteImage = path.join(imagesRoot, 'absolute.png').split(path.sep).join('/');
    await fs.writeFile(imageDoc, [
      '# 图片引用', '',
      '![](assets/图片.png)', '',
      '![](assets/my%20pic.png)', '',
      '![](<assets/my pic.png>)', '',
      '![](../shared/上级.png)', '',
      `![](<${absoluteImage}>)`, '',
      `![](http://127.0.0.1:${imagePort}/a.png)`, '',
      // Network references: no host is ever contacted, so no src is generated.
      '![](file://192.0.2.1/share/a.png)', '',
      '![](//192.0.2.1/share/a.png)', ''
    ].join('\n'));
    await openFile(imageDoc);
    await ensureLive();
    await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget img').length === 8);
    const imageState = await page.evaluate(async () => {
      const nodes = [...document.querySelectorAll('#editor-host .md-widget img')];
      await Promise.all(nodes.map(node => new Promise(resolve => {
        node.loading = 'eager';
        if (node.complete) return resolve();
        node.addEventListener('load', () => resolve(), { once: true });
        node.addEventListener('error', () => resolve(), { once: true });
        setTimeout(resolve, 8000);
      })));
      return nodes.map(node => ({ src: node.getAttribute('src') || '', naturalWidth: node.naturalWidth, mdSrc: node.dataset.mdSrc || '' }));
    });
    assert.equal(imageState.length, 8);
    imageState.slice(0, 6).forEach((image, index) => assert.ok(image.naturalWidth > 0, `第 ${index + 1} 张图片必须加载成功：${JSON.stringify(image)}`));
    assert.match(imageState[5].src, new RegExp(`^http://127\\.0\\.0\\.1:${imagePort}/a\\.png$`), 'http 图片应保留原 URL');
    for (const image of imageState.slice(0, 5)) assert.match(image.src, /^inkstone-asset:\/\//, '本地图片必须走资产协议');
    // UNC and host-ful file URLs are dropped in the renderer: no asset URL is
    // built, so opening the document cannot make Windows contact that host.
    for (const image of imageState.slice(6)) {
      assert.equal(image.src, '', `网络引用不得生成 src：${JSON.stringify(image)}`);
      assert.equal(image.naturalWidth, 0);
    }
    assert.equal(decodeURIComponent(imageState[0].mdSrc), 'assets/图片.png', 'data-md-src 必须保留 Markdown 中的写法');
    const imageHtmlPath = path.join(root, 'images.html');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, imageHtmlPath);
    await page.locator('[data-command="export"]').click();
    await page.locator('[data-export="html"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
    const imageHtml = await fs.readFile(imageHtmlPath, 'utf8');
    assert.equal((imageHtml.match(/data:image\/png;base64,/g) || []).length, 5, '导出应内联五张本地图片');
    assert.ok(!imageHtml.includes('inkstone-asset://'), '导出不得残留应用内部图片协议');
    assert.ok(imageHtml.includes(`http://127.0.0.1:${imagePort}/a.png`), 'http 图片在导出中保持原 URL');
    console.log('STEP image paths (encoded, angle-bracket, ../, absolute, http) render and export inlines local ones');
    // ── typora-root-url: a local image root ──────────────────────────────
    // `/…` is resolved against the document's front matter root, while a plain
    // relative reference keeps its old meaning. Traversal and a symlink that
    // leaves the configured folder are refused by the shared resolver; Save As
    // rewrites a relative root so the copy keeps showing the same picture.
    const rootedRoot = path.join(root, 'image-root');
    const rootedDocs = path.join(rootedRoot, 'docs');
    const rootedAssets = path.join(rootedDocs, '图片 root');
    const rootedOutput = path.join(rootedRoot, 'elsewhere', 'nested');
    const rootedReplacement = path.join(rootedOutput, 'replacement root');
    await fs.mkdir(rootedAssets, { recursive: true });
    await fs.mkdir(rootedReplacement, { recursive: true });
    const rootedSvg = width => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="12"><rect width="100%" height="100%" fill="#4183c4"/></svg>`;
    await fs.writeFile(path.join(rootedAssets, '图片 one.svg'), rootedSvg(37));
    await fs.writeFile(path.join(rootedDocs, '图片 one.svg'), rootedSvg(19));
    await fs.writeFile(path.join(rootedDocs, 'outside.svg'), rootedSvg(61));
    await fs.writeFile(path.join(rootedReplacement, '图片 one.svg'), rootedSvg(43));
    await fs.symlink(path.join(rootedDocs, 'outside.svg'), path.join(rootedAssets, 'symlink.svg'));
    const rootedSource = path.join(rootedDocs, 'source.md');
    await fs.writeFile(rootedSource, [
      '---', 'typora-root-url: "图片 root"', '---', '', '# 本地图片', '',
      '![根目录](/%E5%9B%BE%E7%89%87%20one.svg)', '',
      '![相对路径](<图片 one.svg>)', '', '![越界](/%2e%2e/outside.svg)', '', '![符号链接](/symlink.svg)', ''
    ].join('\r\n'));
    const rootedWidth = (alt, width) => page.waitForFunction(([name, expected]) =>
      [...document.querySelectorAll('#editor-host .md-widget img')].some(image => image.alt === name && image.complete && image.naturalWidth === expected), [alt, width]);
    await openFile(rootedSource);
    await ensureLive();
    await rootedWidth('根目录', 37);
    await rootedWidth('相对路径', 19);
    await rootedWidth('越界', 0);
    await rootedWidth('符号链接', 0);
    // The copy action goes through the same resolver and the same root hint as
    // the preview: it must name the file under the configured folder.
    await app.evaluate(async ({ clipboard }) => clipboard.clear());
    await page.evaluate(() => {
      const image = [...document.querySelectorAll('#editor-host .md-widget img')].find(node => node.alt === '根目录');
      image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 260, clientY: 260, button: 2 }));
    });
    await page.locator('#context-menu').waitFor({ state: 'visible' });
    await page.locator('[data-image-action="copy-path"]').click();
    const rootedAssetReal = await fs.realpath(path.join(rootedAssets, '图片 one.svg'));
    await pollClipboard('text', new RegExp(rootedAssetReal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    const rootedCopy = path.join(rootedOutput, 'copy.md');
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, rootedCopy);
    await page.locator('[data-command="document-menu"]').click();
    await page.locator('[data-menu-command="save-as"]').click();
    await page.waitForFunction(() => document.querySelector('#location').textContent.includes('copy.md'));
    await rootedWidth('根目录', 37);
    const rootedSaved = await fs.readFile(rootedCopy, 'utf8');
    assert.match(rootedSaved, /typora-root-url: "\.\.\/\.\.\/docs\/图片 root"/, `另存为应重写相对图根：${rootedSaved}`);
    assert.equal(onlyCrlf(rootedSaved), true, '图根重写不得改动换行');
    // A later save must not put the pre-Save-As root back on disk: the editor
    // buffer, the store and the new file all carry the rewritten line.
    await page.waitForTimeout(300);
    await page.locator('[data-command="save"]').click();
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
    const rootedResaved = await fs.readFile(rootedCopy, 'utf8');
    assert.match(rootedResaved, /typora-root-url: "\.\.\/\.\.\/docs\/图片 root"/, '再次保存不得写回旧图根');
    assert.equal(rootedResaved.includes('typora-root-url: "图片 root"'), false);
    const rootedHtmlPath = path.join(rootedOutput, 'copy.html');
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, rootedHtmlPath);
    await page.locator('[data-command="export"]').click();
    await page.locator('[data-export="html"]').click();
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await fs.access(rootedHtmlPath); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const rootedHtml = await fs.readFile(rootedHtmlPath, 'utf8');
    const rootedInline = await page.evaluate(source => {
      const parsed = new DOMParser().parseFromString(source, 'text/html');
      return [...parsed.querySelectorAll('article img')].find(node => node.alt === '根目录')?.getAttribute('src') || '';
    }, rootedHtml);
    assert.match(rootedInline, /^data:image\/svg\+xml;base64,/);
    assert.equal(Buffer.from(rootedInline.split(',')[1], 'base64').toString(), rootedSvg(37), 'HTML 导出必须内联图根下的原图');
    // Editing the front matter refreshes the preview: the asset URL carries the
    // new root, which also prevents a stale decoded image from the cache.
    const selectAllInEditor = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
    await page.locator('[data-command="source"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press(selectAllInEditor);
    await page.keyboard.insertText(rootedSaved.replace(/^typora-root-url:.*$/m, 'typora-root-url: "replacement root"'));
    await page.locator('[data-command="source"]').click();
    await rootedWidth('根目录', 43);
    // A network root is refused before the first filesystem call: no image.
    await page.locator('[data-command="source"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press(selectAllInEditor);
    await page.keyboard.insertText(rootedSaved.replace(/^typora-root-url:.*$/m, 'typora-root-url: "file://192.0.2.1/share"'));
    await page.locator('[data-command="source"]').click();
    await rootedWidth('根目录', 0);
    console.log('STEP typora-root-url image root: /-prefix, traversal/symlink refusal, Save As relocation, offline HTML, root refresh');
    // Document HTML must never reach the application's own click delegation.
    const injectedSource = [
      '# 注入检查', '',
      '<span data-command="toggle-ui">注入命令</span>', '',
      '<span data-menu-command="trash">菜单命令</span>', '',
      '<span data-path="C:/secret.md">路径委托</span>', '',
      '<span data-copy-code>伪复制</span>', '',
      // Attribute names are case-insensitive, and SVG / MathML attributes go
      // through the same FORBID_ATTR lookup as HTML ones.
      '<span DATA-COMMAND="upper" Data-Path="mixed">大写委托</span>', '',
      '<svg width="12" height="12" data-command="svg"><circle DATA-EXPORT="x" r="5"/></svg>', '',
      '<math data-menu-command="math"><mi data-section="1">m</mi></math>', '',
      '```js', 'const injected = 1;', '```', ''
    ].join('\n');
    await page.locator('.topbar [data-command="new"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(injectedSource);
    await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget .code-copy').length === 1);
    assert.equal(await page.locator('#editor-host .md-widget [data-command]').count(), 0, '文档内容不得保留 data-command');
    assert.equal(await page.locator('#editor-host .md-widget [data-menu-command]').count(), 0, '文档内容不得保留 data-menu-command');
    assert.equal(await page.locator('#editor-host .md-widget [data-path]').count(), 0, '文档内容不得保留 data-path');
    assert.equal(await page.locator('#editor-host .md-widget [data-copy-code]:not(.code-copy)').count(), 0, '文档内容不得伪造复制按钮');
    assert.equal(await page.locator('#editor-host .md-widget .code-copy').count(), 1, '代码块复制按钮仍由应用插入');
    // The SVG / MathML nodes must really be in the document for the check below
    // to mean anything, and no delegated attribute may survive on any of them.
    assert.ok(await page.locator('#editor-host .md-widget svg').count() >= 1, '文档中的 SVG 应保留');
    assert.ok(await page.locator('#editor-host .md-widget math').count() >= 1, '文档中的 MathML 应保留');
    assert.equal(await page.evaluate(() => {
      const reserved = /^(data-(?:command|menu-command|quick-command|quick-path|path|table-op|index|cell|align|copy-code|image-action|external-action|dismiss|history|history-dir|history-name|export|side|close|document|section|emoji|md-skip|md-src|from|to|inkstone-index))$/i;
      // Descendants only: the widget root carries the editor's own data-from/data-to.
      return [...document.querySelectorAll('#editor-host .md-widget *')]
        // The copy button is the application's own control, inserted after sanitising.
        .filter(node => !(node.classList?.contains('code-copy')))
        .some(node => [...(node.attributes || [])].some(attribute => reserved.test(attribute.name)));
    }), false, '大小写变体与 SVG/MathML 上的保留属性同样必须被剥离');
    const uiBefore = await page.evaluate(() => ({ ui: document.documentElement.dataset.ui, open: document.querySelector('#dialog').open, tabs: document.querySelectorAll('.document-tab').length }));
    await page.locator('#editor-host .md-widget span').filter({ hasText: '注入命令' }).click();
    await page.waitForTimeout(350);
    const uiAfter = await page.evaluate(() => ({ ui: document.documentElement.dataset.ui, open: document.querySelector('#dialog').open, tabs: document.querySelectorAll('.document-tab').length }));
    assert.deepEqual(uiAfter, uiBefore, '点击文档内伪造的 data-* 委托不得驱动应用');
    // The real copy button still works (the system clipboard is not available
    // in this environment, so the button's own confirmation is the evidence).
    await page.locator('#editor-host .md-widget .code-copy').click();
    await page.waitForFunction(() => document.querySelector('#editor-host .md-widget .code-copy')?.textContent === '已复制');
    console.log('STEP document-injected data-* attributes are inert, the real copy button still copies');
    // Exports and the clipboard payload must not carry editor-only chrome.
    const cleanSource = '# 导出检查\n\n```js\nconst exportedMarker = 42;\n```\n';
    await page.locator('.topbar [data-command="new"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(cleanSource);
    await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget .code-copy').length === 1);
    const cleanHtmlPath = path.join(root, 'clean.html');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, cleanHtmlPath);
    await page.locator('[data-command="export"]').click();
    await page.locator('[data-export="html"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
    const cleanHtml = await fs.readFile(cleanHtmlPath, 'utf8');
    assert.ok(!cleanHtml.includes('code-copy'), '导出 HTML 不得包含复制按钮或其样式');
    assert.ok(!cleanHtml.includes('data-copy-code'), '导出 HTML 不得包含复制按钮属性');
    assert.ok(!cleanHtml.includes('复制'), '导出 HTML 不得包含复制按钮文字');
    assert.match(cleanHtml, /exportedMarker/, '导出仍必须包含正文');
    // PDF prints the same DOM, so the print container is checked before printing
    // (PDF text itself cannot be asserted without a PDF text extractor).
    assert.equal(await page.locator('#print-document .code-copy').count(), 0, '打印用 DOM 不得包含复制按钮');
    assert.ok(!(await page.locator('#print-document').textContent()).includes('复制'), '打印用 DOM 不得包含复制按钮文字');
    // Intercept the clipboard write itself: the payload must be chrome-free.
    await app.evaluate(({ clipboard }) => {
      globalThis.__clipboardWrites = [];
      const original = clipboard.write.bind(clipboard);
      clipboard.write = async items => {
        try {
          for (const item of items) {
            if (!item.types?.includes('text/html')) continue;
            const value = await item.getType('text/html');
            globalThis.__clipboardWrites.push(String(typeof value === 'string' ? value : await value.text()));
          }
        } catch { /* recording only */ }
        return original(items);
      };
    });
    await page.locator('.cm-content').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await sendTestCommand('copy-html');
    let copiedHtml = null;
    for (let attempt = 0; attempt < 40 && !copiedHtml; attempt++) {
      copiedHtml = (await app.evaluate(() => globalThis.__clipboardWrites || [])).find(html => typeof html === 'string' && html.includes('exportedMarker')) || null;
      if (!copiedHtml) await page.waitForTimeout(100);
    }
    assert.ok(copiedHtml, '复制为 HTML 必须经过被拦截的剪贴板写入');
    assert.ok(!copiedHtml.includes('code-copy'), '复制为 HTML 不得包含复制按钮');
    assert.ok(!copiedHtml.includes('复制'), '复制为 HTML 不得包含复制按钮文字');
    console.log('STEP exported HTML and copy-as-HTML carry no copy button');
  } finally {
    imageServer.close();
  }
  // ── An unsaved document keeps pasted images in the app temp folder ─────
  const pastedSource = path.join(root, '图片 示例.png');
  await fs.writeFile(pastedSource, png);
  const activeDocumentId = () => page.evaluate(() => [...document.querySelectorAll('[data-document]')].find(node => node.getAttribute('aria-selected') === 'true')?.dataset.document);
  const insertFromDialog = async filePath => {
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, filePath);
    // The real IPC, driven directly: the dialog stub names the picture (Chinese
    // plus a space), and the returned reference is inserted as the editor would.
    const inserted = await page.evaluate(id => window.desktop.insertImage(id), await activeDocumentId());
    assert.ok(inserted.ok, `插入图片失败：${JSON.stringify(inserted)}`);
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(`![图片](${inserted.value})\n`);
    await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget img').length === 1);
    return inserted.value;
  };
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const unsavedId = await activeDocumentId();
  assert.ok(unsavedId);
  await insertFromDialog(pastedSource);
  const tempImage = await page.evaluate(async () => {
    const node = document.querySelector('#editor-host .md-widget img');
    await new Promise(resolve => {
      node.loading = 'eager';
      if (node.complete) return resolve();
      node.addEventListener('load', () => resolve(), { once: true });
      node.addEventListener('error', () => resolve(), { once: true });
      setTimeout(resolve, 8000);
    });
    return { naturalWidth: node.naturalWidth, src: node.getAttribute('src') || '', mdSrc: node.dataset.mdSrc || '' };
  });
  assert.ok(tempImage.naturalWidth > 0, `未保存文档粘贴的图片必须立即显示：${JSON.stringify(tempImage)}`);
  const insertedName = decodeURIComponent(tempImage.mdSrc.split('/').pop());
  assert.match(insertedName, /^图片-示例-[0-9a-f]{8}\.png$/, `中文与空格的图片名应保留：${insertedName}`);
  const tempDirectory = path.join(root, 'profile', 'unsaved-assets', unsavedId);
  assert.equal(await exists(path.join(tempDirectory, 'assets', insertedName)), true, '未保存文档的图片应写入按文档 id 划分的临时目录');
  const unsavedTarget = path.join(root, 'unsaved-save', '未保存文档.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, unsavedTarget);
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  assert.ok((await fs.readFile(unsavedTarget, 'utf8')).includes(`assets/${insertedName}`), '保存后的文档必须引用迁移过去的图片');
  assert.deepEqual(await fs.readdir(path.join(root, 'unsaved-save', 'assets')), [insertedName], '临时图片应迁移到文档旁的 assets');
  assert.ok((await fs.readFile(path.join(root, 'unsaved-save', 'assets', insertedName))).equals(png), '迁移的字节必须一致');
  assert.equal(await exists(tempDirectory), false, '首次保存后应清理临时目录');
  assert.ok((await page.locator('#location').textContent()).includes('未保存文档.md'), '另存为后文档应脱离未保存状态');
  await page.waitForFunction(() => document.querySelector('#editor-host .md-widget img')?.naturalWidth > 0);
  console.log('STEP unsaved document inserts an image, shows it, and migrates it on Save As');
  // Closing a never-saved document with "保存" migrates its images first.
  await fs.mkdir(path.join(root, 'close-save'), { recursive: true });
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const closeSaveId = await activeDocumentId();
  const closeSaveRef = await insertFromDialog(pastedSource);
  const closeSaveName = decodeURIComponent(closeSaveRef.split('/').pop());
  const closeTarget = path.join(root, 'close-save', 'closing.md');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, closeTarget);
  await sendTestCommand('close');
  await page.waitForFunction(id => ![...document.querySelectorAll('[data-document]')].some(node => node.dataset.document === id), closeSaveId, { timeout: 10000 });
  assert.ok((await fs.readFile(closeTarget, 'utf8')).includes(closeSaveRef), '关闭时保存必须写出图片引用');
  assert.ok(await exists(path.join(root, 'close-save', 'assets', closeSaveName)), '关闭时保存也必须迁移临时图片');
  assert.equal(await exists(path.join(root, 'profile', 'unsaved-assets', closeSaveId)), false, '迁移后应清理临时目录');
  console.log('STEP closing an unsaved document with Save migrates its images');
  // Closing a never-saved document discards its temporary images.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const discardId = await activeDocumentId();
  await insertFromDialog(pastedSource);
  const discardDirectory = path.join(root, 'profile', 'unsaved-assets', discardId);
  assert.equal(await exists(discardDirectory), true);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  await sendTestCommand('close');
  await page.waitForFunction(id => ![...document.querySelectorAll('[data-document]')].some(node => node.dataset.document === id), discardId, { timeout: 10000 });
  await page.waitForTimeout(400);
  assert.equal(await exists(discardDirectory), false, '关闭未保存的文档应清理临时图片目录');
  console.log('STEP closing an unsaved document cleans its temporary images');
  // A narrow desktop window must not overflow horizontally or hide the editor.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 80, width: 760, height: 620 }));
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#editor-host').isVisible(), '窄屏下编辑区仍可见');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2), false, '窄屏不应产生横向溢出');
  console.log('STEP narrow desktop viewport');
  // ── Document lifecycle safety and robustness ───────────────────────────
  // 1) Reloading a dirty document after an external edit must leave a copy of
  //    the local text that nothing prunes automatically.
  const reloadPath = path.join(root, 'reload-discard.md');
  await fs.writeFile(reloadPath, 'disk version one\n');
  await openFile(reloadPath);
  await page.locator('.md-widget p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('LOCALEDIT', { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  await page.waitForTimeout(700);
  await fs.writeFile(reloadPath, 'disk version two\n');
  await page.locator('#dialog').getByText('文件已在编辑器外修改').waitFor({ timeout: 15000 });
  assert.match(await page.locator('#dialog .dialog-description').textContent(), /恢复副本/, '对话框必须如实说明本地内容会被保留');
  await page.locator('[data-external-action="reload"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('disk version two'));
  await page.waitForFunction(() => document.querySelector('#notification').textContent.includes('另存为'));
  const reloadNotice = await page.locator('#notification').textContent();
  const discardedDirectory = path.join(root, 'profile', 'recovery', 'discarded');
  const discardedNames = (await fs.readdir(discardedDirectory)).filter(name => name.endsWith('-reload-discard.md'));
  assert.equal(discardedNames.length, 1, `重新加载应留下一个恢复副本，实际 ${discardedNames.length}`);
  const discardedFile = path.join(discardedDirectory, discardedNames[0]);
  assert.match(await fs.readFile(discardedFile, 'utf8'), /LOCALEDIT/, '副本必须是本地版本');
  assert.match(await fs.readFile(discardedFile, 'utf8'), /disk version one/);
  assert.ok(reloadNotice.includes(discardedFile), `界面必须告知副本位置，实际：${reloadNotice}`);
  console.log('STEP reload keeps a discarded copy of dirty local text');
  // 2) "Keep local text" must unblock the next save, and the disk version that
  //    gets overwritten has to stay in the save history.
  const keepPath = path.join(root, 'keep-local.md');
  await fs.writeFile(keepPath, 'base line\n');
  await openFile(keepPath);
  await page.locator('.md-widget p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('KEEP', { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  await page.waitForTimeout(700);
  await fs.writeFile(keepPath, 'external wins\n');
  await page.locator('#dialog').getByText('文件已在编辑器外修改').waitFor({ timeout: 15000 });
  await page.locator('[data-external-action="keep-local"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  await saveOpenFile();
  assert.match(await fs.readFile(keepPath, 'utf8'), /KEEP/, '保留本地内容后保存必须写入本地版本');
  assert.doesNotMatch(await fs.readFile(keepPath, 'utf8'), /external wins/);
  await page.locator('[data-command="document-menu"]').click();
  await page.locator('[data-menu-command="history"]').click();
  await page.locator('.history-item').first().waitFor();
  const historyCount = await page.locator('.history-item').count();
  let keptDiskVersion = false;
  for (let index = 0; index < historyCount; index++) {
    await page.locator('.history-item').nth(index).click();
    if ((await page.locator('#history-preview').textContent()).includes('external wins')) { keptDiskVersion = true; break; }
  }
  assert.ok(keptDiskVersion, '被覆盖的磁盘版本必须能在保存历史中恢复');
  await page.locator('#dialog [data-dismiss]').first().click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  console.log('STEP keep-local unblocks saving and backs up the overwritten disk version');
  // 3) Two documents edited externally at the same time must produce two
  //    prompts, not one prompt plus silence.
  const queueA = path.join(root, 'queue-a.md'), queueB = path.join(root, 'queue-b.md');
  await fs.writeFile(queueA, 'A base\n'); await fs.writeFile(queueB, 'B base\n');
  for (const [file, text] of [[queueA, 'AAA'], [queueB, 'BBB']]) {
    await openFile(file);
    await page.locator('.md-widget p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(text, { delay: 20 });
    await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
    await page.waitForTimeout(650);
  }
  await fs.writeFile(queueA, 'A external\n');
  await fs.writeFile(queueB, 'B external\n');
  await page.locator('#dialog').getByText('文件已在编辑器外修改').waitFor({ timeout: 15000 });
  const firstPrompt = await page.locator('#dialog .dialog-description').textContent();
  // The two prompts may arrive in either order; the second must name the other file.
  const firstName = firstPrompt.includes('queue-a.md') ? 'queue-a.md' : 'queue-b.md';
  const secondName = firstName === 'queue-a.md' ? 'queue-b.md' : 'queue-a.md';
  await page.locator('[data-external-action="keep-local"]').click();
  // The second prompt must appear without any further external change.
  await page.waitForFunction(name => {
    const dialog = document.querySelector('#dialog');
    return !!dialog.open && (dialog.querySelector('.dialog-description')?.textContent || '').includes(name);
  }, secondName, { timeout: 10000 });
  const secondPrompt = await page.locator('#dialog .dialog-description').textContent();
  assert.notEqual(firstPrompt, secondPrompt, '两个文件的提示必须是两次独立的提示');
  assert.match(firstPrompt, new RegExp(firstName.replace('.', '\\.')));
  assert.match(secondPrompt, new RegExp(secondName.replace('.', '\\.')));
  await page.locator('[data-external-action="keep-local"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  console.log('STEP simultaneous external changes queue two prompts');
  // A queued prompt must wait for an unrelated dialog instead of replacing it.
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences').waitFor();
  await fs.writeFile(queueA, 'A external again\n');
  await page.waitForTimeout(4200);
  assert.match(await page.locator('#dialog-title').textContent(), /偏好设置/, '外部变更不得覆盖已打开的对话框');
  await page.locator('#dialog [data-dismiss]').click();
  await page.locator('#dialog').getByText('文件已在编辑器外修改').waitFor({ timeout: 10000 });
  await page.locator('[data-external-action="keep-local"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  console.log('STEP external prompt waits for an open dialog');
  // 4) A clean document follows the disk silently, with only a light notice.
  const cleanPath = path.join(root, 'clean-reload.md');
  await fs.writeFile(cleanPath, 'clean one\n');
  await openFile(cleanPath);
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('clean one'));
  await fs.writeFile(cleanPath, 'clean two\n');
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('clean two'), null, { timeout: 15000 });
  assert.equal(await page.locator('#dialog').isVisible(), false, '未修改的文档不应弹出对话框');
  assert.match(await page.locator('#notification').textContent(), /自动重新加载/, '静默重载也要给一条轻提示');
  console.log('STEP clean document reloads external changes automatically');
  // 5) A deleted file is reported after two polls, then can be saved elsewhere
  //    or kept as an unsaved document.
  const gonePath = path.join(root, 'gone.md');
  await fs.writeFile(gonePath, 'still here\n');
  await openFile(gonePath);
  await page.locator('.md-widget p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('LOCAL', { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  await page.waitForTimeout(650);
  await fs.unlink(gonePath);
  await page.locator('#dialog').getByText('文件已被删除').waitFor({ timeout: 20000 });
  const rescuedPath = path.join(root, 'gone-rescued.md');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, rescuedPath);
  await page.locator('[data-external-action="save-as"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存', null, { timeout: 15000 });
  assert.match(await fs.readFile(rescuedPath, 'utf8'), /LOCAL/, '删除提示中的另存为必须写出本地内容');
  const orphanPath = path.join(root, 'orphan.md');
  await fs.writeFile(orphanPath, 'orphan base\n');
  await openFile(orphanPath);
  await page.locator('.md-widget p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('ORPHAN', { delay: 20 });
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  await page.waitForTimeout(650);
  await fs.unlink(orphanPath);
  await page.locator('#dialog').getByText('文件已被删除').waitFor({ timeout: 20000 });
  await page.locator('[data-external-action="detach"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('orphan.md'));
  assert.equal(await page.locator('#save-status').textContent(), '有未保存的更改', '保留下来的文档应仍是未保存状态');
  console.log('STEP external deletion prompts, then Save As / keep as unsaved');
  // 6) Reopening closed files restores exactly one document per command.
  const reopenA = path.join(root, 'reopen-a.md'), reopenB = path.join(root, 'reopen-b.md');
  await fs.writeFile(reopenA, '# A\n'); await fs.writeFile(reopenB, '# B\n');
  const closeActive = async name => {
    await page.locator('.document-tab.active .close-tab').click();
    await page.waitForFunction(target => !document.querySelector('#location').textContent.includes(target), name);
  };
  await openFile(reopenA);
  await openFile(reopenB);
  await closeActive('reopen-b.md');
  await closeActive('reopen-a.md');
  const tabsBefore = await page.locator('.document-tab').count();
  await broadcast('reopen-closed');
  await page.waitForFunction(count => document.querySelectorAll('.document-tab').length === count + 1, tabsBefore, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('reopen-a.md'));
  assert.equal(await page.locator('.document-tab').count(), tabsBefore + 1, '一次只应重开最近关闭的一个文件');
  const tabText = await page.locator('#document-tabs').textContent();
  assert.ok(tabText.includes('reopen-a.md') && !tabText.includes('reopen-b.md'), `只应重开最近关闭的文件，实际标签：${tabText}`);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.document-tab').count(), tabsBefore + 1, '不应连续重开其余已关闭文件');
  console.log('STEP reopen closed restores only the most recent document');
  // ── Document actions, open documents and the Chinese interface ──────────
  // The tab strip is hidden in the default appearance, so every document action
  // must also be reachable from the native 文件 menu and the command palette.
  const actionFile = path.join(root, 'action-source.md');
  await fs.writeFile(actionFile, '# 操作测试\n');
  await openFile(actionFile);
  await page.locator('.md-widget h1').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText(' 一');
  await saveOpenFile();
  await page.keyboard.insertText(' 二');
  await saveOpenFile();
  const trashLabel = process.platform === 'darwin' ? '废纸篓' : '回收站';
  const menuModel = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const accelerators = [];
    const walk = items => items.forEach(item => { if (item.accelerator) accelerators.push(item.accelerator); if (item.submenu) walk(item.submenu.items); });
    walk(menu.items);
    return {
      groups: Object.fromEntries(menu.items.map(item => [item.label, (item.submenu?.items || []).map(entry => entry.label)])),
      accelerators
    };
  });
  for (const label of ['另存为…', '重命名 / 移动…', '在文件夹中显示', '查看保存历史…']) {
    assert.ok(menuModel.groups['文件'].includes(label), `文件菜单应包含“${label}”`);
  }
  assert.ok(menuModel.groups['文件'].includes(`移到${trashLabel}`), `文件菜单应包含“移到${trashLabel}”`);
  assert.ok(menuModel.groups['段落'].includes('插入图表'), '段落菜单应包含“插入图表”');
  for (const label of ['下一个文档', '上一个文档']) assert.ok(menuModel.groups['窗口'].includes(label), `窗口菜单应包含“${label}”`);
  for (const label of ['剪切', '复制', '粘贴', '全选']) assert.ok(menuModel.groups['编辑'].includes(label), `编辑菜单角色项应为中文：“${label}”`);
  for (const label of ['最小化', '全屏']) {
    const everywhere = Object.values(menuModel.groups).flat();
    assert.ok(everywhere.includes(label), `菜单角色项应为中文：“${label}”`);
  }
  assert.deepEqual(menuModel.accelerators.filter((value, index, all) => all.indexOf(value) !== index), [], '菜单快捷键不得重复');
  // Palette labels must read exactly like the menu entries.
  const openPalette = async () => {
    await broadcast('quick-open');
    await page.locator('#quick-filter').waitFor();
  };
  const paletteLabels = async query => {
    await page.locator('#quick-filter').fill(query);
    return page.evaluate(() => [...document.querySelectorAll('#quick-results [data-quick-command] strong')].map(node => node.textContent));
  };
  // `suffix` is the visible marker that the command actually ran: some commands
  // replace the palette with their own dialog, others just act on the document.
  const paletteCommand = async (query, label) => {
    await openPalette();
    await paletteLabels(query);
    await page.locator('#quick-results [data-quick-command]').filter({ hasText: label }).first().click();
    await page.waitForTimeout(250);
  };
  await openPalette();
  const fileCommands = await paletteLabels('');
  for (const label of ['另存为…', '重命名 / 移动…', '在文件夹中显示', '查看保存历史…']) {
    assert.ok(fileCommands.includes(label), `命令面板条目应与菜单一致：“${label}”`);
  }
  assert.ok(fileCommands.includes(`移到${trashLabel}`), `命令面板应包含“移到${trashLabel}”`);
  assert.ok((await paletteLabels('图表')).includes('插入图表'), '命令面板应能插入图表');
  await page.locator('#dialog [data-dismiss]').click();
  // Version history shows the document name and time, never a UUID or hash.
  await paletteCommand('保存历史', '查看保存历史…');
  await page.locator('.history-item').first().waitFor();
  const historyLabels = await page.locator('.history-item strong').allTextContents();
  assert.ok(historyLabels.length >= 2, `应至少有两条历史版本，实际 ${historyLabels.length}`);
  for (const label of historyLabels) {
    assert.ok(!/\d{10,16}-[0-9a-f]{8}-/i.test(label), `历史列表不得显示 UUID 文件名：${label}`);
    assert.ok(!/[0-9a-f]{16}\b/i.test(label), `历史列表不得显示哈希目录名：${label}`);
    assert.match(label, /\.md · /, `历史条目应显示“文档名 · 时间”：${label}`);
    assert.match(label, /\d{4}/, `历史条目应带时间：${label}`);
  }
  assert.equal(await page.locator('.history-item span').first().textContent(), '当前文件', '历史条目应说明版本来源而不是哈希目录');
  await page.locator('#dialog [data-dismiss]').first().click();
  // Reveal from the native menu, with the shell call stubbed. A native menu
  // command is routed by the main process to the focused window. A window this
  // script drives never receives OS focus here (CI shells, and this suite keeps
  // a second window open), so the test substitutes the focus lookup for exactly
  // the synchronous interval of the menu click instead of trying to focus the OS
  // window. The real menu item still runs, the main process still dispatches the
  // command, the renderer still handles it and the shell stub still asserts the
  // path; the original static method is restored in `finally`.
  await app.evaluate(({ shell }) => {
    globalThis.__revealed = [];
    globalThis.__originalReveal = shell.showItemInFolder;
    shell.showItemInFolder = item => { globalThis.__revealed.push(item); };
  });
  const drivenWindow = await app.browserWindow(page);
  const drivenWindowId = await drivenWindow.evaluate(win => win.webContents.id);
  const clickNativeMenu = async (label, startsWith = false) => {
    await app.evaluate(({ Menu, BrowserWindow }, { id, text, prefix }) => {
      const target = BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win.webContents.id === id);
      if (!target) throw new Error(`被测试窗口 ${id} 不存在`);
      const original = Object.getOwnPropertyDescriptor(BrowserWindow, 'getFocusedWindow');
      BrowserWindow.getFocusedWindow = () => target;
      try {
        const file = Menu.getApplicationMenu().items.find(item => item.label === '文件');
        const entry = file.submenu.items.find(item => prefix ? item.label.startsWith(text) : item.label === text);
        if (!entry) throw new Error(`未找到菜单项 ${text}`);
        entry.click();
      } finally {
        if (original) Object.defineProperty(BrowserWindow, 'getFocusedWindow', original);
        else delete BrowserWindow.getFocusedWindow;
      }
    }, { id: drivenWindowId, text: label, prefix: startsWith });
  };
  await clickNativeMenu('在文件夹中显示');
  const revealedPaths = () => app.evaluate(() => globalThis.__revealed);
  for (let attempt = 0; attempt < 50 && (await revealedPaths()).length === 0; attempt++) await page.waitForTimeout(100);
  assert.deepEqual(await revealedPaths(), [await fs.realpath(actionFile)], '“在文件夹中显示”必须调用 shell.showItemInFolder');
  // Rename / move through the palette.
  const renamedPath = path.join(root, 'action-renamed.md');
  await app.evaluate(({ dialog, shell }, target) => {
    globalThis.__trashed = [];
    globalThis.__originalTrash = shell.trashItem;
    shell.trashItem = async item => { globalThis.__trashed.push(item); };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, renamedPath);
  await paletteCommand('重命名', '重命名 / 移动…');
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('action-renamed.md'), null, { timeout: 15000 });
  assert.deepEqual(await app.evaluate(() => globalThis.__trashed), [await fs.realpath(actionFile)], '重命名应把原文件移到废纸篓 / 回收站');
  // Trash from the native menu in the platform's own wording.
  await app.evaluate(({ dialog }) => {
    globalThis.__trashPrompts = [];
    globalThis.__originalMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => { globalThis.__trashPrompts.push(options); return { response: 1, checkboxChecked: false }; };
  });
  await clickNativeMenu('移到', true);
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改', null, { timeout: 15000 });
  const trashPrompt = await app.evaluate(() => globalThis.__trashPrompts.at(-1));
  assert.match(trashPrompt.message, new RegExp(`移到${trashLabel}`), `确认框应使用“${trashLabel}”`);
  assert.deepEqual(trashPrompt.buttons, ['取消', `移到${trashLabel}`], `确认框按钮应使用“${trashLabel}”`);
  assert.deepEqual(await app.evaluate(() => globalThis.__trashed), [await fs.realpath(actionFile), await fs.realpath(renamedPath)], '移到废纸篓 / 回收站应移动当前文件');
  // Chart insertion from the palette.
  await page.locator('.topbar [data-command="new"]').click();
  await paletteCommand('图表', '插入图表');
  await page.locator('[data-command="source"]').click();
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('```mermaid'), null, { timeout: 10000 });
  await page.locator('[data-command="source"]').click();
  await app.evaluate(({ dialog, shell }) => {
    if (globalThis.__originalMessageBox) dialog.showMessageBox = globalThis.__originalMessageBox;
    if (globalThis.__originalTrash) shell.trashItem = globalThis.__originalTrash;
    if (globalThis.__originalReveal) shell.showItemInFolder = globalThis.__originalReveal;
  });
  console.log('STEP file menu + palette reach rename / reveal / trash / diagram, history names stay readable');
  // Multi-document visibility in the default appearance.
  if (!await page.locator('.sidebar').isVisible()) await page.locator('.topbar [data-command="sidebar"]').click();
  const openDocuments = () => page.evaluate(() => [...document.querySelectorAll('#open-documents .open-document')].map(node => ({
    name: node.querySelector('.open-document-name span').textContent,
    current: node.querySelector('.open-document-name').getAttribute('aria-current') === 'true',
    label: node.querySelector('.open-document-name').getAttribute('aria-label'),
    tag: node.querySelector('.open-document-name').tagName,
    close: node.querySelector('.open-document-close').getAttribute('aria-label')
  })));
  const listed = await openDocuments();
  assert.ok(listed.length >= 2, `侧栏应列出全部已打开文档，实际 ${listed.length}`);
  assert.equal(listed.filter(entry => entry.current).length, 1, '侧栏中只应有一个当前文档');
  assert.equal(listed.at(-1).current, true, '当前文档必须在侧栏中高亮');
  assert.equal(listed.at(-1).tag, 'BUTTON', '侧栏文档条目必须是按钮，才能用 Tab / Enter 操作');
  assert.match(listed.at(-1).label, /^切换到 /, '侧栏条目需要 aria 标签');
  assert.match(listed.at(-1).close, /^关闭 /, '关闭按钮需要 aria 标签');
  const activeName = () => page.evaluate(() => document.querySelector('#location').textContent.replace(/^• /, ''));
  const beforeSwitch = await activeName();
  await broadcast('next-document');
  await page.waitForFunction(name => document.querySelector('#location').textContent.replace(/^• /, '') !== name, beforeSwitch, { timeout: 10000 });
  await broadcast('previous-document');
  await page.waitForFunction(name => document.querySelector('#location').textContent.replace(/^• /, '') === name, beforeSwitch, { timeout: 10000 });
  // Keyboard: focus another entry and press Enter to switch to it.
  const keyboardTarget = listed[0].name;
  await page.locator('#open-documents .open-document-name').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(name => document.querySelector('#location').textContent.replace(/^• /, '') === name, keyboardTarget, { timeout: 10000 });
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('改');
  await page.waitForFunction(() => !!document.querySelector('#open-documents .open-document-name[aria-current="true"] .dirty-mark'), null, { timeout: 10000 });
  const closeName = await activeName();
  const beforeClose = (await openDocuments()).length;
  await app.evaluate(({ dialog }) => {
    globalThis.__closePrompts = [];
    globalThis.__originalMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => { globalThis.__closePrompts.push(options.message); return { response: 2, checkboxChecked: false }; };
  });
  await page.locator('#open-documents .open-document:has(.open-document-name[aria-current="true"]) .open-document-close').click();
  await page.waitForFunction(count => document.querySelectorAll('#open-documents .open-document').length === count - 1, beforeClose, { timeout: 15000 });
  assert.match((await app.evaluate(() => globalThis.__closePrompts)).join('|'), new RegExp(closeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '侧栏关闭未保存文档必须走保存提示');
  await app.evaluate(({ dialog }) => { if (globalThis.__originalMessageBox) dialog.showMessageBox = globalThis.__originalMessageBox; });
  console.log('STEP sidebar lists open documents: switch, dirty marker, keyboard, close prompt');
  // The find / replace panel speaks Chinese too.
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.locator('.cm-search').waitFor();
  const searchLabels = await page.evaluate(() => {
    const node = document.querySelector('.cm-search');
    return [...node.querySelectorAll('button, label, input')].map(entry => entry.textContent || entry.getAttribute('aria-label') || entry.placeholder || '');
  });
  assert.equal(await page.locator('.cm-search button[name="close"]').getAttribute('aria-label'), '关闭', '查找面板关闭按钮应为中文');
  for (const label of ['查找', '替换', '下一个', '上一个', '全部', '区分大小写', '正则表达式', '全词匹配', '全部替换']) {
    assert.ok(searchLabels.includes(label), `查找面板应为中文：“${label}”，实际 ${JSON.stringify(searchLabels)}`);
  }
  assert.ok(!searchLabels.some(label => /^(next|previous|all|replace|replace all|match case|regexp|by word|close)$/i.test(String(label).trim())), `查找面板不得残留英文：${JSON.stringify(searchLabels)}`);
  await page.keyboard.press('Escape');
  console.log('STEP find / replace panel is fully Chinese');
  // 7) Windows cold start: a document path on the command line must be opened,
  //    while the app directory argument must never be treated as a file.
  const argvRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-argv-'));
  const argvFile = path.join(argvRoot, 'from-argv.md');
  await fs.writeFile(argvFile, '# 从命令行打开\n\n参数文件内容。\n');
  const argvEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(argvRoot, 'profile') };
  delete argvEnv.ELECTRON_RUN_AS_NODE;
  const argvApp = await electron.launch({ args: [project, argvFile, '--no-sandbox', '--disable-gpu'], env: argvEnv });
  try {
    const argvPage = await argvApp.firstWindow();
    argvPage.setDefaultTimeout(20000);
    await argvPage.locator('.cm-content').waitFor();
    await argvPage.waitForFunction(() => document.querySelector('#location').textContent.includes('from-argv.md'));
    assert.equal(await argvPage.locator('.document-tab').count(), 1, '命令行只应打开一个文档');
    await argvPage.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('参数文件内容'));
    console.log('STEP cold start opens the document named on the command line');
  } finally {
    const argvClosed = argvApp.waitForEvent('close').catch(() => {});
    await argvApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await argvClosed;
    await argvApp.close().catch(() => {});
    await fs.rm(argvRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // 7a2) A file opened while no folder is open adopts its own directory as the
  //      file tree root (Typora's single-file habit) without opening the sidebar,
  //      and an existing workspace is never replaced by a file from elsewhere.
  const singleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-single-'));
  const singleFolder = path.join(singleRoot, '单文件');
  const otherFolder = path.join(singleRoot, '其它');
  const singleFile = path.join(singleFolder, '甲.md');
  const otherFile = path.join(otherFolder, '丙.md');
  const singleEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(singleRoot, 'profile') };
  delete singleEnv.ELECTRON_RUN_AS_NODE;
  const fileTreeNames = target => target.evaluate(() => [...document.querySelectorAll('.file-item span')].map(node => node.textContent).sort());
  const folderTitle = target => target.evaluate(() => document.querySelector('#side-title').textContent);
  try {
    await fs.mkdir(singleFolder, { recursive: true });
    await fs.mkdir(otherFolder, { recursive: true });
    await fs.writeFile(singleFile, '# 甲\n\n同一目录的第一份。\n');
    await fs.writeFile(path.join(singleFolder, '乙.md'), '# 乙\n\n同一目录的第二份。\n');
    await fs.writeFile(otherFile, '# 丙\n\n另一个目录。\n');
      const singleRun = await electron.launch({ args: [project, singleFile, '--no-sandbox', '--disable-gpu'], env: singleEnv });
      let singlePage;
      try {
        singlePage = await singleRun.firstWindow();
        singlePage.setDefaultTimeout(20000);
        await singlePage.locator('.cm-content').waitFor();
        await singlePage.waitForFunction(() => document.querySelector('#location').textContent === '甲.md');
        // Adopting a folder must not pop the default hidden sidebar open.
        assert.equal(await singlePage.locator('.sidebar').isVisible(), false, '打开单个文件不应强制展开侧栏');
        // The native menu really carries Typora's key map: ⌘⇧O is quick open on
        // macOS, Ctrl+P / Ctrl+Shift+O stay put on Windows / Linux.
        const menuState = await singleRun.evaluate(({ Menu }) => {
          const file = Menu.getApplicationMenu()?.items.find(item => item.label === '文件');
          const items = file?.submenu.items || [];
          const find = label => items.find(item => item.label === label);
          const probe = accelerator => Menu.buildFromTemplate([{ label: 'probe', accelerator }]).items[0].accelerator;
          return {
            quickOpen: find('命令面板 / 快速打开…')?.accelerator ?? null,
            folder: find('打开文件夹…')?.accelerator ?? null,
            ctrlP: probe('CmdOrCtrl+P'), macQuickOpen: probe('Cmd+Shift+O'), ctrlShiftO: probe('CmdOrCtrl+Shift+O')
          };
        });
        if (process.platform === 'darwin') {
          assert.equal(menuState.quickOpen, menuState.macQuickOpen, `macOS 的快速打开应注册为 ⌘⇧O，实际 ${menuState.quickOpen}`);
          assert.ok(!menuState.folder, `macOS 的 ⌘⇧O 已归快速打开，打开文件夹不应再占用它，实际 ${menuState.folder}`);
        } else {
          assert.equal(menuState.quickOpen, menuState.ctrlP, `Windows / Linux 的快速打开应保持 Ctrl+P，实际 ${menuState.quickOpen}`);
          assert.equal(menuState.folder, menuState.ctrlShiftO, `Windows / Linux 打开文件夹应保持 Ctrl+Shift+O，实际 ${menuState.folder}`);
        }
        // macOS keeps ⌘P as an editor binding (the menu item now owns ⌘⇧O).
        if (process.platform === 'darwin') {
          await singlePage.locator('.cm-content').click();
          await singlePage.keyboard.press('Meta+p');
          await singlePage.locator('#quick-filter').waitFor();
          await singlePage.keyboard.press('Escape');
          await singlePage.waitForFunction(() => !document.querySelector('#dialog').open);
        }
        // Clicking the registered native menu item opens the palette, which lists
        // the neighbour of the file that adopted the folder.
        const clickedQuickOpen = await singleRun.evaluate(({ Menu }) => {
          const file = Menu.getApplicationMenu()?.items.find(item => item.label === '文件');
          const item = file?.submenu.items.find(entry => entry.label === '命令面板 / 快速打开…');
          if (!item) return false;
          item.click();
          return true;
        });
        assert.equal(clickedQuickOpen, true, '文件菜单必须提供快速打开');
        await singlePage.locator('#quick-filter').waitFor();
        await singlePage.waitForFunction(() => [...document.querySelectorAll('#quick-results .quick-item strong')].some(node => node.textContent === '乙.md'), null, { timeout: 15000 });
        await singlePage.locator('#quick-results .quick-item').filter({ hasText: '乙.md' }).first().click();
        await singlePage.waitForFunction(() => document.querySelector('#location').textContent === '乙.md');
        // The file tree shows both files of the adopted directory, and the
        // sidebar's visibility is unchanged until the user asks for it.
        await singlePage.evaluate(() => {
          if (document.body.classList.contains('sidebar-hidden')) document.querySelector('.topbar [data-command="sidebar"]').click();
          document.querySelector('[data-side="files"]').click();
        });
        await singlePage.waitForFunction(() => document.querySelectorAll('.file-item').length >= 2, null, { timeout: 15000 });
        assert.deepEqual(await fileTreeNames(singlePage), ['乙.md', '甲.md'], '文件树应列出打开文件所在的目录');
        assert.equal(await folderTitle(singlePage), '单文件', '文件树标题应为打开文件所在的目录');
        console.log('STEP a single file adopts its directory: file tree, quick open, hidden sidebar');
        // A file from another directory opens without replacing the workspace.
        await singleRun.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, otherFile);
        await singlePage.evaluate(() => document.querySelector('.topbar [data-command="open"]').click());
        await singlePage.waitForFunction(() => document.querySelector('#location').textContent === '丙.md', null, { timeout: 15000 });
        assert.equal(await folderTitle(singlePage), '单文件', '打开其它目录的文件后必须保留原有工作区');
        assert.deepEqual(await fileTreeNames(singlePage), ['乙.md', '甲.md'], '原有工作区的文件树不得被替换');
        console.log('STEP opening a file from another directory keeps the existing workspace');
        await singlePage.waitForTimeout(1500);
      } finally {
        const closed = singleRun.waitForEvent('close').catch(() => {});
        await singleRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
        await closed;
        await singleRun.close().catch(() => {});
      }
      // A restored session keeps the adopted folder and every document.
      const restoredRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: singleEnv });
      try {
        const restoredPage = await restoredRun.firstWindow();
        restoredPage.setDefaultTimeout(25000);
        await restoredPage.locator('.cm-content').waitFor();
        await restoredPage.waitForFunction(() => document.querySelector('#location').textContent === '丙.md', null, { timeout: 25000 });
        const restored = await restoredPage.evaluate(() => {
          document.querySelector('[data-side="files"]').click();
          return {
            title: document.querySelector('#side-title').textContent,
            documents: [...document.querySelectorAll('#open-documents .open-document-name span')].map(node => node.textContent).sort(),
            tree: [...document.querySelectorAll('.file-item span')].map(node => node.textContent).sort()
          };
        });
        assert.equal(restored.title, '单文件', '恢复会话后仍应记得打开文件时采用的文件夹');
        assert.deepEqual(restored.tree, ['乙.md', '甲.md'], `恢复会话应重新列出该文件夹的文件，实际 ${JSON.stringify(restored.tree)}`);
        assert.deepEqual(restored.documents, ['丙.md', '乙.md', '甲.md'], `恢复会话应重开全部文档，实际 ${JSON.stringify(restored.documents)}`);
        console.log('STEP a session that adopted a directory restores that folder and its documents');
      } finally {
        const closed = restoredRun.waitForEvent('close').catch(() => {});
        await restoredRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
        await closed;
        await restoredRun.close().catch(() => {});
      }
      // 7a2b) Folder scans belong to their request: a slow explicit scan may
      //       neither replace a newer folder nor report that newer folder's name
      //       with its own entries. The first readdir of the older folder is
      //       held until the newer choice has been committed.
      const raceProfile = path.join(singleRoot, 'race-profile');
      const raceEnv = { ...process.env, INKSTONE_TEST_USER_DATA: raceProfile };
      delete raceEnv.ELECTRON_RUN_AS_NODE;
      const slowRoot = await fs.realpath(singleFolder);
      const fastRoot = await fs.realpath(otherFolder);
      const raceRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: raceEnv });
      try {
        const racePage = await raceRun.firstWindow();
        racePage.setDefaultTimeout(20000);
        await racePage.locator('.cm-content').waitFor();
        await raceRun.evaluate((_, target) => {
          const filesystem = process.getBuiltinModule('node:fs/promises');
          const original = filesystem.readdir;
          let first = true;
          filesystem.readdir = async function (directory, ...rest) {
            if (first && directory === target) {
              first = false;
              await new Promise(resolve => { globalThis.inkstoneResumeRead = resolve; });
            }
            return original.call(filesystem, directory, ...rest);
          };
        }, slowRoot);
        // Start the older scan, then make the newer choice while it is blocked.
        await racePage.evaluate(target => { window.slowFolder = window.desktop.openFolderPath(target); }, slowRoot);
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = await raceRun.evaluate(() => !!globalThis.inkstoneResumeRead);
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(blocked, true, '延迟的目录读取应被触发');
        const fast = await racePage.evaluate(target => window.desktop.openFolderPath(target), fastRoot);
        assert.equal(fast.value?.path, fastRoot, '较新的目录选择必须立即生效');
        await raceRun.evaluate(() => globalThis.inkstoneResumeRead());
        const slow = await racePage.evaluate(() => window.slowFolder);
        assert.equal(slow.value, null, '被取代的慢扫描结果必须丢弃，而不是拼出新目录名 + 旧目录 entries');
        const refreshed = await racePage.evaluate(() => window.desktop.refreshFolder());
        assert.equal(refreshed.value?.path, fastRoot, '刷新必须返回当前工作区');
        assert.deepEqual(refreshed.value.entries.map(entry => entry.name), ['丙.md'], 'entries 必须属于返回值里的那个目录');
        // The newer choice really owns the window, and its baseline still works.
        const recentFolders = await racePage.evaluate(async () => (await window.desktop.recentFiles()).value);
        assert.ok(Array.isArray(recentFolders), '最近文件列表仍可读取');
        // A later normal folder open is not blocked by the dropped ticket.
        await raceRun.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, slowRoot);
        await racePage.evaluate(() => document.querySelector('[data-command="folder"]').click());
        await racePage.waitForFunction(() => document.querySelector('#side-title').textContent === '单文件', null, { timeout: 15000 });
        await racePage.waitForFunction(() => [...document.querySelectorAll('.file-item span')].some(node => node.textContent === '乙.md'), null, { timeout: 15000 });
        console.log('STEP a slow folder scan is dropped instead of replacing a newer root');
        // 7a2c) The same ordering rule covers path resolution: the ticket is taken
        //       when a request starts, so a choice whose realpath is answered late
        //       cannot take the workspace back from the newer one.
        await raceRun.evaluate((_, target) => {
          const filesystem = process.getBuiltinModule('node:fs/promises');
          const original = filesystem.realpath;
          let first = true;
          filesystem.realpath = async function (file, ...rest) {
            if (first && file === target) {
              first = false;
              await new Promise(resolve => { globalThis.inkstoneResumeResolve = resolve; });
            }
            return original.call(filesystem, file, ...rest);
          };
        }, slowRoot);
        await racePage.evaluate(target => { window.slowResolve = window.desktop.openFolderPath(target); }, slowRoot);
        let resolveBlocked = false;
        for (let attempt = 0; attempt < 100 && !resolveBlocked; attempt++) {
          resolveBlocked = await raceRun.evaluate(() => !!globalThis.inkstoneResumeResolve);
          if (!resolveBlocked) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(resolveBlocked, true, '延迟的路径解析应被触发');
        const resolvedFast = await racePage.evaluate(target => window.desktop.openFolderPath(target), fastRoot);
        assert.equal(resolvedFast.value?.path, fastRoot, '较新的目录选择必须立即生效');
        await raceRun.evaluate(() => globalThis.inkstoneResumeResolve());
        const lateResolve = await racePage.evaluate(() => window.slowResolve);
        assert.equal(lateResolve.value, null, '路径解析晚到的旧选择必须丢弃，不能夺回工作区');
        const afterResolve = await racePage.evaluate(() => window.desktop.refreshFolder());
        assert.equal(afterResolve.value?.path, fastRoot, '晚到的路径解析不得改变当前工作区');
        assert.deepEqual(afterResolve.value.entries.map(entry => entry.name), ['丙.md'], '工作区仍是较新的那个目录');
        console.log('STEP a slow folder path resolution cannot outrank a newer choice');
      } finally {
        const closed = raceRun.waitForEvent('close').catch(() => {});
        await raceRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
        await closed;
        await raceRun.close().catch(() => {});
      }
    // 7a3) The recent-files entry (a path open, not a dialog) adopts the folder
    //      too, and a file handed over by Finder never replaces that workspace.
    const recentProfile = path.join(singleRoot, 'recent-profile');
    const recentEnv = { ...process.env, INKSTONE_TEST_USER_DATA: recentProfile };
    delete recentEnv.ELECTRON_RUN_AS_NODE;
    await fs.mkdir(recentProfile, { recursive: true });
    await fs.writeFile(path.join(recentProfile, 'recent.json'), JSON.stringify({ files: [singleFile], folders: [] }));
    const recentRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: recentEnv });
    try {
      const recentPage = await recentRun.firstWindow();
      recentPage.setDefaultTimeout(20000);
      await recentPage.locator('.cm-content').waitFor();
      const openedRecent = await recentRun.evaluate(({ Menu }) => {
        const file = Menu.getApplicationMenu()?.items.find(item => item.label === '文件');
        const item = file?.submenu.items.find(entry => entry.label === '最近打开')?.submenu.items.find(entry => entry.label === '甲.md');
        if (!item) return false;
        item.click();
        return true;
      });
      assert.equal(openedRecent, true, '最近打开菜单必须列出预置的最近文件');
      await recentPage.waitForFunction(() => document.querySelector('#location').textContent === '甲.md', null, { timeout: 15000 });
      await recentPage.waitForFunction(() => document.querySelectorAll('.file-item').length >= 2, null, { timeout: 15000 });
      assert.equal(await folderTitle(recentPage), '单文件', '最近打开的文件也应在没有工作区时采用其父目录');
      // Finder / «open with» arrives on the same queue while a workspace is open.
      await recentRun.evaluate(({ app }, target) => { app.emit('open-file', { preventDefault() {} }, target); }, otherFile);
      await recentPage.waitForFunction(() => document.querySelector('#location').textContent === '丙.md', null, { timeout: 15000 });
      assert.equal(await folderTitle(recentPage), '单文件', 'Finder 打开其它目录的文件不得替换工作区');
      assert.deepEqual(await fileTreeNames(recentPage), ['乙.md', '甲.md'], 'Finder 打开文件后文件树保持不变');
      console.log('STEP recent files and Finder adopt a folder once and never replace it');
    } finally {
      const closed = recentRun.waitForEvent('close').catch(() => {});
      await recentRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await closed;
      await recentRun.close().catch(() => {});
    }
    // 7a4) A directory that cannot be listed must not take the document with it:
    //      the file stays editable and the window simply has no workspace.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-blocked-'));
      const blockedFolder = path.join(blockedRoot, '无法读取');
      const blockedFile = path.join(blockedFolder, '独.md');
      const blockedEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(blockedRoot, 'profile') };
      delete blockedEnv.ELECTRON_RUN_AS_NODE;
      try {
        await fs.mkdir(blockedFolder, { recursive: true });
        await fs.writeFile(blockedFile, '# 独\n\n父目录不可列出。\n');
        // Execute-only: the file is readable and traversable, the directory is not listable.
        await fs.chmod(blockedFolder, 0o111);
        const blockedRun = await electron.launch({ args: [project, blockedFile, '--no-sandbox', '--disable-gpu'], env: blockedEnv });
        try {
          const blockedPage = await blockedRun.firstWindow();
          blockedPage.setDefaultTimeout(20000);
          await blockedPage.locator('.cm-content').waitFor();
          await blockedPage.waitForFunction(() => document.querySelector('#location').textContent === '独.md', null, { timeout: 20000 });
          await blockedPage.locator('.cm-content').click();
          await blockedPage.keyboard.type('可以编辑');
          await blockedPage.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('可以编辑'), null, { timeout: 15000 });
          const blockedTitle = await blockedPage.evaluate(() => {
            if (document.body.classList.contains('sidebar-hidden')) document.querySelector('.topbar [data-command="sidebar"]').click();
            document.querySelector('[data-side="files"]').click();
            return document.querySelector('#side-title').textContent;
          });
          assert.equal(blockedTitle, '文件工作空间', '目录读取失败时不应把该目录设为工作区');
          console.log('STEP an unlistable directory leaves the document editable without a workspace');
        } finally {
          const closed = blockedRun.waitForEvent('close').catch(() => {});
          await blockedRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
          await closed;
          await blockedRun.close().catch(() => {});
        }
      } finally {
        await fs.chmod(blockedFolder, 0o755).catch(() => {});
        await fs.rm(blockedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  } finally {
    await fs.rm(singleRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // 7b) Temporary image folders are pruned at startup once they are 7 days old,
  //     but never when a recovery copy still names that document id.
  const pruneRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-prune-'));
  const pruneProfile = path.join(pruneRoot, 'profile');
  const oldAssetId = '11111111-1111-4111-8111-111111111111';
  const freshAssetId = '22222222-2222-4222-8222-222222222222';
  const recoveredAssetId = '33333333-3333-4333-8333-333333333333';
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  try {
    for (const id of [oldAssetId, freshAssetId, recoveredAssetId]) {
      await fs.mkdir(path.join(pruneProfile, 'unsaved-assets', id, 'assets'), { recursive: true });
      await fs.writeFile(path.join(pruneProfile, 'unsaved-assets', id, 'assets', 'a.png'), png);
    }
    await fs.utimes(path.join(pruneProfile, 'unsaved-assets', oldAssetId), eightDaysAgo, eightDaysAgo);
    await fs.utimes(path.join(pruneProfile, 'unsaved-assets', recoveredAssetId), eightDaysAgo, eightDaysAgo);
    await fs.mkdir(path.join(pruneProfile, 'recovery'), { recursive: true });
    await fs.writeFile(path.join(pruneProfile, 'recovery', `${recoveredAssetId}.json`), JSON.stringify({ id: recoveredAssetId, name: '恢复.md', content: '![图](assets/a.png)\n', dirty: true }));
    const pruneEnv = { ...process.env, INKSTONE_TEST_USER_DATA: pruneProfile };
    delete pruneEnv.ELECTRON_RUN_AS_NODE;
    const pruneApp = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: pruneEnv });
    try {
      const prunePage = await pruneApp.firstWindow();
      await prunePage.locator('.cm-content').waitFor();
      // The recovery copy is restored under a new id, and its image folder moves
      // with it, so wait for that document before inspecting the folders.
      await prunePage.waitForFunction(() => document.querySelector('#location').textContent.includes('恢复-'));
      await prunePage.waitForTimeout(300);
      const recoveredDocId = await prunePage.evaluate(() => [...document.querySelectorAll('[data-document]')].find(node => node.getAttribute('aria-selected') === 'true')?.dataset.document);
      assert.ok(recoveredDocId, '恢复的文档应有一个 id');
      const exists = file => fs.access(file).then(() => true, () => false);
      assert.equal(await exists(path.join(pruneProfile, 'unsaved-assets', oldAssetId)), false, '超过 7 天的临时图片目录应在启动时清理');
      assert.equal(await exists(path.join(pruneProfile, 'unsaved-assets', freshAssetId)), true, '未过期的临时图片目录必须保留');
      assert.equal(await exists(path.join(pruneProfile, 'unsaved-assets', recoveredAssetId)), false, '恢复后图片目录随文档换到新 id');
      assert.equal(await exists(path.join(pruneProfile, 'unsaved-assets', recoveredDocId, 'assets', 'a.png')), true, '恢复副本引用的临时图片不得删除');
      console.log('STEP stale unsaved image folders are pruned but recovery references are kept');
    } finally {
      const pruneClosed = pruneApp.waitForEvent('close').catch(() => {});
      await pruneApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await pruneClosed;
      await pruneApp.close().catch(() => {});
    }
  } finally {
    await fs.rm(pruneRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // 7c) A crash must not lose the images pasted into an unsaved document: the
  //     recovered draft takes over the image folder of the id it crashed under.
  const recoverRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-recover-'));
  const recoverProfile = path.join(recoverRoot, 'profile');
  const recoverEnv = { ...process.env, INKSTONE_TEST_USER_DATA: recoverProfile };
  delete recoverEnv.ELECTRON_RUN_AS_NODE;
  const recoverImage = path.join(recoverRoot, '崩溃 图片.png');
  await fs.writeFile(recoverImage, png);
  try {
    const firstRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: recoverEnv });
    try {
      const firstPage = await firstRun.firstWindow();
      firstPage.setDefaultTimeout(20000);
      await firstPage.locator('.cm-content').waitFor();
      await firstPage.locator('.topbar [data-command="new"]').click();
      await firstPage.locator('.cm-content').click();
      const draftId = await firstPage.evaluate(() => [...document.querySelectorAll('[data-document]')].find(node => node.getAttribute('aria-selected') === 'true')?.dataset.document);
      await firstRun.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, recoverImage);
      const inserted = await firstPage.evaluate(id => window.desktop.insertImage(id), draftId);
      assert.ok(inserted.ok, `插入图片失败：${JSON.stringify(inserted)}`);
      await firstPage.locator('.cm-content').click();
      await firstPage.keyboard.insertText(`![图片](${inserted.value})\n`);
      await firstPage.waitForFunction(() => document.querySelector('#editor-host .md-widget img')?.naturalWidth > 0);
      // Let the debounced flush write the recovery copy, then exit hard: this is
      // what a crash leaves behind (no save, no cleanup).
      await firstPage.waitForTimeout(900);
      const firstClosed = firstRun.waitForEvent('close').catch(() => {});
      await firstRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await firstClosed;
    } finally {
      await firstRun.close().catch(() => {});
    }
    const secondRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: recoverEnv });
    try {
      const secondPage = await secondRun.firstWindow();
      secondPage.setDefaultTimeout(20000);
      await secondPage.locator('.cm-content').waitFor();
      await secondPage.waitForFunction(() => document.querySelector('#location').textContent.includes('恢复-'));
      await secondPage.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget img').length === 1);
      const recoveredImage = await secondPage.evaluate(async () => {
        const node = document.querySelector('#editor-host .md-widget img');
        await new Promise(resolve => {
          node.loading = 'eager';
          if (node.complete) return resolve();
          node.addEventListener('load', () => resolve(), { once: true });
          node.addEventListener('error', () => resolve(), { once: true });
          setTimeout(resolve, 8000);
        });
        return { naturalWidth: node.naturalWidth, src: node.getAttribute('src') || '', mdSrc: node.dataset.mdSrc || '' };
      });
      assert.ok(recoveredImage.naturalWidth > 0, `崩溃恢复后的草稿必须仍显示粘贴的图片：${JSON.stringify(recoveredImage)}`);
      assert.match(recoveredImage.src, /^inkstone-asset:\/\//);
      assert.match(decodeURIComponent(recoveredImage.mdSrc), /^assets\/崩溃-图片-/);
      console.log('STEP a crashed draft keeps its pasted images through recovery');
    } finally {
      const secondClosed = secondRun.waitForEvent('close').catch(() => {});
      await secondRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await secondClosed;
      await secondRun.close().catch(() => {});
    }
  } finally {
    await fs.rm(recoverRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // 8) A crashed renderer must never leave an unclosable window: the prompt
  //    offers a reload, and choosing to close really closes it.
  const crashRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-crash-'));
  const crashEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(crashRoot, 'profile') };
  delete crashEnv.ELECTRON_RUN_AS_NODE;
  const crashApp = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: crashEnv });
  try {
    const crashPage = await crashApp.firstWindow();
    await crashPage.locator('.cm-content').waitFor();
    await crashApp.evaluate(({ dialog }) => {
      globalThis.__crashPrompt = null;
      dialog.showMessageBox = async (_window, options) => { globalThis.__crashPrompt = options; return { response: 0, checkboxChecked: false }; };
    });
    await crashApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    // A crashed target stays dead for Playwright even after a reload, so the
    // reloaded window is verified through the main process.
    const crashState = await crashApp.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const loaded = new Promise(resolve => contents.once('did-finish-load', () => resolve(true)));
      const timeout = new Promise(resolve => setTimeout(() => resolve(false), 25000));
      await Promise.race([loaded, timeout]);
      let count = 0;
      for (let attempt = 0; attempt < 100 && count !== 1; attempt++) {
        count = await contents.executeJavaScript('document.querySelectorAll(".cm-content").length').catch(() => 0);
        if (count === 1) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return { crashed: contents.isCrashed(), count };
    });
    const crashPrompt = await crashApp.evaluate(() => globalThis.__crashPrompt);
    assert.deepEqual(crashPrompt?.buttons, ['重新加载窗口', '关闭窗口'], `崩溃提示应提供重新加载与关闭，实际 ${JSON.stringify(crashPrompt?.buttons)}`);
    assert.deepEqual(crashState, { crashed: false, count: 1 }, `选择重新加载后窗口应恢复可用，实际 ${JSON.stringify(crashState)}`);
    await crashApp.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
    await crashApp.waitForEvent('close', { timeout: 30000 });
    console.log('STEP renderer crash prompts, reloads, and still allows closing');
  } finally {
    await crashApp.close().catch(() => {});
    await fs.rm(crashRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // 9) Quitting asks every window in order, a cancel aborts the whole quit, and
  //    a window whose renderer never answers is still closed after 5 seconds.
  const quitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-quit-'));
  const quitEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(quitRoot, 'profile') };
  delete quitEnv.ELECTRON_RUN_AS_NODE;
  const quitApp = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: quitEnv });
  try {
    const quitPage = await quitApp.firstWindow();
    quitPage.setDefaultTimeout(20000);
    await quitPage.locator('.cm-content').waitFor();
    // The welcome page is pristine and closing it asks nothing, so the quit
    // prompt needs a document with real unsaved text.
    await quitPage.locator('.topbar [data-command="new"]').click();
    await quitPage.locator('.cm-content').click();
    await quitPage.keyboard.insertText('退出前的未保存内容');
    await quitPage.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
    const secondOpened = quitApp.waitForEvent('window', { timeout: 20000 });
    await quitPage.evaluate(() => window.desktop.newWindow());
    const secondWindow = await secondOpened;
    await secondWindow.locator('.cm-content').waitFor();
    const windowCount = () => quitApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.equal(await windowCount(), 2);
    const quitMenu = () => quitApp.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu().items) {
        for (const item of top.submenu?.items || []) {
          if (item.label === '退出' || item.label === '退出墨页') { item.click(); return true; }
        }
      }
      throw new Error('退出菜单项不存在');
    });
    // A renderer that acknowledged the quit owns the close flow: a native save
    // prompt may stay open far longer than the 5 second fallback without the
    // window being taken away underneath the user.
    await quitApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => new Promise(resolve => {
        setTimeout(() => resolve({ response: 1, checkboxChecked: false }), 7000);
      });
    });
    await quitMenu();
    await quitPage.waitForTimeout(6200);
    assert.equal(await windowCount(), 2, '保存提示未选择前不得因 5 秒保底关窗');
    assert.ok(await quitPage.locator('.cm-content').count() >= 1, '保存提示等待期间文档必须仍在');
    await quitPage.waitForTimeout(2500);
    assert.equal(await windowCount(), 2, '选择取消后退出必须整体取消');
    assert.ok(await quitPage.locator('.cm-content').count() >= 1);
    console.log('STEP quit save prompt may outlive the 5s fallback');
    // A cancel in the first window must abort the whole application quit.
    await quitApp.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await quitMenu();
    await quitPage.waitForTimeout(2000);
    assert.equal(await windowCount(), 2, '任一窗口取消保存后必须整体取消退出');
    console.log('STEP quit cancel keeps every window open');
    // The last window never answers the quit command; the fallback closes it.
    await quitApp.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
      const windows = BrowserWindow.getAllWindows();
      windows[windows.length - 1].webContents.send = () => {};
    });
    const quitStarted = Date.now();
    const quitFinished = quitApp.waitForEvent('close', { timeout: 40000 });
    await quitMenu();
    await quitFinished;
    assert.ok(Date.now() - quitStarted >= 4500, `无响应的窗口应由 5 秒保底关闭，实际 ${Date.now() - quitStarted}ms`);
    console.log('STEP multi-window quit walks every window with a 5s fallback');
  } finally {
    await quitApp.close().catch(() => {});
    await fs.rm(quitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // 10) The welcome page is pristine, replaced by the first opened file, and only
  //     a user edit turns it into a normal unsaved document. Selecting an open
  //     document in the palette works with no folder open.
  const welcomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-welcome-'));
  const welcomeEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(welcomeRoot, 'profile') };
  delete welcomeEnv.ELECTRON_RUN_AS_NODE;
  const openedFile = path.join(welcomeRoot, '第一份文档.md');
  await fs.writeFile(openedFile, '# 打开的文件\n');
  try {
    const firstRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: welcomeEnv });
    try {
      const firstPage = await firstRun.firstWindow();
      firstPage.setDefaultTimeout(20000);
      await firstPage.locator('.cm-content').waitFor();
      const pristine = await firstPage.evaluate(() => ({
        location: document.querySelector('#location').textContent,
        title: document.title,
        listed: [...document.querySelectorAll('#open-documents .open-document-name span')].map(node => node.textContent)
      }));
      assert.equal(pristine.location, '欢迎使用.md', '欢迎页不应以未保存状态启动');
      assert.ok(!pristine.title.includes('•'), `窗口标题不应标记未保存：${pristine.title}`);
      assert.deepEqual(pristine.listed, ['欢迎使用.md']);
      await firstPage.locator('.topbar [data-command="new"]').click();
      await firstPage.waitForFunction(() => document.querySelectorAll('#open-documents .open-document').length === 2, null, { timeout: 10000 });
      await firstRun.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'quick-open'));
      await firstPage.locator('#quick-filter').waitFor();
      await firstPage.locator('#quick-filter').fill('欢迎');
      const paletteDocs = firstPage.locator('#quick-results [data-quick-document]');
      assert.equal(await paletteDocs.count(), 1, '未打开文件夹时命令面板也必须列出已打开的文档');
      await paletteDocs.first().click();
      await firstPage.waitForFunction(() => document.querySelector('#location').textContent.includes('欢迎使用.md'));
      assert.equal(await firstPage.evaluate(() => document.querySelectorAll('#open-documents .open-document').length), 2, '选中已打开文档只切换，不应再打开一份');
      await firstRun.evaluate(({ dialog }) => {
        globalThis.__prompts = [];
        dialog.showMessageBox = async (_window, options) => { globalThis.__prompts.push(options.message); return { response: 2, checkboxChecked: false }; };
      });
      if (!await firstPage.locator('.sidebar').isVisible()) await firstPage.locator('.topbar [data-command="sidebar"]').click();
      // Close the extra (untouched) document, leaving only the welcome page.
      await firstPage.locator('#open-documents .open-document').filter({ hasText: '未命名.md' }).locator('.open-document-close').click();
      await firstPage.waitForFunction(() => document.querySelectorAll('#open-documents .open-document').length === 1, null, { timeout: 15000 });
      assert.deepEqual(await firstRun.evaluate(() => globalThis.__prompts), [], '未修改的文档关闭时不应提示保存');
      await firstRun.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, openedFile);
      await firstRun.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'open'));
      await firstPage.waitForFunction(() => document.querySelector('#location').textContent.includes('第一份文档.md'), null, { timeout: 15000 });
      const afterOpen = await firstPage.evaluate(() => [...document.querySelectorAll('#open-documents .open-document-name span')].map(node => node.textContent));
      assert.deepEqual(afterOpen, ['第一份文档.md'], '打开文件应替换未修改的欢迎页，不留下多余标签');
      assert.deepEqual(await firstRun.evaluate(() => globalThis.__prompts), [], '替换欢迎页不应触发保存提示');
      await firstPage.locator('.cm-content').click();
      await firstPage.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
      await firstPage.keyboard.insertText('本地改动');
      await firstPage.waitForFunction(() => document.querySelector('#location').textContent.startsWith('•'), null, { timeout: 10000 });
      await firstRun.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'close'));
      await firstPage.waitForFunction(() => !document.querySelector('#location').textContent.includes('第一份文档.md'), null, { timeout: 15000 });
      const editPrompts = await firstRun.evaluate(() => globalThis.__prompts);
      assert.equal(editPrompts.length, 1, '编辑过的文档关闭时必须提示保存');
      assert.match(editPrompts[0], /第一份文档\.md/, '提示必须使用真实文件名');
      console.log('STEP welcome page stays pristine, the first opened file replaces it, edits make it dirty');
    } finally {
      const closed = firstRun.waitForEvent('close').catch(() => {});
      await firstRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await closed;
      await firstRun.close().catch(() => {});
    }
    const secondRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: welcomeEnv });
    try {
      const secondPage = await secondRun.firstWindow();
      secondPage.setDefaultTimeout(20000);
      await secondPage.locator('.cm-content').waitFor();
      await secondPage.waitForFunction(() => document.querySelector('#location').textContent === '欢迎使用.md', null, { timeout: 10000 });
      await secondRun.evaluate(({ dialog }) => {
        globalThis.__prompts = [];
        dialog.showMessageBox = async (_window, options) => { globalThis.__prompts.push(options.message); return { response: 2, checkboxChecked: false }; };
      });
      await secondPage.locator('.cm-content').click();
      await secondPage.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
      await secondPage.keyboard.insertText('编辑欢迎页');
      await secondPage.waitForFunction(() => document.querySelector('#location').textContent.startsWith('•'), null, { timeout: 10000 });
      await secondRun.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'close'));
      await secondPage.waitForFunction(() => !document.querySelector('#location').textContent.includes('欢迎使用.md'), null, { timeout: 15000 });
      const prompts = await secondRun.evaluate(() => globalThis.__prompts);
      assert.equal(prompts.length, 1, '编辑过的欢迎页关闭时必须提示保存');
      assert.match(prompts[0], /欢迎使用\.md/, '主进程与渲染层必须使用同一个欢迎页名称');
      assert.ok(!prompts[0].includes('未命名.md'), `保存提示不得再出现“未命名.md”：${prompts[0]}`);
      console.log('STEP an edited welcome page behaves like a normal unsaved document');
    } finally {
      const closed = secondRun.waitForEvent('close').catch(() => {});
      await secondRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await closed;
      await secondRun.close().catch(() => {});
    }
  } finally {
    await fs.rm(welcomeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // ── Batch 6: folder search, file tree, links, code highlighting, previews ──
  const featureFolder = path.join(root, '每日 功能');
  await fs.mkdir(featureFolder, { recursive: true });
  await fs.writeFile(path.join(featureFolder, '甲.md'), '# 甲文档\n\n共同关键词 在甲\n');
  await fs.writeFile(path.join(featureFolder, '乙.md'), '# 乙文档\n\n别的段落\n\n## 第二节\n\n共同关键词 在乙\n');
  await fs.writeFile(path.join(featureFolder, '链接目标.md'), '# 第一节\n\n目标内容\n\n## 第二节\n\n更多内容\n');
  await fs.writeFile(path.join(featureFolder, 'index.md'), [
    '# 索引', '', '[相对链接](./链接目标.md)', '', '[锚点链接](./链接目标.md#第二节)',
    '', '[文档内锚点](#索引)', '', '[网络](file://server/share/a.md)', ''
  ].join('\n'));
  await fs.writeFile(path.join(featureFolder, '代码.md'), [
    '# 代码示例', '', '```js', 'const answer = 42;', 'function greet(name) {', '  return `hi ${name}`;', '}', '```',
    '', '```haskell', 'main :: IO ()', 'main = putStrLn "hello"', '```', ''
  ].join('\n'));
  await fs.writeFile(path.join(featureFolder, '预览.md'), [
    '# 预览', '', '$$', 'a^2 + b^2', '$$', '', '```mermaid', 'flowchart LR', '  A[开始] --> B[结束]', '```', '', '段落。', ''
  ].join('\n'));
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, featureFolder);
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
  if (!await page.locator('.sidebar').isVisible()) await page.locator('.topbar [data-command="sidebar"]').click();
  // Clicking the folder command in the page keeps the IPC on the window under
  // test instead of depending on which window currently has focus.
  await page.evaluate(() => document.querySelector('[data-command="folder"]').click());
  const treeItem = name => page.locator('.file-item').filter({ hasText: name });
  await page.waitForFunction(() => [...document.querySelectorAll('.file-item span')].some(node => node.textContent === '甲.md'), null, { timeout: 20000 });
  await page.locator('[data-side="files"]').click();

  // ── folder-wide search ──
  await page.locator('[data-side="search"]').click();
  await page.locator('#folder-search-input').fill('共同关键词');
  await page.waitForFunction(() => document.querySelectorAll('.search-hit').length >= 2, null, { timeout: 20000 });
  assert.equal(await page.locator('.search-file').count(), 2, '搜索结果必须按文件分组');
  assert.ok(await page.locator('.search-hit mark').count() >= 2, '命中片段必须带高亮');
  assert.match(await page.locator('#folder-search-summary').textContent(), /2 个文件/);
  // A second query replaces the first, and case sensitivity is honoured.
  await page.locator('[data-search-option="caseSensitive"]').check();
  await page.locator('#folder-search-input').fill('共同关键词');
  await page.waitForFunction(() => document.querySelectorAll('.search-hit').length >= 2, null, { timeout: 20000 });
  await page.locator('[data-search-option="caseSensitive"]').uncheck();
  console.log('STEP folder search groups matches with highlighted snippets');

  // ── unsaved editor content participates in the search ──
  await page.locator('[data-side="files"]').click();
  await treeItem('甲.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('甲.md'));
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('\n未保存标记词');
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '有未保存的更改');
  await page.locator('[data-side="search"]').click();
  await page.locator('#folder-search-input').fill('未保存标记词');
  await page.waitForFunction(() => [...document.querySelectorAll('.search-hit')].some(node => node.textContent.includes('未保存标记词')), null, { timeout: 20000 });
  const unsavedHit = page.locator('.search-hit').filter({ hasText: '未保存标记词' }).first();
  const hitLine = (await unsavedHit.locator('.search-line').textContent()).trim();
  assert.equal(await page.locator('.search-file').count(), 1, '只有未保存的甲.md 含该标记词');
  await unsavedHit.click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('甲.md'));
  await page.waitForFunction(line => document.querySelector('#position').textContent.includes(`行 ${line}`), hitLine, { timeout: 10000 });
  await page.waitForFunction(() => /已选 \d+ 字/.test(document.querySelector('#selection-status').textContent), null, { timeout: 10000 });
  console.log('STEP unsaved editor content is searchable and a hit moves the caret to the match');

  // ── recent documents ──
  // Open a second document (and close it again) so the menu has to re-open it
  // from disk rather than merely switching to an open tab.
  await page.locator('[data-side="files"]').click();
  await treeItem('乙.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('乙.md'));
  await page.locator('#open-documents .open-document').filter({ hasText: '乙.md' }).locator('.open-document-close').click();
  await page.waitForFunction(() => !document.querySelector('#location').textContent.includes('乙.md'), null, { timeout: 15000 });
  const recent = await page.evaluate(async () => (await window.desktop.recentFiles()).value);
  assert.ok(recent.some(file => file.path.endsWith('甲.md')), `最近打开的文件应被记录，实际 ${JSON.stringify(recent)}`);
  assert.ok(recent.some(file => file.path.endsWith('乙.md')), '第二个文档也必须进入最近列表');
  await page.waitForTimeout(500);
  const recentLabels = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(item => item.label === '文件');
    const recentMenu = file?.submenu.items.find(item => item.label === '最近打开');
    return recentMenu ? recentMenu.submenu.items.map(item => item.label) : [];
  });
  assert.ok(recentLabels.includes('甲.md'), `文件菜单必须列出最近打开的文件，实际 ${JSON.stringify(recentLabels)}`);
  assert.ok(recentLabels.includes('乙.md'), `已关闭的最近文件也应出现在菜单里，实际 ${JSON.stringify(recentLabels)}`);
  assert.ok(recentLabels.includes('清除记录'), '最近打开菜单必须提供清除记录');
  // The menu entry itself is exercised in the single-window session run below:
  // a menu command follows the focused window, and this window shares the
  // application with the extra window opened earlier.
  console.log('STEP recent files menu lists documents and offers a clear action');

  // ── file tree: create, rename, trash ──
  await page.locator('[data-side="files"]').click();
  await page.locator('[data-file-op="new-file"]').click();
  await page.locator('#entry-name').fill('新建笔记');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.file-item')].some(node => node.textContent.trim() === '新建笔记.md'), null, { timeout: 20000 });
  assert.ok((await fs.readdir(featureFolder)).includes('新建笔记.md'), '新建文件必须真的写到磁盘上');
  await page.locator('[data-file-op="new-folder"]').click();
  await page.locator('#entry-name').fill('草稿');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('summary')].some(node => node.textContent.includes('草稿')), null, { timeout: 20000 });
  assert.ok((await fs.stat(path.join(featureFolder, '草稿'))).isDirectory(), '新建文件夹必须真的写到磁盘上');
  console.log('STEP file tree creates files and folders');

  // The native popup cannot take text input, so it reports the action and the
  // renderer asks for the name. The stub clicks the entry it is asked for.
  const stubPopup = label => app.evaluate(({ Menu }, wanted) => {
    globalThis.__originalPopup ||= Menu.prototype.popup;
    Menu.prototype.popup = function (options) {
      this.items.find(item => item.label.startsWith(wanted))?.click();
      options?.callback?.();
    };
  }, label);
  await stubPopup('重命名');
  await treeItem('新建笔记.md').click({ button: 'right' });
  await page.locator('#entry-name').waitFor();
  assert.equal(await page.locator('#entry-name').inputValue(), '新建笔记.md', '重命名对话框应带上原文件名');
  await page.locator('#entry-name').fill('改名的笔记');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('改名的笔记.md'), null, { timeout: 20000 });
  assert.ok((await fs.readdir(featureFolder)).includes('改名的笔记.md'));
  assert.ok(!(await fs.readdir(featureFolder)).includes('新建笔记.md'), '重命名后旧文件名必须消失');
  console.log('STEP file tree rename renames the file and the open tab');

  // A dirty document asks before it goes to the trash, and keeps its text.
  await treeItem('甲.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('甲.md'));
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__trashed = [];
    shell.trashItem = async target => { globalThis.__trashed.push(target); };
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await stubPopup('移到');
  await treeItem('甲.md').click({ button: 'right' });
  await page.waitForFunction(() => document.querySelector('#location').getAttribute('title') === '甲.md', null, { timeout: 20000 });
  const trashed = await app.evaluate(() => globalThis.__trashed);
  assert.ok(trashed.some(file => file.endsWith('甲.md')), '文件树的删除必须走 shell.trashItem');
  assert.match(await page.evaluate(() => document.querySelector('.cm-content').textContent), /共同关键词/, '移到回收站后未保存的文字必须保留');
  await app.evaluate(({ Menu }) => { if (globalThis.__originalPopup) Menu.prototype.popup = globalThis.__originalPopup; });
  console.log('STEP file tree trash confirms dirty documents and keeps the text');

  // Another program creating a file shows up without a manual refresh.
  await fs.writeFile(path.join(featureFolder, '外部新增.md'), '# 外部新增\n');
  await page.waitForFunction(() => [...document.querySelectorAll('.file-item')].some(node => node.textContent.trim() === '外部新增.md'), null, { timeout: 25000 });
  console.log('STEP file tree picks up a file created by another program');

  // ── local Markdown links and anchors ──
  await page.locator('[data-side="files"]').click();
  await treeItem('index.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('index.md'));
  await ensureLive();
  await page.locator('.md-widget a').filter({ hasText: '相对链接' }).click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('链接目标.md'), null, { timeout: 15000 });
  await treeItem('index.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('index.md'));
  await page.locator('.md-widget a').filter({ hasText: '锚点链接' }).click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('链接目标.md'));
  await page.waitForFunction(() => document.querySelector('#position').textContent.includes('行 5'), null, { timeout: 15000 });
  await treeItem('index.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('index.md'));
  await page.locator('.md-widget a').filter({ hasText: '文档内锚点' }).click();
  await page.waitForFunction(() => document.querySelector('#position').textContent.includes('行 1'), null, { timeout: 15000 });
  await page.locator('.md-widget a').filter({ hasText: '网络' }).click();
  await page.waitForFunction(() => {
    const note = document.querySelector('#notification');
    return !!note && !note.hidden && note.textContent.includes('网络');
  }, null, { timeout: 15000 });
  assert.match(await page.locator('#notification').textContent(), /不支持指向网络位置的链接/);
  console.log('STEP relative .md links, cross-document anchors and network-link refusal');

  // ── active code block highlighting, including an on-demand language ──
  await treeItem('代码.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('代码.md'));
  // The rendered page highlights through highlight.js: `js` is registered up
  // front, `haskell` arrives through the lazy loader and only its own block is
  // re-rendered.
  await page.waitForFunction(() => {
    const blocks = [...document.querySelectorAll('.md-widget pre.code-block')];
    const haskell = blocks.find(block => block.textContent.includes('putStrLn'));
    return blocks.length >= 2 && !!haskell && haskell.querySelectorAll('code.hljs span[class*="hljs-"]').length > 0;
  }, null, { timeout: 25000 });
  await page.locator('.md-widget pre.code-block').filter({ hasText: 'putStrLn' }).locator('code').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-line')].some(node => node.textContent.includes('putStrLn')), null, { timeout: 15000 });
  // @codemirror/language-data loads the grammar on demand for the active block.
  await page.waitForFunction(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(node => node.textContent.includes('putStrLn'));
    return !!line && [...line.querySelectorAll('span')].some(node => node.className);
  }, null, { timeout: 25000 });
  const tokenState = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(node => node.textContent.includes('main ::'));
    const tokens = line ? [...line.querySelectorAll('span')].map(node => ({ cls: node.className, text: node.textContent, color: getComputedStyle(node).color })) : [];
    const plain = line ? getComputedStyle(line).color : '';
    return { tokens, plain };
  });
  // Syntax tokens carry a generated highlight class (not one of the editor's
  // own `cm-` classes) and a colour from the shared palette.
  const highlightTokens = tokenState.tokens.filter(token => token.cls && !token.cls.split(' ').every(name => name.startsWith('cm-')));
  assert.ok(highlightTokens.length > 0, `活跃代码块必须有高亮 token 类，实际 ${JSON.stringify(tokenState.tokens)}`);
  assert.ok(highlightTokens.some(token => token.color !== tokenState.plain), '高亮 token 的颜色必须与正文不同');
  console.log('STEP active code block gets syntax tokens, on-demand haskell included');

  // ── live preview of a formula / diagram block being edited ──
  await treeItem('预览.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('预览.md'));
  await ensureLive();
  await page.locator('.md-widget .katex').first().click();
  await page.waitForFunction(() => document.querySelector('.md-live-preview .katex'), null, { timeout: 20000 });
  // The preview follows typing after the debounce, and is never editable.
  assert.equal(await page.evaluate(() => document.querySelector('.md-live-preview').isContentEditable), false);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.insertText(' + c^2');
  await page.waitForFunction(() => {
    const preview = document.querySelector('.md-live-preview');
    return !!preview && preview.textContent.includes('c');
  }, null, { timeout: 15000 });
  await page.keyboard.insertText(' \\frac{');
  await page.waitForFunction(() => document.querySelector('.md-live-preview .md-live-preview-error')?.textContent.includes('公式语法错误'), null, { timeout: 15000 });
  console.log('STEP formula block preview updates while typing and reports syntax errors');
  // The diagram block previews the same way, and a broken diagram says so.
  await page.locator('.md-widget pre.mermaid').first().click({ position: { x: 6, y: 6 } });
  await page.waitForFunction(() => document.querySelector('.md-live-preview pre.mermaid svg'), null, { timeout: 25000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.insertText(' ???');
  await page.waitForFunction(() => document.querySelector('.md-live-preview .diagram-error-message')?.textContent.includes('图表渲染失败'), null, { timeout: 25000 });
  // Clicking the preview only puts the caret back at the end of the source block.
  await page.locator('.md-live-preview').click();
  await page.waitForFunction(() => document.querySelector('#position').textContent.includes('行 10'), null, { timeout: 10000 });
  console.log('STEP diagram block preview renders, reports errors and is not editable');

  // ── folder rename / trash keeps the open documents in sync ──
  const syncRoot = path.join(featureFolder, '同步');
  await fs.mkdir(path.join(syncRoot, 'a'), { recursive: true });
  await fs.writeFile(path.join(syncRoot, 'a', 'x.md'), '# x\n\n第一行\n');
  await page.locator('[data-side="files"]').click();
  await page.locator('[data-file-op="refresh"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.file-item span')].some(node => node.textContent === 'x.md'), null, { timeout: 20000 });
  await page.locator('.file-item').filter({ hasText: /^x\.md$/ }).click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('x.md'));
  const oldSyncPath = await fs.realpath(path.join(syncRoot, 'a', 'x.md'));
  assert.equal(await page.evaluate(() => document.querySelector('#location').getAttribute('title')), oldSyncPath, '打开时标签应显示真实路径');
  await stubPopup('重命名');
  await page.locator('summary').filter({ hasText: /^a$/ }).click({ button: 'right' });
  await page.locator('#entry-name').waitFor();
  await page.locator('#entry-name').fill('b');
  await page.keyboard.press('Enter');
  // The document follows the folder: same tab, same text, new path.
  await page.waitForFunction(() => /[\\/]b[\\/]x\.md$/.test(document.querySelector('#location').getAttribute('title') || ''), null, { timeout: 20000 });
  assert.equal(await fs.stat(path.join(syncRoot, 'a')).then(() => true).catch(() => false), false, '文件夹必须真的改名');
  assert.equal(await fs.readFile(path.join(syncRoot, 'b', 'x.md'), 'utf8'), '# x\n\n第一行\n');
  // Editing and saving after the rename must write the new location only.
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.insertText('保存到新路径');
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存', null, { timeout: 20000 });
  assert.match(await fs.readFile(path.join(syncRoot, 'b', 'x.md'), 'utf8'), /保存到新路径/);
  assert.equal(await fs.stat(path.join(syncRoot, 'a')).then(() => true).catch(() => false), false, '保存不得重新创建旧文件夹');
  console.log('STEP renaming a folder moves the open document with it');

  // Trashing that folder keeps the text and turns the document unsaved.
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__trashedPaths = [];
    globalThis.__openedPaths = [];
    shell.trashItem = async target => { globalThis.__trashedPaths.push(target); };
    shell.openPath = async target => { globalThis.__openedPaths.push(target); return ''; };
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.locator('[data-file-op="refresh"]').click();
  await stubPopup('移到');
  await page.locator('summary').filter({ hasText: /^b$/ }).click({ button: 'right' });
  await page.waitForFunction(() => document.querySelector('#location').getAttribute('title') === 'x.md', null, { timeout: 20000 });
  assert.match(await page.evaluate(() => document.querySelector('.cm-content').textContent), /保存到新路径/, '移到回收站后文字必须保留');
  assert.ok((await app.evaluate(() => globalThis.__trashedPaths)).some(target => target.endsWith('b')), '文件夹必须走 shell.trashItem');
  await app.evaluate(({ Menu }) => { if (globalThis.__originalPopup) Menu.prototype.popup = globalThis.__originalPopup; });
  console.log('STEP trashing a folder turns its open documents into unsaved ones');

  // ── the opened folder itself is not a valid target ──
  const renameRoot = await page.evaluate(target => window.desktop.renameEntry(target, '根目录'), featureFolder);
  assert.equal(renameRoot.ok, false, '不能重命名已打开的文件夹本身');
  assert.match(renameRoot.error, /不能对已打开的文件夹本身执行此操作/);
  const trashRoot = await page.evaluate(target => window.desktop.trashEntry(target), featureFolder);
  assert.equal(trashRoot.ok, false, '不能把已打开的文件夹移到回收站');
  assert.match(trashRoot.error, /不能对已打开的文件夹本身执行此操作/);
  // …while creating an entry in it and revealing it stay allowed.
  const createdInRoot = await page.evaluate(target => window.desktop.createEntry(target, '根目录新建', 'folder'), featureFolder);
  assert.equal(createdInRoot.ok, true, '在已打开文件夹中新建仍然允许');
  await app.evaluate(({ shell }) => { globalThis.__revealed = []; shell.showItemInFolder = target => { globalThis.__revealed.push(target); }; });
  const revealed = await page.evaluate(target => window.desktop.revealPath(target), featureFolder);
  assert.equal(revealed.ok, true, '在文件夹中显示仍然允许');
  assert.equal((await app.evaluate(() => globalThis.__revealed)).length, 1);
  console.log('STEP the workspace root refuses rename / trash but allows create / reveal');

  // ── network locations are refused before the filesystem is touched ──
  const uncTarget = String.raw`\\host\share\notes.md`;
  for (const method of ['openPath', 'openLocalFile', 'openFolderPath']) {
    const started = Date.now();
    const refused = await page.evaluate(([name, target]) => window.desktop[name](target), [method, uncTarget]);
    assert.equal(refused.ok, false, `${method} 必须拒绝网络路径`);
    assert.match(refused.error, /不支持.*网络位置/, `${method} 必须给出中文提示：${refused.error}`);
    assert.ok(Date.now() - started < 2000, `${method} 不得真的访问网络位置`);
  }
  console.log('STEP openPath / openLocalFile / openFolderPath refuse network paths');

  // ── a document link may never launch an executable ──
  await fs.writeFile(path.join(featureFolder, 'setup.bat'), '@echo off\r\n');
  await fs.writeFile(path.join(featureFolder, '危险链接.md'), '# 危险\n\n[运行脚本](./setup.bat)\n');
  await page.locator('[data-file-op="refresh"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.file-item span')].some(node => node.textContent === '危险链接.md'), null, { timeout: 20000 });
  await treeItem('危险链接.md').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('危险链接.md'));
  await ensureLive();
  await app.evaluate(({ shell }) => { globalThis.__openedPaths = []; shell.openPath = async target => { globalThis.__openedPaths.push(target); return ''; }; });
  await page.locator('.md-widget a').filter({ hasText: '运行脚本' }).click();
  await page.waitForFunction(() => {
    const note = document.querySelector('#notification');
    return !!note && !note.hidden && note.textContent.includes('可执行文件');
  }, null, { timeout: 15000 });
  assert.match(await page.locator('#notification').textContent(), /出于安全考虑，不能从文档中打开可执行文件。/);
  assert.deepEqual(await app.evaluate(() => globalThis.__openedPaths), [], '安全校验必须在 shell.openPath 之前完成');
  console.log('STEP a link to an executable is refused and never reaches the shell');

  // ── session restore across two launches (shared userData) ──
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-session-desktop-'));
  const sessionEnv = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(sessionRoot, 'profile') };
  delete sessionEnv.ELECTRON_RUN_AS_NODE;
  const sessionFolder = path.join(sessionRoot, '工作 区');
  await fs.mkdir(sessionFolder, { recursive: true });
  await fs.writeFile(path.join(sessionFolder, '一.md'), '# 一\n\n第一份\n');
  await fs.writeFile(path.join(sessionFolder, '二.md'), '# 二\n\n第二份\n');
  const firstRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: sessionEnv });
  try {
    const firstPage = await firstRun.firstWindow();
    firstPage.setDefaultTimeout(20000);
    await firstPage.locator('.cm-content').waitFor();
    await firstRun.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, sessionFolder);
    await firstPage.evaluate(() => document.querySelector('[data-command="folder"]').click());
    await firstPage.waitForFunction(() => document.querySelectorAll('.file-item').length >= 2, null, { timeout: 20000 });
    await firstPage.locator('.file-item').filter({ hasText: '一.md' }).click();
    await firstPage.waitForFunction(() => document.querySelector('#location').textContent.includes('一.md'));
    await firstPage.locator('.file-item').filter({ hasText: '二.md' }).click();
    await firstPage.waitForFunction(() => document.querySelector('#location').textContent.includes('二.md'));
    await firstPage.waitForTimeout(1200);
    const stored = JSON.parse(await fs.readFile(path.join(sessionRoot, 'profile', 'session.json'), 'utf8'));
    assert.equal(stored.folder, await fs.realpath(sessionFolder), '会话必须记住上次的文件夹');
    assert.equal(stored.files.length, 2, '会话必须记住已保存的文档');
    assert.ok(stored.active.endsWith('二.md'), '会话必须记住当前文档');
    // «文件 → 最近打开» really opens a document that was closed again.
    await firstPage.locator('#open-documents .open-document').filter({ hasText: '二.md' }).locator('.open-document-close').click();
    await firstPage.waitForFunction(() => !document.querySelector('#location').textContent.includes('二.md'), null, { timeout: 15000 });
    const clicked = await firstRun.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find(item => item.label === '文件');
      const recentMenu = file?.submenu.items.find(item => item.label === '最近打开');
      const item = recentMenu?.submenu.items.find(entry => entry.label === '二.md');
      if (!item) return false;
      item.click();
      return true;
    });
    assert.equal(clicked, true, '最近打开菜单必须包含已关闭的文件');
    await firstPage.waitForFunction(() => document.querySelector('#location').textContent.includes('二.md'), null, { timeout: 15000 });
    await firstPage.waitForTimeout(1200);
  } finally {
    const closed = firstRun.waitForEvent('close').catch(() => {});
    await firstRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await closed;
    await firstRun.close().catch(() => {});
  }
  const secondRun = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env: sessionEnv });
  try {
    const secondPage = await secondRun.firstWindow();
    secondPage.setDefaultTimeout(25000);
    await secondPage.locator('.cm-content').waitFor();
    await secondPage.waitForFunction(() => document.querySelector('#location').textContent === '二.md', null, { timeout: 25000 });
    const restored = await secondPage.evaluate(() => ({
      documents: [...document.querySelectorAll('#open-documents .open-document-name span')].map(node => node.textContent),
      folder: document.querySelector('#location').title
    }));
    assert.deepEqual(restored.documents.sort(), ['一.md', '二.md'], `重启后应恢复两个文档，实际 ${JSON.stringify(restored.documents)}`);
    assert.ok(!restored.documents.includes('欢迎使用.md'), '恢复了文档就不应再显示欢迎页');
    // DOM clicks keep the assertion independent of the window-button overlay,
    // which can cover the topbar buttons in a freshly restored window.
    await secondPage.evaluate(() => {
      if (document.body.classList.contains('sidebar-hidden')) document.querySelector('.topbar [data-command="sidebar"]').click();
      document.querySelector('[data-side="files"]').click();
    });
    await secondPage.waitForFunction(() => [...document.querySelectorAll('.file-item span')].some(node => node.textContent === '一.md'), null, { timeout: 20000 });
    console.log('STEP session restore reopens the folder, its documents and the active one');
  } finally {
    const closed = secondRun.waitForEvent('close').catch(() => {});
    await secondRun.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await closed;
    await secondRun.close().catch(() => {});
    await fs.rm(sessionRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: native startup, editing, undo/redo, character-level click positioning, source mode, save, math, Mermaid labels, task toggle, external conflict + live notification, self-contained fonts in HTML, PDF, version history, preferences, custom CSS theme + themed HTML export, typewriter, dark mode, cross-block rendering parity, graphical table editing, clipboard HTML/Markdown, command palette, persisted zoom, cross-block drag selection, typeset live preview + syntax reveal, grouped undo, frameless chrome, code copy, article panel, resizable sidebar, heading numbering, version diff, outline drag reorder, window bounds, table Tab navigation, 200k+ source fallback, toolbar-free layout, typing in typeset mode, in-place table cells, in-cell Markdown with visible inline styles and markers, optional outer pipes, escaped-pipe source mapping, mixed-table refusal, IME candidate keys, native-save drafts, Enter rows, draggable columns, emoji autocomplete + picker, Pandoc gating, image context menu, independent new window, narrow desktop viewport, immediate typeset on closing delimiter, immediate heading/bullet/ordered/code typesetting, list/task/quote prefixes wait for a separator, nested quote/list/task prefixes typeset by layer, parsed thematic breaks (spaced and nested rules, Setext kept), rendered empty task checkbox, IME composition keeps whole-document typesetting, CRLF blocks stay CRLF, CRLF column widths, incremental block rendering keeps widget DOM and click positions, mixed newline round-trip, cell click without edit, bold cell edit, rendered cell Tab/Enter, quoted table editing, reload keeps a discarded copy, keep-local unblocks saving with a history backup, queued external prompts for two files, silent reload of a clean document, external deletion prompt with Save As / unsaved document, one-at-a-time reopen, cold start with an argv document, renderer crash prompts and still closes, Save As keeps rewritten asset references, local image paths (percent-encoded / angle brackets / ../ / absolute / http) and their HTML inlining, a typora-root-url image root (/-prefix, traversal/symlink refusal, copy path, Save As relocation, offline HTML, live root edit), document-injected data-* attributes staying inert, chrome-free export and copy-as-HTML, unsaved-document image insert + Save As migration + temp cleanup, startup pruning of stale unsaved image folders, UNC / network image references never contacted, case-variant and SVG/MathML reserved attributes stripped by DOMPurify alone, crash recovery keeping pasted images, quit save prompt may outlive the 5s fallback, a pristine welcome page that the first opened file replaces, the file menu and command palette exposing rename / reveal / trash / diagram, readable version-history names, the sidebar open-document list with keyboard switching and close prompts, palette switching between open documents without a folder, the Chinese find / replace panel, the Windows / Linux single-row title bar with a native menu popup and a theme-aware window-button overlay, folder-wide search (grouped results, unsaved content, caret placement), the recent-files menu, file-tree create / rename / trash / external refresh, local .md links with cross-document anchors and network-link refusal, active code block syntax tokens with an on-demand haskell grammar, formula + diagram live previews with Chinese syntax errors, folder rename / trash keeping open documents in sync, the workspace root refusing rename and trash, network paths refused by openPath / openLocalFile / openFolderPath, executable links refused before the shell, a single file adopting its own directory as the file tree (menu / recent / Finder / argv, ⌘⇧O quick open with ⌘P still bound in the editor, an unlistable directory keeping the file editable), and session restore across two launches.');
  if (process.env.INKSTONE_SCREENSHOT) await page.screenshot({ path: process.env.INKSTONE_SCREENSHOT });
} finally {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.exit(0));
  await closed;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
