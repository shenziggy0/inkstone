/**
 * Real Electron check for Typora-style equation labels and references.
 *
 * Run after `npm run build`:
 *   node test/math-labels.desktop.mjs
 *
 * It covers the reading view, the active formula preview, a live tag edit, the
 * auto-numbering preference and a self-contained HTML export. No network is
 * used; the only http URLs allowed in the export are XML namespaces.
 */
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-math-desktop-'));
const project = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content').waitFor();

  const sample = [
    '# 公式引用',
    '',
    '$$',
    'a^2+b^2=c^2 \\label{ref1} \\tag{1}',
    '$$',
    '',
    '见 \\(\\ref{ref1}\\) 与 \\(\\eqref{ref1}\\)。',
    '',
    '$$',
    'x=2 \\label{next} \\tag{2}',
    '$$',
    '',
    '$$',
    'y=3 \\label{next} \\tag{9}',
    '$$',
    '',
    '前向引用 \\(\\ref{next}\\)，未定义 \\(\\ref{missing}\\)。',
    '',
    '$$',
    'z=3 \\label{auto}',
    '$$',
    '',
    '自动编号 \\(\\ref{auto}\\)。',
    ''
  ].join('\n');

  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText(sample);
  await page.waitForFunction(() => document.querySelectorAll('.md-widget [data-math-number]').length >= 3);
  // Leave the last block's source so the whole sample is in the reading view.
  await page.locator('.md-widget h1').click();
  await page.waitForTimeout(250);

  const readWidget = async text => page.evaluate(label => {
    const widget = [...document.querySelectorAll('.md-widget')]
      .find(node => node.textContent.includes(label));
    if (!widget) return null;
    return {
      mtexts: [...widget.querySelectorAll('.katex-mathml mtext')].map(node => node.textContent),
      tags: [...widget.querySelectorAll('.katex-tag')].map(node => node.textContent),
      numbers: [...widget.querySelectorAll('[data-math-number]')].map(node => node.getAttribute('data-math-number')),
      duplicate: [...widget.querySelectorAll('[data-math-duplicate-label]')].map(node => node.getAttribute('data-math-duplicate-label'))
    };
  }, text);

  const formulaWidget = async id => page.evaluate(anchorId => {
    const anchor = document.querySelector(`.md-widget [id="${anchorId}"]`);
    const widget = anchor?.closest('.md-widget');
    if (!widget) return null;
    return {
      tags: [...widget.querySelectorAll('.katex-tag')].map(node => node.textContent),
      numbers: [...widget.querySelectorAll('[data-math-number]')].map(node => node.getAttribute('data-math-number'))
    };
  }, id);

  const reading = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.md-widget [id^="math-eq-"]')].map(node => node.id),
    numbers: [...document.querySelectorAll('.md-widget [data-math-number]')].map(node => node.getAttribute('data-math-number')),
    duplicate: [...document.querySelectorAll('.md-widget [data-math-duplicate-label]')].map(node => node.getAttribute('data-math-duplicate-label')),
    rawLabels: [...document.querySelectorAll('.md-widget')].some(node => node.textContent.includes('\\label'))
  }));
  assert.deepEqual(reading.ids, ['math-eq-ref1', 'math-eq-next', 'math-eq-auto'], '每个首次定义的标签只应产生一个锚点');
  assert.deepEqual(reading.numbers, ['1', '2', '9'], '手动编号不消耗自动编号');
  assert.deepEqual(reading.duplicate, ['next'], '重复标签应被标记');
  assert.equal(reading.rawLabels, false, '阅读态不应显示 \\label 源码');
  assert.deepEqual((await readWidget('见 ')).mtexts, ['1', '(1)'], '\\ref 与 \\eqref 应显示手动编号');
  assert.deepEqual((await readWidget('前向引用')).mtexts, ['2', '??'], '前向引用解析，未定义标签为 ??');
  assert.deepEqual((await readWidget('自动编号')).mtexts, ['??'], '关闭自动编号时，无 tag 的 label 不可引用');
  console.log('STEP math labels: reading view tags, references, forward ref, duplicate and undefined');

  // Editing the tag must refresh a reference in another block immediately.
  await page.locator('.md-widget [id="math-eq-ref1"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-line')].some(node => node.textContent.includes('\\label{ref1}')));
  const tagLine = page.locator('.cm-line').filter({ hasText: '\\label{ref1}' });
  await tagLine.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('3}');
  await page.locator('.md-widget h1').click();
  await page.waitForFunction(() => {
    const widget = [...document.querySelectorAll('.md-widget')].find(node => node.textContent.includes('见 '));
    return !!widget && [...widget.querySelectorAll('.katex-mathml mtext')].some(node => node.textContent === '3');
  });
  assert.deepEqual((await readWidget('见 ')).mtexts, ['3', '(3)'], '修改 tag 后引用应立即刷新');
  console.log('STEP math labels: editing a tag refreshes a reference in another block');

  // The active formula keeps its source and shows the same prepared number in
  // the live preview below it.
  await page.locator('.md-widget [id="math-eq-ref1"]').click();
  await page.waitForFunction(() => document.querySelector('.md-live-preview .katex'));
  const active = await page.evaluate(() => ({
    source: [...document.querySelectorAll('.cm-line')].some(node => node.textContent.includes('\\label{ref1}')),
    previewTag: document.querySelector('.md-live-preview .katex-tag')?.textContent || ''
  }));
  assert.equal(active.source, true, '活跃公式块应保留源码以便编辑');
  assert.match(active.previewTag, /3/, '活跃预览应使用文档中的编号');
  await page.locator('.md-widget h1').click();
  console.log('STEP math labels: active formula source + prepared live preview');

  // Auto-numbering is a real tag in the KaTeX tree, not a CSS counter. While
  // the formula is active, the visible preview must follow the preference too;
  // after leaving the block, the reading view and references refresh.
  await page.locator('.md-widget [id="math-eq-auto"]').click();
  await page.waitForFunction(() => document.querySelector('.md-live-preview .katex'));
  assert.equal(await page.locator('.md-live-preview .katex-tag').count(), 0, '关闭自动编号时预览无编号');
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="mathNumbering"]').check();
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => document.body.classList.contains('math-numbering'));
  await page.waitForFunction(() => document.querySelector('.md-live-preview .katex-tag')?.textContent.includes('1'), null, { timeout: 15000 });
  assert.match(await page.locator('.md-live-preview .katex-tag').textContent(), /1/, '切换编号偏好后可见活动预览应刷新');
  await page.locator('.md-widget h1').click();
  await page.waitForFunction(() => {
    const widget = [...document.querySelectorAll('.md-widget')].find(node => node.textContent.includes('自动编号'));
    return !!widget && [...widget.querySelectorAll('.katex-mathml mtext')].some(node => node.textContent === '1');
  });
  assert.deepEqual((await readWidget('自动编号')).mtexts, ['1'], '开启自动编号后引用应显示 1');
  assert.deepEqual((await formulaWidget('math-eq-auto')).tags, ['(1)'], '自动编号应写入 KaTeX tag');
  assert.deepEqual((await formulaWidget('math-eq-ref1')).tags, ['(3)'], '显式 tag 保持不变');
  assert.equal(await page.locator('.md-widget [data-math-number]').count(), 4, '开启后四个公式都有编号');
  await page.locator('[data-command="settings"]').click();
  await page.locator('[name="mathNumbering"]').uncheck();
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => !document.body.classList.contains('math-numbering'));
  await page.waitForFunction(() => {
    const widget = [...document.querySelectorAll('.md-widget')].find(node => node.textContent.includes('自动编号'));
    return !!widget && [...widget.querySelectorAll('.katex-mathml mtext')].some(node => node.textContent === '??');
  });
  assert.deepEqual((await formulaWidget('math-eq-auto')).tags, [], '关闭自动编号后不应留下 tag');
  assert.equal(await page.locator('.md-widget [data-math-number]').count(), 3);
  console.log('STEP math labels: auto-numbering preference re-renders tags and references');

  // HTML export must be self-contained and keep the same numbers.
  const htmlPath = path.join(root, 'math.html');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, htmlPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="html"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  const html = await fs.readFile(htmlPath, 'utf8');
  for (const number of ['2', '3', '9']) {
    assert.ok(html.includes(`data-math-number="${number}"`), `导出应保留公式编号 ${number}`);
  }
  assert.ok(html.includes('math-eq-ref1'), '导出应保留公式锚点');
  assert.ok(html.includes('data:font/'), '导出应内联 KaTeX 字体');
  assert.doesNotMatch(html, /\\label|\\ref\{/, '导出不应包含未处理的标签命令');
  const external = [...new Set([...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(match => match[0]))]
    .filter(url => !url.startsWith('http://www.w3.org/'));
  assert.deepEqual(external, [], '离线导出不得含 CDN、远程字体或远程脚本 URL');
  assert.deepEqual([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]), []);
  console.log('STEP math labels: self-contained offline HTML export');

  // A new document gets a new registry; the old label must not resolve.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('新文档 \\(\\ref{ref1}\\)\n');
  await page.waitForFunction(() => {
    const widget = [...document.querySelectorAll('.md-widget')].find(node => node.textContent.includes('新文档'));
    return !!widget && [...widget.querySelectorAll('.katex-mathml mtext')].some(node => node.textContent === '??');
  });
  const leaked = await page.evaluate(() => [...document.querySelectorAll('.md-widget .katex-mathml mtext')].map(node => node.textContent));
  assert.ok(leaked.includes('??'));
  assert.equal(await page.locator('.md-widget [id^="math-eq-"]').count(), 0, '新文档不应继承旧锚点');
  console.log('STEP math labels: switching documents does not carry labels or numbers');
  assert.deepEqual(errors, []);
  console.log('PASS: math labels, references, live edit refresh, auto-numbering, active preview, offline export and document isolation');
} finally {
  const closed = app.waitForEvent('close').catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closed;
  await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
