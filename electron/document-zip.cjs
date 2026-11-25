const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { zip } = require('fflate');
const { isNetworkPath, resolveAssetFile } = require('./assets.cjs');
const { frontMatterImageRoot, setFrontMatterImageRoot } = require('./front-matter.mjs');
const { atomicWrite } = require('./store.cjs');

const createZip = promisify(zip);
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const fileKey = stat => stat?.ino ? `${stat.dev}:${stat.ino}` : null;

function portableName(stem, fallback) {
  const cleaned = stem.normalize('NFC').replace(/[<>:"/\\|?*#&\u0000-\u001f]/g, '-').trim().replace(/[. ]+$/, '');
  let result = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(result + character) > 200) break;
    result += character;
  }
  result = result.replace(/[. ]+$/, '') || fallback;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(result)) return `_${result}`;
  return result;
}

function documentName(doc) {
  const original = doc.path ? path.basename(doc.path) : doc.suggestedName || doc.name || '未命名.md';
  const extension = /\.(?:md|markdown|mdown|txt)$/i.exec(original)?.[0] || '';
  return portableName(original.slice(0, original.length - extension.length), '未命名') + (extension || '.md');
}

function imageName(file, usedNames) {
  const extension = path.extname(file).toLowerCase();
  const stem = portableName(path.basename(file, path.extname(file)), 'image');
  let name = `${stem}${extension}`;
  let suffix = 1;
  while (usedNames.has(name.toLowerCase())) name = `${stem}-${suffix++}${extension}`;
  usedNames.add(name.toLowerCase());
  return `assets/${name}`;
}

function imageReplacement(name, title) {
  const destination = encodeURI(name).replace(/[()]/g, character => character === '(' ? '%28' : '%29');
  if (title === undefined) return destination;
  const escaped = title.replace(/[&"\\\n\r]/g, character => `&#${character.charCodeAt(0)};`);
  return escaped ? `(${destination} "${escaped}")` : `(${destination})`;
}

function isLocalReference(src) {
  if (/^(?:file:|[a-z]:[\\/])/i.test(src)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

async function prepareDocumentZip(doc, assetOptions = {}) {
  const content = doc.content;
  const { collectAssetReferences, applyReferenceEdits } = await import('./asset-references.mjs');
  const references = collectAssetReferences(content, { all: true });
  const options = {
    documentPath: doc.path || doc.sourcePath,
    imageRoot: frontMatterImageRoot(content),
    ...assetOptions
  };
  const missing = new Set();
  const byReference = new Map();
  const byFile = new Map();
  const names = new Set();
  const files = new Map();
  const sourcePaths = new Set();
  const sourceFiles = new Set();
  const edits = [];

  for (const source of new Set([doc.path, doc.sourcePath].filter(Boolean))) {
    sourcePaths.add(pathKey(source));
    if (isNetworkPath(source)) continue;
    const key = fileKey(await fs.stat(source, { bigint: true }).catch(() => null));
    if (key) sourceFiles.add(key);
  }

  async function packageImage(src) {
    try {
      const file = await resolveAssetFile(src, options);
      if (byFile.has(file)) return byFile.get(file);
      sourcePaths.add(pathKey(file));
      const stat = await fs.stat(file, { bigint: true });
      if (!stat.isFile()) return null;
      const key = fileKey(stat);
      if (key) sourceFiles.add(key);
      const bytes = await fs.readFile(file);
      const name = imageName(file, names);
      byFile.set(file, name);
      files.set(name, [bytes, { level: 0 }]);
      return name;
    } catch {
      return null;
    }
  }

  for (const reference of references) {
    if (!isLocalReference(reference.src)) continue;
    if (reference.from !== null && !byReference.has(reference.src)) {
      byReference.set(reference.src, await packageImage(reference.src));
    }
    const name = reference.from !== null && byReference.get(reference.src);
    if (name) {
      edits.push({ from: reference.from, to: reference.to, insert: imageReplacement(name, reference.inlineImageTitle) });
    } else {
      missing.add(reference.inlineImageTitle === undefined ? reference.raw : reference.src);
    }
  }
  const rootEdit = setFrontMatterImageRoot(content, null);
  if (rootEdit) edits.push(rootEdit);
  const markdown = applyReferenceEdits(content, edits);
  const entries = Object.fromEntries([[documentName(doc), Buffer.from(markdown)], ...files]);
  return { missing: [...missing], entries, sourcePaths, sourceFiles };
}

async function writeDocumentZip(prepared, target) {
  const stat = await fs.stat(target, { bigint: true }).catch(() => null);
  if (prepared.sourcePaths.has(pathKey(target)) || prepared.sourceFiles.has(fileKey(stat))) {
    throw new Error('不能用压缩包覆盖原稿或原图，请另选一个保存位置。');
  }
  try {
    const archive = await createZip(prepared.entries);
    await atomicWrite(target, archive);
  } catch (cause) {
    throw new Error('原稿打包失败，请检查保存位置的权限及可用空间。', { cause });
  }
  return target;
}

module.exports = { prepareDocumentZip, writeDocumentZip };
