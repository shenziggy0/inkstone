import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parser, prepareDocument, renderGroups, resetRenderCache, renderMath
} from '../src/markdown.js';

/** One parse and one raw renderer pass; finalizeHTML() needs a DOM. */
function render(source, mathNumbering = false) {
  const env = { mathNumbering };
  const tokens = parser.parse(source, env);
  return {
    env, tokens,
    html: parser.renderer.render(tokens, parser.options, env)
  };
}

/** Visible text of KaTeX's MathML tree, where `\text{…}` becomes `<mtext>`. */
function mtexts(html) {
  return [...html.matchAll(/<mtext[^>]*>([^<]*)<\/mtext>/g)].map(match => match[1]);
}

function mathTokens(tokens) {
  const result = [];
  const walk = list => {
    for (const token of list) {
      if (token.math) result.push(token);
      if (token.children) walk(token.children);
    }
  };
  walk(tokens);
  return result;
}

/** The per-block path, so a signature change can be asserted without a DOM. */
function renderPlan(source, mathNumbering = false) {
  const plan = prepareDocument(source, 'doc', { mathNumbering });
  const result = renderGroups(plan.groups, plan.signature, group => ({
    html: parser.renderer.render(group.tokens, parser.options, plan.env),
    tables: 0
  }));
  return { plan, ...result, html: result.entries.map(entry => entry.html).join('') };
}

test('manual \\tag and \\label resolve \\ref and \\eqref', () => {
  const source = '$$\na^2+b^2=c^2 \\label{ref1} \\tag{1}\n$$\n\n见 \\(\\ref{ref1}\\) 与 \\(\\eqref{ref1}\\)。\n';
  const { env, html } = render(source);
  assert.equal(env.math.labels.get('ref1').number, '1');
  assert.match(html, /id="math-eq-ref1"/);
  assert.match(html, /data-math-number="1"/);
  assert.doesNotMatch(html, /\\label|\\ref/);
  assert.deepEqual(mtexts(html).slice(0, 3), ['(1)', '1', '(1)']);
});

test('\\tag* keeps its literal mark and still participates in references', () => {
  const source = '$$\nx=1 \\label{star} \\tag*{A}\n$$\n\n\\(\\ref{star}\\) \\(\\eqref{star}\\)\n';
  const { env, html } = render(source);
  assert.equal(env.math.labels.get('star').number, 'A');
  assert.match(html, /data-math-number="A"/);
  assert.deepEqual(mtexts(html).slice(0, 3), ['A', 'A', '(A)']);
});

test('a reference before its formula resolves from the whole-document scan', () => {
  const source = '前向引用 \\(\\ref{later}\\)。\n\n$$\nx=1 \\label{later} \\tag{7}\n$$\n';
  const { env, html } = render(source);
  assert.equal(env.math.labels.get('later').number, '7');
  assert.match(html, /id="math-eq-later"/);
  assert.deepEqual(mtexts(html).slice(0, 2), ['7', '(7)']);
});

test('automatic numbering skips manual tags, like LaTeX', () => {
  const source = '$$\na\n$$\n\n$$\nb \\tag{9}\n$$\n\n$$\nc \\label{c}\n$$\n\n\\(\\ref{c}\\)\n';
  const { env, html } = render(source, true);
  assert.equal(env.math.labels.get('c').number, '2', '手动编号不消耗自动编号');
  assert.deepEqual([...html.matchAll(/data-math-number="([^"]*)"/g)].map(match => match[1]), ['1', '9', '2']);
  assert.ok(mtexts(html).includes('2'), '\\ref 应显示自动编号 2');
});

test('without automatic numbering an unnumbered label is undefined', () => {
  const source = '$$\nx=1 \\label{only}\n$$\n\n\\(\\ref{only}\\) 与 \\(\\eqref{only}\\)\n';
  const { env, html } = render(source, false);
  assert.equal(env.math.labels.get('only').number, null);
  assert.ok(mtexts(html).includes('??'));
  assert.ok(mtexts(html).includes('(??)'));
});

test('undefined labels are ?? and the first duplicate definition wins', () => {
  const source = '$$\na \\label{dup} \\tag{1}\n$$\n\n$$\nb \\label{dup} \\tag{2}\n$$\n\n\\(\\ref{dup}\\) \\(\\ref{missing}\\)\n';
  const { env, html } = render(source);
  assert.equal(env.math.labels.get('dup').number, '1');
  assert.deepEqual(env.math.duplicates, ['dup']);
  assert.match(html, /data-math-duplicate-label="dup"/);
  assert.equal((html.match(/id="math-eq-dup"/g) || []).length, 1, '重复标签只产生一个锚点');
  assert.ok(mtexts(html).includes('1'));
  assert.ok(mtexts(html).includes('??'));
});

test('labels do not leak between documents', () => {
  render('$$\nx=1 \\label{a} \\tag{1}\n$$\n');
  const second = render('$$\ny=2 \\label{b} \\tag{2}\n$$\n\n\\(\\ref{a}\\)\n');
  assert.equal(second.env.math.labels.has('a'), false);
  assert.ok(mtexts(second.html).includes('??'));
});

test('a label in inline math is removed but does not become a display anchor', () => {
  const source = '$x \\label{inline}$\n\n\\(\\ref{inline}\\)\n';
  const { env, html } = render(source);
  assert.equal(env.math.labels.has('inline'), false);
  assert.doesNotMatch(html, /\\label/);
  assert.ok(mtexts(html).includes('??'));
});

test('a commented label and tag do not become document metadata', () => {
  const source = '$$\nx+1 % \\label{commented}\\tag{8}\n$$\n\n\\(\\ref{commented}\\)\n';
  const { env, html } = render(source, false);
  assert.equal(env.math.labels.has('commented'), false, '注释里的 label 不得注册');
  assert.deepEqual([...html.matchAll(/data-math-number="([^"]*)"/g)].map(match => match[1]), [], '注释里的 tag 不得编号');
  assert.ok(mtexts(html).includes('??'));
  assert.ok(!mtexts(html).includes('8'), '页面不得出现注释中的编号');
});

test('escaped percent and a new line keep later labels valid', () => {
  const source = '$$\nx+1 \\% \\label{real}\\tag{8}\n$$\n\n\\(\\ref{real}\\)\n';
  const { env, html } = render(source, false);
  assert.equal(env.math.labels.get('real').number, '8', '\\% 不是注释');
  assert.ok(mtexts(html).includes('8'));

  const multiline = '$$\nx+1 % \\label{commented}\\tag{8}\ny=2 \\label{real}\\tag{9}\n$$\n\n\\(\\ref{real}\\)\n';
  const second = render(multiline, false);
  assert.equal(second.env.math.labels.has('commented'), false, '注释只延续到行尾');
  assert.equal(second.env.math.labels.get('real').number, '9');
  assert.ok(mtexts(second.html).includes('9'));
});

test('a commented ref is left in the TeX comment instead of being rewritten', () => {
  const source = '$$\nx+1 \\% \\ref{real} % \\ref{hidden}\n$$\n\n$$\ny=2 \\label{real}\\tag{1}\n$$\n';
  const { tokens } = render(source);
  const first = mathTokens(tokens).find(token => token.type === 'math_block');
  assert.match(first.math.content, /\\text\{1\}/, '注释前的 ref 正常解析');
  assert.match(first.math.content, /% \\ref\{hidden\}/, '注释里的 ref 保持原文');
  assert.doesNotMatch(first.math.content, /\\text\{hidden\}/);
});

test('escaped command prefixes follow the TeX backslash parity rule', () => {
  const escaped = String.raw`$$\na \\ref{real} \label{real}\tag{1}\n$$`;
  const doubled = mathTokens(render(escaped).tokens).find(token => token.type === 'math_block');
  assert.match(doubled.math.content, /\\\\ref\{real\}/, '两个反斜杠不是 ref 命令');
  assert.doesNotMatch(doubled.math.content, /\\text\{1\}/);

  const command = String.raw`$$\na \\\ref{real} \label{real}\tag{1}\n$$`;
  const tripled = mathTokens(render(command).tokens).find(token => token.type === 'math_block');
  assert.match(tripled.math.content, /\\text\{1\}/, '三个反斜杠中的最后一个开始 ref 命令');
});

test('label and tag text cannot escape into HTML attributes or elements', () => {
  const source = '$$\na \\label{"><img src=x onerror=alert(1)>} \\tag{"><img src=x>}\n$$\n\n\\(\\ref{"><img src=x onerror=alert(1)>}\\)\n';
  const { env, html } = render(source);
  assert.equal(env.math.labels.size, 1);
  assert.doesNotMatch(html, /<img/i);
});

test('a tag edit invalidates reference blocks through the shared signature', () => {
  const source = '$$\na \\label{a} \\tag{1}\n$$\n\n见 \\(\\ref{a}\\)。\n';
  resetRenderCache();
  const first = renderPlan(source);
  const again = renderPlan(source);
  assert.equal(again.stats.reused, first.plan.groups.length, '同一版本应全部复用缓存');
  const changed = renderPlan(source.replace('\\tag{1}', '\\tag{2}'));
  assert.notEqual(changed.plan.signature, first.plan.signature, '编号变化必须进入全局签名');
  assert.equal(changed.stats.reused, 0, '引用块必须随编号一起重渲染');
  assert.ok(mtexts(changed.html).includes('2'));
});

test('renderMath accepts the same prepared labels for the live preview', () => {
  const labels = new Map([['a', { number: '3' }]]);
  const ref = renderMath('\\ref{a}', { labels });
  assert.equal(ref.error, null);
  assert.match(ref.html, /<mtext>3<\/mtext>/);
  const labelled = renderMath('x \\label{a}');
  assert.equal(labelled.error, null, '预览不能再因 \\label 报未定义命令');
  const numbered = renderMath('x', { number: '4' });
  assert.match(numbered.html, /katex/, '预览保留编号公式');
  assert.match(numbered.html, /\\tag\{4\}/);
  const broken = renderMath('\\frac{');
  assert.match(broken.error, /公式语法错误/, '公式错误仍由同一个预览入口报告');
});

test('every supported display delimiter participates in numbering and labels', () => {
  const source = '$$\na \\label{dollar}\n$$\n\n\\[\nb \\label{bracket}\n\\]\n\n$$c \\label{inline-double}$$\n';
  const { env } = render(source, true);
  assert.equal(env.math.labels.get('dollar').number, '1');
  assert.equal(env.math.labels.get('bracket').number, '2');
  assert.equal(env.math.labels.get('inline-double').number, '3');
  assert.equal(mathTokens(parser.parse(source, { mathNumbering: true })).filter(token => token.math?.number).length, 3);
});
