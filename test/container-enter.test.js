import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdown, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { containerEnter } from '../src/container-enter.js';
import { parser } from '../src/markdown.js';

function edit(source) {
  let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [markdown()] });
  return {
    enter() {
      const target = { state, dispatch: transaction => { state = transaction.state; } };
      return containerEnter(target) || insertNewlineContinueMarkup(target);
    },
    get source() { return state.doc.toString(); }
  };
}

test('Enter continues each container once and exits on the empty line', () => {
  for (const [source, marker] of [
    ['- 甲', '- '], ['* 甲', '* '], ['+ 甲', '+ '],
    ['1. 甲', '2. '], ['1) 甲', '2) '],
    ['- [x] 甲', '- [ ] '], ['1. [X] 甲', '2. [ ] '],
    ['> 甲', '> ']
  ]) {
    const editor = edit(source);
    assert.equal(editor.enter(), true);
    assert.equal(editor.source, source + '\n' + marker);
    assert.equal(editor.enter(), true);
    assert.equal(editor.source, source + '\n\n');
    const paragraphs = parser.parse(editor.source + '正文', {}).filter(token => token.type === 'paragraph_open');
    assert.equal(paragraphs.at(-1).level, 0, '后续正文必须位于列表或引用之外');
  }
});

test('empty markers without trailing spaces exit on Enter', () => {
  for (const marker of ['-', '2)', '>', '- [ ]', '- [x]', '1. [ ]', '- []']) {
    const editor = edit(marker);
    assert.equal(editor.enter(), true, marker);
    assert.equal(editor.source, '', marker);
  }
});

test('Enter exits one level of nested list or quote', () => {
  for (const [source, expected] of [
    ['- 外层\n  - 内层\n  - ', '- 外层\n  - 内层\n- '],
    ['1. 外层\n   - 内层\n   - ', '1. 外层\n   - 内层\n2. '],
    ['> > 内层\n> > ', '> > 内层\n>\n> '],
    ['>> 内层\n>> ', '>> 内层\n>\n> '],
    ['> - 内层\n> - ', '> - 内层\n>\n> '],
    ['- > 内层\n  > ', '- > 内层\n\n  '],
    // Mixed ordered / task / quote containers exit only the innermost layer.
    ['> 1. 外层\n>    - 内层\n>    - ', '> 1. 外层\n>    - 内层\n> 2. '],
    ['> - [ ] 任务\n> - [ ] ', '> - [ ] 任务\n>\n> '],
    ['- [ ] 外层\n  - [ ] 内层\n  - [ ] ', '- [ ] 外层\n  - [ ] 内层\n- [ ] '],
    ['1. [x] 外层\n   1. [ ] 内层\n   1. [ ] ', '1. [x] 外层\n   1. [ ] 内层\n2. [ ] '],
    ['>>- 内层\n>>- ', '>>- 内层\n>>\n>> ']
  ]) {
    const editor = edit(source);
    assert.equal(editor.enter(), true);
    assert.equal(editor.source, expected);
  }
});

test('Setext underlines and list-like code are left to their own Enter handlers', () => {
  for (const source of ['标题\n- ', '```\n- ', '    - ']) {
    const state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [markdown()] });
    assert.equal(containerEnter({ state, dispatch: () => assert.fail('unexpected edit') }), false);
  }
});

test('an item with content on a continuation line is not empty', () => {
  const state = EditorState.create({ doc: '- \n  正文', selection: { anchor: 2 }, extensions: [markdown()] });
  assert.equal(containerEnter({ state, dispatch: () => assert.fail('unexpected edit') }), false);
});
