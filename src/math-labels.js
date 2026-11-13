/**
 * Typora's TeX-style equation labels, tags and cross references.
 *
 * The document renderer stays on KaTeX: no MathJax runtime, no CDN and no
 * remote font. KaTeX already typesets `\tag`, `\tag*`, `align` and friends, but
 * it has no document state, so `\label`, `\ref` and `\eqref` are handled here
 * before the TeX reaches KaTeX.
 *
 * The whole document is scanned in order once. That makes a reference work even
 * when it appears before its formula, keeps the numbering deterministic across
 * blocks, and lets the existing per-block render cache reuse unchanged blocks.
 * The compatibility scope is deliberately small:
 *
 *   - a label may only be defined by a display formula (`$$…$$`, `\[…\]`);
 *   - `\tag{…}` / `\tag*{…}` is the manual number, otherwise the current
 *     "自动编号" preference numbers every display formula that has no tag;
 *   - `\ref{name}` shows the tag text, `\eqref{name}` shows it in parentheses;
 *   - an unknown label is `??`, and the first definition of a duplicate label
 *     wins (the later formula keeps its source-derived anchor out of the way);
 *   - labels are document-local: a new parse gets a new registry, so switching
 *     documents cannot carry numbers across;
 *   - an unescaped `%` starts a TeX comment to the end of its line. Commented
 *     commands are neither registered, renumbered nor rewritten, while `\%`
 *     stays a literal percent and a later line is scanned normally.
 *
 * This is not a general LaTeX resolver. It does not process `\ref` outside a
 * math token, does not run user macros, and never enables KaTeX `trust`. Tags
 * are treated as plain text for references (a tag such as `\tag{\text{A}}`
 * still typesets, but its reference shows the escaped tag source); AMS
 * numbering environments such as `\begin{equation}` and `\def` / `\newcommand`
 * remain outside this compatibility layer.
 */

export const MATH_TOKEN_TYPES = new Set([
  'math_inline', 'math_inline_double', 'math_block', 'math_block_eqno'
]);

export const DISPLAY_MATH_TOKEN_TYPES = new Set([
  'math_inline_double', 'math_block', 'math_block_eqno'
]);

const LABEL_NAMES = new Set(['label']);
const TAG_NAMES = new Set(['tag']);
const REF_NAMES = new Set(['ref', 'eqref']);
const DIRECTIVE = /\\(label|tag|ref|eqref)(\*)?/g;

/** The `%` comment ranges of a TeX source, one per line. */
function commentRanges(source) {
  const ranges = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline < 0 ? source.length : newline;
    for (let index = start; index < end; index++) {
      if (source[index] !== '%') continue;
      // `\%` is a literal percent; an even run of backslashes leaves the `%`
      // unescaped, so it starts a TeX comment to the end of this line.
      let slashes = 0;
      for (let at = index - 1; at >= start && source[at] === '\\'; at--) slashes++;
      if (slashes % 2 === 0) { ranges.push([index, end]); break; }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return ranges;
}

/** True when a command at `index` is escaped by an odd run of backslashes. */
function escapedCommand(source, index) {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === '\\'; at--) slashes++;
  return slashes % 2 === 1;
}

/** Read a balanced `{…}` argument. `at` points at the opening brace. */
function readBraced(source, at) {
  if (source[at] !== '{') return null;
  let depth = 0;
  for (let index = at; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') { index++; continue; }
    // An unescaped percent starts a comment, so the argument cannot close on
    // this line; TeX would ignore the rest of the line as well.
    if (character === '%') return null;
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      return { value: source.slice(at + 1, index), end: index + 1 };
    }
  }
  return null;
}

/**
 * Every complete `\label`, `\tag`, `\ref` or `\eqref` command in `source`, in
 * source order. An escaped command (`\\ref`) is left alone, and a command with
 * an unterminated argument is left for KaTeX to report instead of being
 * silently swallowed.
 */
function directives(source, names = null) {
  const result = [];
  const comments = commentRanges(source);
  let commentIndex = 0;
  const commented = index => {
    while (commentIndex < comments.length && comments[commentIndex][1] <= index) commentIndex++;
    const range = comments[commentIndex];
    return !!range && index >= range[0] && index < range[1];
  };
  DIRECTIVE.lastIndex = 0;
  let match;
  while ((match = DIRECTIVE.exec(source))) {
    if (commented(match.index) || escapedCommand(source, match.index)) continue;
    if (names && !names.has(match[1])) continue;
    let at = match.index + match[0].length;
    while (at < source.length && /\s/.test(source[at])) at++;
    const argument = readBraced(source, at);
    if (!argument) continue;
    // A command whose argument contains another command of the same kind is
    // not a second range: the outer one owns those characters, and removing
    // both would corrupt the argument.
    if (result.length && match.index < result[result.length - 1].end) continue;
    result.push({
      name: match[1], star: !!match[2], value: argument.value,
      start: match.index, end: argument.end
    });
  }
  return result;
}

/** Remove every `\label{…}` and return the remaining TeX plus the names. */
export function takeLabels(source) {
  const labels = directives(source, LABEL_NAMES);
  if (!labels.length) return { text: source, labels: [] };
  let text = source;
  for (let index = labels.length - 1; index >= 0; index--) {
    text = text.slice(0, labels[index].start) + text.slice(labels[index].end);
  }
  return {
    text,
    labels: labels.map(label => label.value.trim()).filter(Boolean)
  };
}

/** The first explicit `\tag`/`\tag*` of one display formula, if any. */
export function findTag(source) {
  const tag = directives(source, TAG_NAMES)[0];
  return tag ? { value: tag.value.trim(), star: tag.star } : null;
}

/**
 * A tag used in `\text{…}`. Tags are normally numbers or a short plain-text
 * mark; escaping keeps every other character literal instead of turning it into
 * a KaTeX command or a brace that would break the wrapper.
 */
export function texText(value) {
  return String(value).replace(/[\\{}%#$&_^~]/g, character => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#',
    '&': '\\&', '_': '\\_', $: '\\$', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}'
  })[character]);
}

/** Resolve the number one registry entry holds. */
function numberOf(entry) {
  if (entry && typeof entry === 'object') return entry.number ?? null;
  return entry ?? null;
}

/** Replace `\ref` / `\eqref` with text KaTeX can typeset. */
function resolveReferences(source, labels, refs) {
  const found = directives(source, REF_NAMES);
  if (!found.length) return source;
  const lookup = name => {
    if (labels instanceof Map) return labels.get(name);
    return labels && typeof labels === 'object' ? labels[name] : null;
  };
  let text = '', at = 0;
  for (const reference of found) {
    text += source.slice(at, reference.start);
    const name = reference.value.trim();
    const number = numberOf(lookup(name));
    const known = number !== null && number !== undefined && number !== '';
    const shown = known ? String(number).replace(/\s+/g, ' ').trim() : '??';
    text += `\\text{${texText(reference.name === 'eqref' ? `(${shown})` : shown)}}`;
    refs.push({ kind: reference.name, name, number: known ? number : null });
    at = reference.end;
  }
  return text + source.slice(at);
}

/** Every math token, including the children of an inline token, in order. */
function mathTokens(tokens) {
  return (function* walk(list) {
    for (const token of list) {
      if (MATH_TOKEN_TYPES.has(token.type)) yield token;
      if (token.children?.length) yield* walk(token.children);
    }
  })(tokens);
}

/**
 * Prepare every math token of one parse.
 *
 * `numbering` is the current "公式自动编号" preference. A formula that already
 * has a manual tag never consumes an automatic number, matching LaTeX (and
 * Typora's "Auto Numbering for All Math Equations" mode), so adding a manual
 * tag cannot silently renumber the rest of the document.
 */
export function prepareMath(tokens, { numbering = false } = {}) {
  const labels = new Map();
  const duplicates = [];
  let counter = 0;

  for (const token of mathTokens(tokens)) {
    if (!DISPLAY_MATH_TOKEN_TYPES.has(token.type)) continue;
    const withoutLabels = takeLabels(token.content);
    // texmath's `$$…$$ (7)` form already carries a display number. Keep that
    // template's `(7)` span, and treat 7 as the formula's reference number.
    const eqno = token.type === 'math_block_eqno' ? String(token.info || '').trim() : '';
    const tag = eqno ? { value: eqno, star: false, eqno: true } : findTag(withoutLabels.text);
    let number = tag ? (tag.value || null) : null;
    let content = withoutLabels.text;
    if (!tag && numbering) {
      number = String(++counter);
      content += `${content.endsWith('\n') ? '' : '\n'}\\tag{${number}}`;
    }
    const names = [...new Set(withoutLabels.labels)];
    const tokenDuplicates = [];
    let anchor = null;
    for (const name of names) {
      if (labels.has(name)) {
        tokenDuplicates.push(name);
        duplicates.push(name);
        continue;
      }
      const entry = { label: name, number, anchor: `math-eq-${encodeURIComponent(name)}` };
      labels.set(name, entry);
      anchor ||= entry.anchor;
    }
    token.math = {
      content, number, labels: names, duplicates: tokenDuplicates, anchor,
      tag: tag ? { value: tag.value, star: tag.star, eqno: !!tag.eqno } : null,
      refs: []
    };
  }

  for (const token of mathTokens(tokens)) {
    // A label in an inline formula has no display number of its own. Remove it
    // rather than letting KaTeX fail, but do not register it: references point
    // at display equations, as they do in Typora.
    const base = token.math ? token.math.content : takeLabels(token.content).text;
    if (!token.math) {
      token.math = {
        content: base, number: null, labels: [], duplicates: [], anchor: null,
        tag: null, refs: []
      };
    }
    const refs = [];
    token.math.content = resolveReferences(base, labels, refs);
    token.math.refs = refs;
  }

  // Only a document that actually contains a math token contributes to the
  // global block signature. Ordinary documents keep the previous cache keys.
  const parts = [];
  for (const token of mathTokens(tokens)) {
    if (!token.math) continue;
    parts.push([
      token.type, token.math.number ?? '', token.math.labels.join(','),
      token.math.duplicates.join(',')
    ].join('\u0002'));
  }
  return {
    numbering, labels, duplicates,
    signature: parts.length ? `${numbering ? '1' : '0'}\u0003${parts.join('\u0001')}` : ''
  };
}

/** Prepare a single formula for a preview, without a document registry. */
export function prepareStandaloneMath(source, { labels = null, number = null } = {}) {
  const text = takeLabels(String(source ?? '')).text;
  const refs = [];
  let content = resolveReferences(text, labels, refs);
  if ((number !== null && number !== undefined && number !== '') && !findTag(content)) {
    content += `${content.endsWith('\n') ? '' : '\n'}\\tag{${number}}`;
  }
  return { content, refs };
}
