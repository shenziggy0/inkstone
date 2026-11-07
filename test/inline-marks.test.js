import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineMarks, marksForRange } from '../src/inline-marks.js';

const ranges = line => inlineMarks(line).map(({ from, to }) => [from, to]);

test('heading markers and emphasis delimiters are dimmed, text is not', () => {
  assert.deepEqual(ranges('# 标题 **加粗**'), [[0, 1], [5, 7], [9, 11]]);
  assert.deepEqual(ranges('## 二级'), [[0, 2]]);
  assert.deepEqual(ranges('普通文本'), []);
});

test('links and images keep their label visible', () => {
  assert.deepEqual(ranges('[链接](url)'), [[0, 1], [3, 9]]);
  assert.deepEqual(ranges('![图片](a.png)'), [[0, 2], [4, 12]]);
});

test('block prefixes, task boxes and code spans', () => {
  assert.deepEqual(ranges('- 项目'), [[0, 1]]);
  assert.deepEqual(ranges('1. 项目'), [[0, 2]]);
  assert.deepEqual(ranges('> 引用'), [[0, 1]]);
  assert.deepEqual(ranges('- [ ] 待办'), [[0, 5]]);
  assert.deepEqual(ranges('用 `code` 表示'), [[2, 3], [7, 8]]);
});

test('fences, rules and table delimiter rows are pure syntax', () => {
  assert.deepEqual(ranges('```js'), [[0, 5]]);
  assert.deepEqual(ranges('| --- | :---: |'), [[0, 15]]);
});

test('an incomplete list marker is not a table delimiter row', () => {
  assert.deepEqual(ranges('-'), []);
  assert.deepEqual(ranges('- '), [[0, 1]]);
  assert.deepEqual(ranges('---'), [[0, 3]]);
});

test('ranges are ordered, non-overlapping and inside the line', () => {
  for (const line of ['# **标题** 与 [链接](url)', '- [x] `code` ~~删除~~ $x$', '| A | B |', '']) {
    const all = inlineMarks(line);
    for (let i = 0; i < all.length; i++) {
      assert.ok(all[i].from >= 0 && all[i].to <= line.length, `越界：${line}`);
      assert.ok(all[i].from < all[i].to, `空区间：${line}`);
      if (i) assert.ok(all[i - 1].to <= all[i].from, `重叠：${line}`);
    }
  }
});

test('marksForRange shifts line offsets into document positions', () => {
  const doc = { lineAt: () => ({ number: 1 }), line: () => ({ from: 100, text: '# 标题' }) };
  assert.deepEqual(marksForRange(doc, 100, 102), [{ from: 100, to: 101 }]);
});
