// Compare actual text fragments so an extra wrapped line cannot hide behind
// identical element bounds. The sixth item is deliberately near a line break.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-list-layout-'));
const file = path.join(root, '编号列表.md');
const longFile = path.join(root, '长编号.md');
const longSource = '# 长编号\n\n123456789. 点击这一行正文\n123456790. 下一项\n';
const rows = Array.from({ length: 12 }, (_, i) => i === 5
  ? '文'.repeat(47) + 'iii'
  : '每次只点击文字中间，保留原来的内容。');
const source = '# 排版切换\n\n' + rows.map((row, i) => `${i + 1}. ${row}`).join('\n') + '\n\n列表之后的正文。';
await fs.writeFile(file, source);
await fs.writeFile(longFile, longSource);
const project = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  const executablePath = process.env.INKSTONE_TEST_EXECUTABLE;
  app = await electron.launch({ executablePath, args: executablePath ? [longFile, file] : [project, longFile, file], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 760));
  const readRows = page.locator('.md-widget ol > li');
  await readRows.last().waitFor();
  const geometry = () => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scroller = document.querySelector('#editor-host .cm-scroller');
    const items = scroller.querySelectorAll('.md-widget ol > li, .cm-line.cm-lv-ordered');
    return {
      scroll: scroller.scrollTop,
      fragments: [...items].map(item => {
        const text = [...item.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        const range = document.createRange();
        range.selectNodeContents(text);
        return [...range.getClientRects()].map(rect => ({ x: rect.x, y: rect.y, width: rect.width }));
      })
    };
  });
  const before = await geometry();
  assert.equal(before.fragments.length, 12);
  async function check(stage) {
    const after = await geometry();
    assert.equal(after.scroll, before.scroll, stage + ' 滚动位置');
    assert.equal(after.fragments.length, before.fragments.length, stage + ' 列表项数');
    for (const [i, lines] of before.fragments.entries()) {
      const actual = after.fragments[i];
      assert.equal(actual.length, lines.length, stage + ' 第' + (i + 1) + '项换行数');
      for (const [j, rect] of lines.entries()) {
        for (const dimension of ['x', 'y', 'width']) {
          assert.ok(Math.abs(actual[j][dimension] - rect[dimension]) <= 1,
            `${stage} 第${i + 1}项第${j + 1}行 ${dimension}: ${rect[dimension]} → ${actual[j][dimension]}`);
        }
      }
    }
  }
  await readRows.nth(1).click({ position: { x: 80, y: 8 } });
  await check('点击第2项');
  await page.locator('.cm-lv-ordered').nth(9).click({ position: { x: 90, y: 8 } });
  await check('点击第10项');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.locator('.cm-lv-ordered .cm-md-mark').waitFor();
  await check('编辑编号');
  await page.locator('.md-widget h1').click();
  await check('离开列表');
  assert.equal(await page.locator('#save-status').getAttribute('data-state'), 'saved');
  assert.equal(await fs.readFile(file, 'utf8'), source);
  await readRows.nth(9).click({ position: { x: 80, y: 8 } });
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText('9');
  await page.locator('.topbar [data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  assert.equal(await fs.readFile(file, 'utf8'), source.replace('\n10. ', '\n190. '));
  console.log('PASS 12 个编号项的文字位置、换行数和滚动位置在切换前后一致');

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(910, 760);
    window.webContents.send('inkstone:command', 'next-document');
  });
  await page.locator('.md-widget ol[start="123456789"] > li').first().click({ position: { x: 100, y: 8 } });
  async function assertMarkerVisible(selector) {
    const marker = page.locator(selector).first();
    await marker.waitFor();
    const { markerLeft, markerRight, viewportLeft, viewportRight } = await marker.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const viewport = node.closest('.cm-scroller').getBoundingClientRect();
      return { markerLeft: text.left, markerRight: text.right, viewportLeft: viewport.left, viewportRight: viewport.right };
    });
    assert.ok(markerLeft >= viewportLeft - 1 && markerRight <= viewportRight + 1,
      `九位编号须完整可见：[${markerLeft}, ${markerRight}]，编辑区 [${viewportLeft}, ${viewportRight}]`);
  }
  await assertMarkerVisible('.cm-prefix-ordered');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await assertMarkerVisible('.cm-ordered-source');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText('9');
  await page.locator('.topbar [data-command="save"]').click();
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  assert.equal(await fs.readFile(longFile, 'utf8'), longSource.replace('123456789.', '193456789.'));
  console.log('PASS 九位编号在两种编辑状态下完整可见，保存仅改动指定数字');
} finally {
  if (app) {
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => app.exit(0));
    await closed;
  }
  await fs.rm(root, { recursive: true, force: true });
}
