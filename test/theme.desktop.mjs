import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Focused Electron check for the Typora CSS loader. The real GitHub / Night /
// Newsprint files are exercised by an out-of-tree run; this committed fixture is
// a self-authored minimal theme with the same shape (local import, woff2,
// #write, body, headings, links, code, table, quote, background/foreground and
// a rejected remote URL).
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-theme-desktop-'));
const project = path.resolve(import.meta.dirname, '..');
const themes = path.join(root, 'profile', 'themes');
await fs.mkdir(path.join(themes, 'parts'), { recursive: true });
await fs.mkdir(path.join(themes, 'fonts'), { recursive: true });
const bundledFont = path.join(project, 'node_modules', 'katex', 'dist', 'fonts', 'KaTeX_Main-Regular.woff2');
try {
  await fs.copyFile(bundledFont, path.join(themes, 'fonts', 'fixture.woff2'));
} catch {
  await fs.writeFile(path.join(themes, 'fonts', 'fixture.woff2'), 'fixture-font');
}
await fs.writeFile(path.join(themes, 'parts', 'extra.css'), ':root { --mermaid-theme: fixture; }\n');
await fs.writeFile(path.join(themes, 'fixture.css'), `@import "./parts/extra.css";
@font-face { font-family: 'Fixture Serif'; src: url('./fonts/fixture.woff2') format('woff2'); }
:root { --bg-color: #f4f1ea; --text-color: #1c2a30; }
html { font-size: 16px; }
body { font-family: 'Fixture Serif', Georgia, serif; color: var(--text-color); background: var(--bg-color); line-height: 1.7; }
#write { max-width: 720px; }
#write h1 { font-size: 2.4em; color: #183a4a; border-bottom: 2px solid #bcd; }
#write a { color: #0a6ea8; }
#write pre { background: #e7e0d5; border: 1px solid #c9c1b4; }
#write table { border-collapse: collapse; }
#write th, #write td { border: 1px solid #c9c1b4; padding: 4px 8px; }
#write blockquote { border-left: 5px solid #b0a38e; color: #4a5b62; font-style: italic; }
.remote { background: url(https://example.invalid/theme.png); }
`);
await fs.writeFile(path.join(themes, 'slow.css'), ':root { --theme-order: slow; }\n');
await fs.writeFile(path.join(themes, 'fast.css'), ':root { --theme-order: fast; }\n');
await fs.writeFile(path.join(themes, 'legacy.css'), `.topbar { color: rgb(9, 8, 7); }
.prose { --qa-legacy-color: rgb(21, 20, 19); }
.prose p { background-image: URL("data:image/png;base64,AA"); }
`);

const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.cm-content').waitFor();
  assert.equal(await page.locator('#write').count(), 1, '#write must be the CodeMirror content column');
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# 主题标题\n\n正文与[链接](https://example.com/)。\n\n> 引用一段\n\n```js\nconst theme = true;\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 值 | 值 |\n');
  await page.locator('.md-widget h1').waitFor();
  await page.locator('.md-widget pre').waitFor();
  await page.locator('.md-widget table').waitFor();
  await page.locator('.md-widget blockquote').waitFor();

  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('custom:fixture.css');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#custom-theme')?.textContent.includes('Fixture Serif'));
  await page.evaluate(() => document.fonts.ready);

  const themeState = await page.evaluate(() => {
    const content = document.querySelector('#write');
    const editor = document.querySelector('.cm-editor');
    const h1 = document.querySelector('.md-widget h1');
    const link = document.querySelector('.md-widget a');
    const pre = document.querySelector('.md-widget pre');
    const table = document.querySelector('.md-widget table');
    const quote = document.querySelector('.md-widget blockquote');
    const widget = document.querySelector('.md-widget');
    const style = document.querySelector('#custom-theme')?.textContent || '';
    return {
      contentId: content?.id,
      contentWidth: getComputedStyle(content).maxWidth,
      editorFont: getComputedStyle(editor).fontFamily,
      editorBackground: getComputedStyle(editor).backgroundColor,
      contentColor: getComputedStyle(content).color,
      h1Size: getComputedStyle(h1).fontSize,
      h1Color: getComputedStyle(h1).color,
      h1Border: getComputedStyle(h1).borderBottomWidth,
      linkColor: getComputedStyle(link).color,
      preBackground: getComputedStyle(pre).backgroundColor,
      tableBorder: getComputedStyle(table.querySelector('td')).borderTopWidth,
      quoteBorder: getComputedStyle(quote).borderLeftWidth,
      widgetPadding: parseFloat(getComputedStyle(widget).paddingBottom),
      writeSurface: document.querySelector('#print-document').classList.contains('write-surface'),
      mappedSurface: style.includes(':is(#write, .write-surface)') && !style.includes(':is(#write, .prose)'),
      fontRule: style.includes('data:font/woff2;base64,'),
      importRule: style.includes('--mermaid-theme:fixture'),
      remoteRule: /https?:/i.test(style),
      scopedOffChrome: style.includes('body{') === false
    };
  });
  assert.equal(themeState.contentId, 'write');
  assert.equal(themeState.contentWidth, '720px');
  assert.match(themeState.editorFont, /Fixture Serif/);
  assert.equal(themeState.editorBackground, 'rgb(244, 241, 234)');
  assert.equal(themeState.contentColor, 'rgb(28, 42, 48)');
  assert.equal(themeState.h1Size, '38.4px');
  assert.equal(themeState.h1Color, 'rgb(24, 58, 74)');
  assert.equal(themeState.h1Border, '2px');
  assert.equal(themeState.linkColor, 'rgb(10, 110, 168)');
  assert.equal(themeState.preBackground, 'rgb(231, 224, 213)');
  assert.equal(themeState.tableBorder, '1px');
  assert.equal(themeState.quoteBorder, '5px');
  assert.ok(themeState.widgetPadding < 25, 'document container padding must not land on every block');
  assert.equal(themeState.writeSurface, true, 'export/print article must be the single #write surface');
  assert.equal(themeState.mappedSurface, true, '#write layout must not map to every .prose block');
  assert.equal(themeState.fontRule, true, 'the local woff2 must be embedded');
  assert.equal(themeState.importRule, true, 'the local @import must be inlined');
  assert.equal(themeState.remoteRule, false, 'remote CSS resources must not survive');
  assert.equal(themeState.scopedOffChrome, true, 'body rules must not be emitted unscoped');
  assert.ok(await page.locator('.topbar').isVisible(), 'topbar must stay visible');
  await page.locator('.topbar [data-command="sidebar"]').click();
  assert.ok(await page.locator('.sidebar').isVisible(), 'theme CSS must not hide the sidebar');
  await page.locator('.topbar [data-command="sidebar"]').click();

  // The active editing paragraph inherits the theme body font, colour and
  // line-height. (A single-line heading intentionally stays at body size while
  // the caret is inside it, so the theme's h1 size is a preview/print feature.)
  const paragraphPoint = await page.evaluate(() => {
    const paragraph = document.querySelector('.md-widget p');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 3, y: rect.top + rect.height / 2 };
  });
  await page.locator('.md-widget p').first().scrollIntoViewIfNeeded();
  await page.mouse.click(paragraphPoint.x, paragraphPoint.y);
  await page.locator('.cm-line.cm-live-line').waitFor();
  const liveParagraph = await page.evaluate(() => {
    const line = document.querySelector('.cm-line.cm-live-line');
    return {
      font: getComputedStyle(line).fontFamily,
      color: getComputedStyle(line).color,
      leading: getComputedStyle(document.querySelector('.cm-scroller')).lineHeight
    };
  });
  assert.match(liveParagraph.font, /Fixture Serif/);
  assert.equal(liveParagraph.color, 'rgb(28, 42, 48)');
  assert.equal(liveParagraph.leading, '27.2px');

  // Styled HTML, PDF and PNG exports collect the same embedded theme CSS.
  const htmlPath = path.join(root, 'fixture.html');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, htmlPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="html"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.match(html, /data:font\/woff2;base64/);
  assert.match(html, /--inkstone-theme-paper:\s*var\(--bg-color\)/);
  assert.doesNotMatch(html, /https:\/\/example\.invalid/);

  const pdfPath = path.join(root, 'fixture.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="pdf"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.equal((await fs.readFile(pdfPath)).subarray(0, 4).toString(), '%PDF');

  const pngPath = path.join(root, 'fixture.png');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pngPath);
  await page.locator('[data-command="export"]').click();
  await page.locator('[data-export="png"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.equal((await fs.readFile(pngPath)).subarray(1, 4).toString(), 'PNG');

  // Switching back to a built-in theme removes the custom sheet completely.
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('light');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#custom-theme'));
  const restored = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor,
    h1: getComputedStyle(document.querySelector('.md-widget h1')).color
  }));
  assert.equal(restored.theme, 'light');
  assert.equal(restored.background, 'rgb(255, 255, 255)');
  assert.equal(restored.h1, 'rgb(51, 51, 51)');

  // Existing native-app custom CSS keeps targeting the real top bar, and a
  // `.prose p` selector keeps applying to the rendered blocks without a nested
  // wrapper. A data URL is never wrapped a second time, regardless of case.
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('custom:legacy.css');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#custom-theme')?.textContent.includes('.topbar'));
  const legacy = await page.evaluate(() => ({
    topbar: getComputedStyle(document.querySelector('.topbar')).color,
    style: document.querySelector('#custom-theme').textContent
  }));
  assert.equal(legacy.topbar, 'rgb(9, 8, 7)');
  assert.doesNotMatch(legacy.style, /url\(["']URL\(/);

  // A slow read for the previous theme must not overwrite the newer choice.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('inkstone:readTheme');
    ipcMain.handle('inkstone:readTheme', async (_event, name) => {
      await new Promise(resolve => setTimeout(resolve, name === 'slow.css' ? 800 : 20));
      return { ok: true, value: `:root { --theme-order: ${name === 'slow.css' ? 'slow' : 'fast'}; }` };
    });
  });
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('custom:slow.css');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences select[name="theme"]').selectOption('custom:fast.css');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForTimeout(1100);
  const race = await page.locator('#custom-theme').textContent();
  assert.match(race, /theme-order: fast/, 'the newest theme read must win');
  assert.doesNotMatch(race, /slow/);
  console.log('PASS: Typora CSS theme scoping, local imports/fonts, editor/preview/print styles, HTML/PDF/PNG and ordered switching');
} finally {
  const closed = app.waitForEvent('close').catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closed;
  await app.close().catch(() => {});
  if (errors.length) console.error('Renderer errors:', errors);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
assert.deepEqual(errors, []);
