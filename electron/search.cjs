// Folder-wide text search, executed in the main process so a folder's content
// never has to travel through IPC. The renderer only receives the matches and
// the short context around them.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RESULTS_PER_FILE = 20;
const MAX_RESULTS = 500;
const MAX_LINE_LENGTH = 240;
// Directories that never carry the document a user is looking for, and whose
// traversal would dominate the cost of one query.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'target', 'build', 'out', '.next', '.cache']);
const MARKDOWN_FILE = /\.(md|markdown|mdown|txt)$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: false });

// The same extensions the workspace tree lists. Exported so the file-tree
// operations and the search cannot drift apart.
const isMarkdownFile = name => MARKDOWN_FILE.test(String(name ?? ''));

/** Escape a literal query so it can be used inside a regular expression. */
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the matcher for one query. `regex` lets a user write a real expression;
 * a malformed one falls back to a literal so the search never just fails.
 */
function buildMatcher(query, { caseSensitive = false, regex = false } = {}) {
  const text = String(query ?? '');
  if (!text) return null;
  const flags = caseSensitive ? 'g' : 'gi';
  let expression;
  if (regex) {
    try { expression = new RegExp(text, flags); }
    catch { expression = new RegExp(escapeRegExp(text), flags); }
  } else expression = new RegExp(escapeRegExp(text), flags);
  return { expression, test: line => { expression.lastIndex = 0; return expression.exec(line); } };
}

/**
 * Match ranges of one line. The cap only limits how many matches are recorded
 * per line: an expression that backtracks catastrophically still runs
 * synchronously inside the JavaScript engine and cannot be interrupted. `regex`
 * is a power-user option for the user's own folder, not a sandbox for hostile
 * input, which is why it is off by default.
 */
function lineMatches(expression, line) {
  const ranges = [];
  expression.lastIndex = 0;
  let match;
  while ((match = expression.exec(line)) && ranges.length < MAX_RESULTS_PER_FILE) {
    // A zero-width match (`^`, `\b`) still marks one character so the snippet
    // has something to highlight; the loop then advances by hand.
    const length = Math.max(1, match[0].length);
    ranges.push([match.index, match.index + length]);
    expression.lastIndex = match.index + length;
    if (expression.lastIndex >= line.length) break;
  }
  return ranges;
}

/** Trim one line to a readable window around its first match. */
function snippetOf(line, ranges) {
  const indent = line.match(/^[ \t]*/)[0].length;
  let text = line.slice(indent);
  let shifted = ranges.map(([from, to]) => [from - indent, to - indent]);
  if (text.length <= MAX_LINE_LENGTH) return { text, ranges: shifted };
  const first = Math.max(0, shifted[0][0]);
  const start = Math.max(0, Math.min(first - 60, text.length - MAX_LINE_LENGTH));
  const head = start > 0 ? '…' : '';
  const tail = start + MAX_LINE_LENGTH < text.length ? '…' : '';
  const window = text.slice(start, start + MAX_LINE_LENGTH);
  const shift = head.length - start;
  text = head + window + tail;
  shifted = shifted.map(([from, to]) => [from + shift, to + shift]).filter(([from]) => from >= 0 && from <= text.length);
  return { text, ranges: shifted };
}

/**
 * Matches of one file's text. `overrides` wins over the bytes on disk, so an
 * open document with unsaved edits is searched as the user sees it.
 */
function searchText(source, matcher, { maxPerFile = MAX_RESULTS_PER_FILE } = {}) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const matches = [];
  for (let index = 0; index < lines.length && matches.length < maxPerFile; index++) {
    const ranges = lineMatches(matcher.expression, lines[index]);
    if (!ranges.length) continue;
    const snippet = snippetOf(lines[index], ranges);
    matches.push({ line: index + 1, column: ranges[0][0] + 1, ...snippet });
  }
  return matches;
}

/** Every Markdown file below `root`, skipping build output and dot folders. */
async function listSearchFiles(root, { depth = 0, budget = { count: 0 } } = {}) {
  if (depth > 12 || budget.count >= 5000) return [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSearchFiles(full, { depth: depth + 1, budget }));
      continue;
    }
    if (!entry.isFile() || !isMarkdownFile(entry.name)) continue;
    files.push(full);
    if (++budget.count >= 5000) break;
  }
  return files;
}

/**
 * Search every Markdown file of `root` for `query`.
 *
 * `token` is a mutable `{ cancelled }` record: a new query (or the user pressing
 * Escape) flips it, and the walk stops before doing more work. `overrides` maps
 * absolute paths to the live editor content of documents with unsaved changes.
 */
async function searchFolder(root, query, options = {}) {
  const {
    caseSensitive = false, regex = false, overrides = new Map(), token = { cancelled: false },
    maxPerFile = MAX_RESULTS_PER_FILE, maxResults = MAX_RESULTS, maxFileBytes = MAX_FILE_BYTES
  } = options;
  const matcher = buildMatcher(query, { caseSensitive, regex });
  const empty = { query: String(query ?? ''), files: [], total: 0, truncated: false, cancelled: false };
  if (!matcher || !root) return empty;
  const files = [];
  let total = 0, truncated = false;
  for (const file of await listSearchFiles(root)) {
    if (token.cancelled) return { ...empty, total, files, cancelled: true };
    let source = overrides instanceof Map ? overrides.get(file) : null;
    if (typeof source !== 'string') {
      const stat = await fs.stat(file).catch(() => null);
      // A huge generated file would dominate one query; skipping it is faster
      // than reading it, and the result reports nothing rather than lying.
      if (!stat || !stat.isFile() || stat.size > maxFileBytes) continue;
      source = UTF8.decode(await fs.readFile(file).catch(() => Buffer.alloc(0)));
    }
    const matches = searchText(source, matcher, { maxPerFile });
    if (!matches.length) continue;
    files.push({
      path: file,
      name: path.basename(file),
      relative: path.relative(root, file).split(path.sep).join('/'),
      matches
    });
    total += matches.length;
    if (total >= maxResults) { truncated = true; break; }
  }
  return { query: String(query ?? ''), files, total, truncated, cancelled: false };
}

// ── File-tree name validation ───────────────────────────────────────────────

// Windows reserves these device names in every directory, with or without an
// extension. Accepting them would create a file that can never be opened again.
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Validate one file or folder name typed by the user.
 * Returns `{ ok: true, name }` or `{ ok: false, error }` with a Chinese reason.
 */
function validateEntryName(name) {
  const value = String(name ?? '').trim();
  if (!value) return { ok: false, error: '名称不能为空。' };
  if (value === '.' || value === '..') return { ok: false, error: '名称不能是 “.” 或 “..”。' };
  if (value.length > 120) return { ok: false, error: '名称不能超过 120 个字符。' };
  if (ILLEGAL_CHARACTERS.test(value)) return { ok: false, error: '名称不能包含以下字符之一：< > : " / \\ | ? *' };
  if (/[. ]$/.test(value)) return { ok: false, error: '名称不能以空格或句点结尾。' };
  if (value.startsWith('.')) return { ok: false, error: '名称不能以句点开头。' };
  if (RESERVED_NAMES.test(value)) return { ok: false, error: `“${value}” 是 Windows 保留名称，请换一个。` };
  return { ok: true, name: value };
}

module.exports = {
  MAX_FILE_BYTES, MAX_RESULTS, MAX_RESULTS_PER_FILE, SKIPPED_DIRECTORIES, MARKDOWN_FILE,
  isMarkdownFile, escapeRegExp, buildMatcher, searchText, listSearchFiles, searchFolder,
  validateEntryName, snippetOf
};
