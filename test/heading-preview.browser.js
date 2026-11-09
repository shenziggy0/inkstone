// Run in the Vite preview: await import('/test/heading-preview.browser.js').then(m => m.runHeadingPreviewChecks()).
import { createEditor } from '../src/editor.js';
import { parser } from '../src/markdown.js';

export function runHeadingPreviewChecks() {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor(host, { id: 'syntax-regression', content: '' }, () => {}, () => {}, () => {});
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const set = source => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: source }, selection: { anchor: source.length } });
  const line = () => host.querySelector('.cm-line');
  try {
    for (let level = 1; level <= 6; level++) {
      for (const suffix of ['', ' ', ' 标题']) {
        const source = '#'.repeat(level) + suffix;
        set(source);
        check(getComputedStyle(line()).fontSize === '16px', `h${level} must wait for line completion`);
        check([...line().querySelectorAll('span')].every(node => !getComputedStyle(node).textDecorationLine.includes('underline')), 'heading text must not be underlined');
        check(editor.view.state.doc.toString() === source, 'preview must preserve source');
      }
      set('#'.repeat(level) + ' 标题\n');
      const heading = host.querySelector(`h${level}`);
      check(!!heading, `h${level} renders after newline`);
      check(getComputedStyle(heading).borderBottomWidth === '0px', 'rendered heading must not add a rule');
    }
    for (const marker of ['-', '- ', '* ', '+ ', '1. ', '2. ']) {
      set('正文\n' + marker);
      check(getComputedStyle(line()).fontSize === '16px', `${marker} must not resize previous line`);
      check(getComputedStyle(line()).fontWeight === '400', `${marker} must not bold previous line`);
    }
    for (const marker of ['- 内容', '* 内容', '+ 内容', '1. 内容']) {
      set('正文\n' + marker);
      check(!!host.querySelector('.cm-prefix'), `${marker} is a real list`);
    }
    set('正文\n2. 内容');
    check(!host.querySelector('.cm-prefix'), 'ordered marker other than 1 cannot interrupt a paragraph');
    for (const source of ['#没有空格', '\\# 转义', '```md\n# 标题\n- 内容', '    # 代码', '`# 代码`', '**未闭合']) {
      set(source);
      check(!host.querySelector('.cm-lv-h1, .cm-heading-1, .cm-prefix-bullet'), `literal or incomplete syntax: ${source}`);
      check(editor.view.state.doc.toString() === source, 'literal source preserved');
    }
    for (const underline of ['-', '---', '===']) {
      const source = '标题\n' + underline;
      check(parser.parse(source, {}).some(token => token.type === 'heading_open'), 'standard Setext syntax must remain supported');
      set(source + '\n');
      check(!!host.querySelector('h1, h2'), 'completed Setext heading renders');
    }
    set('**粗体**');
    check(!!host.querySelector('.cm-lv-strong'), 'completed inline emphasis still works');
    return { checks, status: 'passed' };
  } finally { editor.destroy(); host.remove(); }
}
