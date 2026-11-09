import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasConfiguredImageRoot, rewriteRootImages } = require('../electron/pandoc-ast.cjs');
const { resolveAssetFile } = require('../electron/assets.cjs');

const image = (src, alt = '替代文本', title = '') => ({
  t: 'Image',
  c: [['', [], []], [{ t: 'Str', c: alt }], [src, title]]
});
const astOf = (inlines, meta = {}) => ({
  'pandoc-api-version': [1, 23, 1],
  meta,
  blocks: [{ t: 'Para', c: inlines }]
});

test('an image root is only considered configured when it has a value', () => {
  assert.equal(hasConfiguredImageRoot('media-root', null), true);
  assert.equal(hasConfiguredImageRoot(null, 'media-root'), true);
  assert.equal(hasConfiguredImageRoot('', null), false);
  assert.equal(hasConfiguredImageRoot('   ', null), false);
  assert.equal(hasConfiguredImageRoot(undefined, undefined), false);
  assert.equal(hasConfiguredImageRoot(42, null), false);
});

test('only single-slash Image destinations are rewritten and alt/title survive', async () => {
  const ast = astOf([
    image('/图 片.png', '有效图', '标题一'),
    image('./plain.png', '相对图'),
    image('/missing.png', '缺失图'),
    image('//attacker/share/x.png', '网络图'),
    image('https://example.com/x.png', '外链图'),
    image('C:/Users/x.png', '盘符图')
  ], { title: { t: 'MetaInlines', c: [{ t: 'Str', c: '/metadata.png' }] } });
  const seen = [];
  const report = await rewriteRootImages(ast, async src => {
    seen.push(src);
    if (src === '/missing.png') {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return `/private/tmp/root/${src.slice(1)}`;
  });

  assert.deepEqual(seen, ['/图 片.png', '/missing.png']);
  assert.equal(report.rootImages, 2);
  assert.equal(report.rewritten, 1);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].src, '/missing.png');
  assert.equal(report.unresolved[0].code, 'ENOENT');

  const inlines = ast.blocks[0].c;
  assert.equal(inlines[0].c[2][0], '/private/tmp/root/图 片.png');
  assert.deepEqual(inlines[0].c[1], [{ t: 'Str', c: '有效图' }]);
  assert.equal(inlines[0].c[2][1], '标题一');
  assert.equal(inlines[1].c[2][0], './plain.png');
  // The refused image is replaced by its alt inlines, not left as `/missing.png`.
  assert.deepEqual(inlines[2], { t: 'Str', c: '缺失图' });
  assert.equal(inlines[3].c[2][0], '//attacker/share/x.png');
  assert.equal(inlines[4].c[2][0], 'https://example.com/x.png');
  assert.equal(inlines[5].c[2][0], 'C:/Users/x.png');
  assert.equal(ast.meta.title.c[0].c, '/metadata.png');
  assert.doesNotMatch(JSON.stringify(ast), /\/missing\.png/);
});

test('consecutive refused images are replaced in order without shifting siblings', async () => {
  const ast = astOf([
    { t: 'Str', c: '前' },
    { t: 'Image', c: [['', [], []], [{ t: 'Emph', c: [{ t: 'Str', c: '重点' }] }], ['/a.png', 'A']] },
    { t: 'Image', c: [['', [], []], [], ['/b.png', 'B']] },
    { t: 'Str', c: '后' }
  ]);
  const report = await rewriteRootImages(ast, async () => { throw new Error('refused'); });
  assert.equal(report.rootImages, 2);
  assert.equal(report.rewritten, 0);
  assert.deepEqual(ast.blocks[0].c, [
    { t: 'Str', c: '前' },
    { t: 'Emph', c: [{ t: 'Str', c: '重点' }] },
    { t: 'Str', c: '后' }
  ]);
  assert.doesNotMatch(JSON.stringify(ast), /\/a\.png|\/b\.png/);
});

test('a refused root image validates nested Images in its alt before fallback', async () => {
  const validInner = image('/inside/ok.png', '内层正常', '内层标题');
  const refusedInner = image('/private/host/secret.png', '内层拒绝', '内层标题');
  const outer = {
    t: 'Image',
    c: [['', [], []], [validInner, { t: 'Str', c: ' 和 ' }, refusedInner], ['/missing.png', '外层标题']]
  };
  const ast = astOf([outer]);
  const seen = [];
  const report = await rewriteRootImages(ast, async src => {
    seen.push(src);
    if (src === '/inside/ok.png') return '.staging/0.png';
    throw new Error('refused');
  });

  // The outer image is refused first; its alt is then traversed, so the nested
  // host path is still resolved/refused instead of being promoted verbatim.
  assert.deepEqual(seen, ['/missing.png', '/inside/ok.png', '/private/host/secret.png']);
  assert.equal(report.rootImages, 3);
  assert.equal(report.rewritten, 1);
  assert.equal(report.unresolved.length, 2);
  assert.deepEqual(ast.blocks[0].c, [
    image('.staging/0.png', '内层正常', '内层标题'),
    { t: 'Str', c: ' 和 ' },
    { t: 'Str', c: '内层拒绝' }
  ]);
  assert.doesNotMatch(JSON.stringify(ast), /\/missing\.png|private\/host/);
});

test('links, math and non-root image paths keep their destinations', async () => {
  const ast = astOf([
    { t: 'Link', c: [['', [], []], [{ t: 'Str', c: '链接' }], ['/link-target', '']] },
    { t: 'Math', c: [{ t: 'InlineMath' }, '\\label{x}'] },
    image('assets/local.png', '本地图'),
    image('/rooted.png', '根图')
  ]);
  const report = await rewriteRootImages(ast, async src => `/safe${src}`);
  assert.equal(report.rootImages, 1);
  assert.equal(report.rewritten, 1);
  assert.equal(ast.blocks[0].c[0].c[2][0], '/link-target');
  assert.deepEqual(ast.blocks[0].c[1], { t: 'Math', c: [{ t: 'InlineMath' }, '\\label{x}'] });
  assert.equal(ast.blocks[0].c[2].c[2][0], 'assets/local.png');
  assert.equal(ast.blocks[0].c[3].c[2][0], '/safe/rooted.png');
});

test('the shared resolver accepts spaces/Chinese and fallback removes escapes, symlinks and missing roots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-pandoc-ast-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = path.join(root, 'docs');
  const assets = path.join(docs, '图片 root');
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, '子 图.png'), 'png');
  await fs.writeFile(path.join(docs, 'outside.png'), 'png');
  await fs.symlink(path.join(docs, 'outside.png'), path.join(assets, 'symlink.png'));
  const documentPath = path.join(docs, 'note.md');

  const ast = astOf([
    image('/子 图.png', '中文空格'),
    image('/%E5%AD%90%20%E5%9B%BE.png', '编码中文空格'),
    image('/../outside.png', '穿越图'),
    image('/symlink.png', '符号链接图'),
    image('/missing.png', '缺图')
  ]);
  const report = await rewriteRootImages(ast, src => resolveAssetFile(src, { documentPath, imageRoot: '图片 root' }));
  assert.equal(report.rootImages, 5);
  assert.equal(report.rewritten, 2);
  assert.equal(report.unresolved.length, 3);

  const inlines = ast.blocks[0].c;
  assert.equal(inlines[0].c[2][0], await fs.realpath(path.join(assets, '子 图.png')));
  assert.equal(inlines[1].c[2][0], await fs.realpath(path.join(assets, '子 图.png')));
  assert.deepEqual(inlines[2], { t: 'Str', c: '穿越图' });
  assert.deepEqual(inlines[3], { t: 'Str', c: '符号链接图' });
  assert.deepEqual(inlines[4], { t: 'Str', c: '缺图' });
  const serialized = JSON.stringify(ast);
  assert.doesNotMatch(serialized, /\.\.\/outside|outside\.png|\/symlink\.png|\/missing\.png/);
});

test('a document with no root image leaves the AST untouched', async () => {
  const ast = astOf([image('./plain.png'), image('assets/local.png')]);
  const before = JSON.stringify(ast);
  const report = await rewriteRootImages(ast, async () => { throw new Error('should not be called'); });
  assert.equal(report.rootImages, 0);
  assert.equal(report.rewritten, 0);
  assert.deepEqual(report.unresolved, []);
  assert.equal(JSON.stringify(ast), before);
});
