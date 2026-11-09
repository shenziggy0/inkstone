const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
// Pure shared parser; also imported by the renderer (src/markdown.js).
const frontMatter = require('./front-matter.mjs');

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
/** Decode strict UTF-8 so invalid bytes are never silently replaced on save. */
function decodeText(bytes) {
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.includes('\0')) throw new Error('该文件不是 UTF-8 文本。');
  return content;
}
// Every history entry is `<epoch millis>-<uuid>-<original file name>`; parsing
// the whole shape keeps `b-a.md` from matching the history of `a.md`.
const HISTORY_ENTRY = /^(\d{10,16})-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})-(.+)$/;
const HISTORY_LIMIT = 50;
// Document ids double as folder names under `unsaved-assets/`, so they are
// validated before ever being joined into a path.
const SAFE_DOCUMENT_ID = /^[0-9a-f-]{36}$/i;

async function atomicWrite(file, content) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    const mode = await fs.stat(file).then(s => s.mode).catch(() => 0o600);
    handle = await fs.open(temporary, 'wx', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

class DocumentStore {
  /**
   * @param {string} recoveryDirectory per-window recovery folder
   * @param {{historyDirectory?: string, legacyHistoryRoot?: string, unsavedAssetsDirectory?: string}} [options]
   *   `historyDirectory` is shared by every window; `legacyHistoryRoot` still
   *   hosts the old per-window `history/` folders that must stay readable;
   *   `unsavedAssetsDirectory` is the shared root of the per-document image
   *   folders an unsaved document uses (kept in sync on crash recovery).
   */
  constructor(recoveryDirectory, options = {}) {
    this.documents = new Map();
    this.recoveryDirectory = recoveryDirectory;
    this.historyDirectory = options.historyDirectory || path.join(path.dirname(recoveryDirectory), 'history');
    this.legacyHistoryRoot = options.legacyHistoryRoot || recoveryDirectory;
    this.unsavedAssetsDirectory = options.unsavedAssetsDirectory || null;
    this.locks = new Map();
  }
  async serial(id, action) {
    const pending = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(id, pending);
    try { return await pending; } finally { if (this.locks.get(id) === pending) this.locks.delete(id); }
  }
  /**
   * @param {string} content initial text
   * @param {string|null} file real path when the document already exists on disk
   * @param {{name?: string, dirty?: boolean}} [options] `name` gives an unsaved
   *   document its own title (the welcome page); `dirty: false` starts a document
   *   with content that is deliberately not pending a save.
   */
  create(content = '', file = null, options = {}) {
    const name = file ? path.basename(file) : (options.name || '未命名.md');
    const dirty = typeof options.dirty === 'boolean' ? options.dirty : !!content;
    const doc = { id: crypto.randomUUID(), path: file, name, content, savedContent: dirty ? '' : content, version: null, dirty };
    this.documents.set(doc.id, doc);
    return this.public(doc);
  }
  get(id) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error('文档已关闭，请重新打开。');
    return doc;
  }
  public(doc) { return { id: doc.id, path: doc.path, name: doc.name, content: doc.content, dirty: doc.dirty }; }
  async open(file) {
    const resolved = await fs.realpath(file);
    const existing = [...this.documents.values()].find(d => d.path === resolved);
    if (existing) return this.public(existing);
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的 Markdown 文本文件。');
    const bytes = await fs.readFile(resolved);
    const content = decodeText(bytes);
    const value = this.create(content, resolved);
    const doc = this.get(value.id);
    Object.assign(doc, { savedContent: content, version: digest(bytes), dirty: false });
    return this.public(doc);
  }
  async update(id, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 20 * 1024 * 1024) throw new Error('文档内容无效或超过 20 MB。');
    return this.serial(id, async () => {
      const doc = this.get(id);
      doc.content = content;
      doc.dirty = content !== doc.savedContent;
      await this.recover(doc);
      return this.public(doc);
    });
  }
  async recover(doc) {
    if (!this.recoveryDirectory) return;
    await fs.mkdir(this.recoveryDirectory, { recursive: true });
    const file = path.join(this.recoveryDirectory, `${doc.id}.json`);
    if (!doc.dirty) { await fs.unlink(file).catch(() => {}); return; }
    await atomicWrite(file, JSON.stringify({ ...this.public(doc), updatedAt: new Date().toISOString() }));
  }
  /**
   * Keep the current in-memory text as a copy nobody prunes, so reloading the
   * disk version (or recovering after a crash) can never destroy local work.
   */
  async discard(doc) {
    if (!this.recoveryDirectory) return null;
    const directory = path.join(this.recoveryDirectory, 'discarded');
    await fs.mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `${stamp}-${doc.name}`);
    await atomicWrite(file, doc.content);
    return file;
  }
  async save(id, target) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      const requestedFile = target || doc.path;
      if (!requestedFile) throw new Error('请先选择保存位置。');
      // /tmp and /private/tmp (and user-created symlinks) can name the same file.
      // Canonicalize before checking open-document identity or disk conflicts.
      const file = await fs.realpath(requestedFile).catch(async error => {
        if (error.code !== 'ENOENT') throw error;
        return path.join(await fs.realpath(path.dirname(requestedFile)), path.basename(requestedFile));
      });
      let diskContent = null;
      if (file === doc.path && doc.version !== null) {
        const current = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current === null || digest(current) !== doc.version) throw new Error('文件已被其他程序修改或删除。为避免覆盖，请另存为，或重新打开磁盘版本。');
        // Remember the version we are about to replace whenever it differs from
        // the local baseline (an accepted external edit, for example).
        try { diskContent = decodeText(current); } catch { diskContent = null; }
      }
      const opened = [...this.documents.values()].find(d => d.id !== id && d.path === file);
      if (opened) throw new Error('目标文件已在另一个标签页打开，请选择其他名称。');
      if (doc.path) {
        if (doc.dirty) await this.writeHistory(doc, doc.savedContent);
        if (diskContent !== null && diskContent !== doc.savedContent) await this.writeHistory(doc, diskContent);
      }
      // Relocate a document-relative image root only now: the target is
      // canonical and every rejection above (target open elsewhere, changed
      // disk version) has happened. The document keeps its old path, text and
      // clean state until the atomic write succeeds, so a failed Save As can
      // never rewrite the stored YAML or the recovery copy.
      const relocation = doc.path ? relocateImageRoot(doc.content, doc.path, file) : { content: doc.content, imageRootRewrite: null };
      await atomicWrite(file, relocation.content);
      Object.assign(doc, {
        path: file,
        name: path.basename(file),
        content: relocation.content,
        savedContent: relocation.content,
        version: digest(Buffer.from(relocation.content)),
        dirty: false
      });
      await this.recover(doc);
      return { ...this.public(doc), imageRootRewrite: relocation.imageRootRewrite };
    });
  }
  /**
   * Point an open document at a new path without touching its text.
   *
   * Used when the folder around a document is renamed: the bytes on disk did not
   * change, so the disk version (and therefore the dirty baseline) stays valid,
   * and the version history moves with the file instead of being orphaned under
   * the old path hash.
   */
  async rekey(id, target) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      if (!doc.path) return this.public(doc);
      // Canonicalize like open()/save() do: a short 8.3 spelling, a junction or
      // a case variant must not become the identity other code compares against.
      const resolved = await fs.realpath(target).catch(() => target);
      const previousKey = this.historyKey(doc);
      doc.path = resolved;
      doc.name = path.basename(resolved);
      const nextKey = this.historyKey(doc);
      if (previousKey !== nextKey) await this.moveHistory(previousKey, nextKey);
      await this.recover(doc);
      return this.public(doc);
    });
  }
  /** Move one history folder to the key of the renamed file, never merging. */
  async moveHistory(fromKey, toKey) {
    const from = path.join(this.historyDirectory, fromKey);
    const stat = await fs.stat(from).catch(() => null);
    if (!stat?.isDirectory()) return false;
    const to = path.join(this.historyDirectory, toKey);
    if (await fs.stat(to).catch(() => null)) return false;
    return fs.rename(from, to).then(() => true).catch(() => false);
  }
  /**
   * Re-read the on-disk version into an already-open document. A dirty document
   * leaves a copy of the local text under `<recovery>/discarded/` first.
   */
  async reload(id) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      if (!doc.path) throw new Error('文档尚未保存到文件。');
      const bytes = await fs.readFile(doc.path);
      const content = decodeText(bytes);
      const discarded = doc.dirty && doc.content !== content ? await this.discard(doc) : null;
      Object.assign(doc, { content, savedContent: content, version: digest(bytes), dirty: false });
      await this.recover(doc);
      return { ...this.public(doc), discarded };
    });
  }
  /**
   * Accept whatever is on disk right now after the user chose to keep the local
   * text: the next save may overwrite it instead of being blocked forever.
   */
  async acceptDisk(id) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      if (!doc.path) return this.public(doc);
      const bytes = await fs.readFile(doc.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      doc.version = bytes === null ? null : digest(bytes);
      return this.public(doc);
    });
  }
  /** Detach a document from a file that disappeared, keeping its text unsaved. */
  async detach(id) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      Object.assign(doc, { path: null, version: null, savedContent: '', dirty: !!doc.content });
      await this.recover(doc);
      return this.public(doc);
    });
  }
  /** Share the history of one file across every window, keyed by its real path. */
  historyKey(doc) {
    const resolved = path.resolve(doc.path);
    return digest(process.platform === 'win32' ? resolved.toLowerCase() : resolved).slice(0, 16);
  }
  async writeHistory(doc, content) {
    if (!doc.path || typeof content !== 'string') return null;
    const directory = path.join(this.historyDirectory, this.historyKey(doc));
    await fs.mkdir(directory, { recursive: true });
    const name = `${Date.now()}-${crypto.randomUUID()}-${doc.name}`;
    await atomicWrite(path.join(directory, name), content);
    await this.pruneHistory(directory);
    return name;
  }
  async pruneHistory(directory, limit = HISTORY_LIMIT) {
    const names = await fs.readdir(directory).catch(() => []);
    const versions = names
      .map(name => ({ name, match: HISTORY_ENTRY.exec(name) }))
      .filter(entry => entry.match)
      .map(entry => ({ name: entry.name, time: Number(entry.match[1]) || 0 }))
      .sort((a, b) => b.time - a.time);
    for (const stale of versions.slice(limit)) await fs.unlink(path.join(directory, stale.name)).catch(() => {});
  }
  /** Resolve a history token (`new:<hash>` or `legacy:<folder>`) to a real file. */
  historyFile(dir, name) {
    if (typeof dir !== 'string' || typeof name !== 'string') throw new Error('历史版本名无效。');
    if (!name || name !== path.basename(name) || /[\\/]/.test(name) || name.startsWith('.')) throw new Error('历史版本名无效。');
    const legacy = dir.startsWith('legacy:') ? dir.slice('legacy:'.length) : null;
    const current = dir.startsWith('new:') ? dir.slice('new:'.length) : null;
    if (legacy === null && current === null) throw new Error('历史版本名无效。');
    const root = legacy === null ? this.historyDirectory : this.legacyHistoryRoot;
    const base = path.resolve(root, legacy === null ? current : legacy);
    if (!inside(root, base)) throw new Error('历史版本名无效。');
    const file = path.join(base, name);
    if (!inside(base, file)) throw new Error('历史版本名无效。');
    return file;
  }
  async listHistory(id) {
    const doc = this.get(id);
    const entries = [];
    const collect = async (base, directory, legacy) => {
      const names = await fs.readdir(base).catch(() => []);
      for (const name of names) {
        const match = HISTORY_ENTRY.exec(name);
        // Legacy folders mix every document, so only an exact file name matches.
        if (!match || (legacy && match[3] !== doc.name)) continue;
        const stat = await fs.stat(path.join(base, name)).catch(() => null);
        if (!stat?.isFile()) continue;
        const stamp = Number(match[1]);
        const time = Number.isFinite(stamp) && stamp > 0 ? stamp : stat.mtimeMs;
        // The stored file name carries a timestamp and a UUID, and the folder
        // name is a path hash: neither belongs in the dialog. Show the document
        // name with the version time instead, and name the origin separately.
        entries.push({
          name, dir: directory, time,
          label: `${match[3]} · ${new Date(time).toLocaleString('zh-CN')}`,
          hint: legacy ? '旧版历史记录' : '当前文件',
          legacy
        });
      }
    };
    if (doc.path) {
      const key = this.historyKey(doc);
      await collect(path.join(this.historyDirectory, key), `new:${key}`, false);
    }
    await collect(path.join(this.legacyHistoryRoot, 'history'), 'legacy:history', true);
    for (const folder of await fs.readdir(this.legacyHistoryRoot).catch(() => [])) {
      if (!/^window-\d+$/.test(folder)) continue;
      await collect(path.join(this.legacyHistoryRoot, folder, 'history'), `legacy:${folder}/history`, true);
    }
    return entries.sort((a, b) => b.time - a.time).slice(0, HISTORY_LIMIT);
  }
  async readHistory(dir, name) {
    return fs.readFile(this.historyFile(dir, name), 'utf8');
  }
  async close(id) {
    return this.serial(id, async () => {
      this.documents.delete(id);
      if (this.recoveryDirectory) await fs.unlink(path.join(this.recoveryDirectory, `${id}.json`)).catch(() => {});
    });
  }
  /**
   * Move the pasted images of an unsaved document to the id of its recovered
   * copy. A crash leaves the pictures under the old id and recovery always
   * creates a new document, so without this the draft comes back with broken
   * images and the folder is pruned a week later. When the old document is
   * still open in this process (a renderer reload keeps the store entry alive)
   * the folder is copied instead of moved, so neither document loses it.
   */
  async carryUnsavedAssets(fromId, toId) {
    if (!this.unsavedAssetsDirectory || !SAFE_DOCUMENT_ID.test(fromId || '') || !SAFE_DOCUMENT_ID.test(toId || '') || fromId === toId) return false;
    const source = path.join(this.unsavedAssetsDirectory, fromId);
    const target = path.join(this.unsavedAssetsDirectory, toId);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isDirectory()) return false;
    if (await fs.stat(target).catch(() => null)) return false;
    try {
      if (this.documents.has(fromId)) await fs.cp(source, target, { recursive: true });
      else await fs.rename(source, target);
      return true;
    } catch { return false; }
  }
  async recoverAll(includeNested = false) {
    if (!this.recoveryDirectory) return [];
    await fs.mkdir(this.recoveryDirectory, { recursive: true });
    const recovered = [];
    const files = [];
    // A recovered draft must win over the session file it came from: the path
    // is remembered here so the startup restore can skip that document instead
    // of opening the same file twice.
    this.recoveredPaths = new Set();
    const collect = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(file);
        else if (includeNested && entry.isDirectory() && entry.name.startsWith('window-')) await collect(file);
      }
    };
    await collect(this.recoveryDirectory);
    for (const file of files) {
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof record.content !== 'string') continue;
        if (typeof record.path === 'string') this.recoveredPaths.add(record.path);
        const doc = this.create(record.content);
        this.get(doc.id).name = `恢复-${record.name || '未命名.md'}`;
        // Pasted images follow the document to its new id before anything renders.
        await this.carryUnsavedAssets(record.id, doc.id);
        await this.recover(this.get(doc.id));
        recovered.push(this.public(this.get(doc.id)));
        await fs.unlink(file);
      } catch { /* Keep unreadable recovery files for manual recovery. */ }
    }
    return recovered;
  }
}

/**
 * Keep a document-relative `typora-root-url` pointing at the same folder after
 * the document moved. Absolute and `file:` roots already do; on Windows a move
 * to another drive falls back to an absolute path, which `path.relative()`
 * returns by itself.
 *
 * The key position comes from electron/front-matter.mjs, the same module the
 * renderer uses, so this only ever edits the real leading front matter line —
 * never a code fence or body text that quotes the same line. `imageRootRewrite`
 * carries the old and new value for the renderer's live buffer, which applies
 * it only while the line still has the old value.
 */
function relocateImageRoot(content, previousPath, nextPath) {
  const key = frontMatter.imageRootKey(content);
  if (!key || !key.value || !previousPath || !nextPath) return { content, imageRootRewrite: null };
  const value = key.value;
  // Network roots and absolute roots never depend on the document's folder.
  if (/^file:/i.test(value) || /^[\\/]{2}/.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return { content, imageRootRewrite: null };
  }
  const previousDirectory = path.dirname(previousPath);
  const nextDirectory = path.dirname(nextPath);
  if (previousDirectory === nextDirectory) return { content, imageRootRewrite: null };
  let nextValue = path.relative(nextDirectory, path.resolve(previousDirectory, value)) || '.';
  if (path.sep === '\\') nextValue = nextValue.split('\\').join('/');
  const next = frontMatter.rewriteFrontMatterImageRoot(content, nextValue);
  if (next === null || next === content) return { content, imageRootRewrite: null };
  return { content: next, imageRootRewrite: { expected: value, value: nextValue } };
}

/**
 * Keep relative `assets/` images usable when a document is saved or renamed
 * into a different directory. Only references actually used by the document
 * are copied; the strict basename check prevents path traversal. A target that
 * already holds different bytes is never overwritten: a free name is picked and
 * the reference inside the returned content is rewritten to match. `renamed`
 * lists those reference rewrites so the renderer can mirror them in the editor.
 *
 * `options.fromDirectory` replaces `path.dirname(previousPath)`: an unsaved
 * document has no previous path, but its pasted images still live in the
 * per-document temporary folder, which is then migrated by the same rules.
 */
async function syncAssets(content, previousPath, nextPath, options = {}) {
  const result = { copied: 0, skipped: 0, renamed: [], content };
  if (!nextPath || typeof content !== 'string') return result;
  const fromDir = options.fromDirectory || (previousPath ? path.dirname(previousPath) : null);
  if (!fromDir) return result;
  const toDir = path.dirname(nextPath);
  if (fromDir === toDir) return result;
  const references = [];
  for (const match of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let reference;
    try { reference = decodeURIComponent(match[1]); } catch { continue; }
    if (!/^assets\/[^/\\]+$/.test(reference)) continue;
    const name = path.basename(reference);
    if (!name || name === '.' || name === '..') continue;
    references.push({ raw: match[1], name });
  }
  if (!references.length) return result;
  await fs.mkdir(path.join(toDir, 'assets'), { recursive: true });
  const assigned = new Map();
  const targetAssets = path.join(toDir, 'assets');
  const pickName = async (name, bytes) => {
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let index = 1; index <= 999; index++) {
      const candidate = `${stem}-${index}${extension}`;
      const existing = await fs.readFile(path.join(targetAssets, candidate)).catch(() => null);
      if (existing === null) return { name: candidate, copy: true };
      if (existing.equals(bytes)) return { name: candidate, copy: false };
    }
    throw new Error('目标文件夹中无法为该图片找到可用的文件名。');
  };
  for (const { name } of references) {
    if (assigned.has(name)) continue;
    const bytes = await fs.readFile(path.join(fromDir, 'assets', name)).catch(() => null);
    // A missing asset stays a visible broken link instead of failing the save.
    if (bytes === null) { assigned.set(name, null); continue; }
    const existing = await fs.readFile(path.join(targetAssets, name)).catch(() => null);
    if (existing !== null && existing.equals(bytes)) { assigned.set(name, name); result.skipped++; continue; }
    if (existing === null) {
      await fs.copyFile(path.join(fromDir, 'assets', name), path.join(targetAssets, name));
      assigned.set(name, name);
      result.copied++;
      continue;
    }
    const picked = await pickName(name, bytes);
    if (picked.copy) {
      await fs.copyFile(path.join(fromDir, 'assets', name), path.join(targetAssets, picked.name));
      result.copied++;
    } else result.skipped++;
    assigned.set(name, picked.name);
  }
  let next = content;
  for (const { raw, name } of references) {
    const replacement = assigned.get(name);
    if (!replacement || replacement === name) continue;
    const target = `assets/${encodeURIComponent(replacement)}`;
    next = next.split(`](${raw})`).join(`](${target})`);
    // Report each textual rewrite once, exactly as it appears in the document.
    if (!result.renamed.some(entry => entry.from === raw && entry.to === target)) result.renamed.push({ from: raw, to: target });
  }
  result.content = next;
  return result;
}

async function listMarkdown(root, base = root, depth = 0, budget = { count: 0 }) {
  if (depth > 12 || budget.count >= 5000) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'target'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      // An empty folder is listed as well: the file tree creates folders, and a
      // folder that just disappeared from the tree could never be filled.
      const children = await listMarkdown(root, full, depth + 1, budget).catch(() => []);
      result.push({ name: entry.name, path: full, children });
    } else if (/\.(md|markdown|mdown|txt)$/i.test(entry.name)) {
      result.push({ name: entry.name, path: full });
      if (++budget.count >= 5000) break;
    }
  }
  return result;
}
module.exports = { DocumentStore, atomicWrite, inside, listMarkdown, syncAssets, frontMatterImageRoot: frontMatter.frontMatterImageRoot, imageRootKey: frontMatter.imageRootKey, relocateImageRoot, HISTORY_LIMIT };
