import test from 'node:test';
import assert from 'node:assert/strict';
import { headingForAnchor } from '../src/links.js';
import * as markdown from '../src/markdown.js';

const { parser, headings, statistics } = markdown;

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

function renderSelection(source, first, last = first) {
  const lf = source.replace(/\r\n/g, '\n');
  const from = lf.indexOf(first);
  const to = lf.indexOf(last, from) + last.length;
  const plan = markdown.prepareSelectedMarkdown(source, { from, to });
  return { html: parser.renderer.render(plan.tokens, parser.options, plan.env), imageRoot: plan.imageRoot };
}

test('selection clips both paragraph endpoints and retains image definitions and root', () => {
  const source = '\uFEFF---\r\ntypora-root-url: media\r\n---\r\n\r\n# 未选标题\r\n\r\n前缀 首段 **加粗**\r\n\r\n![实拍照片][photo]\r\n\r\n尾段 后缀\r\n\r\n[photo]: /photo.png\r\n';
  const { html, imageRoot } = renderSelection(source, '首段', '尾段');
  assert.match(html, /^<p>首段 <strong>加粗<\/strong><\/p>\n<p><img src="\/photo\.png" alt="实拍照片"><\/p>\n<p>尾段<\/p>\n$/);
  assert.equal(imageRoot, 'media');
});

test('selection keeps a partly selected image and diagram as complete objects', () => {
  const source = '不应复制 ![照片][p] 末尾\n\n[p]: photo.png\n\n```sequence\n甲->乙: 开始\n乙-->甲: 完成\n```\n';
  const image = renderSelection(source, '照片').html;
  assert.match(image, /^<p><img src="photo\.png" alt="照片"><\/p>\n$/);
  const diagram = renderSelection(source, '开始').html;
  assert.match(diagram, /^<pre class="diagram" data-diagram="sequence">甲-&gt;乙: 开始\n乙--&gt;甲: 完成\n<\/pre>\n?$/);
});

test('selection preserves paragraph layout inside an ordered list and excludes siblings', () => {
  const source = '3. 前一项\n4. 前缀 保留 **格式**\n5. 后一项\n';
  const { html } = renderSelection(source, '保留', '**格式**');
  assert.match(html, /^<ol start="4">\n<li>保留 <strong>格式<\/strong><\/li>\n<\/ol>\n$/);
});

test('selection keeps inline formatting where the first and last words cut through formatting', () => {
  const source = '前文 **前缀 重点** 接着 *结尾 后缀* 后文';
  const { html } = renderSelection(source, '重点', '结尾');
  assert.equal(html, '<p><strong>重点</strong> 接着 <em>结尾</em></p>\n');
});

test('selection cuts ordinary multiline code at the requested offsets', () => {
  const source = '```text\n撤掉 首行\n次行 撤掉\n```';
  const { html } = renderSelection(source, '首行', '次行');
  assert.match(html, /<code class="hljs">首行\n次行<\/code>/);
  assert.doesNotMatch(html, /撤掉/);
});

test('selection preserves literal Markdown syntax inside inline code', () => {
  const literal = '![字面](./photo.png)';
  const source = `前文 \`前缀 ${literal} 后缀\` 末尾`;
  const { html } = renderSelection(source, literal);
  assert.equal(html, `<p><code>${literal}</code></p>\n`);
});

test('selection can copy part of a named footnote definition in the source', () => {
  const source = '正文[^picked] 和 [^other]\n\n[^picked]: 前缀 定义 ![图](p.png) 尾段 后缀\n\n[^other]: 未选的脚注\n';
  const { html } = renderSelection(source, '定义', '尾段');
  assert.match(html, /<p>定义 <img src="p\.png" alt="图"> 尾段<\/p>/);
  assert.doesNotMatch(html, /前缀|后缀|未选的脚注|footnote-backref/);
});

test('empty selection cannot fall back to the whole document', () => {
  assert.equal(markdown.renderSelectedMarkdown('完整内容', 'doc', { from: 2, to: 2 }), '');
});

test('duplicate headings receive numbered ids from a shared slug counter', () => {
  const { html } = render('# 标题\n\n# 标题\n\n# 标题\n');
  assert.match(html, /id="标题"/);
  assert.match(html, /id="标题-2"/);
  assert.match(html, /id="标题-3"/);
  assert.deepEqual(headings('# 标题\n\n# 标题').map(item => item.id), ['标题', '标题-2']);
});

test('Typora heading fragments take priority over historical suffixes', () => {
  const source = '# 章节\n\n# 章节\n\n# 章节';
  const outline = headings(source);
  for (const [fragment, line] of [['章节-1', 3], ['章节-2', 3], ['章节-3', 5]]) {
    assert.equal(headingForAnchor(outline, encodeURIComponent(fragment))?.line, line);
  }
  assert.match(render(source).html, /name="章节-1"/);
  const collision = source + '\n\n# 章节-1\n\n# 章节-2';
  const ids = headings(collision).map(h => h.id);
  assert.equal(new Set(ids).size, 5);
  assert.equal(headingForAnchor(headings(collision), '章节-1').line, 7);
  assert.doesNotMatch(render(collision).html, /name="章节-1"/);
  assert.deepEqual(headings('# 固定-2\n\n# 固定\n\n# 固定').map(h => h.id), ['固定-2', '固定', '固定-3']);
  assert.deepEqual(headings('# 固定\n\n# 固定\n\n# 固定-2').map(h => h.id), ['固定', '固定-2', '固定-2-2']);
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

test('Typora parity: soft line breaks render as <br> and CJK punctuation flanks inline syntax', () => {
  const { html: breaksHtml } = render('12.以后所有 `git commit`。\n13.不用 mock。\n14.默认 `ego-lite`。');
  assert.match(breaksHtml, /12\.以后所有 <code>git commit<\/code>。<br>\n13\.不用 mock。<br>\n14\.默认 <code>ego-lite<\/code>。/);

  const cjkCases = [
    ['中文**（括号）**中文', /中文<strong>（括号）<\/strong>中文/],
    ['中文**“引号”**中文', /中文<strong>“引号”<\/strong>中文/],
    ['**注意：**不要这样做', /<strong>注意：<\/strong>不要这样做/],
    ['请看**《墨页》**文档', /请看<strong>《墨页》<\/strong>文档/],
    ['这是**重点！**一定要看', /这是<strong>重点！<\/strong>一定要看/],
    ['使用**`code`**加粗代码', /使用<strong><code>code<\/code><\/strong>加粗代码/],
    ['中文*（斜体）*中文', /中文<em>（斜体）<\/em>中文/],
    ['中文==（高亮）==中文', /中文<mark>（高亮）<\/mark>中文/],
    ['中文~~（删除）~~中文', /中文<s>（删除）<\/s>中文/],
    ['𠀀**（测试）**𠀀', /𠀀<strong>（测试）<\/strong>𠀀/]
  ];
  for (const [source, expected] of cjkCases) {
    assert.match(render(source).html, expected, source);
  }
});

test('draft names use visible prose rather than front matter, source examples or lone images', async () => {
  const { draftTitleFromSource } = await import('../src/markdown.js');
  assert.equal(draftTitleFromSource('---\ntitle: 内部元数据\n---\n\n![图片](assets/a.png)\n\n```md\n# 示例\n```\n\n先写 **海边故事**\n接下来是下一行'), '先写 海边故事');
  assert.equal(draftTitleFromSource('一行正文\n\n# **行李清单**\n'), '行李清单');
  assert.equal(draftTitleFromSource('![图片](assets/a.png)'), '');
});
