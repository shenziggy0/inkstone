import { createMarkdownParser } from '../electron/markdown-parser.mjs';
import { highlightCode } from './highlight.js';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { readColumnWidths, injectColumnWidths } from './table.js';
import { prepareMath, prepareStandaloneMath } from './math-labels.js';
import { NATIVE_DIAGRAM_KINDS, renderNativeDiagram } from './diagrams.js';
import { installSelectionPositions, selectMarkdownTokens } from './selection-image.js';
import {
  imageRootKey,
  frontMatterImageRoot,
  setFrontMatterImageRoot,
  replaceFrontMatterImageRoot
} from '../electron/front-matter.mjs';

export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Every attribute the renderer delegates application behaviour through. A
 * document may contain raw HTML, so without this list `data-command` inside a
 * paragraph would run real commands (`toggle-ui`, `save-as`, `trash`). The
 * rendered document keeps only `data-line`, which is used for source navigation
 * by the outline and [TOC] and can never do more than move the caret.
 */
export const RESERVED_ATTRIBUTES = [
  'data-command', 'data-menu-command', 'data-quick-command', 'data-quick-path',
  'data-path', 'data-table-op', 'data-index', 'data-cell', 'data-align',
  'data-copy-code', 'data-image-action', 'data-external-action', 'data-dismiss',
  'data-history', 'data-history-dir', 'data-history-name', 'data-export',
  'data-side', 'data-close', 'data-document', 'data-section', 'data-emoji',
  // App chrome markers and attributes the renderer/editor writes itself: a
  // document must not be able to hide itself from exports or redirect the
  // image and table plumbing.
  'data-md-skip', 'data-md-src', 'data-from', 'data-to', 'data-inkstone-index'
];

/**
 * DOMPurify's default URI allow-list reads `C:/…` as an unknown scheme and
 * rejects `file:` destinations, which would silently drop the src of a local
 * image. This extends that list by exactly those two shapes; javascript:,
 * vbscript: and the tag-scoped data: rules keep their default behaviour.
 * A surviving `file:` link is inert: opening one goes through the main process
 * `openExternal` allow-list (https / http / mailto only).
 */
export const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|file):|[a-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/**
 * The one sanitizer configuration used for rendered documents. DOMPurify checks
 * FORBID_ATTR before ALLOW_DATA_ATTR, so listing the delegated attributes there
 * is enough; a second, hand-written pass over the HTML string would only add
 * risk on edge inputs (unclosed quotes, `<` inside values, comments). Attribute
 * names are lower-cased before the lookup, and the HTML/SVG/MathML profiles all
 * go through the same check — the desktop test asserts this on the live DOM.
 */
export const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  ADD_ATTR: ['data-line'],
  FORBID_TAGS: ['iframe', 'object', 'embed', 'style', 'form'],
  FORBID_ATTR: ['srcdoc', ...RESERVED_ATTRIBUTES],
  ALLOW_DATA_ATTR: true,
  ALLOWED_URI_REGEXP: ALLOWED_URI
};

/**
 * True when an image reference points at another machine: UNC / device paths
 * (`\\host\share`, `//host/share`, `\\?\UNC\…`, `\\.\…`) or a `file://` URL whose
 * host is neither empty nor localhost. `file:///\\server\share` has an empty
 * host after WHATWG parsing (backslashes become slashes) but its pathname still
 * starts with `//`; that is the same UNC location. Keep this in step with
 * `isNetworkFileURL` in electron/assets.cjs. The main process refuses these
 * before it touches the filesystem; the renderer drops them too, so no asset
 * URL is ever built for them.
 */
export function isNetworkReference(src) {
  const text = decodeAssetReference(src);
  if (/^[\\/]{2}/.test(text)) return true;
  if (!/^file:/i.test(text)) return false;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    return (host !== '' && host !== 'localhost') || /^[\\/]{2}/.test(url.pathname);
  } catch { return true; }
}

/**
 * The reference an author typed, recovered from markdown-it's percent-encoding.
 * A malformed escape keeps the value as-is instead of dropping the image.
 */
export function decodeAssetReference(src) {
  const text = String(src ?? '');
  try { return decodeURI(text); } catch { return text; }
}

/**
 * The `inkstone-asset:` URL of one image. The whole reference is encoded as a
 * single opaque path segment because WHATWG URL parsing collapses `..`
 * segments, which would silently drop the `../` in `../shared/a.png`. Keep the
 * round trip in sync with electron/assets.cjs (asserted in test/assets.test.js).
 *
 * A root-relative reference (`/images/a.png`) also carries the document's
 * image root as a query value. The main process still validates the root, but
 * the URL has to change when the author edits `typora-root-url`, or Chromium
 * would keep serving the previously decoded picture from its cache. Relative
 * references keep the exact same URL as before: a root cannot affect them.
 */
export function assetURL(documentId, src, imageRoot = null) {
  const reference = decodeAssetReference(src);
  const base = `inkstone-asset://${documentId}/${encodeURIComponent(reference)}`;
  if (!/^\/(?!\/)/.test(reference)) return base;
  // A root-relative URL always states its root, including «no root» as an
  // empty value. The renderer can be ahead of the 500 ms document flush; an
  // omitted value would let the main process fall back to the previous front
  // matter and briefly (or, for a new URL, permanently) use the wrong folder.
  return `${base}?root=${encodeURIComponent(imageRoot ?? '')}`;
}

// ── typora-root-url ────────────────────────────────────────────────────────
// Typora resolves `/images/a.png` against the folder named by the front matter
// key `typora-root-url`. The renderer reads that one scalar to build the asset
// URL hint and to write the line from the «设置图片根目录» entry. The parser and
// the line edit live in electron/front-matter.mjs, which the main process shares
// (it needs the same key position for Save As relocation); the main process is
// still the only side that reads image files.
export { frontMatterImageRoot, setFrontMatterImageRoot, replaceFrontMatterImageRoot, imageRootKey };

// Optional app-wide fallback, set from the preferences. The document's own
// `typora-root-url` always wins; an empty document value means «not set».
let imageRootDefault = '';

export function setImageRootSetting(value) {
  const next = typeof value === 'string' ? value.trim() : '';
  if (next === imageRootDefault) return false;
  imageRootDefault = next;
  return true;
}

/** The root an image reference of `source` resolves against, if any. */
export function effectiveImageRoot(source) {
  return frontMatterImageRoot(source) ?? (imageRootDefault || null);
}

export const parser = createMarkdownParser({
  highlight(code, language) {
    // Typora's `sequence` and `flow` fences use their own grammars. They must
    // never reach Mermaid (or highlight.js), so they are recognised here and
    // rendered by the local, offline renderer in diagrams.js.
    const native = NATIVE_DIAGRAM_KINDS.has(String(language || '').toLowerCase()) ? String(language).toLowerCase() : '';
    if (native) return `<pre class="diagram" data-diagram="${native}">${escapeHTML(code)}</pre>`;
    if (language === 'mermaid') return `<pre class="mermaid">${escapeHTML(code)}</pre>`;
    // A language that is not registered yet lands on the escaped fallback; the
    // loader reports back through onLanguageLoaded() so only the blocks that
    // use it are re-rendered. The output is byte-identical to the previous
    // whole-package `hljs.highlight()` call for every registered language.
    const highlighted = highlightCode(code, language);
    const content = highlighted.html ?? escapeHTML(code);
    return `<pre class="code-block"><span class="code-language">${escapeHTML(language || 'text')}</span><code class="hljs">${content}</code></pre>`;
  }
});

installSelectionPositions(parser);


// The app-wide "公式自动编号" preference. Pure helpers accept an explicit
// `mathNumbering` option; the editor and export use this fallback so both paths
// render the same document with the same numbering. The value is per renderer
// process, never per document, and no label registry is stored here.
let mathNumberingDefault = false;

export function mathNumberingEnabled() {
  return mathNumberingDefault;
}

/** Change the preference and return true when it actually changed. */
export function setMathNumbering(enabled) {
  const next = !!enabled;
  if (next === mathNumberingDefault) return false;
  mathNumberingDefault = next;
  resetRenderCache();
  return true;
}

const numberingFor = options => options?.mathNumbering === undefined ? mathNumberingDefault : !!options.mathNumbering;

// Labels and references are resolved after inline parsing, when every math
// token of the document is known. This is the same shared parse that feeds
// footnotes, reference links, heading anchors and [TOC].
parser.core.ruler.after('inline', 'math_labels', state => {
  state.env.math = prepareMath(state.tokens, { numbering: state.env.mathNumbering === true });
});

// texmath installs its own renderer rules. They are replaced by the same
// templates, but with the prepared token content: labels removed, automatic
// numbers injected and `\ref` resolved before KaTeX sees the TeX. KaTeX's
// trust stays off and no user macro is enabled.
function renderTeX(token, displayMode) {
  const content = token.math?.content ?? token.content;
  try {
    return katex.renderToString(content, { displayMode, throwOnError: false, trust: false });
  } catch (error) {
    return escapeHTML(`${content}:${error.message}`);
  }
}

function mathAttributes(token) {
  const math = token.math;
  const attributes = [];
  if (math?.anchor) attributes.push(`id="${escapeHTML(math.anchor)}"`);
  if (math?.number !== null && math?.number !== undefined && math.number !== '') {
    attributes.push(`data-math-number="${escapeHTML(String(math.number))}"`);
  }
  if (math?.duplicates?.length) {
    attributes.push(`data-math-duplicate-label="${escapeHTML(math.duplicates.join(','))}"`);
  }
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

const mathBlockRule = (tokens, index) =>
  `<section${mathAttributes(tokens[index])}><eqn>${renderTeX(tokens[index], true)}</eqn></section>`;
parser.renderer.rules.math_block = mathBlockRule;
parser.renderer.rules.math_inline_double = mathBlockRule;
parser.renderer.rules.math_block_eqno = (tokens, index) =>
  `<section class="eqno"${mathAttributes(tokens[index])}><eqn>${renderTeX(tokens[index], true)}</eqn><span>(${escapeHTML(tokens[index].info || '')})</span></section>`;
parser.renderer.rules.math_inline = (tokens, index) =>
  `<eq>${renderTeX(tokens[index], false)}</eq>`;

parser.renderer.rules.front_matter = (tokens, index, _options, env) => {
  // The card is editor chrome. Skip it at generation time instead of relying
  // on data-md-skip surviving sanitisation; a document-authored element with
  // the same class is not touched by this rule.
  if (env?.chrome === false) return '';
  const raw = tokens[index].content.replace(/^---[^\n]*\r?\n/, '').replace(/\r?\n(?:---|\.\.\.)\s*$/, '');
  const rows = raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon).trim() : '';
    const value = colon > 0 ? line.slice(colon + 1).trim() : line.trim();
    return `<div class="front-matter-row"><span class="front-matter-key">${escapeHTML(key)}</span><span class="front-matter-value">${escapeHTML(value)}</span></div>`;
  }).join('');
  return `<section class="front-matter" data-md-skip><div class="front-matter-label">文档属性</div>${rows}</section>`;
};

// ── GitHub style alerts ────────────────────────────────────────────────────
const ALERTS = { NOTE: '提示', TIP: '技巧', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' };
const defaultBlockquote = parser.renderer.rules.blockquote_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
parser.renderer.rules.blockquote_open = (tokens, index, options, env, self) => {
  // A blockquote wraps a paragraph, so the inline token is a few slots later.
  const inline = tokens.slice(index + 1, index + 6).find(token => token.type === 'inline');
  const match = inline?.content?.match(alertMarker);
  if (!match) return defaultBlockquote(tokens, index, options, env, self);
  const kind = match[1].toUpperCase();
  tokens[index].attrJoin('class', `alert alert-${kind.toLowerCase()}`);
  const first = inline.children?.[0];
  if (first?.type === 'text') first.content = first.content.replace(alertMarker, '');
  if (first?.content === '' && inline.children?.[1]?.type === 'softbreak') inline.children.splice(0, 2);
  inline.content = inline.content.replace(alertMarker, '');
  const quote = defaultBlockquote(tokens, index, options, env, self);
  // The label is editor chrome; the alert blockquote and its body are content.
  if (env?.chrome === false) return quote;
  return `${quote}<div class="alert-label" data-md-skip>${ALERTS[kind]}</div>`;
};

const slugify = title => title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
function headingIds(firstRepeat) {
  const nextSuffix = new Map();
  const used = new Set();
  function allocate(slug) {
    let id = slug;
    if (used.has(id)) {
      let suffix = nextSuffix.get(slug) ?? firstRepeat;
      do { id = `${slug}-${suffix++}`; } while (used.has(id));
      nextSuffix.set(slug, suffix);
    }
    used.add(id);
    return id;
  }
  return { used, allocate };
}

// A later literal heading can own an old fragment. Resolve every canonical
// ID before assigning aliases, including headings nested inside containers.
parser.core.ruler.push('inkstone_heading_ids', ({ tokens }) => {
  const canonical = headingIds(2);
  const legacy = headingIds(1);
  const aliases = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const slug = slugify(tokens[index + 1]?.content || '') || 'heading';
    const id = canonical.allocate(slug);
    const oldId = legacy.allocate(slug);
    token.attrSet('id', id);
    if (oldId !== id) aliases.push([token, oldId]);
  }
  for (const [token, oldId] of aliases) {
    if (!canonical.used.has(oldId)) {
      token.meta ??= {};
      token.meta.legacyId = oldId;
    }
  }
});

parser.renderer.rules.heading_close = (tokens, index, options, env, self) => {
  const alias = tokens[index - 2]?.meta?.legacyId;
  const close = self.renderToken(tokens, index, options);
  return alias ? `<a name="${escapeHTML(alias)}"></a>${close}` : close;
};

/**
 * Outline entries share the IDs assigned to the rendered heading tokens.
 */
export function headingsFromTokens(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open' || !token.map) continue;
    const title = tokens[i + 1]?.content || '';
    const item = { title, level: Number(token.tag.slice(1)), line: token.map[0] + 1, id: token.attrGet('id') };
    if (token.meta?.legacyId) item.legacyId = token.meta.legacyId;
    result.push(item);
  }
  return result;
}

/** The text markdown-it parses: no BOM, LF line breaks. */
function normalized(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

// The document render already walked every token, so its outline is kept for
// the callers that ask for it right afterwards (sidebar, breadcrumb, [TOC]).
let outlineCache = { key: null, items: [] };

export function draftTitleFromSource(source) {
  const tokens = parser.parse(normalized(source), {});
  const heading = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1');
  const candidates = heading === -1 ? tokens : [tokens[heading + 1], ...tokens];
  for (const token of candidates) {
    if (token?.type !== 'inline') continue;
    let line = '';
    for (const child of token.children || []) {
      if (['softbreak', 'hardbreak'].includes(child.type)) {
        if (line.trim()) return line.trim();
        line = '';
      } else if (['text', 'text_special', 'code_inline', 'emoji'].includes(child.type)) {
        line += child.content;
      }
    }
    if (line.trim()) return line.trim();
  }
  return '';
}

export function headings(source) {
  const key = normalized(source);
  if (outlineCache.key !== key) outlineCache = { key, items: headingsFromTokens(parser.parse(key, {})) };
  return outlineCache.items;
}

export const tocItemsFromHeadings = items => items.map(h => `<li style="margin-left:${(h.level - 1) * 12}px"><a href="#${escapeHTML(h.id)}" data-line="${h.line}">${escapeHTML(h.title)}</a></li>`).join('');

function footnoteTitles(source, env) {
  const definitions = new Map();
  for (const match of source.matchAll(/^\[\^([^\]]+)\]:[ \t]*(.+)$/gm)) definitions.set(match[1], match[2].trim());
  return (env.footnotes?.list || []).map(note => definitions.get(note.label) || '');
}

/**
 * Serialise-ready HTML for the Markdown body. `options.chrome` is false for the
 * export / clipboard payloads, which must not carry the copy buttons and other
 * UI the application itself adds to the editor.
 */
function finalizeHTML(html, documentId, toc, footnotes = [], options = {}) {
  const chrome = options.chrome !== false;
  const imageRoot = options.imageRoot ?? null;
  const withToc = html.replace(/<p>\[toc\]<\/p>/gi, `<nav class="toc" aria-label="文内目录"><ul>${toc}</ul></nav>`);
  const clean = DOMPurify.sanitize(withToc, { ...SANITIZE_CONFIG });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const img of template.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    // Remote and embedded images already name their own bytes; http: is kept
    // for Typora parity (the CSP allows it) and the export keeps the URL.
    if (/^(https?:|data:|blob:)/i.test(src)) { img.loading = 'lazy'; continue; }
    if (!src) { img.removeAttribute('src'); continue; }
    // data-md-src keeps the Markdown spelling for the copy-image actions and
    // the source map; the rendered src is the decoded reference re-encoded for
    // the asset protocol, so `![](assets/图片.png)` reaches a real file again.
    img.dataset.mdSrc = src;
    // A reference to another machine would make the asset protocol contact it;
    // no URL is generated for these (the main process rejects them as well).
    if (documentId && !isNetworkReference(src)) img.src = assetURL(documentId, src, imageRoot);
    else img.removeAttribute('src');
    img.loading = 'lazy';
  }
  for (const link of template.content.querySelectorAll('a')) link.rel = 'noopener noreferrer';
  // Typora exposes footnote content on hover. A native title keeps that
  // behavior available without adding a focus-trapping popover, and remains
  // useful to keyboard users through the normal footnote link.
  for (const ref of template.content.querySelectorAll('sup.footnote-ref a[href^="#fn"]')) {
    const id = ref.getAttribute('href')?.slice(1);
    const note = id && template.content.getElementById(id);
    const index = /^fn(\d+)$/.exec(id || '');
    const text = note?.textContent?.replace(/↩+\s*$/, '').trim() || (index ? footnotes[Number(index[1]) - 1] : '');
    if (text) ref.setAttribute('title', text);
  }
  for (const checkbox of template.content.querySelectorAll('input')) checkbox.setAttribute('aria-label', '切换任务完成状态');
  // markdown-it-task-lists only recognises `[ ] ` when text follows the box.
  // A bare `- [ ]` line otherwise renders as literal `[ ]`, contradicting the
  // checkbox the live preview already shows while that line is being typed.
  // Normalise empty task items so the rendered and active block agree.
  for (const item of template.content.querySelectorAll('li')) {
    if (item.querySelector('input, pre, table, ul, ol, blockquote, img')) continue;
    const match = /^\[([ xX])\]$/.exec((item.textContent || '').trim());
    if (!match) continue;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'task-list-item-checkbox';
    input.setAttribute('aria-label', '切换任务完成状态');
    if (match[1] !== ' ') input.checked = true;
    item.classList.add('task-list-item', 'enabled');
    item.parentElement?.classList.add('contains-task-list');
    item.replaceChildren(input);
  }
  // Editor-only chrome: decorations the renderer adds on top of the document
  // (front-matter card, alert labels, copy buttons) never belong in an export
  // or in the clipboard payload.
  if (!chrome) {
    for (const node of template.content.querySelectorAll('[data-md-skip], .code-copy')) node.remove();
  } else {
    // A copy affordance on every fenced code block. Inserted after sanitising,
    // and only after the document's own data-copy-code attributes were stripped
    // above, so the button cannot be forged by the document.
    for (const pre of template.content.querySelectorAll('pre.code-block')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.dataset.copyCode = '';
      button.dataset.mdSkip = '';
      button.setAttribute('aria-label', '复制代码');
      button.textContent = '复制';
      pre.prepend(button);
    }
  }
  return template.innerHTML;
}

export function renderMarkdown(source, documentId, options = {}) {
  const text = normalized(source);
  const env = { mathNumbering: numberingFor(options), chrome: options.chrome !== false };
  const tokens = parser.parse(text, env);
  const items = headingsFromTokens(tokens);
  outlineCache = { key: text, items };
  const html = parser.renderer.render(tokens, parser.options, env);
  const imageRoot = options.imageRoot !== undefined ? options.imageRoot : effectiveImageRoot(text);
  return injectColumnWidths(finalizeHTML(html, documentId, tocItemsFromHeadings(items), footnoteTitles(text, env), { ...options, imageRoot }), readColumnWidths(text));
}

/** Resolve an editor selection in LF UTF-16 coordinates, including a BOM if present. */
export function prepareSelectedMarkdown(source, { from, to } = {}, options = {}) {
  const raw = String(source ?? '');
  const bom = raw.startsWith('\uFEFF') ? 1 : 0;
  const text = normalized(raw);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length + bom || from >= to || to <= bom) return null;
  const env = {
    chrome: false,
    mathNumbering: numberingFor(options),
    selectionSpans: new WeakMap(),
    selectionSources: new WeakMap()
  };
  const full = parser.parse(text, env);
  const tokens = selectMarkdownTokens(parser, full, env, text, Math.max(0, from - bom), to - bom, info => {
    const language = info.trim().split(/\s+/, 1)[0];
    return language === 'mermaid' || NATIVE_DIAGRAM_KINDS.has(language.toLowerCase());
  });
  const selected = new Set(tokens);
  const widths = readColumnWidths(text);
  return {
    tokens,
    env,
    toc: tocItemsFromHeadings(headingsFromTokens(tokens)),
    footnotes: footnoteTitles(text, env),
    imageRoot: options.imageRoot !== undefined ? options.imageRoot : effectiveImageRoot(text),
    widths: full.filter(token => token.type === 'table_open').flatMap((token, index) => selected.has(token) ? [widths[index] || []] : [])
  };
}

/** Selected document content for PNG capture, using the document's export styling. */
export function renderSelectedMarkdown(source, documentId, range, options = {}) {
  const plan = prepareSelectedMarkdown(source, range, options);
  if (!plan?.tokens.length) return '';
  const html = parser.renderer.render(plan.tokens, parser.options, plan.env);
  return injectColumnWidths(finalizeHTML(html, documentId, plan.toc, plan.footnotes, {
    chrome: false, imageRoot: plan.imageRoot
  }), plan.widths);
}

/**
 * Exact source range of every GFM table in one LF document, in render order.
 *
 * `parseTables` models a table from its syntax alone; the block boundaries are
 * decided by this renderer. A heading such as `# H | Q` on the line directly
 * after a table contains a pipe but starts a new block, so table editing has to
 * use the map markdown-it actually rendered instead of scanning for more rows.
 * `source` must already be in the editor's LF coordinates (the caller's text).
 */
export function tableSourceRanges(source) {
  const raw = String(source ?? '');
  // The renderer parses the document without its BOM, but the ranges are handed
  // back in the caller's coordinates: without this shift every table in a
  // BOM-prefixed file would be reported one character too short and a reorder
  // would leave the last row's "|" behind.
  const shift = raw.startsWith('\uFEFF') ? 1 : 0;
  const text = normalized(raw);
  // Line starts are only needed for the tables, but the whole table is one
  // index over them; documents are already indexed per keystroke elsewhere.
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const ranges = [];
  // The BOM is line 0's first character, so line 0 still starts at offset 0;
  // every later offset moves by one.
  const toSource = position => (position > 0 ? position + shift : 0);
  for (const token of parser.parse(text, {})) {
    if (token.type !== 'table_open' || !token.map) continue;
    const [first, after] = token.map;
    // The range covers the table's own lines and stops before their line
    // breaks, so a caller replacing it cannot damage a following block.
    let end = starts[after] ?? text.length;
    if (end > 0 && text[end - 1] === '\n') end--;
    if (end > 0 && text[end - 1] === '\r') end--;
    ranges.push({ start: toSource(starts[first] ?? text.length), end: toSource(end) });
  }
  return ranges;
}

/**
 * Top-level blocks (one entry per `token.map` range) of one parse. Keeping the
 * tokens of each block lets it be rendered on its own while still seeing the
 * document-wide `env`.
 */
export function groupTokens(tokens) {
  const groups = [];
  let current = null;
  for (const token of tokens) {
    if (token.level === 0 && token.map && token.nesting !== -1) {
      if (current) groups.push(current);
      current = { start: token.map[0], end: token.map[1], tokens: [token] };
    } else if (current) current.tokens.push(token);
  }
  if (current) groups.push(current);
  return groups;
}

/**
 * Everything that reaches a block's HTML from outside the block's own source:
 * footnote numbering and bodies, reference-link definitions, stored column
 * widths and the document id used for asset URLs. When this string is
 * unchanged, a block that did not change renders to identical HTML.
 *
 * The cache key for each block includes its assigned heading IDs. The [TOC]
 * cache key also includes the full outline, keeping unrelated blocks reusable.
 */
export function globalSignature({ tokens = [], env = {}, documentId = '', widths = [], imageRoot = null } = {}) {
  const references = env.references || {};
  const notes = env.footnotes?.list || [];
  const bodies = [];
  // Footnote definitions are pulled out of the block stream and glued on after
  // the last block, so they belong to no block's own source.
  let inFootnotes = false;
  for (const token of tokens) {
    if (token.type === 'footnote_block_open') inFootnotes = true;
    if (inFootnotes) bodies.push(token.type, token.content || '');
    if (token.type === 'footnote_block_close') inFootnotes = false;
  }
  return [
    `doc\u0000${documentId}`,
    `image-root\u0000${imageRoot ?? ''}`,
    `widths\u0000${widths.map(group => group.join(',')).join(';')}`,
    `references\u0000${Object.keys(references).map(key => `${key}\u0002${references[key].href || ''}\u0002${references[key].title || ''}`).join('\u0001')}`,
    `notes\u0000${notes.map(note => note.label ?? `inline:${note.content ?? ''}`).join('\u0001')}`,
    `bodies\u0000${bodies.join('\u0001')}`,
    `math\u0000${env.math?.signature || ''}`,
    `chrome\u0000${env.chrome === false ? '0' : '1'}`
  ].join('\u0003');
}

// Rendered block HTML is remembered per document-wide signature, so typing in
// one paragraph only re-renders that paragraph. Each signature keeps the last
// two document versions: the one being rendered and the one before it, which is
// exactly enough to reuse every block an edit did not touch without holding on
// to every intermediate version of every block.
const SIGNATURE_LIMIT = 8;
const htmlCache = new Map();

function cacheFor(signature) {
  let record = htmlCache.get(signature);
  if (record) {
    // Refresh the recency order so the document being edited is evicted last.
    htmlCache.delete(signature);
    htmlCache.set(signature, record);
  } else {
    record = { previous: new Map(), current: new Map() };
    htmlCache.set(signature, record);
    while (htmlCache.size > SIGNATURE_LIMIT) htmlCache.delete(htmlCache.keys().next().value);
  }
  record.previous = record.current;
  record.current = new Map();
  return record;
}

/** Drop every cached render. The render-cache tests use it to start clean. */
export function resetRenderCache() {
  htmlCache.clear();
  outlineCache = { key: null, items: [] };
}

/**
 * Forget the cached HTML of every block that fences one of `languages`.
 * A lazily loaded grammar changes only those blocks, so an on-demand language
 * load re-renders just its own code fences instead of the whole document.
 */
export function invalidateFenceLanguages(languages) {
  const names = new Set([...languages].map(name => String(name).toLowerCase()));
  if (!names.size) return 0;
  const uses = key => {
    for (const match of String(key).matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/gm)) if (names.has(match[1].toLowerCase())) return true;
    return false;
  };
  let dropped = 0;
  for (const record of htmlCache.values()) {
    for (const map of [record.current, record.previous]) {
      for (const key of [...map.keys()]) if (uses(key)) { map.delete(key); dropped++; }
    }
  }
  return dropped;
}

/**
 * Render each block once per (signature, block source, block context) triple.
 * `render` is only called for a block whose HTML is not cached yet; the stats
 * expose which path was taken so it can be asserted without a DOM.
 */
export function renderGroups(groups, signature, render) {
  const cache = cacheFor(signature);
  const seen = new Map();
  let rendered = 0, reused = 0;
  const entries = groups.map(group => {
    const source = group.source ?? '';
    // Two blocks can share the exact same source yet render differently: a
    // duplicate heading gets a numbered anchor and a repeated footnote
    // reference gets the next id. Both are covered by the occurrence index and
    // the block context; blocks that need neither are keyed by their source
    // alone, so the common case allocates nothing.
    const occurrence = seen.get(source) || 0;
    seen.set(source, occurrence + 1);
    const key = occurrence || group.context ? `${occurrence}\u0000${group.context || ''}\u0000${source}` : source;
    let entry = cache.previous.get(key);
    if (entry) reused++;
    else { entry = render(group); rendered++; }
    cache.current.set(key, entry);
    return entry;
  });
  return { entries, stats: { rendered, reused } };
}

/**
 * Render every top-level block against ONE parse of the whole document.
 * A shared `env` is what makes cross-block features work: reference-link
 * definitions, footnotes, duplicate heading slugs and [TOC] all need the
 * rest of the document, which a per-block parse cannot see.
 * Returns [{ start (0-based line), end, html }] keyed to editor block maps.
 */
export function renderDocument(source, documentId, options = {}) {
  const plan = prepareDocument(source, documentId, options);
  // One parse feeds the block HTML, the outline and [TOC].
  outlineCache = { key: plan.text, items: plan.items };
  const { entries, stats } = renderGroups(plan.groups, plan.signature, group => {
    const html = finalizeHTML(parser.renderer.render(group.tokens, parser.options, plan.env), documentId, plan.toc, plan.footnotes, { imageRoot: plan.imageRoot, chrome: plan.chrome });
    return { html, tables: (html.match(/<table\b/g) || []).length };
  });
  let tableOffset = 0;
  const blocks = plan.groups.map((group, index) => {
    const entry = entries[index];
    const html = injectColumnWidths(entry.html, plan.widths, tableOffset);
    tableOffset += entry.tables;
    return { start: group.start, end: group.end, html };
  });
  const footnoteStart = plan.tokens.findIndex(token => token.type === 'footnote_block_open');
  const footnoteHtml = footnoteStart >= 0
    ? finalizeHTML(parser.renderer.render(plan.tokens.slice(footnoteStart), parser.options, plan.env), documentId, plan.toc, plan.footnotes, { imageRoot: plan.imageRoot, chrome: plan.chrome })
    : '';
  // Returning the tokens lets the editor reuse this single parse for its
  // decoration ranges instead of parsing the whole file on every caret move.
  return { tokens: plan.tokens, blocks, stats, math: plan.math, imageRoot: plan.imageRoot, footnoteHtml };
}

/**
 * Parse and plan one document version: the token stream, the block groups with
 * their own source and heading context, the outline, and the document-wide
 * signature that decides whether a block may be reused. No DOM is touched, so
 * the caching behaviour can be asserted directly in unit tests.
 */
export function prepareDocument(source, documentId, options = {}) {
  const text = normalized(source);
  const env = { mathNumbering: numberingFor(options), chrome: options.chrome !== false };
  const tokens = parser.parse(text, env);
  const items = headingsFromTokens(tokens);
  const widths = readColumnWidths(text);
  const groups = groupTokens(tokens);
  // `/images/a.png` depends on this value, so it belongs to the document-wide
  // signature: editing the front matter must not reuse an image block that was
  // rendered against the previous root.
  const imageRoot = options.imageRoot !== undefined ? options.imageRoot : effectiveImageRoot(text);
  // Block sources are slices of the normalised text. Building one line table
  // avoids allocating a split copy of the whole document and joining every
  // block back together on a file that is re-planned on each keystroke.
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  // A block may contain both headings and a TOC, for example inside a quote.
  let tocContext = null;
  for (const group of groups) {
    group.source = text.slice(
      lineStarts[group.start] ?? text.length,
      group.end < lineStarts.length ? lineStarts[group.end] - 1 : text.length
    );
    const anchors = [];
    for (const token of group.tokens) {
      if (token.type === 'heading_open') {
        const id = token.attrGet('id');
        anchors.push(token.meta?.legacyId ? `${id}\u0002${token.meta.legacyId}` : id);
      }
    }
    group.context = anchors.length ? `a\u0000${anchors.join('\u0001')}` : '';
    if (/\[toc\]/i.test(group.source)) {
      tocContext ??= items.map(item => `${item.id}\u0002${item.title}\u0002${item.line}`).join('\u0001');
      if (group.context) group.context += '\u0000';
      group.context += `toc\u0000${tocContext}`;
    }
  }
  return {
    text, env, tokens, items, groups, widths,
    chrome: env.chrome,
    toc: tocItemsFromHeadings(items),
    footnotes: footnoteTitles(text, env),
    math: env.math,
    imageRoot,
    signature: globalSignature({ tokens, env, documentId, widths, imageRoot })
  };
}

/** Backwards-compatible helper for callers that only need the HTML blocks. */
export function renderBlocks(source, documentId, options = {}) {
  return renderDocument(source, documentId, options).blocks;
}

/**
 * Render one display formula with the same engine and options the document
 * uses, for the live preview under a `$$…$$` block being edited. A syntax error
 * comes back as a short Chinese message instead of throwing, so the preview can
 * say what is wrong instead of staying blank.
 *
 * `options.labels` is the document's label registry for live references and
 * `options.number` is the number the document assigned to this formula. The
 * editor normally passes content that was already prepared by prepareMath(),
 * so no document context is needed there.
 */
export function renderMath(source, options = {}) {
  const text = String(source ?? '').trim();
  if (!text) return { html: '', error: '公式为空。' };
  const prepared = prepareStandaloneMath(text, options);
  try {
    return { html: katex.renderToString(prepared.content, { displayMode: true, throwOnError: true, trust: false, strict: false }), error: null };
  } catch (error) {
    const message = String(error?.message || error).replace(/^KaTeX parse error:\s*/i, '');
    return { html: '', error: `公式语法错误：${message}` };
  }
}

let mermaidModule;
let renderQueue = Promise.resolve();

/**
 * Which renderer owns one diagram fence: `'mermaid'`, a native kind, or null
 * for an ordinary `<pre>`. Document HTML can spell `class="diagram"` itself,
 * so a plain `pre.diagram` (or one with an unsupported `data-diagram`) is not
 * a diagram at all and must never fall through to the Mermaid renderer.
 */
export function diagramKindFor(element) {
  const kind = element?.dataset?.diagram || '';
  if (NATIVE_DIAGRAM_KINDS.has(kind) && element?.classList?.contains('diagram')) return kind;
  if (element?.classList?.contains('mermaid')) return 'mermaid';
  return null;
}

// Only the existing Mermaid entry and the two native kinds are selected. A
// document-authored pre.diagram cannot opt itself into either renderer.
const diagramSelector = ['pre.mermaid', ...[...NATIVE_DIAGRAM_KINDS].map(kind => `pre.diagram[data-diagram="${kind}"]`)].join(', ');
const diagramThemes = new WeakMap();
let diagramTheme;

/** Paint colours the diagrams inherit from the active theme. */
function diagramPalette() {
  if (typeof document === 'undefined') return undefined;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body?.append(probe);
  const read = (name, fallback) => {
    probe.style.color = `var(${name})`;
    const value = getComputedStyle(probe).color;
    return value && value !== 'rgba(0, 0, 0, 0)' ? value : fallback;
  };
  const palette = {
    ink: read('--color-ink', '#333333'),
    muted: read('--color-muted', '#777777'),
    rule: read('--color-rule', '#c8c8c8'),
    paper: read('--color-paper', '#ffffff'),
    soft: read('--color-code', '#f6f8fa')
  };
  probe.remove();
  return palette;
}

/**
 * Replace a diagram with the same readable error block Mermaid uses, keeping
 * the original fence text visible so the author can fix it from the document.
 */
function failDiagram(node, message) {
  node.dataset.processed = 'error';
  const label = document.createElement('div');
  label.className = 'diagram-error-message';
  label.setAttribute('data-md-skip', '');
  label.textContent = message;
  node.replaceChildren(label, document.createTextNode(node.dataset.source));
  node.title = message;
  node.classList.add('diagram-error');
}

/**
 * Render pending and out-of-date diagrams in `container`: Mermaid fences through the
 * shared Mermaid queue, and Typora's `sequence` / `flow` fences through the
 * local diagrams.js renderer. The editor widgets, the live preview under the
 * active fence and the HTML/PDF export all call this one function, so all
 * three views carry identical SVG.
 */
export function renderDiagrams(container) {
  const nodes = [...container.querySelectorAll(diagramSelector)];
  const needsRender = node => !node.dataset.processed || diagramThemes.get(node) !== diagramTheme;
  if (!nodes.some(needsRender)) return Promise.resolve();
  const mounted = node => node.isConnected && container.contains(node);
  renderQueue = renderQueue.catch(() => {}).then(async () => {
    let theme;
    do {
      theme = diagramTheme;
      const jobs = nodes.filter(node => mounted(node) && needsRender(node));
      if (!jobs.length) return;
      if (jobs.some(node => diagramKindFor(node) === 'mermaid')) {
        mermaidModule ||= (await import('mermaid')).default;
        if (theme !== diagramTheme) continue;
        mermaidModule.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral', suppressErrorRendering: true });
      }
      const palette = diagramPalette();
      for (const node of jobs) {
        if (!mounted(node)) continue;
        const kind = diagramKindFor(node);
        if (!kind) continue;
        node.dataset.source ||= node.textContent;
        let svg, message;
        if (kind === 'mermaid') {
          try {
            const rendered = await mermaidModule.render(`diagram-${crypto.randomUUID()}`, node.dataset.source);
            if (theme === diagramTheme && mounted(node)) {
              svg = DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'], ADD_ATTR: ['dominant-baseline'] });
            }
          } catch (error) { message = String(error.message || error); }
        } else {
          const rendered = renderNativeDiagram(kind, node.dataset.source, { palette, idPrefix: crypto.randomUUID() });
          ({ svg, error: message } = rendered);
        }
        if (theme !== diagramTheme) break;
        if (!mounted(node)) continue;
        if (message) failDiagram(node, `图表渲染失败：${message}`);
        else {
          node.innerHTML = svg;
          node.dataset.processed = 'true';
          node.classList.remove('diagram-error');
          node.removeAttribute('title');
        }
        diagramThemes.set(node, theme);
      }
      // Callers (including export) keep waiting when the theme changes mid-render.
    } while (theme !== diagramTheme);
  });
  return renderQueue;
}

/** Re-render existing diagrams after a theme change so colours follow. */
export function refreshDiagrams(root, themeKey) {
  if (diagramTheme === themeKey) return Promise.resolve();
  diagramTheme = themeKey;
  return renderDiagrams(root);
}

/**
 * Typora-style word count: each Han character is one word, while Latin
 * words count as one regardless of length. Intl.Segmenter alone would merge
 * a run of Chinese characters into a single "word", undercounting badly.
 */
export function statistics(source) {
  const text = source.replace(/^\uFEFF/, '');
  const characters = [...text].length;
  const nonWhitespace = [...text].filter(character => !/\s/u.test(character)).length;
  let words = 0;
  for (const part of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)) {
    if (!part.isWordLike) continue;
    const han = (part.segment.match(/[\p{Script=Han}]/gu) || []).length;
    words += han || 1;
  }
  return { characters, nonWhitespace, words, lines: text.split(/\r\n|\r|\n/).length, minutes: Math.max(1, Math.ceil(words / 250)) };
}
