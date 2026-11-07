/**
 * Locate the Markdown syntax characters inside one source line.
 *
 * The live-preview editor never hides syntax on the active block; instead it
 * dims these ranges so the text is still editable while reading like prose.
 * Offsets are UTF-16 code units relative to the line start, matching
 * CodeMirror document positions. Ranges are sorted and never overlap.
 */
const BLOCK_PREFIX = /^(\s{0,3})(?:#{1,6}(?=\s)|>+(?=\s|$)|(?:[-*+]|\d+[.)])(?=\s)|(?:```|~~~)[^\n]*|(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/;
const TASK_MARK = /^(\s{0,3})(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/;
const DELIMITERS = /[*_~=`$]/;

export function inlineMarks(line) {
  const ranges = [];
  const push = (from, to) => {
    if (to <= from || from < 0 || to > line.length) return;
    const last = ranges.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  };

  // A table delimiter row is pure syntax; a lone `-` is a list item, not a
  // table, so a pipe is required.
  if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')) return [{ from: 0, to: line.length }];

  let cursor = 0;
  const task = line.match(TASK_MARK);
  if (task) {
    push(0, task[0].length - 1);
    cursor = task[0].length;
  } else {
    const prefix = line.match(BLOCK_PREFIX);
    if (prefix) { push(0, prefix[0].length); cursor = prefix[0].length; }
  }

  while (cursor < line.length) {
    const rest = line.slice(cursor);
    const link = rest.match(/^(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/);
    if (link) {
      const textEnd = cursor + link[1].length + 1 + link[2].length;
      push(cursor, cursor + link[1].length + 1);
      push(textEnd, cursor + link[0].length);
      cursor += link[0].length;
      continue;
    }
    const tag = rest.match(/^<\/?[a-zA-Z][^>\n]*>/);
    if (tag) { push(cursor, cursor + tag[0].length); cursor += tag[0].length; continue; }
    const ticks = rest.match(/^(`+)/);
    if (ticks) {
      const closing = line.indexOf(ticks[1], cursor + ticks[1].length);
      if (closing > cursor) {
        push(cursor, cursor + ticks[1].length);
        push(closing, closing + ticks[1].length);
        cursor = closing + ticks[1].length;
        continue;
      }
    }
    const math = rest.match(/^(\${1,2})(?=\S)/);
    if (math) { push(cursor, cursor + math[1].length); cursor += math[1].length; continue; }
    if (DELIMITERS.test(line[cursor])) {
      let end = cursor;
      while (end < line.length && DELIMITERS.test(line[end])) end++;
      push(cursor, end);
      cursor = end;
      continue;
    }
    if (line[cursor] === '|') { push(cursor, cursor + 1); cursor++; continue; }
    cursor++;
  }
  return ranges;
}

/** Merge ranges from several lines into document-absolute decorations. */
export function marksForRange(doc, from, to) {
  const out = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    for (const mark of inlineMarks(line.text)) out.push({ from: line.from + mark.from, to: line.from + mark.to });
  }
  return out;
}
