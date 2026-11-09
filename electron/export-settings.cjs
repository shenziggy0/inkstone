// PDF export options and their persisted presets. Pure data validation lives
// here so the settings IPC, the exporter and the Node tests share one definition
// of the whitelist. Header / footer text is stored as plain text and only turned
// into Chromium's print template at export time; it is escaped there and never
// concatenated into a file path.

const PDF_PAGE_SIZES = new Set(['css', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid', 'Ledger']);
const PDF_MARGIN_PRESETS = new Set(['css', 'normal', 'narrow', 'wide']);
const PDF_TEXT_LIMIT = 500;
const PDF_PRESET_LIMIT = 20;
const PDF_PRESET_NAME_LIMIT = 40;

const DEFAULT_PDF_EXPORT = Object.freeze({
  header: '',
  footer: '',
  pageNumbers: false,
  pageSize: 'css',
  landscape: false,
  margins: 'css'
});

// CSS @page in src/styles.css is A4 with 20mm top/bottom and 18mm sides. These
// are the same values in inches, used for header/footer padding and to generate
// the @page override in millimetres. `normal` / `narrow` / `wide` are
// conventional Word-like choices.
const PDF_MARGIN_INCHES = Object.freeze({
  css: Object.freeze({ top: 20 / 25.4, bottom: 20 / 25.4, left: 18 / 25.4, right: 18 / 25.4 }),
  normal: Object.freeze({ top: 1, bottom: 1, left: 1, right: 1 }),
  narrow: Object.freeze({ top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }),
  wide: Object.freeze({ top: 1.5, bottom: 1.5, left: 1.5, right: 1.5 })
});

// PNG is captured at the display's device pixel ratio. These limits are checked
// against the final pixel dimensions before any screenshot is requested, so a
// too-long document fails explicitly instead of producing a truncated image.
const PNG_LIMITS = Object.freeze({ maxWidth: 8192, maxHeight: 32000, maxPixels: 60_000_000 });

const cleanText = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return text.slice(0, PDF_TEXT_LIMIT);
};

const cleanName = value => {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PDF_PRESET_NAME_LIMIT);
};

const normalizePageSize = value => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'css') return 'css';
  const match = [...PDF_PAGE_SIZES].find(size => size.toLowerCase() === trimmed.toLowerCase());
  return match || null;
};

const normalizeMargins = value => typeof value === 'string' && PDF_MARGIN_PRESETS.has(value) ? value : null;

/** One persisted PDF configuration, with every unknown or invalid field dropped. */
function normalizePdfExport(value, base = DEFAULT_PDF_EXPORT) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const previous = base && typeof base === 'object' ? base : DEFAULT_PDF_EXPORT;
  return {
    header: source.header === undefined ? cleanText(previous.header) : cleanText(source.header, cleanText(previous.header)),
    footer: source.footer === undefined ? cleanText(previous.footer) : cleanText(source.footer, cleanText(previous.footer)),
    pageNumbers: typeof source.pageNumbers === 'boolean' ? source.pageNumbers : !!previous.pageNumbers,
    pageSize: normalizePageSize(source.pageSize) || normalizePageSize(previous.pageSize) || 'css',
    landscape: typeof source.landscape === 'boolean' ? source.landscape : !!previous.landscape,
    margins: normalizeMargins(source.margins) || normalizeMargins(previous.margins) || 'css'
  };
}

/** Named PDF presets: bounded, unique by display name (case-insensitive). */
function normalizePdfPresets(value) {
  if (!Array.isArray(value)) return [];
  const presets = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = cleanName(entry.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    presets.push({ name, ...normalizePdfExport(entry) });
    if (presets.length >= PDF_PRESET_LIMIT) break;
  }
  return presets;
}

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));

const PAGE_TOKEN = /\$\{(?:pageNo|pageCount|totalPages)\}/;
const hasPagePlaceholder = text => PAGE_TOKEN.test(String(text || ''));

/**
 * Chromium's header/footer template for one plain-text line. Placeholders are
 * replaced only after escaping, and only the three documented page tokens are
 * recognised; an unknown `${...}` stays literal instead of being interpreted.
 */
function pdfTemplateHTML(text, position = 'header', margins = PDF_MARGIN_INCHES.css) {
  const tokens = {
    pageNo: '<span class="pageNumber"></span>',
    pageCount: '<span class="totalPages"></span>',
    totalPages: '<span class="totalPages"></span>'
  };
  const inner = escapeHTML(cleanText(text)).replace(/\$\{(pageNo|pageCount|totalPages)\}/g, (_match, token) => tokens[token]);
  const left = Number.isFinite(margins?.left) ? margins.left : PDF_MARGIN_INCHES.css.left;
  const right = Number.isFinite(margins?.right) ? margins.right : PDF_MARGIN_INCHES.css.right;
  return `<div style="width:100%;box-sizing:border-box;padding:0 ${left}in 0 ${right}in;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:9px;line-height:1.4;color:#666;text-align:center;">${inner || '&nbsp;'}</div>`;
}

/**
 * A CSS @page override for a non-default paper, orientation or margin. Chromium
 * applies the document's @page margin even when printToPDF gets an explicit
 * `margins` object, so the page box has to be expressed in CSS; the injected
 * rule is generated only from the whitelisted numeric presets below.
 */
function pdfPageCSS(value) {
  const pdf = normalizePdfExport(value);
  if (pdf.pageSize === 'css' && pdf.margins === 'css' && !pdf.landscape) return null;
  const margins = PDF_MARGIN_INCHES[pdf.margins];
  const mm = inches => `${(inches * 25.4).toFixed(4)}mm`;
  const size = pdf.pageSize === 'css' ? 'A4' : pdf.pageSize;
  const orientation = pdf.landscape ? ' landscape' : '';
  const margin = `${mm(margins.top)} ${mm(margins.right)} ${mm(margins.bottom)} ${mm(margins.left)}`;
  // A margin-only override leaves the document's own @page size in place; this
  // keeps a theme's custom paper size while changing only the spacing.
  const sizeRule = pdf.pageSize === 'css' && !pdf.landscape ? '' : `size:${size}${orientation};`;
  return `@page{${sizeRule}margin:${margin}}`;
}

/**
 * The arguments for one `printToPDF` call. Called with the defaults it returns
 * exactly the object the exporter has always used, so existing PDF output keeps
 * its paper, margins, background, outline and tagged-PDF behaviour.
 */
function buildPdfPrintOptions(value) {
  const pdf = normalizePdfExport(value);
  const defaults = {
    printBackground: true,
    preferCSSPageSize: true,
    generateDocumentOutline: true,
    generateTaggedPDF: true
  };
  const pagePlaceholder = hasPagePlaceholder(pdf.header) || hasPagePlaceholder(pdf.footer);
  const needsDefaultPageNumbers = pdf.pageNumbers && !pagePlaceholder;
  const footerText = needsDefaultPageNumbers
    ? (pdf.footer ? `${pdf.footer} · \${pageNo} / \${pageCount}` : '${pageNo} / ${pageCount}')
    : pdf.footer;
  const showHeaderFooter = !!(pdf.header || footerText || pdf.pageNumbers);
  if (!showHeaderFooter) return defaults;
  const margins = PDF_MARGIN_INCHES[pdf.margins];
  return {
    ...defaults,
    displayHeaderFooter: true,
    headerTemplate: pdfTemplateHTML(pdf.header, 'header', margins),
    footerTemplate: pdfTemplateHTML(footerText, 'footer', margins)
  };
}

/** Pixel dimensions and the explicit limit violation, if any. Pure and testable. */
function checkPngSize(cssWidth, cssHeight, pixelRatio, limits = PNG_LIMITS) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const width = Math.round(cssWidth * ratio);
  const height = Math.round(cssHeight * ratio);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: 'invalid', width, height, ratio, limits };
  }
  if (width > limits.maxWidth) return { ok: false, reason: 'width', width, height, ratio, limits };
  if (height > limits.maxHeight) return { ok: false, reason: 'height', width, height, ratio, limits };
  if (width * height > limits.maxPixels) return { ok: false, reason: 'pixels', width, height, ratio, limits };
  return { ok: true, width, height, ratio, limits };
}

module.exports = {
  DEFAULT_PDF_EXPORT,
  PDF_PAGE_SIZES,
  PDF_MARGIN_PRESETS,
  PDF_MARGIN_INCHES,
  PDF_TEXT_LIMIT,
  PDF_PRESET_LIMIT,
  PDF_PRESET_NAME_LIMIT,
  PNG_LIMITS,
  cleanText,
  cleanName,
  normalizePdfExport,
  normalizePdfPresets,
  escapeHTML,
  hasPagePlaceholder,
  pdfTemplateHTML,
  pdfPageCSS,
  buildPdfPrintOptions,
  checkPngSize
};
