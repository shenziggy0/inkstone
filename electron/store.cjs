const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

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
  constructor(recoveryDirectory) {
    this.documents = new Map();
    this.recoveryDirectory = recoveryDirectory;
    this.locks = new Map();
  }
  async serial(id, action) {
    const pending = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(id, pending);
    try { return await pending; } finally { if (this.locks.get(id) === pending) this.locks.delete(id); }
  }
  create(content = '', file = null) {
    const doc = { id: crypto.randomUUID(), path: file, name: file ? path.basename(file) : '未命名.md', content, savedContent: '', version: null, dirty: !!content };
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
    // A decoder that throws avoids silently replacing invalid bytes on the next save.
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('该文件不是 UTF-8 文本。');
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
      if (file === doc.path && doc.version !== null) {
        const current = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current === null || digest(current) !== doc.version) throw new Error('文件已被其他程序修改或删除。为避免覆盖，请另存为，或重新打开磁盘版本。');
      }
      const opened = [...this.documents.values()].find(d => d.id !== id && d.path === file);
      if (opened) throw new Error('目标文件已在另一个标签页打开，请选择其他名称。');
      if (doc.path && doc.dirty && this.recoveryDirectory) {
        const history = path.join(this.recoveryDirectory, 'history');
        await fs.mkdir(history, { recursive: true });
        await atomicWrite(path.join(history, `${Date.now()}-${crypto.randomUUID()}-${doc.name}`), doc.savedContent);
      }
      await atomicWrite(file, doc.content);
      Object.assign(doc, { path: file, name: path.basename(file), savedContent: doc.content, version: digest(Buffer.from(doc.content)), dirty: false });
      await this.recover(doc);
      return this.public(doc);
    });
  }
  /** Re-read the on-disk version into an already-open document. */
  async reload(id) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      if (!doc.path) throw new Error('文档尚未保存到文件。');
      const bytes = await fs.readFile(doc.path);
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('该文件不是 UTF-8 文本。');
      Object.assign(doc, { content, savedContent: content, version: digest(bytes), dirty: false });
      await this.recover(doc);
      return this.public(doc);
    });
  }
  async close(id) {
    return this.serial(id, async () => {
      this.documents.delete(id);
      if (this.recoveryDirectory) await fs.unlink(path.join(this.recoveryDirectory, `${id}.json`)).catch(() => {});
    });
  }
  async recoverAll(includeNested = false) {
    if (!this.recoveryDirectory) return [];
    await fs.mkdir(this.recoveryDirectory, { recursive: true });
    const recovered = [];
    const files = [];
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
        const doc = this.create(record.content);
        this.get(doc.id).name = `恢复-${record.name || '未命名.md'}`;
        await this.recover(this.get(doc.id));
        recovered.push(this.public(this.get(doc.id)));
        await fs.unlink(file);
      } catch { /* Keep unreadable recovery files for manual recovery. */ }
    }
    return recovered;
  }
}

/**
 * Keep relative `assets/` images usable when a document is saved or renamed
 * into a different directory. Only references actually used by the document
 * are copied; the strict basename check prevents path traversal.
 */
async function syncAssets(content, previousPath, nextPath) {
  if (!previousPath || !nextPath || typeof content !== 'string') return 0;
  const fromDir = path.dirname(previousPath), toDir = path.dirname(nextPath);
  if (fromDir === toDir) return 0;
  const names = new Set();
  for (const match of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let reference;
    try { reference = decodeURIComponent(match[1]); } catch { continue; }
    if (!/^assets\/[^/\\]+$/.test(reference)) continue;
    const name = path.basename(reference);
    if (name && name !== '.' && name !== '..') names.add(name);
  }
  if (!names.size) return 0;
  await fs.mkdir(path.join(toDir, 'assets'), { recursive: true });
  let copied = 0;
  for (const name of names) {
    const source = path.join(fromDir, 'assets', name);
    const target = path.join(toDir, 'assets', name);
    if (source === target) continue;
    try { await fs.copyFile(source, target); copied++; } catch { /* missing asset stays a visible broken link */ }
  }
  return copied;
}

async function listMarkdown(root, base = root, depth = 0, budget = { count: 0 }) {
  if (depth > 12 || budget.count >= 5000) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'target'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      const children = await listMarkdown(root, full, depth + 1, budget).catch(() => []);
      if (children.length) result.push({ name: entry.name, path: full, children });
    } else if (/\.(md|markdown|mdown|txt)$/i.test(entry.name)) {
      result.push({ name: entry.name, path: full });
      if (++budget.count >= 5000) break;
    }
  }
  return result;
}
module.exports = { DocumentStore, atomicWrite, inside, listMarkdown, syncAssets };
