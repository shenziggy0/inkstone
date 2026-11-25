import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import storeModule from '../electron/store.cjs';

const { DocumentStore } = storeModule;
const content = '# 海边\n\n去码头看潮汐。\n';
const anchor = { from: 6, to: 13, quote: '去码头看潮汐。', prefix: '# 海边\n\n', suffix: '\n' };
const addNote = text => ({ type: 'add', id: randomUUID(), text, anchor });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-notes-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writingNotesDirectory = path.join(root, 'writing-notes');
  const newStore = name => new DocumentStore(path.join(root, name || 'recovery'), { writingNotesDirectory });
  return { root, newStore, writingNotesDirectory };
}

test('draft recovery carries a single private writing note through first save', async t => {
  const { root, newStore } = await fixture(t);
  const initial = newStore();
  const draft = initial.create(content);
  const change = addNote('下次查潮汐时间');
  const note = await initial.updateWritingNote(draft.id, change);
  await initial.updateWritingNote(draft.id, change);

  const restored = newStore();
  const [recovered] = await restored.recoverAll();
  assert.notEqual(recovered.id, draft.id);
  assert.deepEqual(await restored.listWritingNotes(recovered.id), [note]);
  const file = path.join(root, '海边.md');
  await restored.save(recovered.id, file);

  const reopened = newStore();
  assert.deepEqual(await reopened.recoverAll(), []);
  const saved = await reopened.open(file);
  assert.deepEqual(await reopened.listWritingNotes(saved.id), [note]);
  assert.equal(await fs.readFile(file, 'utf8'), content);
});

test('two windows merge note operations by id and leave the manuscript clean', async t => {
  const { root, newStore } = await fixture(t);
  const file = path.join(root, '海边.md');
  await fs.writeFile(file, content);
  const first = newStore();
  const other = newStore('window-2');
  const left = await first.open(file);
  const right = await other.open(file);
  const [a, b] = await Promise.all([
    first.updateWritingNote(left.id, addNote('确认潮位')),
    other.updateWritingNote(right.id, addNote('查船班'))
  ]);
  await Promise.all([
    first.updateWritingNote(left.id, { type: 'edit', id: a.id, text: '确认今晚潮位' }),
    other.updateWritingNote(right.id, { type: 'complete', id: a.id, done: true })
  ]);
  assert.deepEqual((await other.listWritingNotes(right.id)).find(item => item.id === a.id), {
    ...a, text: '确认今晚潮位', done: true
  });
  assert.deepEqual((await first.listWritingNotes(left.id)).find(item => item.id === b.id), b);
  assert.equal(first.get(left.id).dirty, false);
  assert.equal(await fs.readFile(file, 'utf8'), content);
});

test('saving a copy preserves the source notes and renaming moves the copy notes', async t => {
  const { root, newStore } = await fixture(t);
  const original = path.join(root, '海边.md');
  const copy = path.join(root, '海边副本.md');
  const renamed = path.join(root, '码头.md');
  await fs.writeFile(original, content);
  const store = newStore();
  const doc = await store.open(original);
  const note = await store.updateWritingNote(doc.id, addNote('画地图'));
  await store.save(doc.id, copy);
  await store.updateWritingNote(doc.id, { type: 'complete', id: note.id, done: true });
  await store.save(doc.id, renamed, { moveSource: file => fs.unlink(file) });

  const reader = newStore();
  assert.deepEqual(await reader.listWritingNotes((await reader.open(original)).id), [note]);
  assert.deepEqual(await reader.listWritingNotes((await reader.open(renamed)).id), [{ ...note, done: true }]);
  await fs.writeFile(copy, content);
  assert.deepEqual(await reader.listWritingNotes((await reader.open(copy)).id), []);
});

test('a failed first-save note transfer leaves retryable recovery after the Markdown is saved', async t => {
  const { root, newStore, writingNotesDirectory } = await fixture(t);
  const store = newStore();
  const draft = store.create(content);
  const note = await store.updateWritingNote(draft.id, addNote('下次查潮汐时间'));
  await fs.writeFile(writingNotesDirectory, 'directory temporarily unavailable');
  const file = path.join(root, '海边.md');
  const result = await store.save(draft.id, file);
  assert.equal(result.dirty, false);
  assert.match(result.warnings.join('\n'), /留言/);
  assert.equal(await fs.readFile(file, 'utf8'), content);
  await store.close(draft.id);
  await fs.unlink(writingNotesDirectory);

  const restored = newStore();
  const [recovered] = await restored.recoverAll();
  assert.deepEqual(await restored.listWritingNotes(recovered.id), [note]);
  await restored.save(recovered.id, file);
  assert.deepEqual(await restored.listWritingNotes(recovered.id), [note]);
  assert.deepEqual(await newStore().recoverAll(), []);
});

test('moving a closed file transfers writing notes to the new path without touching history', async t => {
  const { root, newStore } = await fixture(t);
  const oldFile = path.join(root, '旧.md');
  const newFile = path.join(root, '新.md');
  await fs.writeFile(oldFile, content);
  const store = newStore();
  const doc = await store.open(oldFile);
  const note = await store.updateWritingNote(doc.id, addNote('回访渔民'));
  await store.close(doc.id);
  assert.equal((await store.listWritingNoteKeys()).size, 1);
  await fs.rename(oldFile, newFile);
  await store.moveWritingNotes(store.historyKey({ path: oldFile }), store.historyKey({ path: newFile }));
  assert.deepEqual(await store.listWritingNotes((await store.open(newFile)).id), [note]);
});

test('an automatic anchor update cannot overwrite newer manual positioning or restore an orphan', async t => {
  const { root, newStore } = await fixture(t);
  const file = path.join(root, '海边.md');
  await fs.writeFile(file, content);
  const store = newStore();
  const doc = await store.open(file);
  const note = await store.updateWritingNote(doc.id, addNote('画地图'));
  const orphaned = { ...anchor, orphaned: true };
  await store.updateWritingNote(doc.id, { type: 'relocate', id: note.id, anchor: orphaned, previousAnchor: anchor });
  const stale = await store.updateWritingNote(doc.id, { type: 'relocate', id: note.id, anchor, previousAnchor: anchor });
  assert.deepEqual(stale.anchor, orphaned);

  const reopened = newStore();
  const saved = await reopened.open(file);
  assert.deepEqual((await reopened.listWritingNotes(saved.id))[0].anchor, orphaned);
  const manual = await reopened.updateWritingNote(saved.id, { type: 'relocate', id: note.id, anchor });
  assert.deepEqual(manual.anchor, anchor);
});

test('a dirty saved draft recovers an orphaned anchor without changing the disk note', async t => {
  const { root, newStore } = await fixture(t);
  const file = path.join(root, '潮汐.md');
  await fs.writeFile(file, content + '\n去码头看潮汐。');
  const first = newStore();
  const doc = await first.open(file);
  const note = await first.updateWritingNote(doc.id, addNote('查潮汐'));
  const orphaned = { ...note.anchor, orphaned: true };
  await first.update(doc.id, '# 海边\n\n\n去码头看潮汐。', [
    { type: 'relocate', id: note.id, previousAnchor: note.anchor, anchor: orphaned }
  ]);

  const restored = newStore();
  const [draft] = await restored.recoverAll();
  assert.deepEqual(await restored.listWritingNotes(draft.id), [{ ...note, anchor: orphaned }]);
  const disk = newStore('disk');
  assert.deepEqual(await disk.listWritingNotes((await disk.open(file)).id), [note]);

  await restored.updateWritingNote(draft.id, { type: 'complete', id: note.id, done: true });
  await restored.save(draft.id, file);
  assert.deepEqual(await disk.listWritingNotes((await disk.open(file)).id), [{ ...note, done: true, anchor: orphaned }]);
});
