/**
 * Syntax tree for the active-block typesetting layer.
 *
 * The reading view is rendered by markdown-it (see `markdown.js`). The active
 * block stays Markdown source with inline decorations, so it needs to know
 * exactly which characters are syntax. Scanning delimiters with regular
 * expressions cannot answer that: emphasis follows the CommonMark flanking
 * rules, code spans and fences are literal, `$5` is not a formula, and a
 * `*` inside a fenced block nested in a list is just a character. Both layers
 * therefore have to agree on a real parse.
 *
 * This module parses the document with Lezer's CommonMark parser, configured
 * with the same extension set markdown-it is loaded with:
 *
 *   GFM (table, task list, strikethrough, autolink), sub/superscript, emoji,
 *   `==highlight==` and the texmath `$…$`, `$$…$$`, `\(…\)` delimiters.
 *
 * The texmath and markdown-it-mark rules are reproduced here rather than
 * approximated, because a mismatch shows up directly as wrongly hidden text.
 */

import { parser as base, GFM, Subscript, Superscript, Emoji } from '@lezer/markdown';
import { parser as renderParser } from './markdown.js';

// Same character class Lezer uses for the CommonMark "punctuation" flanking
// test (see its `Punctuation` constant).
const PUNCTUATION = /\p{S}|\p{P}/u;
// CJK scripts allowed to flank delimiters directly without spaces (Typora parity).
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * `==highlight==`, matching markdown-it-mark. A run of `=` characters is one
 * delimiter run (markdown-it's `scanDelims`): its flanking characters decide
 * whether the run can open and/or close, an odd run leaves one `=` as text,
 * and each remaining pair is a delimiter. A run that can do neither — the
 * `====` in `x ==== y` — is plain text, exactly as the reading view shows it.
 */
const MarkDelimiter = { resolve: 'Mark', mark: 'MarkMark' };
const Mark = {
  defineNodes: [{ name: 'Mark' }, { name: 'MarkMark' }],
  parseInline: [{
    name: 'Mark',
    before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 0x3d /* = */ || cx.char(pos + 1) !== 0x3d) return -1;
      let end = pos;
      while (cx.char(end) === 0x3d) end++;
      const length = end - pos;
      const before = pos > cx.offset ? [...cx.slice(Math.max(cx.offset, pos - 2), pos)].at(-1) : '';
      const after = cx.char(end) < 0 ? '' : [...cx.slice(end, Math.min(cx.end, end + 2))][0];
      const spaceBefore = !before || /\s/.test(before), spaceAfter = !after || /\s/.test(after);
      const punctBefore = PUNCTUATION.test(before), punctAfter = PUNCTUATION.test(after);
      const cjkBefore = CJK.test(before), cjkAfter = CJK.test(after);
      const open = !spaceAfter && (!punctAfter || spaceBefore || punctBefore || cjkBefore);
      const close = !spaceBefore && (!punctBefore || spaceAfter || punctAfter || cjkAfter);
      if (open || close) {
        for (let at = pos + (length % 2); at + 1 < end; at += 2) cx.addDelimiter(MarkDelimiter, at, at + 2, open, close);
      }
      return end;
    }
  }]
};

const gfmBase = base.configure([GFM]);
const baseEmphasis = gfmBase.inlineParsers[gfmBase.inlineNames.indexOf('Emphasis')];
const baseStrikethrough = gfmBase.inlineParsers[gfmBase.inlineNames.indexOf('Strikethrough')];

function parseWithCjk(baseParser) {
  return (cx, next, pos) => {
    const end = baseParser(cx, next, pos);
    if (end >= 0 && next !== 0x5f /* _ */) {
      const part = cx.parts[cx.parts.length - 1];
      if (part && part.from === pos && part.to === end && typeof part.side === 'number') {
        const before = pos > cx.offset ? [...cx.slice(Math.max(cx.offset, pos - 2), pos)].at(-1) : '';
        const after = cx.char(end) < 0 ? '' : [...cx.slice(end, Math.min(cx.end, end + 2))][0];
        if (after && !/\s/.test(after) && CJK.test(before)) part.side |= 1;
        if (before && !/\s/.test(before) && CJK.test(after)) part.side |= 2;
      }
    }
    return end;
  };
}

const CjkInline = {
  parseInline: [
    { name: 'Emphasis', parse: parseWithCjk(baseEmphasis) },
    { name: 'Strikethrough', parse: parseWithCjk(baseStrikethrough) }
  ]
};

/** texmath's `$_pre` / `$_post` guards: a formula cannot start right after a
 * backslash or a digit, and cannot end right before a digit. Digits are how
 * markdown-it keeps `$5` and `$6` out of the formula rules. */
const dollarOpen = (cx, pos) => {
  if (pos <= cx.offset) return true;
  const previous = cx.char(pos - 1);
  return previous !== 0x5c /* \ */ && (previous < 0x30 || previous > 0x39);
};
const dollarClose = (cx, pos) => {
  const following = cx.char(pos + 1);
  return following < 0 || following < 0x30 || following > 0x39;
};
// `\s` of JavaScript, which is also what markdown-it's formula patterns use.
const space = code => code >= 0 && /\s/.test(String.fromCharCode(code));
const nonSpace = code => code >= 0 && !space(code);
const nonSpaceNonBackslash = code => nonSpace(code) && code !== 0x5c;

/** End of a `$$…$$` inline formula, or -1. texmath's `\${2}([^$]*?[^\\])\${2}`:
 * the body cannot contain `$`, cannot be empty and cannot end in a backslash. */
function doubleMathEnd(cx, pos) {
  for (let at = pos + 2; at < cx.end; at++) {
    const ch = cx.char(at);
    if (ch === 0x0a /* \n */) return -1;
    if (ch !== 0x24) continue;
    if (cx.char(at + 1) !== 0x24 || at === pos + 2 || cx.char(at - 1) === 0x5c) return -1;
    return dollarClose(cx, at + 1) ? at + 2 : -1;
  }
  return -1;
}

/**
 * Inline maths: `$…$`, `$$…$$` and `\(…\)`, with the texmath rules. The
 * delimiters become syntax marks and the formula body is styled as code.
 */
const MathInline = {
  defineNodes: [{ name: 'Math' }, { name: 'MathMark' }],
  parseInline: [{
    name: 'Math',
    before: 'Escape',
    parse(cx, next, pos) {
      const formula = (end, length) => cx.addElement(cx.elt('Math', pos, end, [
        cx.elt('MathMark', pos, pos + length), cx.elt('MathMark', end - length, end)
      ]));
      if (next === 0x5c /* \ */) {
        if (cx.char(pos + 1) !== 0x28 /* ( */) return -1;
        const rest = cx.slice(pos + 2, cx.end);
        const close = rest.indexOf('\\)');
        const newline = rest.indexOf('\n');
        if (close < 1 || (newline >= 0 && newline < close)) return -1;
        return formula(pos + 2 + close + 2, 2);
      }
      if (next !== 0x24 /* $ */ || !dollarOpen(cx, pos)) return -1;
      // `$$…$$` is registered before `$…$`; when the double rule does not
      // match, the single rule still gets its turn at the same position.
      if (cx.char(pos + 1) === 0x24) {
        const end = doubleMathEnd(cx, pos);
        if (end > 0) return formula(end, 2);
      }
      for (let at = pos + 2; at < cx.end; at++) {
        const ch = cx.char(at);
        if (ch === 0x0a /* \n */) return -1;
        if (ch !== 0x24) continue;
        if (!nonSpaceNonBackslash(cx.char(pos + 1)) || !nonSpaceNonBackslash(cx.char(at - 1))) continue;
        // A match is only rejected by texmath's post-condition, and then the
        // rule as a whole fails rather than retrying a later `$`.
        if (!dollarClose(cx, at)) return -1;
        return formula(at + 1, 1);
      }
      return -1;
    }
  }]
};

/**
 * Locate the closing `$$` of a block formula. Mirrors texmath's
 * `\${2}([^$]*?[^\\])\${2}`: the body may not contain `$`, must be non-empty
 * and may not end in a backslash. Returns the index of the closing pair, -1
 * when those lines can never hold a block formula, and null while the closing
 * pair is still missing.
 */
function scanMathBlockEnd(text, start = 2) {
  for (let at = start; at < text.length; at++) {
    if (text[at] !== '$') continue;
    if (text[at + 1] === '$' && at > start && text[at - 1] !== '\\') return at;
    return -1;
  }
  return null;
}

function scanBracketMathBlockEnd(text, start = 2) {
  for (let at = start; at < text.length; at++) {
    if (text[at] === '\\' && text[at + 1] === ']') {
      if (at > start && text[at - 1] !== '\\') return at;
    }
  }
  return null;
}

/**
 * Block maths: a paragraph that starts with `$$` or `\[` and runs to the line
 * with the closing `$$` or `\]`. texmath registers this as a block rule, so the
 * body is never parsed as inline Markdown — `_` and `^` inside a formula stay
 * literal.
 *
 * This is a leaf-block override rather than an eager block parser because the
 * construct is only recognised once its closing delimiter shows up: an
 * ordinary paragraph that merely starts with `$$` must fall back to a normal
 * paragraph without any line having been consumed.
 */
class MathBlockParser {
  constructor(leaf) {
    this.scan = leaf.content.startsWith('\\[') ? scanBracketMathBlockEnd : scanMathBlockEnd;
    this.result = this.scan(leaf.content);
  }
  nextLine(cx, line, leaf) {
    if (this.result !== null) return false;
    this.result = this.scan(leaf.content + '\n' + line.scrub());
    if (this.result === null || this.result < 0) return false;
    cx.nextLine();
    cx.addLeafElement(leaf, cx.elt('MathBlock', leaf.start, cx.prevLineEnd()));
    return true;
  }
  finish(cx, leaf) {
    if (this.result === null || this.result < 0) return false;
    cx.addLeafElement(leaf, cx.elt('MathBlock', leaf.start, leaf.start + leaf.content.length));
    return true;
  }
}

const MathBlock = {
  defineNodes: [{ name: 'MathBlock', block: true }],
  parseBlock: [{
    name: 'MathBlock',
    leaf(cx, leaf) {
      return (leaf.content.startsWith('$$') || leaf.content.startsWith('\\[')) ? new MathBlockParser(leaf) : null;
    }
  }]
};

export const syntaxParser = base.configure([GFM, Subscript, Superscript, Emoji, Mark, MathInline, MathBlock, CjkInline]);

/** The text the live preview decorates.
 *
 * Normalised exactly like the reading view (`markdown.js`): no BOM, LF line
 * breaks. Line starts are kept so a block can be sliced by the line numbers
 * markdown-it's `token.map` reports. Blocks are parsed one at a time by
 * `liveBlock()`, so no document-wide syntax tree is kept here.
 */
export function documentLines(source) {
  let text = String(source ?? '').replace(/^\uFEFF/, '');
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  // Reference definitions live in their own block but apply to every other
  // block, so the labels are collected once for the whole document. Links are
  // only resolved against them: `[a][b]` stays literal text when `b` is not
  // defined, exactly like the reading view. The scan is a deliberately cheap
  // approximation of markdown-it's block rule (it does not track fences).
  const references = new Set();
  const footnotes = new Set();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)) {
    const label = match[1].trim();
    if (label.startsWith('^')) {
      const name = label.slice(1);
      if (name && !/\s/.test(name)) footnotes.add(name);
    } else {
      references.add(referenceLabel(label));
    }
  }
  return { source: text, lineStarts, references, footnotes };
}

/** CommonMark's link-label comparison: whitespace collapsed, case folded. */
export function referenceLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Entities ────────────────────────────────────────────────────────────────
// The reading view decodes entities through markdown-it (`&amp;` is `&`), so
// the active block has to show the same character. markdown-it owns the entity
// table; asking it keeps both layers from drifting apart. Results are cached
// because the same entities repeat and an inline parse is not free.
const entityCache = new Map();

export function decodeEntity(raw) {
  if (entityCache.has(raw)) return entityCache.get(raw);
  let value = raw;
  try {
    const tokens = renderParser.parseInline(raw, {});
    // `parseInline` wraps the inline tokens in a single container token.
    const inline = tokens.length === 1 && tokens[0].type === 'inline' ? tokens[0].children || [] : tokens;
    if (inline.length && inline.every(token => token.type === 'text')) value = inline.map(token => token.content).join('');
  } catch { value = raw; }
  entityCache.set(raw, value);
  return value;
}

/**
 * The opening line of a YAML front matter block, when the document has one.
 * markdown-it registers this as a block rule before `hr`, so it is metadata
 * rather than a rule plus heading; the active block keeps it literal.
 */
export function frontMatterRange(source) {
  const firstBreak = source.indexOf('\n');
  if ((firstBreak < 0 ? source : source.slice(0, firstBreak)).trim() !== '---') return null;
  let at = firstBreak + 1;
  while (firstBreak >= 0 && at <= source.length) {
    const end = source.indexOf('\n', at);
    const text = source.slice(at, end < 0 ? source.length : end).trim();
    if (text === '---' || text === '...') return { from: 0, to: end < 0 ? source.length : end };
    if (end < 0) return null;
    at = end + 1;
  }
  return null;
}
