const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
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
const fileQueues = new Map();
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

async function queueTask(queues, key, action) {
  const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, pending);
  try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
}

function withFileLocks(files, action) {
  const keys = [...new Set(files.map(pathKey))].sort();
  return keys.reduceRight((next, key) => () => queueTask(fileQueues, key, next), action)();
}

async function missingAsNull(promise) {
  return promise.catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

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
    return queueTask(this.locks, id, action);
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
    const recovered = options.recovered === true;
    const dirty = recovered || (typeof options.dirty === 'boolean' ? options.dirty : !!content);
    const doc = {
      id: crypto.randomUUID(), path: file, name, content, savedContent: dirty ? '' : content,
      version: null, dirty, recovered, sourcePath: options.sourcePath || null
    };
    this.documents.set(doc.id, doc);
    return this.public(doc);
  }
  get(id) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error('文档已关闭，请重新打开。');
    return doc;
  }
  public(doc) {
    const record = { id: doc.id, path: doc.path, name: doc.name, content: doc.content, dirty: doc.dirty };
    if (doc.recovered) record.recovered = true;
    return record;
  }
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
      doc.dirty = doc.recovered || content !== doc.savedContent;
      await this.recover(doc);
      return this.public(doc);
    });
  }
  async recover(doc) {
    if (!this.recoveryDirectory) return;
    await fs.mkdir(this.recoveryDirectory, { recursive: true });
    const file = path.join(this.recoveryDirectory, `${doc.id}.json`);
    if (!doc.dirty) { await missingAsNull(fs.unlink(file)); return; }
    await atomicWrite(file, JSON.stringify({
      ...this.public(doc), schemaVersion: 2, sourcePath: doc.sourcePath,
      recovered: doc.recovered, updatedAt: new Date().toISOString()
    }));
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
  async save(id, target, { migrateAssets = false, moveSource } = {}) {
    return this.serial(id, async () => {
      const doc = this.get(id);
      const requestedFile = target || doc.path;
      if (!requestedFile) throw new Error('请先选择保存位置。');
      // /tmp and /private/tmp (and user-created symlinks) can name the same file.
      // Canonicalize before checking open-document identity or disk conflicts.
      const file = await fs.realpath(requestedFile).catch(async error => {
        if (error.code !== 'ENOENT') throw error;
        const parent = await fs.realpath(path.dirname(requestedFile)).catch(dirError => {
          if (dirError.code === 'ENOENT') throw new Error('保存位置所在的文件夹不存在。');
          throw dirError;
        });
        return path.join(parent, path.basename(requestedFile));
      });
      const previous = doc.path;
      const sameFile = previous && pathKey(previous) === pathKey(file);
      const moving = Boolean(moveSource && previous && !sameFile);
      return withFileLocks(previous ? [previous, file] : [file], async () => {
        let diskContent = null;
        if ((sameFile || moving) && doc.version !== null) {
          const current = await missingAsNull(fs.readFile(previous));
          if (current === null || digest(current) !== doc.version) throw new Error('文件已被其他程序修改或删除。为避免覆盖，请另存为，或重新打开磁盘版本。');
          // Keep the accepted external revision when it differs from our baseline.
          try { diskContent = decodeText(current); } catch { diskContent = null; }
        }
        const opened = [...this.documents.values()].find(other => other.id !== id && other.path && pathKey(other.path) === pathKey(file));
        if (opened) throw new Error('目标文件已在另一个标签页打开，请选择其他名称。');

        const sourcePath = previous || doc.sourcePath;
        const privateAssets = migrateAssets && !sourcePath && this.unsavedAssetsDirectory
          ? path.join(this.unsavedAssetsDirectory, id) : null;
        if (privateAssets) {
          const privateRoot = await missingAsNull(fs.realpath(privateAssets));
          if (privateRoot && inside(privateRoot, file)) throw new Error('不能保存到本草稿的临时图片目录。');
        }
        const migration = migrateAssets
          ? await syncAssets(doc.content, sourcePath, file, { fromDirectory: privateAssets })
          : { content: doc.content, renamed: [] };
        if (migration.unresolved?.length) {
          throw new Error(`图片未能迁移，文档未保存：${migration.unresolved.map(item => `${item.name}（${item.reason}）`).join('、')}`);
        }
        const relocation = relocateImageRoot(migration.content, sourcePath, file);
        if (previous) {
          if (doc.dirty) await this.writeHistory(doc, doc.savedContent);
          if (diskContent !== null && diskContent !== doc.savedContent) await this.writeHistory(doc, diskContent);
        }
        if (moving) {
          // A confirmed overwrite still retains the previous target version.
          const targetBytes = await missingAsNull(fs.readFile(file));
          if (targetBytes && !targetBytes.equals(Buffer.from(relocation.content))) {
            const targetText = decodeText(targetBytes);
            await this.writeHistory({ path: file, name: path.basename(file) }, targetText);
          }
        }
        await atomicWrite(file, relocation.content);
        const previousKey = moving ? this.historyKey(doc) : null;
        Object.assign(doc, {
          path: file, name: path.basename(file), content: relocation.content,
          savedContent: relocation.content, version: digest(Buffer.from(relocation.content)),
          dirty: false, recovered: false, sourcePath: null
        });
        const warnings = [];
        if (moving) {
          try {
            await this.moveHistory(previousKey, this.historyKey(doc));
            await moveSource(previous);
          } catch (error) {
            warnings.push(`已保存到新位置，但移动未完成：${error.message}`);
          }
        }
        try {
          await this.recover(doc);
          if (privateAssets) await fs.rm(privateAssets, { recursive: true, force: true });
        } catch (error) {
          warnings.push(`已保存文档，但未能清理临时文件：${error.message}`);
        }
        const result = { ...this.public(doc), imageRootRewrite: relocation.imageRootRewrite };
        if (migrateAssets) result.rewritten = migration.renamed;
        if (warnings.length) result.warnings = warnings;
        return result;
      });
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
      const warnings = [];
      try {
        if (previousKey !== nextKey) await this.moveHistory(previousKey, nextKey);
      } catch (error) {
        warnings.push(`已更新路径，但历史迁移未完成：${error.message}`);
      }
      try { await this.recover(doc); }
      catch (error) { warnings.push(`已更新路径，但恢复记录未能更新：${error.message}`); }
      return { ...this.public(doc), ...(warnings.length ? { warnings } : {}) };
    });
  }
  /** Copy all recognized entries before removing the source history. */
  async moveHistory(fromKey, toKey) {
    if (fromKey === toKey) return false;
    if (!/^[0-9a-f]{16}$/.test(fromKey) || !/^[0-9a-f]{16}$/.test(toKey)) throw new Error('历史目录键无效。');
    const from = path.join(this.historyDirectory, fromKey);
    const to = path.join(this.historyDirectory, toKey);
    return withFileLocks([from, to], async () => {
      const entries = await missingAsNull(fs.readdir(from, { withFileTypes: true }));
      if (!entries) return false;
      const versions = entries.filter(entry => entry.isFile() && HISTORY_ENTRY.test(entry.name));
      if (!versions.length) return false;
      await fs.mkdir(to, { recursive: true });
      for (const entry of versions) {
        const source = path.join(from, entry.name);
        const destination = path.join(to, entry.name);
        try {
          await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const bytes = await fs.readFile(source);
          if ((await fs.readFile(destination)).equals(bytes)) continue;
          const [, stamp, , name] = HISTORY_ENTRY.exec(entry.name);
          await fs.copyFile(source, path.join(to, `${stamp}-${crypto.randomUUID()}-${name}`), constants.COPYFILE_EXCL);
        }
      }
      for (const entry of versions) await missingAsNull(fs.unlink(path.join(from, entry.name)));
      await fs.rmdir(from).catch(() => {});
      await this.pruneHistory(to);
      return true;
    });
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
   * Copy the old draft's assets first. The caller retires the source only
   * after the new recovery record has been written successfully.
   */
  async carryUnsavedAssets(fromId, toId) {
    if (!this.unsavedAssetsDirectory || !SAFE_DOCUMENT_ID.test(fromId || '') || !SAFE_DOCUMENT_ID.test(toId || '') || fromId === toId) return false;
    const source = path.join(this.unsavedAssetsDirectory, fromId);
    const target = path.join(this.unsavedAssetsDirectory, toId);
    const stat = await missingAsNull(fs.lstat(source));
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error('恢复图片目录无效。');
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    return true;
  }
  async recoverAll(includeNested = false, { isDocumentOpen = () => false } = {}) {
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
      let doc;
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof record.content !== 'string') continue;
        if (isDocumentOpen(record.id)) continue;
        const { isNetworkPath } = require('./assets.cjs');
        const origin = record.sourcePath || record.path;
        const sourcePath = typeof origin === 'string' && path.isAbsolute(origin) && !isNetworkPath(origin) ? origin : null;
        const name = path.basename(typeof record.name === 'string' ? record.name : '') || '未命名.md';
        doc = this.create(record.content, null, {
          name: record.recovered ? name : `恢复-${name}`, recovered: true, sourcePath
        });
        const copied = await this.carryUnsavedAssets(record.id, doc.id);
        await this.recover(this.get(doc.id));
        // If retirement fails, keep only the original recovery entry.
        await fs.unlink(file);
        if (sourcePath) this.recoveredPaths.add(sourcePath);
        recovered.push(doc);
        if (copied && !this.documents.has(record.id)) {
          await fs.rm(path.join(this.unsavedAssetsDirectory, record.id), { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        if (!doc) continue;
        this.documents.delete(doc.id);
        await fs.unlink(path.join(this.recoveryDirectory, `${doc.id}.json`)).catch(() => {});
        if (this.unsavedAssetsDirectory) {
          await fs.rm(path.join(this.unsavedAssetsDirectory, doc.id), { recursive: true, force: true }).catch(() => {});
        }
      }
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

/** Preserve managed relative images without replacing unrelated target files. */
async function syncAssets(content, previousPath, nextPath, options = {}) {
  const result = { copied: 0, skipped: 0, renamed: [], unresolved: [], content };
  if (!nextPath || typeof content !== 'string') return result;
  const fromDir = options.fromDirectory || (previousPath ? path.dirname(previousPath) : null);
  if (!fromDir) return result;
  const toDir = path.dirname(nextPath);
  if (pathKey(fromDir) === pathKey(toDir)) return result;

  const { collectAssetReferences, rewriteAssetReferences } = await import('./asset-references.mjs');
  const { IMAGE_MIME, isNetworkPath, resolveAssetFile } = require('./assets.cjs');
  const references = collectAssetReferences(content);
  const images = new Map();
  for (const reference of references) {
    if (!images.has(reference.name)) images.set(reference.name, []);
    images.get(reference.name).push(reference);
  }
  const fromAssets = path.join(fromDir, 'assets');
  const toAssets = path.join(toDir, 'assets');
  if (isNetworkPath(fromAssets) || isNetworkPath(toAssets)) throw new Error('不支持迁移网络位置的图片。');

  // First save preserves all private assets, including raw HTML references
  // and images that do not currently appear in Markdown.
  if (options.fromDirectory) {
    const privateEntries = await missingAsNull(fs.readdir(options.fromDirectory, { withFileTypes: true }));
    for (const entry of privateEntries || []) {
      if (entry.name !== 'assets' || !entry.isDirectory()) {
        result.unresolved.push({ name: entry.name, reason: '临时目录包含无法迁移的资源' });
      }
    }
    if (result.unresolved.length) return result;
    const entries = await missingAsNull(fs.readdir(fromAssets, { withFileTypes: true }));
    for (const entry of entries || []) {
      if (!entry.isFile() || !IMAGE_MIME.has(path.extname(entry.name).toLowerCase())) {
        result.unresolved.push({ name: entry.name, reason: '临时目录包含无法迁移的资源' });
      } else if (!images.has(entry.name)) {
        images.set(entry.name, []);
      }
    }
  }
  if (!images.size || result.unresolved.length) return result;

  await fs.mkdir(toAssets, { recursive: true });
  const destinationRoot = await fs.realpath(toAssets);
  if (isNetworkPath(destinationRoot)) throw new Error('不支持迁移网络位置的图片。');
  const privateRoot = options.fromDirectory && await missingAsNull(fs.realpath(options.fromDirectory));
  if (privateRoot && inside(privateRoot, destinationRoot)) {
    throw new Error('目标图片目录指向本草稿的临时目录。');
  }

  for (const [name, uses] of images) {
    try {
      if (!IMAGE_MIME.has(path.extname(name).toLowerCase())) throw new Error('不支持的图片类型');
      const reference = uses[0]?.src ?? `assets/${encodeURIComponent(name)}`;
      const source = await resolveAssetFile(reference, {
        documentPath: previousPath,
        unsavedDirectory: options.fromDirectory
      });
      if (options.fromDirectory && !inside(await fs.realpath(fromAssets), source)) {
        throw new Error('图片不在临时资源目录中');
      }
      if (!(await fs.stat(source)).isFile()) throw new Error('图片不是普通文件');
      const bytes = await fs.readFile(source);
      const extension = path.extname(name);
      const stem = name.slice(0, name.length - extension.length);
      let assigned = false;
      for (let index = 0; index <= 999; index++) {
        if (index && (!uses.length || uses.some(use => use.from === null))) {
          throw new Error('存在同名图片，且无法安全改写引用');
        }
        const candidate = index ? `${stem}-${index}${extension}` : name;
        const destination = path.join(destinationRoot, candidate);
        try {
          await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
          if (!(await fs.readFile(destination)).equals(bytes)) throw new Error('图片在迁移期间发生变化');
          result.copied++;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = await fs.lstat(destination);
          if (!stat.isFile() || !(await fs.readFile(destination)).equals(bytes)) continue;
          result.skipped++;
        }
        if (index) {
          const to = `assets/${encodeURIComponent(candidate)}`;
          for (const { raw: from } of uses) {
            if (!result.renamed.some(item => item.from === from)) result.renamed.push({ from, to });
          }
        }
        assigned = true;
        break;
      }
      if (!assigned) throw new Error('找不到可用的目标文件名');
    } catch (error) {
      result.unresolved.push({ name, reason: error.code === 'ENOENT' ? '源文件不存在' : error.message });
    }
  }
  result.content = rewriteAssetReferences(content, result.renamed, references);
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
