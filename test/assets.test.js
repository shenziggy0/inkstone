import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assets from '../electron/assets.cjs';
import storeModule from '../electron/store.cjs';
import { frontMatterImageRoot as sharedImageRoot, replaceFrontMatterImageRoot } from '../electron/front-matter.mjs';
import { ALLOWED_URI, RESERVED_ATTRIBUTES, SANITIZE_CONFIG, assetURL, decodeAssetReference, frontMatterImageRoot as rendererImageRoot, setFrontMatterImageRoot, isNetworkReference } from '../src/markdown.js';

const { imageMime, parseAssetURL, referenceFromPath, resolveAssetFile, resolveDocumentLink, resolveImageRoot, isExecutableExtension, unsavedAssetsDirectory } = assets;
const { frontMatterImageRoot: documentImageRoot, relocateImageRoot } = storeModule;

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
  const network = ['\\\\attacker\\share\\x.png', '//attacker/share/x.png', '\\\\?\\UNC\\attacker\\share\\x.png', '\\\\.\\C:\\x.png', 'file://attacker/x.png', 'file://192.0.2.1/share/x.png', 'FILE://ATTACKER/x.png', 'file:///\\\\attacker/share/x.png', 'file:////attacker/share/x.png', 'file://localhost//attacker/share/x.png'];
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
    'file://attacker/x.png',
    // WHATWG parsing leaves these with an empty host and a `//…` pathname.
    // Windows `fileURLToPath` then throws "must be absolute" instead of
    // returning a UNC path; they are still network locations.
    'file:///\\\\attacker/share/x.png',
    'file:////attacker/share/x.png',
    'file://localhost//attacker/share/x.png'
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
  // otherwise resolve to UNC; it must be refused before it is stat'ed as well.
  // The last two spellings lose their UNC prefix in `dirname()`/`resolve()`
  // (`///192.0.2.1/share` becomes `\192.0.2.1\share`, `\\192.0.2.1` becomes
  // `\`), so they are only caught if the base is checked before normalisation.
  const shareDocuments = [
    '\\\\192.0.2.1\\share\\note.md',
    '//192.0.2.1/share/note.md',
    '\\\\?\\UNC\\192.0.2.1\\share\\note.md',
    '\\\\.\\PIPE\\note.md',
    '///192.0.2.1/share/note.md',
    '\\\\192.0.2.1'
  ];
  for (const share of shareDocuments) {
    await assert.rejects(resolveAssetFile('assets/a.png', { documentPath: share }), /网络位置/, `${share} 目录下的相对引用必须被拒绝`);
    await assert.rejects(resolveDocumentLink('assets/a.md', { documentPath: share }), /网络位置/, `${share} 目录下的相对链接必须被拒绝`);
  }
  // The two predicates behind those rejections behave as documented.
  assert.equal(assets.isNetworkPath('\\\\host\\share\\x.png'), true);
  assert.equal(assets.isNetworkPath('//host/share/x.png'), true);
  assert.equal(assets.isNetworkPath('C:/Users/a.png'), false);
  assert.equal(assets.isNetworkPath('C:\\Users\\a.png'), false);
  assert.equal(assets.isNetworkFileURL(new URL('file://host/x.png')), true);
  assert.equal(assets.isNetworkFileURL(new URL('file://192.0.2.1/share/x.png')), true);
  assert.equal(assets.isNetworkFileURL(new URL('file:///C:/x.png')), false);
  assert.equal(assets.isNetworkFileURL(new URL('file://localhost/C:/x.png')), false);
  assert.equal(assets.isNetworkFileURL(new URL('file:///\\\\attacker/share')), true, '空 host 的 UNC file URL');
  assert.equal(assets.isNetworkFileURL(new URL('file:////attacker/share')), true, '四斜杠 UNC file URL');
  // Windows converts a host-ful file URL into a UNC path (POSIX refuses the
  // host instead). The empty-host spelling throws there, which is why the
  // resolver classifies the URL before `fileURLToPath` and not in its catch.
  assert.equal(fileURLToPath(new URL('file://attacker/share'), { windows: true }), '\\\\attacker\\share');
  assert.throws(() => fileURLToPath(new URL('file:///\\\\attacker/share'), { windows: true }), { code: 'ERR_INVALID_FILE_URL_PATH' });
});

test('a share as the relative base is refused without any filesystem call', async t => {
  // Timing is not evidence here. `///host/share` normalises to `\host\share`
  // and `\\host` to `\`, so a resolver that only inspected the resolved target
  // would call realpath(). Point realpath() at a failure that cannot be mistaken
  // for a network refusal: a share base must still answer with its own error,
  // while an ordinary local base must reach it exactly as before.
  const root = await fixture(t);
  const originalRealpath = fs.realpath;
  fs.realpath = async () => { throw new Error('文件系统访问不应发生'); };
  try {
    for (const share of ['///host/share/note.md', '\\\\host', '\\\\host\\share\\note.md', '//host/share/note.md', '\\\\?\\UNC\\host\\share\\note.md', '\\\\.\\PIPE\\note.md']) {
      await assert.rejects(resolveAssetFile('assets/a.png', { documentPath: share }), /网络位置/, `${share} 作为文档目录时图片必须被拒绝`);
      await assert.rejects(resolveDocumentLink('assets/a.md', { documentPath: share }), /网络位置/, `${share} 作为文档目录时链接必须被拒绝`);
      await assert.rejects(resolveAssetFile('assets/a.png', { unsavedDirectory: share }), /网络位置/, `${share} 作为未保存目录时图片必须被拒绝`);
      await assert.rejects(resolveDocumentLink('assets/a.md', { unsavedDirectory: share }), /网络位置/, `${share} 作为未保存目录时链接必须被拒绝`);
    }
    // Positive control: the stub is live and ordinary local bases still use the
    // host's own rules to reach the first filesystem call.
    await assert.rejects(resolveAssetFile('assets/a.png', { documentPath: path.join(root, 'note.md') }), /文件系统访问不应发生/);
  } finally {
    fs.realpath = originalRealpath;
  }
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
  await assert.rejects(resolveDocumentLink('file:///\\\\server/share/a.md', { documentPath }), /不支持指向网络位置的链接/);
  await assert.rejects(resolveDocumentLink('file:////server/share/a.md', { documentPath }), /不支持指向网络位置的链接/);
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


test('a configured image root serves only /-prefixed images and refuses escapes', async t => {
  const root = await fixture(t);
  const docs = path.join(root, 'docs');
  const assets = path.join(docs, '图片 root');
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, '图片 one.svg'), '<svg/>');
  await fs.writeFile(path.join(docs, '图片 one.svg'), '<svg/>');
  await fs.writeFile(path.join(docs, 'outside.svg'), '<svg/>');
  await fs.symlink(path.join(docs, 'outside.svg'), path.join(assets, 'symlink.svg'));
  const documentPath = path.join(docs, 'note.md');
  const options = { documentPath, imageRoot: '图片 root' };

  assert.equal(await resolveAssetFile('/%E5%9B%BE%E7%89%87%20one.svg', options), await fs.realpath(path.join(assets, '图片 one.svg')), '编码的空格与中文以图根为基准');
  assert.equal(await resolveAssetFile('/图片 one.svg', options), await fs.realpath(path.join(assets, '图片 one.svg')), '含空格的原始写法');
  // Only the leading-slash form is redirected. A plain relative reference is
  // exactly what it was before, even when the file also exists under the root.
  assert.equal(await resolveAssetFile('图片 one.svg', { ...options, decoded: true }), await fs.realpath(path.join(docs, '图片 one.svg')));
  // `decodeURI` turns `%2e` into `.`, so the lexical escape is visible before
  // realpath; the realpath then refuses a symlink that leaves the folder.
  await assert.rejects(resolveAssetFile('/%2e%2e/outside.svg', options), /图片路径无效/);
  await assert.rejects(resolveAssetFile('/../outside.svg', options), /图片路径无效/);
  await assert.rejects(resolveAssetFile('/symlink.svg', options), /图片路径无效/);
  // A local file URL and a Windows drive path keep their old meaning.
  assert.equal(await resolveAssetFile(pathToFileURL(path.join(docs, 'outside.svg')).href, options), await fs.realpath(path.join(docs, 'outside.svg')));
  // The document setting wins over the optional global fallback.
  const shared = path.join(root, 'shared root');
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, '图片 one.svg'), '<svg/>');
  assert.equal(await resolveAssetFile('/图片 one.svg', { documentPath, globalImageRoot: shared }), await fs.realpath(path.join(shared, '图片 one.svg')));
  assert.equal(await resolveAssetFile('/图片 one.svg', options), await fs.realpath(path.join(assets, '图片 one.svg')));
  // Without any root, `/abs/a.png` is still the host's absolute path.
  const absolute = path.join(root, 'absolute.png');
  await fs.writeFile(absolute, 'png');
  assert.equal(await resolveAssetFile(absolute, { documentPath }), await fs.realpath(absolute));
  // `resolveImageRoot` canonicalises the folder itself, so `/x` cannot escape it.
  assert.equal(await resolveImageRoot('图片 root', { documentPath }), await fs.realpath(assets));
});

test('a network image root is refused before any filesystem call', async t => {
  const root = await fixture(t);
  const documentPath = path.join(root, 'note.md');
  const originalRealpath = fs.realpath;
  fs.realpath = async () => { throw new Error('文件系统访问不应发生'); };
  try {
    for (const imageRoot of ['\\\\attacker\\share', '//attacker/share', 'file://attacker/share', 'file://192.0.2.1/share', 'file:///\\\\attacker/share', 'file:////attacker/share', 'file://localhost//attacker/share']) {
      await assert.rejects(resolveAssetFile('/a.png', { documentPath, imageRoot }), /网络位置/, `${imageRoot} 必须在文件系统调用前被拒绝`);
      await assert.rejects(resolveImageRoot(imageRoot, { documentPath }), /网络位置/, `${imageRoot} 作为图根本身必须被拒绝`);
    }
    // A positive control proves the stub is live: a local root does reach the
    // first filesystem call.
    await assert.rejects(resolveAssetFile('/a.png', { documentPath, imageRoot: 'images' }), /文件系统访问不应发生/);
  } finally { fs.realpath = originalRealpath; }
});

test('a decoded asset reference is not percent-decoded twice', async t => {
  const root = await fixture(t);
  const documentPath = path.join(root, 'note.md');
  await fs.writeFile(path.join(root, 'a%20b.svg'), 'literal percent');
  await fs.writeFile(path.join(root, 'a b.svg'), 'space');
  // The URL segment had already been decoded once, so `%20` is a literal part
  // of the file name; decoding again would silently open `a b.svg` instead.
  assert.equal(await resolveAssetFile('a%20b.svg', { documentPath, decoded: true }), await fs.realpath(path.join(root, 'a%20b.svg')));
  assert.equal(await resolveAssetFile('a%20b.svg', { documentPath }), await fs.realpath(path.join(root, 'a b.svg')));
});

test('asset URLs carry a root only for the references a root can affect', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const rooted = assetURL(id, '/images/a b.svg', '图片 root');
  const parsed = parseAssetURL(rooted);
  assert.equal(parsed.documentId, id);
  assert.equal(parsed.reference, '/images/a b.svg');
  assert.equal(parsed.imageRoot, '图片 root');
  assert.match(parsed.reference, /^\//, '图根适用范围必须由开头的 / 保留');
  // Relative references keep their previous URL: a root cannot change them.
  assert.equal(assetURL(id, 'assets/a.png', '图片 root'), assetURL(id, 'assets/a.png'));
  assert.equal(parseAssetURL(assetURL(id, 'assets/a.png')).imageRoot, null);
  // A root-relative URL always states its root, so «the line was just removed»
  // is distinguishable from «the renderer does not know», even before the
  // document flush reaches the store.
  const cleared = assetURL(id, '/absolute/a.png');
  assert.match(cleared, /\?root=$/);
  assert.equal(parseAssetURL(cleared).imageRoot, '');
  // A `//host` reference never reaches assetURL(), but the guard keeps it out
  // of the rooted branch as well.
  assert.equal(assetURL(id, '//host/a.png', '图片 root').includes('?root='), false);
});

test('front matter root parsing agrees between the renderer and the main process', () => {
  const samples = [
    ['---\r\ntypora-root-url: "图片 root"\r\n---\r\n\r\n# 文档', '图片 root'],
    ['\uFEFF---\r\ntypora-root-url: ' + "'图片 root'" + '\r\n---\r\n', '图片 root'],
    ['---\ntypora-root-url: ./images # 注释\n---\n', './images'],
    ['---\ntypora-root-url: C:\\\\Users\\\\图片\n---\n', 'C:\\\\Users\\\\图片'],
    ['---\ntypora-root-url: "C:\\\\Users\\\\图片"\n---\n', 'C:\\Users\\图片'],
    ['---\r\ntypora-root-url: ""\r\n---\r\n', null],
    ['---\ntitle: x\n---\n', null],
    ['---\ntypora-root-url: |\n  images\n---\n', null],
    ['# 没有属性\n---\ntypora-root-url: images\n---\n', null],
    ['---\r\ntypora-root-url: 图片 root\r\ntitle: 标题\r\n---\r\n', '图片 root']
  ];
  assert.equal(rendererImageRoot, sharedImageRoot, 'renderer 必须复用共享实现');
  assert.equal(documentImageRoot, sharedImageRoot, 'store 必须复用共享实现');
  for (const [source, expected] of samples) {
    assert.equal(rendererImageRoot(source), expected, `renderer：${JSON.stringify(source)}`);
    assert.equal(documentImageRoot(source), expected, `store：${JSON.stringify(source)}`);
    assert.equal(sharedImageRoot(source), expected, `shared：${JSON.stringify(source)}`);
  }
});

test('the root rewrite edits only the real key while its value still matches', () => {
  const source = '---\r\ntypora-root-url: "图片 root"\r\n---\r\n\r\n```yaml\r\ntypora-root-url: "图片 root"\r\n```\r\n';
  const change = replaceFrontMatterImageRoot(source, '图片 root', '../images');
  const next = source.slice(0, change.from) + change.insert + source.slice(change.to);
  assert.match(next, /^---\r\ntypora-root-url: "\.\.\/images"\r\n---\r\n/);
  assert.equal(next.includes('```yaml\r\ntypora-root-url: "图片 root"\r\n```'), true, '代码围栏中的同名文本不得被改写');
  // A concurrent edit changed or removed the key: keep the newer text.
  assert.equal(replaceFrontMatterImageRoot(source, 'another root', '../images'), null);
  const removed = '---\r\ntitle: x\r\n---\r\n\r\n```yaml\r\ntypora-root-url: "图片 root"\r\n```\r\n';
  assert.equal(replaceFrontMatterImageRoot(removed, '图片 root', '../images'), null);
  assert.equal(replaceFrontMatterImageRoot('正文\n', '图片 root', '../images'), null);
  // Removing the key deletes the line and its own break, never the delimiter.
  const removal = replaceFrontMatterImageRoot(source, '图片 root', null);
  const cleared = source.slice(0, removal.from) + removal.insert + source.slice(removal.to);
  assert.match(cleared, /^---\r\n---\r\n/);
});

test('the root entry writes, replaces and removes the front matter line', () => {
  const created = setFrontMatterImageRoot('正文\n', '图片 root');
  assert.deepEqual(created, { from: 0, to: 0, insert: '---\ntypora-root-url: "图片 root"\n---\n\n' });
  const source = '---\ntitle: 文档\n---\n\n正文\n';
  const added = setFrontMatterImageRoot(source, './images');
  const withRoot = source.slice(0, added.from) + added.insert + source.slice(added.to);
  assert.equal(rendererImageRoot(withRoot), './images');
  const replaced = setFrontMatterImageRoot(withRoot, '图片 root');
  const next = withRoot.slice(0, replaced.from) + replaced.insert + withRoot.slice(replaced.to);
  assert.equal(rendererImageRoot(next), '图片 root');
  const removed = setFrontMatterImageRoot(next, null);
  assert.equal(rendererImageRoot(next.slice(0, removed.from) + removed.insert + next.slice(removed.to)), null);
  // A BOM stays in front of the new block.
  const bom = setFrontMatterImageRoot('\uFEFF正文\n', 'images');
  assert.equal(bom.from, 1);
});

test('Save As relocates a document-relative image root and keeps CRLF', () => {
  const content = '---\r\ntypora-root-url: "图片 root"\r\n---\r\n\r\n# 文档\r\n';
  const from = path.join('/tmp', 'one', 'docs', 'note.md');
  const to = path.join('/tmp', 'one', 'elsewhere', 'nested', 'copy.md');
  const moved = relocateImageRoot(content, from, to);
  assert.match(moved.content, /^---\r\ntypora-root-url: "\.\.\/\.\.\/docs\/图片 root"\r\n---\r\n/, moved.content);
  assert.equal(moved.content.replace(/\r\n/g, '').includes('\n'), false, '只允许 CRLF');
  assert.deepEqual(moved.imageRootRewrite, { expected: '图片 root', value: '../../docs/图片 root' });
  // Absolute roots and a same-directory save need no rewrite.
  const absolute = '---\r\ntypora-root-url: "/var/images"\r\n---\r\n';
  assert.deepEqual(relocateImageRoot(absolute, from, to), { content: absolute, imageRootRewrite: null });
  assert.deepEqual(relocateImageRoot(content, from, path.join(path.dirname(from), 'other.md')), { content, imageRootRewrite: null });
});
