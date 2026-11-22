// Recently opened documents / folders and the session restored at startup.
// Both live in the user data directory, next to `settings.json`.
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./store.cjs');
// Reused instead of re-implemented: a recorded `\\host\share\…` must never be
// `stat`-ed, because on Windows that alone opens an SMB session and leaks the
// user's NTLM hash to whoever wrote the entry.
const { isNetworkPath } = require('./assets.cjs');

const RECENT_FILES_LIMIT = 20;
const RECENT_FOLDERS_LIMIT = 10;
const SESSION_FILES_LIMIT = 30;

/**
 * Insert `entry` at the front of `list`, remove duplicates and cut the tail.
 * Exported because the ordering rule ("most recent first, no duplicates, fixed
 * ceiling") is exactly what the menu relies on.
 */
function recordRecent(list, entry, limit) {
  const value = String(entry ?? '');
  if (!value) return Array.isArray(list) ? list.slice(0, limit) : [];
  const seen = new Set();
  const result = [value];
  seen.add(value);
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item ?? '');
    if (!text || seen.has(text) || text === value) continue;
    seen.add(text);
    result.push(text);
  }
  return result.slice(0, limit);
}

/** Drop entries whose file / folder no longer exists. */
async function pruneMissing(list) {
  const kept = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry !== 'string' || !entry) continue;
    // A recorded network location is dropped without any filesystem call.
    if (isNetworkPath(entry)) continue;
    const stat = await fs.stat(entry).catch(() => null);
    if (stat) kept.push(entry);
  }
  return kept;
}

/** `<userData>/recent.json` and `<userData>/session.json`, loaded lazily. */
class WorkspaceState {
  constructor(userData) {
    this.recentFile = path.join(userData, 'recent.json');
    this.sessionFile = path.join(userData, 'session.json');
    this.data = { files: [], folders: [] };
    this.session = { folder: null, files: [], active: null };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.recentFile, 'utf8'));
      this.data = {
        files: Array.isArray(parsed?.files) ? parsed.files.filter(entry => typeof entry === 'string') : [],
        folders: Array.isArray(parsed?.folders) ? parsed.folders.filter(entry => typeof entry === 'string') : []
      };
    } catch { /* first run */ }
    try {
      const parsed = JSON.parse(await fs.readFile(this.sessionFile, 'utf8'));
      this.session = {
        folder: typeof parsed?.folder === 'string' ? parsed.folder : null,
        files: Array.isArray(parsed?.files) ? parsed.files.filter(entry => typeof entry === 'string') : [],
        active: typeof parsed?.active === 'string' ? parsed.active : null
      };
    } catch { /* no session yet */ }
    // A deleted file must never come back through the menu.
    this.data.files = (await pruneMissing(this.data.files)).slice(0, RECENT_FILES_LIMIT);
    this.data.folders = (await pruneMissing(this.data.folders)).slice(0, RECENT_FOLDERS_LIMIT);
    return this;
  }

  /** Recent files as `{ path, name }`, ready for the menu and the palette. */
  files() { return this.data.files.map(file => ({ path: file, name: path.basename(file) })); }
  folders() { return this.data.folders.slice(); }

  recordFile(file) {
    if (typeof file !== 'string' || !file) return this.files();
    this.data.files = recordRecent(this.data.files, file, RECENT_FILES_LIMIT);
    this.schedule();
    return this.files();
  }

  recordFolder(folder) {
    if (typeof folder !== 'string' || !folder) return this.folders();
    this.data.folders = recordRecent(this.data.folders, folder, RECENT_FOLDERS_LIMIT);
    this.schedule();
    return this.folders();
  }

  async clear() {
    this.data = { files: [], folders: [] };
    await this.flush();
    return this.files();
  }

  /** Store the current session; a missing folder or document is dropped later. */
  setSession(session = {}) {
    const files = Array.isArray(session.files) ? session.files.filter(entry => typeof entry === 'string').slice(0, SESSION_FILES_LIMIT) : [];
    this.session = {
      folder: typeof session.folder === 'string' ? session.folder : null,
      files,
      active: typeof session.active === 'string' && files.includes(session.active) ? session.active : files[0] ?? null
    };
    this.schedule();
  }

  /**
   * The session to restore, with everything that disappeared filtered out.
   * Documents opened without a folder are restored too; only the folder itself
   * and the files inside it are dropped when the folder is gone.
   */
  async restorableSession() {
    // A folder that is a network location is not restored either, so startup
    // never touches another machine just because the previous session did.
    const folderExists = this.session.folder && !isNetworkPath(this.session.folder)
      ? !!(await fs.stat(this.session.folder).catch(() => null)) : false;
    const files = await pruneMissing(this.session.files);
    return {
      folder: folderExists ? this.session.folder : null,
      files,
      active: files.includes(this.session.active) ? this.session.active : files[0] ?? null
    };
  }

  schedule() {
    // Writes are coalesced: window bounds also persist through settings.json,
    // and typing does not touch either file, so a short delay is enough.
    this.writing = this.writing.then(() => new Promise(resolve => setTimeout(resolve, 120))).then(() => this.writeState()).catch(() => {});
    return this.writing;
  }

  flush() {
    this.writing = this.writing.then(() => this.writeState());
    return this.writing;
  }

  async writeState() {
    await atomicWrite(this.recentFile, JSON.stringify(this.data, null, 2)).catch(() => {});
    await atomicWrite(this.sessionFile, JSON.stringify(this.session, null, 2)).catch(() => {});
  }
}

async function claimMacFolderAccessReset(userData, executable, home) {
  const relative = path.join('Inkstone.app', 'Contents', 'MacOS', 'Inkstone');
  if (executable !== path.join('/Applications', relative) && executable !== path.join(home, 'Applications', relative)) return false;

  // The inode changes even when Finder replaces the app with the same build.
  const { ino, birthtimeNs, mtimeNs } = await fs.stat(executable, { bigint: true });
  const install = `${ino}:${birthtimeNs}:${mtimeNs}`;
  const marker = path.join(userData, 'mac-folder-access-install');
  const previous = await fs.readFile(marker, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous === install) return false;
  // Record the attempt first so a failed or interrupted reset cannot erase new choices on restart.
  await fs.mkdir(userData, { recursive: true });
  await atomicWrite(marker, install);
  return true;
}

module.exports = { WorkspaceState, recordRecent, pruneMissing, claimMacFolderAccessReset, RECENT_FILES_LIMIT, RECENT_FOLDERS_LIMIT, SESSION_FILES_LIMIT };
