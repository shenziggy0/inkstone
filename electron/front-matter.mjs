// Leading YAML front matter helpers shared by the renderer and the main
// process. The renderer needs the `typora-root-url` value to build an asset URL
// and to write the line from the «设置图片根目录» entry; Save As / rename in the
// main process needs the exact key position to relocate a document-relative
// root. Keeping one implementation means both sides agree on quoting, BOM,
// CRLF and on *where* the key really is (the leading block only, never a code
// fence that quotes the same text).
//
// This file is pure: no Node built-ins, no DOM and no top-level await, so it can
// be imported by Vite and required by electron/store.cjs alike.

export const IMAGE_ROOT_KEY = 'typora-root-url';

/** The readable value of a YAML scalar (double-quoted, single-quoted or plain). */
export function yamlScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('"')) {
    let value = '';
    for (let index = 1; index < text.length; index++) {
      const char = text[index];
      if (char === '"') return value || null;
      if (char !== '\\') { value += char; continue; }
      const next = text[++index];
      const simple = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      if (next in simple) { value += simple[next]; continue; }
      if (next === 'x' || next === 'u' || next === 'U') {
        const length = next === 'x' ? 2 : next === 'u' ? 4 : 8;
        const hex = text.slice(index + 1, index + 1 + length);
        if (new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) {
          const code = parseInt(hex, 16);
          if (code <= 0x10ffff) { value += String.fromCodePoint(code); index += length; continue; }
        }
      }
      // Not a valid YAML escape: keep both characters, so a hand-written
      // Windows path such as "C:\Users\图片" still reads as one folder.
      value += `\\${next ?? ''}`;
    }
    return null;
  }
  if (text.startsWith("'")) {
    let value = '';
    for (let index = 1; index < text.length; index++) {
      if (text[index] !== "'") { value += text[index]; continue; }
      if (text[index + 1] === "'") { value += "'"; index++; continue; }
      return value || null;
    }
    return null;
  }
  if (text.startsWith('|') || text.startsWith('>')) return null;
  // A YAML comment starts at a `#` that follows whitespace.
  const value = text.replace(/[ \t]#.*$/, '').trim();
  if (!value || /^(?:~|null|Null|NULL)$/.test(value)) return null;
  return value;
}

/** A double-quoted YAML scalar for a filesystem path. */
export function yamlQuoted(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The bounds of a leading YAML front matter block. `openEnd` is the index of the
 * newline that ends the opening `---` line; `closeStart` is the start of the
 * closing `---` / `...` line. Both are absolute offsets in the original text.
 */
export function frontMatterBounds(source) {
  const text = String(source ?? '');
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  const firstEnd = text.indexOf('\n', bom);
  const first = text.slice(bom, firstEnd < 0 ? text.length : firstEnd).replace(/\r$/, '');
  if (first.trim() !== '---') return null;
  let at = firstEnd < 0 ? text.length : firstEnd + 1;
  let closeStart = -1;
  while (at <= text.length) {
    const end = text.indexOf('\n', at);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(at, lineEnd).replace(/\r$/, '');
    if (line.trim() === '---' || line.trim() === '...') { closeStart = at; break; }
    if (end < 0) break;
    at = end + 1;
  }
  if (closeStart < 0) return null;
  return { text, bom, openEnd: firstEnd < 0 ? text.length : firstEnd, closeStart };
}

/**
 * The real `typora-root-url` line of the leading front matter, or null.
 * `lineStart`/`lineEnd` exclude the line break and any `\r`, so replacing that
 * range keeps the document's own CRLF / BOM untouched.
 */
export function imageRootKey(source) {
  const bounds = frontMatterBounds(source);
  if (!bounds) return null;
  let at = bounds.openEnd + 1;
  while (at < bounds.closeStart) {
    const end = bounds.text.indexOf('\n', at);
    const lineEnd = end < 0 || end > bounds.closeStart ? bounds.closeStart : end;
    const line = bounds.text.slice(at, lineEnd).replace(/\r$/, '');
    const match = /^typora-root-url[ \t]*:[ \t]*(.*)$/.exec(line);
    if (match) return { value: yamlScalar(match[1]), lineStart: at, lineEnd: at + line.length, line };
    at = lineEnd + 1;
  }
  return null;
}

/** The `typora-root-url` scalar of a document, or null when it has none. */
export function frontMatterImageRoot(source) {
  const key = imageRootKey(source);
  return key ? key.value : null;
}

/** A `\n`-style minimal edit that sets (or removes, with null) the key. */
export function setFrontMatterImageRoot(source, value) {
  const text = String(source ?? '');
  const line = value ? `${IMAGE_ROOT_KEY}: ${yamlQuoted(value)}` : null;
  const bounds = frontMatterBounds(text);
  if (!bounds) {
    if (!line) return null;
    const at = text.startsWith('\uFEFF') ? 1 : 0;
    return { from: at, to: at, insert: `---\n${line}\n---\n\n` };
  }
  const key = imageRootKey(text);
  if (key) {
    if (!line) {
      // Remove the whole line, including its own line break, but never the
      // closing delimiter that follows it.
      let removeTo = key.lineEnd;
      if (text[removeTo] === '\r') removeTo++;
      if (text[removeTo] === '\n') removeTo++;
      return { from: key.lineStart, to: removeTo, insert: '' };
    }
    return { from: key.lineStart, to: key.lineEnd, insert: line };
  }
  if (!line) return null;
  // Add it directly under the opening `---`, keeping the rest of the block.
  return { from: bounds.openEnd, to: bounds.openEnd, insert: `\n${line}` };
}

/**
 * The edit that rewrites the key only while its current value is still the one
 * the main process saw. A concurrent edit that changed or removed the line, or
 * added unrelated text elsewhere, is never overwritten; the caller simply keeps
 * the newer text. A code fence that quotes the same line is not the key and is
 * never touched.
 */
export function replaceFrontMatterImageRoot(source, expected, value) {
  const key = imageRootKey(source);
  if (!key) return null;
  if ((key.value ?? null) !== (expected ?? null)) return null;
  return setFrontMatterImageRoot(source, value);
}

/** The whole document with the key line replaced, or null when it has none. */
export function rewriteFrontMatterImageRoot(source, value) {
  const text = String(source ?? '');
  const key = imageRootKey(text);
  if (!key) return null;
  const line = `${IMAGE_ROOT_KEY}: ${yamlQuoted(value)}`;
  return text.slice(0, key.lineStart) + line + text.slice(key.lineEnd);
}
