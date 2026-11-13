import { createMarkdownParser } from './markdown-parser.mjs';

const parser = createMarkdownParser();

// Keep the upstream grammar and record positions at the points where its
// actual image and reference rules accept a destination.
function wrapRule(ruler, name, wrap) {
  const { fn, alt } = ruler.__rules__.find(rule => rule.name === name);
  ruler.at(name, wrap(fn), { alt });
}

function destinationRange(source, start, end) {
  return source[start] === '<' ? [start + 1, end - 1] : [start, end];
}

function tableSource(line) {
  const escapedPipes = [];
  const text = line.replace(/\\\|/g, (_, index) => {
    escapedPipes.push(index - escapedPipes.length);
    return '|';
  });
  const originalOffset = offset => offset + escapedPipes.filter(index => index < offset).length;
  return { text, originalOffset };
}

wrapRule(parser.block.ruler, 'reference', original => (state, start, end, silent) => {
  if (silent) return original(state, start, end, silent);
  const helpers = state.md.helpers;
  let range;
  state.md.helpers = {
    ...helpers,
    parseLinkDestination(source, from, max) {
      const result = helpers.parseLinkDestination(source, from, max);
      if (result.ok) range = destinationRange(source, from, result.pos);
      return result;
    }
  };
  let matched;
  try {
    matched = original(state, start, end, silent);
  } finally {
    state.md.helpers = helpers;
  }
  if (matched && range) {
    const label = state.tokens.at(-1).meta.label;
    // Markdown-it uses the first valid definition for each label.
    if (!state.env.assetDefinitions.has(label)) state.env.assetDefinitions.set(label, range);
  }
  return matched;
});

wrapRule(parser.inline.ruler, 'image', original => (state, silent) => {
  const start = state.pos;
  const matched = original(state, silent);
  if (!matched || silent) return matched;
  const token = state.tokens.at(-1);
  if (token.meta?.label) return matched;
  const helpers = state.md.helpers;
  const afterLabel = helpers.parseLinkLabel(state, start + 1, false) + 1;
  let from = afterLabel + 1;
  while (from < state.pos && /[ \t\n]/.test(state.src[from])) from++;
  const parsed = helpers.parseLinkDestination(state.src, from, state.pos);
  if (parsed.ok && token.attrGet('src')) {
    token.meta = { assetRange: destinationRange(state.src, from, parsed.pos) };
  }
  return matched;
});

// Inline footnotes are parsed in a second inline state. Their destinations
// still belong to the enclosing token's source coordinates.
wrapRule(parser.inline.ruler, 'footnote_inline', original => (state, silent) => {
  const start = state.pos + 2;
  const matched = original(state, silent);
  if (matched && !silent) {
    const { id } = state.tokens.at(-1).meta;
    for (const token of state.env.footnotes.list[id].tokens) {
      if (token.meta?.assetRange) token.meta.assetRange = token.meta.assetRange.map(offset => start + offset);
    }
  }
  return matched;
});

// Match each inline token to the source lines the block parser assigned to
// it. Container prefixes (quote/list markers) are outside those slices.
// Table cells lack their own map, so walk them in source order within the row.
parser.core.ruler.before('footnote_tail', 'inkstone_asset_positions', state => {
  const lines = state.src.split('\n');
  const starts = [0];
  for (const line of lines) starts.push(starts.at(-1) + line.length + 1);
  let row = null;
  let rowCursor = 0;
  for (const token of state.tokens) {
    if (token.type === 'tr_open') {
      row = token.map;
      rowCursor = 0;
    }
    if (token.type === 'tr_close') row = null;
    if (token.type !== 'inline') continue;
    const map = token.map ?? row;
    if (!map) continue;
    const mapped = [];
    let offset = 0;
    for (const [index, line] of token.content.split('\n').entries()) {
      const lineNumber = map[0] + index;
      if (lineNumber >= map[1]) break;
      const { text: literal, originalOffset } = row
        ? tableSource(lines[lineNumber])
        : { text: lines[lineNumber], originalOffset: position => position };
      const from = literal.indexOf(line, row ? rowCursor : 0);
      if (from >= 0) {
        mapped.push({
          inlineStart: offset, length: line.length,
          sourceOffset: position => starts[lineNumber] + originalOffset(from + position)
        });
        if (row) rowCursor = from + line.length;
      }
      offset += line.length + 1;
    }
    const mapImage = image => {
      const range = image.meta?.assetRange;
      if (!range) return;
      const line = mapped.find(({ inlineStart, length }) => range[0] >= inlineStart && range[1] <= inlineStart + length);
      if (line) image.meta.documentRange = range.map(position => line.sourceOffset(position - line.inlineStart));
    };
    for (const child of token.children) {
      if (child.type === 'image') mapImage(child);
      if (child.type === 'footnote_ref') {
        for (const image of state.env.footnotes?.list?.[child.meta.id]?.tokens || []) mapImage(image);
      }
    }
  }
});

function assetName(src) {
  const match = /^(?:\.\/)?assets\/(.*)$/.exec(src || '');
  if (!match) return null;
  let name;
  try { name = decodeURI(match[1]); }
  catch { return null; }
  if (!name || name === '.' || name === '..' || /[/\\:\u0000]/.test(name)) return null;
  return name;
}

export function collectAssetReferences(content) {
  // Use Markdown-it's LF coordinate space, then map back to the exact input
  // so the original BOM and all line endings survive edits.
  const start = content.startsWith('\uFEFF') ? 1 : 0;
  const crlfPositions = [];
  const source = content.slice(start).replace(/\r\n|\r/g, (ending, offset) => {
    if (ending.length === 2) crlfPositions.push(offset - crlfPositions.length);
    return '\n';
  });
  const toOriginal = position => {
    let low = 0, high = crlfPositions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (crlfPositions[mid] < position) low = mid + 1;
      else high = mid;
    }
    return start + position + low;
  };
  const env = { assetDefinitions: new Map() };
  const references = new Map();
  for (const token of parser.parse(source, env)) {
    for (const image of token.children || []) {
      if (image.type !== 'image') continue;
      const src = image.attrGet('src');
      const name = assetName(src);
      if (!name) continue;
      const range = image.meta?.label ? env.assetDefinitions.get(image.meta.label) : image.meta?.documentRange;
      const from = range ? toOriginal(range[0]) : null;
      const to = range ? toOriginal(range[1]) : null;
      references.set(range ? from : Symbol(), { name, src, from, to, raw: range ? content.slice(from, to) : src });
    }
  }
  return [...references.values()];
}

export function rewriteAssetReferences(content, renamed, references) {
  if (!renamed.length) return content;
  references ??= collectAssetReferences(content);
  const replacements = new Map(renamed.map(({ from, to }) => [from, to]));
  const edits = references.filter(ref => ref.from !== null && (replacements.has(ref.raw) || replacements.has(ref.src)));
  if (!edits.length) return content;
  const parts = [];
  let cursor = 0;
  for (const ref of edits.sort((a, b) => a.from - b.from)) {
    parts.push(content.slice(cursor, ref.from), replacements.get(ref.raw) ?? replacements.get(ref.src));
    cursor = ref.to;
  }
  return parts.join('') + content.slice(cursor);
}
