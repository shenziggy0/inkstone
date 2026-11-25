// Export document builders. They work on the already-rendered `#print-document`
// DOM, so HTML, PNG and PDF all show the same formulas, diagrams and images the
// editor rendered. Nothing here touches the editor document or its scroll state.

const escapeText = value => String(value).replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));
// A style sheet is embedded in a <style> element. A user theme must not be able
// to close it with a literal `</style>` and turn the rest into markup.
const inlineCSS = value => String(value).replace(/<\/style/gi, '<\\/style');

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const inSVG = node => {
  for (let current = node; current; current = current.parentNode) {
    if (current.namespaceURI === SVG_NAMESPACE) return true;
  }
  return false;
};

/**
 * A self-contained print document. It carries the same article markup and the
 * same style sheets the main window used to print, but lives in its own window
 * so the open modal dialog cannot suppress Chromium's outline/tagged output.
 */
export function printHTML(title, body, css, { theme = 'light', ui = 'typora', headingNumbering = false } = {}) {
  const safeTheme = ['light', 'dark', 'sepia'].includes(theme) ? theme : 'light';
  const safeUI = ui === 'workbench' ? 'workbench' : 'typora';
  const bodyClass = headingNumbering ? ' class="heading-numbering"' : '';
  // Use one paper/ink pair for the printable page and its article. Built-in
  // themes supply the defaults, and custom themes can override each colour.
  const page = `@media print{
    :root[data-theme]{
      --inkstone-print-paper:var(--inkstone-theme-paper,var(--color-paper,#fff));
      --inkstone-print-ink:var(--inkstone-theme-ink,var(--color-ink,#333));
      /* Keep Chromium's page margins light for its separate header and footer. */
      color-scheme:light;
      print-color-adjust:exact;
    }
    html,body,.print-document{background:var(--inkstone-print-paper);color:var(--inkstone-print-ink)}
  }`;
  return `<!doctype html><html lang="zh-CN" data-theme="${safeTheme}" data-ui="${safeUI}"><meta charset="utf-8"><title>${escapeText(title)}</title><style>${inlineCSS(css)}\n${page}</style><body${bodyClass}><article class="print-document prose write-surface" id="print-document">${body}</article></body></html>`;
}

/** The current self-contained styled export, kept byte-compatible with the old path. */
export function styledHTML(title, body, css) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeText(title)}</title><style>${inlineCSS(css)}\nhtml,body{background:var(--inkstone-theme-paper,#fff);color:var(--inkstone-theme-ink,#333)}body{overflow:auto!important;display:block!important;height:auto!important;padding:48px!important}.prose{max-width:800px;margin:auto}</style><body><article class="prose write-surface">${body}</article></body></html>`;
}

/**
 * HTML without application/theme CSS. It keeps the semantic article, heading and
 * footnote ids, links, table structure, diagram SVG and the rendered MathML.
 * KaTeX's visual-only layer is removed so a browser without CSS sees one
 * readable formula instead of both a MathML tree and an absolutely positioned
 * duplicate.
 */
export function unstyledHTML(title, target) {
  const clone = target.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('script').forEach(node => node.remove());
  clone.querySelectorAll('style, link, meta, base').forEach(node => {
    if (!inSVG(node)) node.remove();
  });
  clone.querySelectorAll('.code-copy, .code-language, .table-column-resizer').forEach(node => node.remove());

  const mathOf = node => node.querySelector('.katex-mathml math') || node.querySelector('math');
  for (const display of [...clone.querySelectorAll('.katex-display')]) {
    const math = mathOf(display);
    const block = document.createElement('div');
    if (math) block.append(math.cloneNode(true));
    else block.textContent = (display.textContent || '').trim();
    display.replaceWith(block);
  }
  for (const katex of [...clone.querySelectorAll('.katex')]) {
    const math = mathOf(katex);
    const replacement = document.createElement(math?.getAttribute('display') === 'block' ? 'div' : 'span');
    if (math) replacement.append(math.cloneNode(true));
    else replacement.textContent = (katex.querySelector('.katex-mathml')?.textContent || katex.textContent || '').trim();
    katex.replaceWith(replacement);
  }
  // Typora's renderer wraps block formulas in <eqn> and inline formulas in <eq>.
  // Those are not HTML elements; convert them to ordinary containers.
  for (const eqn of [...clone.querySelectorAll('eqn')]) {
    const block = document.createElement('div');
    block.append(...eqn.childNodes);
    eqn.replaceWith(block);
  }
  for (const eq of [...clone.querySelectorAll('eq')]) {
    const inline = document.createElement('span');
    inline.append(...eq.childNodes);
    eq.replaceWith(inline);
  }
  for (const pre of [...clone.querySelectorAll('pre.mermaid, pre.diagram')]) {
    if (!pre.querySelector('svg')) continue;
    const figure = document.createElement('figure');
    figure.append(...pre.childNodes);
    pre.replaceWith(figure);
  }

  // Remove every styling hook outside the diagram SVG. SVG carries its own
  // <style> and presentation attributes, which must survive for the diagram to
  // keep its appearance in a document with no external CSS.
  clone.querySelectorAll('*').forEach(node => {
    if (inSVG(node)) return;
    for (const name of ['style', 'class', 'contenteditable', 'spellcheck', 'draggable', 'tabindex', 'loading']) node.removeAttribute(name);
    for (const attribute of [...node.attributes]) {
      if (/^data-/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
  });
  clone.removeAttribute('style');
  clone.removeAttribute('class');
  for (const attribute of [...clone.attributes]) if (/^data-/i.test(attribute.name)) clone.removeAttribute(attribute.name);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeText(title)}</title><body>${clone.outerHTML}</body></html>`;
}

/**
 * The HTML loaded into the isolated PNG capture window. The width is fixed so a
 * full-page screenshot has deterministic CSS pixels; the caller multiplies by
 * the display pixel ratio when it verifies the PNG dimensions.
 */
export function pngHTML(title, body, css, { width, background = '#ffffff', theme = 'light', ui = 'typora', headingNumbering = false } = {}) {
  const safeWidth = Math.max(320, Math.round(Number(width) || 956));
  const safeTheme = ['light', 'dark', 'sepia'].includes(theme) ? theme : 'light';
  const safeUI = ui === 'workbench' ? 'workbench' : 'typora';
  const safeBackground = /^[a-z0-9(),.%#\s-]+$/i.test(String(background)) ? background : '#ffffff';
  const bodyClass = headingNumbering ? ' class="heading-numbering"' : '';
  return `<!doctype html><html lang="zh-CN" data-theme="${safeTheme}" data-ui="${safeUI}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeText(title)}</title><style>${inlineCSS(css)}
html,body{margin:0!important;padding:0!important;height:auto!important;overflow:hidden!important;background:${safeBackground}!important;color:var(--inkstone-theme-ink,#333)}
body{width:${safeWidth}px;padding:48px!important;box-sizing:border-box}
.prose{max-width:none!important;margin:0!important}
.prose pre{white-space:pre-wrap!important;overflow-wrap:anywhere}
.prose table{width:100%!important}
</style><body${bodyClass}><article class="prose write-surface">${body}</article></body></html>`;
}
