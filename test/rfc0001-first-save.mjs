// Run on a desktop and choose the printed path in the real Save dialog.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-first-save-'));
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const output = path.join(root, 'first-save.md');
const executablePath = process.env.INKSTONE_TEST_EXECUTABLE;
const args = ['--no-sandbox', '--disable-gpu'];
if (!executablePath) args.unshift(path.resolve(import.meta.dirname, '..'));
const app = await electron.launch({ executablePath, args, env });

try {
  const page = await app.firstWindow();
  await page.locator('.cm-content').waitFor();
  const command = name => app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows()[0].webContents.send('inkstone:command', name), name);
  await command('new');
  await page.waitForFunction(() => document.querySelector('#location')?.textContent === '未命名.md');
  const image = await app.evaluate(({ nativeImage }) => [...nativeImage.createFromBitmap(Buffer.from([0, 128, 255, 255]), { width: 1, height: 1 }).toPNG()]);
  const paste = () => page.locator('.cm-content').evaluate((editor, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)], 'pixel.png', { type: 'image/png' }));
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, image);
  await paste();
  console.log('请在真实保存对话框输入路径：' + output);
  await command('save');
  await page.waitForTimeout(700);
  await paste();
  await page.waitForFunction(() => document.querySelector('#location')?.textContent === '• first-save.md', null, { timeout: 180000 });
  await command('save');
  await page.waitForFunction(() => document.querySelector('#location')?.textContent === 'first-save.md');
  const content = await fs.readFile(output, 'utf8');
  const refs = [...content.matchAll(/\]\((assets\/[^)]+)\)/g)].map(match => match[1]);
  assert.equal(new Set(refs).size, 2);
  for (const ref of refs) assert.deepEqual(await fs.readFile(path.join(root, ref)), Buffer.from(image));
  console.log('R2：真实首次保存前后插入的两张图片均已写入目标目录和正文');
} finally {
  const stopped = app.waitForEvent('close', { timeout: 15000 });
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await stopped;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
