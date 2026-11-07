/**
 * The active block and the reading view must show the same text.
 *
 * The editor keeps the Markdown source on screen while a block is being
 * edited: syntax characters are hidden with zero-width widgets and styled
 * content is given real typography. The reading view of the very same block is
 * rendered by markdown-it. Both layers therefore have to agree on *which
 * characters are syntax*; before this test existed they did not, and ordinary
 * characters such as the `*` in `2 * 3 * 4` were hidden while editing.
 *
 * The invariant: for every prose block, the visible text of the active block —
 * the source with hidden syntax removed and emoji/entities shown as the
 * character the reader sees — equals the plain text of the rendered block.
 *
 * Comparison rules (all of them keep the invariant meaningful, none of them
 * hides a difference in prose):
 *   - block indentation and the blank lines that separate block children are
 *     dropped, because list nesting and paragraph spacing are block structure,
 *     not text;
 *   - maths is compared by its TeX source (KaTeX's visual tree is not text);
 *   - an image is compared by its `alt` text, which is what the active block
 *     shows for `![alt](src)`;
 *   - code, formulas, HTML blocks and front matter are *literal* blocks: they
 *     are covered by their own test instead, since the reading view typesets
 *     them and the active block deliberately shows the source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { liveBlock, documentLines, blockReveal } from '../src/live-preview.js';
import { parser, groupTokens } from '../src/markdown.js';

// ── Text of the active block ────────────────────────────────────────────────

/** Visible text of one block with the caret outside it (nothing revealed). */
function visibleText(block, ranges = []) {
  const reveal = blockReveal(block, ranges);
  return block.lines.map((info, index) => {
    const cuts = [];
    if (info.prefix && !reveal.prefix.has(index)) cuts.push({ from: info.prefix.from, to: info.prefix.to, text: '' });
    for (const mark of info.marks) {
      if (mark.kind === 'syntax' && mark.group >= 0 && !reveal.groups.has(mark.group)) cuts.push({ from: mark.from, to: mark.to, text: '' });
    }
    for (const replacement of info.replacements) {
      if (!reveal.groups.has(replacement.group)) cuts.push({ from: replacement.from, to: replacement.to, text: replacement.text });
    }
    cuts.sort((a, b) => a.from - b.from);
    let out = '', at = 0;
    for (const cut of cuts) {
      if (cut.from < at) continue;
      out += info.text.slice(at, cut.from) + cut.text;
      at = cut.to;
    }
    return out + info.text.slice(at);
  }).join('\n');
}

// ── Text of the reading view ────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

function decodeHTML(text) {
  return text.replace(ENTITY, (raw, decimal, hexadecimal, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(parseInt(hexadecimal, 16));
    return ENTITIES[name] ?? raw;
  });
}

const BLOCK_SEPARATORS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'td', 'th', 'tr', 'table', 'blockquote', 'ul', 'ol', 'div']);
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;

/**
 * Plain text of rendered HTML. Skips code-block chrome, KaTeX's visual
 * `katex-html` tree and SVG, keeps the TeX annotation of formulas, and turns
 * block boundaries into line breaks.
 */
function htmlText(html) {
  let out = '';
  let index = 0;
  let skip = 0;          // > 0 while inside a subtree that must not contribute
  let mathml = 0;        // > 0 while inside KaTeX's MathML part
  let annotation = 0;    // > 0 while inside its TeX annotation
  const frames = [];
  const collect = () => skip === 0 && (mathml === 0 || annotation > 0);
  while (index < html.length) {
    const next = html.indexOf('<', index);
    const end = next < 0 ? html.length : next;
    if (end > index && collect()) out += decodeHTML(html.slice(index, end));
    if (next < 0) break;
    index = next;
    if (html.startsWith('<!--', index)) {
      const close = html.indexOf('-->', index + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const close = html.indexOf('>', index);
      index = close < 0 ? html.length : close + 1;
      continue;
    }
    TAG.lastIndex = index;
    const match = TAG.exec(html);
    if (!match) { index += 1; continue; }
    index = TAG.lastIndex;
    const closing = match[1] === '/', name = match[2].toLowerCase(), attributes = match[3] || '', selfClosing = /\/$/.test(attributes);
    if (closing) {
      if (name === 'annotation') annotation = Math.max(0, annotation - 1);
      for (let at = frames.length - 1; at >= 0; at--) {
        if (frames[at].name !== name) continue;
        while (frames.length > at) {
          const frame = frames.pop();
          if (frame.skip) skip--;
          if (frame.mathml) mathml--;
        }
        break;
      }
      if (BLOCK_SEPARATORS.has(name) && collect()) out += '\n';
      continue;
    }
    const classes = /class\s*=\s*"([^"]*)"/.exec(attributes)?.[1] || '';
    const frame = { name, skip: false, mathml: false };
    if (attributes.includes('data-md-skip') || classes.includes('katex-html') || classes.includes('code-language')
      || /^(style|script|svg|head|title)$/.test(name)) frame.skip = true;
    if (classes.includes('katex-mathml')) frame.mathml = true;
    if (name === 'annotation') annotation++;
    if (!selfClosing) {
      frames.push(frame);
      if (frame.skip) skip++;
      if (frame.mathml) mathml++;
      // Descendants of a skipped subtree are covered by the `skip` counter, so
      // nothing else has to be emitted from inside it.
      if (!collect()) continue;
    }
    if (name === 'br') out += '\n';
    if (name === 'img') {
      const alt = /alt\s*=\s*"([^"]*)"/.exec(attributes)?.[1];
      if (alt) out += decodeHTML(alt);
    }
  }
  return out;
}

/** One prose block: its source lines, and its own rendered HTML. */
function renderBlocks(source) {
  const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const env = {};
  const tokens = parser.parse(text, env);
  // Footnote definitions are appended to the token stream at the end of the
  // document and would otherwise be rendered into the block above them. They
  // are generated content, not part of any block's own source.
  const footnote = tokens.findIndex(token => token.type === 'footnote_block_open');
  const blocks = footnote < 0 ? tokens : tokens.slice(0, footnote);
  const lines = text.split('\n');
  return groupTokens(blocks).map(group => ({
    start: group.start,
    end: group.end,
    type: group.tokens[0].type,
    source: lines.slice(group.start, group.end).join('\n'),
    // Rendering one block on its own with the document-wide `env` is exactly
    // what the reading view does (`renderDocument`), without the DOM pass.
    html: parser.renderer.render(group.tokens, parser.options, env)
  }));
}

/** Whitespace-insensitive comparison form: list indentation and the blank
 * lines between block children are structure, not text. */
function comparable(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

function compareBlock(source, block) {
  const live = liveBlock(documentLines(source), block.start, block.end);
  const liveText = comparable(visibleText(live));
  const rendered = comparable(htmlText(block.html));
  assert.equal(liveText, rendered, `${JSON.stringify(block.source)}: 活跃块可见文本与渲染层纯文本不一致`);
  return { block: live, live: liveText, rendered };
}

// ── Corpus ──────────────────────────────────────────────────────────────────

// Required by the task: these used to lose ordinary characters.
const FALSE_SYNTAX = [
  '2 * 3 * 4 = 24',
  '判断 a == b 和 c == d',
  '路径 ~/.bashrc 和 ~/.zshrc',
  '价格 $5 和 $6',
  'x^2 + y^2 = z^2'
];

const INLINE_CORPUS = [
  ...FALSE_SYNTAX,
  '**粗 *斜* 字**',
  '**跨行\n强调** 与 snake_case 和 __init__',
  '中文**加粗**中文',
  '第一段 **加粗** 文字。',
  '==高亮== 与 *斜体* 与 ~~删除~~',
  '`行内代码` 与 H~2~O 与 x^2^',
  '转义 \\*星号\\* 与 \\`反引号\\`',
  ':smile: 与 :tada:',
  '[链接](https://example.com) 与 ![图片](a.png "标题")',
  '[链接](https://example.com/a) 与 <https://example.com/autolink>',
  '<u>下划线</u> <kbd>Ctrl</kbd> <mark>高亮</mark> <sub>2</sub> <sup>3</sup>',
  '实体 &amp; 与 &nbsp; 与 &bogus;',
  '行尾双空格  \n下一行',
  '中文与 English 混排，**加粗 bold**、*斜体 italic*、~~删除线 strike~~、`行内代码 code`、\n==高亮 mark==、H~2~O、x^2^、:smile: 与转义 \\*星号\\*。',
  '中文**紧贴加粗**中文（CJK 边界用例）。',
  '[行内链接](https://example.com/ "标题")、[跳转到二级标题](#链接-links) 以及 <https://example.com/autolink>',
  '# 标题 **粗** `code`',
  '> 引用 **粗**\n> 续行 *斜*',
  '- 一\n- 二 `code`\n  - 嵌套 **粗**',
  '1. 一\n2. 二',
  '- [ ] 待办 `code`\n- [x] 完成',
  '行内公式 $E = mc^2$ 与 \\(x^2\\) 以及 $y=1$。',
  'a == b == c 与 x^2 + y^2 = z^2 与 $5 与 $6',
  'x ==== y 与 ===三个=== 与 a==b==c 与 ==a b==',
  '*a* 与 **a** 与 ***a*** 与 a*b* 与 a_b_c 与 *a 与 a*',
  '**a *b* c** 与 *a **b** c* 与 __a__ 与 _a_ 与 中文*斜体*中文',
  '`a` 与 ``a`b`` 与 `*a*` 与 `**a**`',
  '[a](b) 与 [a](b "t") 与 ![a](b) 与 [**a**](b) 与 **[a](b)**',
  '[a][b] 与 [a] 与 <a@b.c> 与 <https://x.y>',
  '\\*a\\* 与 a\\*b 与 \\\\ 与 \\[',
  '&lt; 与 &#42; 与 &copy; 与 &nbsp; 与 &bogus;',
  '2*3*4 与 a*b*c 与 a * b * c',
  'www.example.com 与 https://x.y/z. 与 mailto:a@b.c',
  'a\\\nb 与 a  \nb 与 a \nb',
  '~~a~~ 与 ~~a~~b~~ 与 ==a== 与 ==a b== 与 ==`a`== 与 ==a==b==c==',
  ':smile: 与 :bogus: 与 a:smile:b',
  '<u>a</u> 与 <kbd>a</kbd> 与 <mark>a</mark> 与 <sub>2</sub> 与 <sup>3</sup> 与 <b>a</b>'
];

test('active block text matches the rendered text for the inline corpus', () => {
  for (const source of INLINE_CORPUS) {
    const blocks = renderBlocks(source);
    assert.ok(blocks.length >= 1, source);
    for (const block of blocks) compareBlock(source, block);
  }
});

test('ordinary characters are no longer mistaken for syntax', () => {
  for (const source of FALSE_SYNTAX) {
    const block = liveBlock(documentLines(source), 0, 1);
    assert.equal(visibleText(block), source, `${JSON.stringify(source)} 必须原样显示`);
    // Nothing is hidden, so nothing can be typed over.
    assert.deepEqual(block.lines[0].marks, [], `${JSON.stringify(source)} 不应隐藏任何字符`);
  }
  // `x^2` alone is still a superscript: the parser decides, not the pattern.
  assert.equal(visibleText(liveBlock(documentLines('x^2 + y^2 = z^2'), 0, 1)), 'x^2 + y^2 = z^2');
});

test('reference links follow the labels the document defines', () => {
  // A reference link's visible text depends on a definition in another block,
  // so the active block has to know the document's labels: `[链接][ref-id]`
  // hides its destination while the undefined `[缺失][nope]` keeps both parts.
  const source = [
    '引用式 [链接][ref-id]、短式 [短式]、大小写 [链接][REF-ID] 与未定义的 [缺失][nope] 和 [孤立]。',
    '',
    '[ref-id]: https://example.com/reference',
    '',
    '[短式]: https://example.com/short'
  ].join('\n');
  const blocks = renderBlocks(source);
  assert.ok(blocks.length >= 1);
  for (const block of blocks) compareBlock(source, block);
  const live = liveBlock(documentLines(source), blocks[0].start, blocks[0].end);
  // The undefined references keep their brackets; the resolved ones do not.
  assert.match(visibleText(live), /\[缺失\]\[nope\] 和 \[孤立\]/);
  assert.match(visibleText(live), /引用式 链接、短式 短式、大小写 链接/);
});

// The formula rules are the ones texmath implements for markdown-it: a `$`
// after a digit or backslash opens nothing, the body may not start or end with
// whitespace, and a closing `$` may not be followed by a digit.
const MATH_CORPUS = [
  '$E = mc^2$ 与 $y=1$。',
  '价格 $5 和 $6',
  '$ x $ 与 $x$ 与 $x y$',
  // A line that *starts* with `$$` is a block formula, i.e. a literal block.
  '文本 $$y$$ 与 $z$ 与结尾 $$w$$',
  '\$5 与 $6$',
  '\(x^2\) 与 \( a \)'
];

test('formula delimiters follow texmath on both layers', () => {
  for (const source of MATH_CORPUS) {
    const blocks = renderBlocks(source);
    assert.ok(blocks.length >= 1, source);
    for (const block of blocks) compareBlock(source, block);
  }
});

test('docs/parity/fixtures/parity-sample.md blocks match the rendered text', () => {
  const file = path.join(import.meta.dirname, '..', 'docs', 'parity', 'fixtures', 'parity-sample.md');
  const source = fs.readFileSync(file, 'utf8');
  // Blocks whose rendered text is generated rather than derived from their own
  // source: the reading view replaces them (TOC, footnote references and
  // definitions, GitHub alert labels) or typesets them (code, tables, HTML,
  // front matter), so they cannot be compared by text.
  const generated = /\[TOC\]|\[\^|\[!|^\[[^\]]+\]:/m;
  const literal = /^(fence|code_block|math_block|math_block_eqno|html_block|table_open|front_matter)$/;
  let compared = 0;
  for (const block of renderBlocks(source)) {
    if (literal.test(block.type) || generated.test(block.source)) continue;
    compareBlock(source, block);
    compared++;
  }
  assert.ok(compared >= 12, `对等语料应覆盖至少 12 个块，实际 ${compared}`);
});

// ── Literal blocks ──────────────────────────────────────────────────────────

const LITERAL_SOURCE = [
  '- 列表项',
  '  ```sh',
  '  rm *.txt && echo *',
  '  a == b 与 $5',
  '  ```',
  '',
  '$$',
  '\\sum_{i=1}^{m} x_i^2',
  '$$',
  '',
  '> ```',
  '> x^2 * y^2',
  '> ```',
  '',
  '    indented code *x*',
  '',
  '<div class="x">html *block*</div>',
  ''
].join('\n');

test('code, formulas and HTML blocks keep their source while editing', () => {
  const document = documentLines(LITERAL_SOURCE);
  const blocks = renderBlocks(LITERAL_SOURCE);
  const kind = new Map();
  for (const block of blocks) {
    const live = liveBlock(document, block.start, block.end);
    for (const info of live.lines) kind.set(info.text, info);
  }
  for (const line of ['  ```sh', '  rm *.txt && echo *', '  a == b 与 $5', '$$', '\\sum_{i=1}^{m} x_i^2', '> ```', '> x^2 * y^2', '    indented code *x*', '<div class="x">html *block*</div>']) {
    const info = kind.get(line);
    assert.ok(info, `缺少行 ${JSON.stringify(line)}`);
    assert.ok(info.literal || info.plain, `${JSON.stringify(line)} 应是字面量行`);
    assert.deepEqual(info.marks, [], `${JSON.stringify(line)} 不应隐藏任何字符`);
  }
});

test('a fenced block nested in a list item hides no asterisks', () => {
  const source = '- 列表\n  ```sh\n  rm *.txt && echo *\n  ```';
  const block = liveBlock(documentLines(source), 0, 4);
  assert.equal(visibleText(block), '列表\n  ```sh\n  rm *.txt && echo *\n  ```', '代码块内容必须完整可见');
});

test('a block formula is literal from the opening to the closing delimiter', () => {
  const source = '$$\n\\sum_{i=1}^{m} x_i^2\n$$';
  const block = liveBlock(documentLines(source), 0, 3);
  assert.equal(visibleText(block), source);
  assert.ok(block.lines.every(info => info.literal), '公式块每一行都是字面量');
});

// ── Reveal semantics ────────────────────────────────────────────────────────

test('nested emphasis hides its inner markers instead of dimming them', () => {
  const source = '**粗 *斜* 字**';
  const block = liveBlock(documentLines(source), 0, 1);
  const info = block.lines[0];
  assert.equal(visibleText(block), '粗 斜 字');
  assert.ok(!visibleText(block).includes('*'), '光标在组外时不应出现任何星号');
  assert.equal(info.styles.filter(style => style.kind === 'strong').length, 1);
  assert.equal(info.styles.filter(style => style.kind === 'em').length, 1);
  // Both elements keep their own editing group, so the caret can bring back
  // exactly the markers of the element it enters.
  assert.equal(block.groups.length, 2);
  // The caret outside the element reveals nothing; inside it reveals the
  // markers of the element it entered (and of the enclosing one, because
  // those ranges nest).
  assert.deepEqual([...blockReveal(block, []).groups], []);
  assert.deepEqual([...blockReveal(block, [{ from: 11, to: 11 }]).groups], []);
  assert.deepEqual([...blockReveal(block, [{ from: 9, to: 9 }]).groups], [0]);
  assert.deepEqual([...blockReveal(block, [{ from: 4, to: 4 }]).groups], [0, 1]);
});

test('a completed element typesets immediately and reveals under the caret', () => {
  const source = '**跨行\n强调**';
  const block = liveBlock(documentLines(source), 0, 2);
  assert.equal(visibleText(block), '跨行\n强调', '闭合标记之后不再裸露语法');
  // The element spans a soft line break, so a caret on the second line has to
  // reveal the markers on the first line as well.
  const reveal = blockReveal(block, [{ from: block.lines[1].offset + 2, to: block.lines[1].offset + 2 }]);
  assert.equal(visibleText(block, [{ from: block.lines[1].offset + 2, to: block.lines[1].offset + 2 }]), '**跨行\n强调**');
  assert.equal(reveal.groups.size, 1);
});
