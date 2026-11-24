// Use a real Markdown file, Electron's native theme, and an isolated profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const project = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-workspace-'));
const file = path.join(root, '山间手记.md');
await fs.copyFile(path.join(project, 'docs/assets/logo-256.png'), path.join(root, 'figure.png'));
const contents = '# 山间手记\n\n![正文配图](figure.png)\n\n' + Array.from({ length: 18 }, (_, i) => `## 第 ${i + 1} 段\n\n山脊在云雾中若隐若现。`).join('\n\n');
await fs.writeFile(file, contents);
const firstDraft = path.join(root, '甲稿.md');
const secondDraft = path.join(root, '乙稿.md');
await fs.writeFile(firstDraft, '# 甲稿\n');
await fs.writeFile(secondDraft, '# 乙稿\n');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
const settingsFile = path.join(env.INKSTONE_TEST_USER_DATA, 'settings.json');
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [project, firstDraft, secondDraft, file], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const checkStatusBounds = async () => {
    const editor = await page.locator('#editor-host').boundingBox();
    const status = await page.locator('.statusbar').boundingBox();
    assert.ok(editor.y + editor.height <= status.y + 1, '状态条不得覆盖可点击的编辑区域');
  };
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 650));
  await page.waitForFunction(() => document.querySelector('#location')?.textContent === '山间手记.md');
  await page.waitForFunction(() => document.querySelector('.cm-content img[alt="正文配图"]')?.naturalWidth === 256);
  await page.locator('.topbar [data-command="source"]').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText('\n\n落笔，收稿。');
  await page.locator('.topbar [data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  assert.equal(await fs.readFile(file, 'utf8'), contents + '\n\n落笔，收稿。');
  await page.locator('.topbar [data-command="source"]').click();
  console.log('PASS 正文配图读取、真实文件打开、源码编辑、保存后逐字核对');

  await page.locator('.topbar [data-command="sidebar"]').click();
  await page.locator('#side-outline').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#side-files').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  await page.locator('#sidebar-resizer').focus();
  const width = Number(await page.locator('#sidebar-resizer').getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(w => Number(document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow')) === w, width + 16);
  await page.locator('.topbar [data-command="settings"]').click();
  await page.locator('[name="uiMode"]').selectOption('workbench');
  await page.locator('[name="theme"]').selectOption('system');
  await page.locator('#preferences [type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  // Playwright pins a light colour scheme by default. Let Chromium follow the
  // real theme of this isolated Electron application.
  await page.emulateMedia({ colorScheme: null });
  for (const mode of ['dark', 'light']) {
    await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, mode);
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, mode);
  }
  assert.equal(await page.locator('.formatbar').isVisible(), true);
  console.log('PASS 文稿库键盘导航和调整宽度、工作台、跟随系统明暗切换');

  await checkStatusBounds();
  const tab = name => page.locator('#document-tabs [role="tab"]').filter({ hasText: name });
  await tab('甲稿.md').click();
  await page.locator('.topbar [data-command="source"]').click();
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const entries = Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []);
    entries.find(item => item.label === '下一个文档').click(undefined, BrowserWindow.getFocusedWindow());
  });
  await page.waitForFunction(() => document.querySelector('#location').textContent === '乙稿.md');
  assert.equal(await page.locator('#editor-host .cm-content').evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.insertText('换篇后继续写。');
  await page.locator('.topbar [data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  assert.ok((await fs.readFile(secondDraft, 'utf8')).includes('换篇后继续写。'));
  assert.equal(await fs.readFile(firstDraft, 'utf8'), '# 甲稿\n');
  await page.locator('.topbar [data-command="source"]').click();
  await tab('甲稿.md').click();
  await page.locator('#document-tabs [aria-label="关闭 乙稿.md"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#document-tabs [role="tab"]').length === 2);
  assert.equal(await page.locator('#location').textContent(), '甲稿.md');
  assert.equal(await page.locator('#editor-host .cm-content').evaluate(el => el.contains(document.activeElement)), true);
  await page.locator('.topbar [data-command="new"]').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent === '未命名.md');
  await page.keyboard.insertText('新稿开头');
  assert.ok((await page.locator('#editor-host .cm-content').innerText()).includes('新稿开头'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'draft');
  await page.locator('#document-tabs [aria-label="关闭 未命名.md"]').click();
  await tab('山间手记.md').focus();
  await page.keyboard.press('Home');
  assert.equal(await tab('甲稿.md').evaluate(el => document.activeElement === el), true);
  await tab('山间手记.md').click();
  assert.equal(await page.locator('#editor-host .cm-content').evaluate(el => el.contains(document.activeElement)), true);
  console.log('PASS 新建和切换后直接输入、方向键浏览标签、关闭后台文档保留当前页');

  const lastParagraph = page.locator('#editor-host :is(.cm-line, .md-widget p)').filter({ hasText: /^落笔，收稿。$/ });
  const scroller = page.locator('#editor-host > .editor-mount > .cm-editor > .cm-scroller');
  const lastLine = (contents + '\n\n落笔，收稿。').split('\n').length;
  const checkLastLineClick = async () => {
    await page.locator('#editor-host .cm-content').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    await page.waitForFunction(() => document.querySelector('#position').textContent.startsWith('行 1，'));
    await scroller.hover();
    await page.mouse.wheel(0, 4000);
    await page.waitForFunction(() => {
      const scroller = document.querySelector('#editor-host > .editor-mount > .cm-editor > .cm-scroller');
      return scroller.scrollTop > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
    });
    await lastParagraph.waitFor();
    const point = await lastParagraph.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      return { x: text.left + text.width / 2, y: text.top + text.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(line => document.querySelector('#position').textContent.startsWith(`行 ${line}，`), lastLine);
    await checkStatusBounds();
  };
  await checkLastLineClick();

  await page.locator('.topbar [data-command="sidebar"]').click();
  await page.waitForFunction(async () => (await window.desktop.settings()).value.workbenchSidebarVisible === false);
  // Exercise the real IPC and settings file when several quick toggles overlap.
  const writes = await page.evaluate(() => Promise.all(Array.from({ length: 24 }, (_, i) =>
    window.desktop.settings({ workbenchSidebarVisible: i % 2 === 0 }))));
  assert.ok(writes.every(result => result.ok));
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).workbenchSidebarVisible, false, '重启时应读取最后一次选择');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(736, 620));
  await page.waitForFunction(() => matchMedia('(max-width:760px)').matches);
  await checkLastLineClick();
  console.log('PASS 两种窗口尺寸滚到正文末尾并点击文字，光标落在对应行');
  assert.equal(await page.locator('#writing-sidebar').getAttribute('inert'), '');
  await page.locator('.topbar [data-command="sidebar"]').click();
  assert.equal(await page.locator('#writing-sidebar').getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('.main-pane').getAttribute('inert'), '');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.topbar [data-command="sidebar"]').evaluate(el => document.activeElement === el), true);
  await page.locator('.topbar [data-command="sidebar"]').click();
  await page.locator('.sidebar [data-command="quick-open"]').click();
  await page.locator('#quick-filter').fill('山间手记');
  await page.locator('#quick-results [data-quick-document]').click();
  assert.equal(await page.locator('.main-pane').evaluate(el => el.inert), false);
  await page.locator('[data-command="toolbar-menu"]').click();
  await page.locator('[data-menu-command="settings"]').click();
  await page.locator('#preferences').waitFor();
  await page.keyboard.press('Escape');
  await scroller.evaluate(el => el.scrollTo(0, 0));
  await scroller.hover();
  await page.mouse.wheel(0, 450);
  await page.locator('.tools-folded .restore-tools').waitFor();
  await page.locator('.restore-tools').click();
  assert.equal(await page.locator('.status-actions').isVisible(), true);
  console.log('PASS 窄窗抽屉、焦点归位、更多操作、随滚动收起与恢复工具');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.locator('[data-command="toolbar-menu"]').click();
  await page.locator('[data-menu-command="settings"]').click();
  const sheet = page.locator('#dialog');
  await sheet.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
  assert.equal(Math.round((await sheet.boundingBox()).width), 390);
  const handle = await page.locator('.sheet-grabber').boundingBox();
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x, y + 122, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  console.log('PASS 手机宽度下面板铺满屏幕、下拉关闭');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] });
  const settings = await page.evaluate(() => ({ blur: getComputedStyle(document.querySelector('.glass-group')).backdropFilter, motion: getComputedStyle(document.querySelector('.sidebar-tabs'), '::before').transitionDuration }));
  assert.deepEqual(settings, { blur: 'none', motion: '0s' });
  assert.deepEqual(errors, []);
  console.log('PASS 减少动态效果、降低透明度、无渲染错误');

  await app.close();
  app = await electron.launch({ args: [project, file], env });
  const restored = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1050, 690));
  await restored.waitForFunction(() => innerWidth > 760 && document.documentElement.dataset.ui === 'workbench' && document.querySelector('.cm-content'));
  assert.equal(await restored.locator('#writing-sidebar').isVisible(), false);
  await restored.locator('.topbar [data-command="settings"]').click();
  await restored.locator('[name="uiMode"]').selectOption('typora');
  await restored.locator('#preferences [type="submit"]').click();
  await restored.waitForFunction(() => document.documentElement.dataset.ui === 'typora');
  assert.equal(await restored.locator('#writing-sidebar').isVisible(), true);
  console.log('PASS 重启恢复工作台侧栏，两种布局分别记忆');

  await app.close();
  const legacyProfile = path.join(root, 'legacy-profile');
  await fs.mkdir(legacyProfile);
  await fs.writeFile(path.join(legacyProfile, 'settings.json'), JSON.stringify({ uiMode: 'workbench', sidebarVisible: false }));
  app = await electron.launch({ args: [project, file], env: { ...env, INKSTONE_TEST_USER_DATA: legacyProfile } });
  const upgraded = await app.firstWindow();
  await upgraded.waitForFunction(() => innerWidth > 760 && document.documentElement.dataset.ui === 'workbench' && document.querySelector('.cm-content'));
  assert.equal(await upgraded.locator('#writing-sidebar').isVisible(), false);
  console.log('PASS 旧版工作台沿用已保存的侧栏状态');
} finally {
  if (app) await app.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}
