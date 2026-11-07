import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import storeModule from '../electron/store.cjs';
const { DocumentStore, inside, listMarkdown, syncAssets } = storeModule;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new DocumentStore(path.join(root, '.recovery')) };
}
test('UTF-8 BOM, CRLF, YAML, HTML and unsupported syntax survive an unchanged save byte for byte', async t => {
  const { root, store } = await fixture(t);
  const file = path.join(root, '中文.md');
  const original = Buffer.from('\uFEFF---\r\ntitle: 测试\r\n---\r\n\r\n# 标题\r\n\r\n<div>HTML</div>\r\n[^x]: note\r\n:custom:\r\n');
  await fs.writeFile(file, original);
  const doc = await store.open(file);
  assert.equal(doc.dirty, false);
  await store.save(doc.id);
  assert.deepEqual(await fs.readFile(file), original);
});
test('refuses to overwrite a changed file and leaves recovery text available', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old'); const doc = await store.open(file);
  await store.update(doc.id, 'mine'); await fs.writeFile(file, 'external');
  await assert.rejects(store.save(doc.id), /其他程序/);
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
  assert.equal(JSON.parse(await fs.readFile(path.join(store.recoveryDirectory, `${doc.id}.json`))).content, 'mine');
});
test('refuses to silently recreate a deleted original', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old'); const doc = await store.open(file);
  await store.update(doc.id, 'new'); await fs.unlink(file);
  await assert.rejects(store.save(doc.id), /删除/);
});
test('save failure retains the dirty document and original file', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old'); const doc = await store.open(file);
  await store.update(doc.id, 'new');
  await assert.rejects(store.save(doc.id, path.join(root, 'missing', 'new.md')));
  assert.equal(store.get(doc.id).dirty, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
});
test('recover unsaved work into a new unnamed document, once', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old'); const doc = await store.open(file);
  await store.update(doc.id, 'unsaved');
  const second = new DocumentStore(store.recoveryDirectory);
  const recovered = await second.recoverAll();
  assert.equal(recovered.length, 1); assert.equal(recovered[0].content, 'unsaved');
  assert.equal(recovered[0].path, null); assert.equal(recovered[0].dirty, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  await second.save(recovered[0].id, path.join(root, 'restored.md'));
  assert.deepEqual(await new DocumentStore(store.recoveryDirectory).recoverAll(), []);
});
test('primary startup recovers unsaved documents left by secondary windows', async t => {
  const { root, store } = await fixture(t);
  const secondary = new DocumentStore(path.join(store.recoveryDirectory, 'window-1'));
  const doc = secondary.create('secondary draft');
  await secondary.update(doc.id, 'secondary draft');
  assert.deepEqual(await store.recoverAll(), [], 'normal recovery must not steal a live secondary window');
  const recovered = await store.recoverAll(true);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].content, 'secondary draft');
  assert.deepEqual((await fs.readdir(path.join(store.recoveryDirectory, 'window-1'))).filter(name => name.endsWith('.json')), []);
});
test('serializes changes and saves without losing a later edit', async t => {
  const { root, store } = await fixture(t); const doc = store.create(); const file = path.join(root, 'note.md');
  await Promise.all([store.update(doc.id, 'first'), store.save(doc.id, file), store.update(doc.id, 'second')]);
  assert.equal(await fs.readFile(file, 'utf8'), 'first'); assert.equal(store.get(doc.id).content, 'second'); assert.equal(store.get(doc.id).dirty, true);
});
test('existing open target cannot be overwritten by another tab', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'one'); await store.open(file); const second = store.create('two');
  await assert.rejects(store.save(second.id, file), /另一个标签页/);
  assert.equal(await fs.readFile(file, 'utf8'), 'one');
});
test('rejects invalid UTF-8 and binary files without modifying them', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'bad.md');
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x42])); await assert.rejects(store.open(file));
  await fs.writeFile(file, 'a\0b'); await assert.rejects(store.open(file), /文本/);
});
test('reload reads the disk version back into an open document', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'first'); const doc = await store.open(file);
  await store.update(doc.id, 'local edit');
  await fs.writeFile(file, 'external version');
  const reloaded = await store.reload(doc.id);
  assert.equal(reloaded.content, 'external version');
  assert.equal(reloaded.dirty, false);
  assert.equal(store.get(doc.id).content, 'external version');
});
test('filesystem boundary check rejects prefix siblings and traversal; tree skips symlinks', async t => {
  const { root } = await fixture(t);
  assert.equal(inside(root, `${root}-other/file`), false); assert.equal(inside(root, path.resolve(root, '../elsewhere')), false);
  assert.equal(inside(root, path.join(root, 'ok.md')), true);
  await fs.writeFile(path.join(root, 'a.md'), '# A'); await fs.writeFile(path.join(root, 'b.js'), 'code');
  await fs.symlink(path.join(root, 'a.md'), path.join(root, 'link.md'));
  assert.deepEqual((await listMarkdown(root)).map(x => x.name), ['a.md']);
});
test('Save As carries only referenced assets into the new directory', async t => {
  const { root } = await fixture(t);
  const from = path.join(root, 'a'), to = path.join(root, 'b');
  await fs.mkdir(path.join(from, 'assets'), { recursive: true });
  await fs.writeFile(path.join(from, 'assets', 'pic.png'), 'image-bytes');
  await fs.writeFile(path.join(from, 'assets', 'unused.png'), 'not-referenced');
  const content = '![图](assets/pic.png)\n\n![远程](https://example.com/x.png)\n\n![越界](assets/../secret)\n';
  assert.equal(await syncAssets(content, path.join(from, 'note.md'), path.join(to, 'note.md')), 1);
  assert.equal(await fs.readFile(path.join(to, 'assets', 'pic.png'), 'utf8'), 'image-bytes');
  await assert.rejects(fs.readFile(path.join(to, 'assets', 'unused.png')));
  assert.equal(await syncAssets(content, path.join(from, 'note.md'), path.join(from, 'other.md')), 0, '同目录无需复制');
  assert.equal(await syncAssets('纯文本', path.join(from, 'note.md'), path.join(root, 'c', 'note.md')), 0);
});
