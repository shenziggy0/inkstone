import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const sample = '# Desktop verification\n\n中文与 **Markdown**。\n\n$$\nE=mc^2\n$$\n\n```mermaid\nflowchart LR\n A[Input] --> B[Output]\n```\n\n- [ ] pending\n';
  await page.keyboard.insertText(sample);
  await page.locator('.outline-item').filter({ hasText: 'Desktop verification' }).waitFor();
  await page.locator('[data-command="source"]').click();
  console.log('STEP edit + source');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await page.locator('.cm-placeholder').count(), 1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
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
  await fs.writeFile(savePath, 'changed externally');
  await page.locator('[data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#notification').textContent.includes('其他程序'));
  assert.equal(await fs.readFile(savePath, 'utf8'), 'changed externally');
  // The disk watcher should also report the external edit without a save.
  await page.locator('#dialog').getByText('文件已在编辑器外修改').waitFor({ timeout: 8000 });
  await page.locator('[data-menu-command="keep-local"]').click();
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
  assert.equal(await page.locator('.md-widget .footnote-ref').count(), 1);
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
  // A single click now edits the cell in place instead of opening a dialog.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
  await page.locator('.md-widget table td').first().click();
  assert.match(await page.locator('#selection-status').textContent(), /已选 1 字/, '单击单元格应选中该单元格源码');
  await page.keyboard.insertText('99');
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
  // Dragging from one rendered block into another must produce a real
  // cross-block selection, not just a caret in the first block.
  const paragraphs = await page.locator('.md-widget p').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + Math.min(Math.max(rect.width - 8, 8), 80), y: rect.top + rect.height / 2 };
  }));
  assert.ok(paragraphs.length >= 2, `需要至少两个渲染段落，实际 ${paragraphs.length}`);
  await page.mouse.move(paragraphs[0].x, paragraphs[0].y);
  await page.mouse.down();
  await page.mouse.move(paragraphs[1].x, paragraphs[1].y, { steps: 14 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length >= 2, { timeout: 4000 }).catch(() => {});
  const liveLines = await page.locator('.cm-live-line').count();
  assert.ok(liveLines >= 2, `跨块拖选应展开多个源码行，实际 ${liveLines}`);
  assert.ok((await page.evaluate(() => window.getSelection().toString())).includes('\n'), '跨块选区应包含段落之间的换行');
  assert.ok(await page.locator('.cm-selectionBackground').count() >= 1, '跨块拖选应产生可见选区');
  await app.evaluate(async ({ clipboard, BrowserWindow }) => { await clipboard.clear(); BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', 'copy-markdown'); });
  await pollClipboard('text', /文字|结尾|普通/);
  console.log('STEP cross-block drag selection');
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
  // Beyond 200k characters the live renderer must stand down entirely.
  page.setDefaultTimeout(90000);
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText(`# 大文档\n\n${'内容 '.repeat(70000)}`);
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length === 0, null, { timeout: 30000 });
  assert.equal(await page.locator('.cm-content').count(), 1);
  assert.ok((await page.locator('.cm-content').textContent()).includes('内容'));
  page.setDefaultTimeout(15000);
  console.log('STEP 200k+ character plain-source fallback');
  // A Typora-like toolbar-free layout is opt-in from preferences.
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="showFormatbar"]').uncheck();
  await page.locator('#preferences button[type="submit"]').click();
  assert.ok(await page.evaluate(() => document.body.classList.contains('hide-formatbar')));
  assert.equal(await page.locator('.formatbar').isVisible(), false);
  console.log('STEP optional toolbar-free layout');
  // Hidden syntax must never corrupt the source: typing into a typeset active
  // block writes to the real Markdown characters.
  await page.locator('[data-command="source"]').click();
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
  await page.keyboard.type('# ', { delay: 25 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-hidden-mark').length >= 1);
  assert.ok(await page.locator('.cm-lv-h1').count() >= 1, '输入 # 加空格后应立即成为标题');
  await page.keyboard.type('标题', { delay: 25 });
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('# '), '标题前缀应立即隐藏');
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
  console.log('STEP immediate heading, bullet, ordered list and code span typesetting');
  // `:shortcode` autocompletion writes the Unicode glyph into the source.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type(':smi');
  await page.locator('.cm-tooltip-autocomplete').waitFor();
  await page.keyboard.press('Enter');
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
  // A narrow desktop window must not overflow horizontally or hide the editor.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 80, width: 760, height: 620 }));
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#editor-host').isVisible(), '窄屏下编辑区仍可见');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2), false, '窄屏不应产生横向溢出');
  console.log('STEP narrow desktop viewport');
  assert.deepEqual(errors, []);
  console.log('PASS: native startup, editing, undo/redo, character-level click positioning, source mode, save, math, Mermaid labels, task toggle, external conflict + live notification, self-contained fonts in HTML, PDF, version history, preferences, custom CSS theme + themed HTML export, typewriter, dark mode, cross-block rendering parity, graphical table editing, clipboard HTML/Markdown, command palette, persisted zoom, cross-block drag selection, typeset live preview + syntax reveal, grouped undo, frameless chrome, code copy, article panel, resizable sidebar, heading numbering, version diff, outline drag reorder, window bounds, table Tab navigation, 200k+ source fallback, toolbar-free layout, typing in typeset mode, in-place table cells, Enter rows, draggable columns, emoji autocomplete + picker, Pandoc gating, image context menu, independent new window, narrow desktop viewport, immediate typeset on closing delimiter, immediate heading/bullet/ordered/code typesetting.');
  if (process.env.INKSTONE_SCREENSHOT) await page.screenshot({ path: process.env.INKSTONE_SCREENSHOT });
} finally {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.exit(0));
  await closed;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
