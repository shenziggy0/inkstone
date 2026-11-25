import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAssetFile } from '../electron/assets.cjs';
import { collectAssetReferences } from '../electron/asset-references.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const firstImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const secondImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=', 'base64');

async function unpack(file) {
  const { unzipSync } = await import('fflate');
  return Object.fromEntries(Object.entries(unzipSync(await fs.readFile(file))).map(([name, bytes]) => [name, Buffer.from(bytes)]));
}

test('ZIP preserves BOM and CRLF and carries each readable local image once', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'photos'));
  await fs.mkdir(path.join(root, 'reference'));
  await fs.writeFile(path.join(root, 'photos', 'a.png'), firstImage);
  await fs.writeFile(path.join(root, 'reference', 'a.png'), secondImage);
  const content = [
    '\uFEFF---', 'title: 手记', 'typora-root-url: reference', '---', '',
    '![本地](photos/a.png "标题") ![重复](./photos/a.png)', '', '![根目录][pic]', '',
    '[pic]: /a.png', '', '![网络](https://example.invalid/p.png)', '',
    '```md', '![示例](skipped.png)', '```', ''
  ].join('\r\n');
  const file = path.join(root, '手记.md');
  await fs.writeFile(file, content);
  const prepared = await prepareDocumentZip({ path: file, name: '手记.md', content });
  assert.deepEqual(prepared.missing, []);

  const target = path.join(root, 'portable.zip');
  await writeDocumentZip(prepared, target);
  const entries = await unpack(target);
  assert.deepEqual(Object.keys(entries).sort(), ['assets/a-1.png', 'assets/a.png', '手记.md']);
  assert.deepEqual(entries['assets/a.png'], firstImage);
  assert.deepEqual(entries['assets/a-1.png'], secondImage);
  assert.deepEqual(entries['手记.md'], Buffer.from([
    '\uFEFF---', 'title: 手记', '---', '',
    '![本地](assets/a.png "标题") ![重复](assets/a.png)', '', '![根目录][pic]', '',
    '[pic]: assets/a-1.png', '', '![网络](https://example.invalid/p.png)', '',
    '```md', '![示例](skipped.png)', '```', ''
  ].join('\r\n')));
  assert.deepEqual(await fs.readFile(file), Buffer.from(content));
  assert.deepEqual(await fs.readFile(path.join(root, 'photos', 'a.png')), firstImage);
  assert.deepEqual(await fs.readFile(path.join(root, 'reference', 'a.png')), secondImage);

  const extracted = path.join(root, 'offline');
  await fs.mkdir(path.join(extracted, 'assets'), { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) await fs.writeFile(path.join(extracted, name), bytes);
  await fs.rm(path.join(root, 'photos'), { recursive: true });
  await fs.rm(path.join(root, 'reference'), { recursive: true });
  const documentPath = path.join(extracted, '手记.md');
  const references = collectAssetReferences(await fs.readFile(documentPath, 'utf8'));
  assert.deepEqual(await Promise.all(references.map(async ({ src }) => fs.readFile(await resolveAssetFile(src, { documentPath })))), [firstImage, firstImage, secondImage]);
});

test('ZIP preparation reports missing images without touching an existing target', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  const target = path.join(root, 'draft.zip');
  const draftAssets = path.join(root, 'temporary', 'assets');
  await fs.mkdir(draftAssets, { recursive: true });
  await fs.writeFile(path.join(draftAssets, '剪贴图.png'), firstImage);
  await fs.writeFile(path.join(draftAssets, '未引用.png'), secondImage);
  await fs.writeFile(target, 'previous archive');
  const content = '![剪贴图](assets/剪贴图.png)\n![缺失](missing.png) ![重复缺失](missing.png)';
  const prepared = await prepareDocumentZip({ name: '草稿.md', content }, { unsavedDirectory: path.dirname(draftAssets) });
  assert.deepEqual(prepared.missing, ['missing.png']);
  assert.equal(await fs.readFile(target, 'utf8'), 'previous archive');

  await fs.rm(draftAssets, { recursive: true });
  await writeDocumentZip(prepared, target);
  const entries = await unpack(target);
  assert.deepEqual(Object.keys(entries).sort(), ['assets/剪贴图.png', '草稿.md']);
  assert.deepEqual(entries['assets/剪贴图.png'], firstImage);
  assert.equal(entries['草稿.md'].toString(), '![剪贴图](assets/%E5%89%AA%E8%B4%B4%E5%9B%BE.png)\n![缺失](missing.png) ![重复缺失](missing.png)');
});

test('ZIP updates an image when its reference definition is also used by an ordinary link', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'a.png'), firstImage);
  const content = '![图][pic] [原始链接][pic]\n\n[pic]: a.png "相册"\n';
  const target = path.join(root, 'portable.zip');
  await writeDocumentZip(await prepareDocumentZip({ path: path.join(root, 'document.md'), content }), target);
  const entries = await unpack(target);
  assert.equal(entries['document.md'].toString(), '![图](assets/a.png "相册") [原始链接][pic]\n\n[pic]: a.png "相册"\n');
});

test('ZIP carries an image with its shared reference label split across lines', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'a.png'), firstImage);
  const content = '> ![图][\r\n> pic] 末尾\r\n\r\n[pic]: a.png "相册"\r\n\r\n[原始链接][pic]\r\n';
  const target = path.join(root, 'portable.zip');
  const prepared = await prepareDocumentZip({ path: path.join(root, 'document.md'), content });
  assert.deepEqual(prepared.missing, []);
  await writeDocumentZip(prepared, target);
  const entries = await unpack(target);
  assert.deepEqual(entries['assets/a.png'], firstImage);
  assert.equal(entries['document.md'].toString(), '> ![图](assets/a.png "相册") 末尾\r\n\r\n[pic]: a.png "相册"\r\n\r\n[原始链接][pic]\r\n');
});

test('ZIP carries local HTML images and preserves the author’s other HTML', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '海(岸)#1.png'), firstImage);
  const content = '内嵌 <img alt="海岸" SRC=\'海(岸)#1.png\'>\n\n<div>\n  <img src="海(岸)&#35;1.png" width="20">\n  <!-- <img src="skipped.png"> -->\n</div>\n';
  const target = path.join(root, 'portable.zip');
  const prepared = await prepareDocumentZip({ path: path.join(root, 'document.md'), content });
  assert.deepEqual(prepared.missing, []);
  await writeDocumentZip(prepared, target);
  const entries = await unpack(target);
  assert.deepEqual(Object.keys(entries).sort(), ['assets/海(岸)-1.png', 'document.md']);
  assert.deepEqual(entries['assets/海(岸)-1.png'], firstImage);
  const reference = 'assets/%E6%B5%B7%28%E5%B2%B8%29-1.png';
  assert.equal(entries['document.md'].toString(), `内嵌 <img alt="海岸" SRC='${reference}'>\n\n<div>\n  <img src="${reference}" width="20">\n  <!-- <img src="skipped.png"> -->\n</div>\n`);
});

test('ZIP cannot replace a directory and leaves no partial output behind', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  const target = path.join(root, 'document.zip');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'original');
  const prepared = await prepareDocumentZip({ name: '草稿.md', content: '# 手记' });
  await assert.rejects(writeDocumentZip(prepared, target));
  assert.deepEqual(await fs.readdir(root), ['document.zip']);
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'original');
});

test('ZIP rejects a target that points at a source document or image', async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  const file = path.join(root, 'document.md');
  const image = path.join(root, 'image.png');
  const content = '![图](image.png)';
  await fs.writeFile(file, content);
  await fs.writeFile(image, firstImage);
  const prepared = await prepareDocumentZip({ path: file, content });
  await assert.rejects(writeDocumentZip(prepared, file), /原稿或原图/);
  await assert.rejects(writeDocumentZip(prepared, image), /原稿或原图/);
  assert.equal(await fs.readFile(file, 'utf8'), content);
  assert.deepEqual(await fs.readFile(image), firstImage);
});

test('ZIP also protects an unreadable image after continuing past the missing image warning', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
}, async t => {
  const { prepareDocumentZip, writeDocumentZip } = await import('../electron/document-zip.cjs');
  const root = await fixture(t);
  const image = path.join(root, 'image.png');
  const alias = path.join(root, 'existing.zip');
  await fs.writeFile(image, firstImage);
  await fs.link(image, alias);
  await fs.chmod(image, 0o000);
  try {
    await assert.rejects(fs.readFile(image), { code: 'EACCES' });
    const doc = { path: path.join(root, 'document.md'), content: '![图](image.png)' };
    const prepared = await prepareDocumentZip(doc);
    assert.deepEqual(prepared.missing, ['image.png']);
    await assert.rejects(writeDocumentZip(prepared, image), /原稿或原图/);
    await assert.rejects(writeDocumentZip(prepared, alias), /原稿或原图/);
  } finally {
    await fs.chmod(image, 0o600);
  }
  assert.deepEqual(await fs.readFile(image), firstImage);
});
