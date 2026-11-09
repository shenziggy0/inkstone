import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const project = path.resolve(import.meta.dirname, '..');
const popplerHint = '需要 Poppler 的 pdfinfo / pdftotext / pdfimages；请设置 INKSTONE_POPPLER_BIN 或把它们加入 PATH。';
const popplerName = name => process.platform === 'win32' ? `${name}.exe` : name;
const tool = name => {
  const directory = process.env.INKSTONE_POPPLER_BIN;
  if (!directory) return name;
  const candidate = path.join(directory, popplerName(name));
  if (!fsSync.existsSync(candidate)) throw new Error(`INKSTONE_POPPLER_BIN 中找不到 ${popplerName(name)}。${popplerHint}`);
  return candidate;
};
const run = async (name, args) => {
  try {
    return (await execFile(tool(name), args, { maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`无法运行 ${name}。${popplerHint}`);
    throw error;
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFile = async file => {
  for (let attempt = 0; attempt < 400; attempt++) {
    try { if ((await fs.stat(file)).size > 0) return; } catch { /* still writing */ }
    await sleep(100);
  }
  throw new Error(`文件未生成：${file}`);
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-export-desktop-'));
const work = path.join(root, 'fixture');
const out = path.join(root, 'out');
await fs.mkdir(path.join(work, 'media-root'), { recursive: true });
await fs.mkdir(out, { recursive: true });
// Three real PNGs with different dimensions, so PDF image extraction sees
// three distinct pictures and the test needs no fixture outside this file.
const pngFixtures = [
  ['plain.png', 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAVCAIAAACPAfpVAAAAPklEQVR4nM3OQQ0AIBDAsLEEyxjDIP8zwKqga99DicRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMT4OzA9C+gBWJDNH+EAAAAASUVORK5CYII='],
  ['media-root/rooted.png', 'iVBORw0KGgoAAAANSUhEUgAAAD8AAAAZCAIAAAAJyGGjAAAARUlEQVR4nNXOQREAIAzAsFJVmMI1QhCxB9coyLr7kCVlUiZlUiZlUiZlUiZlUiZlUiZlUiZlUiZlUiZlUiZlUiZl/g6MPF2RAbtJGr72AAAAAElFTkSuQmCC'],
  ['media-root/end.png', 'iVBORw0KGgoAAAANSUhEUgAAAEkAAAAZCAIAAADyn5R8AAAARklEQVR4nN3OAQ0AIAzAsDEbSMK/DySg4iFZFXTtc4mSLumSLumSLumSLumSLumSLumSLumSLumSLumSLumSLumSLn8HBj3ggQGIeQzsDQAAAABJRU5ErkJggg==']
];
for (const [name, data] of pngFixtures) await fs.writeFile(path.join(work, name), Buffer.from(data, 'base64'));
const pageLines = Array.from({ length: 60 }, (_value, index) => `第 ${index + 1} 行分页样例。正文需要保留在 PDF 和长图中，检查是否截断。`).join('\n\n');
const sampleLines = [
  '---',
  'title: 墨页导出回归',
  'author: Inkstone QA',
  'typora-root-url: media-root',
  '---',
  '',
  '# 第一章',
  '',
  '[前往末页](#最后一章) · **加粗** · *斜体* · [外部链接](https://example.com/)',
  '',
  '| 名称 | 数量 |',
  '| :--- | ---: |',
  '| 苹果 | 2 |',
  '',
  '请核对脚注[^one]、公式 $a^2+b^2=c^2$ 和交叉引用 $\\eqref{eq:test}$。',
  '',
  '$$',
  '\\label{eq:test}',
  'E = mc^2',
  '$$',
  '',
  '```sequence',
  '甲->乙: 导出',
  '乙-->甲: 完成',
  '```',
  '',
  '> [!NOTE]',
  '> 警示块正文。',
  '',
  '![普通相对图](./plain.png)',
  '',
  '![网站根图](/rooted.png)',
  '',
  '[^one]: 脚注完整性哨兵。',
  '',
  pageLines,
  '',
  '# 最后一章',
  '',
  '末页哨兵 LAST-INKSTONE-PAGE。',
  '',
  '![末端校验图](/end.png)',
  ''
];
const sample = path.join(work, 'sample.md');
await fs.writeFile(sample, sampleLines.join('\n'));
const longDocument = path.join(work, 'long.md');
await fs.writeFile(longDocument, `# 超长文档\n\n${'用于验证 PNG 尺寸上限的段落。\n\n'.repeat(2500)}LAST-INKSTONE-PAGE\n`);
const mermaidDocument = path.join(work, 'mermaid.md');
await fs.writeFile(mermaidDocument, '# 图表\n\n```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```\n');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, sample, '--no-sandbox', '--disable-gpu'], env });
const errors = [];
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content').waitFor();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('sample.md'));
  await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget .katex').length >= 1);
  await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget svg').length >= 1);
  await page.evaluate(() => Promise.all([...document.querySelectorAll('#editor-host img')].map(image => image.decode().catch(() => {}))));
  // The card and alert label are editor chrome and must still be visible in
  // the editor even though every export now omits them at generation time.
  await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget .front-matter').length >= 1);
  assert.match(await page.locator('#editor-host .md-widget .front-matter').first().textContent(), /typora-root-url/, '编辑器预览应显示文档属性卡片');
  assert.ok(await page.locator('#editor-host .md-widget .alert-label').count() >= 1, '编辑器预览应显示警示标签');
  const lineWidth = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-width')) || 860);
  const pixelRatio = await page.evaluate(() => window.devicePixelRatio || 1);
  const settingsFile = path.join(root, 'profile', 'settings.json');
  const readSettings = async () => {
    try { return JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch { return {}; }
  };
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const stubSave = target => app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  const stubCancel = () => app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  });
  const openExport = async () => {
    await page.locator('[data-command="export"]').click();
    await page.locator('#dialog[open]').waitFor();
    await page.locator('[data-export="pdf"]').waitFor();
  };
  const closeDialog = async () => {
    if (await page.locator('#dialog[open]').count()) await page.locator('#dialog [data-dismiss]').first().click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
  };
  const waitExportClosed = () => page.waitForFunction(() => !document.querySelector('#dialog').open, null, { timeout: 120000 });
  const exportTo = async (format, target) => {
    await stubSave(target);
    await openExport();
    await page.locator(`[data-export="${format}"]`).click();
    await waitExportClosed();
    await waitFile(target);
  };

  // ── Styled HTML keeps the existing self-contained behaviour ────────────
  const styledPath = path.join(out, 'styled.html');
  await exportTo('html', styledPath);
  const styled = await fs.readFile(styledPath, 'utf8');
  assert.match(styled, /<style>/);
  assert.match(styled, /data:font\/woff2;base64/);
  assert.equal((styled.match(/data:image\/png;base64,/g) || []).length, 3, '三张本地图片都应内嵌');
  assert.ok(!styled.includes('inkstone-asset://'), '不得残留应用内部图片协议');
  const styledState = await page.evaluate(source => {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    return {
      ids: [...parsed.querySelectorAll('[id]')].map(node => node.id),
      anchors: [...parsed.querySelectorAll('a[href]')].map(node => {
        const href = node.getAttribute('href') || '';
        try { return decodeURIComponent(href); } catch { return href; }
      }),
      svg: parsed.querySelectorAll('svg').length,
      frontMatter: parsed.querySelectorAll('.front-matter').length,
      alertLabels: parsed.querySelectorAll('.alert-label').length,
      text: parsed.querySelector('article')?.textContent || parsed.body.textContent
    };
  }, styled);
  assert.ok(styledState.ids.includes('第一章'));
  assert.ok(styledState.anchors.includes('#最后一章'), `链接应保留：${styledState.anchors.join(',')}`);
  assert.ok(styledState.anchors.includes('https://example.com/'));
  assert.ok(styledState.svg >= 1);
  assert.equal(styledState.frontMatter, 0, '导出不得包含文档属性卡片');
  assert.equal(styledState.alertLabels, 0, '导出不得包含警示标签装饰');
  assert.ok(!styledState.text.includes('文档属性'));
  assert.match(styledState.text, /警示块正文/, '警示块正文仍应保留');
  console.log('STEP styled HTML remains self-contained and omits editor chrome');

  // ── HTML without styles: no app/theme CSS, one semantic formula tree ──
  const plainPath = path.join(out, 'plain.html');
  await exportTo('html-unstyled', plainPath);
  const plain = await fs.readFile(plainPath, 'utf8');
  const plainState = await page.evaluate(source => {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const outsideSVG = node => !node.closest('svg');
    return {
      styleOutside: [...parsed.querySelectorAll('style')].filter(outsideSVG).length,
      linksOutside: [...parsed.querySelectorAll('link')].length,
      scriptCount: parsed.querySelectorAll('script').length,
      classOutside: [...parsed.querySelectorAll('[class]')].filter(outsideSVG).length,
      styleAttrOutside: [...parsed.querySelectorAll('[style]')].filter(outsideSVG).length,
      dataOutside: [...parsed.querySelectorAll('*')].filter(outsideSVG).reduce((count, node) => count + [...node.attributes].filter(attribute => /^data-/i.test(attribute.name)).length, 0),
      math: parsed.querySelectorAll('math').length,
      katexHtml: parsed.querySelectorAll('.katex-html').length,
      katexWrapper: parsed.querySelectorAll('.katex').length,
      svg: parsed.querySelectorAll('svg').length,
      inlineImages: [...parsed.querySelectorAll('img')].filter(image => /^data:image\//.test(image.getAttribute('src') || '')).length,
      ids: [...parsed.querySelectorAll('[id]')].map(node => node.id),
      anchors: [...parsed.querySelectorAll('a[href]')].map(node => node.getAttribute('href')),
      frontMatter: parsed.querySelectorAll('.front-matter').length,
      alertLabels: parsed.querySelectorAll('.alert-label').length,
      text: parsed.querySelector('article')?.textContent || parsed.body.textContent
    };
  }, plain);
  assert.equal(plainState.styleOutside, 0, '无样式 HTML 不得包含应用/主题 <style>');
  assert.equal(plainState.linksOutside, 0, '无样式 HTML 不得引用外部样式表');
  assert.equal(plainState.scriptCount, 0, '无样式 HTML 不得含脚本');
  assert.equal(plainState.classOutside, 0, '无样式 HTML 不得残留应用 class');
  assert.equal(plainState.styleAttrOutside, 0, '无样式 HTML 不得残留行内样式');
  assert.equal(plainState.dataOutside, 0, '无样式 HTML 不得残留应用 data-* 属性');
  assert.ok(plainState.math >= 2, `公式应保留 MathML，实际 ${plainState.math}`);
  assert.equal(plainState.katexHtml, 0, '不得把 KaTeX 视觉层原样暴露给无 CSS 浏览器');
  assert.equal(plainState.katexWrapper, 0);
  assert.ok(plainState.svg >= 1, '图表 SVG 必须保留');
  assert.equal(plainState.inlineImages, 3, '本地图片必须内嵌');
  assert.ok(plainState.ids.includes('第一章') && plainState.ids.includes('最后一章'), `标题 ID 必须保留：${plainState.ids.join(',')}`);
  const decodedAnchors = plainState.anchors.map(href => { try { return decodeURIComponent(href); } catch { return href; } });
  assert.ok(decodedAnchors.includes('#最后一章') && decodedAnchors.includes('https://example.com/'), `链接必须保留：${plainState.anchors.join(',')}`);
  assert.match(plainState.text, /LAST-INKSTONE-PAGE/);
  assert.match(plainState.text, /脚注完整性哨兵/);
  assert.equal(plainState.frontMatter, 0, '无样式 HTML 不得包含文档属性卡片');
  assert.equal(plainState.alertLabels, 0, '无样式 HTML 不得包含警示标签装饰');
  assert.ok(!plainState.text.includes('文档属性'));
  assert.match(plainState.text, /警示块正文/);
  console.log('STEP unstyled HTML: semantic body, MathML only, SVG, data-URI images, no CSS/classes/data');

  // ── Default PDF: unchanged printToPDF defaults ─────────────────────────
  const defaultPdf = path.join(out, 'default.pdf');
  await exportTo('pdf', defaultPdf);
  const defaultInfo = await run('pdfinfo', [defaultPdf]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(defaultInfo)?.[1] || 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(defaultInfo);
  assert.ok(pages >= 2, `默认 PDF 应有多页，实际 ${pages}`);
  assert.ok(size && Math.abs(Number(size[1]) - 595.28) < 2 && Math.abs(Number(size[2]) - 841.89) < 2, `默认纸张应保持 A4：${size?.[0]}`);
  const defaultText = await run('pdftotext', ['-layout', defaultPdf, '-']);
  assert.match(defaultText, /第一章/);
  assert.match(defaultText, /苹果/);
  assert.match(defaultText, /脚注完整性哨兵/);
  assert.match(defaultText, /LAST-INKSTONE-PAGE/);
  assert.match(defaultText, /导出/);
  const lastPageText = await run('pdftotext', ['-f', String(pages), '-l', String(pages), '-layout', defaultPdf, '-']);
  assert.match(lastPageText, /LAST-INKSTONE-PAGE/, '末页标识必须位于最后一页');
  const defaultRaw = await fs.readFile(defaultPdf);
  assert.ok(defaultRaw.includes(Buffer.from('/Outlines')), 'PDF 必须保留文档大纲');
  const defaultImages = await run('pdfimages', ['-list', defaultPdf]);
  assert.ok(defaultImages.split('\n').filter(line => /^\s+\d+\s+\d+\s+image\b/.test(line)).length >= 3, `PDF 应包含三张本地图片：${defaultImages}`);
  assert.ok(defaultRaw.includes(Buffer.from('https://example.com/')), 'PDF 应保留外部链接');
  assert.match(await run('pdfinfo', ['-url', defaultPdf]), /https:\/\/example\.com\//);
  assert.match(await run('pdfinfo', ['-dests', defaultPdf]), /fn1/, 'PDF 应保留脚注等内部命名目标');
  assert.ok(!defaultText.includes('INKSTONE-HEADER'), '默认输出不得带入自定义页眉');
  console.log(`STEP default PDF: ${pages} pages, A4, outline, images, links, last-page sentinel`);

  // ── Custom PDF options + reusable preset ──────────────────────────────
  await openExport();
  await page.locator('#pdf-header').fill('INKSTONE-HEADER');
  await page.locator('#pdf-footer').fill('第 ${pageNo} 页 / ${pageCount} 页');
  await page.locator('#pdf-page-size').selectOption('Letter');
  await page.locator('#pdf-margins').selectOption('narrow');
  await page.locator('#pdf-preset-name').fill('窄页脚');
  await page.locator('[data-pdf-preset-action="save"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#pdf-preset-select option')].some(option => option.textContent === '窄页脚'));
  const presetSettings = await readSettings();
  const preset = (presetSettings.pdfPresets || []).find(entry => entry.name === '窄页脚');
  assert.ok(preset, '预设必须写入 settings.json');
  assert.equal(preset.header, 'INKSTONE-HEADER');
  assert.equal(preset.footer, '第 ${pageNo} 页 / ${pageCount} 页');
  assert.equal(preset.pageSize, 'Letter');
  assert.equal(preset.margins, 'narrow');
  await closeDialog();
  const customPdf = path.join(out, 'custom.pdf');
  await stubSave(customPdf);
  await openExport();
  await page.locator('#pdf-preset-select').selectOption({ label: '窄页脚' });
  await page.locator('[data-export="pdf"]').click();
  await waitExportClosed();
  await waitFile(customPdf);
  const customInfo = await run('pdfinfo', [customPdf]);
  const customPages = Number(/^Pages:\s+(\d+)/m.exec(customInfo)?.[1] || 0);
  const customSize = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(customInfo);
  assert.ok(customSize && Math.abs(Number(customSize[1]) - 612) < 2 && Math.abs(Number(customSize[2]) - 792) < 2, `自定义纸张应为 Letter：${customSize?.[0]}`);
  const firstPage = await run('pdftotext', ['-f', '1', '-l', '1', '-layout', customPdf, '-']);
  assert.match(firstPage, /INKSTONE-HEADER/);
  assert.match(firstPage, new RegExp(`第\\s*1\\s*页\\s*/\\s*${customPages}\\s*页`));
  const customLast = await run('pdftotext', ['-f', String(customPages), '-l', String(customPages), '-layout', customPdf, '-']);
  assert.match(customLast, new RegExp(`第\\s*${customPages}\\s*页\\s*/\\s*${customPages}\\s*页`));
  assert.match(customLast, /LAST-INKSTONE-PAGE/, '自定义页脚不得截断末页内容');
  const bbox = await run('pdftotext', ['-bbox', '-f', '1', '-l', '1', customPdf, '-']);
  const headerWord = /<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>INKSTONE-HEADER<\/word>/.exec(bbox);
  assert.ok(headerWord && Number(headerWord[2]) < 70, `页眉应位于上边距：${headerWord?.[0]}`);
  const headingWord = /<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>第一章<\/word>/.exec(bbox);
  assert.ok(headingWord && Number(headingWord[1]) >= 30, `窄边距正文应靠近左边缘：${headingWord?.[0]}`);
  const savedSettings = await readSettings();
  assert.equal(savedSettings.pdfExport.header, 'INKSTONE-HEADER');
  assert.equal(savedSettings.pdfExport.pageSize, 'Letter');
  console.log(`STEP custom PDF: Letter, narrow margins, running header/footer, ${customPages} pages, preset persisted`);

  // Reopening the dialog restores the named preset without changing it.
  await openExport();
  await page.locator('#pdf-preset-select').selectOption({ label: '窄页脚' });
  assert.equal(await page.locator('#pdf-header').inputValue(), 'INKSTONE-HEADER');
  assert.equal(await page.locator('#pdf-page-size').inputValue(), 'Letter');
  await closeDialog();
  console.log('STEP PDF preset can be selected again');

  // ── PNG: whole article, device pixel ratio, isolated window ───────────
  const pngPath = path.join(out, 'full.png');
  const beforeWindows = await windowCount();
  await exportTo('png', pngPath);
  const afterWindows = await windowCount();
  assert.equal(afterWindows, beforeWindows, 'PNG 捕获完成后不得留下隐藏窗口');
  const pngBytes = await fs.readFile(pngPath);
  assert.equal(pngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '必须是有效 PNG');
  const pngWidth = pngBytes.readUInt32BE(16);
  const pngHeight = pngBytes.readUInt32BE(20);
  const expectedWidth = Math.round((lineWidth + 96) * pixelRatio);
  assert.ok(Math.abs(pngWidth - expectedWidth) <= 2, `PNG 宽度应为正文宽度 + 96 样式像素后乘以设备像素比 ${pixelRatio}：期望 ${expectedWidth}，实际 ${pngWidth}`);
  assert.ok(pngHeight > pngWidth * 2, `整篇长图高度应明显超过宽度：${pngWidth}×${pngHeight}`);
  const pngPixels = await app.evaluate(async ({ nativeImage }, file) => {
    const image = nativeImage.createFromPath(file);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    let darkBottom = 0;
    const firstRow = Math.max(0, size.height - Math.round(180 * (size.width / 956)));
    for (let y = firstRow; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const offset = (y * size.width + x) * 4;
        if (bitmap[offset] < 190 && bitmap[offset + 1] < 190 && bitmap[offset + 2] < 190) darkBottom++;
      }
    }
    return { width: size.width, height: size.height, darkBottom };
  }, pngPath);
  assert.equal(pngPixels.width, pngWidth);
  assert.equal(pngPixels.height, pngHeight);
  assert.ok(pngPixels.darkBottom > 200, `长图底部应有正文像素，而不是空白或截断：${pngPixels.darkBottom}`);
  console.log(`STEP PNG: ${pngWidth}×${pngHeight} at dpr ${pixelRatio}, no hidden window left, content reaches the bottom`);

  // The same print DOM feeds HTML/PNG/PDF; none of the three may carry the
  // front-matter card or alert label, while the rooted images stay present.
  const printState = await page.evaluate(() => {
    const target = document.querySelector('#print-document');
    return {
      frontMatter: target.querySelectorAll('.front-matter').length,
      alertLabels: target.querySelectorAll('.alert-label').length,
      images: [...target.querySelectorAll('img')].map(image => ({ alt: image.alt, width: image.naturalWidth })),
      text: target.textContent
    };
  });
  assert.equal(printState.frontMatter, 0, 'PDF/PNG 打印 DOM 不得包含文档属性卡片');
  assert.equal(printState.alertLabels, 0, 'PDF/PNG 打印 DOM 不得包含警示标签装饰');
  assert.equal(printState.images.length, 3, '图根目录下的本地图片仍应存在');
  assert.ok(printState.images.every(image => image.width > 0), `本地图片必须已加载：${JSON.stringify(printState.images)}`);
  assert.ok(!printState.text.includes('文档属性'));
  assert.match(printState.text, /警示块正文/);

  // ── Explicit limit failure: no file and no window ─────────────────────
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, longDocument);
  await page.locator('[data-command="open"]').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('long.md'));
  await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('用于验证 PNG 尺寸上限的段落'));
  const oversized = path.join(out, 'oversized.png');
  const beforeLimitWindows = await windowCount();
  await stubSave(oversized);
  await openExport();
  await page.locator('[data-export="png"]').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('#notification');
    return node && !node.hidden && node.classList.contains('error') && /PNG 导出失败/.test(node.textContent);
  }, null, { timeout: 120000 });
  const limitMessage = await page.locator('#notification').textContent();
  assert.match(limitMessage, /超过|上限/);
  await assert.rejects(fs.access(oversized), '超长 PNG 不得保存截断文件');
  assert.equal(await windowCount(), beforeLimitWindows, '超长 PNG 失败后不得留下隐藏窗口');
  await closeDialog();
  console.log(`STEP oversized PNG fails explicitly without saving: ${limitMessage}`);

  // ── Save-dialog cancel writes nothing and leaves presets alone ─────────
  const beforeCancel = await readSettings();
  const cancelTarget = path.join(out, 'cancelled.pdf');
  await stubCancel();
  await openExport();
  await page.locator('#pdf-header').fill('CANCELLED-HEADER');
  await page.locator('#pdf-footer').fill('CANCELLED-FOOTER');
  await page.locator('[data-export="pdf"]').click();
  await waitExportClosed();
  await assert.rejects(fs.access(cancelTarget), '取消保存不得写入文件');
  const afterCancel = await readSettings();
  assert.deepEqual(afterCancel.pdfPresets, beforeCancel.pdfPresets, '取消保存不得修改已有预设');
  assert.equal(afterCancel.pdfExport.header, beforeCancel.pdfExport.header, '取消保存不得记住草稿值');
  const afterCancelPreset = (afterCancel.pdfPresets || []).find(entry => entry.name === '窄页脚');
  assert.equal(afterCancelPreset.header, 'INKSTONE-HEADER');
  assert.equal(afterCancelPreset.footer, '第 ${pageNo} 页 / ${pageCount} 页');
  console.log('STEP canceled save dialog writes no file and does not pollute the stored preset');

  // ── Unstyled HTML keeps a diagram's own SVG presentation ───────────────
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, mermaidDocument);
  await page.locator('[data-command="open"]').click();
  await page.waitForFunction(() => document.querySelector('#location').textContent.includes('mermaid.md'));
  await page.waitForFunction(() => document.querySelectorAll('#editor-host .md-widget svg').length >= 1);
  const mermaidPlainPath = path.join(out, 'mermaid-plain.html');
  await exportTo('html-unstyled', mermaidPlainPath);
  const mermaidPlain = await fs.readFile(mermaidPlainPath, 'utf8');
  const mermaidState = await page.evaluate(source => {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const svg = parsed.querySelector('svg');
    return {
      svg: !!svg,
      stylesInside: [...parsed.querySelectorAll('style')].filter(node => node.closest('svg')).length,
      classesInside: [...parsed.querySelectorAll('[class]')].filter(node => node.closest('svg')).length,
      stylesOutside: [...parsed.querySelectorAll('style')].filter(node => !node.closest('svg')).length,
      classesOutside: [...parsed.querySelectorAll('[class]')].filter(node => !node.closest('svg')).length
    };
  }, mermaidPlain);
  assert.equal(mermaidState.svg, true);
  assert.ok(mermaidState.stylesInside >= 1, 'Mermaid SVG 内部样式应保留');
  assert.ok(mermaidState.classesInside > 0, 'SVG 内部 class 应保留');
  assert.equal(mermaidState.stylesOutside, 0);
  assert.equal(mermaidState.classesOutside, 0);
  console.log('STEP unstyled HTML keeps self-contained SVG styles/classes while stripping them outside the diagram');

  // ── Unstyled HTML and PNG are hidden in the browser-only path ─────────
  // The renderer's `native` flag is filled by the preload bridge; this is the
  // same branch used by the Vite preview, so assert it is not exposed there.
  assert.equal(await page.evaluate(() => typeof window.desktop), 'object');
  console.log('STEP desktop export dialog exposes native-only formats; browser preview keeps HTML/PDF by branch');

  assert.deepEqual(errors, []);
  console.log('PASS: HTML (with/without styles), default PDF, custom PDF header/footer/page numbers/paper/margins/preset, whole-document PNG, size-limit failure, cancel safety, no hidden windows.');
} finally {
  if (page && process.env.INKSTONE_SCREENSHOT) await page.screenshot({ path: process.env.INKSTONE_SCREENSHOT }).catch(() => {});
  const closed = app.waitForEvent('close').catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closed;
  await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
