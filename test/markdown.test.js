import test from 'node:test';
import assert from 'node:assert/strict';
import { parser, headings, statistics } from '../src/markdown.js';

// Mirror renderBlocks(): parse the whole document once, then render against
// the same env. This is exactly what makes cross-block features work.
function render(source) {
  const env = {};
  const tokens = parser.parse(source, env);
  return { html: parser.renderer.render(tokens, parser.options, env), env };
}

test('YAML front matter is metadata, not a horizontal rule plus a heading', () => {
  const { html } = render('---\ntitle: 对照样例\nauthor: 墨页\n---\n\n# 正文\n');
  assert.match(html, /<section class="front-matter"/);
  assert.match(html, /front-matter-key">title/);
  assert.match(html, /front-matter-value">对照样例/);
  assert.doesNotMatch(html, /<h2>title/);
  assert.doesNotMatch(html, /<hr>\s*<h2>/);
  assert.equal(headings('---\ntitle: x\n---\n\n# H\n').length, 1);
});

test('GitHub style alerts keep the kind and hide the raw marker', () => {
  const { html } = render('> [!NOTE]\n> 警示内容\n');
  assert.match(html, /class="alert alert-note"/);
  assert.match(html, /class="alert-label" data-md-skip>提示/);
  assert.doesNotMatch(html, /\[!NOTE\]/);
  assert.match(html, /警示内容/);
  const plain = render('> 普通引用\n').html;
  assert.doesNotMatch(plain, /class="alert/);
});

test('one parse env resolves reference links and footnotes across blocks', () => {
  const { html, env } = render('引用[^a] 与 [链接][ref]。\n\n[^a]: 脚注内容\n\n[ref]: https://example.com/ref\n');
  assert.ok(Object.keys(env.references || {}).length > 0);
  assert.match(html, /<a href="https:\/\/example.com\/ref">链接<\/a>/);
  assert.match(html, /class="footnote-ref"/);
  assert.match(html, /脚注内容/);
});

test('duplicate headings receive numbered ids from a shared slug counter', () => {
  const { html } = render('# 标题\n\n# 标题\n\n# 标题\n');
  assert.match(html, /id="标题"/);
  assert.match(html, /id="标题-1"/);
  assert.match(html, /id="标题-2"/);
});

test('both dollar and LaTeX bracket delimiters render KaTeX', () => {
  const { html } = render('$E=mc^2$ 与 \\(x^2\\) 以及 $y=1$。');
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
});

test('[TOC] stays a replaceable paragraph block for the renderer layer', () => {
  const { html } = render('[TOC]\n\n# 一\n\n## 二\n');
  assert.match(html, /<p>\[TOC\]<\/p>/);
  assert.equal(headings('[TOC]\n\n# 一\n\n## 二\n').length, 2);
});

test('statistics count every Han character, Latin words as one, and ignore BOM', () => {
  const stats = statistics('中文与 English 混排\n第二行');
  assert.equal(stats.characters, [...'中文与 English 混排\n第二行'].length);
  assert.ok(stats.nonWhitespace < stats.characters);
  assert.equal(stats.lines, 2);
  assert.equal(statistics('中文四个字').words, 5, '每个汉字应单独计词');
  assert.equal(statistics('hello world').words, 2);
  assert.equal(statistics('\uFEFF中文').characters, 2, 'BOM 不应计入字符数');
});
