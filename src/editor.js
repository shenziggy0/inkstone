import { EditorState, StateEffect, StateField, Compartment, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection, highlightActiveLine, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectLine, selectParentSyntax, indentMore, indentLess, cursorDocStart, cursorDocEnd, deleteLine, deleteGroupBackward } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { emojiCompletion } from './emoji.js';
import { renderMarkdown, renderDocument, renderDiagrams, renderMath, escapeHTML, invalidateFenceLanguages } from './markdown.js';
import { onLanguageLoaded } from './highlight.js';
import { linkAt } from './links.js';
import { buildSourceMap, sourceOffsetAt, imageSourceOffset } from './source-map.js';
import { inlineMarks } from './inline-marks.js';
import { liveBlock, blockReveal, documentLines } from './live-preview.js';
import { tableCellRanges, parseTables, rowPrefix } from './table.js';
import { applyEol, createEolContext, toLf } from './eol.js';

/**
 * Translate a screen point into a document position. Rendered blocks are
 * replaced decorations, so CodeMirror's own hit testing only knows their
 * boundaries. While they exist we use the widget's text→source map instead;
 * once a drag reveals them as source lines, posAtCoords becomes exact.
 */
function resolveDocPosition(view, x, y) {
  const target = document.elementFromPoint(x, y);
  const widget = target?.closest?.('.md-widget');
  const info = widget?._inkstone;
  if (info) {
    let offset = sourceOffsetAt(info.map, x, y, info.fallback);
    const image = target.closest?.('img');
    if (image) {
      const imageOffset = imageSourceOffset(info.source, image.getAttribute('alt') || '');
      if (imageOffset >= 0) offset = imageOffset;
    }
    return info.toDoc(offset);
  }
  const position = view.posAtCoords({ x, y });
  return typeof position === 'number' && position >= 0 ? position : null;
}

const modeEffect = StateEffect.define();
const compositionEffect = StateEffect.define();
// Keeps the whole document typeset while a cell edit moves from one cell to the
// next: the commit rebuilds the widget, and without this the block holding the
// caret would expand into source lines and the target cell would be gone.
const cellEffect = StateEffect.define();
const modeField = StateField.define({ create: () => ({ source: false, composing: false, pristine: true, hold: false }), update(value, tr) {
  for (const effect of tr.effects) {
    if (effect.is(modeEffect)) value = { ...value, source: effect.value };
    if (effect.is(compositionEffect)) value = { ...value, composing: effect.value };
    if (effect.is(cellEffect)) value = { ...value, hold: effect.value };
  }
  // Typora shows a newly opened file fully typeset. Only the first real
  // interaction (a click, caret move or keystroke) reveals the active block.
  if ((tr.docChanged || tr.selection) && !tr.effects.some(effect => effect.is(cellEffect))) {
    value = { ...value, pristine: false, hold: false };
  }
  return value;
} });

class MarkdownWidget extends WidgetType {
  constructor(source, from, to, id, html) { super(); Object.assign(this, { source, from, to, id, html }); }
  eq(other) { return this.source === other.source && this.from === other.from && this.to === other.to && this.id === other.id && this.html === other.html; }
  /**
   * A block that only moved (typically because text was typed in an earlier
   * block) keeps its DOM. Rebuilding it would throw away every Mermaid SVG,
   * KaTeX tree and decoded image, which is what made typing above a diagram
   * flicker. The positions the handlers resolve against are refreshed here;
   * they are never read from the widget instance that built the DOM.
   */
  updateDOM(dom) {
    const info = dom._inkstone;
    if (!info || info.source !== this.source || info.html !== this.html) return false;
    info.from = this.from;
    info.to = this.to;
    dom.dataset.from = this.from;
    dom.dataset.to = this.to;
    return true;
  }
  toDOM(view) {
    const element = document.createElement('div');
    element.className = 'md-widget prose';
    element.innerHTML = this.html;
    // Handlers and the drag-selection code outlive this widget instance (the
    // DOM is reused by updateDOM), so every document position is read from
    // this mutable block record instead of from `this`.
    const info = {
      from: this.from,
      to: this.to,
      source: this.source,
      html: this.html,
      fallback: 0,
      map: null,
      // CodeMirror's document is LF-normalized, so a source offset inside the
      // block is also a document offset relative to the block start.
      toDoc: offset => {
        const clamped = Math.min(Math.max(offset, 0), info.source.length);
        return Math.min(info.to, info.from + clamped);
      }
    };
    element.dataset.from = info.from;
    element.dataset.to = info.to;
    info.map = buildSourceMap(element, info.source);
    // Fall back to the block start (after a heading marker) when a click lands
    // on generated UI with no source counterpart, e.g. math, diagrams, TOC.
    info.fallback = info.source.match(/^#{1,6} /)?.[0].length || 0;
    // Consumed by resolveDocPosition for cross-block drag selection.
    element._inkstone = info;
    const toDocOffset = info.toDoc;
    // Right-click (or Alt+click) opens the full grid editor for this table.
    element.addEventListener('contextmenu', event => {
      const cell = event.target.closest('td, th');
      if (!cell) return;
      event.preventDefault();
      element.dispatchEvent(new CustomEvent('inkstone:table-edit', {
        bubbles: true,
        detail: { source: info.source, from: info.from, index: [...element.querySelectorAll('table')].indexOf(cell.closest('table')) }
      }));
    });
    // Column resize handles are added after the text→source map is built so
    // they can never pollute character mapping. Widths are stored in one
    // invisible comment at the end of the document.
    for (const [tableIndex, table] of [...element.querySelectorAll('table')].entries()) {
      table.dataset.inkstoneIndex = tableIndex;
      const header = table.querySelector('tr');
      if (!header) continue;
      [...header.children].forEach((cell, column) => {
        const handle = document.createElement('span');
        handle.className = 'table-column-resizer';
        handle.dataset.mdSkip = '';
        handle.setAttribute('aria-hidden', 'true');
        cell.append(handle);
        // Hit-test the header cell's right edge rather than the visual handle:
        // a thin absolutely positioned span can be covered by the next cell.
        cell.addEventListener('mousedown', event => {
          if (column + 1 >= header.children.length || event.button !== 0) return;
          if (event.clientX < cell.getBoundingClientRect().right - 9) return;
          event.preventDefault();
          event.stopPropagation();
          const startX = event.clientX;
          const original = [...header.children].map(node => node.getBoundingClientRect().width);
          const widths = original.slice();
          let total = original.reduce((sum, value) => sum + value, 0);
          const paint = () => {
            let group = table.querySelector('colgroup');
            if (!group) { group = document.createElement('colgroup'); table.prepend(group); }
            group.replaceChildren(...widths.map(value => {
              const col = document.createElement('col');
              col.style.width = `${Math.max(36, value)}px`;
              return col;
            }));
            table.style.tableLayout = 'fixed';
          };
          const onMove = move => {
            const delta = move.clientX - startX;
            widths[column] = Math.max(36, original[column] + delta);
            widths[column + 1] = Math.max(36, original[column + 1] - delta);
            total = widths.reduce((sum, value) => sum + value, 0);
            paint();
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const parsed = parseTables(info.source);
            const target = parsed[tableIndex];
            // Dispatch on document: the widget may already have been replaced
            // by source lines while the pointer was moving.
            document.dispatchEvent(new CustomEvent('inkstone:table-width', {
              detail: {
                absoluteStart: target ? info.toDoc(target.start) : info.from,
                widths: widths.map(value => value * 100 / total)
              }
            }));
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp, { once: true });
        });
      });
    }
    // A rendered cell is edited in place: it shows the cell's own Markdown
    // source, and only a real change is written back. Detaching the rendered
    // child nodes into a fragment (instead of re-creating them from HTML) lets
    // Escape and "no change" restore the exact same DOM, so the block's
    // text→source map keeps working afterwards.
    const cellAt = (tableIndex, lineIndex, column) => {
      const table = element.querySelectorAll('table')[tableIndex];
      const row = table?.rows[lineIndex === 0 ? 0 : lineIndex - 1];
      return row?.cells[column] || null;
    };

    const startCellEdit = (cell, tableIndex) => {
      if (!cell || cell.isContentEditable) return;
      const table = parseTables(info.source)[tableIndex];
      if (!table) return;
      const rowIndex = cell.parentElement.rowIndex, column = cell.cellIndex;
      const lines = info.source.slice(table.start, table.end).split('\n');
      const lineIndex = rowIndex === 0 ? 0 : rowIndex + 1;
      if (lineIndex >= lines.length) return;
      let offset = table.start;
      for (let index = 0; index < lineIndex; index++) offset += lines[index].length + 1;
      const range = tableCellRanges(lines[lineIndex])[column];
      if (!range) return;
      const markdown = lines[lineIndex].slice(range.from, range.to);
      const originals = document.createDocumentFragment();
      while (cell.firstChild) originals.append(cell.firstChild);
      cell.replaceChildren(document.createTextNode(markdown));
      cell.contentEditable = 'plaintext-only';
      cell.classList.add('table-cell-editing');
      let finished = false;
      const restore = () => {
        cell.contentEditable = 'false';
        cell.classList.remove('table-cell-editing');
        cell.replaceChildren(originals);
      };
      const cleanup = () => {
        cell.removeEventListener('blur', onBlur);
        cell.removeEventListener('keydown', onKey);
      };
      const value = () => (cell.textContent || '').replace(/[\r\n]+/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();
      // Editable cells in reading order; the delimiter row is syntax, not content.
      const order = [0, ...Array.from({ length: Math.max(0, lines.length - 2) }, (_, index) => index + 2)]
        .flatMap(line => tableCellRanges(lines[line]).map((_, at) => ({ lineIndex: line, column: at })));
      const target = step => {
        const at = order.findIndex(candidate => candidate.lineIndex === lineIndex && candidate.column === column);
        return at < 0 ? null : order[at + step] || null;
      };
      const submit = (direction = 'blur') => {
        if (finished) return;
        finished = true;
        cleanup();
        const changes = [];
        // Nothing typed means nothing to write: no document change and no undo step.
        if (value() !== markdown.trim()) {
          changes.push({ from: toDocOffset(offset + range.from), to: toDocOffset(offset + range.to), insert: value() });
        }
        let focus = direction === 'tab' ? target(1) : direction === 'shift-tab' ? target(-1) : null;
        if (direction === 'enter') {
          // Enter appends a body row, keeping the table's container prefix so a
          // table inside a quote or a list item stays inside it.
          const columns = Math.max(...table.rows.map(row => row.length), table.aligns.length);
          const at = toDocOffset(table.end);
          const prefix = rowPrefix(lines[lines.length - 1]);
          changes.push({ from: at, to: at, insert: `\n${prefix}|${Array(columns).fill('  ').join('|')}|` });
          focus = { lineIndex: lines.length, column: 0 };
        }
        if (!changes.length) {
          restore();
          if (focus) startCellEdit(cellAt(tableIndex, focus.lineIndex, focus.column), tableIndex);
          return;
        }
        pendingCellFocus = focus ? { blockFrom: info.from, tableIndex, ...focus } : null;
        cell.contentEditable = 'false';
        cell.classList.remove('table-cell-editing');
        view.dispatch({ changes, effects: cellEffect.of(true) });
        continuePendingCellEdit();
      };
      const onBlur = () => submit('blur');
      const onKey = key => {
        // An IME owns Enter / Tab / Escape while a candidate window is open.
        if (key.isComposing || key.keyCode === 229) return;
        if (key.key === 'Escape') {
          key.preventDefault();
          finished = true;
          cleanup();
          restore();
          view.focus();
        } else if (key.key === 'Enter') {
          key.preventDefault();
          submit('enter');
        } else if (key.key === 'Tab') {
          key.preventDefault();
          submit(key.shiftKey ? 'shift-tab' : 'tab');
        }
      };
      cell.addEventListener('blur', onBlur);
      cell.addEventListener('keydown', onKey);
      queueMicrotask(() => {
        cell.focus();
        const selection = window.getSelection(), editingRange = document.createRange();
        editingRange.selectNodeContents(cell);
        selection.removeAllRanges(); selection.addRange(editingRange);
      });
    };
    element._inkstone.editCell = (tableIndex, lineIndex, column) => startCellEdit(cellAt(tableIndex, lineIndex, column), tableIndex);
    element.addEventListener('mousedown', event => {
      // Right-click belongs to the context-menu handler (grid table editor).
      if (event.button !== 0) return;
      // The edge of a header cell belongs to the column resizer.
      const headerCell = event.target.closest('th');
      if (headerCell && event.clientX >= headerCell.getBoundingClientRect().right - 9) return;
      // Outline / [TOC] entries own their click: they carry data-line and the
      // document-level handler jumps to that line without rebuilding this block.
      if (event.target.closest('[data-line]')) return;
      // A link is followed from here, not from the `click` event: the mousedown
      // below replaces this block with source lines, so the browser would
      // dispatch `click` on a detached node and the link would be lost.
      const link = event.target.closest('a');
      if (link) {
        event.preventDefault();
        element.dispatchEvent(new CustomEvent('inkstone:open-link', {
          bubbles: true,
          detail: { href: link.getAttribute('href') || '', modifier: !!(event.metaKey || event.ctrlKey) }
        }));
        return;
      }
      // Let generated controls (code copy) receive their own click.
      if (event.target.closest('[data-copy-code]')) return;
      if (event.target.matches('input[type="checkbox"]')) {
        event.preventDefault();
        const index = [...element.querySelectorAll('input[type="checkbox"]')].indexOf(event.target);
        const matches = [...info.source.matchAll(/^\s*[-*+] \[([ xX])\]/gm)];
        const match = matches[index];
        if (match) {
          const from = toDocOffset(match.index + match[0].lastIndexOf('[') + 1);
          view.dispatch({ changes: { from, to: from + 1, insert: match[1] === ' ' ? 'x' : ' ' } });
        }
        return;
      }
      // A single click edits the rendered cell itself, like Typora. The source
      // range is updated when editing finishes; Alt+click still opens the full
      // grid dialog for structural changes.
      const cell = event.target.closest('td, th');
      if (cell) {
        // A click inside the cell that is being edited belongs to the browser's
        // own caret handling, so the widget must not swallow it.
        if (cell.isContentEditable) return;
        event.preventDefault();
        const tableIndex = [...element.querySelectorAll('table')].indexOf(cell.closest('table'));
        if (event.altKey) {
          element.dispatchEvent(new CustomEvent('inkstone:table-edit', {
            bubbles: true,
            detail: { source: info.source, from: info.from, index: tableIndex }
          }));
          return;
        }
        startCellEdit(cell, tableIndex);
        return;
      }
      event.preventDefault();
      const anchor = resolveDocPosition(view, event.clientX, event.clientY);
      if (anchor == null) { view.focus(); return; }
      const startX = event.clientX, startY = event.clientY;
      let moved = false;
      // A drag across rendered blocks reveals their source lines as the
      // selection grows. Recomputing the hit position each move keeps the
      // head accurate even though the DOM is rebuilt underneath the pointer.
      const onMove = move => {
        if (!moved && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        moved = true;
        const head = resolveDocPosition(view, move.clientX, move.clientY);
        if (head == null || head === anchor) return;
        view.dispatch({ selection: EditorSelection.range(anchor, head) });
      };
      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onUp);
      };
      const onUp = () => {
        cleanup();
        // The user is already looking at the clicked text; scrolling here
        // would move the page under a subsequent drag.
        if (!moved) view.dispatch({ selection: { anchor } });
        view.focus();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
      window.addEventListener('blur', onUp, { once: true });
    });
    queueMicrotask(() => renderDiagrams(element).then(() => view.requestMeasure()));
    return element;
  }
  ignoreEvent() { return true; }
}

// After a cell edit the widget is rebuilt by CodeMirror; Tab / Enter ask the
// re-rendered table to continue editing in a neighbouring cell. The target is
// remembered by block start (stable across a cell edit) until it is found.
let pendingCellFocus = null;

/**
 * Committing a cell edit rebuilds the widget, so Tab / Enter cannot hold on to
 * the old DOM. The target cell is picked up as soon as the re-rendered table
 * appears.
 *
 * The widget is rebuilt synchronously by the dispatch that committed the edit,
 * so the target is entered in the same task; animation frames are only a
 * fallback for the case where the block still renders as source lines.
 * Deferring the first attempt would let frame timing decide whether Tab / Enter
 * continues in the next cell.
 */
function continuePendingCellEdit() {
  const pending = pendingCellFocus;
  if (!pending) return;
  let frames = 0;
  const attempt = () => {
    if (pendingCellFocus !== pending) return true;
    const element = document.querySelector(`.md-widget[data-from="${pending.blockFrom}"]`);
    if (!element?._inkstone) return false;
    pendingCellFocus = null;
    element._inkstone.editCell(pending.tableIndex, pending.lineIndex, pending.column);
    return true;
  };
  if (attempt()) return;
  const retry = () => {
    if (attempt()) return;
    if (++frames > 20) { pendingCellFocus = null; return; }
    requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}

/**
 * Typora hides Markdown syntax until the caret approaches it. A replace
 * decoration removes the characters from the layout entirely (not just their
 * colour), which is what makes the active block read as typeset text while
 * the source remains the only data.
 */
class HiddenMark extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-hidden-mark';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() { return true; }
}
const hiddenMark = new HiddenMark();

class RenderedInline extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return this.text === other.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-rendered-inline';
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

/** Bullets, task boxes and rules replace their source prefix in the layout. */
class PrefixWidget extends WidgetType {
  constructor(kind, docFrom, checked, label) { super(); Object.assign(this, { kind, docFrom, checked, label }); }
  eq(other) { return this.kind === other.kind && this.docFrom === other.docFrom && this.checked === other.checked && this.label === other.label; }
  toDOM(view) {
    const span = document.createElement('span');
    span.className = `cm-prefix cm-prefix-${this.kind}`;
    if (this.kind === 'bullet') span.textContent = '•';
    if (this.kind === 'ordered') span.textContent = this.label;
    if (this.kind === 'hr') span.setAttribute('aria-label', '分隔线');
    if (this.kind === 'task') {
      span.textContent = this.checked ? '☑' : '☐';
      span.setAttribute('role', 'checkbox');
      span.setAttribute('aria-checked', String(this.checked));
      span.setAttribute('aria-label', '切换任务完成状态');
      span.addEventListener('mousedown', event => {
        event.preventDefault();
        const at = this.docFrom;
        if (at < 0 || at >= view.state.doc.length) return;
        const value = view.state.doc.sliceString(at, at + 1);
        if (value !== ' ' && !/[xX]/.test(value)) return;
        view.dispatch({ changes: { from: at, to: at + 1, insert: /[xX]/.test(value) ? ' ' : 'x' } });
        view.focus();
      });
    }
    return span;
  }
  ignoreEvent() { return true; }
}

// Rendering the whole document once is what gives every block the same parse
// environment. Cache by (document id + text): selection changes recompute
// decorations but must not re-parse the file.
let blockCache = { key: '', blocks: [], tokens: [], document: null };
function parsedFor(source, id) {
  const key = `${id}\u0000${source}`;
  // One parse per document version. Selection-only updates reuse both the
  // block HTML and the token ranges, which keeps caret movement cheap even
  // in long technical documents. `document` holds the normalised text and the
  // line table the active block is sliced and parsed from.
  if (blockCache.key !== key) blockCache = { key, ...renderDocument(source, id), document: documentLines(source) };
  return blockCache;
}

/**
 * Fenced-code highlighting inside the editor.
 *
 * Two halves: `markdown({ codeLanguages })` gives a code block a real language
 * parser (loaded lazily by @codemirror/language-data), and this style maps the
 * resulting tokens onto the same palette the rendered page uses for
 * highlight.js. Switching between the rendered block and the active source
 * therefore keeps the colours, which is what makes the active block read as
 * the same document rather than as plain text.
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.self, tags.atom, tags.bool, tags.null, tags.unit], color: 'var(--color-syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.escape], color: 'var(--color-syntax-string)' },
  { tag: [tags.number, tags.typeName, tags.className, tags.namespace, tags.standard(tags.name), tags.standard(tags.propertyName)], color: 'var(--color-syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.propertyName, tags.attributeName, tags.tagName, tags.macroName], color: 'var(--color-syntax-function)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--color-muted)', fontStyle: 'italic' }
]);

/** A language finished loading: refresh the blocks that fence it. */
const refreshEffect = StateEffect.define();
const previewViews = new Set();
onLanguageLoaded(language => {
  // Only the blocks that fence this language have different HTML now; the
  // render cache is invalidated for exactly those and every open editor is
  // asked to recompute, which leaves all other blocks' DOM untouched. The
  // editor-level parse cache has to go too, or it would hand the old HTML back
  // without asking the renderer again.
  invalidateFenceLanguages([language]);
  blockCache = { key: '', blocks: [], tokens: [], document: null };
  for (const view of previewViews) {
    if (!view.dom.isConnected) { previewViews.delete(view); continue; }
    view.dispatch({ effects: refreshEffect.of(true) });
  }
});

// ── Live preview of a formula or diagram block being edited ────────────────
// Typora shows the rendered result under the block the caret is in. The block
// itself stays editable source; the preview is a read-only block widget that
// is rebuilt only when its source text changes.
const mathFence = /^\s*\$\$\s*$/;
const fenceOpen = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/;
const MAX_PREVIEW_BLOCK_LINES = 400;

/** The `$$…$$` or ```mermaid block that contains `pos`, or null. */
function enclosingPreviewBlock(doc, pos) {
  const caret = doc.lineAt(pos);
  const first = Math.max(1, caret.number - MAX_PREVIEW_BLOCK_LINES);
  let opener = null;
  for (let number = caret.number; number >= first; number--) {
    const text = doc.line(number).text;
    if (mathFence.test(text)) { opener = { kind: 'math', number }; break; }
    const fence = fenceOpen.exec(text);
    if (fence) {
      const language = fence[2].toLowerCase();
      if (language !== 'mermaid') return null;
      opener = { kind: 'mermaid', number, marker: fence[1] };
      break;
    }
  }
  if (!opener) return null;
  const last = Math.min(doc.lines, opener.number + MAX_PREVIEW_BLOCK_LINES);
  for (let number = opener.number + 1; number <= last; number++) {
    const text = doc.line(number).text;
    const closes = opener.kind === 'math' ? mathFence.test(text) : new RegExp(`^\\s*${opener.marker}\\s*$`).test(text);
    if (!closes) continue;
    // A caret below the closing marker belongs to the next block.
    if (caret.number > number) return null;
    const body = [];
    for (let index = opener.number + 1; index < number; index++) body.push(doc.line(index).text);
    return { kind: opener.kind, from: doc.line(opener.number).from, to: doc.line(number).to, source: body.join('\n') };
  }
  return null;
}

const previewEffect = StateEffect.define();
const previewKey = preview => preview ? `${preview.kind}\u0000${preview.source}\u0000${preview.from}\u0000${preview.to}` : '';

const previewField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(previewEffect)) value = effect.value;
    // Editing shifts the block; the widget position follows the document.
    if (tr.docChanged && value) value = { ...value, from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    return value;
  }
});
class PreviewWidget extends WidgetType {
  constructor(preview) { super(); Object.assign(this, preview); }
  // Only the source decides whether the preview must be rebuilt; a move only
  // refreshes the position the click puts the caret at.
  eq(other) { return this.kind === other.kind && this.source === other.source; }
  updateDOM(dom) {
    const info = dom._inkstone;
    if (!info || info.source !== this.source || info.kind !== this.kind) return false;
    info.to = this.anchor;
    dom.dataset.to = String(this.anchor);
    return true;
  }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'md-live-preview';
    wrap.dataset.mdSkip = '';
    wrap.dataset.to = String(this.anchor);
    wrap.setAttribute('role', 'note');
    // The widget ignores CodeMirror's own event handling, so the click that
    // returns the caret to the end of the source block is handled here.
    wrap._inkstone = { kind: this.kind, source: this.source, to: this.anchor };
    wrap.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      const to = Number(wrap._inkstone?.to);
      view.dispatch({
        selection: { anchor: Number.isFinite(to) ? Math.min(to, view.state.doc.length) : view.state.doc.length },
        scrollIntoView: true
      });
      view.focus();
    });
    const label = document.createElement('div');
    label.className = 'md-live-preview-label';
    label.textContent = this.kind === 'math' ? '公式预览' : '图表预览';
    const body = document.createElement('div');
    body.className = 'md-live-preview-body';
    wrap.append(label, body);
    if (this.kind === 'math') {
      const { html, error } = renderMath(this.source);
      if (error) body.innerHTML = `<p class="md-live-preview-error">${escapeHTML(error)}</p>`;
      else body.innerHTML = html;
    } else {
      const diagram = document.createElement('pre');
      diagram.className = 'mermaid';
      diagram.textContent = this.source;
      body.append(diagram);
      // The shared Mermaid queue renders asynchronously and shows a Chinese
      // message in place of a failed diagram, so this cannot end up blank.
      queueMicrotask(() => renderDiagrams(body).catch(() => {}));
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

/**
 * Decorations for the current preview. The widget sits under the closing
 * marker, which keeps it out of the source text and out of the text→source map
 * used for click positioning.
 */
const previewDecorations = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    const preview = tr.state.field(previewField, false);
    if (!preview) return Decoration.none;
    if (!tr.docChanged && !tr.selection && !tr.effects.length && value !== Decoration.none) return value;
    const selection = tr.state.selection;
    // The caret must still be inside the block; leaving it restores the normal
    // rendered block.
    const inside = selection.ranges.some(range => range.from <= preview.to && range.to >= preview.from);
    if (!inside) return Decoration.none;
    const position = Math.min(preview.to, tr.state.doc.length);
    return Decoration.set([Decoration.widget({
      widget: new PreviewWidget({ kind: preview.kind, source: preview.source, anchor: position }),
      block: true, side: 1
    }).range(position)]);
  },
  provide: field => EditorView.decorations.from(field)
});

/**
 * Debounced preview updater. Waiting for a short pause means a formula is not
 * re-typeset on every keystroke, and a Mermaid diagram is not queued per
 * character either.
 */
const previewScheduler = ViewPlugin.fromClass(class {
  constructor(view) { this.timer = 0; this.schedule(view); }
  update(update) { if (update.docChanged || update.selectionSet) this.schedule(update.view); }
  schedule(view) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!view.dom.isConnected) return;
      // In source mode the whole document is code; a preview would duplicate
      // the block the user is already reading, so it only applies to the
      // typeset view.
      const mode = view.state.field(modeField, false);
      const position = view.state.selection.main.head;
      let next = null;
      if (!mode?.source) {
        const block = enclosingPreviewBlock(view.state.doc, position);
        if (block) next = { ...block, anchor: block.to };
      }
      const current = view.state.field(previewField, false);
      const changed = !next !== !current || (next && current && (next.kind !== current.kind || next.source !== current.source || next.to !== current.to));
      if (changed || (next && previewKey(next) !== previewKey(current))) view.dispatch({ effects: previewEffect.of(next) });
    }, 150);
  }
  destroy() { clearTimeout(this.timer); }
});

/** Selection endpoint relative to the start of a block. */
function blockOffset(live, state, pos, startLine) {
  const line = state.doc.lineAt(pos);
  const index = line.number - 1 - startLine;
  if (index < 0) return 0;
  if (index >= live.lines.length) return live.length;
  return live.lines[index].offset + Math.min(pos - line.from, live.lines[index].length);
}

function liveDecorations(state, id) {
  const mode = state.field(modeField);
  if (mode.source || state.doc.length > 200000) return Decoration.none;
  const source = state.doc.toString();
  const { tokens, blocks, document } = parsedFor(source, id);
  const htmlByStart = new Map(blocks.map(block => [block.start, block.html]));
  const ranges = [], occupied = new Set();
  // Before any interaction, the caret at offset 0 must not turn the first
  // heading into an editable source line; the whole document is a reading view.
  const selection = mode.pristine || mode.hold ? [] : state.selection.ranges;
  for (const token of tokens) {
    if (!token.map || token.level !== 0 || token.nesting === -1) continue;
    const [start, end] = token.map;
    if (start >= end || occupied.has(start) || end > state.doc.lines) continue;
    occupied.add(start);
    const from = state.doc.line(start + 1).from;
    const to = state.doc.line(end).to;
    if (from === to) continue;
    // The active block stays editable, but reads as typeset prose: syntax
    // characters are removed from the layout until the caret comes near them,
    // and the content itself receives real typography (bold, italic, code…).
    if (selection.some(range => range.from <= to && range.to >= from)) {
      // The block is parsed as a whole, so emphasis may cross soft line breaks
      // and code fences nested in a list are known to be literal. Only this
      // block is parsed, which keeps every keystroke proportional to it.
      const live = liveBlock(document, start, end);
      // Typora renders a completed syntax at once, even with the caret right
      // after the closing marker. Only a caret *inside* the element (or a
      // selection overlapping it) brings the source characters back.
      const reveal = blockReveal(live, selection.map(range => ({
        from: blockOffset(live, state, range.from, start), to: blockOffset(live, state, range.to, start)
      })));
      live.lines.forEach((info, index) => {
        const line = state.doc.line(start + 1 + index);
        const classes = ['cm-live-line', ...info.classes];
        if (index === 0 && token.type === 'heading_open') classes.push(`cm-heading-${token.tag.slice(1)}`);
        if (index === 0 && token.type === 'blockquote_open') classes.push('cm-live-quote');
        ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
        // Code, formulas, HTML blocks and front matter are literal source.
        if (info.literal) return;
        if (info.plain) {
          for (const mark of inlineMarks(line.text)) {
            ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(line.from + mark.from, line.from + mark.to));
          }
          return;
        }
        for (const mark of info.marks) {
          const markFrom = line.from + mark.from, markTo = line.from + mark.to;
          const hidden = mark.kind === 'syntax' && mark.group >= 0 && !reveal.groups.has(mark.group);
          if (hidden) {
            ranges.push(Decoration.replace({ widget: hiddenMark }).range(markFrom, markTo));
          } else {
            ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(markFrom, markTo));
          }
        }
        for (const style of info.styles) {
          ranges.push(Decoration.mark({ class: `cm-lv-${style.kind}` }).range(line.from + style.from, line.from + style.to));
        }
        for (const replacement of info.replacements || []) {
          const from = line.from + replacement.from, to = line.from + replacement.to;
          if (reveal.groups.has(replacement.group)) ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(from, to));
          else ranges.push(Decoration.replace({ widget: new RenderedInline(replacement.text) }).range(from, to));
        }
        if (info.prefix) {
          const prefixFrom = line.from + info.prefix.from, prefixTo = line.from + info.prefix.to;
          if (reveal.prefix.has(index)) {
            ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(prefixFrom, prefixTo));
          } else if (info.prefix.kind === 'heading' || info.prefix.kind === 'quote') {
            ranges.push(Decoration.replace({ widget: hiddenMark }).range(prefixFrom, prefixTo));
          } else {
            ranges.push(Decoration.replace({
              widget: new PrefixWidget(info.prefix.kind, line.from + (info.prefix.checkOffset ?? 0), info.prefix.checked, info.prefix.label)
            }).range(prefixFrom, prefixTo));
          }
        }
      });
      continue;
    }
    const text = state.doc.sliceString(from, to, '\n');
    const html = htmlByStart.get(start) ?? renderMarkdown(text, id);
    ranges.push(Decoration.replace({ widget: new MarkdownWidget(text, from, to, id, html), block: true }).range(from, to));
  }
  return Decoration.set(ranges, true);
}

/** Tab / Shift+Tab walk table cells when the caret is on a GFM table row. */
function tableTab(view, backwards) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const cells = tableCellRanges(line.text);
  if (cells.length < 2) return false;
  const relative = head - line.from;
  const current = cells.findIndex(cell => relative >= cell.from - 2 && relative <= cell.to + 2);
  const next = current < 0 ? (backwards ? cells.length - 1 : 0) : current + (backwards ? -1 : 1);
  if (next < 0 || next >= cells.length) return false;
  view.dispatch({ selection: EditorSelection.range(line.from + cells[next].from, line.from + cells[next].to), scrollIntoView: true });
  return true;
}

const isDelimiterRow = text => {
  const cells = tableCellRanges(text);
  return cells.length >= 2 && cells.every(cell => /^:?-{1,}:?$/.test(text.slice(cell.from, cell.to)));
};

/** Enter inside a GFM table appends a row instead of breaking the table. */
function tableEnter(view) {
  let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1);
  while (node) {
    if (/^(?:FencedCode|CodeBlock|HTMLBlock)$/.test(node.name)) return false;
    node = node.parent;
  }
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (/^ {4}|^\t/.test(line.text)) return false;
  const table = parseTables(view.state.doc.toString()).find(candidate => candidate.start <= line.from && line.to <= candidate.end);
  if (!table) return false;
  const cells = tableCellRanges(line.text);
  if (cells.length < 2 || isDelimiterRow(line.text)) return false;
  const next = line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : null;
  const at = next && isDelimiterRow(next.text) ? next.to : line.to;
  // Keep the table's container prefix so a quoted / indented table stays inside it.
  const prefix = rowPrefix(line.text);
  const row = `${prefix}|${Array(cells.length).fill('  ').join('|')}|`;
  view.dispatch({
    changes: { from: at, to: at, insert: `\n${row}` },
    selection: { anchor: at + 2 }, scrollIntoView: true
  });
  view.focus();
  return true;
}

/**
 * Enter inside a literal code block only breaks the line: the nested language
 * parser now supplies its own indentation rules, which would silently insert
 * spaces into the fence (and disagree with the source the user sees). Keeping
 * the current line's own indentation is what Typora does.
 */
function codeEnter(view) {
  const range = view.state.selection.main;
  let node = syntaxTree(view.state).resolveInner(range.head, -1);
  let literal = false;
  while (node) {
    if (/^(?:FencedCode|CodeBlock)$/.test(node.name)) { literal = true; break; }
    node = node.parent;
  }
  if (!literal) return false;
  const line = view.state.doc.lineAt(range.head);
  const indent = line.text.match(/^[ 	]*/)[0];
  const insert = `
${indent}`;
  view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, scrollIntoView: true });
  return true;
}

/** Typora's Return creates a new paragraph; Shift+Return keeps a soft break. */
function paragraphEnter(view) {
  if (tableEnter(view)) return true;
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.head);
  if (!line.text) return false;
  let node = syntaxTree(view.state).resolveInner(range.head, -1);
  let paragraph = false;
  while (node) {
    if (/^(?:FencedCode|CodeBlock|HTMLBlock|Blockquote|ListItem|BulletList|OrderedList)$/.test(node.name)) return false;
    if (node.name === 'Paragraph' || /^ATXHeading[1-6]$/.test(node.name)) paragraph = true;
    node = node.parent;
  }
  if (!paragraph) return false;
  // A following source newline already supplies half of the blank separator.
  const insert = range.empty && range.head === line.to && line.to < view.state.doc.length ? '\n' : '\n\n';
  view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, scrollIntoView: true });
  return true;
}

function softBreak(view) {
  const range = view.state.selection.main;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: '\n' }, selection: { anchor: range.from + 1 }, scrollIntoView: true });
  return true;
}

const isWordCharacter = character => /[\p{L}\p{N}_]/u.test(character || '');
function selectScope(view) {
  const range = view.state.selection.main;
  if (!range.empty) { selectParentSyntax(view); view.focus(); return; }
  const line = view.state.doc.lineAt(range.head);
  const at = range.head - line.from;
  let start = at, end = at;
  while (start > 0 && isWordCharacter(line.text[start - 1])) start--;
  while (end < line.text.length && isWordCharacter(line.text[end])) end++;
  if (start === end) {
    if (at < line.text.length) end = at + 1;
    else start = Math.max(0, at - 1);
  }
  view.dispatch({ selection: EditorSelection.range(line.from + start, line.from + end), scrollIntoView: true });
  view.focus();
}

// CodeMirror ships English panel labels. These phrases replace them with the
// Chinese wording used by the rest of the interface (find / replace panel,
// completion list, announcements).
const CHINESE_PHRASES = {
  'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个',
  'all': '全部', 'match case': '区分大小写', 'regexp': '正则表达式', 'by word': '全词匹配',
  'replace': '替换', 'replace all': '全部替换', 'close': '关闭',
  'current match': '当前匹配', 'on line': '位于行',
  'Go to line': '跳转到行', 'go': '跳转',
  'replaced $ matches': '已替换 $ 处匹配', 'replaced match on line $': '已替换第 $ 行的匹配',
  'Completions': '补全', 'Control character': '控制字符', 'Selection deleted': '已删除选区'
};

export function createEditor(parent, doc, onChange, onSelection, onCommand, onImage, onNavigate) {
  const gutter = new Compartment();
  const spelling = new Compartment();
  const preview = StateField.define({
    create: state => liveDecorations(state, doc.id),
    update: (value, tr) => {
      // An IME composition writes into the live contenteditable DOM. Rebuilding
      // decorations (or clearing them to Decoration.none) at that moment tears
      // down the node the browser is composing into, exposes raw Markdown for
      // the whole document and can drop characters. Keep the existing typeset
      // layout frozen, merely shifting positions if the document did change;
      // recompute once compositionend arrives and the text is committed.
      const mode = tr.state.field(modeField, false);
      if (mode?.composing && !mode.source) return tr.docChanged ? value.map(tr.changes) : value;
      return tr.docChanged || tr.selection || tr.effects.some(e => e.is(modeEffect) || e.is(compositionEffect) || e.is(cellEffect) || e.is(refreshEffect))
        ? liveDecorations(tr.state, doc.id) : value;
    },
    provide: field => EditorView.decorations.from(field)
  });
  const eol = createEolContext(doc.content);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const dispatch = name => () => { onCommand(name); return true; };
  // `view` is only referenced when a key is pressed, after construction.
  const edit = command => () => { command(view); view.focus(); return true; };
  const view = new EditorView({ parent, state: EditorState.create({
    // The document lives in LF form internally; the file's own line endings
    // are restored by applyEol() whenever text goes back out to disk.
    doc: toLf(doc.content),
    extensions: [
      modeField, preview, gutter.of([]), spelling.of(EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown 文档编辑器' })),
      // Windows binds redo to Mod-y in historyKeymap, so this is the only
      // Mod-Shift-z binding. It has to run ahead of the keymap: some
      // environments report Shift+Z as a lowercase "z", which makes the plain
      // Mod-z binding (undo) match first.
      Prec.highest(EditorView.domEventHandlers({
        keydown(event) {
          if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return false;
          if (event.isComposing || event.key?.toLowerCase() !== 'z') return false;
          if (!redo(view)) return false;
          event.preventDefault();
          view.focus();
          return true;
        }
      })),
      // A longer grouping window keeps a continuous typing burst in one undo
      // step even when the caret crosses rendered block boundaries.
      history({ minDepth: 100, newGroupDelay: 600 }), drawSelection(), highlightActiveLine(), highlightSelectionMatches(), bracketMatching(), closeBrackets(), indentOnInput(),
      autocompletion({ override: [emojiCompletion], activateOnTyping: true, icons: false }),
      // `codeLanguages` gives the fence the caret is in a real parser (loaded on
      // demand by @codemirror/language-data); the extra highlight style maps its
      // tokens onto the same palette the rendered page uses.
      markdown({ codeLanguages: languages }), syntaxHighlighting(defaultHighlightStyle), syntaxHighlighting(codeHighlightStyle),
      previewField, previewDecorations, previewScheduler,
      EditorView.lineWrapping, placeholder('开始写作，或输入 # 创建标题'),
      // Panel labels and prompts follow the Chinese interface.
      EditorState.phrases.of(CHINESE_PHRASES),
      search({ top: true }),
      keymap.of([
        { key: 'Tab', run: view => tableTab(view, false) },
        { key: 'Shift-Tab', run: view => tableTab(view, true) },
        { key: 'Enter', run: paragraphEnter },
        { key: 'Enter', run: codeEnter },
        { key: 'Shift-Enter', run: softBreak },
        { key: 'Mod-b', run: dispatch('bold') },
        { key: 'Mod-i', run: dispatch('italic') },
        { key: 'Mod-k', run: dispatch('link') },
        { key: 'Mod-u', run: dispatch('underline') },
        { key: 'Mod-\\', run: dispatch('clear-format') },
        { key: 'Mod-Shift-`', run: dispatch('inline-code') },
        { key: 'Mod-Shift-c', run: dispatch('copy-markdown') },
        { key: 'Mod-Shift-v', run: dispatch('paste-plain') },
        { key: 'Mod-l', run: edit(selectLine) },
        { key: 'Mod-e', run: edit(selectScope) },
        { key: 'Mod-d', run: edit(selectScope) },
        { key: 'Mod-Shift-d', run: edit(deleteGroupBackward) },
        { key: 'Mod-Shift-Backspace', run: edit(deleteLine) },
        { key: 'Mod-0', run: dispatch('paragraph') },
        { key: 'Mod-=', run: dispatch('heading-up') },
        { key: 'Mod--', run: dispatch('heading-down') },
        { key: 'Mod-[', run: edit(indentLess) },
        { key: 'Mod-]', run: edit(indentMore) },
        { key: 'Mod-Shift-q', run: dispatch('quote') },
        { key: 'Mod-Shift-[', run: dispatch('ordered-list') },
        { key: 'Mod-Shift-]', run: dispatch('unordered-list') },
        { key: 'Mod-Shift-k', run: dispatch('code') },
        { key: 'Mod-Shift-m', run: dispatch('math') },
        { key: 'Mod-h', run: dispatch('replace') },
        { key: 'Mod-j', run: dispatch('jump-to-selection') },
        { key: 'Mod-Home', run: dispatch('jump-top') },
        { key: 'Mod-End', run: dispatch('jump-bottom') },
        { key: 'F8', run: dispatch('focus') },
        { key: 'F9', run: dispatch('typewriter') },
        { key: 'Mod-Shift-1', run: dispatch('panel-outline') },
        { key: 'Mod-Shift-2', run: dispatch('panel-files') },
        { key: 'Mod-Shift-t', run: dispatch('reopen-closed') },
        { key: 'Mod-Shift-0', run: dispatch('zoom-reset') },
        { key: 'Mod-Shift-=', run: dispatch('zoom-in') },
        { key: 'Mod-Shift--', run: dispatch('zoom-out') },
        ...(isMac ? [
          { key: 'Mod-t', run: dispatch('new') },
          { key: 'Mod-Alt-t', run: dispatch('table') },
          { key: 'Mod-Alt-c', run: dispatch('code') },
          { key: 'Mod-Alt-b', run: dispatch('math') },
          { key: 'Mod-Alt-q', run: dispatch('quote') },
          { key: 'Mod-Alt-o', run: dispatch('ordered-list') },
          { key: 'Mod-Alt-u', run: dispatch('unordered-list') },
          { key: 'Mod-Alt-f', run: dispatch('fullscreen') },
          { key: 'Mod-Control-i', run: dispatch('image') },
          { key: 'Mod-`', run: dispatch('next-document') },
          { key: 'Mod-Control-1', run: dispatch('panel-outline') },
          { key: 'Mod-Control-2', run: dispatch('panel-files') }
        ] : [
          { key: 'Mod-t', run: dispatch('table') },
          { key: 'Mod-Shift-i', run: dispatch('image') },
          { key: 'Mod-Tab', run: dispatch('next-document') },
          { key: 'F11', run: dispatch('fullscreen') },
          { key: 'Mod-,', run: dispatch('settings') }
        ]),
        ...closeBracketsKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) onChange(applyEol(update.state.doc.toString(), eol));
        if (update.selectionSet || update.docChanged) onSelection(update);
      }),
      EditorView.domEventHandlers({
        compositionstart: () => { view.dispatch({ effects: compositionEffect.of(true) }); },
        compositionend: () => { requestAnimationFrame(() => { if (view.dom.isConnected) view.dispatch({ effects: compositionEffect.of(false) }); }); },
        // Ctrl / Cmd + click in the active block jumps to the link under the
        // pointer, exactly like clicking a link in the typeset view. A plain
        // click keeps placing the caret, which is what editing needs.
        mousedown: (event, editorView) => {
          if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
          const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
          if (typeof pos !== 'number' || pos < 0) return false;
          const line = editorView.state.doc.lineAt(pos);
          const link = linkAt(line.text, Math.min(Math.max(pos - line.from, 0), line.text.length));
          if (!link) return false;
          event.preventDefault();
          onNavigate?.(link.target);
          return true;
        },
        paste: event => {
          const images = [...(event.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
          if (!images.length) return false;
          event.preventDefault(); onImage(images[0]); return true;
        },
        drop: event => {
          const images = [...(event.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
          if (!images.length) return false;
          event.preventDefault(); onImage(images[0]); return true;
        }
      })
    ]
  }) });
  // Language loads refresh every open editor; closed ones are dropped here.
  previewViews.add(view);
  return {
    view,
    destroy() { previewViews.delete(view); view.destroy(); },
    undo() { undo(view); view.focus(); },
    redo() { redo(view); view.focus(); },
    setSource(value) { view.dispatch({ effects: [modeEffect.of(value), gutter.reconfigure(value ? lineNumbers() : [])] }); },
    setSpellcheck(value) { view.dispatch({ effects: spelling.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(value), 'aria-label': 'Markdown 文档编辑器' })) }); },
    find() { openSearchPanel(view); view.focus(); },
    setContent(value) {
      // A reload / history restore replaces the baseline the newline style is
      // rebuilt from, so later edits keep the file's own endings.
      Object.assign(eol, createEolContext(value));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: toLf(value) }, selection: { anchor: 0 } });
      view.focus();
    },
    jump(line) { const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines)); view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true }); view.focus(); },
    /**
     * Put the caret on a search hit (1-based line and column) and select the
     * match. Positions are clamped because the document may have changed since
     * the search ran.
     */
    jumpTo(line, column = 1, length = 0) {
      const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      const from = target.from + Math.min(Math.max(column - 1, 0), target.length);
      const to = Math.min(target.to, from + Math.max(length, 0));
      view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
      view.focus();
    },
    jumpTop() { cursorDocStart(view); view.focus(); },
    jumpBottom() { cursorDocEnd(view); view.focus(); },
    jumpToSelection() { view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }); view.focus(); },
    selectLine() { selectLine(view); view.focus(); },
    selectScope() { selectScope(view); },
    deleteLine() { deleteLine(view); view.focus(); },
    deleteWord() { deleteGroupBackward(view); view.focus(); },
    indent() { indentMore(view); view.focus(); },
    outdent() { indentLess(view); view.focus(); },
    insert(text) { view.dispatch(view.state.replaceSelection(toLf(text))); view.focus(); },
    /** The document as CodeMirror sees it: LF line breaks, same offsets as positions. */
    text() { return view.state.doc.toString(); },
    selectedText() {
      const range = view.state.selection.main;
      return range.empty ? view.state.doc.toString() : view.state.sliceDoc(range.from, range.to);
    },
    replaceRange(from, to, text) {
      const insert = toLf(text);
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true });
      view.focus();
    },
    caretOffset() { return view.state.selection.main.head; },
    /** Minimal, selection-preserving edit (used for persisted table widths). */
    applyChange({ from, to, insert }) {
      view.dispatch({ changes: { from, to, insert: toLf(insert) } });
      view.focus();
    },
    wrap(before, after = before, fallback = '文字') {
      const { from, to } = view.state.selection.main;
      const value = view.state.sliceDoc(from, to) || fallback;
      view.dispatch({ changes: { from, to, insert: before + value + after }, selection: { anchor: from + before.length, head: from + before.length + value.length } }); view.focus();
    },
    prefix(prefix) {
      const selection = view.state.selection.main;
      const first = view.state.doc.lineAt(selection.from), last = view.state.doc.lineAt(selection.to);
      const changes = [];
      for (let n = first.number; n <= last.number; n++) {
        const line = view.state.doc.line(n);
        const old = line.text.match(/^(?:#{1,6}\s|>\s|[-*+]\s(?:\[[ xX]\]\s)?)/)?.[0] || '';
        changes.push({ from: line.from, to: line.from + old.length, insert: prefix });
      }
      view.dispatch({ changes }); view.focus();
    },
    heading(delta) {
      const selection = view.state.selection.main;
      const first = view.state.doc.lineAt(selection.from), last = view.state.doc.lineAt(selection.to);
      const changes = [];
      for (let n = first.number; n <= last.number; n++) {
        const line = view.state.doc.line(n);
        const match = line.text.match(/^(#{1,6})\s+/);
        const level = match ? match[1].length : 0;
        const next = delta === 0 ? 0 : Math.max(1, Math.min(6, level + delta));
        changes.push({ from: line.from, to: line.from + (match ? match[0].length : 0), insert: next ? '#'.repeat(next) + ' ' : '' });
      }
      view.dispatch({ changes }); view.focus();
    },
    list(kind) {
      const selection = view.state.selection.main;
      const first = view.state.doc.lineAt(selection.from), last = view.state.doc.lineAt(selection.to);
      const changes = [];
      for (let n = first.number, i = 1; n <= last.number; n++, i++) {
        const line = view.state.doc.line(n);
        const old = line.text.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s)?/)?.[0] || '';
        changes.push({ from: line.from, to: line.from + old.length, insert: kind === 'ordered' ? `${i}. ` : '- ' });
      }
      view.dispatch({ changes }); view.focus();
    },
    clearFormat() {
      const { from, to } = view.state.selection.main;
      const value = view.state.sliceDoc(from, to);
      const cleaned = value
        .replace(/\*\*(.*?)\*\*/gs, '$1').replace(/__(.*?)__/gs, '$1')
        .replace(/~~(.*?)~~/gs, '$1').replace(/==(.*?)==/gs, '$1')
        .replace(/`(.*?)`/gs, '$1').replace(/<\/?u>/gi, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/gs, '$1')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
      view.dispatch({ changes: { from, to, insert: cleaned }, selection: { anchor: from, head: from + cleaned.length } }); view.focus();
    },
  }
}
