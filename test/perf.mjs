/**
 * Typing and scrolling benchmark for the live (typeset) preview.
 *
 * Repeats the measurement the iteration-11 audit used: open a document made of
 * identical fragments, click into the first paragraph so that block becomes
 * editable, then press a key and wait for the renderer to be idle N times.
 * Each sample therefore covers the whole synchronous chain of one keystroke —
 * CodeMirror, the decoration rebuild, the whole-document preview render, and
 * every DOM update the app performs around them.
 *
 * The editor publishes its layout on `.cm-editor[data-inkstone-layout]`:
 * `typeset` (live preview), `source` (the user chose source mode), or
 * `source-fallback` (the document is past the live-preview size limit). The
 * benchmark reports the state instead of waiting forever for a widget that a
 * fallback document will never build.
 *
 *   node test/perf.mjs                     # 5k / 30k / 100k / 220k characters
 *   node test/perf.mjs --sizes=5000,220000 # a subset
 *   node test/perf.mjs --keys=20           # samples per size (default 20)
 *
 * Thresholds, recorded before this batch was measured:
 *   - 5k and 30k: average ≤ 50 ms per key, no reproducible regression.
 *   - 100k and 220k while typeset: average ≤ 150 ms per key.
 *   - 220k must scroll to both the first and the last line; duration and long
 *     tasks are recorded even when the document is on the source fallback.
 * A document on the source fallback is reported as `fallback`, not silently
 * treated as a pass: the fallback may only be removed once 220k typeset
 * measurements meet the threshold repeatedly.
 *
 * The script exits 1 on a regression no machine noise explains: an average
 * above three times the target for a typeset size, a diagram rebuilt by typing
 * above it, or a 220k document that cannot reach the top/bottom of the file.
 *
 *   node test/perf.mjs --report-only   # never fail, just print the tables
 *
 * It is not part of CI: hosted runners are slower and noisier than a desktop.
 */
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const argument = name => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const sizes = (argument('sizes') || '5000,30000,100000,220000').split(',').map(Number).filter(Boolean);
const keys = Number(argument('keys') || 20);
const targets = { 5000: 50, 30000: 50, 100000: 150, 220000: 150 };
// Hard limit = 3x the target: wide enough for a busy machine, tight enough to
// catch a return of whole-document re-rendering on every keystroke.
const LIMIT_FACTOR = 3;
const reportOnly = process.argv.includes('--report-only');
const failures = [];

/** One repeatable fragment: a heading, a paragraph with inline syntax, a list. */
const fragment = n => `## 第 ${n} 节\n\n这一段包含 **粗体**、\`代码\`、[链接](https://a.b) 的中文正文。\n\n- 列表项一\n- 列表项二\n\n`;
function documentOfSize(size) {
  let text = '', index = 0;
  while (text.length < size) text += fragment(++index);
  return text;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-perf-'));
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
const results = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layoutOf = () => page.evaluate(() => {
    const editor = document.querySelector('.cm-editor');
    return {
      layout: editor?.dataset.inkstoneLayout || 'unknown',
      length: Number(editor?.dataset.inkstoneLength || 0),
      widgets: document.querySelectorAll('.md-widget').length,
      liveLines: document.querySelectorAll('.cm-live-line').length,
      position: document.querySelector('#position')?.textContent || ''
    };
  });
  const resetLongTasks = () => page.evaluate(() => {
    window.__longTasks = [];
    if (!window.__longTaskObserver) {
      window.__longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
      });
      window.__longTaskObserver.observe({ entryTypes: ['longtask'] });
    }
  });
  const takeLongTasks = async () => {
    await page.waitForTimeout(60);
    return page.evaluate(() => window.__longTasks.splice(0));
  };
  const open = async target => {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, target);
    await page.locator('[data-command="open"]').click();
    await page.waitForFunction(name => document.querySelector('#location').textContent.includes(name), path.basename(target));
    // Either layout is a valid document state. Waiting for the marker, not a
    // widget, is what makes the 220k source fallback observable at all.
    await page.waitForFunction(() => {
      const editor = document.querySelector('.cm-editor');
      const layout = editor?.dataset.inkstoneLayout;
      if (!editor || !layout) return false;
      if (layout === 'typeset') return document.querySelectorAll('.md-widget').length > 0;
      return Number(editor.dataset.inkstoneLength) > 0;
    }, null, { timeout: 180000 });
    await frame();
    return layoutOf();
  };

  await page.locator('.cm-content').waitFor();
  for (const size of sizes) {
    const file = path.join(root, `perf-${size}.md`);
    await fs.writeFile(file, documentOfSize(size));
    const layoutState = await open(file);
    // Interacting with the document switches it from the reading view to the
    // active-block layout, which is what a user typing actually pays for.
    if (layoutState.layout === 'typeset') {
      await page.locator('.md-widget p').first().click();
      await page.waitForFunction(() => document.querySelectorAll('.cm-live-line').length > 0, null, { timeout: 180000 });
    } else {
      // Source mode and the large-document fallback both show real `.cm-line`
      // elements; the first paragraph is visible at the top of either.
      await page.locator('.cm-line').filter({ hasText: '这一段包含' }).first().click();
    }
    await frame();
    await resetLongTasks();
    const samples = [];
    for (let index = 0; index < keys; index++) {
      const letter = String.fromCharCode(97 + (index % 26));
      const started = performance.now();
      await page.keyboard.press(letter);
      // Round-trip the page so the measurement includes everything the
      // keystroke triggered, not just the input event dispatch.
      await page.evaluate(() => 1);
      samples.push(performance.now() - started);
    }
    await frame();
    const typingTasks = await takeLongTasks();
    const afterTyping = await layoutOf();

    // Fixed scroll actions: the same two commands a user has for the ends of
    // the document, then a fixed five-wheel-step scroll. The jump timings
    // include the layout rebuild that moving the caret to an extreme triggers.
    const scroll = {};
    const jump = async (shortcut, check) => {
      await resetLongTasks();
      const started = performance.now();
      await page.keyboard.press(shortcut);
      await page.evaluate(() => 1);
      await page.waitForFunction(check, null, { timeout: 180000, polling: 'raf' });
      await frame();
      const elapsed = performance.now() - started;
      const reached = await page.evaluate(check);
      const tasks = await takeLongTasks();
      return { elapsed, reached, tasks };
    };
    // CodeMirror scrolls the caret line into view, which can leave the very
    // bottom of the scroller short of its maximum by the editor's padding.
    // "Reached the end" therefore means the caret is on the last line and that
    // line is actually inside the viewport, not scrollTop === scrollHeight.
    const bottomCheck = () => {
      const scroller = document.querySelector('.cm-scroller');
      const editor = document.querySelector('.cm-editor');
      if (!scroller || !editor) return false;
      const total = Number(editor.dataset.inkstoneLines || 0);
      const line = Number(/行 (\d+)/.exec(document.querySelector('#position')?.textContent || '')?.[1] || 0);
      if (!total || line < total) return false;
      const last = [...document.querySelectorAll('.cm-line')].at(-1);
      const view = scroller.getBoundingClientRect();
      const rect = last?.getBoundingClientRect();
      return !rect || (rect.bottom > view.top && rect.top < view.bottom);
    };
    const topCheck = () => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) return false;
      const line = Number(/行 (\d+)/.exec(document.querySelector('#position')?.textContent || '')?.[1] || 0);
      const first = document.querySelector('.cm-line');
      const view = scroller.getBoundingClientRect();
      const rect = first?.getBoundingClientRect();
      return line === 1 && (!rect || (rect.bottom > view.top && rect.top < view.bottom));
    };
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    scroll.bottom = await jump(`${modifier}+End`, bottomCheck);
    scroll.bottomState = await layoutOf();
    scroll.top = await jump(`${modifier}+Home`, topCheck);
    scroll.topState = await layoutOf();
    // A wheel gesture is not a caret move: it exercises the viewport's block
    // widgets without rebuilding decorations. Five equal steps make it fixed.
    const box = await page.locator('.cm-content').boundingBox();
    if (box) await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + Math.min(120, box.height / 2));
    await resetLongTasks();
    const wheelStarted = performance.now();
    for (let step = 0; step < 5; step++) {
      await page.mouse.wheel(0, 900);
      await page.evaluate(() => 1);
    }
    await frame();
    scroll.wheel = { elapsed: performance.now() - wheelStarted, tasks: await takeLongTasks() };
    const bottomReached = scroll.bottom.reached;
    const topReached = scroll.top.reached;
    // Return to the top so the next document opens with a comparable viewport.
    await page.keyboard.press(`${modifier}+Home`);
    await page.evaluate(() => 1);

    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const worst = Math.max(...samples);
    const taskTotal = tasks => tasks.reduce((sum, value) => sum + value, 0);
    const taskMax = tasks => tasks.length ? Math.max(...tasks) : 0;
    results.push({
      size, layout: afterTyping.layout, length: afterTyping.length,
      widgets: afterTyping.widgets, liveLines: afterTyping.liveLines,
      average, worst, samples,
      typingTasks, scroll, bottomReached, topReached
    });
    console.log(`size=${size} layout=${afterTyping.layout} chars=${afterTyping.length} widgets=${afterTyping.widgets} avg=${average.toFixed(1)}ms worst=${worst.toFixed(1)}ms longtask=${taskTotal(typingTasks).toFixed(0)}ms (${typingTasks.length} tasks)`);
    console.log(`  raw keys: ${samples.map(value => value.toFixed(1)).join(', ')}`);
    console.log(`  scroll: bottom=${scroll.bottom.elapsed.toFixed(0)}ms head=${scroll.top.elapsed.toFixed(0)}ms wheel5=${scroll.wheel.elapsed.toFixed(0)}ms reached=${topReached}/${bottomReached} scroll-longtask=${taskTotal([...scroll.bottom.tasks, ...scroll.top.tasks, ...scroll.wheel.tasks]).toFixed(0)}ms`);
    if (size >= 220000 && (!bottomReached || !topReached)) {
      failures.push(`${size} chars could not scroll to ${topReached ? '' : 'head '}${bottomReached ? '' : 'tail'}`.trim());
    }
  }
  // A diagram must not be rebuilt by typing above it. The marker lives on the
  // rendered <svg> node itself, so it only survives if that node is kept.
  // Kept short so every block (diagram, table, task item) is inside the
  // viewport: CodeMirror only builds widgets that are visible, and this check
  // is about DOM identity, not about latency in a long document.
  const diagram = path.join(root, 'perf-diagram.md');
  await fs.writeFile(diagram, '# 图表性能\n\n第一段，图表上方。\n\n\`\`\`mermaid\nflowchart LR\n  A[输入] --> B[输出]\n\`\`\`\n\n图表下方的段落。\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] 待办\n');
  await open(diagram);
  await page.waitForFunction(() => document.querySelectorAll('.mermaid svg').length === 1);
  const marked = await page.evaluate(() => {
    const svg = document.querySelector('.mermaid svg');
    svg.dataset.perfMarker = 'kept';
    window.__widgets = 0;
    const observer = new MutationObserver(records => { window.__widgets += records.length; });
    observer.observe(document.querySelector('.cm-content'), { childList: true, subtree: true });
    const widget = svg.closest('.md-widget');
    return { widget: widget?.dataset.from || '', below: document.querySelectorAll('.md-widget').length };
  });
  const above = await page.locator('.md-widget p').first().boundingBox();
  await page.mouse.click(above.x + 6, above.y + above.height / 2);
  await page.keyboard.press('End');
  for (const letter of 'performance') {
    await page.keyboard.press(letter);
    await page.evaluate(() => 1);
  }
  const diagramState = await page.evaluate(() => ({
    kept: document.querySelector('.mermaid svg')?.dataset.perfMarker === 'kept',
    diagrams: document.querySelectorAll('.mermaid svg').length,
    mutations: window.__widgets
  }));
  if (!diagramState.kept || diagramState.diagrams !== 1) failures.push('typing above a diagram rebuilt its <svg>');
  console.log(`diagram: svg-kept=${diagramState.kept} diagrams=${diagramState.diagrams} dom-mutations=${diagramState.mutations} widgets-before=${marked.below}`);
  console.log('');
  console.log('| size | layout | widgets | avg ms/key | worst ms | long task ms (count, max) | target | limit | verdict |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    const target = targets[result.size];
    const limit = target ? target * LIMIT_FACTOR : null;
    let verdict = '-';
    if (result.layout === 'source-fallback') verdict = 'fallback';
    else if (result.layout === 'source') verdict = 'source';
    else if (target) verdict = result.average <= target ? 'pass' : result.average <= limit ? 'miss' : 'FAIL';
    if (verdict === 'FAIL') failures.push(`${result.size} chars: ${result.average.toFixed(1)} ms/key > limit ${limit} ms`);
    const total = result.typingTasks.reduce((sum, value) => sum + value, 0);
    const max = result.typingTasks.length ? Math.max(...result.typingTasks) : 0;
    console.log(`| ${result.size} | ${result.layout} | ${result.widgets} | ${result.average.toFixed(1)} | ${result.worst.toFixed(1)} | ${total.toFixed(0)} (${result.typingTasks.length}, ${max.toFixed(0)}) | ${target ?? '-'} | ${limit ?? '-'} | ${verdict} |`);
  }
  console.log('');
  console.log('| size | layout | bottom ms | head ms | wheel5 ms | reached head/tail | scroll long task ms (count, max) |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    const all = [...result.scroll.bottom.tasks, ...result.scroll.top.tasks, ...result.scroll.wheel.tasks];
    const total = all.reduce((sum, value) => sum + value, 0);
    const max = all.length ? Math.max(...all) : 0;
    console.log(`| ${result.size} | ${result.layout} | ${result.scroll.bottom.elapsed.toFixed(0)} | ${result.scroll.top.elapsed.toFixed(0)} | ${result.scroll.wheel.elapsed.toFixed(0)} | ${result.topReached ? 'yes' : 'NO'}/${result.bottomReached ? 'yes' : 'NO'} | ${total.toFixed(0)} (${all.length}, ${max.toFixed(0)}) |`);
  }
} finally {
  // The benchmark leaves dirty documents behind; app.exit() skips the quit
  // prompt so a measurement run can never block on a dialog.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

if (failures.length) {
  console.log('');
  for (const failure of failures) console.log(`PERF REGRESSION: ${failure}`);
  if (!reportOnly) process.exitCode = 1;
}
