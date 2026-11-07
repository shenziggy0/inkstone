/**
 * Typing-latency benchmark for the live (typeset) preview.
 *
 * Repeats the measurement the iteration-11 audit used: open a document made of
 * identical fragments, click into the first paragraph so that block becomes
 * editable, then press a key and wait for the renderer to be idle 10 times.
 * Each sample therefore covers the whole synchronous chain of one keystroke —
 * CodeMirror, the decoration rebuild, the whole-document preview render, and
 * every DOM update the app performs around them.
 *
 *   node test/perf.mjs                 # 5k / 30k / 100k characters
 *   node test/perf.mjs --sizes=5000    # a single size (fast smoke run)
 *   node test/perf.mjs --keys=20       # more samples per size
 *
 * Targets recorded in the audit: 30k ≤ 50 ms per key and 100k ≤ 150 ms per key.
 * Those are reported, not enforced, because the numbers swing with the host
 * machine (the same build measured 11/23/54 ms and 17/30/80 ms an hour apart).
 * The script does exit 1 on a regression no machine noise explains: an average
 * above three times the target (the audit started from ~850 ms per key at
 * 30k), or a diagram rebuilt by typing above it.
 *
 *   node test/perf.mjs --report-only   # never fail, just print the table
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
const sizes = (argument('sizes') || '5000,30000,100000').split(',').map(Number).filter(Boolean);
const keys = Number(argument('keys') || 10);
const targets = { 5000: 50, 30000: 50, 100000: 150 };
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
  await page.locator('.cm-content').waitFor();
  for (const size of sizes) {
    const file = path.join(root, `perf-${size}.md`);
    const text = documentOfSize(size);
    await fs.writeFile(file, text);
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, file);
    await page.locator('[data-command="open"]').click();
    await page.waitForFunction(name => document.querySelector('#location').textContent.includes(name), path.basename(file));
    await page.waitForFunction(() => document.querySelectorAll('.md-widget').length > 0);
    const blocks = await page.locator('.md-widget').count();
    // Interacting with the document switches it from the reading view to the
    // active-block layout, which is what a user typing actually pays for.
    await page.locator('.md-widget p').first().click();
    await page.evaluate(() => {
      window.__longTasks = [];
      if (!window.__longTaskObserver) {
        window.__longTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
        });
        window.__longTaskObserver.observe({ entryTypes: ['longtask'] });
      }
    });
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
    const longTasks = await page.evaluate(() => window.__longTasks.splice(0));
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const worst = Math.max(...samples);
    const longTaskTotal = longTasks.reduce((sum, value) => sum + value, 0);
    const sourceLength = await page.evaluate(() => document.querySelector('.cm-content').textContent.length);
    results.push({ size, blocks, average, worst, longTaskTotal, chars: sourceLength });
    console.log(`size=${size} blocks=${blocks} avg=${average.toFixed(1)}ms worst=${worst.toFixed(1)}ms longtask=${longTaskTotal.toFixed(0)}ms (${longTasks.length} tasks)`);
  }
  // A diagram must not be rebuilt by typing above it. The marker lives on the
  // rendered <svg> node itself, so it only survives if that node is kept.
  // Kept short so every block (diagram, table, task item) is inside the
  // viewport: CodeMirror only builds widgets that are visible, and this check
  // is about DOM identity, not about latency in a long document.
  const diagram = path.join(root, 'perf-diagram.md');
  await fs.writeFile(diagram, '# 图表性能\n\n第一段，图表上方。\n\n\`\`\`mermaid\nflowchart LR\n  A[输入] --> B[输出]\n\`\`\`\n\n图表下方的段落。\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] 待办\n');
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, diagram);
  await page.locator('[data-command="open"]').click();
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
  console.log('| size | blocks | avg ms/key | worst ms | long task ms | target | limit | verdict |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    const target = targets[result.size];
    const limit = target ? target * LIMIT_FACTOR : null;
    const verdict = !target ? '-' : result.average <= target ? 'pass' : result.average <= limit ? 'miss' : 'FAIL';
    if (verdict === 'FAIL') failures.push(`${result.size} chars: ${result.average.toFixed(1)} ms/key > limit ${limit} ms`);
    console.log(`| ${result.size} | ${result.blocks} | ${result.average.toFixed(1)} | ${result.worst.toFixed(1)} | ${result.longTaskTotal.toFixed(0)} | ${target ?? '-'} | ${limit ?? '-'} | ${verdict} |`);
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
