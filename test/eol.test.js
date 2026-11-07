import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEol, createEolContext, detectEol, toLf } from '../src/eol.js';

const WITHOUT = text => text.replace(/\r/g, '');

test('detectEol reports pure LF, pure CRLF and mixed files', () => {
  assert.deepEqual(detectEol('a\nb\n'), { bom: '', eol: '\n', crlf: 0, lf: 2, mixed: false });
  assert.deepEqual(detectEol('a\r\nb\r\n'), { bom: '', eol: '\r\n', crlf: 2, lf: 0, mixed: false });
  const mixed = detectEol('a\r\n\r\nb\n\nc\r\n');
  assert.equal(mixed.mixed, true);
  assert.equal(mixed.eol, '\r\n', '多数换行符决定改动区域的风格');
  assert.equal(detectEol('\uFEFFa\r\n').bom, '\uFEFF');
  assert.equal(detectEol('没有换行').eol, '\n');
});

test('a pure LF file keeps LF and a pure CRLF file is converted wholesale', () => {
  const lf = createEolContext('第一段\n\n第二段\n');
  assert.equal(applyEol(toLf('第一段\n\n第二段\n'), lf), '第一段\n\n第二段\n');
  assert.equal(applyEol(toLf('第一段\n新增\n\n第二段\n'), lf), '第一段\n新增\n\n第二段\n');

  const crlf = createEolContext('第一段\r\n\r\n第二段\r\n');
  assert.equal(toLf('第一段\r\n\r\n第二段\r\n'), '第一段\n\n第二段\n');
  assert.equal(applyEol(toLf('第一段\r\n\r\n第二段\r\n'), crlf), '第一段\r\n\r\n第二段\r\n', '未修改必须逐字节一致');
  // Exactly the reported bug: Enter plus typing must not leave a bare "\n".
  const edited = '第一段\n新段\n\n第二段\n';
  assert.equal(applyEol(edited, crlf), '第一段\r\n新段\r\n\r\n第二段\r\n');
  assert.equal(applyEol('', crlf), '');
  assert.equal(WITHOUT(applyEol('标题\n', crlf)), WITHOUT('标题\n'), '每行都必须以 CRLF 结尾');
});

test('a mixed file keeps untouched prefix and suffix lines and uses the majority style in between', () => {
  const original = '一行\r\n\r\n二行\n\n三行\r\n';
  const context = createEolContext(original);
  assert.equal(applyEol(toLf(original), context), original, '未修改的混合文件必须原样输出');
  const edited = toLf(original).replace('二行', '二行改了');
  assert.equal(applyEol(edited, context), '一行\r\n\r\n二行改了\r\n\n三行\r\n',
    '改动的行用多数风格，未改动的后缀行保留自己的换行符');
  // Appending at the end touches no baseline line but the last: its new break
  // uses the majority style instead of the old line's ending.
  assert.equal(applyEol(`${toLf(original)}新增\n`, context), '一行\r\n\r\n二行\n\n三行\r\n新增\r\n');
  // Inserting a line shifts the suffix back onto its own baseline line.
  assert.equal(applyEol('一行\n\n二行\n插入\n\n三行\n', context), '一行\r\n\r\n二行\n插入\r\n\n三行\r\n',
    '新插入的行用多数风格，公共后缀行仍保留原换行符');
});

test('a BOM is preserved and never doubled', () => {
  const context = createEolContext('\uFEFF# 标题\r\n\r\n正文\r\n');
  assert.equal(context.bom, '\uFEFF');
  assert.equal(context.baseline, '# 标题\r\n\r\n正文\r\n');
  assert.equal(applyEol('\uFEFF# 标题\n\n正文\n', context), '\uFEFF# 标题\r\n\r\n正文\r\n');
  assert.equal(applyEol('\uFEFF# 标题\n\n正文改\n', context), '\uFEFF# 标题\r\n\r\n正文改\r\n');
  assert.equal(applyEol('# 标题\n', context), '# 标题\r\n', '没有 BOM 的文本不会凭空长出 BOM');
});
