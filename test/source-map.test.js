import test from 'node:test';
import assert from 'node:assert/strict';
import { alignSourceOffsets, imageSourceOffset } from '../src/source-map.js';

const offsets = (source, rendered) => alignSourceOffsets(rendered, source);

test('heading text and inline emphasis map to their own source characters', () => {
  const source = '# Title **bold**';
  assert.deepEqual(offsets(source, 'Title bold'), [2, 3, 4, 5, 6, 7, 10, 11, 12, 13]);
});

test('inline links, code and CJK text keep their positions', () => {
  assert.deepEqual(offsets('[文档](https://example.com)', '文档'), [1, 2]);
  assert.deepEqual(offsets('前缀 `code` 后缀', '前缀 code 后缀'), [0, 1, 2, 4, 5, 6, 7, 9, 10, 11]);
  assert.deepEqual(offsets('- [ ] 待办事项', '待办事项'), [6, 7, 8, 9]);
});

test('table cells align across the separator row', () => {
  const source = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.deepEqual(offsets(source, 'AB12'), [2, 6, 26, 30]);
});

test('list items align without being confused by generated layout newlines', () => {
  const source = '- alpha\n- beta';
  assert.deepEqual(offsets(source, 'alphabeta'), [2, 3, 4, 5, 6, 10, 11, 12, 13]);
});

test('HTML entities and emoji shortcodes do not shift following characters', () => {
  assert.deepEqual(offsets('&amp; text', '& text'), [0, 5, 6, 7, 8, 9]);
  const rendered = '\u{1F604} end';
  assert.deepEqual(offsets(':smile: end', rendered), [0, 0, 7, 8, 9, 10]);
});

test('repeated characters always keep the earliest in-order match', () => {
  assert.deepEqual(offsets('**a**a', 'aa'), [2, 5]);
  // A 'd' inside "and" is followed by a space and looks tempting to a
  // lookahead scorer, but the first 'd' inside **bold** is the real one.
  assert.deepEqual(offsets('**bold** and **bold**', 'bold and bold'), [2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18]);
});

test('soft line breaks keep their source newline', () => {
  const source = 'first line\nsecond line';
  assert.deepEqual(offsets(source, 'first line\nsecond line'), [...source].map((_, i) => i));
});

test('offsets are always inside the source, including when nothing matches', () => {
  for (const value of offsets('abc', '中文与符号')) assert.ok(value >= 0 && value <= 3);
  assert.deepEqual(alignSourceOffsets('', 'abc'), []);
});

test('image clicks resolve to the start of the alt text', () => {
  assert.equal(imageSourceOffset('文字 ![图片](assets/a.png) 文字', '图片'), 5);
  assert.equal(imageSourceOffset('no image here', '图片'), -1);
  assert.equal(imageSourceOffset('![](a.png)', ''), -1);
});
