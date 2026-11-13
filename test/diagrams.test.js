// Typora's `sequence` and `flow` fences are separate languages from Mermaid.
// These cases pin the allow-listed grammar, the line-numbered Chinese errors
// and the security contract of the generated SVG (escaped text only, no raw
// HTML, no click callbacks and no remote references).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNativeDiagram, parseSequence, parseFlow, wrapLabel } from '../src/diagrams.js';
import { parser, diagramKindFor } from '../src/markdown.js';

const SEQUENCE = [
  'Alice->Bob: Hello Bob, how are you?',
  'Note right of Bob: Bob thinks',
  'Bob-->Alice: I am good thanks!'
].join('\n');

const FLOW = [
  'st=>start: Start',
  'op=>operation: Your Operation',
  'cond=>condition: Yes or No?',
  'e=>end',
  '',
  'st->op->cond',
  'cond(yes)->e',
  'cond(no)->op'
].join('\n');

const safeSVG = svg => {
  assert.doesNotMatch(svg, /<script|<foreignObject|<iframe|<image\b|<a\b/i, '不得出现可执行或可导航元素');
  assert.doesNotMatch(svg, /\son[a-z]+\s*=\s*["']/i, '不得出现事件处理属性');
  assert.doesNotMatch(svg, /href=|javascript:|data:text\/html/i, '不得出现链接或脚本 URL');
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org\/)/i, '不得引用远程资源');
  assert.doesNotMatch(svg, /<style|<link|<object|<embed/i, '不得注入样式或外部对象');
};

test('the official sequence example renders participants, messages and a note', () => {
  const { svg, error } = renderNativeDiagram('sequence', SEQUENCE, { idPrefix: 'official' });
  assert.equal(error, null);
  assert.match(svg, /aria-label="时序图"/);
  assert.match(svg, />Alice</);
  assert.match(svg, />Bob</);
  assert.match(svg, />Hello Bob, how are you\?</);
  assert.match(svg, />Bob thinks</);
  assert.match(svg, />I am good thanks!</);
  assert.match(svg, /stroke-dasharray="5 4"/, 'Bob-->Alice 必须是虚线');
  assert.match(svg, /marker-end="url\(#inkstone-sequence-official-filled\)"/);
  safeSVG(svg);
});

test('sequence participants, title, notes and open arrows follow the js-sequence subset', () => {
  const source = [
    '# a whole-line comment',
    'Title: 登录流程',
    'participant C',
    'participant B',
    'participant A',
    'C->A: 开始',
    'Note left of A: 左侧说明',
    'Note over A: 单人行',
    'Note over A,B: 双人行',
    'A->>B: 请求\\n第二行',
    'B-->>C: 完成',
    ''
  ].join('\n');
  const parsed = parseSequence(source);
  assert.deepEqual(parsed.actors.map(actor => actor.label), ['C', 'B', 'A'], 'participant 行决定参与者顺序');
  assert.equal(parsed.title, '登录流程');
  assert.deepEqual(parsed.events.filter(event => event.type === 'note').map(event => event.placement), ['left', 'over', 'over']);
  const { svg, error } = renderNativeDiagram('sequence', source, { idPrefix: 'notes' });
  assert.equal(error, null);
  assert.match(svg, />登录流程</);
  assert.match(svg, />左侧说明</);
  assert.match(svg, />单人行</);
  assert.match(svg, />双人行</);
  assert.match(svg, />第二行</, '\\n 转义必须换行');
  safeSVG(svg);
});

test('the official flow example renders four symbols and the yes/no branches', () => {
  const { svg, error } = renderNativeDiagram('flow', FLOW, { idPrefix: 'official' });
  assert.equal(error, null);
  assert.match(svg, /aria-label="流程图"/);
  assert.match(svg, />Start</);
  assert.match(svg, />Your Operation</);
  assert.match(svg, />Yes or No\?</);
  assert.match(svg, />yes</);
  assert.match(svg, />no</);
  assert.match(svg, /<polygon points="[^"]+"/, 'condition 必须是菱形');
  assert.match(svg, /stroke-width="1.5"/);
  safeSVG(svg);
});

test('flow accepts subroutine, inputoutput, input and output shapes', () => {
  const source = [
    's=>start: S',
    'i=>inputoutput: IO',
    'sub=>subroutine: Sub',
    'in=>input: In',
    'out=>output: Out',
    'e=>end: E',
    's->i->sub->in->out->e'
  ].join('\n');
  const { svg, error } = renderNativeDiagram('flow', source, { idPrefix: 'shapes' });
  assert.equal(error, null);
  for (const label of ['S', 'IO', 'Sub', 'In', 'Out', 'E']) assert.match(svg, new RegExp(`>${label}<`));
  assert.match(svg, /<line x1=/, 'subroutine 必须有双竖边');
});

test('flow joins a continuation line into one node label', () => {
  const { svg, error } = renderNativeDiagram('flow', 'a=>operation: 第一行\n第二行\na->a', { idPrefix: 'multiline' });
  assert.equal(error, null);
  assert.match(svg, />第一行</);
  assert.match(svg, />第二行</);
});

test('a flow definition header with a broken body reports that line instead of dropping the node', () => {
  // Regression: the old definition matcher only accepted `id=>type[: text]`.
  // A header that did not match was silently skipped by both passes, so these
  // inputs rendered a successful chart with the broken node missing.
  for (const source of [
    'a=>start: A\nb=>operation|state: B',
    'a=>start: A\nb=>operation<weird'
  ]) {
    const { svg, error } = renderNativeDiagram('flow', source);
    assert.equal(svg, null, `不得返回成功图：${source}`);
    assert.match(error, /^流程图第 2 行：/, `错误必须定位到出问题的定义行：${error}`);
  }
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>operation|state: B').error, /不支持节点状态样式（\|state）/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>operation<weird').error, /无法识别节点“b”的定义正文“<weird”/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>operation state: B').error, /^流程图第 2 行：无法识别节点“b”的定义正文/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>').error, /^流程图第 2 行：节点“b”缺少类型/);
  // A pipe inside the text is only a state marker at the end of the label.
  const literal = renderNativeDiagram('flow', 'a=>operation: A | B C\na->a', { idPrefix: 'literal-pipe' });
  assert.equal(literal.error, null);
  assert.match(literal.svg, />A \| B C</);
});

test('flow accepts direction hints and stores no unread edge state', () => {
  const parsed = parseFlow('a=>start: A\nb=>operation: B\na(yes, right)->b');
  assert.equal(parsed.edges.length, 1);
  assert.deepEqual(Object.keys(parsed.edges[0]).sort(), ['from', 'label', 'to'], '方向提示不得留在边上');
  assert.equal(parsed.edges[0].label, 'yes');
  const { svg, error } = renderNativeDiagram('flow', 'a=>start: A\nb=>operation: B\na(yes, right)->b', { idPrefix: 'direction' });
  assert.equal(error, null);
  assert.match(svg, />yes</);
  assert.doesNotMatch(svg, />right</, '方向提示不是标签');
});

test('sequence errors name the diagram and the source line in Chinese', () => {
  assert.equal(renderNativeDiagram('sequence', '').error, '时序图第 1 行：时序图为空。');
  assert.match(renderNativeDiagram('sequence', 'Alice->Bob: ok\nAlice=>Bob: no').error, /^时序图第 2 行：无法识别/);
  assert.match(renderNativeDiagram('sequence', 'Alice->Bob').error, /^时序图第 1 行：无法识别/);
  assert.match(renderNativeDiagram('sequence', 'Note over A,B,C: x').error, /^时序图第 1 行：Note over 只支持/);
  assert.match(renderNativeDiagram('sequence', 'A->B:').error, /^时序图第 1 行：消息后缺少文字/);
  assert.match(renderNativeDiagram('sequence', 'A->B: x\nNote over B').error, /^时序图第 2 行：Note 语法/);
});

test('flow errors never render partially accepted input', () => {
  assert.equal(renderNativeDiagram('flow', '').error, '流程图第 1 行：流程图为空。');
  assert.match(renderNativeDiagram('flow', 'a=>loop: x').error, /^流程图第 1 行：不支持的节点类型/);
  assert.match(renderNativeDiagram('flow', 'a=>parallel: x').error, /^流程图第 1 行：暂不支持 parallel/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\na->missing').error, /^流程图第 2 行：连接引用了未定义的节点“missing”/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\na:>https://example.com->a').error, /^流程图第 2 行：不支持链接目标/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\na@>a({"fill":"red"})').error, /^流程图第 2 行：不支持节点样式/);
  assert.match(renderNativeDiagram('flow', 'cond(align-next=no)=>condition: x').error, /^流程图第 1 行：不支持节点选项/);
  assert.match(renderNativeDiagram('flow', 'cond(yes, align-next=no)->e\ncond=>condition: x\ne=>end').error, /^流程图第 1 行：不支持 align-next/);
  assert.match(renderNativeDiagram('flow', 'op=>operation: Foo|past').error, /^流程图第 1 行：不支持节点状态样式/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>start: B\na->b(yes)').error, /^流程图第 3 行：连接标签必须写在箭头起点一侧/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>start: B\na=>end: C').error, /^流程图第 3 行：节点“a”重复定义/);
  assert.match(renderNativeDiagram('flow', 'a=>start: A\nb=>start: B\na->').error, /^流程图第 3 行：连接/);
});

test('document text can never become markup, a URL or a callback', () => {
  const hostile = [
    'A->B: <img src=x onerror=alert(1)>',
    'Note over A: </text><script>alert(2)</script>',
    'B-->>A: "quoted" & <b>bold</b>'
  ].join('\n');
  const { svg, error } = renderNativeDiagram('sequence', hostile, { idPrefix: 'hostile' });
  assert.equal(error, null);
  assert.match(svg, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(svg, /&lt;\/text&gt;&lt;script&gt;/);
  assert.match(svg, /&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(svg, /<img\b|<script\b|onerror\s*=\s*["']/i);
  safeSVG(svg);

  const flow = renderNativeDiagram('flow', 'a=>operation: </text><script>x</script>\na->a', { idPrefix: 'hostile-flow' });
  assert.equal(flow.error, null);
  assert.match(flow.svg, /&lt;\/text&gt;&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(flow.svg, /<script|onload\s*=\s*["']/i);
  safeSVG(flow.svg);

  // Theme colours come from computed CSS custom properties; a hostile custom
  // theme must not be able to break out of the SVG attributes with one.
  const injected = renderNativeDiagram('sequence', 'A->B: x', {
    idPrefix: 'hostile-palette',
    palette: { ink: '"><script>alert(1)</script>', paper: 'red;background:url(http://evil.test/x)' }
  });
  assert.equal(injected.error, null);
  assert.doesNotMatch(injected.svg, /<script|evil\.test|background:url/i);
  assert.match(injected.svg, /fill="#333333"/, '非法颜色必须回退到默认色板');
  safeSVG(injected.svg);
});

test('native diagram fences reach the Markdown renderer without touching Mermaid', () => {
  const render = (language, body) => parser.render(`\`\`\`${language}\n${body}\n\`\`\`\n`, {});
  const sequence = render('sequence', SEQUENCE);
  assert.match(sequence, /<pre class="diagram" data-diagram="sequence">/);
  assert.match(sequence, /Alice-&gt;Bob: Hello Bob, how are you\?/);
  assert.doesNotMatch(sequence, /code-block/);

  const upper = render('SEQUENCE', SEQUENCE);
  assert.match(upper, /<pre class="diagram" data-diagram="sequence">/, 'sequence / flow 围栏名不区分大小写');
  assert.match(render('Flow', FLOW), /<pre class="diagram" data-diagram="flow">/);

  // Existing Mermaid behaviour is intentionally unchanged: only the exact
  // lowercase label is a diagram, everything else remains an ordinary fence.
  assert.match(render('mermaid', 'flowchart LR\n  A-->B'), /<pre class="mermaid">/);
  assert.match(render('Mermaid', 'flowchart LR\n  A-->B'), /<pre class="code-block">/);
  assert.match(render('text', 'Alice->Bob: hello'), /<pre class="code-block">/);
  assert.match(render('javascript', 'const a = 1;'), /hljs/);
});

test('wrapLabel breaks CJK per character and keeps explicit line breaks', () => {
  const lines = wrapLabel('第一行\n第二行很长很长', 40);
  assert.deepEqual(lines[0], '第一行');
  assert.ok(lines.length > 2, '超宽中文必须折行');
  assert.ok(lines.every(line => line.length <= 4), '40px / 13px 约四个汉字一行');
});

test('renderNativeDiagram only accepts the two native fence kinds', () => {
  assert.match(renderNativeDiagram('mermaid', 'flowchart LR\nA-->B').error, /不支持的图表类型/);
  assert.match(renderNativeDiagram('', 'x').error, /不支持的图表类型/);
});

test('only the Mermaid entry and the two declared native kinds are diagram fences', () => {
  const element = (classes, kind) => ({
    classList: { contains: name => classes.split(/\s+/).includes(name) },
    dataset: kind === undefined ? {} : { diagram: kind }
  });
  assert.equal(diagramKindFor(element('diagram')), null, '普通 pre.diagram 不能被当成 Mermaid');
  assert.equal(diagramKindFor(element('diagram', 'evil')), null, '不支持的 data-diagram 不是图表');
  assert.equal(diagramKindFor(element('diagram', 'sequence')), 'sequence');
  assert.equal(diagramKindFor(element('diagram', 'flow')), 'flow');
  assert.equal(diagramKindFor(element('mermaid')), 'mermaid');
  assert.equal(diagramKindFor(element('mermaid', 'evil')), 'mermaid', '不支持的 data-diagram 不能接管 Mermaid 入口');
  assert.equal(diagramKindFor(element('diagram mermaid', 'sequence')), 'sequence');
  assert.equal(diagramKindFor(null), null);
});
