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

const EMOJI_MAP = new Map(EMOJI);

// Inline containers whose children are parsed as inline Markdown.
const INLINE_CONTAINER = /^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|Task)$/;
// Delimiter nodes are rendered by the element that owns them.
const DELIMITERS = new Set(['EmphasisMark', 'StrikethroughMark', 'SubscriptMark', 'SuperscriptMark', 'MarkMark', 'CodeMark', 'LinkMark']);
// Inline HTML that markdown-it passes through and Typora typesets.
const HTML_KINDS = new Set(['u', 'sub', 'sup', 'mark', 'kbd']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'wbr', 'source', 'col', 'area', 'base', 'embed', 'link', 'meta', 'param', 'track']);

const emptyInfo = length => ({
  text: '', offset: 0, length, classes: [], prefix: null, marks: [], styles: [], groups: [],
  replacements: [], plain: false, literal: false
});

/** Prefix of one line: bullet, task box, number, heading or quote marker. */
function prefixOf(line) {
  const task = TASK_PREFIX.exec(line);
  if (task) {
    return {
      prefix: {
        from: task[1].length, to: task[0].length, kind: 'task',
        checked: /[xX]/.test(task[3]),
        checkOffset: task[0].lastIndexOf('[') + 1
      },
      classes: ['cm-lv-list', 'cm-lv-task']
    };
  }
  const heading = HEADING_PREFIX.exec(line);
  if (heading) return { prefix: { from: heading[1].length, to: heading[0].length, kind: 'heading' }, classes: [`cm-lv-h${heading[2].length}`] };
  const quote = QUOTE_PREFIX.exec(line);
  if (quote) return { prefix: { from: 0, to: quote[0].length, kind: 'quote' }, classes: ['cm-lv-quote'] };
  const bullet = BULLET_PREFIX.exec(line);
  if (bullet) return { prefix: { from: bullet[1].length, to: bullet[0].length, kind: 'bullet' }, classes: ['cm-lv-list'] };
  const ordered = ORDERED_PREFIX.exec(line);
  if (ordered) {
    // Typora typesets the list number as soon as `1. ` is typed; the literal
    // `1. ` only reappears while the caret sits inside the prefix.
    return {
      prefix: { from: ordered[1].length, to: ordered[0].length, kind: 'ordered', label: ordered[2] },
      classes: ['cm-lv-list', 'cm-lv-ordered']
    };
  }
  return { prefix: null, classes: [] };
}

/**
 * Describe one block of the document. `startLine`/`endLine` are the 0-based
 * line range markdown-it reports for a top-level token (`endLine` exclusive).
 *
 * Returns `{ length, lines, groups }` where `groups` are block-relative
 * editing ranges and every entry of `lines` is the info for one source line,
 * with offsets relative to that line start.
 */
export function liveBlock(document, startLine, endLine) {
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

  const stack = [];
  syntaxParser.parse(blockText).iterate({
    from: 0, to: blockText.length,
    enter(ref) {
      stack.push(ref.name);
      const parent = stack[stack.length - 2];
      switch (ref.name) {
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
    if (HR_LINE.test(text)) {
      info.prefix = { from: 0, to: text.length, kind: 'hr' };
      info.classes.push('cm-lv-hr');
      lines.push(info);
      continue;
    }
    const prefix = prefixOf(text);
    info.prefix = prefix.prefix;
    info.classes.push(...prefix.classes);
    if (text.includes('|') && (text.trimStart().startsWith('|') || /\s\|\s/.test(text))) info.classes.push('cm-lv-table');
    pushLineMarks(info, marks, lineFrom, lineTo);
    pushLineStyles(info, styles, lineFrom, lineTo);
    for (const replacement of replacements) {
      if (replacement.from < lineFrom || replacement.to > lineTo) continue;
      info.replacements.push({ from: replacement.from - lineFrom, to: replacement.to - lineFrom, text: replacement.text, group: replacement.group });
    }
    if (prefix.prefix) {
      // The prefix owns its characters. The inline parse of `- [x]` sees a
      // shortcut link in the task box, and the block markers of nested quotes
      // are part of the prefix as well; the prefix widget is what renders
      // those characters, so nothing inside them may be hidden twice.
      const outside = range => range.to <= prefix.prefix.from || range.from >= prefix.prefix.to;
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
  block.lines.forEach((info, index) => {
    if (info.prefix && inside(ranges, info.offset + info.prefix.from, info.offset + info.prefix.to)) prefix.add(index);
  });
  return { groups, prefix };
}

/**
 * Reveal state of one line, with line-relative offsets. Only meaningful for
 * the single-line info returned by `liveLine()`; the editor uses
 * `blockReveal()`, because an element may span several lines.
 */
export function revealFor(info, ranges) {
  const groups = new Set();
  (info.groups || []).forEach((group, index) => { if (inside(ranges, group.from, group.to)) groups.add(index); });
  return { groups, prefix: Boolean(info.prefix && inside(ranges, info.prefix.from, info.prefix.to)) };
}

/**
 * Describe one source line on its own. Convenience wrapper for tests and for
 * callers that have no document at hand; a real block must be described with
 * `liveBlock()` so that syntax spanning soft line breaks is parsed as one.
 */
export function liveLine(line) {
  const block = liveBlock(documentLines(line), 0, 1);
  const info = block.lines[0] || emptyInfo(line.length);
  info.text = line;
  return { ...info, groups: block.groups };
}
