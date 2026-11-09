// On-demand syntax highlighting: only a short list of grammars is registered
// with highlight.js core at startup, everything else is fetched when a document
// names it. The desktop case proves the rendered code block gets tokens; these
// cases pin the pure decisions underneath it (which fences a document asks for,
// what happens before and after a grammar arrives, and the fallback for a label
// nobody can load), because a regression here silently degrades highlighting in
// every document without failing any UI assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRELOADED_LANGUAGES, ensureLanguages, fenceLanguages, highlightCode,
  isHljsLanguage, requestLanguage
} from '../src/highlight.js';

test('fenceLanguages lists every fenced label once, in order, and skips diagrams', () => {
  const source = [
    '# 标题',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '~~~haskell',
    'main = pure ()',
    '~~~',
    '',
    '```mermaid',
    'flowchart LR',
    '```',
    '',
    '```sequence',
    'Alice->Bob: hello',
    '```',
    '',
    '```flow',
    'a=>start: A',
    '```',
    '',
    '```JS',
    'const b = 2;',
    '```',
    ''
  ].join('\n');
  // mermaid / sequence / flow are rendered as diagrams, not highlighted as
  // code; the repeat of `js` (different case) must not ask for the grammar
  // twice.
  assert.deepEqual(fenceLanguages(source), ['js', 'haskell']);
  // A long fence and an indented list item are both real fences.
  assert.deepEqual(fenceLanguages('  ````css\n  a { }\n  ````\n'), ['css']);
  // Inline code, indented code and prose are not fence labels.
  assert.deepEqual(fenceLanguages('用 `js` 说明，而不是代码块。\n\n    indented code\n'), []);
  assert.deepEqual(fenceLanguages(''), []);
  assert.deepEqual(fenceLanguages(null), []);
});

test('the preloaded grammars highlight immediately', () => {
  assert.ok(PRELOADED_LANGUAGES.includes('javascript'));
  assert.equal(isHljsLanguage('js'), true, '别名也应可用');
  const { html, pending } = highlightCode('const answer = 42;', 'js');
  assert.equal(pending, false);
  assert.match(html, /hljs-keyword/);
});

test('a document label nobody can load stays plain instead of hanging', () => {
  assert.equal(requestLanguage('not-a-language-at-all'), null);
  assert.deepEqual(highlightCode('x', 'not-a-language-at-all'), { html: null, pending: false });
  // No label at all is a plain fence, not a pending one.
  assert.deepEqual(highlightCode('x', ''), { html: null, pending: false });
});

test('a non-preloaded grammar arrives on demand and answers to its alias', async () => {
  // `haskell` is deliberately absent from PRELOADED_LANGUAGES, so this is the
  // dynamic-import path the editor uses for an unusual fence label.
  assert.equal(PRELOADED_LANGUAGES.includes('haskell'), false);
  const loaded = await ensureLanguages('```haskell\nmain = putStrLn "x"\n```\n');
  assert.equal(loaded, 1, '应加载一个语言包');
  assert.equal(isHljsLanguage('haskell'), true);
  assert.equal(isHljsLanguage('hs'), true, '语言包自带的别名也应注册');
  const { html, pending } = highlightCode('main = putStrLn "x"', 'hs');
  assert.equal(pending, false);
  assert.match(html, /hljs-title/);
  // Asking again is a no-op rather than a second load.
  assert.equal(requestLanguage('haskell'), null);
  assert.equal(await ensureLanguages('```haskell\nmain = 1\n```\n'), 0);
});
