// Image reference resolution shared by the asset protocol, the clipboard image
// actions and HTML export inlining. One implementation means a picture shown in
// the editor and the same picture inlined into an export can never disagree.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { inside } = require('./store.cjs');

// Only these extensions are ever served, inlined or copied. Keeping the list in
// one place is what makes "any local image" a safe promise: the file is always
// checked after realpath, so a symlink cannot smuggle in a non-image.
const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon']
]);

const INVALID = '图片路径无效。';
const LOCAL_ONLY = '仅支持文档中的本地图片。';
const NETWORK = '不支持指向网络位置的图片。';
const LINK_INVALID = '链接路径无效。';
const LINK_LOCAL_ONLY = '仅支持文档中的本地链接。';
const LINK_NETWORK = '不支持指向网络位置的链接。';
const LINK_MISSING = '链接指向的文件不存在。';

/**
 * Anything that makes Windows talk to another machine: UNC paths (`\\host\…`,
 * `//host/…`), the `\\?\UNC\` / `\\.\` device forms, and any host-ful
 * `file://host/…` URL. A document is untrusted input, and merely calling
 * `fs.realpath()` on such a path opens an SMB session — which leaks the user's
 * NTLM hash to whoever wrote the Markdown. Every check below runs before the
 * first filesystem call, and once more on the realpath result.
 */
const isNetworkPath = value => /^[\\/]{2}/.test(String(value ?? ''));

/** `file://` URLs are only accepted without a host, or with `localhost`. */
function isNetworkFileURL(url) {
  const host = url.hostname.toLowerCase();
  return host !== '' && host !== 'localhost';
}

/** The reference an author typed, recovered from markdown-it's encoding. */
function decodeReference(reference) {
  const text = String(reference ?? '');
  try { return decodeURI(text); } catch { return text; }
}

/**
 * The reference carried by an `inkstone-asset:` URL path. The renderer encodes
 * the whole reference as ONE segment (see src/markdown.js assetURL()), because
 * WHATWG URL parsing collapses `..` path segments.
 */
function referenceFromPath(pathname) {
  const text = String(pathname ?? '');
  const encoded = text.startsWith('/') ? text.slice(1) : text;
  try { return decodeURIComponent(encoded); } catch { return ''; }
}

/** `{ documentId, reference }` of an asset URL string or URL object. */
function parseAssetURL(url) {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return { documentId: parsed.hostname, reference: referenceFromPath(parsed.pathname) };
}

/**
 * Unsaved documents keep their pasted images in the application's own folder,
 * one directory per document id, so the editor can show `assets/x.png`
 * immediately and the files can move next to the document on first save.
 */
function unsavedAssetsDirectory(userData, documentId) {
  if (typeof documentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(documentId)) throw new Error('文档标识无效。');
  return path.join(userData, 'unsaved-assets', documentId);
}

/** Windows drive / UNC / POSIX absolute path. */
const isAbsoluteReference = reference =>
  /^[a-zA-Z]:[\\/]/.test(reference) || /^\\\\/.test(reference) || path.isAbsolute(reference) || path.win32.isAbsolute(reference);

/**
 * Resolve one image reference to the real file the app may read.
 *
 * Accepted, per Typora's habit: a path relative to the document, `../` above the
 * document, a Windows absolute path and a `file:///` URL. The trade-off is
 * deliberate: the file must exist, must be a regular path after realpath, and
 * must carry an image extension — the app only ever puts the bytes into an
 * `<img>`, and an SVG loaded as an image can neither script nor run macros. The
 * document id itself is checked by the caller (protocol / export), so a
 * reference can never escape into another window's documents.
 *
 * Relative references of an unsaved document resolve inside that document's
 * temporary folder only; an absolute path or file URL stays allowed there too.
 *
 * Network locations are refused before any filesystem call (see isNetworkPath):
 * opening a document must never make the machine contact another host.
 */
async function resolveAssetFile(reference, { documentPath = null, unsavedDirectory = null } = {}) {
  const raw = decodeReference(reference);
  if (!raw || raw.length > 4096 || raw.includes('\0')) throw new Error(INVALID);
  if (isNetworkPath(raw)) throw new Error(NETWORK);
  let target;
  if (/^file:/i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error(INVALID); }
    if (isNetworkFileURL(url)) throw new Error(NETWORK);
    try { target = fileURLToPath(url); } catch { throw new Error(INVALID); }
  } else if (isAbsoluteReference(raw)) {
    target = raw;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new Error(LOCAL_ONLY);
  } else {
    const base = documentPath ? path.dirname(documentPath) : unsavedDirectory;
    if (!base) throw new Error(LOCAL_ONLY);
    target = path.resolve(base, raw);
    if (!documentPath && unsavedDirectory && !inside(unsavedDirectory, target)) throw new Error(INVALID);
  }
  // A relative reference below a document that itself lives on a share would
  // otherwise resolve to UNC; refuse that too, before it is stat'ed.
  if (isNetworkPath(target)) throw new Error(NETWORK);
  const resolved = await fs.realpath(target);
  // A symlink, junction or mapped drive can still lead to another machine.
  if (isNetworkPath(resolved)) throw new Error(NETWORK);
  if (!IMAGE_MIME.has(path.extname(resolved).toLowerCase())) throw new Error(INVALID);
  return resolved;
}

/** MIME type for an already resolved image file. */
const imageMime = file => IMAGE_MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream';

/**
 * Extensions that make opening a file equivalent to running code.
 *
 * A document is untrusted input, so a link inside one must never be able to
 * launch a program: one click on «打开» in the confirmation dialog would
 * otherwise execute whatever the author shipped next to the Markdown file.
 * Windows resolves at least `.exe`, `.bat`, `.cmd`, `.ps1`, `.lnk` and friends
 * through the shell; macOS treats bundles and `.command`/`.sh` files the same
 * way. Everything `PATHEXT` declares is refused as well, so a machine that
 * registers an extra executable type is covered without a code change.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows programs, scripts, installers and shell-affecting containers.
  'exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'msi', 'msp', 'scr', 'cpl', 'lnk', 'url', 'reg', 'jar', 'pif', 'application',
  'gadget', 'appref-ms', 'settingcontent-ms', 'msc', 'crt', 'ins', 'isp', 'shs',
  // macOS bundles and scripts.
  'app', 'command', 'sh', 'pkg', 'terminal', 'workflow', 'action'
]);

/**
 * True when `file` names something the system would execute or install.
 *
 * The check uses the extension of the *resolved* path, so a symlink, a `.lnk`
 * shortcut or a path with a different spelling cannot smuggle in a program.
 */
function isExecutableExtension(file, { platform = process.platform, pathExt = process.env.PATHEXT } = {}) {
  const name = String(file ?? '');
  const extension = path.extname(name).toLowerCase();
  if (!extension) return false;
  const bare = extension.slice(1);
  if (EXECUTABLE_EXTENSIONS.has(bare)) return true;
  if (platform !== 'win32' || typeof pathExt !== 'string') return false;
  // `PATHEXT` is what the Windows shell considers runnable right now.
  for (const entry of pathExt.split(';')) {
    const value = entry.trim().replace(/^\./, '').toLowerCase();
    if (value && value === bare) return true;
  }
  return false;
}

/**
 * Resolve a link inside a document (`./other.md`, `../notes/a.md#title`) to a
 * real file on this machine.
 *
 * The reference decoding and the network-path refusal are the image resolver's,
 * because a document is untrusted input in both cases: `\\host\share` must be
 * rejected before the first filesystem call, or merely rendering the page would
 * leak the user's NTLM hash. The only deliberate difference is that any file
 * type is accepted — a link may point at a PDF — and a missing target is
 * reported instead of throwing, so the caller can say so in Chinese.
 */
async function resolveDocumentLink(reference, { documentPath = null, unsavedDirectory = null } = {}) {
  const raw = decodeReference(reference);
  if (!raw || raw.length > 4096 || raw.includes('\0')) throw new Error(LINK_INVALID);
  if (isNetworkPath(raw)) throw new Error(LINK_NETWORK);
  let target;
  if (/^file:/i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error(LINK_INVALID); }
    if (isNetworkFileURL(url)) throw new Error(LINK_NETWORK);
    try { target = fileURLToPath(url); } catch { throw new Error(LINK_INVALID); }
  } else if (isAbsoluteReference(raw)) {
    target = raw;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new Error(LINK_LOCAL_ONLY);
  } else {
    const base = documentPath ? path.dirname(documentPath) : unsavedDirectory;
    if (!base) throw new Error('请先保存文档，才能打开相对链接。');
    target = path.resolve(base, raw);
    if (!documentPath && unsavedDirectory && !inside(unsavedDirectory, target)) throw new Error(LINK_INVALID);
  }
  if (isNetworkPath(target)) throw new Error(LINK_NETWORK);
  const resolved = await fs.realpath(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!resolved) throw new Error(LINK_MISSING);
  if (isNetworkPath(resolved)) throw new Error(LINK_NETWORK);
  return resolved;
}

module.exports = {
  IMAGE_MIME, imageMime, decodeReference, referenceFromPath, isNetworkPath, isNetworkFileURL,
  parseAssetURL, unsavedAssetsDirectory, resolveAssetFile, resolveDocumentLink,
  isExecutableExtension, EXECUTABLE_EXTENSIONS,
  LINK_INVALID, LINK_LOCAL_ONLY, LINK_NETWORK, LINK_MISSING
};
