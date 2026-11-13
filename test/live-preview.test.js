import test from 'node:test';
import assert from 'node:assert/strict';
import { liveLine, liveBlock, documentLines, revealFor, blockReveal } from '../src/live-preview.js';

const text = (line, from, to) => line.slice(from, to);
const bare = ranges => ranges.map(({ from, to, kind }) => ({ from, to, kind }));
const syntax = info => bare(info.marks.filter(mark => mark.kind === 'syntax'));

test('heading: prefix becomes a hidden range and the line gets display typography', () => {
  const info = liveLine('# 标题');
  assert.deepEqual(info.prefix, { from: 0, to: 2, kind: 'heading' });
  assert.ok(info.classes.includes('cm-lv-h1'));
  assert.equal(info.plain, false);
  assert.deepEqual(info.marks, []);
  assert.deepEqual(info.styles, []);
});

test('inline emphasis: markers are syntax, content is styled', () => {
  const line = '第一段 **加粗** 文字。';
  const info = liveLine(line);
  assert.deepEqual(syntax(info), [{ from: 4, to: 6, kind: 'syntax' }, { from: 8, to: 10, kind: 'syntax' }]);
  assert.deepEqual(bare(info.styles), [{ from: 6, to: 8, kind: 'strong' }]);
  assert.equal(text(line, 6, 8), '加粗');
});

test('links style only the label and hide brackets plus destination', () => {
  const line = '[文字](https://example.com)';
  const info = liveLine(line);
  assert.deepEqual(syntax(info), [
    { from: 0, to: 1, kind: 'syntax' },
    { from: 3, to: line.length, kind: 'syntax' }
  ]);
  assert.deepEqual(bare(info.styles), [{ from: 1, to: 3, kind: 'link' }]);
});

test('nested emphasis hides inner markers instead of dimming them', () => {
  // The parser gives the inner `*斜*` its own element, so its markers are
  // hidden like every other completed syntax and reappear only when the caret
  // enters that element. Before the parse-driven layer they were merely
  // dimmed, which made `**粗 *斜* 字**` disagree with the rendered text.
  const line = '**粗 *斜* 字**';
  const info = liveLine(line);
  assert.ok(info.styles.some(style => style.kind === 'strong' && text(line, style.from, style.to) === '粗 *斜* 字'));
  assert.ok(info.styles.some(style => style.kind === 'em' && text(line, style.from, style.to) === '斜'));
  assert.deepEqual(bare(info.marks), [
    { from: 0, to: 2, kind: 'syntax' },
    { from: 4, to: 5, kind: 'syntax' },
    { from: 6, to: 7, kind: 'syntax' },
    { from: 9, to: 11, kind: 'syntax' }
  ]);
  assert.equal(info.marks.filter(mark => mark.kind === 'soft').length, 0);
  assert.deepEqual(bare(info.groups), [
    { from: 0, to: 11, kind: 'strong' }, { from: 4, to: 7, kind: 'em' }
  ]);
});

test('task list prefix exposes the exact checkbox character offset', () => {
  const line = '- [ ] 待办';
  const info = liveLine(line);
  assert.equal(info.prefix.kind, 'task');
  assert.equal(info.prefix.checked, false);
  assert.equal(line[info.prefix.checkOffset], ' ');
  assert.ok(info.classes.includes('cm-lv-task'));
  assert.equal(liveLine('- [x] 完成').prefix.checked, true);
});

test('bullets, quotes, ordered lists and rules each get the right prefix', () => {
  assert.deepEqual(liveLine('- 项目').prefix, { from: 0, to: 2, kind: 'bullet' });
  assert.deepEqual(liveLine('> 引用').prefix, { from: 0, to: 2, kind: 'quote' });
  assert.deepEqual(liveLine('1. 项目').prefix, { from: 0, to: 3, kind: 'ordered', label: '1.' });
  assert.ok(liveLine('1. 项目').classes.includes('cm-lv-ordered'));
  assert.deepEqual(liveLine('1. 项目').marks, []);
  assert.equal(liveLine('---').prefix.kind, 'hr');
});

test('literal blocks stay as source: fences and table delimiter rows', () => {
  assert.equal(liveLine('```js').plain, true);
  assert.equal(liveLine('| --- | :---: |').plain, true);
  assert.equal(liveLine('const x = 1;').plain, false);
});

test('an incomplete list item is a bullet, never a table delimiter row', () => {
  assert.equal(liveLine('-').plain, false);
  assert.equal(liveLine('-').prefix, null);
  assert.deepEqual(liveLine('- ').prefix, { from: 0, to: 2, kind: 'bullet' });
  assert.equal(liveLine('- ').plain, false);
  assert.equal(liveLine('---').prefix.kind, 'hr');
});

test('list and quote prefixes wait for a separator in the active line', () => {
  for (const marker of ['-', '*', '+', '1.', '2)', '>', '>>']) {
    const info = liveLine(marker);
    assert.equal(info.prefix, null, marker);
    assert.deepEqual(info.classes, [], marker);
  }
  assert.equal(liveLine('>原文').prefix, null);
  assert.equal(liveLine('> >').prefix.to, 2);
  assert.equal(liveLine('> > ').prefix.to, 4);
  for (const line of ['- ', '* ', '+ ', '  - ', '-\t']) {
    const info = liveLine(line);
    assert.equal(info.prefix?.kind, 'bullet', `${JSON.stringify(line)} 应即时显示项目符号`);
    assert.equal(info.plain, false);
    assert.equal(revealFor(info, [{ from: line.length, to: line.length }]).prefix, false,
      `${JSON.stringify(line)} 行尾光标不应让语法裸露`);
  }

  for (const line of ['- [ ]', '- [x]', '- [] ', '1. [X]']) {
    assert.notEqual(liveLine(line).prefix?.kind, 'task', line);
  }
  for (const [line, checked] of [['- [ ] ', false], ['- [x] ', true], ['- [X] ', true], ['1. [x] ', true], ['* [ ] 待办', false]]) {
    const info = liveLine(line);
    assert.equal(info.prefix?.kind, 'task', `${JSON.stringify(line)} 应即时显示复选框`);
    assert.equal(info.prefix.checked, checked, `${JSON.stringify(line)} 勾选状态`);
    assert.deepEqual(info.marks, [], `${JSON.stringify(line)} 的 [ ] 必须整体属于前缀，不能留下裸语法`);
    assert.equal(revealFor(info, [{ from: info.prefix.to, to: info.prefix.to }]).prefix, false,
      `${JSON.stringify(line)} 前缀闭合后应立即排版`);
    assert.equal(revealFor(info, [{ from: 0, to: 0 }]).prefix, true,
      `${JSON.stringify(line)} 光标回到行首应显现源码`);
    assert.ok(info.classes.includes('cm-lv-task'));
  }
  assert.equal(liveLine('- [ ] ').prefix.checkOffset, 3);
  assert.equal('- [ ]'[liveLine('- [ ] ').prefix.checkOffset], ' ');
  assert.equal(liveLine('- [x] ').prefix.checkOffset, 3);

  for (const [line, kind] of [['> ', 'quote'], ['>> ', 'quote'], ['1. ', 'ordered'], ['2) ', 'ordered']]) {
    assert.equal(liveLine(line).prefix?.kind, kind, `${JSON.stringify(line)} 应即时排版`);
    assert.equal(revealFor(liveLine(line), [{ from: line.length, to: line.length }]).prefix, false);
  }
  assert.equal(liveLine('- [ ] 任务').prefix.kind, 'task', '有正文的任务项不能被破坏');
});

test('nested block prefixes typeset every layer, not just the outermost', () => {
  const spans = info => info.prefixes.map(({ from, to, kind }) => ({ from, to, kind }));
  for (const [line, expected] of [
    ['> - 项目', [{ from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'bullet' }]],
    ['- > 引用', [{ from: 0, to: 2, kind: 'bullet' }, { from: 2, to: 4, kind: 'quote' }]],
    ['> 1. 项目', [{ from: 0, to: 2, kind: 'quote' }, { from: 2, to: 5, kind: 'ordered' }]],
    ['1. > 引用', [{ from: 0, to: 3, kind: 'ordered' }, { from: 3, to: 5, kind: 'quote' }]],
    ['- 1. 项目', [{ from: 0, to: 2, kind: 'bullet' }, { from: 2, to: 5, kind: 'ordered' }]],
    ['1. - 项目', [{ from: 0, to: 3, kind: 'ordered' }, { from: 3, to: 5, kind: 'bullet' }]],
    ['> - [ ] 任务', [
      { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 8, kind: 'task' }
    ]],
    // Compact and spaced spellings of the same nesting both expose each marker.
    ['> > 引用', [{ from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'quote' }]],
    ['>> 引用', [{ from: 0, to: 1, kind: 'quote' }, { from: 1, to: 3, kind: 'quote' }]],
    ['> > - 项目', [
      { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'quote' }, { from: 4, to: 6, kind: 'bullet' }
    ]]
  ]) {
    const info = liveLine(line);
    assert.deepEqual(spans(info), expected, line);
    assert.deepEqual(info.marks, [], `${line}: 前缀字符不能再留下裸语法`);
    assert.equal(info.classes.includes('cm-lv-quote'), line.includes('>'), line);
  }
  const task = liveLine('> - [ ] 任务').prefixes.at(-1);
  assert.equal(task.checked, false);
  assert.equal('> - [ ] 任务'[task.checkOffset], ' ', '嵌套任务框的复选框偏移必须落在 [ ] 内');
  assert.equal(liveLine('> - [x] 完成').prefixes.at(-1).checked, true);
});

test('an outer prefix typesets while the inner marker still waits for its space', () => {
  const spans = info => info.prefixes.map(({ from, to, kind }) => ({ from, to, kind }));
  for (const [line, expected] of [
    ['>>', []],
    ['> >', [{ from: 0, to: 2, kind: 'quote' }]],
    ['>-', []],
    ['> -', [{ from: 0, to: 2, kind: 'quote' }]],
    ['> - [ ]', [{ from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'bullet' }]],
    ['> - [ ] ', [
      { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 8, kind: 'task' }
    ]],
    ['>> ', [{ from: 0, to: 1, kind: 'quote' }, { from: 1, to: 3, kind: 'quote' }]],
    ['> > ', [{ from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'quote' }]],
    ['>- ', [{ from: 0, to: 1, kind: 'quote' }, { from: 1, to: 3, kind: 'bullet' }]]
  ]) {
    assert.deepEqual(spans(liveLine(line)), expected, JSON.stringify(line));
  }
});

test('each nested prefix is revealed by the caret that enters that layer', () => {
  const list = liveBlock(documentLines('> - 项目'), 0, 1, new Set([0]));
  assert.deepEqual(list.lines[0].prefixes.map(prefix => prefix.kind), ['quote', 'bullet']);
  for (const [caret, kinds] of [
    [0, ['quote']], [1, ['quote']],
    [3, ['bullet']],
    [6, []]
  ]) {
    const reveal = blockReveal(list, [{ from: caret, to: caret }]);
    assert.deepEqual([...reveal.prefixes].map(prefix => prefix.kind), kinds, `光标 ${caret}`);
    assert.equal(reveal.prefix.size, kinds.length ? 1 : 0, `光标 ${caret} 所在行`);
  }
  const selection = blockReveal(list, [{ from: 0, to: 4 }]);
  assert.deepEqual([...selection.prefixes].map(prefix => prefix.kind), ['quote', 'bullet']);

  const task = liveBlock(documentLines('> - [ ] 任务'), 0, 1, new Set([0]));
  assert.deepEqual(task.lines[0].prefixes.map(prefix => prefix.kind), ['quote', 'task']);
  for (const caret of [3, 5]) {
    const reveal = blockReveal(task, [{ from: caret, to: caret }]);
    assert.deepEqual([...reveal.prefixes].map(prefix => prefix.kind), ['task'], `任务光标 ${caret}`);
  }
});

test('a ready task box replaces its direct list marker with one checkbox', () => {
  for (const [line, expected, outer] of [
    ['- [ ] ', { from: 0, to: 6, checkOffset: 3 }, []],
    ['1. [ ] ', { from: 0, to: 7, checkOffset: 4 }, []],
    ['> - [ ] ', { from: 2, to: 8, checkOffset: 5 }, ['quote']],
    ['- - [ ] ', { from: 2, to: 8, checkOffset: 5 }, ['bullet']]
  ]) {
    const info = liveLine(line);
    const tasks = info.prefixes.filter(prefix => prefix.kind === 'task');
    assert.equal(tasks.length, 1, line);
    assert.equal(tasks[0].from, expected.from, line);
    assert.equal(tasks[0].to, expected.to, line);
    assert.equal(tasks[0].checkOffset, expected.checkOffset, line);
    assert.equal(line[tasks[0].checkOffset], ' ', `${line}: 勾选偏移落在 [ ] 内`);
    assert.deepEqual(info.prefixes.filter(prefix => prefix.kind !== 'task').map(prefix => prefix.kind), outer, line);
  }
  // Without the separator after `]` the list control and raw brackets remain.
  assert.deepEqual(liveLine('- [ ]').prefixes.map(({ kind }) => kind), ['bullet']);
  assert.deepEqual(liveLine('> - [ ]').prefixes.map(({ kind }) => kind), ['quote', 'bullet']);
});

test('every marker on a multi-line nested block is described', () => {
  const cases = [
    ['> - 项目\n> - 第二', [
      ['quote', 'bullet'], ['quote', 'bullet']
    ]],
    ['- > 引用\n  > 续', [
      ['bullet', 'quote'], ['quote']
    ]],
    ['>> 引用\n>> 续', [
      ['quote', 'quote'], ['quote', 'quote']
    ]]
  ];
  for (const [source, expected] of cases) {
    const lines = source.split('\n');
    const block = liveBlock(documentLines(source), 0, lines.length, new Set([0, 1]));
    assert.deepEqual(block.lines.map(info => info.prefixes.map(prefix => prefix.kind)), expected, source);
  }
});

test('an empty list marker being typed previews inside a Setext context', () => {
  const prefixes = (source, line) => {
    const lines = source.split('\n');
    return liveBlock(documentLines(source), 0, lines.length, new Set([line])).lines[line].prefixes
      .map(({ from, to, kind, label }) => label ? { from, to, kind, label } : { from, to, kind });
  };
  for (const [marker, expected] of [
    ['- ', { from: 0, to: 2, kind: 'bullet' }],
    ['* ', { from: 0, to: 2, kind: 'bullet' }],
    ['+ ', { from: 0, to: 2, kind: 'bullet' }],
    ['1. ', { from: 0, to: 3, kind: 'ordered', label: '1.' }],
    ['2) ', { from: 0, to: 3, kind: 'ordered', label: '2)' }]
  ]) {
    assert.deepEqual(prefixes('正文\n' + marker, 1), [expected], marker);
  }
  assert.deepEqual(prefixes('> 正文\n> - ', 1), [
    { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'bullet' }
  ]);
  assert.deepEqual(prefixes('> > 正文\n> > - ', 1), [
    { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'quote' }, { from: 4, to: 6, kind: 'bullet' }
  ]);
  assert.deepEqual(prefixes('>> 正文\n>> - ', 1), [
    { from: 0, to: 1, kind: 'quote' }, { from: 1, to: 3, kind: 'quote' }, { from: 3, to: 5, kind: 'bullet' }
  ]);
  // A marker without its separator keeps only the surrounding quote visible.
  assert.deepEqual(prefixes('> 正文\n> -', 1), [{ from: 0, to: 2, kind: 'quote' }]);
  // Content after the marker is ordinary paragraph text, even next to a list.
  assert.deepEqual(prefixes('正文\n2. 内容', 1), []);
  // Completed Setext underlines and real rules are not empty list markers.
  assert.deepEqual(prefixes('标题\n---', 1), []);
  assert.deepEqual(prefixes('> 正文\n> ---', 1), []);
});

test('existing compact quotes still parse as nested quotes outside editing', () => {
  const compact = liveBlock(documentLines('>> 引用'), 0, 1);
  assert.deepEqual(compact.lines[0].prefixes.map(({ kind }) => kind), ['quote', 'quote']);
  assert.deepEqual(compact.lines[0].prefix, { from: 0, to: 3, kind: 'quote' });
});

test('unmatched delimiters are content, underscores inside words stay literal', () => {
  // `一段 * 文字` renders the asterisk as text (it opens no emphasis), so the
  // active block must show it as text too, not as dimmed syntax.
  assert.deepEqual(bare(liveLine('一段 * 文字').marks), []);
  assert.deepEqual(liveLine('变量 snake_case 结束').marks, []);
  assert.deepEqual(liveLine('2 * 3 * 4 与 a == b').marks, []);
});

test('escapes, subscript, superscript, HTML spans and emoji match rendered syntax', () => {
  const escaped = liveLine('\\*literal*');
  // Only the backslash is syntax. The trailing `*` closes nothing, so it is
  // ordinary content — exactly what markdown-it renders for `\*literal*`.
  assert.deepEqual(bare(escaped.marks), [{ from: 0, to: 1, kind: 'syntax' }]);
  assert.deepEqual(bare(escaped.styles), []);

  const extensions = liveLine('H~2~O x^2^ <u>线</u> :smile:');
  assert.ok(extensions.styles.some(style => style.kind === 'sub' && text('H~2~O x^2^ <u>线</u> :smile:', style.from, style.to) === '2'));
  assert.ok(extensions.styles.some(style => style.kind === 'sup'));
  assert.ok(extensions.styles.some(style => style.kind === 'u'));
  assert.deepEqual(extensions.replacements.map(({ text: value }) => value), ['😄']);
});

test('a completed syntax renders immediately when the caret follows the closing marker', () => {
  const line = '**加粗**';
  const info = liveLine(line);
  assert.deepEqual(info.groups, [{ from: 0, to: 6, kind: 'strong' }]);
  // This is exactly where the caret sits after typing the last `*`.
  assert.equal(revealFor(info, [{ from: 6, to: 6 }]).groups.size, 0, '闭合标记后不应再裸露源码');
  // Entering the element reveals both markers as editable dim text.
  for (const caret of [0, 1, 2, 3, 5]) {
    assert.deepEqual([...revealFor(info, [{ from: caret, to: caret }]).groups], [0], `光标 ${caret} 应显现语法`);
  }
  assert.deepEqual([...revealFor(info, [{ from: 1, to: 4 }]).groups], [0], '选区覆盖时显现语法');
});

test('code spans, links and images share one editing group across both marks', () => {
  const code = liveLine('`代码`');
  assert.deepEqual(code.groups, [{ from: 0, to: 4, kind: 'code' }]);
  assert.equal(revealFor(code, [{ from: 4, to: 4 }]).groups.size, 0);
  const link = liveLine('[文字](a)');
  assert.equal(link.groups.length, 1);
  assert.equal(revealFor(link, [{ from: link.groups[0].to, to: link.groups[0].to }]).groups.size, 0);
});

test('block prefixes typeset at once but reveal under the caret', () => {
  for (const [line, end] of [['# 标题', 2], ['- 项目', 2], ['1. 项目', 3], ['- [ ] 待办', 6]]) {
    const info = liveLine(line);
    const caretAfterPrefix = line.startsWith('1.') ? 3 : line.startsWith('- [') ? 6 : end;
    assert.equal(revealFor(info, [{ from: caretAfterPrefix, to: caretAfterPrefix }]).prefix, false,
      `${line}: 输入前缀后应立即排版`);
    assert.equal(revealFor(info, [{ from: 0, to: 0 }]).prefix, true,
      `${line}: 光标回到行首应显现源码`);
  }
  assert.equal(revealFor(liveLine('**加粗**'), [{ from: 6, to: 6 }]).prefix, false);
});

test('incomplete syntax has no group and therefore stays visible', () => {
  const info = liveLine('**加粗');
  assert.deepEqual(info.groups, []);
  assert.equal(revealFor(info, [{ from: 5, to: 5 }]).groups.size, 0);
  // An unclosed delimiter opens nothing: the characters are plain text, just
  // as they are in the rendered paragraph.
  assert.deepEqual(bare(info.marks), []);
});

test('all ranges are ordered, disjoint and inside the line', () => {
  for (const line of [
    '# 标题', '**粗 *斜* 字** 与 `代码` 和 ~~删~~ 及 ==标==',
    '[链接](a) ![图](b.png)', '> **引用** 文字', '| A | B |', '- [x] 完成'
  ]) {
    const info = liveLine(line);
    for (const range of info.marks) {
      assert.ok(range.from >= 0 && range.to <= line.length && range.to > range.from, `${line}: ${JSON.stringify(range)}`);
      const previous = info.marks[info.marks.indexOf(range) - 1];
      if (previous) assert.ok(previous.to <= range.from, `${line}: marks overlap`);
    }
    for (const style of info.styles) assert.ok(style.from >= 0 && style.to <= line.length && style.to > style.from);
  }
});

test('paragraph continuation is not falsely styled as an ordered list', () => {
  const doc = documentLines('正文\n2. 内容');
  const live = liveBlock(doc, 0, 2);
  assert.equal(live.lines[1].prefix, null);
  assert.deepEqual(live.lines[1].classes, []);
  const list = liveBlock(documentLines('正文\n1. 内容'), 0, 2);
  assert.equal(list.lines[1].prefix.kind, 'ordered');
});

test('Setext underlines are headings, not rules, in every container', () => {
  const lines = source => {
    const texts = source.split('\n');
    return liveBlock(documentLines(source), 0, texts.length).lines;
  };
  for (const [source, underline] of [['标题\n---', 1], ['> 标题\n> ---', 1], ['- 项目\n  ---', 1]]) {
    const info = lines(source)[underline];
    assert.equal(info.prefixes.some(prefix => prefix.kind === 'hr'), false, source);
    assert.ok(!info.classes.includes('cm-lv-hr'), source);
  }
  // A rule made of the same characters *inside* a quote or list is a rule.
  for (const [source, rule] of [['> 标题\n>\n> ---', 2], ['- 项目\n\n  * * *', 2]]) {
    assert.ok(lines(source)[rule].prefixes.some(prefix => prefix.kind === 'hr'), source);
  }
  assert.equal(liveLine('---').prefix.kind, 'hr');
});

test('thematic breaks come from the parse, including spaced and indented spellings', () => {
  const spans = info => info.prefixes.map(({ from, to, kind }) => ({ from, to, kind }));
  for (const line of ['---', '* * *', '___', '_ _ _', '- - -', '  ---', '---   ', ' *** ']) {
    const info = liveLine(line);
    assert.deepEqual(spans(info), [{ from: 0, to: line.length, kind: 'hr' }], JSON.stringify(line));
    assert.ok(info.classes.includes('cm-lv-hr'), JSON.stringify(line));
    assert.deepEqual(info.marks, [], `${JSON.stringify(line)}: 分隔线不能留下裸语法`);
  }
  // `- -` is still two nested empty list markers, not a rule.
  assert.deepEqual(spans(liveLine('- -')).map(prefix => prefix.kind), ['bullet']);
});

test('a rule inside a quote or list keeps every container layer', () => {
  const spans = info => info.prefixes.map(({ from, to, kind }) => ({ from, to, kind }));
  assert.deepEqual(spans(liveLine('> ---')), [
    { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 5, kind: 'hr' }
  ]);
  assert.deepEqual(spans(liveLine('> > * * *')), [
    { from: 0, to: 2, kind: 'quote' }, { from: 2, to: 4, kind: 'quote' }, { from: 4, to: 9, kind: 'hr' }
  ]);
  assert.ok(liveLine('> ---').classes.includes('cm-lv-quote'), '引用层不能因为分隔线而丢失');
  // A quote marker that is still waiting for its separator keeps the line as
  // source; once the space arrives the quote layer and the rule typeset.
  assert.deepEqual(spans(liveLine('>---')), []);
  const source = '> - 项目\n>\n>   - - -';
  const block = liveBlock(documentLines(source), 0, 3, new Set([2]));
  assert.deepEqual(block.lines.map(info => spans(info).map(prefix => prefix.kind)), [
    ['quote', 'bullet'], ['quote'], ['quote', 'hr']
  ], source);
  const rule = block.lines[2].prefixes.at(-1);
  assert.equal(source.split('\n')[2].slice(rule.from, rule.to), '- - -', '规则区间必须正好覆盖原始源码');
  // The outer quote is typeset and the rule source is hidden, so the visible
  // text of the nested rule line is empty; the row layout draws both.
  assert.equal(block.lines[2].marks.length, 0);
});

test('table delimiter rows, fences and front matter never become rules', () => {
  const lines = source => {
    const texts = source.split('\n');
    return liveBlock(documentLines(source), 0, texts.length).lines;
  };
  for (const source of ['| A | B |\n| --- | --- |', '```\n---\n```', '~~~\n***\n~~~', '---\na: 1\n---', '---\na: 1\n...', '    ---\n    ***']) {
    assert.ok(lines(source).every(info => !info.classes.includes('cm-lv-hr')), source);
  }
  assert.ok(lines('---\na: 1\n...').every(info => info.plain), 'front matter 必须整块按原文保留');
  assert.deepEqual(lines('```\n---\n```').map(info => [info.literal, info.plain]), [[false, true], [true, false], [false, true]]);
  assert.deepEqual(lines('    ---\n    ***').map(info => info.literal), [true, true], '缩进代码块里的短横线不是分隔线');
});

test('a rule reveals its own source when the caret enters it', () => {
  const block = liveBlock(documentLines('> ---'), 0, 1, new Set([0]));
  const kinds = range => [...blockReveal(block, [range]).prefixes].map(prefix => prefix.kind);
  const caret = from => kinds({ from, to: from });
  assert.deepEqual(caret(5), [], '行尾光标（刚输入完）应保持排版');
  assert.deepEqual(caret(2), ['hr'], '进入分隔线即显现源码');
  assert.deepEqual(caret(4), ['hr']);
  assert.deepEqual(caret(0), ['quote'], '光标在引用前缀上只显现引用层');
  assert.deepEqual(kinds({ from: 2, to: 5 }), ['hr'], '选区覆盖分隔线时显现源码');
  const plain = liveBlock(documentLines('* * *'), 0, 1, new Set([0]));
  assert.deepEqual([...blockReveal(plain, [{ from: 2, to: 2 }]).prefixes].map(prefix => prefix.kind), ['hr']);
});
