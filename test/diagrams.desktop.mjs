/**
 * Real Electron check for Typora's `sequence` and `flow` fences.
 *
 *   npm run build && node test/diagrams.desktop.mjs
 *
 * The fixture is the two examples from
 * https://support.typora.io/Draw-Diagrams-With-Markdown/ plus participant,
 * note, uppercase, error and ordinary-code cases. It verifies the reading
 * view, the active-block preview, theme refresh, self-contained HTML export
 * and the print DOM used for the PDF. On macOS the first PDF page is also
 * rasterised with `sips` and checked for the native diagrams' stroke and note
 * colours, so a missing diagram cannot pass as an empty page.
 */
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-diagrams-desktop-'));
const project = path.resolve(import.meta.dirname, '..');
const samplePath = path.join(root, 'diagram-sample.md');

const SAMPLE = [
  '# 图表围栏验收',
  '',
  '```sequence',
  'Alice->Bob: Hello Bob, how are you?',
  'Note right of Bob: Bob thinks',
  'Bob-->Alice: I am good thanks!',
  '```',
  '',
  '```sequence',
  'Title: 参与者',
  'participant 客户端',
  'participant 服务端',
  '客户端->服务端: 请求',
  'Note over 客户端,服务端: 校验',
  '服务端-->>客户端: 响应',
  '```',
  '',
  '```SEQUENCE',
  'X->Y: 大写围栏',
  '```',
  '',
  '```flow',
  'st=>start: Start',
  'op=>operation: Your Operation',
  'cond=>condition: Yes or No?',
  'e=>end',
  '',
  'st->op->cond',
  'cond(yes)->e',
  'cond(no)->op',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  M[Mermaid 正常] --> N[结束]',
  '```',
  '',
  '```sequence',
  'Alice=>Bob: broken',
  '```',
  '',
  '```flow',
  'bad=>loop: nope',
  'bad->bad',
  '```',
  '',
  '```text',
  'Alice->Bob: 普通代码围栏',
  '```',
  ''
].join('\n');
await fs.writeFile(samplePath, SAMPLE);

const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, samplePath, '--no-sandbox', '--disable-gpu'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content').waitFor();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('diagram-sample.md'));

  // ── reading view ────────────────────────────────────────────────────────
  await page.waitForFunction(() => {
    const pre = [...document.querySelectorAll('.md-widget pre.diagram')];
    return pre.some(node => node.dataset.diagram === 'sequence' && node.dataset.processed === 'true' && node.querySelector('svg')) &&
      pre.some(node => node.dataset.diagram === 'flow' && node.dataset.processed === 'true' && node.querySelector('svg')) &&
      pre.filter(node => node.dataset.processed === 'error').length === 2 &&
      !!document.querySelector('.md-widget pre.mermaid svg');
  });
  const reading = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.md-widget pre.diagram')];
    const text = node => [...node.querySelectorAll('svg text')].map(item => item.textContent);
    const svgs = [...document.querySelectorAll('.md-widget pre.diagram svg')];
    return {
      sequence: blocks.filter(node => node.dataset.diagram === 'sequence' && node.dataset.processed === 'true').map(text),
      flow: blocks.filter(node => node.dataset.diagram === 'flow' && node.dataset.processed === 'true').map(text),
      mermaid: [...document.querySelectorAll('.md-widget pre.mermaid svg text')].map(item => item.textContent),
      errors: blocks.filter(node => node.dataset.processed === 'error').map(node => ({
        kind: node.dataset.diagram,
        message: node.querySelector('.diagram-error-message')?.textContent || '',
        source: node.textContent
      })),
      code: [...document.querySelectorAll('.md-widget pre.code-block')].map(node => node.textContent),
      labels: svgs.map(node => node.getAttribute('aria-label')),
      shapes: {
        rects: document.querySelectorAll('.md-widget pre.diagram svg rect').length,
        polygons: document.querySelectorAll('.md-widget pre.diagram svg polygon').length,
        dashed: document.querySelectorAll('.md-widget pre.diagram svg [stroke-dasharray="5 4"]').length
      },
      unsafe: [...document.querySelectorAll('.md-widget pre.diagram svg')].flatMap(svg => [
        ...[...svg.querySelectorAll('script, iframe, object, embed, image, foreignObject, a')].map(node => node.tagName),
        ...[...svg.querySelectorAll('*')].flatMap(node => [...node.attributes].map(attribute => attribute.name)).filter(name => /^on/i.test(name) || name === 'href')
      ])
    };
  });
  const joined = reading.sequence.flat().join('\n');
  for (const label of ['Alice', 'Bob', 'Hello Bob, how are you?', 'Bob thinks', 'I am good thanks!', '客户端', '服务端', '请求', '校验', '响应', 'X', 'Y', '大写围栏']) {
    assert.ok(joined.includes(label), `时序图应包含“${label}”，实际 ${joined}`);
  }
  assert.deepEqual(reading.sequence.map(list => list[0]), ['Hello Bob, how are you?', '请求', '大写围栏'], '三张合法时序图都应渲染');
  const flowText = reading.flow.flat().join('\n');
  for (const label of ['Start', 'Your Operation', 'Yes or No?', 'yes', 'no']) assert.ok(flowText.includes(label), `流程图应包含“${label}”，实际 ${flowText}`);
  assert.ok(reading.mermaid.includes('Mermaid 正常') && reading.mermaid.includes('结束'), '原 Mermaid 围栏必须继续工作');
  assert.ok(reading.shapes.rects >= 8 && reading.shapes.polygons >= 1 && reading.shapes.dashed >= 1, `图形必须有实际形状：${JSON.stringify(reading.shapes)}`);
  assert.deepEqual(reading.labels, ['时序图', '时序图', '时序图', '流程图'], '原生图表必须带无障碍名称');
  assert.deepEqual(reading.unsafe, [], '原生图表的 SVG 不得含脚本、链接或事件属性');
  assert.deepEqual(reading.errors.map(error => error.kind), ['sequence', 'flow']);
  assert.match(reading.errors[0].message, /图表渲染失败：时序图第 1 行/);
  assert.match(reading.errors[1].message, /图表渲染失败：流程图第 1 行/);
  assert.match(reading.errors[0].source, /Alice=>Bob: broken/, '错误块必须保留原 Markdown');
  assert.match(reading.errors[1].source, /bad=>loop: nope/, '错误块必须保留原 Markdown');
  assert.ok(reading.code.some(text => text.includes('Alice->Bob: 普通代码围栏')), '普通代码围栏不得被当成图表');
  assert.match(await page.evaluate(() => document.querySelector('.cm-content').textContent), /Alice=>Bob: broken/);
  console.log('STEP sequence / flow / mermaid fences render in the reading view; errors keep the source; text fences stay code');

  // ── HTML export ─────────────────────────────────────────────────────────
  const htmlPath = path.join(root, 'diagram-sample.html');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, htmlPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="html"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.equal((html.match(/<pre class="diagram(?: diagram-error)?"/g) || []).length, 6, '导出应保留六个图表围栏');
  assert.equal((html.match(/data-diagram="sequence"/g) || []).length, 4);
  assert.equal((html.match(/data-diagram="flow"/g) || []).length, 2);
  assert.equal((html.match(/aria-label="时序图"/g) || []).length, 3, '三个合法时序图必须导出 SVG');
  assert.equal((html.match(/aria-label="流程图"/g) || []).length, 1, '合法流程图必须导出 SVG');
  assert.equal((html.match(/aria-roledescription="flowchart-v2"/g) || []).length, 1, 'Mermaid 导出不能被破坏');
  for (const label of ['Alice', 'Hello Bob, how are you?', 'Bob thinks', 'I am good thanks!', 'Start', 'Your Operation', 'Yes or No?', '>yes<', '>no<', 'Mermaid 正常']) {
    assert.ok(html.includes(label), `HTML 导出应包含“${label}”`);
  }
  assert.match(html, /<pre class="diagram diagram-error" data-diagram="sequence"[^>]*data-processed="error"/);
  assert.match(html, /图表渲染失败：时序图第 1 行/);
  assert.doesNotMatch(html, /<script\b/i, '导出不得包含脚本');
  const nativeBlocks = [...html.matchAll(/<pre class="diagram(?: diagram-error)?"[^>]*>[\s\S]*?<\/pre>/g)].map(match => match[0]);
  assert.equal(nativeBlocks.length, 6);
  for (const block of nativeBlocks) {
    assert.doesNotMatch(block, /<script|<iframe|<foreignObject|<a\b|\son[a-z]+\s*=/i, '导出的图表不得含脚本、链接或事件处理属性');
    assert.doesNotMatch(block, /https?:\/\/(?!www\.w3\.org\/)/i, '导出的图表不得引用远程资源');
  }
  assert.match(html, /\.prose pre\.diagram/, '导出样式必须带上图表围栏规则');
  const external = [...new Set([...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(match => match[0]))]
    .filter(url => !url.startsWith('http://www.w3.org/'));
  assert.deepEqual(external, [], '离线 HTML 不得含远程依赖');
  console.log('STEP fixed sample HTML export contains all native SVGs, errors, no scripts and no remote resources');

  // ── PDF export ──────────────────────────────────────────────────────────
  const pdfPath = path.join(root, 'diagram-sample.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="pdf"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  const pdf = await fs.readFile(pdfPath);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 40000, `PDF 应有实际内容，实际 ${pdf.length} 字节`);
  // `#print-document` is the exact DOM Chromium printed. (It is cleared only
  // when the next export starts, so it still holds this PDF's content.)
  const print = await page.evaluate(() => {
    const node = document.querySelector('#print-document');
    return {
      sequence: node.querySelectorAll('pre.diagram[data-diagram="sequence"] svg').length,
      flow: node.querySelectorAll('pre.diagram[data-diagram="flow"] svg').length,
      mermaid: node.querySelectorAll('pre.mermaid svg').length,
      text: node.textContent,
      scripts: node.querySelectorAll('script').length,
      unsafe: [...node.querySelectorAll('pre.diagram *')].flatMap(element => [...element.attributes].map(attribute => attribute.name)).filter(name => /^on/i.test(name) || name === 'href')
    };
  });
  assert.equal(print.sequence, 3);
  assert.equal(print.flow, 1);
  assert.equal(print.mermaid, 1);
  assert.match(print.text, /Hello Bob, how are you\?/);
  assert.match(print.text, /Bob thinks/);
  assert.match(print.text, /Yes or No\?/);
  assert.equal(print.scripts, 0);
  assert.deepEqual(print.unsafe, []);

  // Raster evidence that the diagrams reached the PDF itself. The sequence
  // Read the actual theme colours used by the diagram, so a palette change
  // keeps testing the same note fill and lifelines in the printed PDF.
  if (process.platform === 'darwin') {
    const bmpPath = path.join(root, 'diagram-sample.bmp');
    try {
      await run('sips', ['-s', 'format', 'bmp', pdfPath, '--out', bmpPath], { timeout: 30000 });
      const bmp = await fs.readFile(bmpPath);
      const offset = bmp.readUInt32LE(10);
      const width = bmp.readInt32LE(18);
      const rawHeight = bmp.readInt32LE(22);
      const height = Math.abs(rawHeight);
      const bpp = bmp.readUInt16LE(28);
      assert.equal(bpp, 32, 'sips 应输出 32 位 BMP');
      let soft = 0, muted = 0;
      const [noteFill, lineInk, paper] = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const colors = ['--color-code', '--color-muted', '--color-paper'].map(token => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color.match(/\d+/g).map(Number);
        });
        probe.remove();
        return colors;
      });
      const near = (r, g, b, color) => Math.abs(r - color[0]) <= 2 && Math.abs(g - color[1]) <= 2 && Math.abs(b - color[2]) <= 2;
      // At print resolution a one-pixel lifeline can straddle two pixels.
      const halfInk = lineInk.map((channel, i) => (channel + paper[i]) / 2);
      for (let y = 0; y < height; y++) {
        const row = offset + (rawHeight < 0 ? y : height - 1 - y) * width * 4;
        for (let x = 0; x < width; x++) {
          const at = row + x * 4;
          const blue = bmp[at], green = bmp[at + 1], red = bmp[at + 2], alpha = bmp[at + 3];
          if (alpha < 200) continue;
          if (near(red, green, blue, noteFill)) soft++;
          if (near(red, green, blue, lineInk) || near(red, green, blue, halfInk)) muted++;
        }
      }
      assert.ok(soft > 1000, `PDF 第一页应包含时序图注释底色，实际 ${soft} 像素`);
      assert.ok(muted > 20, `PDF 第一页应包含时序图线条与流程标签的灰色，实际 ${muted} 像素`);
      console.log(`STEP PDF print DOM carries all diagrams; rasterised page 1 has ${soft} note-fill and ${muted} diagram-line pixels`);
    } catch (error) {
      if (/sips|ENOENT|not found/i.test(String(error?.message || error)) && error?.code === 'ENOENT') {
        console.log('STEP PDF print DOM carries all diagrams (raster check skipped: sips unavailable)');
      } else throw error;
    }
  } else {
    console.log('STEP PDF print DOM carries all diagrams (raster check is macOS-only)');
  }

  // ── active-block preview ────────────────────────────────────────────────
  await page.locator('.md-widget pre.diagram[data-diagram="sequence"]').first().click({ position: { x: 8, y: 8 } });
  await page.waitForFunction(() => document.querySelector('.md-live-preview pre.diagram[data-diagram="sequence"] svg'));
  assert.equal(await page.evaluate(() => document.querySelector('.md-live-preview').isContentEditable), false);
  assert.equal(await page.locator('.md-live-preview-label').textContent(), '图表预览');
  const noteLine = page.locator('.cm-line').filter({ hasText: 'Note right of Bob' });
  await noteLine.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' ✓');
  await page.waitForFunction(() => {
    const preview = document.querySelector('.md-live-preview pre.diagram svg');
    return !!preview && [...preview.querySelectorAll('text')].some(node => node.textContent.includes('Bob thinks ✓'));
  });
  console.log('STEP sequence block previews while editing and follows a note edit');

  await page.locator('.md-widget pre.diagram[data-diagram="flow"]').first().click({ position: { x: 8, y: 8 } });
  await page.waitForFunction(() => document.querySelector('.md-live-preview pre.diagram[data-diagram="flow"] svg'));
  const noLine = page.locator('.cm-line').filter({ hasText: 'cond(no)->op' });
  await noLine.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' ???');
  await page.waitForFunction(() => document.querySelector('.md-live-preview .diagram-error-message')?.textContent.includes('图表渲染失败：流程图第'), null, { timeout: 20000 });
  const previewError = await page.evaluate(() => ({
    message: document.querySelector('.md-live-preview .diagram-error-message')?.textContent || '',
    source: document.querySelector('.md-live-preview')?.textContent || '',
    documentText: document.querySelector('.cm-content').textContent
  }));
  assert.match(previewError.message, /图表渲染失败：流程图第 \d+ 行/);
  assert.match(previewError.source, /cond\(no\)->op \?\?\?/, '错误的预览必须保留原 Markdown');
  assert.match(previewError.documentText, /cond\(no\)->op \?\?\?/, '错误输入不得丢弃文档内容');
  console.log('STEP flow block previews while editing and reports a readable Chinese error');

  // ── theme refresh ───────────────────────────────────────────────────────
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('dark');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForFunction(() => {
    const svg = document.querySelector('.md-widget pre.diagram[data-diagram="sequence"] svg');
    if (!svg) return false;
    const ink = getComputedStyle(document.body).color;
    return [...svg.querySelectorAll('path[stroke]')].some(node => getComputedStyle(node).stroke === ink);
  }, null, { timeout: 20000 });
  const refreshed = await page.evaluate(() => ({
    processed: [...document.querySelectorAll('.md-widget pre.diagram[data-processed="true"] svg')].length,
    texts: [...document.querySelectorAll('.md-widget pre.diagram[data-diagram="sequence"] svg text')].map(node => node.textContent)
  }));
  assert.ok(refreshed.processed >= 3, '切换主题后所有原生图表都应重新渲染');
  assert.ok(refreshed.texts.includes('Alice') && refreshed.texts.includes('Bob'), '主题切换不得丢失图表内容');
  console.log('STEP theme change re-renders native diagrams with the dark palette');

  assert.deepEqual(errors, []);
  console.log('PASS: sequence / flow fences in the reading view, errors, editing preview, theme refresh and offline HTML/PDF exports');
} finally {
  const closed = app.waitForEvent('close').catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closed;
  await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
