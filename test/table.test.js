import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTables, serializeTable, setCell, insertRow, removeRow,
  insertColumn, removeColumn, setAlignment, tableCellRanges,
  readColumnWidths, columnWidthEdit, injectColumnWidths
} from '../src/table.js';

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
