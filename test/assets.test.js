import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assets from '../electron/assets.cjs';
import { ALLOWED_URI, RESERVED_ATTRIBUTES, SANITIZE_CONFIG, assetURL, decodeAssetReference, isNetworkReference } from '../src/markdown.js';

const { imageMime, parseAssetURL, referenceFromPath, resolveAssetFile, resolveDocumentLink, isExecutableExtension, unsavedAssetsDirectory } = assets;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('the sanitizer URI allow-list keeps local image spellings and blocks scripts', () => {
  // DOMPurify's default list rejects both `C:/…` (read as an unknown scheme)
  // and `file:`; these are the two shapes this project adds back for images.
  for (const value of ['assets/a.png', '../shared/a.png', 'C:/Users/a.png', 'C:\\Users\\a.png', 'file:///C:/a.png', 'https://example.com/a.png', 'http://127.0.0.1:1/a.png']) {
    assert.ok(ALLOWED_URI.test(value), `应放行：${value}`);
  }
  // data: is not in this list: DOMPurify allows `data:image/*` on <img> through
  // its own tag-scoped rule, so the regex must not widen it to every element.
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox', 'data:text/html,x', 'data:image/png;base64,AA', 'inkstone-asset://id/a.png']) {
    assert.ok(!ALLOWED_URI.test(value), `不得放行：${value}`);
  }
});

test('DOMPurify is configured with every reserved attribute (no string pre-pass)', () => {
  // FORBID_ATTR is checked before ALLOW_DATA_ATTR by DOMPurify, which is why the
  // renderer needs no second, hand-written pass over the HTML string.
  assert.equal(SANITIZE_CONFIG.ALLOW_DATA_ATTR, true);
  assert.deepEqual([...SANITIZE_CONFIG.FORBID_ATTR].sort(), [...['srcdoc', ...RESERVED_ATTRIBUTES]].sort());
  // data-line is the one application attribute [TOC] / the outline need.
  assert.deepEqual(SANITIZE_CONFIG.ADD_ATTR, ['data-line']);
  assert.ok(!SANITIZE_CONFIG.FORBID_ATTR.includes('data-line'));
  // SVG and MathML go through the same attribute check as HTML.
  assert.equal(SANITIZE_CONFIG.USE_PROFILES.svg, true);
  assert.equal(SANITIZE_CONFIG.USE_PROFILES.mathMl, true);
});

test('network references are recognised without any filesystem access', () => {
  const network = ['\\\\attacker\\share\\x.png', '//attacker/share/x.png', '\\\\?\\UNC\\attacker\\share\\x.png', '\\\\.\\C:\\x.png', 'file://attacker/x.png', 'file://192.0.2.1/share/x.png', 'FILE://ATTACKER/x.png'];
  for (const reference of network) assert.equal(isNetworkReference(reference), true, `应认定为网络引用：${reference}`);
  const local = ['assets/a.png', '../shared/a.png', 'C:/Users/a.png', 'C:\\Users\\a.png', 'file:///C:/a.png', 'file://localhost/C:/a.png', 'https://example.com/a.png', 'data:image/png;base64,AA'];
  for (const reference of local) assert.equal(isNetworkReference(reference), false, `不应误判为网络引用：${reference}`);
});

test('the resolver refuses UNC, device and host-ful file URLs without touching the network', async t => {
  const root = await fixture(t);
  const documentPath = path.join(root, 'note.md');
  await fs.writeFile(path.join(root, 'a.png'), 'png');
  const network = [
    '\\\\192.0.2.1\\share\\x.png',
    '//192.0.2.1/share/x.png',
    '\\\\?\\UNC\\192.0.2.1\\share\\x.png',
    '\\\\.\\PIPE\\x.png',
    'file://192.0.2.1/share/x.png',
    'file://attacker/x.png'
  ];
  for (const reference of network) {
    const started = Date.now();
    await assert.rejects(resolveAssetFile(reference, { documentPath }), /网络位置/, `${reference} 必须被拒绝`);
    const elapsed = Date.now() - started;
    // Reaching realpath() would open an SMB session and leak the NTLM hash, so a
    // slow rejection is itself the failure this test is looking for.
    assert.ok(elapsed < 100, `${reference} 必须在未发起网络访问时立即拒绝，实际 ${elapsed}ms`);
  }
  // A relative reference under a document that itself lives on a share would
  // resolve to UNC; it must be refused before it is stat'ed as well.
  const started = Date.now();
  await assert.rejects(resolveAssetFile('assets/a.png', { documentPath: '\\\\192.0.2.1\\share\\note.md' }), /网络位置/);
  assert.ok(Date.now() - started < 100, 'UNC 文档目录下的相对引用也必须立即拒绝');
  // The two predicates behind those rejections behave as documented.
  assert.equal(assets.isNetworkPath('\\\\host\\share\\x.png'), true);
  assert.equal(assets.isNetworkPath('//host/share/x.png'), true);
  assert.equal(assets.isNetworkPath('C:/Users/a.png'), false);
  assert.equal(assets.isNetworkPath('C:\\Users\\a.png'), false);
  assert.equal(assets.isNetworkFileURL(new URL('file://host/x.png')), true);
  assert.equal(assets.isNetworkFileURL(new URL('file://192.0.2.1/share/x.png')), true);
  assert.equal(assets.isNetworkFileURL(new URL('file:///C:/x.png')), false);
  assert.equal(assets.isNetworkFileURL(new URL('file://localhost/C:/x.png')), false);
});

test('local absolute paths and local file URLs keep resolving', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'a.png');
  await fs.writeFile(file, 'png');
  const documentPath = path.join(root, 'note.md');
  const real = await fs.realpath(file);
  assert.equal(await resolveAssetFile(file.split(path.sep).join('/'), { documentPath }), real, '正斜杠绝对路径');
  assert.equal(await resolveAssetFile(file, { documentPath }), real, '反斜杠绝对路径');
  assert.equal(await resolveAssetFile(pathToFileURL(file).href, { documentPath }), real, 'file:/// URL');
  assert.equal(await resolveAssetFile(`file://localhost${pathToFileURL(file).pathname}`, { documentPath }), real, 'file://localhost URL');
  assert.equal(await resolveAssetFile('a.png', { documentPath }), real, '相对路径');
});

test('asset URLs round-trip every reference spelling the markdown source allows', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const references = [
    'assets/图片.png', 'assets/my%20pic.png', 'assets/my pic.png', '../shared/上级.png',
    'C:\\Users\\示例\\a b.png', 'C:/Users/example/a b.png', 'file:///C:/images/a.png', './assets/a.png',
    'assets/../img/../assets/a.png', 'assets/a%23b.png'
  ];
  for (const reference of references) {
    const url = assetURL(id, reference);
    const parsed = parseAssetURL(url);
    assert.equal(parsed.documentId, id, `文档 id 必须保留：${url}`);
    assert.equal(parsed.reference, decodeAssetReference(reference), `引用必须可还原：${reference} => ${url}`);
    // `..` must survive URL parsing, which is why the reference is one segment.
    assert.ok(!parsed.reference.startsWith('/'), `引用不得被改写成绝对路径：${url}`);
  }
  // The reference is a single opaque segment, so `../` is never collapsed.
  assert.match(assetURL(id, '../shared/上级.png'), /^inkstone-asset:\/\/[^/]+\/\.\.%2F/);
});

test('images resolve relative to the document, above it, and by absolute path', async t => {
  const root = await fixture(t);
  const docDirectory = path.join(root, 'doc');
  await fs.mkdir(path.join(docDirectory, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'shared'), { recursive: true });
  await fs.writeFile(path.join(docDirectory, 'assets', '图片.png'), 'png');
  await fs.writeFile(path.join(docDirectory, 'assets', 'my pic.png'), 'png');
  await fs.writeFile(path.join(root, 'shared', '上级.png'), 'png');
  const documentPath = path.join(docDirectory, 'note.md');
  const options = { documentPath };

  assert.equal(await resolveAssetFile('assets/图片.png', options), await fs.realpath(path.join(docDirectory, 'assets', '图片.png')));
  // markdown-it percent-encodes the destination, so the encoded spelling must work too.
  assert.equal(await resolveAssetFile('assets/my%20pic.png', options), await fs.realpath(path.join(docDirectory, 'assets', 'my pic.png')));
  assert.equal(await resolveAssetFile('../shared/上级.png', options), await fs.realpath(path.join(root, 'shared', '上级.png')));
  assert.equal(await resolveAssetFile(path.join(root, 'shared', '上级.png'), options), await fs.realpath(path.join(root, 'shared', '上级.png')));
  assert.equal(await resolveAssetFile(pathToFileURL(path.join(root, 'shared', '上级.png')).href, options), await fs.realpath(path.join(root, 'shared', '上级.png')));
  assert.equal(imageMime('a.SVG'), 'image/svg+xml');
});

test('the resolver only ever returns real image files', async t => {
  const root = await fixture(t);
  const documentPath = path.join(root, 'note.md');
  await fs.writeFile(path.join(root, 'plain.txt'), 'not an image');
  await fs.writeFile(path.join(root, 'a.png'), 'png');
  await assert.rejects(resolveAssetFile('plain.txt', { documentPath }), /图片路径无效/);
  await assert.rejects(resolveAssetFile('missing.png', { documentPath }), /ENOENT/);
  await assert.rejects(resolveAssetFile('https://example.com/a.png', { documentPath }), /仅支持文档中的本地图片/);
  await assert.rejects(resolveAssetFile('javascript:alert(1)', { documentPath }), /仅支持文档中的本地图片/);
  await assert.rejects(resolveAssetFile('', { documentPath }), /图片路径无效/);
  await assert.rejects(resolveAssetFile('a.png', {}), /仅支持文档中的本地图片/);
});

test('an unsaved document resolves assets inside its own temporary folder', async t => {
  const root = await fixture(t);
  const unsaved = path.join(root, 'unsaved-assets', '11111111-2222-3333-4444-555555555555');
  await fs.mkdir(path.join(unsaved, 'assets'), { recursive: true });
  await fs.writeFile(path.join(unsaved, 'assets', '粘贴 图片.png'), 'png');
  await fs.writeFile(path.join(root, 'outside.png'), 'png');
  assert.equal(await resolveAssetFile('assets/粘贴 图片.png', { unsavedDirectory: unsaved }), await fs.realpath(path.join(unsaved, 'assets', '粘贴 图片.png')));
  // Walking out of the temporary folder is refused while no path exists yet.
  await assert.rejects(resolveAssetFile('../../outside.png', { unsavedDirectory: unsaved }), /图片路径无效/);
  // Absolute references stay allowed, exactly like for a saved document.
  assert.equal(await resolveAssetFile(path.join(root, 'outside.png'), { unsavedDirectory: unsaved }), await fs.realpath(path.join(root, 'outside.png')));
});

test('the unsaved asset folder is keyed by a validated document id', async t => {
  const root = await fixture(t);
  const id = '11111111-2222-3333-4444-555555555555';
  assert.equal(unsavedAssetsDirectory(root, id), path.join(root, 'unsaved-assets', id));
  assert.throws(() => unsavedAssetsDirectory(root, '../../escape'), /文档标识无效/);
  assert.equal(referenceFromPath('/assets%2Fa.png'), 'assets/a.png');
  assert.equal(referenceFromPath('/%E0%A4%A'), '');
});

test('document links resolve relative references and reuse the network refusal', async t => {
  const root = await fixture(t);
  const folder = path.join(root, 'notes');
  await fs.mkdir(path.join(folder, 'sub'), { recursive: true });
  await fs.writeFile(path.join(folder, 'other.md'), '# other\n');
  await fs.writeFile(path.join(folder, 'sub', 'deep.md'), '# deep\n');
  const documentPath = path.join(folder, 'index.md');
  await fs.writeFile(documentPath, '# index\n');

  assert.equal(await resolveDocumentLink('./other.md', { documentPath }), await fs.realpath(path.join(folder, 'other.md')));
  assert.equal(await resolveDocumentLink('../notes/sub/deep.md', { documentPath }), await fs.realpath(path.join(folder, 'sub', 'deep.md')));
  // Percent-encoded Chinese and spaces reach the same file the author meant.
  await fs.writeFile(path.join(folder, '笔记 一.md'), '# n\n');
  assert.equal(await resolveDocumentLink('./%E7%AC%94%E8%AE%B0%20%E4%B8%80.md', { documentPath }), await fs.realpath(path.join(folder, '笔记 一.md')));
  // Any file type is allowed here, unlike images.
  await fs.writeFile(path.join(folder, 'a.pdf'), 'pdf');
  assert.equal(await resolveDocumentLink('a.pdf', { documentPath }), await fs.realpath(path.join(folder, 'a.pdf')));
  // A missing target is reported in Chinese instead of throwing a raw ENOENT.
  await assert.rejects(resolveDocumentLink('./missing.md', { documentPath }), /链接指向的文件不存在/);
  // Network locations are refused before the first filesystem call, exactly like
  // the image resolver: no SMB session may ever be opened by rendering a page.
  const uncPath = String.raw`\\host\share\a.md`;
  await assert.rejects(resolveDocumentLink(uncPath, { documentPath }), /不支持指向网络位置的链接/);
  await assert.rejects(resolveDocumentLink('//host/share/a.md', { documentPath }), /不支持指向网络位置的链接/);
  await assert.rejects(resolveDocumentLink('file://server/share/a.md', { documentPath }), /不支持指向网络位置的链接/);
  await assert.rejects(resolveDocumentLink('https://example.com/a.md', { documentPath }), /仅支持文档中的本地链接/);
  // A relative link of an unsaved document has no base folder to resolve against.
  await assert.rejects(resolveDocumentLink('./other.md', {}), /请先保存文档/);
});

test('executable and script targets are refused before anything can run them', () => {
  // Windows programs, scripts, installers and shell-affecting containers.
  for (const name of ['setup.exe', 'run.BAT', 'x.Cmd', 'a.ps1', 'a.psm1', 'a.vbs', 'a.vbe', 'a.js', 'a.jse',
    'a.wsf', 'a.wsh', 'a.hta', 'a.msi', 'a.msp', 'a.scr', 'a.cpl', 'a.lnk', 'a.url', 'a.reg', 'a.jar',
    'a.pif', 'a.application', 'a.gadget', 'a.appref-ms', 'a.settingcontent-ms']) {
    assert.equal(isExecutableExtension(name, { platform: 'win32', pathExt: '' }), true, `${name} 必须被拒绝`);
  }
  // The macOS list, including bundles.
  for (const name of ['安装.app', 'run.command', 'x.sh', 'x.pkg', 'x.terminal']) {
    assert.equal(isExecutableExtension(name, { platform: 'darwin', pathExt: '' }), true, `${name} 必须被拒绝`);
  }
  // Everything PATHEXT declares is refused too, so an extra registered type
  // cannot slip through on a machine we have never seen.
  assert.equal(isExecutableExtension('tool.pscustom', { platform: 'win32', pathExt: '.COM;.EXE;.PS1;.PSCUSTOM' }), true);
  // Plain documents and images stay allowed, with any casing.
  for (const name of ['notes.md', 'NOTES.MD', 'a.pdf', 'a.png', 'a.txt', 'a.docx', 'README']) {
    assert.equal(isExecutableExtension(name, { platform: 'win32', pathExt: '.COM;.EXE;.BAT;.CMD' }), false, `${name} 不应被拒绝`);
  }
  // A name without an extension is not executable by itself.
  assert.equal(isExecutableExtension('', {}), false);
  assert.equal(isExecutableExtension(undefined, {}), false);
});
