import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTables, serializeTable, setCell, insertRow, removeRow,
  insertColumn, removeColumn, setAlignment, tableCellRanges,
  readColumnWidths, columnWidthEdit, injectColumnWidths, rowPrefix, containerPrefix,
  cellSourceRange, normalizeCellMarkdown,
  moveRow, moveColumn, moveColumnWidths, dropIndex, tableMoveEdit
} from '../src/table.js';
import { tableSourceRanges } from '../src/markdown.js';

const sample = '| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 5 |\n';

test('parseTables locates a table and its exact source range', () => {
  const source = `前言\n\n${sample}\n结尾\n`;
  const tables = parseTables(source);
  assert.equal(tables.length, 1);
  assert.equal(source.slice(tables[0].start, tables[0].end), sample.trimEnd());
  assert.deepEqual(tables[0].aligns, ['left', 'right']);
  assert.deepEqual(tables[0].rows, [['名称', '数量'], ['苹果', '3'], ['梨', '5']]);
});

test('parseTables handles multiple tables, no outer pipes and CRLF', () => {
  const source = 'A | B\r\n--- | ---\r\n1 | 2\r\n\r\n| C | D |\r\n| --- | --- |\r\n| 3 | 4 |';
  const tables = parseTables(source);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].rows, [['A', 'B'], ['1', '2']]);
  assert.deepEqual(tables[1].rows, [['C', 'D'], ['3', '4']]);
  assert.equal(source.slice(tables[1].start, tables[1].end), '| C | D |\r\n| --- | --- |\r\n| 3 | 4 |');
});

test('parseTables ignores non-tables and escaped pipes', () => {
  assert.deepEqual(parseTables('# 标题\n\n普通段落 | 文字\n\n---\n'), []);
  const tables = parseTables('| A | B |\n| --- | --- |\n| x \\| y | z |');
  assert.deepEqual(tables[0].rows[1], ['x \\| y', 'z']);
  assert.match(serializeTable(tables[0]), /x \\\| y/);
});

test('serializeTable keeps alignment and is re-parseable', () => {
  const table = parseTables(sample)[0];
  const roundTrip = parseTables(serializeTable(table))[0];
  assert.deepEqual(roundTrip.rows, table.rows);
  assert.deepEqual(roundTrip.aligns, table.aligns);
});

test('parseTables skips example tables inside fenced code', () => {
  const source = '```md\n| a | b |\n| --- | --- |\n```\n\n| c | d |\n| --- | --- |\n| 1 | 2 |\n\n~~~\n| e | f |\n| --- | --- |\n~~~\n';
  const tables = parseTables(source);
  assert.equal(tables.length, 1, '代码围栏内的示例表格不得计入序号');
  assert.deepEqual(tables[0].rows, [['c', 'd'], ['1', '2']]);
  assert.equal(source.slice(tables[0].start, tables[0].end), '| c | d |\n| --- | --- |\n| 1 | 2 |');
  // An unterminated fence swallows the rest of the source, like a renderer does.
  assert.deepEqual(parseTables('```\n| a | b |\n| --- | --- |\n'), []);
});

test('parseTables finds tables inside blockquotes and list items', () => {
  const quoted = parseTables('> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n')[0];
  assert.deepEqual(quoted.rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(tableCellRanges('> | a | b |'), [{ from: 4, to: 5 }, { from: 8, to: 9 }], '单元格区间要跳过引用前缀');

  const listed = parseTables('- 列表\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n')[0];
  assert.deepEqual(listed.rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(tableCellRanges('  | a | b |'), [{ from: 4, to: 5 }, { from: 8, to: 9 }], '单元格区间要跳过列表缩进');
  assert.equal(rowPrefix('> - 列表'), '> ');
  assert.equal(rowPrefix('| a | b |'), '');
  assert.deepEqual(tableCellRanges('普通段落'), []);
});

test('tableCellRanges follows the renderer for optional outer pipes and consecutive slashes', () => {
  const cells = (line, optional = true) => tableCellRanges(line, { optionalOuterPipes: optional}).map(cell => line.slice(cell.from, cell.to));
  assert.deepEqual(cells('A | B'), ['A', 'B']);
  assert.deepEqual(cells('| A | B'), ['A', 'B'], '缺少尾部竖线时仍有两格');
  assert.deepEqual(cells('A | B |'), ['A', 'B'], '缺少首部竖线时仍有两格');
  assert.deepEqual(cells('| A | B |'), ['A', 'B']);
  assert.deepEqual(cells('| A || B |'), ['A', '', 'B'], '相邻竖线中间的空格必须保留为第三列');
  assert.deepEqual(tableCellRanges('A | B'), [], '普通含竖线的段落不得抢占源码模式的 Tab');
  assert.deepEqual(tableCellRanges('> 普通 | 文字'), [], '引用内的普通段落也不得抢占 Tab');
  assert.deepEqual(tableCellRanges('| A | B'), [{ from: 2, to: 3 }, { from: 6, to: 7 }]);
  // markdown-it's escapedSplit only looks at the character right before a
  // pipe, so two backslashes still escape it (parity would split the cell).
  const slash = '\\';
  const row = '| a ' + slash + slash + '| b | c |';
  const parsed = parseTables('| H1 | H2 |\n| --- | --- |\n' + row + '\n')[0];
  assert.equal(parsed.rows[1].length, 2, '模型与渲染一致地看成两列');
  assert.deepEqual(cells(row), ['a ' + slash + slash + '| b', 'c'], '连续反斜杠后的竖线属于单元格内容');
  assert.equal(tableCellRanges(row).length, 2, '严格模式也必须与渲染列数一致');
});

test('cellSourceRange describes exactly one rendered cell, prefix and escapes included', () => {
  const source = '> | A | B |\n> | --- | --- |\n> | x \\| y | **b** |';
  assert.deepEqual(cellSourceRange(source, 0, 0), { lineIndex: 0, from: 4, to: 5, markdown: 'A' });
  const escaped = cellSourceRange(source, 1, 0);
  assert.equal(escaped.lineIndex, 2);
  assert.equal(escaped.markdown, 'x \\| y', '转义竖线不得把单元格切开');
  assert.equal(source.slice(escaped.from, escaped.to), 'x \\| y');
  assert.equal(source.slice(escaped.from - 4, escaped.from), '> | ');
  assert.equal(cellSourceRange(source, 1, 1).markdown, '**b**');
  assert.equal(cellSourceRange(source, 0, 2), null);
  assert.equal(cellSourceRange(source, 9, 0), null);
  // Optional outer pipes are the common GFM form; the cell range must still
  // address the rendered column instead of the whole line.
  const plain = 'A | B\n--- | ---\nleft | right';
  assert.equal(cellSourceRange(plain, 1, 0).markdown, 'left');
  assert.equal(cellSourceRange(plain, 1, 1).markdown, 'right');
  assert.equal(cellSourceRange(plain, 0, 1).markdown, 'B');
  assert.equal(cellSourceRange(plain, 1, 2), null);
  const slash = '\\';
  const slashed = '| H1 | H2 |\n| --- | --- |\n| a ' + slash + slash + '| b | c |';
  assert.equal(cellSourceRange(slashed, 1, 0).markdown, 'a ' + slash + slash + '| b');
  assert.equal(cellSourceRange(slashed, 1, 1).markdown, 'c');
});

test('normalizeCellMarkdown keeps escapes and never splits the row', () => {
  assert.equal(normalizeCellMarkdown('  a **b**  '), 'a **b**');
  assert.equal(normalizeCellMarkdown('第一行\r\n第二行'), '第一行 第二行');
  assert.equal(normalizeCellMarkdown('a | b'), 'a \\| b');
  assert.equal(normalizeCellMarkdown('a \\| b'), 'a \\| b', '已有转义必须保持原样');
  assert.equal(normalizeCellMarkdown(''), '');
  assert.equal(normalizeCellMarkdown('|'), '\\|');
});

test('cell, row and column operations keep the table rectangular', () => {
  let table = parseTables(sample)[0];
  table = setCell(table, 1, 1, '12');
  assert.equal(table.rows[1][1], '12');
  assert.equal(parseTables(sample)[0].rows[1][1], '3', 'operations must not mutate the input');
  table = insertRow(table, 1);
  assert.equal(table.rows.length, 4);
  assert.deepEqual(table.rows[1], ['', '']);
  table = removeRow(table, 1);
  assert.equal(table.rows.length, 3);
  table = insertColumn(table, 1);
  assert.equal(table.aligns.length, 3);
  assert.ok(table.rows.every(row => row.length === 3));
  table = removeColumn(table, 1);
  assert.equal(table.aligns.length, 2);
  table = setAlignment(table, 0, 'center');
  assert.equal(table.aligns[0], 'center');
  assert.match(serializeTable(table), /:---:/);
});

test('header row and last column are protected from deletion', () => {
  const table = parseTables('| A |\n| --- |\n| 1 |')[0];
  assert.equal(removeRow(table, 0).rows.length, 2);
  assert.equal(removeColumn(table, 0).aligns.length, 1);
});

test('tableCellRanges finds editable cells and ignores escaped pipes', () => {
  const line = '| 苹果 | 3 |';
  assert.deepEqual(tableCellRanges(line), [{ from: 2, to: 4 }, { from: 7, to: 8 }]);
  assert.equal(line.slice(2, 4), '苹果');
  assert.equal(line.slice(7, 8), '3');
  assert.deepEqual(tableCellRanges('| a\\|b | c |'), [{ from: 2, to: 6 }, { from: 9, to: 10 }]);
  assert.deepEqual(tableCellRanges('  |  |  |'), [{ from: 5, to: 5 }, { from: 8, to: 8 }]);
  assert.deepEqual(tableCellRanges('普通段落'), []);
});

test('column widths round-trip through one invisible comment', () => {
  const source = `前言\n\n${sample}\n结尾\n`;
  assert.deepEqual(readColumnWidths(source), []);
  const first = columnWidthEdit(source, 0, [30, 70]);
  const updated = source.slice(0, first.from) + first.insert + source.slice(first.to);
  assert.match(updated, /<!-- inkstone:columns 30\.0,70\.0 -->/);
  assert.deepEqual(readColumnWidths(updated), [[30, 70]]);
  const second = columnWidthEdit(updated, 0, [45, 55]);
  const twice = updated.slice(0, second.from) + second.insert + updated.slice(second.to);
  assert.equal((twice.match(/inkstone:columns/g) || []).length, 1, 'repeated drags must not pile up comments');
  assert.deepEqual(readColumnWidths(twice), [[45, 55]]);
  assert.ok(twice.includes('结尾'), 'width metadata must not damage the rest of the document');
  assert.deepEqual(parseTables(twice)[0].rows, parseTables(source)[0].rows);
});

test('column widths survive across several tables and render as colgroup', () => {
  const source = `${sample}\n${sample}`;
  const first = columnWidthEdit(source, 0, [20, 80]);
  let text = source.slice(0, first.from) + first.insert + source.slice(first.to);
  const second = columnWidthEdit(text, 1, [60, 40]);
  text = text.slice(0, second.from) + second.insert + text.slice(second.to);
  assert.deepEqual(readColumnWidths(text), [[20, 80], [60, 40]]);
  const html = injectColumnWidths('<table><tr><th>A</th></tr></table>', readColumnWidths(text));
  assert.match(html, /<col style="width:20\.0%">/);
  assert.match(html, /<col style="width:80\.0%">/);
  assert.equal(injectColumnWidths('<p>no table</p>', [[20, 80]]), '<p>no table</p>');
});

const applyEdits = (source, changes) => [...changes]
  .sort((a, b) => b.from - a.from)
  .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source);

test('moving a data row never drags the header or the delimiter row', () => {
  const table = parseTables(sample)[0];
  assert.deepEqual(moveRow(table, 1, 2).rows, [['名称', '数量'], ['梨', '5'], ['苹果', '3']]);
  assert.deepEqual(moveRow(table, 0, 2).rows, table.rows, '表头不可移动');
  assert.deepEqual(moveRow(table, 1, 0).rows, table.rows, '不能把数据行挪到表头之前');
  assert.deepEqual(moveRow(table, 1, 1).rows, table.rows, '原位移动是空操作');
  const moved = moveRow(table, 1, 2);
  assert.deepEqual(parseTables(serializeTable(moved))[0].rows, moved.rows);
  assert.deepEqual(parseTables(serializeTable(moved))[0].aligns, ['left', 'right']);
  assert.deepEqual(moveRow(moved, 2, 1).rows, table.rows, '向上拖回原位');
});

test('moving a column moves its cells, alignment and stored width', () => {
  const table = parseTables(sample)[0];
  const moved = moveColumn(table, 0, 1);
  assert.deepEqual(moved.rows, [['数量', '名称'], ['3', '苹果'], ['5', '梨']]);
  assert.deepEqual(moved.aligns, ['right', 'left']);
  assert.deepEqual(parseTables(serializeTable(moved))[0].rows, moved.rows);
  assert.deepEqual(moveColumnWidths([30, 70], 0, 1), [70, 30]);
  assert.deepEqual(moveColumnWidths([30, 70], 1, 1), [30, 70]);
  assert.deepEqual(moveColumn(moved, 1, 0).rows, table.rows, '向上拖回的列恢复原位');
  assert.equal(tableMoveEdit(sample, 0, 'column', 1, 0).length, 1, '列向上移动也是一次原子编辑（无宽度注释时不写注释）');
  assert.deepEqual(moveColumnWidths([], 0, 1), []);
  // A drop slot maps back through the removal, so its own place stays a no-op.
  assert.equal(dropIndex(1, 1), 1);
  assert.equal(dropIndex(1, 2), 1);
  assert.equal(dropIndex(1, 3), 2);
  assert.deepEqual(tableMoveEdit(sample, 0, 'row', 1, 2), [], '同位放下不产生编辑');
  assert.deepEqual(tableMoveEdit(sample, 0, 'row', 0, 3), [], '表头不参与重排');
});

test('one atomic row move keeps quoted prefix, escaped pipes, alignment, widths and CRLF', () => {
  const source = '前言\r\n\r\n> | 名称 | 数量 |\r\n> | :---: | ---: |\r\n> | 苹果 \\| 红 | 3 |\r\n> | 梨 | 5 |\r\n\r\n结尾\r\n';
  const changes = tableMoveEdit(source, 0, 'row', 1, 3);
  assert.equal(changes.length, 1, '行移动不得改动宽度注释');
  const moved = applyEdits(source, changes);
  assert.doesNotMatch(moved.replace(/\r\n/g, ''), /\n/, '行重排不得插入裸 LF');
  const table = parseTables(moved)[0];
  assert.deepEqual(table.rows, [['名称', '数量'], ['梨', '5'], ['苹果 \\| 红', '3']]);
  assert.deepEqual(table.aligns, ['center', 'right']);
  assert.match(moved, /苹果 \\\| 红/, '转义竖线必须保留');
  const tableLines = moved.split('\r\n').filter(line => line.startsWith('>'));
  assert.deepEqual(tableLines.map(line => line.startsWith('> |')), [true, true, true, true], '引用前缀必须保留在每一行');
  assert.match(moved, /^前言\r\n\r\n/);
  assert.match(moved, /\r\n\r\n结尾\r\n$/);
});

test('one atomic column move permutes widths without touching a second table', () => {
  const first = '| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 5 |\n';
  const second = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const source = `前言\n\n${first}\n${second}\n<!-- inkstone:columns 30.0,70.0;25.0,75.0 -->\n结尾\n`;
  const changes = tableMoveEdit(source, 0, 'column', 0, 2);
  assert.equal(changes.length, 2, '表格与宽度注释属于同一次编辑');
  const moved = applyEdits(source, changes);
  const table = parseTables(moved)[0];
  assert.deepEqual(table.rows, [['数量', '名称'], ['3', '苹果'], ['5', '梨']]);
  assert.deepEqual(table.aligns, ['right', 'left']);
  assert.deepEqual(readColumnWidths(moved), [[70, 30], [25, 75]], '只有被移动表格的宽度换位');
  assert.ok(moved.includes('<!-- inkstone:columns 70.0,30.0;25.0,75.0 -->'), '第二张表的宽度文本不得被重写');
  assert.deepEqual(parseTables(moved)[1].rows, [['A', 'B'], ['1', '2']], '第二张表保持原样');
  assert.deepEqual(parseTables(moved)[1].aligns, [null, null]);
  assert.ok(moved.startsWith('前言\n\n'), '表格前的文字不应改动');
  assert.ok(moved.endsWith('结尾\n'), '表格后的文字不应改动');
  assert.match(moved, /\| 数量/g, '表头随列移动');
  assert.doesNotMatch(moved, /\| 苹果 \| 3 \|/, '单元格随列移动');
});

test('a document BOM stays at the head instead of being copied onto every row', () => {
  // The table is the first block, so the model's first line prefix starts with
  // the BOM. Serializing the whole table with that prefix wrote one BOM per
  // row and the renderer stopped seeing a table at all.
  const source = '\uFEFF| H | I |\r\n| --- | --- |\r\n| a | b |\r\n| c | d |\r\n\r\n结尾\r\n';
  assert.equal(containerPrefix('\uFEFF> | a |'), '> ', 'BOM 不属于可复制的行前缀');
  const changes = tableMoveEdit(source, 0, 'row', 1, 3);
  const moved = applyEdits(source, changes);
  assert.equal((moved.match(/\uFEFF/g) || []).length, 1, 'BOM 只能出现一次');
  assert.ok(moved.startsWith('\uFEFF| H'), 'BOM 必须仍在文档头');
  assert.doesNotMatch(moved.replace(/\r\n/g, ''), /\n/, '行重排不得插入裸 LF');
  assert.doesNotMatch(moved.replace(/\uFEFF/g, ''), /\uFEFF/);
  const table = parseTables(moved)[0];
  assert.deepEqual(table.rows, [['H', 'I'], ['c', 'd'], ['a', 'b']]);
  assert.deepEqual(table.aligns, [null, null]);
  assert.ok(moved.endsWith('\r\n结尾\r\n'), '表格外的正文不得改动');
});

test('swapping two identical columns still swaps their stored widths', () => {
  const source = '| A | A |\n| --- | --- |\n| B | B |\n\n<!-- inkstone:columns 15,85 -->\n';
  const changes = tableMoveEdit(source, 0, 'column', 0, 2);
  assert.equal(changes.length, 1, '内容相同的列交换只需要改写宽度注释');
  const moved = applyEdits(source, changes);
  assert.deepEqual(parseTables(moved)[0].rows, [['A', 'A'], ['B', 'B']], '内容保持矩形');
  assert.deepEqual(readColumnWidths(moved), [[85, 15]], '宽度必须随列一起换位');
  assert.match(moved, /<!-- inkstone:columns 85\.0,15\.0 -->/);
  assert.equal(applyEdits(source, tableMoveEdit(source, 0, 'column', 0, 1)), source, '同位放下仍然不写');
});

test('a width comment inside a cell moves as content instead of being rewritten', () => {
  // The same comment text can be ordinary cell content. Rewriting it there would
  // produce a second change overlapping the table range, which the editor applies
  // as a duplicated comment appended to the row.
  const source = '| A | B |\n| --- | --- |\n| x <!-- inkstone:columns 12,88 --> | y |\n';
  const ranges = tableSourceRanges(source);
  assert.equal(ranges.length, 1);
  for (const [label, changes] of [
    ['block range', tableMoveEdit(source, 0, 'column', 0, 2, ranges[0])],
    ['model range', tableMoveEdit(source, 0, 'column', 0, 2)]
  ]) {
    assert.equal(changes.length, 1, `${label}: 重叠的宽度区间不得生成第二个 change`);
    assert.equal(changes[0].from, 0, `${label}: 唯一 change 是表格区间`);
    assert.equal(changes[0].to, source.trimEnd().length, `${label}: 表格区间不得外扩`);
    const moved = applyEdits(source, changes);
    assert.equal((moved.match(/inkstone:columns/g) || []).length, 1, `${label}: 原注释只能出现一次`);
    assert.equal(moved.trimEnd().split('\n').length, 3, `${label}: 不能在表格后追加新行`);
    assert.equal(moved.endsWith('|\n'), true, `${label}: 文档尾不变`);
    assert.deepEqual(parseTables(moved)[0].rows, [['B', 'A'], ['y', 'x <!-- inkstone:columns 12,88 -->']], `${label}: 注释随单元格移动`);
  }
});

test('width metadata that does not match the columns is left untouched', () => {
  const source = '| A | B |\n| --- | --- |\n| x | y |\n\n<!-- inkstone:columns 10,20,30 -->\n';
  const changes = tableMoveEdit(source, 0, 'column', 0, 2);
  assert.equal(changes.length, 1, '只有表格内容被重写');
  assert.equal(applyEdits(source, changes).includes('<!-- inkstone:columns 10,20,30 -->'), true, '长度不匹配的旧元数据必须原样保留');
  // Two identical columns and stale metadata leave nothing to write at all.
  const identical = '| A | A |\n| --- | --- |\n| B | B |\n\n<!-- inkstone:columns 10,20,30 -->\n';
  assert.deepEqual(tableMoveEdit(identical, 0, 'column', 0, 2), []);
});

test('table boundaries come from the renderer, so a following heading is not a row', () => {
  const source = '# 标题\n\n| A | B |\n| --- | --- |\n| x | y |\n# H | Q\n\n| W | K |\n| --- | --- |\n| 1 | 2 |\n';
  const ranges = tableSourceRanges(source);
  assert.equal(ranges.length, 2);
  assert.equal(source.slice(ranges[0].start, ranges[0].end), '| A | B |\n| --- | --- |\n| x | y |', '表格范围不含下一块标题');
  assert.equal(source.slice(ranges[1].start, ranges[1].end), '| W | K |\n| --- | --- |\n| 1 | 2 |');
  assert.deepEqual(parseTables(source)[0].rows.length, 3, '模型解析确实会把标题当成数据行');
  const changes = tableMoveEdit(source, 0, 'column', 0, 2, ranges[0]);
  assert.equal(changes.length, 1);
  const moved = applyEdits(source, changes);
  assert.ok(moved.includes('# H | Q\n'), '相邻标题必须原样保留');
  assert.deepEqual(parseTables(moved.slice(ranges[0].start, moved.indexOf('\n# H | Q')))[0].rows, [['B', 'A'], ['y', 'x']]);
  assert.ok(moved.endsWith('| W | K |\n| --- | --- |\n| 1 | 2 |\n'), '后面的表格不得改动');
  // A range that does not describe exactly one table is refused.
  assert.deepEqual(tableMoveEdit(source, 0, 'column', 0, 2, { start: ranges[0].start, end: source.indexOf('# H | Q') }), []);
});

test('renderer boundaries include the last cell of a BOM-prefixed table', () => {
  // The renderer parses the document without its BOM while the editor text keeps
  // it. Ranges built from the stripped text stopped one character early, so the
  // last row's closing "|" stayed outside the replacement ("RR" became "R").
  const source = '\uFEFF| A | B |\n| --- | --- |\n| x \\| y | Z |\n| L | RR |\n\n| W | K |\n| --- | --- |\n| 1 | 2 |\n';
  const ranges = tableSourceRanges(source);
  assert.equal(ranges[0].start, 0);
  assert.equal(source.slice(ranges[0].start, ranges[0].end), '\uFEFF| A | B |\n| --- | --- |\n| x \\| y | Z |\n| L | RR |');
  assert.equal(source.slice(ranges[1].start, ranges[1].end), '| W | K |\n| --- | --- |\n| 1 | 2 |');
  const moved = applyEdits(source, tableMoveEdit(source, 0, 'row', 1, 3, ranges[0]));
  assert.equal((moved.match(/\|/g) || []).length, (source.match(/\|/g) || []).length, '重排不得多出或丢掉竖线');
  assert.equal((moved.match(/\uFEFF/g) || []).length, 1, 'BOM 只能出现一次');
  assert.ok(moved.startsWith('\uFEFF| A'), 'BOM 必须仍在文档头');
  const table = parseTables(moved)[0];
  assert.deepEqual(table.rows, [['A', 'B'], ['L', 'RR'], ['x \\| y', 'Z']], '末格内容不能被截断');
  assert.ok(moved.endsWith('\n\n| W | K |\n| --- | --- |\n| 1 | 2 |\n'), '后面的表格不得改动');
});

test('a BOM before the text does not shift later table ranges or get copied', () => {
  // BOM in front of a paragraph: the table starts after it, so its range must
  // still be exact (a start one character short made the grip do nothing).
  const source = '\uFEFF前言\n\n| A | B |\n| --- | --- |\n| x | y |\n| L | R |\n';
  const ranges = tableSourceRanges(source);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, source.indexOf('| A'));
  assert.equal(source.slice(ranges[0].start, ranges[0].end), '| A | B |\n| --- | --- |\n| x | y |\n| L | R |');
  const withBlock = applyEdits(source, tableMoveEdit(source, 0, 'row', 1, 3, ranges[0]));
  assert.equal((withBlock.match(/\uFEFF/g) || []).length, 1, 'BOM 只能出现一次');
  assert.ok(withBlock.startsWith('\uFEFF前言\n\n| A'));
  assert.deepEqual(parseTables(withBlock)[0].rows, [['A', 'B'], ['L', 'R'], ['x', 'y']]);
  // The fallback model path has no block offset: the BOM condition must be the
  // table's absolute start, otherwise a later table would gain another BOM.
  const withModel = applyEdits(source, tableMoveEdit(source, 0, 'row', 1, 3));
  assert.equal((withModel.match(/\uFEFF/g) || []).length, 1, '备用模型路径不得重复写 BOM');
  assert.ok(withModel.startsWith('\uFEFF前言\n\n| A'));
  assert.deepEqual(parseTables(withModel)[0].rows, [['A', 'B'], ['L', 'R'], ['x', 'y']]);
});

test('renderer boundaries cover quoted, listed and fenced tables', () => {
  const source = '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n\n- 列表\n\n  | c | d |\n  | --- | --- |\n  | 3 | 4 |\n\n```\n| e | f |\n| --- | --- |\n```\n';
  const ranges = tableSourceRanges(source);
  assert.equal(ranges.length, 2, '围栏里的示例表格不是表格');
  assert.equal(source.slice(ranges[0].start, ranges[0].end), '> | a | b |\n> | --- | --- |\n> | 1 | 2 |');
  assert.equal(source.slice(ranges[1].start, ranges[1].end), '  | c | d |\n  | --- | --- |\n  | 3 | 4 |');
  const moved = applyEdits(source, tableMoveEdit(source, 0, 'row', 1, 3, ranges[0]));
  const quoted = moved.split('\n').slice(0, 3);
  assert.deepEqual(quoted.map(line => line.startsWith('> |')), [true, true, true], '引用前缀必须保留');
  assert.match(quoted[2], /1/);
  assert.ok(moved.endsWith('```\n| e | f |\n| --- | --- |\n```\n'), '围栏不得当作表格改写');
});
