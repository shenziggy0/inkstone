import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import storeModule from '../electron/store.cjs';

const { DocumentStore } = storeModule;
const temp = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(temp, 'inkstone-rfc-rendering-'));
const profile = path.join(root, 'profile');
const historyFile = path.join(root, 'history.md');
const headingFile = path.join(root, 'headings.md');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app;

try {
  const rows = Array.from({ length: 3100 }, (_, i) => `line ${i + 1}`);
  await fs.writeFile(historyFile, rows.join('\n'));
  const store = new DocumentStore(path.join(profile, 'recovery'), { historyDirectory: path.join(profile, 'history') });
  const { id } = await store.open(historyFile);
  rows[3098] = 'changed line 3099';
  await store.update(id, rows.join('\n'));
  await store.save(id);

  await fs.writeFile(headingFile, '[TOC]\n\n# Same\n\nKeep this paragraph.\n\n# Other\n\nFinish here.\n');
  app = await electron.launch({
    args: [path.resolve(import.meta.dirname, '..'), '--no-sandbox', '--disable-gpu', historyFile, headingFile],
    env
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const command = name => app.evaluate(({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', name);
  }, name);
  const active = name => page.waitForFunction(name => document.querySelector('#location')?.textContent === name, name);

  await active('headings.md');
  const headings = page.locator('.md-widget h1');
  await headings.filter({ hasText: 'Other' }).click();
  await page.keyboard.press('End');
  for (let i = 0; i < 'Other'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.insertText('Same');
  await page.locator('.md-widget p').filter({ hasText: 'Finish here.' }).click();
  assert.deepEqual(await headings.evaluateAll(elements => elements.map(element => element.id)), ['same', 'same-1']);
  assert.deepEqual(await page.locator('.md-widget .toc a').evaluateAll(elements => elements.map(element => element.getAttribute('href'))), ['#same', '#same-1']);
  console.log('R9：增量修改第二个标题后，正文和目录锚点唯一且一致');

  await command('previous-document');
  await active('history.md');
  await command('history');
  await page.locator('.history-item').first().click();
  await page.locator('#compare-history').click();
  const progress = page.locator('#diff-progress');
  const more = page.getByRole('button', { name: '继续显示' });
  await more.waitFor();
  assert.match(await page.locator('#dialog').textContent(), /按行位置比较/);
  assert.equal(await progress.textContent(), '已显示 3000 / 3101 条');
  assert.equal(await page.locator('.diff-view .diff-line').count(), 3000);
  await more.click();
  assert.equal(await progress.textContent(), '已显示 3101 / 3101 条');
  assert.equal(await more.isVisible(), false);
  assert.deepEqual(await page.locator('.diff-view .diff-remove code').allTextContents(), ['line 3099']);
  assert.deepEqual(await page.locator('.diff-view .diff-add code').allTextContents(), ['changed line 3099']);
  assert.equal(await page.locator('.diff-view .diff-line code').last().textContent(), 'line 3100');
  console.log('R7：大文档按批追加直至全文末尾，显示第 3099 行变更及降级提示');
} finally {
  if (app) {
    const stopped = app.waitForEvent('close', { timeout: 15000 });
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await stopped;
  }
  const resolved = await fs.realpath(root);
  if (path.dirname(resolved) === temp && path.basename(resolved).startsWith('inkstone-rfc-rendering-')) {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
