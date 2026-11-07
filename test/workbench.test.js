import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffHTML, escapeDiff } from '../src/diff.js';
import { parseSections, moveSection } from '../src/outline.js';

test('diff reports equal, inserted, deleted and replaced lines', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nb\nc').map(row => row.type), ['equal', 'equal', 'equal']);
  assert.deepEqual(diffLines('a\nc', 'a\nb\nc').map(row => row.type), ['equal', 'add', 'equal']);
  assert.deepEqual(diffLines('a\nb\nc', 'a\nc').map(row => row.type), ['equal', 'remove', 'equal']);
  assert.deepEqual(diffLines('a\nold\nc', 'a\nnew\nc').map(row => row.type), ['equal', 'remove', 'add', 'equal']);
});

test('diff normalizes CRLF and escapes HTML in the rendered view', () => {
  assert.deepEqual(diffLines('a\r\nb', 'a\nb').map(row => row.type), ['equal', 'equal']);
  const html = diffHTML('<script>x</script>', '<b>y</b>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /diff-remove/);
  assert.match(html, /diff-add/);
  assert.equal(escapeDiff(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
});

test('very large documents take the bounded path without throwing', () => {
  const left = Array.from({ length: 1400 }, (_, i) => `line ${i}`).join('\n');
  const right = `${left}\nextra`;
  const rows = diffLines(left, right);
  assert.equal(rows.at(-1).type, 'add');
  assert.equal(rows.at(-1).text, 'extra');
});

const DOCUMENT = '前言\n\n# 一\n\n内容一\n\n## 子一\n\n子内容\n\n# 二\n\n内容二\n\n# 三\n\n内容三\n';

test('top-level sections own their subsections', () => {
  const parsed = parseSections(DOCUMENT);
  assert.equal(parsed.sections.length, 3);
  assert.deepEqual(parsed.sections.map(item => item.title), ['一', '二', '三']);
  assert.ok(parsed.sections[0].lines.join('\n').includes('## 子一'), '父章节应包含子标题');
  assert.deepEqual(parsed.owners, [0, 0, 1, 2]);
  assert.deepEqual(parsed.preamble, ['前言', '']);
});

test('moving a section carries its children and preserves every line', () => {
  const moved = moveSection(DOCUMENT, 0, 2);
  assert.ok(moved.indexOf('# 二') < moved.indexOf('# 三'));
  assert.ok(moved.indexOf('# 三') < moved.indexOf('# 一'));
  assert.ok(moved.indexOf('# 一') < moved.indexOf('## 子一'), '子标题必须跟随父章节');
  const nonEmpty = text => text.split('\n').filter(line => line.trim()).sort();
  assert.deepEqual(nonEmpty(moved), nonEmpty(DOCUMENT), '重排不得丢失或改写任何内容');
});

test('section reorder respects CRLF and refuses no-op / invalid moves', () => {
  const crlf = DOCUMENT.replace(/\n/g, '\r\n');
  const moved = moveSection(crlf, 0, 1);
  assert.ok(moved.includes('\r\n'));
  assert.doesNotMatch(moved, /(^|[^\r])\n/);
  assert.equal(moveSection(DOCUMENT, 0, 0), DOCUMENT);
  assert.equal(moveSection(DOCUMENT, -1, 2), DOCUMENT);
  assert.equal(moveSection(DOCUMENT, 0, 99), DOCUMENT);
  assert.equal(moveSection('纯文本\n', 0, 1), '纯文本\n');
});
