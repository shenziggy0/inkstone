import test from 'node:test';
import assert from 'node:assert/strict';
import { liveLine, revealFor } from '../src/live-preview.js';

const text = (line, from, to) => line.slice(from, to);
const bare = ranges => ranges.map(({ from, to, kind }) => ({ from, to, kind }));
const syntax = info => bare(info.marks.filter(mark => mark.kind === 'syntax'));

test('heading: prefix becomes a hidden range and the line gets display typography', () => {
  const info = liveLine('# 标题');
  assert.deepEqual(info.prefix, { from: 0, to: 2, kind: 'heading' });
  assert.ok(info.classes.includes('cm-lv-h1'));
  assert.equal(info.plain, false);
  assert.deepEqual(info.marks, []);
  assert.deepEqual(info.styles, []);
});

test('inline emphasis: markers are syntax, content is styled', () => {
  const line = '第一段 **加粗** 文字。';
  const info = liveLine(line);
  assert.deepEqual(syntax(info), [{ from: 4, to: 6, kind: 'syntax' }, { from: 8, to: 10, kind: 'syntax' }]);
  assert.deepEqual(bare(info.styles), [{ from: 6, to: 8, kind: 'strong' }]);
  assert.equal(text(line, 6, 8), '加粗');
});

test('links style only the label and hide brackets plus destination', () => {
  const line = '[文字](https://example.com)';
  const info = liveLine(line);
  assert.deepEqual(syntax(info), [
    { from: 0, to: 1, kind: 'syntax' },
    { from: 3, to: line.length, kind: 'syntax' }
  ]);
  assert.deepEqual(bare(info.styles), [{ from: 1, to: 3, kind: 'link' }]);
});

test('nested emphasis keeps inner markers dim instead of replacing them', () => {
  const line = '**粗 *斜* 字**';
  const info = liveLine(line);
  assert.ok(info.styles.some(style => style.kind === 'strong' && text(line, style.from, style.to) === '粗 *斜* 字'));
  assert.ok(info.styles.some(style => style.kind === 'em' && text(line, style.from, style.to) === '斜'));
  assert.deepEqual(bare(info.marks.filter(mark => mark.kind === 'soft')), [
    { from: 4, to: 5, kind: 'soft' }, { from: 6, to: 7, kind: 'soft' }
  ]);
});

test('task list prefix exposes the exact checkbox character offset', () => {
  const line = '- [ ] 待办';
  const info = liveLine(line);
  assert.equal(info.prefix.kind, 'task');
  assert.equal(info.prefix.checked, false);
  assert.equal(line[info.prefix.checkOffset], ' ');
  assert.ok(info.classes.includes('cm-lv-task'));
  assert.equal(liveLine('- [x] 完成').prefix.checked, true);
});

test('bullets, quotes, ordered lists and rules each get the right prefix', () => {
  assert.deepEqual(liveLine('- 项目').prefix, { from: 0, to: 2, kind: 'bullet' });
  assert.deepEqual(liveLine('> 引用').prefix, { from: 0, to: 2, kind: 'quote' });
  assert.deepEqual(liveLine('1. 项目').prefix, { from: 0, to: 3, kind: 'ordered', label: '1.' });
  assert.ok(liveLine('1. 项目').classes.includes('cm-lv-ordered'));
  assert.deepEqual(liveLine('1. 项目').marks, []);
  assert.equal(liveLine('---').prefix.kind, 'hr');
});

test('literal blocks stay as source: fences and table delimiter rows', () => {
  assert.equal(liveLine('```js').plain, true);
  assert.equal(liveLine('| --- | :---: |').plain, true);
  assert.equal(liveLine('const x = 1;').plain, false);
});

test('an incomplete list item is a bullet, never a table delimiter row', () => {
  assert.equal(liveLine('-').plain, false);
  assert.deepEqual(liveLine('- ').prefix, { from: 0, to: 2, kind: 'bullet' });
  assert.equal(liveLine('- ').plain, false);
  assert.equal(liveLine('---').prefix.kind, 'hr');
});

test('stray delimiters are dim, underscores inside words are content', () => {
  assert.deepEqual(bare(liveLine('一段 * 文字').marks), [{ from: 3, to: 4, kind: 'soft' }]);
  assert.deepEqual(liveLine('变量 snake_case 结束').marks, []);
});

test('a completed syntax renders immediately when the caret follows the closing marker', () => {
  const line = '**加粗**';
  const info = liveLine(line);
  assert.deepEqual(info.groups, [{ from: 0, to: 6, kind: 'strong' }]);
  // This is exactly where the caret sits after typing the last `*`.
  assert.equal(revealFor(info, [{ from: 6, to: 6 }]).groups.size, 0, '闭合标记后不应再裸露源码');
  // Entering the element reveals both markers as editable dim text.
  for (const caret of [0, 1, 2, 3, 5]) {
    assert.deepEqual([...revealFor(info, [{ from: caret, to: caret }]).groups], [0], `光标 ${caret} 应显现语法`);
  }
  assert.deepEqual([...revealFor(info, [{ from: 1, to: 4 }]).groups], [0], '选区覆盖时显现语法');
});

test('code spans, links and images share one editing group across both marks', () => {
  const code = liveLine('`代码`');
  assert.deepEqual(code.groups, [{ from: 0, to: 4, kind: 'code' }]);
  assert.equal(revealFor(code, [{ from: 4, to: 4 }]).groups.size, 0);
  const link = liveLine('[文字](a)');
  assert.equal(link.groups.length, 1);
  assert.equal(revealFor(link, [{ from: link.groups[0].to, to: link.groups[0].to }]).groups.size, 0);
});

test('block prefixes typeset at once but reveal under the caret', () => {
  for (const [line, end] of [['# 标题', 2], ['- 项目', 2], ['1. 项目', 3], ['- [ ] 待办', 6]]) {
    const info = liveLine(line);
    const caretAfterPrefix = line.startsWith('1.') ? 3 : line.startsWith('- [') ? 6 : end;
    assert.equal(revealFor(info, [{ from: caretAfterPrefix, to: caretAfterPrefix }]).prefix, false,
      `${line}: 输入前缀后应立即排版`);
    assert.equal(revealFor(info, [{ from: 0, to: 0 }]).prefix, true,
      `${line}: 光标回到行首应显现源码`);
  }
  assert.equal(revealFor(liveLine('**加粗**'), [{ from: 6, to: 6 }]).prefix, false);
});

test('incomplete syntax has no group and therefore stays visible', () => {
  const info = liveLine('**加粗');
  assert.deepEqual(info.groups, []);
  assert.equal(revealFor(info, [{ from: 5, to: 5 }]).groups.size, 0);
  assert.deepEqual(bare(info.marks), [{ from: 0, to: 2, kind: 'soft' }]);
});

test('all ranges are ordered, disjoint and inside the line', () => {
  for (const line of [
    '# 标题', '**粗 *斜* 字** 与 `代码` 和 ~~删~~ 及 ==标==',
    '[链接](a) ![图](b.png)', '> **引用** 文字', '| A | B |', '- [x] 完成'
  ]) {
    const info = liveLine(line);
    for (const range of info.marks) {
      assert.ok(range.from >= 0 && range.to <= line.length && range.to > range.from, `${line}: ${JSON.stringify(range)}`);
      const previous = info.marks[info.marks.indexOf(range) - 1];
      if (previous) assert.ok(previous.to <= range.from, `${line}: marks overlap`);
    }
    for (const style of info.styles) assert.ok(style.from >= 0 && style.to <= line.length && style.to > style.from);
  }
});
