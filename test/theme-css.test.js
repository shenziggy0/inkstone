import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { readThemeCSS, safeThemeName, localThemeFile } = require('../electron/theme-css.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-theme-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const write = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};

test('a Typora-style theme inlines relative imports and local font resources', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'fixture.css'), `@import "./parts/base.css";
:root { --bg-color: #f5f5f5; --text-color: #223344; }
html { font-size: 16px; }
body { font-family: "Fixture Serif", serif; color: #223344; background: var(--bg-color); }
#write { max-width: 700px; }
#write h1 { font-size: 2em; color: #123456; border-bottom: 1px solid #eee; }
#write a { color: #0b6bcb; }
#write pre { background: #f0f0f0; }
#write table { border: 1px solid #ddd; }
#write blockquote { color: #555; }
@include-when-export url(https://fonts.example.invalid/font.css);
`);
  await write(path.join(root, 'parts', 'base.css'), `@import "../fonts/fonts.css";
.remote { background: url(https://example.invalid/a.png); }
.absolute { background: url("/etc/passwd"); }
.outside { background: url("../../outside.woff2"); }
.topbar { color: red; }
`);
  await write(path.join(root, 'fonts', 'fonts.css'), `@font-face { font-family: 'Fixture Serif'; src: url('./fixture.woff2') format('woff2'); }
`);
  await write(path.join(root, 'fonts', 'fixture.woff2'), 'fixture-font-bytes');
  await write(path.join(path.dirname(root), 'outside.woff2'), 'outside-font-bytes');

  const css = await readThemeCSS('fixture.css', root);
  assert.doesNotMatch(css, /@import|@include-when-export/i);
  assert.doesNotMatch(css, /https?:|file:|\/etc\/passwd|\.\.\//i);
  assert.match(css, /data:font\/woff2;base64,/);
  assert.match(css, /:root\{--bg-color:#f5f5f5;--text-color:#223344\}/);
  // Document roots are scoped away from the application chrome, and #write
  // keeps its Typora id while also matching the export article's .prose.
  assert.match(css, /:is\(\.cm-editor, \.prose\)\{font-size:16px\}/);
  assert.match(css, /:is\(\.cm-editor, \.prose\)\{--font-body:"Fixture Serif", serif;--font-display:"Fixture Serif", serif\}/);
  assert.match(css, /:root\{--inkstone-theme-ink:#223344;--inkstone-theme-paper:var\(--bg-color\)\}/);
    assert.match(css, /:is\(#write, \.write-surface\)\{max-width:700px\}/);
  assert.match(css, /:is\(#write, \.write-surface\) h1\{font-size:2em;color:#123456;border-bottom:1px solid #eee\}/);
  assert.match(css, /\.cm-editor \.cm-line\.cm-heading-1\{font-size:2em;color:#123456\}/);
  assert.match(css, /:is\(#write, \.write-surface\) a\{color:#0b6bcb\}/);
  assert.match(css, /:is\(#write, \.write-surface\) pre\{background:#f0f0f0\}/);
  // Missing / rejected resources stay local and inert.
  assert.match(css, /background:url\("data:,"\)/);
  assert.doesNotMatch(css, /b3V0c2lkZS1mb250LWJ5dGVz/);
  assert.match(css, /:is\(\.cm-content, \.prose\) \.topbar\{color:red\}/);
});

test('remote, UNC, drive and traversal imports are never read', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'safe.css'), `@import "https://example.invalid/x.css";
@import "//server/share/x.css";
@import "\\\\\\\\server\\\\share\\\\x.css";
@import "C:/Windows/x.css";
@import "../outside.css";
:root { --fixture-image: url(https://example.invalid/a.png); }
body { color: #111; }
`);
  await write(path.join(path.dirname(root), 'outside.css'), ':root { --leak: yes; }');
  const css = await readThemeCSS('safe.css', root);
  assert.doesNotMatch(css, /leak|https?:|server|Windows\/x/i);
  assert.match(css, /:root\{--fixture-image:url\("data:,"\)\}/);
  assert.match(css, /body\{color:#111\}/);
  assert.doesNotMatch(css, /:is\(\.cm-editor, \.prose\)\{color:#111\}/);
});

test('symlinked files and folders may not escape the theme root', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await write(path.join(outside, 'secret.css'), ':root { --secret: visible; }');
  await write(path.join(outside, 'secret.woff2'), 'SECRET-FONT-BYTES');
  let links = true;
  try {
    await fs.symlink(path.join(outside, 'secret.css'), path.join(root, 'link.css'));
    await fs.symlink(path.join(outside, 'secret.woff2'), path.join(root, 'leak.woff2'));
    await fs.symlink(outside, path.join(root, 'leak-dir'), 'dir');
  } catch {
    links = false;
  }
  if (!links) return;
  await assert.rejects(() => readThemeCSS('link.css', root), /主题文件不存在/);

  await write(path.join(root, 'main.css'), `.a { background: url("./leak.woff2"); }
.b { background: url("./leak-dir/secret.woff2"); }
.c { background: url("./leak-dir/secret.css"); }
`);
  const css = await readThemeCSS('main.css', root);
  assert.doesNotMatch(css, /SECRET-FONT|U0VDUkVULUZPTlQtQllURVM/);
  assert.equal((css.match(/url\("data:,"\)/g) || []).length, 3);
});

test('ordinary old themes keep loading and unsupported constructors are inert', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'old.css'), `@charset "UTF-8";
@namespace svg url(http://www.w3.org/2000/svg);
body { font-family: Georgia, serif; }
#write p { line-height: 1.7; }
@font-face { font-family: Missing; src: url("./missing.woff2"); }
`);
  const css = await readThemeCSS('old.css', root);
  assert.match(css, /--font-body:Georgia, serif/);
  assert.match(css, /:is\(#write, \.write-surface\) p\{line-height:1.7\}/);
  assert.match(css, /url\("data:,"\)/);
  assert.doesNotMatch(css, /@namespace|@charset|http:/i);
});

test('theme names are a single top-level .css basename', async () => {
  for (const name of ['github.css', 'night.css', 'newsprint.css', 'my theme.css']) assert.equal(safeThemeName(name), true, name);
  for (const name of ['../github.css', 'github', '.hidden.css', 'sub/github.css', '', null]) assert.equal(safeThemeName(name), false, String(name));
});

test('the local resource gate accepts only real files below the root', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'fonts', 'a.woff2'), 'x');
  const realRoot = await fs.realpath(root);
  assert.ok(await localThemeFile(realRoot, path.join(realRoot, 'fonts', 'base.css'), '../fonts/a.woff2', new Set(['.woff2'])));
  assert.equal(await localThemeFile(realRoot, path.join(realRoot, 'fonts', 'base.css'), '../../a.woff2', new Set(['.woff2'])), null);
  assert.equal(await localThemeFile(realRoot, path.join(realRoot, 'fonts', 'base.css'), 'https://example.invalid/a.woff2', new Set(['.woff2'])), null);
  assert.equal(await localThemeFile(realRoot, path.join(realRoot, 'fonts', 'base.css'), '\\\\server\\share\\a.woff2', new Set(['.woff2'])), null);
  assert.equal(await localThemeFile(realRoot, path.join(realRoot, 'fonts', 'base.css'), 'a.css', new Set(['.woff2'])), null);
});

test('selector, declaration and at-rule text cannot escape document scoping', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'safe.css'), ':root { --safe: yes; }');
  await write(path.join(root, 'hostile.css'), `@import "safe.css" screen} body{display:none};
@media screen} body{display:none}{#write h1{color:red}}
body} .escaped { color: red; }
#write h1 { color: blue; --payload: } body { display: none } }
#write h2 { content: "</style><script>alert(1)</script>"; }
`);
  const css = await readThemeCSS('hostile.css', root);
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /<\/style/i);
  // The only body rule left is the scoped one from the hostile selector's drop
  // path; no unscoped `body{display:none}` / `.escaped{...}` may appear.
  assert.doesNotMatch(css, /(^|\n)body\{display:none\}/);
  assert.doesNotMatch(css, /(^|\n)\.escaped\{/);
});

test('export builders cannot be closed early by CSS text', async () => {
  const { styledHTML, printHTML } = await import('../src/export.js');
  for (const html of [
    styledHTML('t', '<p>x</p>', 'body{color:red}</style><script>alert(1)</script>'),
    printHTML('t', '<p>x</p>', 'body{color:red}</style><script>alert(1)</script>')
  ]) {
    assert.doesNotMatch(html, /<\/style><script>/i);
    assert.match(html, /<\\\/style><script>/i);
  }
});

test('data URLs stay single tokens and complex resource syntax is rejected', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'pic.png'), 'png-bytes');
  await write(path.join(root, 'values.css'), `:root { --keep: url("data:image/png;base64,AAAA"); }
.single { background-image: url("data:image/png;base64,BBBB"); }
.upper { background-image: URL("data:image/png;base64,CCCC"); }
.content { content: "url(https://example.invalid/text) \\2014"; }
.local { background-image: url("./pic.png"); }
.image-set { background-image: image-set("http://127.0.0.1:1/x.png" 1x); }
.escaped { background-image: u\\72l("http://127.0.0.1:1/y.png"); }
.commented { background-image: u/**/rl("http://127.0.0.1:1/z.png"); }
`);
  const css = await readThemeCSS('values.css', root);
  assert.doesNotMatch(css, /url\("url\(/);
  assert.match(css, /url\("data:image\/png;base64,BBBB"\)/);
  assert.match(css, /URL\("data:image\/png;base64,CCCC"\)/);
  assert.match(css, /data:image\/png;base64,cG5nLWJ5dGVz/);
  assert.match(css, /content:"url\(https:\/\/example\.invalid\/text\) \\2014"/);
  assert.doesNotMatch(css, /image-set|127\.0\.0\.1|escaped|commented|[xyz]\.png/);
});

test('oversized source CSS fails explicitly instead of being sliced', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'huge.css'), `:root { --pad: "${'a'.repeat(2 * 1024 * 1024 + 1)}"; }`);
  await assert.rejects(() => readThemeCSS('huge.css', root), /2 MB/);
});

test('legacy app and .prose selectors keep their existing meaning', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'legacy.css'), `@import "./parts/typora-helper.css";
.topbar { color: rgb(9, 8, 7); }
.sidebar-tabs { border-bottom: 0; }
button[data-command="settings"] { outline: 2px solid rgb(12, 34, 56); }
.prose { --qa-legacy-color: rgb(21, 20, 19); }
.prose p { background-image: URL("data:image/png;base64,AA"); }
`);
  await write(path.join(root, 'parts', 'typora-helper.css'), '#write h1 { color: rgb(1, 2, 3); }\n');
  const css = await readThemeCSS('legacy.css', root);
  assert.match(css, /(?:^|\n)\.topbar\{color:rgb\(9, 8, 7\)\}/);
  assert.match(css, /(?:^|\n)\.sidebar-tabs\{border-bottom:0\}/);
  assert.match(css, /(?:^|\n)button\[data-command="settings"\]\{outline:2px solid rgb\(12, 34, 56\)\}/);
  assert.match(css, /(?:^|\n)\.prose\{--qa-legacy-color:rgb\(21, 20, 19\)\}/);
  assert.match(css, /(?:^|\n)\.prose p\{background-image:URL\("data:image\/png;base64,AA"\)\}/);
  // The imported helper contains #write, but the entry has no #write selector:
  // the whole import tree stays in legacy mode and keeps the selector as-is.
  assert.match(css, /(?:^|\n)#write h1\{color:rgb\(1, 2, 3\)\}/);
  assert.doesNotMatch(css, /:is\(#write, \.write-surface\) h1/);
  assert.doesNotMatch(css, /url\("URL\(/);
});

test('mode detection ignores #write in comments and attribute values', async t => {
  const root = await fixture(t);
  await write(path.join(root, 'legacy.css'), `/* #write { color: rgb(1, 2, 3); } */
[data-x="#write"] { color: rgb(4, 5, 6); }
#write-box { color: rgb(7, 8, 9); }
`);
  const css = await readThemeCSS('legacy.css', root);
  assert.match(css, /\[data-x="#write"\]\{color:rgb\(4, 5, 6\)\}/);
  assert.match(css, /#write-box\{color:rgb\(7, 8, 9\)\}/);
  assert.doesNotMatch(css, /:is\(#write, \.write-surface\)/);
});
