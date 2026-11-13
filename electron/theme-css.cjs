// Typora-compatible CSS theme loading.
//
// Typora themes are ordinary style sheets with three conventions this loader
// understands: relative `@import` files, relative font/image resources and the
// `#write` document column. Everything stays local: imports and `url(...)` are
// resolved below <userData>/themes (after realpath), remote/UNC/absolute
// references become an empty data URL, and binary resources are embedded as
// data URLs so the editor, HTML/PDF exports and the PNG capture window all use
// the same bytes without a second protocol.
const fs = require('node:fs/promises');
const path = require('node:path');

// Expanded CSS (including data URLs) is bounded separately from the source
// text: a theme must never be cut in the middle of an embedded font or rule.
const MAX_THEME_CSS = 8 * 1024 * 1024;
const MAX_IMPORTED_CSS = 2 * 1024 * 1024;
const MAX_RESOURCE = 20 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 8;

const RESOURCE_MIME = Object.freeze({
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
});
const STYLE_EXTENSIONS = new Set(['.css']);
const RESOURCE_EXTENSIONS = new Set(Object.keys(RESOURCE_MIME));
const DANGEROUS_DECLARATIONS = new Set(['behavior', '-moz-binding', '-ms-behavior']);
const TYPOGRAPHIC = new Set([
  'color', 'font', 'font-family', 'font-size', 'font-style', 'font-variant',
  'font-weight', 'letter-spacing', 'line-height', 'text-align', 'text-decoration',
  'text-decoration-color', 'text-decoration-line', 'text-decoration-style',
  'text-shadow', 'text-transform', 'white-space', 'word-spacing', 'word-break',
  'overflow-wrap', 'word-wrap'
]);
const REJECTED_RESOURCE_FUNCTIONS = new Set([
  'image-set', '-webkit-image-set', 'image', 'cross-fade', '-webkit-cross-fade',
  'paint', 'src'
]);
const EMBEDDED_AT_RULES = new Set(['font-face', 'page']);
const GROUP_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document']);
const KEYFRAME_AT_RULES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes']);

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function safeThemeName(name) {
  return typeof name === 'string' && name === path.basename(name) && !/[\\/]/.test(name) && !name.startsWith('.') && /\.css$/i.test(name);
}

/** A CSS string with backslash escapes reduced to the characters they quote. */
function unescapeCSS(value) {
  return String(value).replace(/\\([\\'"() ])/g, '$1');
}

const withoutQuery = value => String(value).split(/[?#]/, 1)[0];

/**
 * At-rule preludes are copied back into the generated style sheet. A `}` in a
 * prelude would close the generated block early and let the following text
 * escape the document scope, so suspicious preludes are dropped entirely.
 * `</style` would also terminate the export's <style> element.
 */
function safePrelude(value) {
  return !/[{}\\]|<\/style/i.test(String(value || ''));
}

const safeSelector = value => !/[{}]/.test(value) && !/<\/style/i.test(value);

function readCSSName(value, start) {
  let index = start;
  let raw = '';
  let escaped = false;
  let commented = false;
  while (index < value.length) {
    const character = value[index];
    if (/[A-Za-z0-9_-]/.test(character)) { raw += character; index++; continue; }
    if (character === '\\') {
      const escapeStart = index;
      index++;
      let digits = 0;
      while (digits < 6 && /[0-9A-Fa-f]/.test(value[index] || '')) { index++; digits++; }
      if (digits) {
        if (value[index] === '\r' && value[index + 1] === '\n') index += 2;
        else if (/[ \t\n\r\f]/.test(value[index] || '')) index++;
      } else if (index < value.length) {
        index++;
      }
      raw += value.slice(escapeStart, index);
      escaped = true;
      continue;
    }
    if (character === '/' && value[index + 1] === '*') {
      const end = skipComment(value, index);
      // CSS comments are removed during tokenisation, so `u/**/rl()` is the
      // same function token as `url()`. Only continue the name when another
      // name character follows the comment.
      if (/[A-Za-z0-9_\\-]/.test(value[end] || '')) { commented = true; index = end; continue; }
    }
    break;
  }
  return { end: index, raw, escaped, commented };
}

function decodeCSSIdentifier(value) {
  return String(value).replace(/\\(?:([0-9A-Fa-f]{1,6})(?:\r\n|[ \n\r\t\f])?|([\s\S]))/g, (_match, hex, character) => {
    if (!hex) return character;
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
  });
}

/**
 * Resource-bearing CSS functions this loader does not reinterpret. `image-set`
 * carries bare URL strings rather than `url()` tokens, and an escaped function
 * name (`u\72l`) is the same token to CSS but not to a literal regex. Both are
 * rejected instead of trying to decode the whole style sheet (which would also
 * turn harmless content escapes into syntax).
 */
function unsafeResourceSyntax(value) {
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === '/' && value[index + 1] === '*') { index = skipComment(value, index); continue; }
    if (character === '"' || character === "'") { index = skipString(value, index); continue; }
    if (/[A-Za-z_\\-]/.test(character)) {
      const token = readCSSName(value, index);
      if (token.end === index) { index++; continue; }
      index = token.end;
      const open = skipTrivia(value, index);
      if (value[open] === '(') {
        const name = decodeCSSIdentifier(token.raw).toLowerCase();
        if (REJECTED_RESOURCE_FUNCTIONS.has(name)) return true;
        if (name === 'url' && (token.escaped || token.commented)) return true;
      }
      continue;
    }
    index++;
  }
  return false;
}

/**
 * A raw `}` in a declaration value would close the generated rule. Property
 * names are restricted to ordinary/custom properties, so a theme cannot smuggle
 * a rule boundary through either side of the colon. Complex resource syntax is
 * rejected before the value is copied; content escapes such as `\2014` remain
 * untouched.
 */
function safeDeclaration(property, value) {
  return /^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9_-]*)$/.test(property.trim())
    && !/[{}]/.test(value)
    && !/<\/style/i.test(value)
    && !unsafeResourceSyntax(value);
}

/**
 * Resolve one CSS reference through the theme root. The reference is decoded
 * first, then rejected unless it is a plain relative path whose realpath is
 * still under the real theme root. This is the single gate for `@import`,
 * `url(...)` and every embedded resource.
 */
async function localThemeFile(root, baseFile, reference, extensions, fromDirectory = false) {
  let decoded;
  try { decoded = decodeURIComponent(withoutQuery(unescapeCSS(reference).trim())); } catch { return null; }
  if (!decoded || decoded.includes('\0')) return null;
  // Any explicit scheme, drive letter, absolute path, UNC/device prefix or
  // backslash spelling is not a theme-relative resource.
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  if (/^[\\/]/.test(decoded) || decoded.includes('\\')) return null;
  const candidate = path.resolve(fromDirectory ? baseFile : path.dirname(baseFile), decoded);
  if (!isInside(root, candidate)) return null;
  let real;
  try { real = await fs.realpath(candidate); } catch { return null; }
  if (!isInside(root, real)) return null;
  const extension = path.extname(real).toLowerCase();
  if (!extensions.has(extension)) return null;
  try {
    const stats = await fs.stat(real);
    if (!stats.isFile() || stats.size > MAX_RESOURCE) return null;
  } catch { return null; }
  return real;
}

function dataURL(file, bytes) {
  const mime = RESOURCE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function resourceURL(root, baseFile, reference) {
  if (/^data:/i.test(reference)) return reference;
  if (reference.startsWith('#')) return reference;
  const file = await localThemeFile(root, baseFile, reference, RESOURCE_EXTENSIONS);
  if (!file) return null;
  try { return dataURL(file, await fs.readFile(file)); } catch { return null; }
}

// ── CSS scanning ───────────────────────────────────────────────────────────
// The transforms below only need to understand top-level rule boundaries,
// strings and comments. A full CSS parser would be larger than the feature.
function skipComment(css, index) {
  const end = css.indexOf('*/', index + 2);
  return end < 0 ? css.length : end + 2;
}

function skipString(css, index) {
  const quote = css[index];
  let current = index + 1;
  while (current < css.length) {
    if (css[current] === '\\') { current += 2; continue; }
    if (css[current] === quote) return current + 1;
    current++;
  }
  return css.length;
}

function readBlock(css, index) {
  let depth = 1;
  let current = index + 1;
  while (current < css.length) {
    const character = css[current];
    if (character === '/' && css[current + 1] === '*') { current = skipComment(css, current); continue; }
    if (character === '"' || character === "'") { current = skipString(css, current); continue; }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return { body: css.slice(index + 1, current), end: current + 1 };
    current++;
  }
  return { body: css.slice(index + 1), end: css.length };
}

function skipTrivia(css, index) {
  let current = index;
  while (current < css.length) {
    if (/\s/.test(css[current])) { current++; continue; }
    if (css[current] === '/' && css[current + 1] === '*') { current = skipComment(css, current); continue; }
    break;
  }
  return current;
}

function parseStyleSheet(css) {
  const nodes = [];
  let index = 0;
  while (index < css.length) {
    index = skipTrivia(css, index);
    if (index >= css.length) break;
    if (css[index] === '@') {
      const nameStart = ++index;
      while (index < css.length && /[-\w]/.test(css[index])) index++;
      const name = css.slice(nameStart, index).toLowerCase();
      const preludeStart = index;
      let depth = 0;
      while (index < css.length) {
        const character = css[index];
        if (character === '/' && css[index + 1] === '*') { index = skipComment(css, index); continue; }
        if (character === '"' || character === "'") { index = skipString(css, index); continue; }
        if (character === '(') depth++;
        else if (character === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (character === '{' || character === ';')) break;
        index++;
      }
      const prelude = css.slice(preludeStart, index).trim();
      if (css[index] === ';') {
        nodes.push({ type: 'at', name, prelude });
        index++;
      } else if (css[index] === '{') {
        const block = readBlock(css, index);
        nodes.push({ type: 'at', name, prelude, body: block.body });
        index = block.end;
      }
    } else {
      const selectorStart = index;
      let depth = 0;
      while (index < css.length) {
        const character = css[index];
        if (character === '/' && css[index + 1] === '*') { index = skipComment(css, index); continue; }
        if (character === '"' || character === "'") { index = skipString(css, index); continue; }
        if (character === '(' || character === '[') depth++;
        else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
        else if (depth === 0 && character === '{') break;
        index++;
      }
      if (css[index] !== '{') break;
      const selector = css.slice(selectorStart, index).trim();
      const block = readBlock(css, index);
      if (selector) nodes.push({ type: 'rule', selector, body: block.body });
      index = block.end;
    }
  }
  return nodes;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let current = 0;
  while (current < value.length) {
    const character = value[current];
    if (character === '/' && value[current + 1] === '*') { current = skipComment(value, current); continue; }
    if (character === '"' || character === "'") { current = skipString(value, current); continue; }
    if (character === '(' || character === '[') depth++;
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && character === separator) {
      parts.push(value.slice(start, current));
      start = current + 1;
    }
    current++;
  }
  parts.push(value.slice(start));
  return parts;
}

function parseDeclarations(body) {
  return splitTopLevel(body, ';').flatMap(part => {
    const text = part.trim();
    if (!text) return [];
    const colon = text.indexOf(':');
    if (colon <= 0) return [];
    return [{ property: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() }];
  });
}

// ── Selector compatibility ─────────────────────────────────────────────────
// Typora writes document rules under `#write`; several class names have a
// direct equivalent in this renderer. UI selectors are kept out of the app by
// scoping every non-root rule to the writing surfaces.
function typoraSelector(selector) {
  return selector
    .replace(/#write(?![\w-])/g, ':is(#write, .write-surface)')
    .replace(/\bpre\.md-fences(?![\w-])/g, 'pre')
    .replace(/\.md-fences(?![\w-])/g, 'pre')
    .replace(/\.md-task-list-item(?![\w-])/g, '.task-list-item')
    .replace(/\bpre\.md-meta-block(?![\w-])/g, '.front-matter')
    .replace(/\.md-meta-block(?![\w-])/g, '.front-matter')
    .replace(/\.md-toc(?![\w-])/g, '.toc')
    .replace(/\.md-lang(?![\w-])/g, '.code-language')
    .replace(/\.md-image(?![\w-])/g, 'img')
    .replace(/\.md-footnote(?![\w-])/g, '.footnote-ref');
}

const isDocumentRoot = selector => /^(?:html|body)$/i.test(selector) || /^:root(?:\b|$)/i.test(selector);

function scopedSelector(selector) {
  if (selector.startsWith(':is(#write, .write-surface)') || selector.startsWith(':is(.cm-content, .prose)')) return selector;
  // `.prose` is already the document article/widget class; a Typora helper that
  // uses it must keep applying to both surfaces without a second wrapper.
  if (selector === '.prose' || selector.startsWith('.prose')) return selector;
  const replaced = selector.replace(/^(?:html|body)(?=$|[\s>+~.#[:])/i, ':is(.cm-editor, .prose)');
  if (replaced !== selector) return replaced;
  return `:is(.cm-content, .prose) ${selector}`;
}

/**
 * True when a selector actually contains an `#write` id token. Attribute
 * strings and values are skipped, so `[href="#write"]` is not a document rule.
 */
function selectorHasWrite(selector) {
  let index = 0;
  let brackets = 0;
  while (index < selector.length) {
    const character = selector[index];
    if (character === '/' && selector[index + 1] === '*') { index = skipComment(selector, index); continue; }
    if (character === '"' || character === "'") { index = skipString(selector, index); continue; }
    if (character === '[') { brackets++; index++; continue; }
    if (character === ']') { brackets = Math.max(0, brackets - 1); index++; continue; }
    if (character === '#' && brackets === 0) {
      const token = readCSSName(selector, index + 1);
      if (token.end > index + 1 && decodeCSSIdentifier(token.raw).toLowerCase() === 'write') return true;
      index = Math.max(token.end, index + 1);
      continue;
    }
    index++;
  }
  return false;
}

function nodesHaveWrite(nodes) {
  for (const node of nodes) {
    if (node.type === 'rule' && selectorHasWrite(node.selector)) return true;
    if (node.type === 'at' && GROUP_AT_RULES.has(node.name) && node.body && nodesHaveWrite(parseStyleSheet(node.body))) return true;
  }
  return false;
}

/**
 * Typora mode is recognised from the entry theme's real `#write` selector, not
 * from its file name or UI-looking class names. The whole import tree then uses
 * the same mode: old native Inkstone CSS keeps its selectors unchanged, while a
 * Typora theme gets the restricted document mapping.
 */
function detectThemeMode(css) {
  return nodesHaveWrite(parseStyleSheet(css)) ? 'typora' : 'legacy';
}

/** A live-typeset heading line is a CodeMirror line, not an <h1>. */
function headingCompanion(selectors) {
  const companions = [];
  for (const selector of selectors) {
    const match = /^(?::is\((?:#write|\.cm-content), (?:\.write-surface|\.prose)\)\s*>?\s*)?h([1-6])$/i.exec(selector);
    if (match) companions.push(`.cm-editor .cm-line.cm-heading-${match[1]}`);
  }
  return companions;
}

function typographicDeclarations(declarations) {
  return declarations
    .filter(({ property }) => TYPOGRAPHIC.has(property.toLowerCase()))
    .map(({ property, value }) => `${property}:${value}`)
    .join(';');
}

// ── Resource rewriting ─────────────────────────────────────────────────────
function cssStringValue(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return unescapeCSS(text.slice(1, -1));
  }
  return unescapeCSS(text);
}

function functionEnd(value, open) {
  let depth = 1;
  let index = open + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === '/' && value[index + 1] === '*') { index = skipComment(value, index); continue; }
    if (character === '"' || character === "'") { index = skipString(value, index); continue; }
    if (character === '\\') { index += 2; continue; }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index + 1;
    index++;
  }
  return value.length;
}

/**
 * Rewrite real `url()` tokens only. Strings and comments are skipped, so a
 * `content: "url(http…)"` literal stays text, and a data URL is returned as
 * the original token instead of being wrapped in a second `url()`.
 */
async function applyURLs(value, context) {
  let output = '';
  let last = 0;
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === '/' && value[index + 1] === '*') { index = skipComment(value, index); continue; }
    if (character === '"' || character === "'") { index = skipString(value, index); continue; }
    if (!/[A-Za-z_\\-]/.test(character)) { index++; continue; }
    const start = index;
    const token = readCSSName(value, index);
    if (token.end === start) { index++; continue; }
    index = token.end;
    const open = skipTrivia(value, index);
    if (value[open] !== '(') continue;
    const name = decodeCSSIdentifier(token.raw).toLowerCase();
    if (name !== 'url') continue;
    const end = functionEnd(value, open);
    if (token.escaped || token.commented) {
      // A safe declaration never reaches this branch, but keep the fallback
      // offline if it ever does.
      output += value.slice(last, start) + 'url("data:,")';
      last = end;
      index = end;
      continue;
    }
    const reference = cssStringValue(value.slice(open + 1, end - 1));
    let replacement;
    if (/^data:/i.test(reference) || reference.startsWith('#')) {
      // Keep the original token byte-for-byte; wrapping it again would produce
      // `url("url("data:…")")`.
      replacement = value.slice(start, end);
    } else {
      const resolved = await resourceURL(context.root, context.file, reference);
      replacement = resolved ? `url("${resolved}")` : 'url("data:,")';
    }
    output += value.slice(last, start) + replacement;
    last = end;
    index = end;
  }
  return last === 0 ? value : output + value.slice(last);
}

async function declarationsText(body, context, { rootOnly = false } = {}) {
  const declarations = [];
  for (const { property, value } of parseDeclarations(body)) {
    if (rootOnly && !property.startsWith('--')) continue;
    if (!rootOnly && DANGEROUS_DECLARATIONS.has(property.toLowerCase())) continue;
    if (!safeDeclaration(property, value)) continue;
    declarations.push(`${property}:${await applyURLs(value, context)}`);
  }
  return declarations;
}

async function rootDeclarations(body, context) {
  const declarations = [];
  const variables = [];
  for (const { property, value } of parseDeclarations(body)) {
    if (DANGEROUS_DECLARATIONS.has(property.toLowerCase())) continue;
    if (!safeDeclaration(property, value)) continue;
    const resolved = await applyURLs(value, context);
    declarations.push(`${property}:${resolved}`);
    const name = property.toLowerCase();
    if (name === 'font-family') {
      variables.push(`--font-body:${resolved}`, `--font-display:${resolved}`);
    } else if (name === 'font-size') {
      variables.push(`--editor-size:${resolved}`);
    } else if (name === 'line-height') {
      variables.push(`--editor-leading:${resolved}`);
    } else if (name === 'background' || name === 'background-color') {
      variables.push(`--inkstone-theme-paper:${resolved}`);
    } else if (name === 'color') {
      variables.push(`--inkstone-theme-ink:${resolved}`);
    }
  }
  return { declarations, variables };
}

// ── Import handling ────────────────────────────────────────────────────────
function importParts(prelude) {
  const text = prelude.trim();
  const url = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)\s*([\s\S]*)$/i.exec(text);
  if (url) return { reference: (url[1] ?? url[2] ?? url[3] ?? '').trim(), condition: (url[4] || '').trim() };
  const quoted = /^"([^"]*)"\s*([\s\S]*)$/.exec(text) || /^'([^']*)'\s*([\s\S]*)$/.exec(text);
  if (quoted) return { reference: quoted[1], condition: (quoted[2] || '').trim() };
  return null;
}

async function expandFile(file, context, depth, source = null) {
  if (depth > MAX_IMPORT_DEPTH || context.stack.has(file)) return '';
  let css;
  if (typeof source === 'string') css = source;
  else {
    try { css = await fs.readFile(file, 'utf8'); } catch { return ''; }
  }
  context.total += css.length;
  if (context.total > MAX_IMPORTED_CSS) throw new Error('主题 CSS 超过 2 MB（含 @import）。');
  const previousFile = context.file;
  context.file = file;
  context.stack.add(file);
  const output = [];
  for (const node of parseStyleSheet(css)) {
    if (node.type === 'rule') {
      output.push(await transformRule(node.selector, node.body, context));
      continue;
    }
    const { name, prelude, body } = node;
    if (name === 'charset' || name === 'namespace') continue;
    if (name === 'import') {
      const parts = importParts(prelude);
      if (!parts || !parts.reference || !safePrelude(parts.condition) || /^(?:layer|supports)\b/i.test(parts.condition)) continue;
      const imported = await localThemeFile(context.root, file, parts.reference, STYLE_EXTENSIONS);
      if (!imported) continue;
      const inner = await expandFile(imported, context, depth + 1);
      if (!inner) continue;
      const condition = parts.condition;
      output.push(condition && !/^all$/i.test(condition) ? `@media ${condition}{${inner}}` : inner);
      continue;
    }
    if (name.includes('include-when-export')) continue;
    if (!safePrelude(prelude)) continue;
    if (KEYFRAME_AT_RULES.has(name)) {
      // Keyframe bodies contain nested blocks, not declarations; reject complex
      // resource syntax and rewrite ordinary local url() references.
      if (unsafeResourceSyntax(body || '')) continue;
      const resolved = await applyURLs(body || '', context);
      if (resolved.trim()) output.push(`@${name}${prelude ? ` ${prelude}` : ''}{${resolved}}`);
      continue;
    }
    if (EMBEDDED_AT_RULES.has(name)) {
      const text = await declarationsText(body || '', context);
      if (text.length) output.push(`@${name}${prelude ? ` ${prelude}` : ''}{${text.join(';')}}`);
      continue;
    }
    if (GROUP_AT_RULES.has(name) && body) {
      const inner = [];
      for (const child of parseStyleSheet(body)) {
        if (child.type === 'rule') inner.push(await transformRule(child.selector, child.body, context));
        else if (child.name === 'font-face') {
          const text = await declarationsText(child.body || '', context);
          if (text.length) inner.push(`@font-face{${text.join(';')}}`);
        } else if (GROUP_AT_RULES.has(child.name) && child.body) {
          // Nested @media/@supports is rare but valid; recurse through the same
          // rule path so URLs and document selectors stay transformed.
          const nested = [];
          for (const grandchild of parseStyleSheet(child.body)) {
            if (grandchild.type === 'rule') nested.push(await transformRule(grandchild.selector, grandchild.body, context));
          }
          if (nested.length && safePrelude(child.prelude)) inner.push(`@${child.name}${child.prelude ? ` ${child.prelude}` : ''}{${nested.join('')}}`);
        }
      }
      if (inner.length) output.push(`@${name}${prelude ? ` ${prelude}` : ''}{${inner.join('')}}`);
    }
  }
  context.stack.delete(file);
  context.file = previousFile;
  const result = output.join('\n');
  if (result.length > MAX_THEME_CSS) throw new Error('主题展开后超过 8 MB（含内嵌资源）。');
  return result;
}

async function transformRule(selector, body, context) {
  const selectors = splitTopLevel(selector, ',').map(part => part.trim()).filter(Boolean);
  if (context.mode === 'legacy') {
    // An ordinary Inkstone CSS file keeps its original selector semantics.
    // Only the shared safety gates (selector/prelude/declaration and local
    // resources) apply; no Typora class or document-scope rewriting happens.
    const safe = selectors.filter(safeSelector);
    const declarations = await declarationsText(body, context);
    return safe.length && declarations.length ? `${safe.join(', ')}{${declarations.join(';')}}` : '';
  }
  const normal = [];
  const documentRoot = [];
  const themeRoot = [];
  for (const raw of selectors) {
    if (!safeSelector(raw)) continue;
    const mapped = typoraSelector(raw);
    if (!mapped) continue;
    if (isDocumentRoot(mapped)) {
      const customOnly = /^:root\b/i.test(mapped);
      (customOnly ? themeRoot : documentRoot).push(customOnly ? ':root' : 'html-or-body');
    } else {
      normal.push(scopedSelector(mapped));
    }
  }
  const output = [];
  const declarations = await declarationsText(body, context);
  if (normal.length && declarations.length) {
    output.push(`${normal.join(', ')}{${declarations.join(';')}}`);
    const companions = headingCompanion(normal);
    const typography = typographicDeclarations(parseDeclarations(body));
    if (companions.length && typography) output.push(`${companions.join(', ')}{${typography}}`);
  }
  if (documentRoot.length) {
    const root = await rootDeclarations(body, context);
    if (root.declarations.length) output.push(`:is(.cm-editor, .prose){${root.declarations.join(';')}}`);
    // Typography variables belong to the writing surfaces; paper/ink variables
    // are read by the standalone export builders from the document root.
    const contentVariables = root.variables.filter(variable => /^--(?:font-body|font-display|editor-size|editor-leading):/.test(variable));
    const pageVariables = root.variables.filter(variable => !/^--(?:font-body|font-display|editor-size|editor-leading):/.test(variable));
    if (contentVariables.length) output.push(`:is(.cm-editor, .prose){${contentVariables.join(';')}}`);
    if (pageVariables.length) output.push(`:root{${pageVariables.join(';')}}`);
  }
  if (themeRoot.length) {
    const custom = await declarationsText(body, context, { rootOnly: true });
    if (custom.length) output.push(`:root{${custom.join(';')}}`);
  }
  return output.join('\n');
}

/**
 * Read one theme from <themesDirectory>, inline its local imports, embed local
 * fonts/images and neutralise every reference that could leave the directory.
 */
async function readThemeCSS(name, themesDirectory) {
  if (!safeThemeName(name)) throw new Error('主题文件名无效。');
  const realRoot = await fs.realpath(themesDirectory);
  const realFile = await localThemeFile(realRoot, realRoot, name, STYLE_EXTENSIONS, true);
  if (!realFile) throw new Error('主题文件不存在或不在主题目录内。');
  let entry;
  try { entry = await fs.readFile(realFile, 'utf8'); } catch { throw new Error('主题文件不存在或无法读取。'); }
  const context = { root: realRoot, file: realFile, stack: new Set(), total: 0, mode: detectThemeMode(entry) };
  return expandFile(realFile, context, 0, entry);
}

module.exports = {
  MAX_THEME_CSS,
  MAX_IMPORTED_CSS,
  MAX_RESOURCE,
  MAX_IMPORT_DEPTH,
  RESOURCE_MIME,
  safeThemeName,
  localThemeFile,
  parseStyleSheet,
  readThemeCSS
};
