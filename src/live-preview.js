/**
 * Typora-style live preview for the *active* block.
 *
 * The Markdown source stays the single source of truth. One block (which may
 * span several lines) is described as a list of disjoint ranges:
 *
 *   marks        – syntax characters. Hidden with a zero-width widget as soon
 *                  as the syntax is *complete*, revealed as dim text only
 *                  while the caret is inside that element's editing range.
 *   styles       – content ranges that receive real typography (bold, italic,
 *                  inline code, links, …) instead of monospace source.
 *   prefix       – a block prefix rendered as a bullet, task box, rule or
 *                  nothing, per line.
 *   groups       – the editing range of each complete inline element, from the
 *                  opening marker to the end of the closing marker.
 *   replacements – literal source (emoji shortcode, entity) shown as the
 *                  single character the reader sees.
 *
 * Typora's contract: typing the last `*` of `**bold**` renders it *immediately*
 * even though the caret sits right after the closing marker. Proximity alone is
 * the wrong rule — it keeps the closing marker visible until the user "leaves"
 * the syntax. Instead, source characters reappear only when the caret is
 * actually inside the element (or a selection overlaps it).
 *
 * Which characters *are* syntax is decided by a real CommonMark parse
 * (`md-syntax.js`), not by pattern matching: `2 * 3 * 4`, `a == b`,
 * `~/.bashrc`, `$5` and `x^2 + y^2` contain no syntax at all, emphasis may
 * cross a soft line break, and code fences, indented code, formulas, HTML
 * blocks and front matter are literal. This is what keeps the active block and
 * the markdown-it reading view from disagreeing about the text.
 *
 * A top level block is a complete construct, so it is parsed on its own: the
 * result is identical to parsing the whole document, and a keystroke only ever
 * costs one block instead of the file. Everything here is a pure function so
 * the behaviour can be locked down by unit tests.
 */

import { EMOJI } from './emoji.js';
import { documentLines, frontMatterRange, decodeEntity, referenceLabel, syntaxParser } from './md-syntax.js';

// The editor slices blocks with these line offsets, so they are part of this
// module's API.
export { documentLines };

const FENCE_PREFIX = /^\s{0,3}(?:```|~~~)/;
// A GFM delimiter row always contains a pipe. Without this check a lone `-`
// (or `- ` while typing a list item) is mistaken for a table and the bullet
// only appears after the user types the item text.
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

const EMOJI_MAP = new Map(EMOJI);

// Inline containers whose children are parsed as inline Markdown.
const INLINE_CONTAINER = /^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|Task)$/;
// Delimiter nodes are rendered by the element that owns them.
const DELIMITERS = new Set(['EmphasisMark', 'StrikethroughMark', 'SubscriptMark', 'SuperscriptMark', 'MarkMark', 'CodeMark', 'LinkMark']);
// Inline HTML that markdown-it passes through and Typora typesets.
const HTML_KINDS = new Set(['u', 'sub', 'sup', 'mark', 'kbd']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'wbr', 'source', 'col', 'area', 'base', 'embed', 'link', 'meta', 'param', 'track']);

const emptyInfo = length => ({
  text: '', offset: 0, length, classes: [], prefix: null, prefixes: [],
  marks: [], styles: [], groups: [], replacements: [], plain: false, literal: false
});

function isEscaped(text, pos) {
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return (backslashes & 1) === 1;
}

function replaceWithSpaces(text, from, to) {
  return text.slice(0, from) + ' '.repeat(to - from) + text.slice(to);
}

function scanCodeSpansAndSingleBackticks(text) {
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`' || isEscaped(text, i)) continue;
    let end = i + 1;
    while (end < text.length && text[end] === '`') end++;
    runs.push({ from: i, to: end, len: end - i });
    i = end - 1;
  }
  const multiRanges = [];
  const singles = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.len >= 2) {
      let close = -1;
      for (let j = i + 1; j < runs.length; j++) {
        if (runs[j].len === run.len) { close = j; break; }
      }
      if (close >= 0) {
        multiRanges.push([run.from, runs[close].to]);
        i = close;
      }
    } else {
      singles.push(run.from);
    }
  }
  return { multiRanges, singles };
}

function pickOrphanPosition(positions, editing, caretCols) {
  if (!positions.length) return -1;
  if (editing && caretCols?.length) {
    const caret = caretCols[0];
    const before = positions.filter(pos => pos < caret);
    return before.length % 2 === 1
      ? before[before.length - 1]
      : (positions.find(pos => pos >= caret) ?? positions[positions.length - 1]);
  }
  return positions[positions.length - 1];
}

function findSymmetricMatches(text, regex, codeRanges) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    const from = match.index;
    const to = from + match[0].length;
    if (isEscaped(text, from)) continue;
    if (codeRanges.some(([a, b]) => from >= a && to <= b)) continue;
    const before = from > 0 ? text[from - 1] : '';
    const after = to < text.length ? text[to] : '';
    if ((!before || /\s/.test(before)) && (!after || /\s/.test(after))) continue;
    matches.push({ from, to });
  }
  return matches;
}

/**
 * Isolate unclosed delimiters on a line using equal-length space padding so
 * typing a lone `` ` `` or `**` never steals partners from closed syntax on
 * the same line or across lines.
 */
export function isolateUnclosedDelimiters(text, editing, caretCols = [], blockTotals = null) {
  let out = text;
  const { multiRanges, singles } = scanCodeSpansAndSingleBackticks(out);
  let orphanBacktick = -1;
  if (singles.length % 2 === 1) {
    orphanBacktick = pickOrphanPosition(singles, editing, caretCols);
    if (orphanBacktick >= 0) out = replaceWithSpaces(out, orphanBacktick, orphanBacktick + 1);
  }
  if (!editing) return out;
  const codeRanges = [...multiRanges];
  const pairedSingles = singles.filter(pos => pos !== orphanBacktick);
  for (let i = 0; i + 1 < pairedSingles.length; i += 2) {
    codeRanges.push([pairedSingles[i], pairedSingles[i + 1] + 1]);
  }
  const specs = [
    { key: 'strong', regex: /(?<!\*)\*\*(?!\*)/g },
    { key: 'strike', regex: /(?<!~)~~(?!~)/g },
    { key: 'mark', regex: /(?<!=)==(?!=)/g },
    { key: 'em', regex: /(?<!\*)\*(?!\*)/g }
  ];
  for (const { key, regex } of specs) {
    const matches = findSymmetricMatches(out, regex, codeRanges);
    if (matches.length % 2 !== 1) continue;
    const total = blockTotals ? blockTotals[key] : matches.length;
    if (total % 2 !== 1 && matches.length < 3) continue;
    const orphanPos = pickOrphanPosition(matches.map(m => m.from), true, caretCols);
    const target = matches.find(m => m.from === orphanPos);
    if (target) out = replaceWithSpaces(out, target.from, target.to);
  }
  return out;
}

function maskBlockLines(texts, startLine, editingLines, caretLines) {
  const literalMask = texts.map(() => false);
  let fence = null;
  let mathCloser = null;
  for (let index = 0; index < texts.length; index++) {
    const line = texts[index];
    if (fence) {
      literalMask[index] = true;
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.len) fence = null;
      continue;
    }
    if (mathCloser) {
      literalMask[index] = true;
      if (mathCloser.test(line)) mathCloser = null;
      continue;
    }
    const fenceOpen = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceOpen) {
      literalMask[index] = true;
      fence = { char: fenceOpen[1][0], len: fenceOpen[1].length };
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      literalMask[index] = true;
      mathCloser = /^\s*\$\$\s*$/;
      continue;
    }
    if (/^\s*\\\[\s*$/.test(line)) {
      literalMask[index] = true;
      mathCloser = /^\s*\\\]\s*$/;
    }
  }
  // Pass 1: isolate orphan single backticks on all non-literal lines and collect code spans.
  const backtickMasked = texts.map((text, index) => {
    if (literalMask[index]) return { text, codeRanges: [] };
    const editing = Boolean(editingLines?.has(startLine + index));
    const cols = caretLines?.get(startLine + index) || [];
    const { multiRanges, singles } = scanCodeSpansAndSingleBackticks(text);
    let out = text;
    let orphanBacktick = -1;
    if (singles.length % 2 === 1) {
      orphanBacktick = pickOrphanPosition(singles, editing, cols);
      if (orphanBacktick >= 0) out = replaceWithSpaces(out, orphanBacktick, orphanBacktick + 1);
    }
    const codeRanges = [...multiRanges];
    const pairedSingles = singles.filter(pos => pos !== orphanBacktick);
    for (let i = 0; i + 1 < pairedSingles.length; i += 2) {
      codeRanges.push([pairedSingles[i], pairedSingles[i + 1] + 1]);
    }
    return { text: out, codeRanges };
  });
  // Pass 2: isolate unclosed **, ~~, ==, * on editing lines when unbalanced across the block.
  const specs = [
    { key: 'strong', regex: /(?<!\*)\*\*(?!\*)/g },
    { key: 'strike', regex: /(?<!~)~~(?!~)/g },
    { key: 'mark', regex: /(?<!=)==(?!=)/g },
    { key: 'em', regex: /(?<!\*)\*(?!\*)/g }
  ];
  for (const { key, regex } of specs) {
    let blockTotal = 0;
    const perLine = backtickMasked.map((entry, index) => {
      if (literalMask[index]) return [];
      const matches = findSymmetricMatches(entry.text, regex, entry.codeRanges);
      blockTotal += matches.length;
      return matches;
    });
    for (let index = 0; index < backtickMasked.length; index++) {
      if (literalMask[index] || !editingLines?.has(startLine + index)) continue;
      const matches = perLine[index];
      if (matches.length % 2 !== 1) continue;
      if (blockTotal % 2 !== 1 && matches.length < 3) continue;
      const cols = caretLines?.get(startLine + index) || [];
      const orphanPos = pickOrphanPosition(matches.map(m => m.from), true, cols);
      const target = matches.find(m => m.from === orphanPos);
      if (target) {
        backtickMasked[index].text = replaceWithSpaces(backtickMasked[index].text, target.from, target.to);
      }
    }
  }
  return backtickMasked.map(entry => entry.text).join('\n');
}

/**
 * Split one line's parsed block markers into the prefix segments that sit
 * before the content. Nested containers interleave arbitrarily
 * (`> - item`, `- > item`, `>> item`), so a single regex cannot describe the
 * prefix: the marker positions and their types come from the parser, and this
 * only walks the contiguous chain from the line start.
 *
 * While editing, a marker becomes visible syntax until its own separator (or,
 * for a compact quote such as `>>`, the next quote marker) is complete. This
 * keeps the current convention that `-`, `1.`, `>` and `>>` stay raw until a
 * space is typed, while an outer quote can already be typeset next to an inner
 * marker that is still missing its separator.
 */
function prefixOf(text, markers, editing, lineStart = 0) {
  const empty = { prefixes: [], classes: [] };
  if (!markers?.length) return empty;
  // Marker positions come from the block parse; the chain below works with
  // line-relative offsets because it compares them with the line text.
  const ordered = markers
    .map(marker => ({ ...marker, from: marker.from - lineStart, to: marker.to - lineStart }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const lead = /^[ \t]*/.exec(text)[0].length;
  const chain = [];
  let at = lead;
  for (;;) {
    const marker = ordered.find(candidate => candidate.from === at);
    if (!marker) break;
    let to = marker.to;
    while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to++;
    chain.push({ ...marker, markerTo: marker.to, to });
    at = to;
  }
  if (!chain.length) return empty;

  const ready = chain.map(() => !editing);
  if (editing) {
    // The innermost marker is the one the author is typing. An outer compact
    // quote or list marker becomes ready once the marker that follows it is.
    for (let index = chain.length - 1; index >= 0; index--) {
      const marker = chain[index];
      if (marker.to > marker.markerTo) ready[index] = true;
      else if (index + 1 < chain.length && ready[index + 1]) ready[index] = true;
    }
  }

  const prefixes = [], classes = [];
  chain.forEach((marker, index) => {
    if (!ready[index]) return;
    const previous = index > 0 ? chain[index - 1] : null;
    // A task item is one checkbox in the active view. Its direct list marker
    // is absorbed into the checkbox range; outer lists and quotes remain.
    if (marker.type === 'list' && chain[index + 1]?.type === 'task' && ready[index + 1]) return;
    if (marker.type === 'quote') {
      const from = index === 0 ? 0 : marker.from;
      prefixes.push({ from, to: marker.to, kind: 'quote' });
      classes.push('cm-lv-quote');
    } else if (marker.type === 'heading') {
      prefixes.push({ from: marker.from, to: marker.to, kind: 'heading' });
      classes.push(`cm-lv-h${marker.level}`);
    } else if (marker.type === 'task') {
      const from = previous?.type === 'list' && ready[index - 1] ? previous.from : marker.from;
      prefixes.push({ from, to: marker.to, kind: 'task', checked: marker.checked, checkOffset: marker.from + 1 });
      classes.push('cm-lv-list', 'cm-lv-task');
    } else if (marker.type === 'list') {
      const label = text.slice(marker.from, marker.markerTo);
      if (/^\d/.test(label)) {
        prefixes.push({ from: marker.from, to: marker.to, kind: 'ordered', label });
        classes.push('cm-lv-list', 'cm-lv-ordered');
      } else {
        prefixes.push({ from: marker.from, to: marker.to, kind: 'bullet' });
        classes.push('cm-lv-list');
      }
    }
  });
  return { prefixes, classes: [...new Set(classes)] };
}

/**
 * An empty list marker that is still being typed. A bare `- ` after a
 * paragraph is parsed as a Setext underline, and the same ambiguity inside a
 * quote can hide both the quote marker and the list marker. Recover only the
 * contiguous prefix of the current line: quote markers plus one empty list
 * marker. Without the separator the marker itself stays raw; a completed
 * underline, rule, code, formula or a marker followed by text is untouched.
 */
function inProgressEmptyList(text) {
  let at = 0, lead = 0;
  while (lead < 3 && (text[lead] === ' ' || text[lead] === '\t')) lead++;
  at = lead;
  const quotes = [];
  while (text[at] === '>') {
    quotes.push({ type: 'quote', from: at, to: at + 1 });
    at++;
    if (text[at] === ' ' || text[at] === '\t') at++;
  }
  let indent = 0;
  while (indent < 3 && (text[at] === ' ' || text[at] === '\t')) { at++; indent++; }
  const match = /^(?:[-*+]|\d+[.)])/.exec(text.slice(at));
  if (!match) return null;
  const from = at;
  at += match[0].length;
  const rest = text.slice(at);
  if (!rest) return { quotes, list: null };
  if (!/^[ \t]+$/.test(rest)) return null;
  return { quotes, list: { type: 'list', from, to: at } };
}

/** One span for callers that only need to remove/reveal the whole prefix. */
function combinePrefixes(prefixes) {
  if (!prefixes.length) return null;
  if (prefixes.length === 1) return prefixes[0];
  // The innermost segment owns the kind/checkbox metadata, while the range
  // covers every segment so the reading-view parity check cuts all of them.
  return { ...prefixes[prefixes.length - 1], from: prefixes[0].from, to: prefixes[prefixes.length - 1].to };
}

/**
 * Describe one block of the document. `startLine`/`endLine` are the 0-based
 * line range markdown-it reports for a top-level token (`endLine` exclusive).
 *
 * Returns `{ length, lines, groups }` where `groups` are block-relative
 * editing ranges and every entry of `lines` is the info for one source line,
 * with offsets relative to that line start.
 */
export function liveBlock(document, startLine, endLine, editingLines, caretLines = new Map()) {
  const source = document.source;
  const lineStarts = document.lineStarts;
  const last = Math.min(endLine, lineStarts.length);
  const from = lineStarts[startLine] ?? 0;
  const to = last < lineStarts.length ? lineStarts[last] - 1 : source.length;
  const blockText = source.slice(from, to);
  const texts = [], starts = [];
  for (let line = startLine; line < last; line++) {
    starts.push(lineStarts[line] - from);
    texts.push(source.slice(lineStarts[line], line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : source.length));
  }

  const groups = [];
  const marks = [];
  const styles = [];
  const replacements = [];
  const lineMarkers = texts.map(() => []);
  // A thematic break is whatever the CommonMark parse says it is: `* * *`,
  // `___` and a rule nested in a quote or list item are rules, while a Setext
  // underline (`标题` + `---`), a table delimiter row, a fence line and front
  // matter are not. Describing them from the tree instead of the line text is
  // what keeps this layer agreeing with the reading view.
  const rules = new Map();
  // null = ordinary prose, 'literal' = source shown as written (code, formula),
  // 'plain' = syntax dimmed by the caller (`inlineMarks`).
  const kinds = texts.map(() => null);
  const kindClasses = texts.map(() => null);

  const group = (a, b, kind) => (groups.push({ from: a, to: b, kind }), groups.length - 1);
  const mark = (a, b, kind, id) => { if (b > a) marks.push({ from: a, to: b, kind, group: id }); };
  const style = (a, b, kind) => { if (b > a) styles.push({ from: a, to: b, kind }); };

  const lastLine = texts.length - 1;
  const lineAt = pos => {
    let low = 0, high = lastLine;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= pos) low = mid; else high = mid - 1;
    }
    return low;
  };
  const classify = (a, b, kind, className = null) => {
    if (b <= a) return;
    const first = lineAt(Math.max(a, 0));
    const lastTouched = lineAt(Math.min(Math.max(a, b - 1), starts[lastLine] + texts[lastLine].length));
    for (let index = first; index <= lastTouched; index++) {
      kinds[index] = kind;
      if (className) kindClasses[index] = className;
    }
  };

  // ── Inline mapping ───────────────────────────────────────────────────────
  const isLineStart = pos => pos === 0 || blockText[pos - 1] === '\n';
  const textOf = node => blockText.slice(node.from, node.to);

  const paired = (node, kind) => {
    const delimiters = [];
    for (let child = node.firstChild; child; child = child.nextSibling) if (DELIMITERS.has(child.name)) delimiters.push(child);
    if (delimiters.length < 2) return;
    const id = group(node.from, node.to, kind);
    for (const delimiter of delimiters) mark(delimiter.from, delimiter.to, 'syntax', id);
    style(delimiters[0].to, delimiters[delimiters.length - 1].from, kind);
    children(node);
  };

  const codeSpan = node => {
    if (lineAt(node.from) !== lineAt(node.to - 1)) return;
    const delimiters = [];
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'CodeMark') delimiters.push(child);
    if (delimiters.length < 2) return;
    const id = group(node.from, node.to, 'code');
    for (const delimiter of delimiters) mark(delimiter.from, delimiter.to, 'syntax', id);
    // A code span's content is literal: nothing inside it is syntax.
    style(delimiters[0].to, delimiters[delimiters.length - 1].from, 'code');
  };

  const mathInline = node => {
    const delimiters = [];
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'MathMark') delimiters.push(child);
    if (delimiters.length < 2) return;
    const id = group(node.from, node.to, 'math');
    for (const delimiter of delimiters) mark(delimiter.from, delimiter.to, 'syntax', id);
    style(delimiters[0].to, delimiters[1].from, 'math');
  };

  const references = document.references || new Set();
  const isDefined = label => references.has(referenceLabel(label));

  const link = (node, kind) => {
    const linkMarks = [], others = [];
    let destination = false, reference = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'LinkMark') linkMarks.push(child);
      else {
        others.push(child);
        if (child.name === 'URL') destination = true;
        if (child.name === 'LinkLabel') reference = child;
      }
    }
    if (!linkMarks.length) return;
    const labelFrom = linkMarks[0].to;
    const labelTo = (linkMarks[1] || linkMarks[0]).from;
    // `[text](url)` always links, while `[text][ref]` and `[ref]` only link
    // when the document defines that label. Otherwise markdown-it renders the
    // brackets, so the active block dims them and keeps the text.
    const resolved = destination || (reference
      ? isDefined(textOf(reference).slice(1, -1))
      : isDefined(blockText.slice(labelFrom, labelTo)));
    if (!resolved) {
      const rawLabel = blockText.slice(labelFrom, labelTo);
      if (!destination && !reference && linkMarks.length >= 2 && rawLabel.startsWith('^') && rawLabel.length > 1) {
        if (blockText[node.to] === ':') {
          mark(node.from, node.to + 1, 'soft', -1);
        } else {
          const id = group(node.from, node.to, 'link');
          for (const bracket of linkMarks) mark(bracket.from, bracket.to, 'syntax', id);
          mark(labelFrom, labelFrom + 1, 'syntax', id);
          style(labelFrom + 1, labelTo, 'sup');
          style(labelFrom + 1, labelTo, 'link');
        }
        return;
      }
      for (const bracket of linkMarks) mark(bracket.from, bracket.to, 'soft', -1);
      for (const child of others) inlineNode(child);
      return;
    }
    const id = group(node.from, node.to, kind);
    mark(node.from, labelFrom, 'syntax', id);
    mark(labelTo, node.to, 'syntax', id);
    style(labelFrom, labelTo, kind);
    for (const child of others) if (child.from >= labelFrom && child.to <= labelTo) inlineNode(child);
  };

  const autolink = node => {
    const delimiters = [];
    let url = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'LinkMark') delimiters.push(child);
      else if (child.name === 'URL') url = child;
    }
    if (delimiters.length < 2 || !url) return;
    const id = group(node.from, node.to, 'link');
    for (const delimiter of delimiters) mark(delimiter.from, delimiter.to, 'syntax', id);
    style(url.from, url.to, 'link');
  };

  /** A standalone syntax node that is hidden as one editing group. */
  const separate = (node, kind) => {
    const id = group(node.from, node.to, kind);
    mark(node.from, node.to, 'syntax', id);
  };

  const children = node => {
    for (let child = node.firstChild; child; child = child.nextSibling) inlineNode(child);
  };

  const inlineNode = node => {
    switch (node.name) {
      case 'StrongEmphasis': return paired(node, 'strong');
      case 'Emphasis': return paired(node, 'em');
      case 'Strikethrough': return paired(node, 'strike');
      case 'Subscript': return paired(node, 'sub');
      case 'Superscript': return paired(node, 'sup');
      case 'Mark': return paired(node, 'mark');
      case 'InlineCode': return codeSpan(node);
      case 'Math': return mathInline(node);
      case 'Link': return link(node, 'link');
      case 'Image': return link(node, 'image');
      case 'Autolink': return autolink(node);
      case 'Escape': {
        // Only the backslash is syntax; the escaped character is content.
        const id = group(node.from, node.to, 'escape');
        mark(node.from, node.from + 1, 'syntax', id);
        return;
      }
      case 'HardBreak': {
        // Trailing spaces (or the backslash) produce the line break; the
        // newline itself belongs to the line structure and is never replaced.
        const id = group(node.from, node.to - 1, 'break');
        mark(node.from, node.to - 1, 'syntax', id);
        return;
      }
      case 'Emoji': {
        const glyph = EMOJI_MAP.get(textOf(node));
        if (!glyph) return;
        const id = group(node.from, node.to, 'emoji');
        replacements.push({ from: node.from, to: node.to, text: glyph, group: id });
        return;
      }
      case 'Entity': {
        const raw = textOf(node);
        const value = decodeEntity(raw);
        if (value === raw) return;
        const id = group(node.from, node.to, 'entity');
        replacements.push({ from: node.from, to: node.to, text: value, group: id });
        return;
      }
      case 'URL':
        // A bare URL linkified by markdown-it; the visible text is unchanged.
        style(node.from, node.to, 'link');
        return;
      case 'HeaderMark':
        // The leading `#` of an ATX heading belongs to the block prefix; a
        // closing `###` sequence is syntax of its own.
        if (isLineStart(node.from)) return;
        separate(node, 'heading');
        return;
      default:
        // Delimiters, block markers (QuoteMark / ListMark / TaskMarker) and
        // link destinations are handled by their owner or by the prefix.
        return;
    }
  };

  /** Pair inline HTML tags so `<u>text</u>` hides the tags and styles the text. */
  const htmlTags = container => {
    const tags = [];
    const collect = node => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'HTMLTag') tags.push(child);
        else collect(child);
      }
    };
    collect(container);
    if (!tags.length) return;
    const open = new Map();
    for (const tag of tags) {
      const raw = textOf(tag);
      const match = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(raw);
      if (!match) { separate(tag, 'html'); continue; }
      const name = match[2].toLowerCase();
      const stack = open.get(name) || [];
      if (match[1]) {
        const start = stack.pop();
        if (!start) { separate(tag, 'html'); continue; }
        const kind = HTML_KINDS.has(name) ? name : 'html';
        const id = group(start.from, tag.to, kind);
        mark(start.from, start.to, 'syntax', id);
        mark(tag.from, tag.to, 'syntax', id);
        if (HTML_KINDS.has(name)) style(start.to, tag.from, name);
        continue;
      }
      if (VOID_TAGS.has(name) || raw.endsWith('/>')) { separate(tag, 'html'); continue; }
      stack.push(tag);
      open.set(name, stack);
    }
    for (const stack of open.values()) for (const tag of stack) separate(tag, 'html');
  };

  // ── Block structure ──────────────────────────────────────────────────────
  // Front matter is metadata rather than a rule plus heading, and the block
  // that holds it starts at the top of the document.
  if (startLine === 0) {
    const front = frontMatterRange(source);
    if (front) classify(front.from, front.to, 'plain');
  }

  const parseText = maskBlockLines(texts, startLine, editingLines, caretLines);
  const stack = [];
  syntaxParser.parse(parseText).iterate({
    from: 0, to: parseText.length,
    enter(ref) {
      stack.push(ref.name);
      const parent = stack[stack.length - 2];
      switch (ref.name) {
        case 'HeaderMark': {
          // A Setext underline is not a rule and not a list marker; the parse
          // already tells it apart, so only an ATX `#` becomes a prefix.
          if (/^ATXHeading[1-6]$/.test(parent)) {
            const line = lineAt(ref.from);
            lineMarkers[line].push({ type: 'heading', level: Number(parent.slice(-1)), from: ref.from, to: ref.to });
          }
          break;
        }
        case 'HorizontalRule': {
          const line = lineAt(ref.from);
          rules.set(line, { from: ref.from - starts[line], to: ref.to - starts[line] });
          break;
        }
        case 'ListMark':
          lineMarkers[lineAt(ref.from)].push({ type: 'list', from: ref.from, to: ref.to });
          break;
        case 'QuoteMark':
          lineMarkers[lineAt(ref.from)].push({ type: 'quote', from: ref.from, to: ref.to });
          break;
        case 'TaskMarker':
          lineMarkers[lineAt(ref.from)].push({
            type: 'task', from: ref.from, to: ref.to, checked: /[xX]/.test(blockText.slice(ref.from, ref.to))
          });
          break;
        case 'FencedCode': classify(ref.from, ref.to, 'literal'); break;
        case 'CodeBlock': classify(ref.from, ref.to, 'literal'); break;
        case 'MathBlock': classify(ref.from, ref.to, 'literal'); break;
        case 'HTMLBlock': classify(ref.from, ref.to, 'plain'); break;
        case 'CodeMark':
          // The fence lines are syntax the caller dims; everything between
          // them is literal code.
          if (parent === 'FencedCode') classify(ref.from, ref.to, 'plain', 'cm-lv-fence');
          break;
        case 'TableDelimiter':
          if (parent === 'Table') classify(ref.from, ref.to, 'plain', 'cm-lv-table');
          else mark(ref.from, ref.to, 'soft', -1);
          break;
        case 'LinkReference': {
          for (let child = ref.node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'LinkLabel' || child.name === 'LinkMark' || child.name === 'LinkTitle') {
              mark(child.from, child.to, 'soft', -1);
            } else if (child.name === 'URL') {
              style(child.from, child.to, 'link');
            }
          }
          break;
        }
        default:
          if (INLINE_CONTAINER.test(ref.name)) { htmlTags(ref.node); children(ref.node); }
      }
      return true;
    },
    leave() { stack.pop(); }
  });

  // ── Per-line assembly ────────────────────────────────────────────────────
  const lines = [];
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    const lineFrom = starts[index], lineTo = lineFrom + text.length;
    const info = emptyInfo(text.length);
    info.text = text;
    info.offset = lineFrom;
    const kind = kinds[index];
    if (kind === 'literal') {
      info.literal = true;
      lines.push(info);
      continue;
    }
    if (kind === 'plain') {
      info.plain = true;
      if (kindClasses[index]) info.classes.push(kindClasses[index]);
      lines.push(info);
      continue;
    }
    // A single line that is described on its own still has to recognise a
    // fence or a table delimiter row; inside a block the parse above wins.
    if (FENCE_PREFIX.test(text)) {
      info.plain = true;
      info.classes.push('cm-lv-fence');
      lines.push(info);
      continue;
    }
    if (TABLE_DELIMITER.test(text) && text.includes('-') && text.includes('|')) {
      info.plain = true;
      info.classes.push('cm-lv-table');
      lines.push(info);
      continue;
    }
    const editing = Boolean(editingLines?.has(startLine + index));
    let markers = lineMarkers[index];
    if (editing && !markers.some(marker => marker.type === 'list' || marker.type === 'task')) {
      const pending = inProgressEmptyList(text);
      if (pending) {
        const offset = lineFrom;
        markers = [
          ...pending.quotes.map(marker => ({ ...marker, from: marker.from + offset, to: marker.to + offset })),
          ...(pending.list ? [{ ...pending.list, from: pending.list.from + offset, to: pending.list.to + offset }] : [])
        ];
      }
    }
    const prefix = prefixOf(text, markers, editing, lineFrom);
    info.prefixes = prefix.prefixes;
    info.classes.push(...prefix.classes);
    // The rule owns the rest of its line, after the container markers. An
    // enclosing quote or list layer stays a prefix of its own, so a nested
    // rule keeps its nesting instead of flattening to one span. A marker that
    // is still waiting for its separator (`>---`) keeps the whole line as
    // source: a rule may only absorb whitespace before it.
    const rule = rules.get(index);
    if (rule) {
      const start = info.prefixes.length ? info.prefixes[info.prefixes.length - 1].to : 0;
      if (/^[ \t]*$/.test(text.slice(start, rule.from))) {
        info.prefixes.push({ from: start, to: text.length, kind: 'hr' });
        info.classes.push('cm-lv-hr');
      }
    }
    info.prefix = combinePrefixes(info.prefixes);
    if (text.includes('|') && (text.trimStart().startsWith('|') || /\s\|\s/.test(text))) info.classes.push('cm-lv-table');
    pushLineMarks(info, marks, lineFrom, lineTo);
    pushLineStyles(info, styles, lineFrom, lineTo);
    for (const replacement of replacements) {
      if (replacement.from < lineFrom || replacement.to > lineTo) continue;
      info.replacements.push({ from: replacement.from - lineFrom, to: replacement.to - lineFrom, text: replacement.text, group: replacement.group });
    }
    if (info.prefix) {
      // The prefix owns its characters. The inline parse of `- [x]` sees a
      // shortcut link in the task box, and the block markers of nested quotes
      // are part of the prefix as well; the prefix widgets render those
      // characters, so nothing inside them may be hidden twice.
      const outside = range => range.to <= info.prefix.from || range.from >= info.prefix.to;
      info.marks = info.marks.filter(outside);
      info.styles = info.styles.filter(outside);
      info.replacements = info.replacements.filter(outside);
    }
    lines.push(info);
  }

  return { length: blockText.length, lines, groups };
}

function pushLineMarks(info, marks, lineFrom, lineTo) {
  const own = [];
  for (const mark of marks) {
    if (mark.from >= lineTo || mark.to <= lineFrom) continue;
    own.push({ from: Math.max(mark.from, lineFrom) - lineFrom, to: Math.min(mark.to, lineTo) - lineFrom, kind: mark.kind, group: mark.group });
  }
  own.sort((a, b) => a.from - b.from || a.to - b.to);
  // Decorations must be ordered and disjoint. The mapper never produces
  // overlapping syntax, but adjacent runs are merged defensively so a single
  // hidden range is never split into two widgets.
  const merged = [];
  for (const mark of own) {
    const last = merged[merged.length - 1];
    if (last && mark.from < last.to) {
      last.to = Math.max(last.to, mark.to);
      if (mark.kind === 'soft') last.kind = 'soft';
      if (mark.group !== last.group) last.group = -1;
    } else merged.push(mark);
  }
  info.marks = merged.filter(mark => mark.to > mark.from);
}

function pushLineStyles(info, styles, lineFrom, lineTo) {
  for (const style of styles) {
    if (style.from >= lineTo || style.to <= lineFrom) continue;
    info.styles.push({ from: Math.max(style.from, lineFrom) - lineFrom, to: Math.min(style.to, lineTo) - lineFrom, kind: style.kind });
  }
  info.styles.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Whether a caret/selection range lies inside an element's editing range. */
function inside(ranges, from, to) {
  return ranges.some(range => range.from === range.to
    ? range.from >= from && range.from < to
    : range.from < to && range.to > from);
}

/**
 * Decide which source characters must be visible for editing.
 *
 * `ranges` are caret/selection offsets relative to the block start. A caret
 * exactly at the END of an element (the position right after typing the
 * closing marker) is OUTSIDE it: the syntax renders immediately. A caret at
 * the START of or inside an element is INSIDE it: the syntax reappears so it
 * can be edited. Non-empty selections reveal everything they overlap.
 *
 * `prefix` holds the line indices whose block prefix must show its source.
 */
export function blockReveal(block, ranges) {
  const groups = new Set();
  block.groups.forEach((group, index) => { if (inside(ranges, group.from, group.to)) groups.add(index); });
  const prefix = new Set();
  const prefixes = new Set();
  block.lines.forEach((info, index) => {
    for (const segment of info.prefixes || []) {
      if (!inside(ranges, info.offset + segment.from, info.offset + segment.to)) continue;
      prefixes.add(segment);
      prefix.add(index);
    }
  });
  return { groups, prefix, prefixes };
}

/**
 * Reveal state of one line, with line-relative offsets. Only meaningful for
 * the single-line info returned by `liveLine()`; the editor uses
 * `blockReveal()`, because an element may span several lines.
 */
export function revealFor(info, ranges) {
  const groups = new Set();
  (info.groups || []).forEach((group, index) => { if (inside(ranges, group.from, group.to)) groups.add(index); });
  const prefixes = new Set();
  for (const segment of info.prefixes || []) {
    if (inside(ranges, info.offset + segment.from, info.offset + segment.to)) prefixes.add(segment);
  }
  return { groups, prefix: prefixes.size > 0, prefixes };
}

/**
 * Describe one source line on its own. Convenience wrapper for tests and for
 * callers that have no document at hand; a real block must be described with
 * `liveBlock()` so that syntax spanning soft line breaks is parsed as one.
 */
export function liveLine(line) {
  const block = liveBlock(documentLines(line), 0, 1, new Set([0]));
  const info = block.lines[0] || emptyInfo(line.length);
  info.text = line;
  return { ...info, groups: block.groups };
}
