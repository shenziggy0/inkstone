import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-visual-'));
// Screenshots go to the platform temp folder (or INKSTONE_SHOT_DIR): a POSIX
// `/tmp` path resolves to `<drive>:	mp` on Windows, which usually does not exist.
const shots = process.env.INKSTONE_SHOT_DIR || path.join(os.tmpdir(), 'inkstone-shots');
await fs.mkdir(shots, { recursive: true });
const shot = name => path.join(shots, `inkstone-live-${name}.png`);
const project = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator('.cm-content').waitFor();
  // The very first window is the deliverable: a clean Typora-like page.
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot('initial') });
  await page.locator('.topbar [data-command="sidebar"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('sidebar') });
  await page.locator('.topbar [data-command="sidebar"]').click();
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  const sample = `# 墨页 · 排版态演示

正在编辑的段落也是**排版态**：\`语法字符\`会在光标远离时隐藏，只留下 [真实排版](https://example.com) 与 ==高亮==、~~删除线~~。

## 列表与引用

- 第一项
- 第二项 **加粗**
- [x] 已完成任务

> 引用块保留左边框与缩进。

| 功能 | 状态 |
| --- | --- |
| 即时渲染 | 已完成 |
| 表格就地编辑 | 已完成 |

下一段普通文字，用来对照渲染块与活跃块的视觉差异。
`;
  await page.keyboard.insertText(sample);
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 3);
  // Click the paragraph in the middle so it becomes the typeset active block.
  await page.locator('.md-widget p').first().click();
  await page.waitForTimeout(400);
  const light = process.env.INKSTONE_LIGHT_SHOT || shot('light');
  const dark = process.env.INKSTONE_DARK_SHOT || shot('dark');
  await page.screenshot({ path: light });
  // A second shot shows the exact state the user complained about: syntax was
  // just typed, the caret is still at the end, and everything must be typeset.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  // insertText avoids CodeMirror's automatic list continuation, which would
  // otherwise duplicate the `- ` markers in this fixed visual fixture.
  await page.keyboard.insertText('# 即时排版验收\n\n普通段落含 **加粗**、`代码`、~~删除线~~、==高亮== 与 [链接](https://example.com)。\n\n- 第一项\n- 第二项\n\n1. 有序项\n2. 另一个有序项');
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('typing') });
  // Another shot: an IME composition in flight. The whole document must stay
  // typeset while pinyin is being composed — the old implementation cleared
  // every decoration and exposed raw Markdown as soon as composition started.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# 组合输入验收\n\n第一段含 **加粗** 与 `代码`。\n\n- 列表项\n\n> 引用文字\n\n正在输入：');
  await page.waitForFunction(() => document.querySelectorAll('.md-widget').length >= 4);
  const ime = await page.context().newCDPSession(page);
  await ime.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: shot('ime') });
  await ime.send('Input.insertText', { text: '中文' });
  // Next shot: type the three content-free prefixes character by character.
  // insertText supplies line breaks so CodeMirror's newline continuation does
  // not duplicate the list markers; the markers themselves are real keystrokes.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('# 前缀即时排版', { delay: 12 });
  await page.keyboard.insertText('\n\n');
  await page.keyboard.type('- [ ]', { delay: 25 });
  await page.keyboard.insertText('\n');
  await page.keyboard.type('-', { delay: 25 });
  await page.keyboard.insertText('\n- [x] 已完成，用于对照勾选态复选框\n');
  await page.keyboard.type('>', { delay: 25 });
  await page.keyboard.insertText('\n> 引用文字，用于对照上方的空引用行。');
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('prefixes') });
  await page.locator('[data-command="theme"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: dark });
  // A control shot proves the dense workbench is still one preference away.
  await page.locator('[data-command="settings"]').click();
  await page.locator('#preferences [name="uiMode"]').selectOption('workbench');
  await page.locator('#preferences [name="theme"]').selectOption('light');
  await page.locator('#preferences button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.ui === 'workbench');
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('workbench') });
  console.log(`screenshots written to ${shots}: initial, sidebar, light, typing, ime-composition, prefixes, dark, workbench`);
} finally {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.exit(0));
  await closed;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
