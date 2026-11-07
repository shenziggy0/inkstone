import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  // Creating a symlink needs extra privileges on Windows and fails with EPERM;
  // the tree assertions still run, only the linked entry is skipped.
  try {
    await fs.symlink(path.join(root, 'a.md'), path.join(root, 'link.md'));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) throw error;
    t.diagnostic(`symlink skipped: ${error.code}`);
  }
  assert.deepEqual((await listMarkdown(root)).map(x => x.name), ['a.md']);
});
test('Save As carries only referenced assets into the new directory', async t => {
  const { root } = await fixture(t);
  const from = path.join(root, 'a'), to = path.join(root, 'b');
  await fs.mkdir(path.join(from, 'assets'), { recursive: true });
  await fs.writeFile(path.join(from, 'assets', 'pic.png'), 'image-bytes');
  await fs.writeFile(path.join(from, 'assets', 'unused.png'), 'not-referenced');
  const content = '![图](assets/pic.png)\n\n![远程](https://example.com/x.png)\n\n![越界](assets/../secret)\n';
  const copied = await syncAssets(content, path.join(from, 'note.md'), path.join(to, 'note.md'));
  assert.equal(copied.copied, 1);
  assert.equal(copied.content, content, '没有重名冲突时引用不应改写');
  assert.equal(await fs.readFile(path.join(to, 'assets', 'pic.png'), 'utf8'), 'image-bytes');
  await assert.rejects(fs.readFile(path.join(to, 'assets', 'unused.png')));
  assert.equal((await syncAssets(content, path.join(from, 'note.md'), path.join(from, 'other.md'))).copied, 0, '同目录无需复制');
  assert.equal((await syncAssets('纯文本', path.join(from, 'note.md'), path.join(root, 'c', 'note.md'))).copied, 0);
});
test('syncAssets never overwrites a same-named asset with different bytes', async t => {
  const { root } = await fixture(t);
  const from = path.join(root, 'a'), to = path.join(root, 'b');
  await fs.mkdir(path.join(from, 'assets'), { recursive: true });
  await fs.mkdir(path.join(to, 'assets'), { recursive: true });
  await fs.writeFile(path.join(from, 'assets', 'pic.png'), 'local-bytes');
  await fs.writeFile(path.join(to, 'assets', 'pic.png'), 'existing-bytes');
  await fs.writeFile(path.join(from, 'assets', 'same.png'), 'identical');
  await fs.writeFile(path.join(to, 'assets', 'same.png'), 'identical');
  const content = '![图](assets/pic.png)\n\n![同](assets/same.png)\n';
  const result = await syncAssets(content, path.join(from, 'note.md'), path.join(to, 'note.md'));
  assert.equal(result.copied, 1, '只复制内容不同的那张同名图片');
  assert.equal(result.skipped, 1, '内容相同的同名图片应跳过');
  assert.equal(await fs.readFile(path.join(to, 'assets', 'pic.png'), 'utf8'), 'existing-bytes', '目标已有文件不得被覆盖');
  assert.equal(await fs.readFile(path.join(to, 'assets', 'pic-1.png'), 'utf8'), 'local-bytes', '不同内容应使用不冲突的新名字');
  assert.match(result.content, /!\[图\]\(assets\/pic-1\.png\)/, '文档引用必须改写到新名字');
  assert.match(result.content, /!\[同\]\(assets\/same\.png\)/, '内容相同则保留原引用');
  assert.deepEqual(result.renamed, [{ from: 'assets/pic.png', to: 'assets/pic-1.png' }], '改写列表供渲染层同步编辑器');
  // A second save into the same folder reuses the already copied file.
  const again = await syncAssets(content, path.join(from, 'note.md'), path.join(to, 'note.md'));
  assert.match(again.content, /assets\/pic-1\.png/, '已存在的同名副本应复用而不是继续加后缀');
  assert.deepEqual(again.renamed, [{ from: 'assets/pic.png', to: 'assets/pic-1.png' }], '复用副本时仍要报告引用改写');
  assert.equal(await fs.readFile(path.join(to, 'assets', 'pic-1.png'), 'utf8'), 'local-bytes');
});
test('reload keeps a discarded copy of dirty local text', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'first'); const doc = await store.open(file);
  await store.update(doc.id, 'local draft');
  await fs.writeFile(file, 'external version');
  const reloaded = await store.reload(doc.id);
  assert.equal(reloaded.content, 'external version');
  assert.equal(reloaded.dirty, false);
  assert.ok(reloaded.discarded, '重新加载应返回副本路径');
  assert.equal(await fs.readFile(reloaded.discarded, 'utf8'), 'local draft');
  assert.match(path.basename(reloaded.discarded), /-note\.md$/);
  await assert.rejects(fs.readFile(path.join(store.recoveryDirectory, `${doc.id}.json`)), '本地内容已有副本，自动恢复文件可以删除');
  const clean = await store.reload(doc.id);
  assert.equal(clean.discarded, null, '没有本地修改时不需要副本');
});
test('accepting the disk version lets the next save overwrite and keeps the disk text in history', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'base'); const doc = await store.open(file);
  await store.update(doc.id, 'mine');
  await fs.writeFile(file, 'external');
  await assert.rejects(store.save(doc.id), /其他程序/);
  await store.acceptDisk(doc.id);
  const saved = await store.save(doc.id);
  assert.equal(saved.dirty, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'mine', '保留本地内容后保存应覆盖磁盘版本');
  const entries = await store.listHistory(doc.id);
  assert.ok(entries.length >= 2);
  const contents = await Promise.all(entries.map(entry => store.readHistory(entry.dir, entry.name)));
  assert.ok(contents.includes('external'), '被覆盖的磁盘版本必须能从保存历史恢复');
  assert.ok(contents.includes('base'), '覆盖前的本地基线也应保留');
});
test('history is keyed by the document path, shared, and pruned to 50 versions', async t => {
  const { root, store } = await fixture(t);
  const one = path.join(root, 'one', 'README.md'), two = path.join(root, 'two', 'README.md');
  await fs.mkdir(path.join(root, 'one')); await fs.mkdir(path.join(root, 'two'));
  await fs.writeFile(one, 'one'); await fs.writeFile(two, 'two');
  const first = await store.open(one);
  const second = await store.open(two);
  assert.notEqual(store.historyKey(store.get(first.id)), store.historyKey(store.get(second.id)), '同名不同目录必须分开');
  for (let index = 0; index < 55; index++) {
    await store.update(first.id, `version ${index}`);
    await store.save(first.id);
  }
  const key = store.historyKey(store.get(first.id));
  const files = (await fs.readdir(path.join(store.historyDirectory, key))).filter(name => name.endsWith('-README.md'));
  assert.equal(files.length, 50, `每个文件只保留最近 50 个版本，实际 ${files.length}`);
  const own = await store.listHistory(first.id);
  assert.equal(own.length, 50);
  assert.ok(own.every(entry => entry.dir === `new:${key}`));
  const other = await store.listHistory(second.id);
  assert.deepEqual(other, [], '另一个目录中的同名文件不得混入');
});
test('legacy history folders stay readable but only match the exact file name', async t => {
  const { root, store } = await fixture(t);
  const file = path.join(root, 'docs', 'a.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'a');
  const doc = await store.open(file);
  const legacy = path.join(store.recoveryDirectory, 'history');
  await fs.mkdir(legacy, { recursive: true });
  const stamp = Date.now();
  const exact = `${stamp}-${crypto.randomUUID()}-a.md`;
  const decoy = `${stamp}-${crypto.randomUUID()}-b-a.md`;
  await fs.writeFile(path.join(legacy, exact), 'old a');
  await fs.writeFile(path.join(legacy, decoy), 'old b-a');
  const entries = await store.listHistory(doc.id);
  assert.deepEqual(entries.map(entry => entry.name), [exact], 'b-a.md 的历史不能显示在 a.md 下');
  assert.equal(entries[0].dir, 'legacy:history');
  assert.equal(entries[0].legacy, true);
  assert.equal(await store.readHistory('legacy:history', exact), 'old a');
  await assert.rejects(store.readHistory('legacy:..', exact), /无效/);
  await assert.rejects(store.readHistory('legacy:history', '../secret'), /无效/);
});
test('a named new document starts unmodified with its own title', async t => {
  const { store } = await fixture(t);
  const welcome = store.create('# 欢迎\n', null, { name: '欢迎使用.md', dirty: false });
  assert.equal(welcome.name, '欢迎使用.md', '主进程与渲染层必须使用同一个名字');
  assert.equal(welcome.dirty, false, '欢迎页不是未保存文档');
  assert.equal(store.get(welcome.id).savedContent, '# 欢迎\n', '未修改状态以当前内容为基线');
  await store.update(welcome.id, '# 欢迎\n改动');
  assert.equal(store.get(welcome.id).dirty, true, '用户编辑后才变为未保存');
  const plain = store.create('正文');
  assert.equal(plain.name, '未命名.md');
  assert.equal(plain.dirty, true, '其它新建文档仍按未保存处理');
  assert.equal(store.get(plain.id).savedContent, '', '未命名文档没有保存基线');
});
test('history labels name the document and time instead of the stored uuid file', async t => {
  const { root, store } = await fixture(t);
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old');
  const doc = await store.open(file);
  await store.update(doc.id, 'new');
  await store.save(doc.id);
  const [entry] = await store.listHistory(doc.id);
  assert.match(entry.label, /^note\.md · /, `历史条目应显示文档名，实际 ${entry.label}`);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(entry.label), `历史条目不得显示 UUID：${entry.label}`);
  assert.ok(!entry.label.includes(store.historyKey(store.get(doc.id))), '历史条目不得显示哈希目录名');
  assert.equal(entry.hint, '当前文件');
  assert.notEqual(entry.name, entry.label, '内部文件名只用于读取，不用于显示');
});
test('detaching a deleted file keeps its text as an unsaved document', async t => {
  const { root, store } = await fixture(t), file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old'); const doc = await store.open(file);
  await store.update(doc.id, 'draft');
  await fs.unlink(file);
  const detached = await store.detach(doc.id);
  assert.equal(detached.path, null);
  assert.equal(detached.dirty, true);
  assert.equal(store.get(doc.id).version, null);
  const record = JSON.parse(await fs.readFile(path.join(store.recoveryDirectory, `${doc.id}.json`), 'utf8'));
  assert.equal(record.content, 'draft');
});
test('an unsaved document migrates its temporary images on the first save', async t => {
  const { root } = await fixture(t);
  const unsaved = path.join(root, 'unsaved-assets', 'doc-id');
  const target = path.join(root, 'target');
  await fs.mkdir(path.join(unsaved, 'assets'), { recursive: true });
  await fs.mkdir(path.join(target, 'assets'), { recursive: true });
  await fs.writeFile(path.join(unsaved, 'assets', '粘贴 图片-1a2b.png'), 'pasted');
  await fs.writeFile(path.join(unsaved, 'assets', 'logo.png'), 'pasted-logo');
  await fs.writeFile(path.join(target, 'assets', 'logo.png'), 'existing-logo');
  const content = '![粘贴](assets/%E7%B2%98%E8%B4%B4%20%E5%9B%BE%E7%89%87-1a2b.png)\n\n![图](assets/logo.png)\n';
  const result = await syncAssets(content, null, path.join(target, 'note.md'), { fromDirectory: unsaved });
  assert.equal(result.copied, 2);
  assert.equal(await fs.readFile(path.join(target, 'assets', '粘贴 图片-1a2b.png'), 'utf8'), 'pasted');
  assert.equal(await fs.readFile(path.join(target, 'assets', 'logo.png'), 'utf8'), 'existing-logo', '不得覆盖目标目录已有的同名图片');
  assert.equal(await fs.readFile(path.join(target, 'assets', 'logo-1.png'), 'utf8'), 'pasted-logo');
  assert.match(result.content, /assets\/logo-1\.png/, '冲突时必须回写引用');
  assert.deepEqual(result.renamed, [{ from: 'assets/logo.png', to: 'assets/logo-1.png' }]);
  // Without a source directory there is nothing to migrate.
  assert.equal((await syncAssets(content, null, path.join(root, 'x', 'note.md'))).copied, 0);
});
test('a recovered unsaved document keeps the images of the id it crashed under', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-recover-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recovery = path.join(root, 'recovery'), unsavedRoot = path.join(root, 'unsaved-assets');
  const exists = file => fs.access(file).then(() => true, () => false);
  // A crash leaves the draft in the recovery folder and its image under its id.
  const first = new DocumentStore(recovery, { unsavedAssetsDirectory: unsavedRoot });
  const draft = first.create('![图](assets/a.png)\n');
  await first.update(draft.id, '![图](assets/a.png)\n');
  await fs.mkdir(path.join(unsavedRoot, draft.id, 'assets'), { recursive: true });
  await fs.writeFile(path.join(unsavedRoot, draft.id, 'assets', 'a.png'), 'pasted');
  // The next start of the application recovers the text with a brand new id.
  const second = new DocumentStore(recovery, { unsavedAssetsDirectory: unsavedRoot });
  const recovered = await second.recoverAll();
  assert.equal(recovered.length, 1);
  const recoveredId = recovered[0].id;
  assert.notEqual(recoveredId, draft.id);
  assert.equal(await fs.readFile(path.join(unsavedRoot, recoveredId, 'assets', 'a.png'), 'utf8'), 'pasted', '图片目录必须随文档迁移到新 id');
  assert.equal(await exists(path.join(unsavedRoot, draft.id)), false, '迁移后旧目录不应留下');
  // The recovery record names the new id, so startup pruning keeps the folder.
  const record = JSON.parse(await fs.readFile(path.join(recovery, `${recoveredId}.json`), 'utf8'));
  assert.equal(record.id, recoveredId);
  assert.match(record.content, /assets\/a\.png/);
  // Recovering while the original document is still open (a renderer reload
  // keeps the store entry alive) copies instead of moving, so neither loses it.
  const third = new DocumentStore(path.join(root, 'recovery-window-1'), { unsavedAssetsDirectory: unsavedRoot });
  const live = third.create('![图](assets/b.png)\n');
  await third.update(live.id, '![图](assets/b.png)\n');
  await fs.mkdir(path.join(unsavedRoot, live.id, 'assets'), { recursive: true });
  await fs.writeFile(path.join(unsavedRoot, live.id, 'assets', 'b.png'), 'live');
  const copies = await third.recoverAll();
  assert.equal(copies.length, 1);
  assert.equal(await fs.readFile(path.join(unsavedRoot, copies[0].id, 'assets', 'b.png'), 'utf8'), 'live');
  assert.equal(await fs.readFile(path.join(unsavedRoot, live.id, 'assets', 'b.png'), 'utf8'), 'live', '仍打开的文档保留自己的图片');
});
test('rekey points a document at a renamed folder and moves its history', async t => {
  const { root, store } = await fixture(t);
  const before = path.join(root, 'a');
  const after = path.join(root, 'b');
  await fs.mkdir(before);
  const original = path.join(before, 'x.md');
  await fs.writeFile(original, 'base');
  const doc = await store.open(original);
  // One save with a changed body leaves a history entry for the old text.
  await store.update(doc.id, 'edited');
  await store.save(doc.id);
  const historyBefore = await store.listHistory(doc.id);
  assert.equal(historyBefore.length, 1);

  // The user renames the folder on disk; the store must follow.
  await fs.rename(before, after);
  const moved = await store.rekey(doc.id, path.join(after, 'x.md'));
  assert.equal(moved.path, await fs.realpath(path.join(after, 'x.md')));
  assert.equal(moved.name, 'x.md');
  assert.equal(moved.content, 'edited', '重命名文件夹不改变内容');
  assert.equal(moved.dirty, false, '重命名文件夹不改变未保存状态');

  const historyAfter = await store.listHistory(doc.id);
  assert.equal(historyAfter.length, 1, '历史目录必须随文件一起移动');
  assert.equal(await store.readHistory(historyAfter[0].dir, historyAfter[0].name), 'base');
  assert.equal(await fs.readdir(path.join(store.historyDirectory, store.historyKey({ path: original }))).catch(() => []).then(list => list.length), 0);

  // Saving after the rename writes the new location, and a rename to a name
  // that already owns history never merges the two folders.
  await store.update(doc.id, 'after rename');
  const saved = await store.save(doc.id);
  assert.equal(saved.path, await fs.realpath(path.join(after, 'x.md')));
  assert.equal(await fs.readFile(path.join(after, 'x.md'), 'utf8'), 'after rename');
});
