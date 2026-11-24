import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parser, prepareDocument, renderGroups, resetRenderCache, globalSignature,
  headings, headingsFromTokens, tocItemsFromHeadings
} from '../src/markdown.js';

// The live preview renders block by block against one shared parse. Node has no
// DOM, so the finalizeHTML() step (DOMPurify) is replaced by the raw renderer
// output here; grouping, block context, signature and caching are the real
// code paths, and the cross-block features that matter (duplicate anchors,
// footnotes, reference links, [TOC]) are decided before that step.
function renderPlan(source, documentId = 'doc') {
  const plan = prepareDocument(source, documentId);
  const result = renderGroups(plan.groups, plan.signature, group => ({
    html: parser.renderer.render(group.tokens, parser.options, plan.env),
    tables: (HTML_TABLE.exec(group.source) || []).length
  }));
  return { plan, ...result, html: result.entries.map(entry => entry.html).join('') };
}
const HTML_TABLE = /<table\b/g;

/** Same document, rendered in one go: the pre-cache output. */
function renderWhole(source) {
  const env = {};
  const tokens = parser.parse(source, env);
  return { html: parser.renderer.render(tokens, parser.options, env), env, tokens };
}

resetRenderCache();

test('a paragraph edit reuses every other block and re-renders only itself', () => {
  const source = '# 标题\n\n第一段。\n\n第二段。\n\n第三段。\n';
  resetRenderCache();
  const first = renderPlan(source);
  assert.equal(first.stats.rendered, first.plan.groups.length, '首次渲染应生成所有块');
  assert.equal(first.stats.reused, 0);
  const again = renderPlan(source);
  assert.equal(again.stats.rendered, 0, '同一版本再次渲染不应重新计算任何块');
  assert.equal(again.stats.reused, first.plan.groups.length);
  const edited = renderPlan(source.replace('第二段。', '第二段改。'));
  assert.equal(edited.stats.rendered, 1, '只应重渲染被编辑的段落');
  assert.equal(edited.stats.reused, first.plan.groups.length - 1);
  assert.match(edited.html, /第二段改/);
  assert.match(edited.html, /第一段。/);
});

test('a changed global signature invalidates every block', () => {
  const base = '# 标题\n\n正文。\n\n尾段。\n';
  resetRenderCache();
  renderPlan(base);
  // A new footnote definition can change the footnote section of the last
  // block and the tooltip of any reference, so nothing may be reused.
  const withFootnote = renderPlan(`${base}\n引用[^a]。\n\n[^a]: 定义\n`);
  assert.equal(withFootnote.stats.reused, 0, '脚注定义变化后必须全量重渲染');
  assert.match(withFootnote.html, /class="footnote-ref"/);
  renderPlan(`${base}\n引用[^a]。\n\n[^a]: 定义\n`);
  const reference = renderPlan(`${base}\n引用[^a]。\n\n[^a]: 定义\n\n[ref]: https://example.com/x\n`);
  assert.equal(reference.stats.reused, 0, '引用式链接定义变化后必须全量重渲染');
  assert.equal(globalSignature({ documentId: 'a' }) === globalSignature({ documentId: 'b' }), false, '文档 id 属于签名');
});

test('the signature ignores edits that no block can see across boundaries', () => {
  const source = '# 标题\n\n第一段。\n\n第二段。\n';
  const before = prepareDocument(source, 'doc');
  const after = prepareDocument(source.replace('第一段。', '第一段，加长了很多。'), 'doc');
  assert.equal(after.signature, before.signature, '段落编辑不应改变全局签名');
  const heading = prepareDocument(source.replace('# 标题', '# 新标题'), 'doc');
  assert.equal(heading.signature, before.signature, '标题改名不改变全局签名（锚点走块上下文）');
  const widths = prepareDocument(`${source}\n<!-- inkstone:columns 40,60 -->\n`, 'doc');
  assert.notEqual(widths.signature, before.signature, '列宽注释属于全局签名');
});

test('block context keeps duplicate heading anchors and the table of contents exact', () => {
  const source = '[TOC]\n\n# 标题\n\n正文。\n\n# 标题\n';
  resetRenderCache();
  const { plan, stats, html } = renderPlan(source);
  const headingGroups = plan.groups.filter(group => group.tokens[0].type === 'heading_open');
  assert.deepEqual(headingGroups.map(group => group.context), ['a\u0000标题', 'a\u0000标题-2\u0002标题-1'], '标题块上下文应包含分配后的锚点');
  assert.equal(new Set(headingGroups.map(group => group.source)).size, 1, '两个标题源码完全相同');
  assert.equal(stats.rendered, plan.groups.length, '相同源码但不同锚点的块不能共用缓存');
  assert.match(html, /<h1 id="标题">/, '第一个标题使用裸锚点');
  assert.match(html, /<h1 id="标题-2">/, '第二个标题使用编号锚点');
  const tocGroup = plan.groups.find(group => /\[toc\]/i.test(group.source));
  assert.match(tocGroup.context, /^toc\u0000/, '[TOC] 块上下文应带上全部标题');
  assert.match(tocGroup.context, /标题\u0002标题\u00023/, '[TOC] 上下文应包含标题与行号');
  assert.match(tocGroup.context, /标题-2\u0002标题\u00027/, '[TOC] 上下文应包含编号锚点');
  // Same input renders the same anchors again, from the cache this time.
  const again = renderPlan(source);
  assert.equal(again.stats.rendered, 0);
  assert.deepEqual(again.entries.map(entry => entry.html), renderPlan(source).entries.map(entry => entry.html));
});

test('per-block rendering matches one whole-document render', () => {
  const fixtures = [
    '# 标题\n\n# 标题\n\n## 子标题\n',
    '[TOC]\n\n# 一\n\n## 二\n',
    '引用[^a] 与 [^a] 还有 [链接][ref]。\n\n[^a]: 脚注**内容**\n\n[ref]: https://example.com/ref "标题"\n',
    '> [!WARNING]\n> 警示\n\n- [ ] 空任务\n\n- [x] 已完成\n',
    '$$\nE=mc^2\n$$\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n',
    '---\ntitle: 属性\n---\n\n正文 `代码` 与 :smile:\n'
  ];
  for (const source of fixtures) {
    resetRenderCache();
    const whole = renderWhole(source);
    const { html } = renderPlan(source);
    assert.equal(html, whole.html, `逐块渲染必须与整篇一次渲染完全一致：${JSON.stringify(source)}`);
  }
});

test('editing duplicate headings keeps cached anchors consistent with the whole document', () => {
  const source = '[TOC]\n\n# Same\n\n正文。\n\n# Other\n';
  resetRenderCache();
  renderPlan(source);
  const edited = source.replace('# Other', '# Same');
  const firstEdit = renderPlan(edited);
  assert.match(firstEdit.html, /<h1 id="same-2">/);
  assert.equal(firstEdit.html, renderWhole(edited).html);
  assert.equal(firstEdit.stats.reused, 2, '首个标题和未改段落应复用');
  assert.deepEqual(firstEdit.plan.items.map(item => item.id), ['same', 'same-2']);

  const withCollision = `${edited}\n# Same-1\n\n# Constructor\n`;
  const collisionEdit = renderPlan(withCollision);
  const ids = [...collisionEdit.html.matchAll(/<h1 id="([^"]+)">/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, 4, '同名序号不得与普通标题锚点重复');
  assert.equal(ids.at(-1), 'constructor');
  assert.deepEqual(ids, collisionEdit.plan.items.map(item => item.id));
  assert.equal(collisionEdit.html, renderWhole(withCollision).html);
});

test('the outline and [TOC] are derived from the render parse', () => {
  const source = '# 标题\n\n## 子标题\n\n# 标题\n';
  const parsed = headingsFromTokens(parser.parse(source, {}));
  assert.deepEqual(parsed, headings(source), 'headings() 与 token 推导结果一致');
  assert.deepEqual(parsed.map(item => item.id), ['标题', '子标题', '标题-2']);
  assert.equal(
    tocItemsFromHeadings([{ title: '一', level: 2, line: 3, id: '一' }]),
    '<li style="margin-left:12px"><a href="#一" data-line="3">一</a></li>',
    '[TOC] 条目格式保持不变'
  );
  const plan = prepareDocument(source, 'doc');
  assert.deepEqual(plan.items, parsed, '一次解析同时给出大纲');
  assert.equal(plan.toc, tocItemsFromHeadings(parsed));
});

test('CRLF and BOM documents render the same blocks as their LF form', () => {
  const lf = '# 标题\n\n正文。\n';
  resetRenderCache();
  const lfPlan = renderPlan(lf);
  const crlfPlan = renderPlan(lf.replace(/\n/g, '\r\n'));
  assert.deepEqual(crlfPlan.plan.groups.map(group => group.source), lfPlan.plan.groups.map(group => group.source));
  assert.equal(crlfPlan.html, lfPlan.html);
  const bom = renderPlan(`\uFEFF${lf}`);
  assert.equal(bom.html, lfPlan.html, 'BOM 不应改变渲染结果');
});
