import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchFolder, searchText, buildMatcher, validateEntryName, listSearchFiles } from '../electron/search.cjs';
import { inside } from '../electron/store.cjs';

test('literal search finds every occurrence in a line', () => {
  const matcher = buildMatcher('笔记');
  const matches = searchText('# 笔记\n\n这是笔记，另一处笔记。\n', matcher);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].line, 1);
  assert.equal(matches[1].line, 3);
  assert.deepEqual(matches[1].ranges, [[2, 4], [8, 10]]);
  assert.equal(matches[1].column, 3, 'column 是 1 起的列号');
});

test('case-sensitive matching can be switched on, and regex is opt-in', () => {
  const source = 'Inkstone inkstone INKSTONE\n';
  assert.equal(searchText(source, buildMatcher('inkstone'))[0].ranges.length, 3);
  assert.equal(searchText(source, buildMatcher('inkstone', { caseSensitive: true }))[0].ranges.length, 1);
  const regex = searchText('a1 b22 c333\n', buildMatcher('b\\d+', { regex: true }));
  assert.deepEqual(regex[0].ranges, [[3, 6]]);
  // A malformed expression falls back to a literal instead of failing.
  const fallback = searchText('x a+(y\n', buildMatcher('a+(', { regex: true }));
  assert.deepEqual(fallback[0].ranges, [[2, 5]]);
});

test('long lines are windowed around the first match', () => {
  const line = `${'前'.repeat(400)}命中${'后'.repeat(400)}`;
  const matches = searchText(line, buildMatcher('命中'));
  assert.ok(matches[0].text.length <= 242, `片段应被截断，实际 ${matches[0].text.length}`);
  const [from, to] = matches[0].ranges[0];
  assert.equal(matches[0].text.slice(from, to), '命中', '截断后高亮区间必须仍然指向命中的文字');
});

test('per-file and total limits cap a very repetitive file', () => {
  const matches = searchText('命中\n'.repeat(100), buildMatcher('命中'), { maxPerFile: 5 });
  assert.equal(matches.length, 5);
});

test('folder search groups matches, skips node_modules and oversized files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-'));
  try {
    await fs.writeFile(path.join(root, 'a.md'), '# 甲\n\n共同关键词\n');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'b.markdown'), '共同关键词 在这里\n共同关键词 再来一次\n');
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'skip.md'), '共同关键词\n');
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'skip.md'), '共同关键词\n');
    await fs.writeFile(path.join(root, 'big.md'), `共同关键词\n${'x'.repeat(64)}`);
    await fs.writeFile(path.join(root, 'notes.txt'), 'nothing here\n');

    const result = await searchFolder(root, '共同关键词');
    assert.equal(result.cancelled, false);
    const names = result.files.map(file => file.relative).sort();
    assert.deepEqual(names, ['a.md', 'big.md', 'sub/b.markdown']);
    assert.ok(!names.some(name => name.includes('node_modules') || name.includes('.git') || name.endsWith('.txt')), 'node_modules / .git / 非 Markdown 文件不参与');
    const sub = result.files.find(file => file.relative === 'sub/b.markdown');
    assert.equal(sub.matches.length, 2);
    assert.equal(result.total, 4);

    // A file over the size limit is skipped even when it matches.
    const limited = await searchFolder(root, '共同关键词', { maxFileBytes: 16 });
    assert.deepEqual(limited.files.map(file => file.relative), []);
    assert.equal((await listSearchFiles(root)).some(file => file.endsWith('big.md')), true, '扫描仍会列出该文件，读取时按大小跳过');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unsaved editor content overrides the bytes on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-'));
  try {
    const file = path.join(root, 'draft.md');
    await fs.writeFile(file, '磁盘上的旧内容\n');
    const overrides = new Map([[file, '编辑器里的新内容\n']]);
    const stale = await searchFolder(root, '旧内容');
    assert.equal(stale.total, 1);
    const fresh = await searchFolder(root, '新内容', { overrides });
    assert.equal(fresh.total, 1, '未保存的编辑内容必须可被搜索到');
    assert.equal(fresh.files[0].path, file);
    const gone = await searchFolder(root, '旧内容', { overrides });
    assert.equal(gone.total, 0, '覆盖后磁盘旧内容不应再命中');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a cancelled token stops the walk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-'));
  try {
    for (let index = 0; index < 6; index++) await fs.writeFile(path.join(root, `f${index}.md`), '关键词\n');
    const token = { cancelled: false };
    const result = await searchFolder(root, '关键词', { token });
    assert.equal(result.cancelled, false);
    const cancelled = { cancelled: true };
    const stopped = await searchFolder(root, '关键词', { token: cancelled });
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.files.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('file names are validated with Chinese reasons', () => {
  assert.deepEqual(validateEntryName('笔记 一'), { ok: true, name: '笔记 一' });
  assert.equal(validateEntryName('').ok, false);
  assert.equal(validateEntryName('   ').ok, false);
  assert.match(validateEntryName('a/b').error, /不能包含/);
  assert.match(validateEntryName('a:b').error, /不能包含/);
  assert.match(validateEntryName('a?b').error, /不能包含/);
  assert.match(validateEntryName('CON').error, /保留名称/);
  assert.match(validateEntryName('con.md').error, /保留名称/);
  assert.match(validateEntryName('LPT1.txt').error, /保留名称/);
  assert.match(validateEntryName('结尾.').error, /句点/);
  assert.match(validateEntryName('.hidden').error, /句点开头/);
  assert.match(validateEntryName('..').error, /不能是/);
});

test('the inside() boundary rejects paths outside the opened folder', () => {
  const root = path.resolve('/workspace/notes');
  assert.equal(inside(root, path.join(root, 'a.md')), true);
  assert.equal(inside(root, root), true);
  assert.equal(inside(root, path.resolve('/workspace/notes-other/a.md')), false);
  assert.equal(inside(root, path.resolve('/workspace')), false);
  assert.equal(inside(root, path.resolve('/etc/passwd')), false);
});
