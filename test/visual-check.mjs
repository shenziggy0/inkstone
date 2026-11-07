import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-visual-'));
const project = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, INKSTONE_TEST_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator('.cm-content').waitFor();
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
  const light = process.env.INKSTONE_LIGHT_SHOT || '/tmp/inkstone-live-light.png';
  const dark = process.env.INKSTONE_DARK_SHOT || '/tmp/inkstone-live-dark.png';
  await page.screenshot({ path: light });
  // A second shot shows the exact state the user complained about: syntax was
  // just typed, the caret is still at the end, and everything must be typeset.
  await page.locator('.topbar [data-command="new"]').click();
  await page.locator('.cm-content').click();
  // insertText avoids CodeMirror's automatic list continuation, which would
  // otherwise duplicate the `- ` markers in this fixed visual fixture.
  await page.keyboard.insertText('# 即时排版验收\n\n普通段落含 **加粗**、`代码`、~~删除线~~、==高亮== 与 [链接](https://example.com)。\n\n- 第一项\n- 第二项\n\n1. 有序项\n2. 另一个有序项');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/inkstone-live-typing.png' });
  await page.locator('[data-command="theme"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: dark });
  console.log(`screenshots written: ${light}, ${dark}, /tmp/inkstone-live-typing.png`);
} finally {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.exit(0));
  await closed;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
