import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-rfc0001-'));
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const files = ['one.md', 'two.md'].map(name => path.join(root, name));
await fs.writeFile(files[0], '[目标](two.md#target)\n\n结尾');
await fs.writeFile(files[1], '# Target\n\n正文');
await fs.mkdir(path.join(root, 'assets'));
let app;
async function launch(args = []) {
  app = await electron.launch({ args: [path.resolve(import.meta.dirname, '..'), '--no-sandbox', '--disable-gpu', ...args], env });
  const page = await app.firstWindow();
  await page.locator('.cm-content').waitFor();
  return page;
}
async function command(name) {
  await app.evaluate(({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', name);
  }, name);
}
const tabs = page => page.locator('#document-tabs [data-document]');
const active = (page, name) => page.waitForFunction(name => document.querySelector('#location')?.textContent === name, name);
async function ipc(page, method, ...args) {
  const result = await page.evaluate(({ method, args }) => window.desktop[method](...args), { method, args });
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function quit(force = false) {
  const stopped = app.waitForEvent('close', { timeout: 15000 });
  await app.evaluate(({ app }, force) => force ? app.exit(0) : app.quit(), force).catch(() => {});
  await stopped;
  app = null;
}
try {
  let page = await launch(files);
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([0, 128, 255, 255]), { width: 1, height: 1 }).toPNG());
  await fs.writeFile(path.join(root, 'assets', 'pixel.png'), Buffer.from(png));
  await active(page, 'two.md');
  await command('previous-document');
  await active(page, 'one.md');
  await quit();
  page = await launch();
  assert.deepEqual(await tabs(page).allTextContents(), ['one.md', 'two.md']);
  await active(page, 'one.md');
  console.log('R4：正常退出后恢复独立文件及活动文档');

  await command('close');
  await active(page, 'two.md');
  await command('recent-files');
  await page.locator('#dialog [data-quick-path]').filter({ hasText: 'one.md' }).click();
  await active(page, 'one.md');
  console.log('R5：无工作区时从最近文件打开文档');

  await command('source');
  const link = page.locator('.cm-line').filter({ hasText: '[目标]' });
  await link.waitFor();
  await link.click({ position: { x: 20, y: 8 }, modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await active(page, 'two.md');
  console.log('R8：源码中的修饰键点击打开本地文档');

  const race = path.join(root, 'race.md');
  await fs.writeFile(race, '# 初始版本');
  const windowOpened = app.waitForEvent('window');
  await ipc(page, 'newWindow');
  const second = await windowOpened;
  await second.locator('.cm-content').waitFor();
  const left = await ipc(page, 'openPath', race);
  const right = await ipc(second, 'openPath', race);
  await ipc(page, 'updateDocument', left.id, '# 左窗口');
  await ipc(second, 'updateDocument', right.id, '# 右窗口');
  const results = await Promise.all([
    page.evaluate(id => window.desktop.saveDocument(id), left.id),
    second.evaluate(id => window.desktop.saveDocument(id), right.id),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.match(results.find(result => !result.ok).error, /修改或删除/);
  assert.equal(await fs.readFile(race, 'utf8'), results.find(result => result.ok).value.content);
  const pending = results[0].ok ? right : left;
  const recovery = path.join(env.INKSTONE_TEST_USER_DATA, 'recovery', ...(results[0].ok ? ['window-1'] : []), `${pending.id}.json`);
  assert.equal(JSON.parse(await fs.readFile(recovery, 'utf8')).dirty, true);
  console.log('R1：双窗口并发保存仅一方成功，另一方恢复稿保留');

  const originalFolder = path.join(root, 'history-folder');
  await fs.mkdir(originalFolder);
  const closed = path.join(originalFolder, 'closed.md');
  await fs.writeFile(closed, '# 历史版本');
  const closedDoc = await ipc(page, 'openPath', closed);
  await ipc(page, 'updateDocument', closedDoc.id, '# 当前版本');
  await ipc(page, 'saveDocument', closedDoc.id);
  await ipc(page, 'closeDocument', closedDoc.id);
  await ipc(page, 'openFolderPath', root);
  const renamed = await ipc(page, 'renameEntry', closed, 'renamed.md');
  const renamedDoc = await ipc(page, 'openPath', renamed.to);
  const history = await ipc(page, 'listHistory', renamedDoc.id);
  assert.equal(history.length, 1);
  assert.equal(await ipc(page, 'readHistory', history[0].dir, history[0].name), '# 历史版本');
  await ipc(page, 'closeDocument', renamedDoc.id);
  const movedFolder = await ipc(page, 'renameEntry', originalFolder, 'moved-folder');
  const nestedDoc = await ipc(page, 'openPath', path.join(movedFolder.to, 'renamed.md'));
  const nestedHistory = await ipc(page, 'listHistory', nestedDoc.id);
  assert.equal(nestedHistory.length, 1);
  assert.equal(await ipc(page, 'readHistory', nestedHistory[0].dir, nestedHistory[0].name), '# 历史版本');
  console.log('R6：关闭的文件及其父目录重命名后仍可读取原历史');

  const draft = await ipc(page, 'openPath', files[0]);
  await ipc(page, 'updateDocument', draft.id, '# 恢复测试\n\n![像素](assets/pixel.png)');
  const empty = await ipc(page, 'openPath', files[1]);
  await ipc(page, 'updateDocument', empty.id, '');
  await quit(true);
  page = await launch();
  await tabs(page).filter({ hasText: '恢复-one.md' }).evaluate(button => button.click());
  const restoredImage = page.locator('.md-widget img');
  await restoredImage.waitFor({ state: 'attached' });
  await restoredImage.evaluate(img => { img.loading = 'eager'; return img.decode(); });
  const blank = tabs(page).filter({ hasText: '恢复-two.md' });
  const blankId = await blank.getAttribute('data-document');
  assert.equal((await ipc(page, 'updateDocument', blankId, '')).dirty, true);
  assert.equal(await fs.readFile(files[1], 'utf8'), '# Target\n\n正文');
  console.log('R3：恢复原目录图片和空正文修改状态');
} finally {
  if (app) await quit(true);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
