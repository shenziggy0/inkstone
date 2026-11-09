import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DEFAULT_PDF_EXPORT,
  PDF_TEXT_LIMIT,
  PNG_LIMITS,
  normalizePdfExport,
  normalizePdfPresets,
  escapeHTML,
  pdfTemplateHTML,
  hasPagePlaceholder,
  buildPdfPrintOptions,
  pdfPageCSS,
  checkPngSize
} = require('../electron/export-settings.cjs');

test('PDF defaults preserve the existing printToPDF output', () => {
  assert.deepEqual(buildPdfPrintOptions(DEFAULT_PDF_EXPORT), {
    printBackground: true,
    preferCSSPageSize: true,
    generateDocumentOutline: true,
    generateTaggedPDF: true
  });
  assert.deepEqual(buildPdfPrintOptions(undefined), buildPdfPrintOptions(DEFAULT_PDF_EXPORT));
});

test('PDF options accept only whitelisted fields and sane values', () => {
  const normalized = normalizePdfExport({
    header: '  页眉\n\t第二行  ',
    footer: '页脚',
    pageNumbers: 'yes',
    pageSize: 'a4',
    landscape: 'true',
    margins: 'narrow',
    injected: 'ignored'
  });
  assert.equal(normalized.header, '页眉 第二行');
  assert.equal(normalized.footer, '页脚');
  assert.equal(normalized.pageNumbers, false);
  assert.equal(normalized.pageSize, 'A4');
  assert.equal(normalized.landscape, false);
  assert.equal(normalized.margins, 'narrow');
  assert.equal('injected' in normalized, false);
  const fallback = normalizePdfExport({ pageSize: 'exec', margins: 'javascript:', header: 7 }, { ...DEFAULT_PDF_EXPORT, header: '旧页眉', pageSize: 'Letter' });
  assert.equal(fallback.pageSize, 'Letter');
  assert.equal(fallback.margins, 'css');
  assert.equal(fallback.header, '旧页眉');
});

test('PDF header/footer text is escaped and only page placeholders become spans', () => {
  const html = pdfTemplateHTML('<b>&"</b> ${pageNo} / ${pageCount} ${totalPages} ${title} ${unknown}', 'footer');
  assert.match(html, /&lt;b&gt;&amp;&quot;&lt;\/b&gt;/);
  assert.match(html, /<span class="pageNumber"><\/span>/);
  assert.equal((html.match(/class="totalPages"/g) || []).length, 2);
  assert.match(html, /\$\{title\} \$\{unknown\}/, 'unknown placeholders stay literal');
  assert.ok(!html.includes('<b>'), 'no raw header markup survives');
  assert.ok(pdfTemplateHTML('x'.repeat(PDF_TEXT_LIMIT + 20)).length < PDF_TEXT_LIMIT + 300);
});

test('page number option appends a default only when no placeholder exists', () => {
  const appended = buildPdfPrintOptions({ pageNumbers: true, footer: '末页' });
  assert.equal(appended.displayHeaderFooter, true);
  assert.match(appended.footerTemplate, /末页 · <span class="pageNumber"><\/span> \/ <span class="totalPages"><\/span>/);
  const placeholder = buildPdfPrintOptions({ pageNumbers: true, footer: '第 ${pageNo} / ${pageCount} 页' });
  assert.match(placeholder.footerTemplate, /第 <span class="pageNumber"><\/span> \/ <span class="totalPages"><\/span> 页/);
  assert.ok(!placeholder.footerTemplate.includes('·'), 'a footer placeholder is not duplicated');
  const alias = buildPdfPrintOptions({ header: '${totalPages}' });
  assert.match(alias.headerTemplate, /<span class="totalPages"><\/span>/);
});

test('custom paper, margins and landscape become a generated @page override', () => {
  const letter = buildPdfPrintOptions({ pageSize: 'Letter', margins: 'narrow' });
  assert.deepEqual(letter, {
    printBackground: true,
    preferCSSPageSize: true,
    generateDocumentOutline: true,
    generateTaggedPDF: true
  }, 'the page box is expressed in CSS, not in printToPDF margins');
  const letterCSS = pdfPageCSS({ pageSize: 'Letter', margins: 'narrow' });
  assert.match(letterCSS, /^@page\{size:Letter;margin:/);
  assert.match(letterCSS, /margin:12\.7000mm 12\.7000mm 12\.7000mm 12\.7000mm\}/);
  assert.match(pdfPageCSS({ landscape: true }), /^@page\{size:A4 landscape;margin:20\.0000mm 18\.0000mm 20\.0000mm 18\.0000mm\}/);
  assert.match(pdfPageCSS({ margins: 'wide' }), /margin:38\.1000mm/);
  assert.equal(pdfPageCSS({}), null);
  const cssMargins = buildPdfPrintOptions({ header: 'H', margins: 'css' });
  assert.equal(cssMargins.displayHeaderFooter, true);
  assert.equal(cssMargins.margins, undefined, 'the document @page keeps the default margins');
  assert.equal(pdfPageCSS({ header: 'H', margins: 'css' }), null);
  assert.match(pdfPageCSS({ header: 'H', margins: 'narrow' }), /^@page\{margin:12\.7000mm/);
});

test('PDF presets are bounded, unique and normalized', () => {
  const presets = normalizePdfPresets([
    { name: ' 报告 ', header: 'A', pageSize: 'a5' },
    { name: '报告', footer: 'duplicate' },
    { name: '', header: 'unnamed' },
    { name: 'x'.repeat(80), footer: 'long' },
    { name: 'Bad', pageNumbers: 'yes', margins: 'wide' }
  ]);
  assert.equal(presets.length, 3);
  assert.deepEqual(presets[0], { name: '报告', ...normalizePdfExport({ header: 'A', pageSize: 'A5' }) });
  assert.equal(presets[1].name.length, 40);
  assert.equal(presets[2].margins, 'wide');
  assert.equal(presets[2].pageNumbers, false);
  assert.deepEqual(normalizePdfPresets('nope'), []);
});

test('PNG limit checks report dimensions before capture', () => {
  assert.deepEqual(checkPngSize(800, 1200, 2), { ok: true, width: 1600, height: 2400, ratio: 2, limits: PNG_LIMITS });
  assert.equal(checkPngSize(PNG_LIMITS.maxWidth + 1, 10, 1).reason, 'width');
  assert.equal(checkPngSize(10, PNG_LIMITS.maxHeight + 1, 1).reason, 'height');
  const pixels = checkPngSize(8_000, 10_000, 1);
  assert.equal(pixels.reason, 'pixels');
  assert.equal(checkPngSize(0, 10, 1).reason, 'invalid');
});

test('export HTML escape helper is shared by templates', () => {
  assert.equal(escapeHTML(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  assert.equal(hasPagePlaceholder('${pageNo}'), true);
  assert.equal(hasPagePlaceholder('${pageNumber}'), false);
});
