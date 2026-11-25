const FORMAT_RULES = new Set(['emphasis', 'strikethrough', 'mark']);

// Markdown-it locates block tokens by line. Record the accepted inline syntax
// as well so the capture can keep whole images and preserve cut-through marks.
export function installSelectionPositions(parser) {
  const ruler = parser.inline.ruler;
  for (const name of ['image', 'html_inline', 'backticks', ...FORMAT_RULES]) {
    const { fn, alt } = ruler.__rules__.find(rule => rule.name === name);
    ruler.at(name, (state, silent) => {
      const spans = state.env.selectionSpans;
      if (silent || !spans) return fn(state, silent);
      const start = state.pos;
      const first = state.tokens.length;
      const matched = fn(state, silent);
      if (!matched) return false;
      if (FORMAT_RULES.has(name)) {
        // Each delimiter run emits one token per marker. Walk backwards to
        // ignore any preceding plain text the rule happened to flush.
        let end = state.pos;
        for (let index = state.tokens.length - 1; index >= first && end > start; index--) {
          const token = state.tokens[index];
          const left = end - token.content.length;
          spans.set(token, [left, end]);
          end = left;
        }
      } else if (state.tokens.length > first) {
        const token = state.tokens.at(-1);
        if (token.type === 'image' || token.type === 'code_inline' || /^<img\b/i.test(token.content)) {
          spans.set(token, [start, state.pos]);
        }
      }
      return true;
    }, { alt });
  }

  // Task lists remove their checkbox marker from inline content after parsing.
  // Keep the original inline source for the positions recorded above.
  parser.core.ruler.before('inline', 'inkstone_selection_source', ({ tokens, env }) => {
    if (!env.selectionSources) return;
    for (const token of tokens) {
      if (token.type === 'inline') env.selectionSources.set(token, token.content);
    }
  });
}

const COMPLETE_OBJECTS = new Set(['table_open', 'math_block', 'math_block_eqno']);

function codeFragment(source) {
  if (!source.trim()) return source.length ? `<code>${source}</code>` : '';
  let width = 1;
  for (const run of source.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1);
  const ticks = '`'.repeat(width);
  return `${ticks} ${source} ${ticks}`;
}

function inlineSelection(source, children, spans, [first, last]) {
  const edits = [];
  const openings = [];
  const bound = position => Math.min(last, Math.max(first, position));
  for (const child of children) {
    const span = spans.get(child);
    if (!span) continue;
    if (child.type === 'code_inline' && span[0] < last && span[1] > first && (first > span[0] || last < span[1])) {
      const left = Math.max(first, span[0] + child.markup.length);
      const right = Math.min(last, span[1] - child.markup.length);
      edits.push({ from: span[0], to: span[1], insert: codeFragment(source.slice(left, right)) });
    }
    if (!child.nesting) continue;
    if (child.nesting === 1) {
      openings.push(span[1]);
      continue;
    }
    const openEnd = openings.pop();
    const openStart = openEnd - child.markup.length;
    const closeStart = span[0];
    const closeEnd = closeStart + child.markup.length;
    if (openStart >= last || closeEnd <= first || (first <= openStart && last >= closeEnd)) continue;
    // Strong tokens carry the inner character's span. `markup.length` above
    // also covers the adjacent character consumed by the same delimiter.
    const keepText = first < closeStart && last > openEnd;
    edits.push(
      { from: openStart, to: openEnd, insert: keepText ? `<${child.tag}>` : '' },
      { from: closeStart, to: closeEnd, insert: keepText ? `</${child.tag}>` : '' }
    );
  }
  // Insert only formatting tags and selected source text. When both ends of
  // nested formatting are clipped, their original order still matters.
  let content = '';
  let cursor = first;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    content += source.slice(cursor, bound(edit.from)) + edit.insert;
    cursor = bound(edit.to);
  }
  return content + source.slice(cursor, last);
}

/** Project the document's tokens onto an LF range, leaving original tokens
 * with contextual Markdown (list numbers, references, math) wherever possible. */
export function selectMarkdownTokens(parser, tokens, env, text, from, to, isDiagram) {
  const lines = text.split('\n');
  const starts = [0];
  for (const line of lines) starts.push(starts.at(-1) + line.length + 1);

  // Match lines after Markdown-it has removed container prefixes and leading
  // indentation. The inline content is the tail of each line, except for an
  // ATX heading's optional closing hashes and a tab expanded to spaces.
  function clip(content, lineIndex, heading = false) {
    let offset = 0;
    let first = null;
    let last = null;
    for (const line of content.split('\n')) {
      let raw = lines[lineIndex];
      if (raw === undefined) break;
      if (heading) raw = raw.replace(/[ \t]+#+[ \t]*$/, '');
      const literal = raw.includes(line) ? line : line.trimStart();
      const column = raw.lastIndexOf(literal);
      if (column >= 0 && literal) {
        const start = starts[lineIndex] + column;
        const end = start + literal.length;
        const left = Math.max(from, start);
        const right = Math.min(to, end);
        if (left < right) {
          const inlineOffset = offset + line.length - literal.length - start;
          first ??= left + inlineOffset;
          last = right + inlineOffset;
        }
      }
      offset += line.length + 1;
      lineIndex++;
    }
    return first === null ? null : [first, last];
  }

  function withWholeImages(range, children) {
    if (!range) return null;
    const [first, last] = range;
    for (const child of children) {
      if (child.type !== 'image' && child.type !== 'html_inline') continue;
      const span = env.selectionSpans.get(child);
      if (span && span[0] < last && span[1] > first) {
        range[0] = Math.min(range[0], span[0]);
        range[1] = Math.max(range[1], span[1]);
      }
    }
    return range;
  }

  function clipLeaf(token, parent) {
    const [line] = token.map;
    if (token.type === 'inline') {
      const raw = env.selectionSources.get(token) ?? token.content;
      const range = withWholeImages(clip(raw, line, parent?.markup.startsWith('#')), token.children);
      if (!range) return null;
      const content = raw.slice(...range);
      if (content === raw) return token;
      const selected = inlineSelection(raw, token.children, env.selectionSpans, range);
      if (!selected) return null;
      const fragmentEnv = { references: env.references, chrome: false };
      if (env.footnotes?.refs) {
        fragmentEnv.footnotes = {
          refs: { ...env.footnotes.refs },
          list: env.footnotes.list?.map(note => ({ label: note.label, count: 0 }))
        };
      }
      const [inline] = parser.parseInline(selected, fragmentEnv);
      return { ...token, content, children: inline.children };
    }
    if (['fence', 'code_block', 'html_block'].includes(token.type)) {
      // Fence delimiters and the language badge are separate from code text.
      // Ordinary code respects the exact range, even across multiple lines.
      const bodyLine = token.type === 'fence' ? line + 1 : line;
      let range = clip(token.content, bodyLine);
      if (range && token.type === 'html_block' && /<img\b/i.test(token.content)) {
        const children = [];
        parser.inline.parse(token.content, parser, { selectionSpans: env.selectionSpans }, children);
        range = withWholeImages(range, children);
      }
      if (!range) return null;
      return { ...token, content: token.content.slice(...range) };
    }
    return token;
  }

  // Record balanced token runs once. Trimming a list or quote can then keep
  // its wrapper while dropping every unselected nested paragraph or item.
  const ends = new Map();
  const openings = [];
  for (const [index, token] of tokens.entries()) {
    if (token.nesting === 1) openings.push(index);
    if (token.nesting === -1) ends.set(openings.pop(), index);
  }

  function project(first, last, parent = null) {
    const result = [];
    for (let index = first; index < last;) {
      const token = tokens[index];
      const close = ends.get(index) ?? index;
      const start = token.map ? starts[token.map[0]] : Infinity;
      const end = token.map ? Math.min(text.length, starts[token.map[1]] - 1) : -Infinity;
      // The footnote plugin moves definitions to a wrapper at the end. Its
      // paragraphs keep their source maps even though the wrappers have none.
      const footnoteScope = token.type === 'footnote_block_open' || token.type === 'footnote_open';
      if (footnoteScope || (start < to && end > from)) {
        const atomic = COMPLETE_OBJECTS.has(token.type) || (token.type === 'fence' && isDiagram(token.info));
        if (atomic || (token.map && from <= start && end <= to)) {
          for (let at = index; at <= close; at++) {
            if (tokens[at].type !== 'footnote_anchor') result.push(tokens[at]);
          }
        } else if (close > index) {
          const content = project(index + 1, close, token);
          if (content.length) {
            if (token.type === 'ordered_list_open' && content[0].type === 'list_item_open') {
              let skipped = 0;
              for (let item = index + 1; item < close && tokens[item] !== content[0]; item = (ends.get(item) ?? item) + 1) {
                if (tokens[item].type === 'list_item_open') skipped++;
              }
              if (skipped > 0) token.attrSet('start', String(Number(token.attrGet('start') ?? 1) + skipped));
            }
            result.push(token);
            for (const child of content) result.push(child);
            result.push(tokens[close]);
          }
        } else {
          const leaf = clipLeaf(token, parent);
          if (leaf) result.push(leaf);
        }
      }
      index = close + 1;
    }
    return result;
  }

  return project(0, tokens.length);
}
