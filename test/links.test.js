import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLinkTarget, linkAt, headingForAnchor, safeDecode } from '../src/links.js';

test('relative Markdown links are classified as local', () => {
  assert.deepEqual(splitLinkTarget('./other.md'), { kind: 'local', path: './other.md', anchor: '', raw: './other.md' });
  assert.deepEqual(splitLinkTarget('../a/b.md'), { kind: 'local', path: '../a/b.md', anchor: '', raw: '../a/b.md' });
  assert.equal(splitLinkTarget('other.md').kind, 'local');
  assert.equal(splitLinkTarget('C:\\notes\\a.md').kind, 'local', 'Windows 绝对路径不是 URL 协议');
  assert.equal(splitLinkTarget('file:///c:/notes/a.md').kind, 'local', 'file: 由主进程解析');
});

test('percent-encoded Chinese names and spaces are decoded', () => {
  const target = splitLinkTarget('./%E7%AC%94%E8%AE%B0%20%E4%B8%80.md');
  assert.equal(target.kind, 'local');
  assert.equal(target.path, './笔记 一.md');
  // markdown-it encodes the fragment too.
  const anchored = splitLinkTarget('./%E7%AC%94%E8%AE%B0.md#%E7%AC%AC%E4%B8%80%E8%8A%82');
  assert.equal(anchored.path, './笔记.md');
  assert.equal(anchored.anchor, '第一节');
  assert.equal(safeDecode('%E0%A4%A'), '%E0%A4%A', 'Malformed escapes keep the text');
});

test('pure anchors, web links and unsupported schemes', () => {
  assert.deepEqual(splitLinkTarget('#标题'), { kind: 'anchor', anchor: '标题' });
  assert.deepEqual(splitLinkTarget('other.md#标题'), { kind: 'local', path: 'other.md', anchor: '标题', raw: 'other.md' });
  assert.equal(splitLinkTarget('https://example.com/a.md').kind, 'external');
  assert.equal(splitLinkTarget('mailto:a@b.c').kind, 'external');
  assert.equal(splitLinkTarget('javascript:alert(1)').kind, 'external', '不支持的协议交给 allow-list 拒绝');
  assert.equal(splitLinkTarget('').kind, 'empty');
});

test('UNC and device paths stay local so the main process can refuse them', () => {
  // The renderer never decides that a network path is safe; it only classifies
  // it, and electron/assets.cjs rejects it before any filesystem call.
  assert.equal(splitLinkTarget('\\\\host\\share\\a.md').kind, 'local');
  assert.equal(splitLinkTarget('//host/share/a.md').kind, 'local');
});

test('linkAt finds the inline link under the caret, but never an image', () => {
  const line = '文字 [甲](./a.md) 与 [乙](#锚点) 以及 ![图](./p.png)';
  assert.deepEqual(linkAt(line, 6), { target: './a.md', label: '甲', from: 3, to: 14 });
  assert.equal(linkAt(line, 22).target, '#锚点');
  assert.equal(linkAt(line, line.indexOf('p.png')), null, '图片语法不是链接');
  assert.equal(linkAt(line, 0), null);
  assert.equal(linkAt('<https://example.com>', 4).target, 'https://example.com');
});

test('anchors resolve against the renderer slugs', () => {
  const headings = [{ title: '第一节', id: '第一节', line: 3 }, { title: '第二节', id: '第二节-1', line: 9 }];
  assert.equal(headingForAnchor(headings, '第一节').line, 3);
  assert.equal(headingForAnchor(headings, '#%E7%AC%AC%E4%BA%8C%E8%8A%82-1').line, 9);
  assert.equal(headingForAnchor(headings, '不存在'), null);
});
