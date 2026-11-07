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

/** Find every GFM table and its exact [start, end) character range. */
export function parseTables(source) {
  const lines = linesOf(source);
  const tables = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].text.includes('|')) continue;
    const header = splitRow(lines[i].text);
    const delimiter = splitRow(lines[i + 1].text);
    if (header.length < 1 || delimiter.length !== header.length || !delimiter.every(cell => DELIMITER.test(cell))) continue;
    const rows = [header];
    let last = i + 1;
    for (let j = i + 2; j < lines.length; j++) {
      const text = lines[j].text;
      if (!text.trim() || !text.includes('|')) break;
      const cells = splitRow(text);
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

/** Serialize back to a readable, padded GFM table. */
export function serializeTable(table) {
  const columns = Math.max(1, table.aligns.length, ...table.rows.map(row => row.length));
  const rows = table.rows.map(row => Array.from({ length: columns }, (_, column) => escapeCell(row[column] ?? '')));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(3, ...rows.map(row => [...row[column]].length)));
  const line = cells => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  const aligns = Array.from({ length: columns }, (_, column) => ALIGN_MARKER[table.aligns[column]] || ALIGN_MARKER.null);
  return [line(rows[0]), line(aligns), ...rows.slice(1).map(line)].join('\n');
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
  const all = readColumnWidths(source);
  while (all.length <= index) all.push([]);
  all[index] = widths.map(value => Math.max(4, Math.min(95, Number(value) || 0)).toFixed(1));
  const payload = all.map(group => group.join(',')).join(';');
  const comment = `<!-- inkstone:columns ${payload} -->`;
  const match = WIDTH_COMMENT.exec(source);
  if (match) return { from: match.index, to: match.index + match[0].length, insert: comment };
  const trailing = /\s*$/.exec(source);
  return { from: trailing.index, to: source.length, insert: `${source.length ? '\n\n' : ''}${comment}\n` };
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
 * Editable ranges of one GFM table source line, relative to the line start.
 * Used by Tab / Shift+Tab to walk cells in source mode. Escaped pipes do not
 * start a new cell.
 */
export function tableCellRanges(text) {
  if (!/^\s*\|/.test(text)) return [];
  const bars = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '|') continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && text[back] === '\\'; back--) slashes++;
    if (slashes % 2 === 0) bars.push(index);
  }
  if (bars.length < 2) return [];
  const cells = [];
  for (let index = 0; index < bars.length - 1; index++) {
    let from = bars[index] + 1, to = bars[index + 1];
    while (from < to && /\s/u.test(text[from])) from++;
    while (to > from && /\s/u.test(text[to - 1])) to--;
    cells.push({ from, to });
  }
  return cells;
}
