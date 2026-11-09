/**
 * GFM table editing helpers.
 *
 * Pure string <-> structure conversion so the dialog can be tested in Node.
 * The Markdown source stays the single source of truth: editing a rendered
 * table rewrites exactly the character range of that table, nothing else.
 */

const DELIMITER = /^:?-{1,}:?$/;
const ALIGN_MARKER = { left: ':---', center: ':---:', right: '---:', null: '---' };

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { buffer += '\\|'; i++; continue; }
    if (text[i] === '|') { cells.push(buffer.trim()); buffer = ''; continue; }
    buffer += text[i];
  }
  cells.push(buffer.trim());
  return cells;
}

const alignmentOf = cell => {
  const left = cell.startsWith(':'), right = cell.endsWith(':');
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null;
};

/**
 * Container prefix of a table row: list indentation and blockquote markers.
 * A table may live inside `> …` or an indented list item, so the row's cells
 * only start after this prefix and edits must never touch it.
 */
export function rowPrefix(text) {
  // A UTF-8 BOM is part of the first line's source, never of its cells.
  return /^[\uFEFF \t]*(?:>[ \t]?)*/.exec(text)[0];
}

/**
 * Row prefix that may be repeated on every regenerated line: the container
 * markers only. The BOM belongs to the document head, so copying the first
 * line's prefix verbatim would leave one BOM in front of every row and no
 * renderer would recognise the table any more.
 */
export function containerPrefix(text) {
  return rowPrefix(text).replace(/^\uFEFF/, '');
}

const bodyOf = text => text.slice(rowPrefix(text).length);

function linesOf(source) {
  const lines = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline;
    const raw = source.slice(start, end);
    lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, start, end });
    start = end + 1;
  }
  return lines;
}

/**
 * Find every GFM table and its exact [start, end) character range.
 * Fenced code is literal text: a sample table inside a fence is not a table,
 * otherwise every later table index (and its stored column widths) shifts.
 */
export function parseTables(source) {
  const lines = linesOf(source);
  const tables = [];
  let fence = null;
  for (let i = 0; i + 1 < lines.length; i++) {
    const body = bodyOf(lines[i].text);
    if (fence) {
      const closing = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`);
      if (closing.test(body.trim())) fence = null;
      continue;
    }
    const opening = /^(`{3,}|~{3,})/.exec(body);
    if (opening) { fence = opening[1]; continue; }
    if (!body.includes('|')) continue;
    const header = splitRow(body);
    const delimiter = splitRow(bodyOf(lines[i + 1].text));
    if (header.length < 1 || delimiter.length !== header.length || !delimiter.every(cell => DELIMITER.test(cell))) continue;
    const rows = [header];
    let last = i + 1;
    for (let j = i + 2; j < lines.length; j++) {
      const row = bodyOf(lines[j].text);
      if (!row.trim() || !row.includes('|')) break;
      const cells = splitRow(row);
      if (cells.every(cell => DELIMITER.test(cell))) break;
      rows.push(Array.from({ length: header.length }, (_, column) => cells[column] ?? ''));
      last = j;
    }
    tables.push({ start: lines[i].start, end: lines[last].end, rows, aligns: delimiter.map(alignmentOf) });
    i = last;
  }
  return tables;
}

const escapeCell = value => String(value ?? '').replace(/(?<!\\)\|/g, '\\|');

/**
 * Serialize back to a readable, padded GFM table.
 *
 * `prefix` is the row prefix of the block container (blockquote markers, list
 * indentation). Reordering a quoted or indented table rewrites its whole
 * source range, so every regenerated line has to keep that prefix.
 */
export function serializeTable(table, prefix = '', eol = '\n') {
  const columns = Math.max(1, table.aligns.length, ...table.rows.map(row => row.length));
  const rows = table.rows.map(row => Array.from({ length: columns }, (_, column) => escapeCell(row[column] ?? '')));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(3, ...rows.map(row => [...row[column]].length)));
  const line = cells => `${prefix}| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  const aligns = Array.from({ length: columns }, (_, column) => ALIGN_MARKER[table.aligns[column]] || ALIGN_MARKER.null);
  return [line(rows[0]), line(aligns), ...rows.slice(1).map(line)].join(eol);
}

const clone = table => ({ ...table, rows: table.rows.map(row => [...row]), aligns: [...table.aligns] });
const width = table => Math.max(1, ...table.rows.map(row => row.length), table.aligns.length);

export function setCell(table, row, column, value) {
  const next = clone(table);
  if (next.rows[row]) next.rows[row][column] = String(value ?? '');
  return next;
}

export function insertRow(table, at = table.rows.length) {
  const next = clone(table);
  next.rows.splice(Math.min(Math.max(at, 1), next.rows.length), 0, Array(width(table)).fill(''));
  return next;
}

export function removeRow(table, index) {
  const next = clone(table);
  if (index < 1 || index >= next.rows.length || next.rows.length <= 2) return next;
  next.rows.splice(index, 1);
  return next;
}

export function insertColumn(table, at = table.aligns.length) {
  const next = clone(table);
  const column = Math.min(Math.max(at, 0), width(next));
  next.aligns.splice(column, 0, null);
  for (const row of next.rows) row.splice(column, 0, '');
  return next;
}

export function removeColumn(table, index) {
  const next = clone(table);
  if (index < 0 || index >= width(next) || width(next) <= 1) return next;
  next.aligns.splice(index, 1);
  for (const row of next.rows) row.splice(index, 1);
  return next;
}

export function setAlignment(table, index, alignment) {
  const next = clone(table);
  if (index >= 0 && index < next.aligns.length) next.aligns[index] = ['left', 'center', 'right'].includes(alignment) ? alignment : null;
  return next;
}

/**
 * Move one data row to a new index in the same rows array.
 *
 * The header row (0) and the delimiter row are syntax, not data: the header
 * never moves and `serializeTable` always regenerates the delimiter from the
 * alignments, so a reorder can never turn the table into a paragraph.
 */
export function moveRow(table, from, to) {
  const next = clone(table);
  if (from < 1 || from >= next.rows.length || to < 1 || to >= next.rows.length || from === to) return next;
  const [row] = next.rows.splice(from, 1);
  next.rows.splice(to, 0, row);
  return next;
}

/** Move a whole column: its alignment, every cell and (separately) its width. */
export function moveColumn(table, from, to) {
  const next = clone(table);
  const columns = width(next);
  if (from < 0 || from >= columns || to < 0 || to >= columns || from === to) return next;
  while (next.aligns.length < columns) next.aligns.push(null);
  for (const row of next.rows) while (row.length < columns) row.push('');
  const [align] = next.aligns.splice(from, 1);
  next.aligns.splice(to, 0, align);
  for (const row of next.rows) {
    const [cell] = row.splice(from, 1);
    row.splice(to, 0, cell);
  }
  return next;
}

/** Permute one table's stored column widths so a moved column keeps its width. */
export function moveColumnWidths(widths, from, to) {
  const next = (widths || []).slice();
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [value] = next.splice(from, 1);
  next.splice(to, 0, value);
  return next;
}

/**
 * Final index of an item removed from `from` and dropped into `slot`.
 * A drop in the item's own place (`slot` or `slot + 1`) maps back to itself,
 * which is what makes "drop it back where it was" a no-op instead of an edit.
 */
export const dropIndex = (from, slot) => (slot > from ? slot - 1 : slot);

const sameTable = (a, b) => a.rows.length === b.rows.length
  && a.aligns.length === b.aligns.length
  && a.rows.every((row, index) => row.length === b.rows[index].length && row.every((cell, column) => cell === b.rows[index][column]))
  && a.aligns.every((align, index) => align === b.aligns[index]);

/**
 * Column widths have no GFM syntax. One invisible HTML comment at the end of
 * the document carries them in a form every other Markdown editor ignores,
 * so a dragged column survives save / reopen / export instead of being lost.
 */
const WIDTH_COMMENT = /<!--\s*inkstone:columns\s+([\d.,;\s]*)-->/;

export function readColumnWidths(source) {
  const match = WIDTH_COMMENT.exec(source);
  if (!match) return [];
  return String(match[1]).split(';').map(group => group.split(',').map(Number).filter(value => Number.isFinite(value) && value > 0));
}

/** Return a single minimal edit that stores one table's widths as percentages. */
export function columnWidthEdit(source, index, widths) {
  const match = WIDTH_COMMENT.exec(source);
  // Untouched groups keep their stored text: moving one table's column must not
  // rewrite another table's widths into a different (but equal) form.
  const groups = match ? match[1].split(';').map(group => group.trim()) : [];
  while (groups.length <= index) groups.push('');
  groups[index] = widths.map(value => Math.max(4, Math.min(95, Number(value) || 0)).toFixed(1)).join(',');
  const comment = `<!-- inkstone:columns ${groups.join(';')} -->`;
  if (match) return { from: match.index, to: match.index + match[0].length, insert: comment };
  const trailing = /\s*$/.exec(source);
  return { from: trailing.index, to: source.length, insert: `${source.length ? '\n\n' : ''}${comment}\n` };
}

/**
 * One atomic edit that moves a data row or a whole column of table `index`.
 *
 * `slot` is an insertion slot in the same index space as `from` (the source
 * row / column the moved item lands before), so dropping an item back where it
 * came from returns no changes and the caller writes nothing — no document
 * change, no undo step.
 *
 * `block` is the exact source range the renderer produced for this table
 * (`tableSourceRanges`). The model parser is only trusted inside it: a heading
 * such as `# H | Q` under a table looks like another row to the model but is a
 * separate block, and a reorder must never overwrite it. Without a block the
 * model's own range is used, which is only correct for callers that already
 * know the table stands alone.
 *
 * A column carries its alignment and, when the document stores widths, its
 * width. Those widths live in one trailing comment, so the table range and the
 * comment range are returned as changes of the same transaction: a single
 * undo restores the table and its widths together.
 */
export function tableMoveEdit(source, index, kind, from, slot, block = null) {
  if (kind !== 'row' && kind !== 'column') return [];
  let table, base = 0;
  if (block) {
    const slice = source.slice(block.start, block.end);
    const inner = parseTables(slice);
    // The renderer's block map and the model must describe the same table.
    // When they disagree nothing is written, so a pseudo-table can never be
    // turned into data or overwrite a neighbouring block.
    if (inner.length !== 1 || inner[0].start !== 0 || inner[0].end !== slice.length) return [];
    table = inner[0];
    base = block.start;
  } else {
    table = parseTables(source)[index];
    if (!table) return [];
  }
  const to = dropIndex(from, slot);
  if (to === from) return [];
  const next = kind === 'row' ? moveRow(table, from, to) : moveColumn(table, from, to);
  const start = base + table.start, end = base + table.end;
  const range = source.slice(start, end);
  const eol = range.includes('\r\n') ? '\r\n' : '\n';
  // A line's range ends on its "\n", so a CRLF table's range keeps a trailing
  // "\r". Leave that carriage return in place: the regenerated lines already
  // use the table's own newline style.
  const until = range.endsWith('\r') ? end - 1 : end;
  // The BOM is part of the first line, but it belongs to the document head:
  // keep it once, at absolute offset 0, and never on a table that merely follows
  // text (including the fallback model path, which has no block offset).
  const bom = start === 0 && source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const changes = sameTable(next, table)
    ? []
    : [{ from: start, to: until, insert: bom + serializeTable(next, containerPrefix(range), eol) }];
  if (kind === 'column') {
    // Identical columns produce an identical table (see `sameTable`), but the
    // widths are still per column: without this branch a swap of two equal
    // columns would silently keep the old widths.
    const stored = readColumnWidths(source)[index] || [];
    if (stored.length === width(table)) {
      const moved = moveColumnWidths(stored, from, to);
      if (moved.some((value, at) => value !== stored[at])) {
        const widthEdit = columnWidthEdit(source, index, moved);
        // The width comment normally lives after the document, but the same text
        // can also sit inside a cell as ordinary content. Rewriting it there
        // would overlap the table range — two changes on one range, which the
        // editor applies as a duplicated comment. In that case the text is just
        // cell content and moves with its column; no second change is created.
        const overlaps = widthEdit.from < until && widthEdit.to > start;
        if (!overlaps) changes.push(widthEdit);
      }
    }
    // Metadata whose length does not match the columns no longer describes
    // this table. Permuting it with clamped indices would move unrelated
    // columns, so it is left exactly as stored instead.
  }
  return changes.sort((a, b) => a.from - b.from);
}

/** Insert <colgroup> into rendered tables so saved widths actually apply. */
export function injectColumnWidths(html, widths, offset = 0) {
  if (!widths?.length) return html;
  let index = offset;
  return html.replace(/<table\b[^>]*>/g, tag => {
    const columns = widths[index++] || [];
    if (!columns.length) return tag;
    const total = columns.reduce((sum, value) => sum + value, 0) || 100;
    const group = `<colgroup>${columns.map(value => `<col style="width:${(value * 100 / total).toFixed(1)}%">`).join('')}</colgroup>`;
    return tag + group;
  });
}

/**
 * Source range of one rendered cell inside its table's source.
 *
 * `source` is the table's exact source range and `rowIndex` counts rendered
 * rows (0 is the header), so the delimiter row is source line 1 but never a
 * row. The returned `from`/`to` are relative to `source`; the commit writes
 * exactly that range, which is what keeps the container prefix, alignment and
 * escaped pipes untouched.
 */
export function cellSourceRange(source, rowIndex, column) {
  let lineIndex = rowIndex === 0 ? 0 : rowIndex + 1;
  let offset = 0;
  for (let index = 0; index < lineIndex; index++) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) return null;
    offset = newline + 1;
  }
  const end = source.indexOf('\n', offset);
  const line = source.slice(offset, end < 0 ? source.length : end);
  const range = tableCellRanges(line, { optionalOuterPipes: true })[column];
  if (!range) return null;
  return { lineIndex, from: offset + range.from, to: offset + range.to, markdown: line.slice(range.from, range.to) };
}

/**
 * The text an in-place cell editor writes back: one line, no unescaped pipes
 * (a pasted `|` must not split the row) and no surrounding whitespace.
 * Existing escapes are kept exactly as typed.
 */
export function normalizeCellMarkdown(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/(?<!\\)\|/g, '\\|')
    .trim();
}

/**
 * Editable ranges of one GFM table source line, relative to the line start.
 *
 * The split follows the renderer instead of approximating it:
 * - a pipe starts a new cell unless the character immediately before it is a
 *   backslash (markdown-it's `escapedSplit`, which also treats `\\|` as an
 *   escaped pipe instead of counting backslashes);
 * - outer pipes are optional on either side, because GFM accepts `A | B` and
 *   `| A | B`; an empty leading/trailing segment produced by an outer pipe is
 *   dropped exactly like the renderer does.
 *
 * `optionalOuterPipes` is opt-in. Source-mode Tab calls this without it, so a
 * prose line such as `a | b` can never capture Tab; callers that already know
 * the line belongs to a GFM table (the in-place cell editor) pass `true`.
 */
export function tableCellRanges(text, { optionalOuterPipes = false } = {}) {
  const prefix = rowPrefix(text);
  const body = text.slice(prefix.length);
  const start = /^\s*/.exec(body)[0].length;
  // Keep the strict form for unspecified callers: a table row in source mode
  // still has to start with a pipe, otherwise ordinary prose with a pipe would
  // steal Tab / Enter.
  if (!optionalOuterPipes && body[start] !== '|') return [];
  // The renderer trims the whole row before splitting it.
  const end = body.length - /[ \t]*$/.exec(body)[0].length;
  if (start >= end) return [];
  const content = body.slice(start, end);
  const bars = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '|' && (index === 0 || content[index - 1] !== '\\')) bars.push(index);
  }
  if (!optionalOuterPipes && bars.length < 2) return [];
  const segments = [];
  let last = 0;
  for (const bar of bars) {
    segments.push([last, bar]);
    last = bar + 1;
  }
  segments.push([last, content.length]);
  // Outer pipes only create empty edge columns; a missing outer pipe does not.
  if (segments.length && segments[0][0] === segments[0][1]) segments.shift();
  if (segments.length && segments[segments.length - 1][0] === segments[segments.length - 1][1]) segments.pop();
  const cells = [];
  for (const [from, to] of segments) {
    let cellFrom = from, cellTo = to;
    while (cellFrom < cellTo && /\s/u.test(content[cellFrom])) cellFrom++;
    while (cellTo > cellFrom && /\s/u.test(content[cellTo - 1])) cellTo--;
    // Ranges stay relative to the whole line so callers can slice it directly.
    cells.push({ from: prefix.length + start + cellFrom, to: prefix.length + start + cellTo });
  }
  return cells;
}
