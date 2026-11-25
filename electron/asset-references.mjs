import { parseFragment } from 'parse5';
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
  const helpers = state.md.helpers;
  const afterLabel = helpers.parseLinkLabel(state, start + 1, false) + 1;
  if (token.meta?.label) {
    if (state.env.allAssetReferences) token.meta.assetRange = [afterLabel, state.pos];
    return matched;
  }
  let from = afterLabel + 1;
  while (from < state.pos && /[ \t\n]/.test(state.src[from])) from++;
  const parsed = helpers.parseLinkDestination(state.src, from, state.pos);
  if (parsed.ok && token.attrGet('src')) {
    token.meta = { assetRange: destinationRange(state.src, from, parsed.pos) };
  }
  return matched;
});

wrapRule(parser.inline.ruler, 'html_inline', original => (state, silent) => {
  const start = state.pos;
  const matched = original(state, silent);
  if (matched && !silent && state.env.allAssetReferences) {
    state.tokens.at(-1).meta = { htmlStart: start };
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
      if (token.meta?.htmlStart !== undefined) token.meta.htmlStart += start;
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
    const htmlBlock = token.type === 'html_block' && state.env.allAssetReferences;
    if (token.type !== 'inline' && !htmlBlock) continue;
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
    const mapRange = range => {
      const offsets = range.map(position => {
        const line = mapped.find(({ inlineStart, length }) => position >= inlineStart && position <= inlineStart + length);
        return line?.sourceOffset(position - line.inlineStart);
      });
      if (offsets.every(Number.isInteger)) return offsets;
    };
    if (htmlBlock) {
      token.meta = { ...token.meta, htmlImages: htmlImageReferences(token.content, mapRange) };
      continue;
    }
    const htmlImages = [];
    const mapChildren = children => {
      for (const child of children) {
        const range = child.meta?.assetRange;
        if (child.type === 'image' && range) child.meta.documentRange = mapRange(range);
        if (child.type === 'footnote_ref') mapChildren(state.env.footnotes?.list?.[child.meta.id]?.tokens || []);
      }
      if (!state.env.allAssetReferences) return;
      const htmlTokens = children.filter(child => child.meta?.htmlStart !== undefined);
      if (!htmlTokens.some(child => /<img\b/i.test(child.content))) return;
      // Preserve source offsets while parsing tags together. This keeps inert
      // markup within comments, templates and other raw-text elements inert.
      let previousEnd = 0;
      const html = htmlTokens.map(child => {
        const start = child.meta.htmlStart;
        const part = ' '.repeat(Math.max(0, start - previousEnd)) + child.content;
        previousEnd = start + child.content.length;
        return part;
      }).join('');
      for (const image of htmlImageReferences(html, mapRange)) htmlImages.push(image);
    };
    mapChildren(token.children);
    if (htmlImages.length) token.meta = { ...token.meta, htmlImages };
  }
});

function htmlImageReferences(html, mapRange) {
  if (!/<img\b/i.test(html)) return [];
  const images = [];
  const nodes = [parseFragment(html, { sourceCodeLocationInfo: true })];
  while (nodes.length) {
    const node = nodes.pop();
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index--) nodes.push(children[index]);
    if (node.tagName !== 'img' || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const src = node.attrs.find(attribute => attribute.name === 'src')?.value;
    const location = node.sourceCodeLocation?.attrs?.src;
    if (!src || !location) continue;
    const { startOffset, endOffset } = location;
    const attribute = html.slice(startOffset, endOffset);
    const valueStart = /^src[\t\n\f\r ]*=[\t\n\f\r ]*/i.exec(attribute)?.[0].length;
    if (valueStart === undefined) continue;
    const quoted = attribute[valueStart] === '"' || attribute[valueStart] === "'";
    const range = mapRange([startOffset + valueStart + Number(quoted), endOffset - Number(quoted)]);
    images.push({ src, range });
  }
  return images;
}

function assetName(src) {
  const match = /^(?:\.\/)?assets\/(.*)$/.exec(src || '');
  if (!match) return null;
  let name;
  try { name = decodeURI(match[1]); }
  catch { return null; }
  if (!name || name === '.' || name === '..' || /[/\\:\u0000]/.test(name)) return null;
  return name;
}

export function collectAssetReferences(content, { all = false } = {}) {
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
  const env = { assetDefinitions: new Map(), allAssetReferences: all };
  const tokens = parser.parse(source, env);
  const linkLabels = new Set();
  if (all) {
    for (const token of tokens) {
      for (const link of token.children || []) {
        if (link.type === 'link_open' && link.meta?.label) linkLabels.add(link.meta.label);
      }
    }
  }
  const references = new Map();
  const addReference = (src, name, range, extra = {}) => {
    const from = range ? toOriginal(range[0]) : null;
    const to = range ? toOriginal(range[1]) : null;
    references.set(range ? from : Symbol(), { name, src, from, to, raw: range ? content.slice(from, to) : src, ...extra });
  };
  for (const token of tokens) {
    for (const image of token.children || []) {
      if (image.type !== 'image') continue;
      const src = image.attrGet('src');
      const name = assetName(src);
      if (!src || (!all && !name)) continue;
      const label = image.meta?.label;
      // A definition may also serve an ordinary link. Update just the image's
      // reference suffix in that case so the link still uses the original URL.
      if (linkLabels.has(label)) {
        addReference(src, name, image.meta?.documentRange, { inlineImageTitle: image.attrGet('title') || '' });
      } else {
        addReference(src, name, label ? env.assetDefinitions.get(label) : image.meta?.documentRange);
      }
    }
    for (const image of token.meta?.htmlImages || []) addReference(image.src, null, image.range);
  }
  const result = [...references.values()];
  return all ? result.sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity)) : result;
}

export function rewriteAssetReferences(content, renamed, references) {
  if (!renamed.length) return content;
  references ??= collectAssetReferences(content);
  const replacements = new Map(renamed.map(({ from, to }) => [from, to]));
  const edits = references.flatMap(ref => {
    const insert = replacements.get(ref.raw) ?? replacements.get(ref.src);
    return ref.from === null || insert === undefined ? [] : [{ ...ref, insert }];
  });
  return applyReferenceEdits(content, edits);
}

export function applyReferenceEdits(content, edits) {
  if (!edits.length) return content;
  const parts = [];
  let cursor = 0;
  for (const ref of edits.sort((a, b) => a.from - b.from)) {
    parts.push(content.slice(cursor, ref.from), ref.insert);
    cursor = ref.to;
  }
  return parts.join('') + content.slice(cursor);
}
