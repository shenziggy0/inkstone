/**
 * Typora-style live preview for the *active* block.
 *
 * The Markdown source stays the single source of truth. A source line is
 * decomposed into three disjoint kinds of ranges:
 *
 *   marks  – syntax characters. Hidden with a zero-width widget as soon as
 *            the syntax is *complete*, revealed as dim text only while the
 *            caret is inside that element's editing range.
 *   styles – content ranges that receive real typography (bold, italic,
 *            inline code, links, …) instead of monospace source highlighting.
 *   prefix – a block prefix rendered as a bullet, task box, rule or nothing.
 *   groups – the editing range of each complete inline element, from the
 *            opening marker to the end of the closing marker.
 *
 * Typora's contract: typing the last `*` of `**bold**` renders it *immediately*
 * even though the caret sits right after the closing marker. Proximity alone is
 * the wrong rule — it keeps the closing marker visible until the user "leaves"
 * the syntax. Instead, source characters reappear only when the caret is
 * actually inside the element (or a selection overlaps it).
 *
 * All offsets are UTF-16 code units relative to the line start, matching
 * CodeMirror document positions. Everything here is a pure function so the
 * behaviour can be locked down by unit tests.
 */

// A block prefix is complete even when the line has no content after it.
// `-`, `- [ ]`, `- [x]`, `1.` and `>` are all valid (and parsed as lists /
// quotes by CommonMark on their own), so they must typeset the moment the
// last character is typed. `[]` also counts: CodeMirror's bracket autoclosing
// produces it while `- [ ]` is being typed.
const TASK_PREFIX = /^(\s{0,3})([-*+]|\d+[.)])[ \t]+\[([ xX]?)\](?:[ \t]+|$)/;
const HEADING_PREFIX = /^(\s{0,3})(#{1,6})[ \t]+/;
const QUOTE_PREFIX = /^(\s{0,3}>+)[ \t]?/;
const BULLET_PREFIX = /^(\s{0,3})([-*+])(?:[ \t]+|$)/;
const ORDERED_PREFIX = /^(\s{0,3})(\d+[.)])(?:[ \t]+|$)/;
const FENCE_PREFIX = /^\s{0,3}(?:```|~~~)/;
const HR_LINE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
// A GFM delimiter row always contains a pipe. Without this check a lone `-`
// (or `- ` while typing a list item) is mistaken for a table and the bullet
// only appears after the user types the item text.
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const LINK = /^(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/;
import { EMOJI } from './emoji.js';

const EMOJI_MAP = new Map(EMOJI);
const HTML_PAIR = /^<(u|sub|sup|mark|kbd)>([^\n]*?)<\/\1>/i;
const HTML_TAG = /^<\/?(?:u|sub|sup|mark|kbd|br)\b[^>\n]*>/i;
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

// Longest markers first: `**` must win over `*`, `$$` over `$`.
const PAIRS = [
  ['**', 'strong'], ['__', 'strong'], ['~~', 'strike'], ['==', 'mark'],
  ['$$', 'math'], ['$', 'math'], ['*', 'em'], ['_', 'em'], ['~', 'sub'], ['^', 'sup']
];

function closing(line, marker, from, to) {
  let at = from;
  while ((at = line.indexOf(marker, at)) >= 0) {
    if (at + marker.length > to) return -1;
    if (at > from && line[at - 1] === '\\') { at += marker.length; continue; }
    return at;
  }
  return -1;
}

function scan(line, from, to, out, depth = 0) {
  let cursor = from;
  const escapedClosers = [];
  // A group is the editing range of one complete inline element. Its two
  // syntax marks share the group id, so they are revealed/hidden together.
  const group = (from, to, kind) => (out.groups.push({ from, to, kind }), out.groups.length - 1);
  const mark = (from, to, kind, group = -1) => out.marks.push({
    from, to, group,
    kind: depth > 0 && kind === 'syntax' ? 'soft' : kind
  });
  while (cursor < to) {
    const rest = line.slice(cursor, to);
    if (line[cursor] === '\\' && cursor + 1 < to && ESCAPABLE.test(line[cursor + 1])) {
      const id = group(cursor, cursor + 2, 'escape');
      mark(cursor, cursor + 1, 'syntax', id);
      out.styles.push({ from: cursor + 1, to: cursor + 2, kind: 'literal', group: id });
      if (/[*_~=$^]/.test(line[cursor + 1])) escapedClosers.push(line[cursor + 1]);
      cursor += 2;
      continue;
    }
    const escapedIndex = escapedClosers.indexOf(line[cursor]);
    if (escapedIndex >= 0) {
      escapedClosers.splice(escapedIndex, 1);
      out.styles.push({ from: cursor, to: cursor + 1, kind: 'literal', group: -1 });
      cursor++;
      continue;
    }
    const emoji = /^:[A-Za-z0-9_+-]+:/.exec(rest);
    if (emoji && EMOJI_MAP.has(emoji[0])) {
      const id = group(cursor, cursor + emoji[0].length, 'emoji');
      out.replacements.push({ from: cursor, to: cursor + emoji[0].length, text: EMOJI_MAP.get(emoji[0]), group: id });
      cursor += emoji[0].length;
      continue;
    }
    const link = LINK.exec(rest);
    if (link) {
      const labelFrom = cursor + link[1].length + 1;
      const labelTo = labelFrom + link[2].length;
      const id = group(cursor, cursor + link[0].length, link[1] ? 'image' : 'link');
      mark(cursor, labelFrom, 'syntax', id);
      mark(labelTo, cursor + link[0].length, 'syntax', id);
      if (link[2].length) out.styles.push({ from: labelFrom, to: labelTo, kind: link[1] ? 'image' : 'link', group: id });
      cursor += link[0].length;
      continue;
    }
    const htmlPair = HTML_PAIR.exec(rest);
    if (htmlPair) {
      const openLength = htmlPair[0].indexOf('>') + 1;
      const closeLength = htmlPair[1].length + 3;
      const closeFrom = cursor + htmlPair[0].length - closeLength;
      const id = group(cursor, cursor + htmlPair[0].length, htmlPair[1].toLowerCase());
      mark(cursor, cursor + openLength, 'syntax', id);
      mark(closeFrom, cursor + htmlPair[0].length, 'syntax', id);
      if (closeFrom > cursor + openLength) out.styles.push({ from: cursor + openLength, to: closeFrom, kind: htmlPair[1].toLowerCase(), group: id });
      cursor += htmlPair[0].length;
      continue;
    }
    const tag = HTML_TAG.exec(rest);
    if (tag) {
      const id = group(cursor, cursor + tag[0].length, 'html');
      mark(cursor, cursor + tag[0].length, 'syntax', id);
      cursor += tag[0].length;
      continue;
    }
    const ticks = /^(`+)/.exec(rest);
    if (ticks) {
      const marker = ticks[1];
      const close = closing(line, marker, cursor + marker.length, to);
      if (close > cursor + marker.length - 1 && close + marker.length <= to) {
        const id = group(cursor, close + marker.length, 'code');
        mark(cursor, cursor + marker.length, 'syntax', id);
        mark(close, close + marker.length, 'syntax', id);
        if (close > cursor + marker.length) out.styles.push({ from: cursor + marker.length, to: close, kind: 'code', group: id });
        cursor = close + marker.length;
      } else {
        mark(cursor, cursor + marker.length, 'soft');
        cursor += marker.length;
      }
      continue;
    }
    let paired = false;
    for (const [marker, kind] of PAIRS) {
      if (!rest.startsWith(marker)) continue;
      // `snake_case` and `a_b` are words, not emphasis.
      if (marker.startsWith('_') && cursor > from && /[\p{L}\p{N}]/u.test(line[cursor - 1])) continue;
      const close = closing(line, marker, cursor + marker.length, to);
      if (close <= cursor + marker.length - 1 || close === cursor + marker.length) continue;
      const id = group(cursor, close + marker.length, kind);
      mark(cursor, cursor + marker.length, 'syntax', id);
      mark(close, close + marker.length, 'syntax', id);
      out.styles.push({ from: cursor + marker.length, to: close, kind, group: id });
      // Nested emphasis is common: **bold *and* italic**. Nested syntax must
      // remain a dim mark, never a replace decoration, because it lives inside
      // the outer style's mark range.
      if (depth < 2 && kind !== 'math' && kind !== 'code') scan(line, cursor + marker.length, close, out, depth + 1);
      cursor = close + marker.length;
      paired = true;
      break;
    }
    if (paired) continue;
    if (line[cursor] === '|') {
      mark(cursor, cursor + 1, 'soft');
      cursor++;
      continue;
    }
    if (/[*_~=$^]/.test(line[cursor])) {
      // An underscore inside a word (`snake_case`) is content, not syntax.
      if (line[cursor] === '_' && cursor > from && cursor + 1 < to
        && /[\p{L}\p{N}]/u.test(line[cursor - 1]) && /[\p{L}\p{N}]/u.test(line[cursor + 1])) {
        cursor++;
        continue;
      }
      let end = cursor + 1;
      while (end < to && line[end] === line[cursor]) end++;
      mark(cursor, end, 'soft');
      cursor = end;
      continue;
    }
    cursor++;
  }
}

/** Merge truly overlapping ranges. Adjacent marks of different elements stay
 * separate so each one can be revealed independently. */
function normalise(out) {
  out.marks.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const mark of out.marks) {
    const last = merged.at(-1);
    if (last && mark.from < last.to) {
      last.to = Math.max(last.to, mark.to);
      if (mark.kind === 'soft') last.kind = 'soft';
      if (mark.group !== last.group) last.group = -1;
    } else merged.push({ ...mark });
  }
  out.marks = merged.filter(mark => mark.to > mark.from && mark.from >= 0 && mark.to <= out.length);
  out.styles = out.styles.filter(style => style.to > style.from && style.from >= 0 && style.to <= out.length);
  return out;
}

/**
 * Decide which source characters must be visible for editing.
 *
 * `ranges` are caret/selection offsets relative to the line start. A caret
 * exactly at the END of an element (the position right after typing the
 * closing marker) is OUTSIDE it: the syntax renders immediately. A caret at
 * the START of or inside an element is INSIDE it: the syntax reappears so it
 * can be edited. Non-empty selections reveal everything they overlap.
 */
export function revealFor(info, ranges) {
  const inside = (from, to) => ranges.some(range => range.from === range.to
    ? range.from >= from && range.from < to
    : range.from < to && range.to > from);
  const groups = new Set();
  (info.groups || []).forEach((group, index) => { if (inside(group.from, group.to)) groups.add(index); });
  return { groups, prefix: Boolean(info.prefix && inside(info.prefix.from, info.prefix.to)) };
}

/**
 * Describe one source line. `plain: true` means the caller should fall back
 * to dimming the whole syntax (fenced code, table delimiter rows).
 */
export function liveLine(line) {
  const out = { classes: [], prefix: null, marks: [], styles: [], groups: [], replacements: [], plain: false, length: line.length };
  if (FENCE_PREFIX.test(line)) {
    out.plain = true;
    out.classes.push('cm-lv-fence');
    return out;
  }
  if (HR_LINE.test(line)) {
    out.prefix = { from: 0, to: line.length, kind: 'hr' };
    out.classes.push('cm-lv-hr');
    return out;
  }
  if (TABLE_DELIMITER.test(line) && line.includes('-') && line.includes('|')) {
    out.plain = true;
    out.classes.push('cm-lv-table');
    return out;
  }

  let start = 0;
  const task = TASK_PREFIX.exec(line);
  const heading = HEADING_PREFIX.exec(line);
  const quote = QUOTE_PREFIX.exec(line);
  const bullet = BULLET_PREFIX.exec(line);
  const ordered = ORDERED_PREFIX.exec(line);
  if (task) {
    const checked = /[xX]/.test(task[3]);
    out.prefix = {
      from: task[1].length, to: task[0].length, kind: 'task', checked,
      checkOffset: task[0].lastIndexOf('[') + 1
    };
    out.classes.push('cm-lv-list', 'cm-lv-task');
    start = task[0].length;
  } else if (heading) {
    out.prefix = { from: heading[1].length, to: heading[0].length, kind: 'heading' };
    out.classes.push(`cm-lv-h${heading[2].length}`);
    start = heading[0].length;
  } else if (quote) {
    out.prefix = { from: 0, to: quote[0].length, kind: 'quote' };
    out.classes.push('cm-lv-quote');
    start = quote[0].length;
  } else if (bullet) {
    out.prefix = { from: bullet[1].length, to: bullet[0].length, kind: 'bullet' };
    out.classes.push('cm-lv-list');
    start = bullet[0].length;
  } else if (ordered) {
    // Typora typesets the list number as soon as `1. ` is typed; the literal
    // `1. ` only reappears while the caret sits inside the prefix.
    out.prefix = { from: ordered[1].length, to: ordered[0].length, kind: 'ordered', label: ordered[2] };
    out.classes.push('cm-lv-list', 'cm-lv-ordered');
    start = ordered[0].length;
  }

  const isTableRow = line.includes('|') && (line.trimStart().startsWith('|') || /\s\|\s/.test(line));
  if (isTableRow) out.classes.push('cm-lv-table');
  scan(line, start, line.length, out);
  return normalise(out);
}
