/**
 * Reorder whole Markdown sections by dragging outline entries. A section is
 * a top-level heading plus everything up to the next heading of the same or
 * higher level, so moving a parent carries all of its subsections with it.
 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function parseSections(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(eol);
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(HEADING);
    if (match) headings.push({ index, level: match[1].length, title: match[2], line: index + 1 });
  }
  const base = headings.length ? Math.min(...headings.map(item => item.level)) : 0;
  const tops = headings.filter(item => item.level === base);
  const sections = tops.map((item, order) => ({
    ...item,
    end: order + 1 < tops.length ? tops[order + 1].index : lines.length,
    lines: lines.slice(item.index, order + 1 < tops.length ? tops[order + 1].index : lines.length)
  }));
  // Map every visible outline entry to the top-level section that owns it.
  const owners = headings.map(item => {
    let owner = 0;
    for (let order = 0; order < tops.length; order++) if (tops[order].index <= item.index) owner = order;
    return owner;
  });
  return {
    eol, lines, headings, sections, owners,
    preamble: lines.slice(0, headings.length ? headings[0].index : lines.length)
  };
}

/** Move section `from` so it sits at position `to`. Returns the new source. */
export function moveSection(source, from, to) {
  const { eol, preamble, sections } = parseSections(source);
  if (!sections.length || !Number.isInteger(from) || !Number.isInteger(to)) return source;
  if (from < 0 || to < 0 || from >= sections.length || to >= sections.length || from === to) return source;
  const blocks = sections.map(section => section.lines);
  const [moved] = blocks.splice(from, 1);
  blocks.splice(to, 0, moved);
  return [...preamble, ...blocks.flat()].join(eol);
}
