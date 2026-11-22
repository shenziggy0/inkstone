import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceState, recordRecent, pruneMissing, claimMacFolderAccessReset, RECENT_FILES_LIMIT, RECENT_FOLDERS_LIMIT } from '../electron/session.cjs';

test('mac folder access reset is claimed once, including after identical reinstalls', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-mac-install-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const userData = path.join(home, 'support');
  const executable = path.join(home, 'Applications', 'Inkstone.app', 'Contents', 'MacOS', 'Inkstone');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  const buildTime = new Date('2026-01-01T00:00:00Z');
  await fs.writeFile(executable, 'same build');
  await fs.utimes(executable, buildTime, buildTime);
  assert.equal(await claimMacFolderAccessReset(userData, executable, home), true);
  assert.equal(await claimMacFolderAccessReset(userData, executable, home), false);

  const replacement = `${executable}.replacement`;
  await fs.copyFile(executable, replacement);
  await fs.utimes(replacement, buildTime, buildTime);
  await fs.rename(replacement, executable);
  assert.equal(await claimMacFolderAccessReset(userData, executable, home), true);
  assert.equal(await claimMacFolderAccessReset(userData, executable, home), false);
});

test('a mac app outside Applications does not consume the install reset', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-mac-install-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const userData = path.join(home, 'support');
  const executable = path.join(home, 'Downloads', 'Inkstone.app', 'Contents', 'MacOS', 'Inkstone');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, '');
  assert.equal(await claimMacFolderAccessReset(userData, executable, home), false);
  await assert.rejects(fs.stat(userData), { code: 'ENOENT' });
});

test('recent lists keep the newest entry first, never duplicate and stay capped', () => {
  let list = [];
  for (let index = 0; index < 25; index++) list = recordRecent(list, `/tmp/doc-${index}.md`, RECENT_FILES_LIMIT);
  assert.equal(list.length, RECENT_FILES_LIMIT);
  assert.equal(list[0], '/tmp/doc-24.md');
  assert.equal(list.at(-1), '/tmp/doc-5.md');
  // Re-opening an existing entry moves it back to the front without repeating it.
  list = recordRecent(list, '/tmp/doc-10.md', RECENT_FILES_LIMIT);
  assert.equal(list[0], '/tmp/doc-10.md');
  assert.equal(list.filter(entry => entry === '/tmp/doc-10.md').length, 1);
  assert.equal(list.length, RECENT_FILES_LIMIT);
  assert.deepEqual(recordRecent([], '', RECENT_FILES_LIMIT), []);
});

test('pruneMissing drops entries whose file disappeared', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-recent-'));
  try {
    const kept = path.join(root, 'kept.md');
    await fs.writeFile(kept, '# kept\n');
    const missing = path.join(root, 'gone.md');
    assert.deepEqual(await pruneMissing([kept, missing, '', 42]), [kept]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace state persists recents and the restorable session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-session-'));
  try {
    const folder = path.join(root, 'notes');
    await fs.mkdir(folder);
    const first = path.join(folder, 'a.md');
    const second = path.join(folder, 'b.md');
    await fs.writeFile(first, '# a\n');
    await fs.writeFile(second, '# b\n');
    const state = await new WorkspaceState(root).load();
    state.recordFile(first);
    state.recordFile(second);
    state.recordFolder(folder);
    state.setSession({ folder, files: [first, second, path.join(folder, 'gone.md')], active: second });
    await state.flush();

    // A fresh process reads both files back.
    const reopened = await new WorkspaceState(root).load();
    assert.deepEqual(reopened.files().map(file => file.name), ['b.md', 'a.md']);
    assert.deepEqual(reopened.folders(), [folder]);
    const session = await reopened.restorableSession();
    assert.equal(session.folder, folder);
    assert.deepEqual(session.files, [first, second], '不存在的文件在恢复时被静默跳过');
    assert.equal(session.active, second);

    // Deleting the folder makes the whole session unrestorable.
    await fs.rm(folder, { recursive: true, force: true });
    const empty = await reopened.restorableSession();
    assert.deepEqual(empty, { folder: null, files: [], active: null });
    // Loading prunes the recents that no longer exist.
    const pruned = await new WorkspaceState(root).load();
    assert.deepEqual(pruned.files(), []);
    assert.deepEqual(pruned.folders(), []);

    await pruned.clear();
    assert.deepEqual((await new WorkspaceState(root).load()).files(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session limits: folders cap at ten and files at the session ceiling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-session-'));
  try {
    const state = await new WorkspaceState(root).load();
    for (let index = 0; index < 14; index++) state.recordFolder(`/tmp/folder-${index}`);
    assert.equal(state.folders().length, RECENT_FOLDERS_LIMIT);
    assert.equal(state.folders()[0], '/tmp/folder-13');
    const files = Array.from({ length: 40 }, (_, index) => `/tmp/file-${index}.md`);
    state.setSession({ folder: '/tmp', files, active: files[39] });
    await state.flush();
    const loaded = await new WorkspaceState(root).load();
    assert.ok(loaded.session.files.length <= 30, `会话文件数应有上限，实际 ${loaded.session.files.length}`);
    assert.equal(loaded.session.active, secondActive(loaded.session.files), '当前文档不在列表里时回落到第一个');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const secondActive = files => files[0] ?? null;

test('a recorded network location is dropped without touching the network', async () => {
  const unc = String.raw`\host\share\notes.md`;
  const started = performance.now();
  const kept = await pruneMissing([unc, '//host/share/other.md']);
  const elapsed = performance.now() - started;
  assert.deepEqual(kept, [], '网络路径必须被静默丢弃');
  // A real SMB call blocks for far longer than this (and leaks credentials);
  // returning instantly is the evidence that no filesystem call was made.
  assert.ok(elapsed < 100, `剔除网络路径不应访问网络，实际耗时 ${elapsed.toFixed(1)}ms`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-session-'));
  try {
    // A session pointing at a share is not restored either.
    await fs.writeFile(path.join(root, 'session.json'), JSON.stringify({ folder: unc, files: [unc], active: unc }));
    const state = await new WorkspaceState(root).load();
    const startedRestore = performance.now();
    assert.deepEqual(await state.restorableSession(), { folder: null, files: [], active: null });
    assert.ok(performance.now() - startedRestore < 100, '恢复会话不得访问网络位置');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
