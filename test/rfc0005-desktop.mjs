// Real Electron, files and clipboard. Native save dialogs are checked separately.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const project = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-rfc0005-'));
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [project], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(3500);
  const command = name => page.locator(`#app [data-command="${name}"]:visible`);
  const editor = page.locator('#editor-host .cm-content');
  const status = id => page.locator(id).textContent();
  const documentTitle = () => status('#location');
  const selectLine = () => page.keyboard.press('Shift+Home');
  await page.getByRole('button', { name: '写第一篇', exact: true }).click();
  await editor.press('Control+End');
  await page.keyboard.insertText('# 行李清单\n\n带望远镜');
  await page.waitForFunction(() => document.title.includes('行李清单'));
  await command('sidebar').click();
  await page.locator('#side-search').click();
  await page.locator('#folder-search-input').fill('望远镜');
  await page.locator('[data-search-document]').click();
  await page.waitForFunction(() => document.querySelector('#selection-status').textContent === '已选 3 字');
  await command('new').first().click();
  assert.equal(await status('#position'), '行 1，列 1');
  assert.equal(await status('#selection-status'), '');
  await page.keyboard.insertText('# 想去的地方\n\n海边灯塔');
  await page.locator('#side-articles').click();
  await page.locator('.article-item').filter({ hasText: '行李清单' }).click();
  assert.match(await documentTitle(), /行李清单/);
  assert.equal(await status('#selection-status'), '已选 3 字');
  await page.locator('#side-search').click();
  await page.getByLabel('包含本窗口草稿').uncheck();
  await page.waitForFunction(() => !document.querySelector('[data-search-document]'));
  await page.getByLabel('包含本窗口草稿').check();
  await page.locator('[data-search-document]').click();
  console.log('PASS 欢迎页新建、草稿命名和切换、无文件夹搜索、选区随稿件刷新');

  await page.locator('#selection-tools [data-command="bold"]').click();
  await page.waitForFunction(() => document.querySelector('#editor-host .cm-line strong, #editor-host .cm-lv-strong'));
  await editor.press('Escape');
  await page.locator('#selection-tools').waitFor({ state: 'hidden' });
  await command('new').first().click();
  await page.keyboard.insertText('青山');
  await selectLine();
  await page.locator('#selection-tools [data-command="selection-link"]').click();
  await page.locator('#entry-name').fill('https://example.com');
  await page.locator('#entry-name-confirm').click();
  await command('source').click();
  assert.match(await editor.innerText(), /\[青山\]\(<https:\/\/example\.com>\)/);
  await command('source').click();
  console.log('PASS 简洁模式选区加粗、链接和 Esc 收起');

  await page.locator('#side-articles').click();
  await page.locator('.article-item').filter({ hasText: '想去的地方' }).click();
  await selectLine();
  await page.locator('#selection-tools [data-command="writing-note-add"]').click();
  await page.locator('#entry-name').fill('下次查潮汐');
  await page.locator('#entry-name-confirm').click();
  await page.locator('#side-outline').click();
  await page.locator('[data-writing-note-action="jump"]').filter({ hasText: '下次查潮汐' }).click();
  assert.equal(await status('#selection-status'), '已选 4 字');
  await page.locator('#selection-tools [data-command="bold"]').click();
  await page.locator('#side-articles').click();
  await page.locator('#side-outline').click();
  assert.equal(await page.locator('[data-writing-note-action="jump"]').isEnabled(), true, '格式化原句不应使续写提示丢失');
  await page.locator('[data-writing-note-action="toggle"]').click();
  await page.getByRole('button', { name: '重新打开提示' }).waitFor();
  await page.locator('[data-writing-note-action="jump"]').filter({ hasText: '下次查潮汐' }).click();
  await page.locator('#selection-tools [data-command="copy-selection-image"]').click();
  try {
    await page.waitForFunction(() => {
      const notification = document.querySelector('#notification');
      return !notification.hidden && (notification.classList.contains('error') || notification.textContent.includes('选区已复制为图片'));
    });
    assert.match(await status('#notification'), /选区已复制为图片/);
  } catch (error) {
    throw new Error(`选区复制失败，界面提示：${await status('#notification')}`, { cause: error });
  }
  const bytes = await app.evaluate(async ({ clipboard, nativeImage }) => {
    const entries = await clipboard.read();
    const item = entries.find(entry => entry.types.includes('image/png'));
    if (!item) return 0;
    const blob = await item.getType('image/png');
    const buffer = Buffer.from(await blob.arrayBuffer());
    return nativeImage.createFromBuffer(buffer).isEmpty() ? 0 : buffer.length;
  });
  assert.ok(bytes > 100);
  console.log('PASS 续写提示添加与定位、完成状态、真实系统剪贴板 PNG');

  await command('export').click();
  assert.equal(await page.locator('button[data-export]:visible').count(), 3);
  await page.getByText('更多格式', { exact: true }).click();
  await page.locator('[data-export="zip"]').waitFor();
  await page.getByText('PDF 设置', { exact: true }).click();
  await page.locator('#pdf-preset-select').waitFor();
  console.log('PASS 导出首层、更多格式和 PDF 设置分层');
} finally {
  await app?.evaluate(({ app: electronApp }) => { setImmediate(() => electronApp.exit(0)); }).catch(() => {});
  await app?.close().catch(() => {});
  await fs.rm(root, { force: true, recursive: true });
}
