const { randomUUID } = require('node:crypto');

const noteId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const pathKey = /^[0-9a-f]{16}$/;
const CONTEXT_LENGTH = 256;
const NOTE_LENGTH = 8000;
const DOCUMENT_LIMIT = 20 * 1024 * 1024;

function anchorFields(anchor) {
  const { from, to, quote, prefix, suffix, orphaned } = anchor || {};
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > DOCUMENT_LIMIT
    || typeof quote !== 'string' || quote.length !== to - from || quote.includes('\r')
    || typeof prefix !== 'string' || prefix.length > CONTEXT_LENGTH || prefix.includes('\r')
    || typeof suffix !== 'string' || suffix.length > CONTEXT_LENGTH || suffix.includes('\r')
    || (orphaned !== undefined && typeof orphaned !== 'boolean')) {
    throw new Error('留言的选段位置无效。');
  }
  return { from, to, quote, prefix, suffix, ...(orphaned ? { orphaned } : {}) };
}

function noteText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > NOTE_LENGTH) throw new Error('请输入 1 到 8000 字的留言。');
  return text.trim();
}

function storedNotes(notes) {
  if (!Array.isArray(notes)) throw new Error('留言列表无效。');
  return notes.map(({ id, text, done, anchor }) => {
    if (typeof id !== 'string' || !noteId.test(id) || typeof done !== 'boolean') throw new Error('留言记录无效。');
    return { id, text: noteText(text), done, anchor: anchorFields(anchor) };
  });
}

function storedAnchorUpdates(updates) {
  if (!Array.isArray(updates)) return [];
  const valid = [];
  for (const change of updates) {
    if (change?.type !== 'relocate' || !noteId.test(change.id)) continue;
    try {
      valid.push({ type: 'relocate', id: change.id, previousAnchor: anchorFields(change.previousAnchor), anchor: anchorFields(change.anchor) });
    } catch { /* The text recovery must remain available even with a malformed note update. */ }
  }
  return valid;
}

function storedTransfers(transfers) {
  if (!Array.isArray(transfers)) throw new Error('留言迁移记录无效。');
  return transfers.map(({ key, move }) => {
    if (typeof key !== 'string' || !pathKey.test(key) || typeof move !== 'boolean') throw new Error('留言迁移记录无效。');
    return { key, move };
  });
}

/** The first group wins on duplicate IDs, including a transfer retried after writing. */
function mergeNotes(...groups) {
  const entries = new Map();
  for (const notes of groups) {
    for (const note of notes) if (!entries.has(note.id)) entries.set(note.id, note);
  }
  return [...entries.values()];
}

function applyNoteChange(notes, change) {
  if (!change || typeof change !== 'object') throw new Error('留言操作无效。');
  const id = change.type === 'add' && change.id === undefined ? randomUUID() : change.id;
  if (typeof id !== 'string' || !noteId.test(id)) throw new Error('留言编号无效。');
  const index = notes.findIndex(note => note.id === id);
  const previous = notes[index];
  let note;
  if (change.type === 'add') {
    if (previous) return { note: previous, notes };
    note = { id, text: noteText(change.text), done: false, anchor: anchorFields(change.anchor) };
    return { note, notes: [...notes, note] };
  }
  if (!previous) throw new Error('找不到这条留言。');
  switch (change.type) {
    case 'edit': note = { ...previous, text: noteText(change.text) }; break;
    case 'complete':
      if (typeof change.done !== 'boolean') throw new Error('留言的完成状态无效。');
      note = { ...previous, done: change.done };
      break;
    case 'relocate': {
      const anchor = anchorFields(change.anchor);
      if (change.previousAnchor) {
        const expected = anchorFields(change.previousAnchor);
        if (JSON.stringify(expected) !== JSON.stringify(previous.anchor)) return { note: previous, notes };
      }
      note = { ...previous, anchor };
      break;
    }
    default: throw new Error('留言操作无效。');
  }
  const updated = notes.slice();
  updated[index] = note;
  return { note, notes: updated };
}

module.exports = { pathKey, storedNotes, storedTransfers, storedAnchorUpdates, mergeNotes, applyNoteChange };
