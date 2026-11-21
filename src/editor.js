import { EditorState, StateEffect, StateField, Compartment, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection, highlightActiveLine, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, invertedEffects, isolateHistory, undo, redo, selectLine, selectParentSyntax, indentMore, indentLess, cursorDocStart, cursorDocEnd, deleteLine, deleteGroupBackward } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { emojiCompletion } from './emoji.js';
import { renderMarkdown, renderDocument, renderDiagrams, renderMath, escapeHTML, invalidateFenceLanguages, tableSourceRanges, mathNumberingEnabled } from './markdown.js';
import { onLanguageLoaded } from './highlight.js';
import { linkAt } from './links.js';
import { buildSourceMap, sourceOffsetAt, imageSourceOffset } from './source-map.js';
import { inlineMarks } from './inline-marks.js';
import { liveBlock, blockReveal, documentLines } from './live-preview.js';
import { tableCellRanges, cellSourceRange, normalizeCellMarkdown, parseTables, rowPrefix } from './table.js';
import { applyEol, createEolContext, toLf } from './eol.js';
import { containerEnter } from './container-enter.js';

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
// Above this many characters the whole-document live layout is replaced by a
// plain source view. It is part of the editor's observable state, not just an
// implementation detail: the status marker below lets the desktop and
// performance tests tell a typeset document from the fallback. The benchmark
// keeps a 220k document live (measured well inside its 150 ms/key budget) and
// uses a document past this limit to cover the fallback path itself.
const LIVE_PREVIEW_LIMIT = 260000;
// Keeps the whole document typeset while a cell edit moves from one cell to the
// next: the commit rebuilds the widget, and without this the block holding the
// caret would expand into source lines and the target cell would be gone.
const cellEffect = StateEffect.define();
// A row / column reorder is a structural edit, not typing: the typeset table the
// user dropped into has to stay on screen instead of revealing the caret's block
// as Markdown. Unlike a cell commit this also has to survive undo / redo, which
// `invertedEffects` below arranges.
const reorderEffect = StateEffect.define();
const holdsTypeset = effect => effect.is(cellEffect) || effect.is(reorderEffect);
const modeField = StateField.define({ create: () => ({ source: false, composing: false, pristine: true, hold: false }), update(value, tr) {
  for (const effect of tr.effects) {
    if (effect.is(modeEffect)) value = { ...value, source: effect.value };
    if (effect.is(compositionEffect)) value = { ...value, composing: effect.value };
    if (effect.is(cellEffect)) value = { ...value, hold: effect.value };
    if (effect.is(reorderEffect)) value = { ...value, hold: true };
  }
  // Typora shows a newly opened file fully typeset. Only the first real
  // interaction (a click, caret move or keystroke) reveals the active block.
  if ((tr.docChanged || tr.selection) && !tr.effects.some(holdsTypeset)) {
    value = { ...value, pristine: false, hold: false };
  }
  return value;
} });

/**
 * Row and column drag handles for one rendered table.
 *
 * A data row is dragged from the grip in its first cell; a column from the
 * grip at the top of its header cell (the right edge stays the width resizer).
 * The header row and the delimiter row are never draggable, and the block's
 * source is only rewritten on drop, by one document transaction in main.js.
 *
 * The drop slot is resolved from the pointer against the current geometry:
 * dropping an item back into its own place dispatches nothing, and Escape
 * cancels the drag without touching the document. A drag also ends when the
 * window loses focus, when the block it started in was rebuilt (its document
 * changed or another document was activated) or when its positions moved: the
 * handle events live on `document`, so a stale drag must never edit whatever
 * document happens to be active at drop time.
 */
function bindTableReorder(element, info, table, tableIndex) {
  // Native HTML tables in the same block are real DOM tables with no Markdown
  // source of their own, so a DOM index can point past the GFM tables. The
  // receiving side compares this count with the block's GFM ranges and refuses
  // when the two index spaces cannot be matched.
  const domTables = element.querySelectorAll('table').length;
  // Positions and indices are resolved when the drag ends: the widget may have
  // been reused meanwhile, so nothing is read from a stale widget instance.
  const dispatchMove = (kind, from, slot, startedAt) => {
    if (!element.isConnected || info.from !== startedAt) return;
    const target = parseTables(info.source)[tableIndex];
    if (!target) return;
    // The receiving side re-checks the document id, the block source and the
    // rendered table boundaries before it writes anything.
    document.dispatchEvent(new CustomEvent('inkstone:table-move', {
      detail: {
        documentId: info.id, blockFrom: info.from, blockSource: info.source, tableIndex, domTables,
        kind, from, slot
      }
    }));
  };
  const slotAt = (boxes, coordinate, horizontal) => boxes.reduce((slot, box) =>
    slot + ((horizontal ? box.left + box.width / 2 : box.top + box.height / 2) < coordinate ? 1 : 0), 0);
  const highlight = (items, slot) => {
    for (const node of items) node.classList.remove('table-drop-before', 'table-drop-after');
    if (slot < 0 || !items.length) return;
    if (slot >= items.length) items[items.length - 1].classList.add('table-drop-after');
    else items[slot].classList.add('table-drop-before');
  };
  const startDrag = (event, { kind, from, items, horizontal }) => {
    if (event.button !== 0 || items.length < 2) return;
    if (kind === 'row' && from < 1) return;
    // `from` is a table row index (header included) for rows, a column index
    // for columns; slots are positions in `items`. The two differ by one for
    // rows because `items` starts at the first data row.
    const position = kind === 'row' ? from - 1 : from;
    // Own the gesture: no text selection, no cell edit, no column resize.
    event.preventDefault();
    event.stopPropagation();
    const boxes = items.map(node => node.getBoundingClientRect());
    const startedX = event.clientX, startedY = event.clientY;
    const startedAt = info.from;
    let slot = position, dragging = false, finished = false;
    const clear = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      element.classList.remove('table-reorder-active');
      highlight(items, -1);
    };
    // A drag that outlives its block must not keep painting or dispatch later.
    const stale = () => !element.isConnected || info.from !== startedAt;
    const onMove = move => {
      if (stale()) { finished = true; clear(); return; }
      if (!dragging && Math.hypot(move.clientX - startedX, move.clientY - startedY) < 4) return;
      dragging = true;
      element.classList.add('table-reorder-active');
      slot = slotAt(boxes, horizontal ? move.clientX : move.clientY, horizontal);
      highlight(items, slot);
    };
    const onUp = () => {
      if (finished) return;
      finished = true;
      const dropped = slot, moved = dragging;
      clear();
      // A click, Escape or a drop on the item's own place writes nothing.
      if (!moved || dropped === position || dropped === position + 1) return;
      dispatchMove(kind, from, kind === 'row' ? dropped + 1 : dropped, startedAt);
    };
    const onKey = key => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      if (finished) return;
      finished = true;
      clear();
    };
    const onBlur = () => {
      if (finished) return;
      finished = true;
      clear();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
  };
  const headerCells = [...(table.querySelector('tr')?.children || [])];
  const bodyRows = [...table.rows].slice(1);
  const handle = (className, label) => {
    const node = document.createElement('span');
    node.className = className;
    node.dataset.mdSkip = '';
    node.title = label;
    node.setAttribute('aria-hidden', 'true');
    return node;
  };
  headerCells.forEach((cell, column) => {
    const grip = handle('table-column-handle', '拖动以移动整列');
    cell.append(grip);
    grip.addEventListener('mousedown', event => startDrag(event, { kind: 'column', from: column, items: headerCells, horizontal: true }));
  });
  for (const row of bodyRows) {
    const cell = row.cells[0];
    if (!cell) continue;
    const grip = handle('table-row-handle', '拖动以移动该行');
    cell.append(grip);
    grip.addEventListener('mousedown', event => startDrag(event, { kind: 'row', from: row.rowIndex, items: bodyRows, horizontal: false }));
  }
}

// ── In-place table cell editing ────────────────────────────────────────────
/**
 * Inline decorations for the cell editor: the cell's own Markdown with the
 * same content styles the active block uses (bold, italic, code, link text)
 * and its syntax characters dimmed but visible, so they can be found and
 * edited. Nothing is inferred from the rendered DOM; this only describes the
 * editor's own source text.
 */
function cellDecorations(state, references) {
  const blockDocument = documentLines(state.doc.toString());
  // A reference link in a cell is resolved by the whole document, exactly as
  // markdown-it renders it when it builds the table.
  blockDocument.references = references;
  const live = liveBlock(blockDocument, 0, state.doc.lines, new Set([0]));
  const ranges = [];
  live.lines.forEach((info, index) => {
    // Literal content (fences, indented code) stays exactly as written.
    if (info.literal) return;
    const line = state.doc.line(index + 1);
    if (info.plain) {
      for (const mark of inlineMarks(line.text)) {
        ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(line.from + mark.from, line.from + mark.to));
      }
      return;
    }
    for (const mark of info.marks) {
      ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(line.from + mark.from, line.from + mark.to));
    }
    for (const style of info.styles) {
      ranges.push(Decoration.mark({ class: `cm-lv-${style.kind}` }).range(line.from + style.from, line.from + style.to));
    }
  });
  return Decoration.set(ranges, true);
}

/** Decorations follow the cell editor's document; no caret proximity rule. */
const cellPreview = references => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = cellDecorations(view.state, references); }
  update(update) { if (update.docChanged) this.decorations = cellDecorations(update.state, references); }
}, { decorations: value => value.decorations });

// The cell editor currently open, if any. It is module level because a click
// into another cell of the same table commits this one first and then reopens
// the clicked cell once the rebuilt table appears (`pendingCellFocus`).
let activeCellEdit = null;

class MarkdownWidget extends WidgetType {
  /**
   * `selected` marks a block that lies strictly between the two ends of a
   * selection. It is part of `eq` so a selection change reuses the DOM through
   * `updateDOM` instead of rebuilding it (and losing Mermaid / KaTeX trees).
   */
  constructor(source, from, to, id, html, selected = false) { super(); Object.assign(this, { source, from, to, id, html, selected }); }
  eq(other) { return this.source === other.source && this.from === other.from && this.to === other.to && this.id === other.id && this.html === other.html && this.selected === other.selected; }
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
    // The typeset block itself never changes; only the selection tint does.
    dom.classList.toggle('cm-block-selected', this.selected);
    return true;
  }
  toDOM(view) {
    const element = document.createElement('div');
    element.className = `md-widget prose${this.selected ? ' cm-block-selected' : ''}`;
    element.innerHTML = this.html;
    // Handlers and the drag-selection code outlive this widget instance (the
    // DOM is reused by updateDOM), so every document position is read from
    // this mutable block record instead of from `this`.
    const info = {
      from: this.from,
      to: this.to,
      // The document this block belongs to: a drag that started here must never
      // be applied to another document that became active meanwhile.
      id: this.id,
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
    // Resolve a rendered table to its exact source range using the renderer's
    // own token map. The model parser alone is not enough: a heading such as
    // `# H | Q` under a quoted table looks like another row, and a raw HTML
    // table is a DOM table with no Markdown source. When the DOM and the GFM
    // tables differ in number the index spaces cannot be matched, so the
    // operation is refused instead of editing a neighbouring table.
    let tableRanges = null, domTables = 0;
    const resolveTable = tableIndex => {
      tableRanges ||= tableSourceRanges(info.source);
      if (!domTables) domTables = element.querySelectorAll('table').length;
      if (domTables !== tableRanges.length) return null;
      const range = tableRanges[tableIndex];
      if (!range) return null;
      const source = info.source.slice(range.start, range.end);
      const parsed = parseTables(source);
      // The renderer and the model must describe the same table exactly.
      if (parsed.length !== 1 || parsed[0].start !== 0 || parsed[0].end !== source.length) return null;
      return { range, source, table: parsed[0] };
    };
    // Right-click (or Alt+click) opens the full grid editor for this table.
    element.addEventListener('contextmenu', event => {
      // Inside the in-cell Markdown editor the native text context menu stays.
      if (event.target.closest('.table-cell-editor')) return;
      const cell = event.target.closest('td, th');
      if (!cell) return;
      const tableIndex = [...element.querySelectorAll('table')].indexOf(cell.closest('table'));
      // A raw HTML table and the GFM tables of the same block do not share an
      // index space; never open a neighbouring table's source from here.
      if (!resolveTable(tableIndex)) return;
      event.preventDefault();
      element.dispatchEvent(new CustomEvent('inkstone:table-edit', {
        bubbles: true,
        detail: { source: info.source, from: info.from, index: tableIndex }
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
          // A native HTML table has no source range; a block whose DOM tables
          // and GFM tables disagree must not resize a neighbouring table.
          const resolved = resolveTable(tableIndex);
          if (!resolved) return;
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
            // Dispatch on document: the widget may already have been replaced
            // by source lines while the pointer was moving. A detached block
            // must not write its widths into whichever table happens to be at
            // that offset now.
            if (!element.isConnected) return;
            document.dispatchEvent(new CustomEvent('inkstone:table-width', {
              detail: {
                absoluteStart: info.toDoc(resolved.range.start),
                widths: widths.map(value => value * 100 / total)
              }
            }));
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp, { once: true });
        });
      });
      // Row / column drag handles are added last: they are generated UI with no
      // source counterpart, so they must never influence the character map.
      bindTableReorder(element, info, table, tableIndex);
    }
    // A rendered cell is edited in place by a small CodeMirror instance whose
    // document is exactly the cell's Markdown. The source stays the truth:
    // the commit writes `state.doc` back to the cell's source range, while
    // `cellDecorations` keeps bold / italic / code / link text typeset and
    // shows the Markdown markers dimmed so they can be found and edited.
    // Detaching the rendered child nodes into a fragment (instead of
    // re-creating them from HTML) lets Escape and "no change" restore the exact
    // same DOM, so the block's text→source map keeps working afterwards.
    const cellAt = (tableIndex, lineIndex, column) => {
      const table = element.querySelectorAll('table')[tableIndex];
      const row = table?.rows[lineIndex === 0 ? 0 : lineIndex - 1];
      return row?.cells[column] || null;
    };

    const startCellEdit = (cell, tableIndex) => {
      if (!cell || cell.querySelector('.table-cell-editor')) return;
      // The source range comes from the renderer's table map, not from the
      // model's row scan alone. A quoted heading with a pipe is its own block
      // and a raw HTML table is not a GFM table, so the index is only trusted
      // when both sides agree.
      const resolved = resolveTable(tableIndex);
      if (!resolved) return;
      const { table, source: tableSource } = resolved;
      const rowIndex = cell.parentElement.rowIndex, column = cell.cellIndex;
      const lines = tableSource.split('\n');
      const range = cellSourceRange(tableSource, rowIndex, column);
      if (!range) return;
      const lineIndex = range.lineIndex;
      const markdown = range.markdown;
      // Moving between cells: the open editor commits first, and the clicked
      // cell is entered after the table has been rebuilt from that commit.
      if (activeCellEdit && !activeCellEdit.element.isConnected) activeCellEdit.dispose();
      if (activeCellEdit) {
        if (activeCellEdit.element === element) {
          activeCellEdit.continueAt({ tableIndex, lineIndex, column });
          return;
        }
        activeCellEdit.finish('blur');
        // The other block's commit may have rebuilt this widget after all.
        if (!cell.isConnected) return;
      }
      // Freeze the table's current column widths while the raw Markdown is
      // shown. Syntax markers and link destinations are wider than the rendered
      // text; an auto-layout table would otherwise reflow every column on
      // entering the cell. The temporary colgroup (or the fixed layout over the
      // existing one) is removed again on Escape / no change.
      const tableElement = cell.closest('table');
      const previousLayout = tableElement.style.tableLayout;
      const existingColumns = tableElement.querySelector('colgroup');
      let temporaryColumns = null;
      if (tableElement.rows[0]?.cells.length) {
        const widths = [...tableElement.rows[0].cells].map(node => node.getBoundingClientRect().width);
        const total = widths.reduce((sum, value) => sum + value, 0);
        if (total > 0) {
          temporaryColumns = document.createElement('colgroup');
          temporaryColumns.dataset.mdSkip = '';
          temporaryColumns.replaceChildren(...widths.map(value => {
            const col = document.createElement('col');
            col.style.width = `${(value * 100 / total).toFixed(3)}%`;
            return col;
          }));
          existingColumns?.remove();
          tableElement.prepend(temporaryColumns);
          tableElement.style.tableLayout = 'fixed';
        }
      }
      const restoreColumns = () => {
        temporaryColumns?.remove();
        if (existingColumns && !existingColumns.isConnected) tableElement.prepend(existingColumns);
        tableElement.style.tableLayout = previousLayout;
      };
      const originals = document.createDocumentFragment();
      while (cell.firstChild) originals.append(cell.firstChild);
      const host = document.createElement('div');
      host.className = 'table-cell-editor';
      host.dataset.mdSkip = '';
      cell.replaceChildren(host);
      cell.classList.add('table-cell-editing');
      let cellView = null;
      let finished = false;
      // Filled in after the view exists; key bindings only run once it is focused.
      let submit = null, cancel = null;
      const references = parsedFor(view.state.doc.toString(), info.id).document.references;
      cellView = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: markdown,
          extensions: [
            cellPreview(references),
            keymap.of([
              { key: 'Escape', run: () => (cancel ? cancel() : false) },
              // Enter appends a row; Shift-Enter has never inserted a line break
              // into a cell, so it commits the same way.
              { key: 'Enter', run: () => (submit ? submit('enter') : false) },
              { key: 'Shift-Enter', run: () => (submit ? submit('enter') : false) },
              { key: 'Tab', run: () => (submit ? submit('tab') : false) },
              { key: 'Shift-Tab', run: () => (submit ? submit('shift-tab') : false) }
            ]),
            history({ minDepth: 50 }), keymap.of(historyKeymap),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': '表格单元格 Markdown', autocapitalize: 'off' })
          ]
        })
      });
      // A key that belongs to an IME candidate window must never reach the cell
      // keymap. CodeMirror only knows a composition that the browser reported;
      // an IME confirmation can also arrive as `isComposing` / keyCode 229.
      // Stop it on the capture phase (so no earlier keymap runs), but let the
      // browser / IME keep its default action.
      host.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) event.stopPropagation();
      }, true);
      // Editable cells in reading order; the delimiter row is syntax, not content.
      // This line is known to be a table row, so outer pipes are optional here.
      const order = [0, ...Array.from({ length: Math.max(0, lines.length - 2) }, (_, index) => index + 2)]
        .flatMap(line => tableCellRanges(lines[line], { optionalOuterPipes: true }).map((_, at) => ({ lineIndex: line, column: at })));
      const target = step => {
        const at = order.findIndex(candidate => candidate.lineIndex === lineIndex && candidate.column === column);
        return at < 0 ? null : order[at + step] || null;
      };
      const value = () => normalizeCellMarkdown(cellView.state.doc.toString());
      /** Close the editor without writing: the original DOM comes back intact. */
      const restore = () => {
        if (cellView) { cellView.destroy(); cellView = null; }
        host.remove();
        cell.classList.remove('table-cell-editing');
        cell.replaceChildren(originals);
        restoreColumns();
      };
      submit = (direction = 'blur', continueAt = null, isolate = false) => {
        if (finished) return true;
        finished = true;
        activeCellEdit = null;
        const changes = [], next = value();
        // Nothing typed means nothing to write: no document change and no undo step.
        if (next !== markdown.trim()) {
          changes.push({ from: toDocOffset(resolved.range.start + range.from), to: toDocOffset(resolved.range.start + range.to), insert: next });
        }
        let focus = continueAt || (direction === 'tab' ? target(1) : direction === 'shift-tab' ? target(-1) : null);
        if (direction === 'enter') {
          // Enter appends a body row, keeping the table's container prefix so a
          // table inside a quote or a list item stays inside it.
          const columns = Math.max(...table.rows.map(row => row.length), table.aligns.length);
          const at = toDocOffset(resolved.range.start + table.end);
          const prefix = rowPrefix(lines[lines.length - 1]);
          changes.push({ from: at, to: at, insert: `\n${prefix}|${Array(columns).fill('  ').join('|')}|` });
          focus = { lineIndex: lines.length, column: 0 };
        }
        if (!changes.length) {
          restore();
          if (focus) startCellEdit(cellAt(tableIndex, focus.lineIndex, focus.column), tableIndex);
          return true;
        }
        pendingCellFocus = focus ? { blockFrom: info.from, tableIndex, ...focus } : null;
        restore();
        // One transaction for the whole cell edit: one undo step, and the table
        // stays typeset because the commit is not caret-relative typing. A
        // lifecycle commit (explicit save / close / document switch) is isolated
        // so it cannot be merged with the typing that preceded it.
        const spec = { changes, effects: cellEffect.of(true) };
        if (isolate) spec.annotations = isolateHistory.of('full');
        view.dispatch(spec);
        continuePendingCellEdit();
        return true;
      };
      cancel = () => {
        if (finished) return true;
        finished = true;
        activeCellEdit = null;
        restore();
        view.focus();
        return true;
      };
      activeCellEdit = {
        element,
        cell,
        isDirty: () => value() !== markdown.trim(),
        isComposing: () => Boolean(cellView?.composing),
        commit: () => submit('blur', null, true),
        continueAt: targetCell => submit('blur', targetCell),
        finish: direction => submit(direction),
        dispose: () => { if (!finished) { finished = true; activeCellEdit = null; restore(); } }
      };
      // Leaving the cell commits, exactly as the old contenteditable did. Focus
      // moving inside the cell editor is not leaving it.
      host.addEventListener('focusout', event => {
        if (finished) return;
        if (event.relatedTarget && host.contains(event.relatedTarget)) return;
        submit('blur');
      });
      queueMicrotask(() => {
        if (finished || !host.isConnected) return;
        cellView.dispatch({ selection: { anchor: 0, head: cellView.state.doc.length } });
        cellView.focus();
      });
    };
    element._inkstone.editCell = (tableIndex, lineIndex, column) => startCellEdit(cellAt(tableIndex, lineIndex, column), tableIndex);
    element.addEventListener('mousedown', event => {
      // Right-click belongs to the context-menu handler (grid table editor).
      if (event.button !== 0) return;
      // The in-cell editor owns its own pointer gestures (caret placement,
      // source selection); a click inside it must not reopen the cell.
      if (event.target.closest('.table-cell-editor')) return;
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
        // A click inside the cell editor is the nested editor's own business.
        if (cell.querySelector('.table-cell-editor')) return;
        event.preventDefault();
        const tableIndex = [...element.querySelectorAll('table')].indexOf(cell.closest('table'));
        if (event.altKey) {
          // Ambiguous DOM / GFM indices (a raw HTML table in the same block) must
          // not open the grid editor on a neighbouring table.
          if (!resolveTable(tableIndex)) return;
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

/** Bullets, task boxes, quotes and rules replace their source prefix in the layout. */
class PrefixWidget extends WidgetType {
  constructor(kind, docFrom, checked, label) { super(); Object.assign(this, { kind, docFrom, checked, label }); }
  eq(other) { return this.kind === other.kind && this.docFrom === other.docFrom && this.checked === other.checked && this.label === other.label; }
  toDOM(view) {
    const span = document.createElement('span');
    span.className = `cm-prefix cm-prefix-${this.kind}`;
    if (this.kind === 'bullet') span.textContent = '•';
    if (this.kind === 'ordered') span.textContent = this.label;
    if (this.kind === 'quote') {
      span.setAttribute('aria-label', '引用');
      span.setAttribute('aria-hidden', 'true');
    }
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
  // Let CodeMirror place the caret from a click on a bullet, quote marker or
  // rule; clicking the left half of a compact marker lands inside its hidden
  // source and the next decoration pass reveals it, so the rule is one click
  // away from its Markdown source. A task widget owns its click (toggling the
  // box), so the editor must not also move the caret there.
  ignoreEvent() { return this.kind === 'task'; }
}

// Rendering the whole document once is what gives every block the same parse
// environment. Cache by (document id + text): selection changes recompute
// decorations but must not re-parse the file.
let blockCache = { key: '', blocks: [], tokens: [], document: null, math: null };
const blockCacheKey = (id, source) => `${id}\u0000${mathNumberingEnabled() ? '1' : '0'}\u0000${source}`;
function parsedFor(source, id) {
  const numbering = mathNumberingEnabled();
  const key = blockCacheKey(id, source);
  // One parse per document version. Selection-only updates reuse both the
  // block HTML and the token ranges, which keeps caret movement cheap even
  // in long technical documents. `document` holds the normalised text and the
  // line table the active block is sliced and parsed from.
  if (blockCache.key !== key) blockCache = { key, ...renderDocument(source, id, { mathNumbering: numbering }), document: documentLines(source) };
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

// Heading typography belongs to the preview layer. CodeMirror's default
// heading tag otherwise adds bold/underline even while a heading is pending.
const editorHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.filter(spec => spec.tag !== tags.heading));

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
  blockCache = { key: '', blocks: [], tokens: [], document: null, math: null };
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
const bracketMathOpen = /^\s*\\\[\s*$/;
const bracketMathClose = /^\s*\\\]\s*$/;
const fenceOpen = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/;
const MAX_PREVIEW_BLOCK_LINES = 400;

/** The `$$…$$`, `\[…\]` or ```mermaid / ```sequence / ```flow block that contains `pos`, or null. */
function enclosingPreviewBlock(doc, pos) {
  const caret = doc.lineAt(pos);
  const first = Math.max(1, caret.number - MAX_PREVIEW_BLOCK_LINES);
  let opener = null;
  for (let number = caret.number; number >= first; number--) {
    const text = doc.line(number).text;
    if (number < caret.number && bracketMathClose.test(text)) return null;
    if (mathFence.test(text)) { opener = { kind: 'math', number, close: mathFence }; break; }
    if (bracketMathOpen.test(text)) { opener = { kind: 'math', number, close: bracketMathClose }; break; }
    const fence = fenceOpen.exec(text);
    if (fence) {
      const language = fence[2].toLowerCase();
      if (language !== 'mermaid' && language !== 'sequence' && language !== 'flow') return null;
      opener = { kind: language, number, marker: fence[1] };
      break;
    }
  }
  if (!opener) return null;
  const last = Math.min(doc.lines, opener.number + MAX_PREVIEW_BLOCK_LINES);
  for (let number = opener.number + 1; number <= last; number++) {
    const text = doc.line(number).text;
    const closes = opener.kind === 'math' ? opener.close.test(text) : new RegExp(`^\\s*${opener.marker}\\s*$`).test(text);
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
const previewKey = preview => preview ? `${preview.kind}\u0000${preview.source}\u0000${preview.renderSource || ''}\u0000${preview.mathKey || ''}\u0000${preview.from}\u0000${preview.to}` : '';

const previewField = StateField.define({
  create: () => null,
  update(value, tr) {
    // Manual source mode shows source only, so an existing preview is cleared
    // immediately. Switching back is handled by the scheduler below.
    if (tr.state.field(modeField, false)?.source) return null;
    for (const effect of tr.effects) if (effect.is(previewEffect)) value = effect.value;
    // Editing shifts the block; the widget position follows the document.
    if (tr.docChanged && value) value = { ...value, from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    return value;
  }
});
class PreviewWidget extends WidgetType {
  constructor(preview) { super(); Object.assign(this, preview); }
  // The source and its prepared math decide whether the preview must be
  // rebuilt; a move only refreshes the position the click puts the caret at.
  eq(other) {
    return this.kind === other.kind && this.source === other.source &&
      (this.renderSource || '') === (other.renderSource || '') &&
      (this.mathKey || '') === (other.mathKey || '');
  }
  updateDOM(dom) {
    const info = dom._inkstone;
    if (!info || info.source !== this.source || info.kind !== this.kind ||
      (info.renderSource || '') !== (this.renderSource || '')) return false;
    info.to = this.anchor;
    info.mathKey = this.mathKey || '';
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
    wrap._inkstone = { kind: this.kind, source: this.source, to: this.anchor, renderSource: this.renderSource || '', mathKey: this.mathKey || '' };
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
      const { html, error } = renderMath(this.renderSource || this.source);
      if (error) body.innerHTML = `<p class="md-live-preview-error">${escapeHTML(error)}</p>`;
      else body.innerHTML = html;
    } else {
      const diagram = document.createElement('pre');
      diagram.className = this.kind === 'mermaid' ? 'mermaid' : 'diagram';
      if (this.kind !== 'mermaid') diagram.dataset.diagram = this.kind;
      diagram.textContent = this.source;
      body.append(diagram);
      // The shared diagram queue renders asynchronously and shows a Chinese
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
      widget: new PreviewWidget({
        kind: preview.kind, source: preview.source, anchor: position,
        renderSource: preview.renderSource || '', mathKey: preview.mathKey || ''
      }),
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
const previewSchedulerFor = id => ViewPlugin.fromClass(class {
  constructor(view) { this.timer = 0; this.schedule(view); }
  update(update) {
    const changed = update.transactions.some(transaction =>
      transaction.effects.some(effect => effect.is(refreshEffect) || effect.is(modeEffect)));
    if (update.docChanged || update.selectionSet || changed) this.schedule(update.view);
  }
  schedule(view) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!view.dom.isConnected) return;
      // In source mode the whole document is code; a preview would duplicate
      // the block the user is already reading, so it only applies to the
      // typeset view. The large-document fallback is still a source layout,
      // but a local formula or Mermaid preview needs no document-wide parse,
      // so it keeps working there.
      const mode = view.state.field(modeField, false);
      const position = view.state.selection.main.head;
      let next = null;
      if (!mode?.source) {
        const block = enclosingPreviewBlock(view.state.doc, position);
        if (block) {
          next = { ...block, anchor: block.to };
          // Only a formula needs the whole-document registry for labels and
          // automatic numbers. Mermaid and the >260k source fallback stay on
          // the local source and must not trigger parsedFor().
          if (block.kind === 'math' && view.state.doc.length <= LIVE_PREVIEW_LIMIT) {
            // Use the whole-document context for the viewed document. The
            // global block cache may currently hold another document or an
            // older numbering preference; parsedFor() reuses this document's
            // existing render when it matches and otherwise rebuilds it through
            // the normal shared-parse entry point. That prepared content
            // already contains this formula's automatic number and every
            // resolved reference.
            const source = view.state.doc.toString();
            const plan = blockCache.key === blockCacheKey(id, source) ? blockCache : parsedFor(source, id);
            const line = view.state.doc.lineAt(block.from).number - 1;
            const token = plan.tokens.find(token =>
              token.type === 'math_block' && token.math && token.map?.[0] === line);
            if (token?.math) {
              next.renderSource = token.math.content;
              next.mathKey = `${token.math.number ?? ''}\u0002${token.math.content}`;
            }
          }
        }
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
  if (mode.source || state.doc.length > LIVE_PREVIEW_LIMIT) return Decoration.none;
  const source = state.doc.toString();
  const { tokens, blocks, document, imageRoot } = parsedFor(source, id);
  const htmlByStart = new Map(blocks.map(block => [block.start, block.html]));
  const ranges = [], occupied = new Set(), coveredLines = new Set();
  // Before any interaction, the caret at offset 0 must not turn the first
  // heading into an editable source line; the whole document is a reading view.
  const selection = mode.pristine || mode.hold ? [] : state.selection.ranges;
  const editingLines = new Set();
  const caretLines = new Map();
  for (const range of selection) {
    if (!range.empty) continue;
    const line = state.doc.lineAt(range.head);
    const index = line.number - 1;
    editingLines.add(index);
    const cols = caretLines.get(index) || [];
    cols.push(range.head - line.from);
    caretLines.set(index, cols);
  }

  const decorateActiveRange = (start, end, tokenType = '', tokenTag = '') => {
    // The block is parsed as a whole, so emphasis may cross soft line breaks
    // and code fences nested in a list are known to be literal. Only this
    // block is parsed, which keeps every keystroke proportional to it.
    const live = liveBlock(document, start, end, editingLines, caretLines);
    // Only a multi-line Setext heading stays provisional while editing its
    // underline row (`正文\n- `); ATX headings keep their display scale.
    const pendingHeading = tokenType === 'heading_open' && end > start + 1 && editingLines.has(end - 1);
    // Typora renders a completed syntax at once, even with the caret right
    // after the closing marker. Only a caret *inside* the element (or a
    // selection overlapping it) brings the source characters back.
    const reveal = blockReveal(live, selection.map(range => ({
      from: blockOffset(live, state, range.from, start), to: blockOffset(live, state, range.to, start)
    })));
    live.lines.forEach((info, index) => {
      const line = state.doc.line(start + 1 + index);
      const classes = ['cm-live-line', ...info.classes];
      const readyHeading = info.classes.some(name => /^cm-lv-h[1-6]$/.test(name)) || (end > start + 1 && !pendingHeading);
      if (index === 0 && tokenType === 'heading_open' && readyHeading) classes.push(`cm-heading-${tokenTag.slice(1)}`);
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
      for (const prefix of info.prefixes) {
        const prefixFrom = line.from + prefix.from, prefixTo = line.from + prefix.to;
        if (reveal.prefixes.has(prefix)) {
          ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(prefixFrom, prefixTo));
        } else if (prefix.kind === 'heading') {
          ranges.push(Decoration.replace({ widget: hiddenMark }).range(prefixFrom, prefixTo));
        } else {
          // A quote owns an inline indentation/rule span, so prefixes remain
          // ordered correctly for `- > item` as well as `> - item`. The line
          // class only contributes the muted quote colour.
          ranges.push(Decoration.replace({
            widget: new PrefixWidget(prefix.kind, line.from + (prefix.checkOffset ?? 0), prefix.checked, prefix.label)
          }).range(prefixFrom, prefixTo));
        }
      }
    });
  };

  for (const token of tokens) {
    if (!token.map || token.level !== 0 || token.nesting === -1) continue;
    const [start, rawEnd] = token.map;
    let end = rawEnd;
    if (token.type !== 'fence' && token.type !== 'code_block' && token.type !== 'math_block') {
      while (end > start + 1 && end <= state.doc.lines && !state.doc.line(end).text.trim()) end--;
    }
    if (start >= end || occupied.has(start) || end > state.doc.lines) continue;
    occupied.add(start);
    for (let lineIndex = start; lineIndex < end; lineIndex++) coveredLines.add(lineIndex);
    const from = state.doc.line(start + 1).from;
    const to = state.doc.line(end).to;
    if (from === to) continue;
    // Only the block that owns a selection endpoint stays editable. A block
    // that the selection merely passes through keeps its typeset layout and its
    // Markdown hidden, so the page does not turn into source as the selection
    // grows. Both endpoints are active: the anchor is where the drag (or
    // Shift-extend) began and the head is where it is now, and each has to be
    // visible to place a caret.
    const active = selection.some(range =>
      (range.anchor >= from && range.anchor <= to) || (range.head >= from && range.head <= to));
    // The active block stays editable, but reads as typeset prose: syntax
    // characters are removed from the layout until the caret comes near them,
    // and the content itself receives real typography (bold, italic, code…).
    if (active) {
      decorateActiveRange(start, end, token.type, token.tag);
      continue;
    }
    const text = state.doc.sliceString(from, to, '\n');
    const html = htmlByStart.get(start) ?? renderMarkdown(text, id, { mathNumbering: mathNumberingEnabled(), imageRoot });
    // A block strictly inside one selection range is a middle block: it stays
    // typeset (no Markdown revealed, no layout change) and is only tinted.
    const selected = selection.some(range => !range.empty && range.from <= from && range.to >= to);
    ranges.push(Decoration.replace({ widget: new MarkdownWidget(text, from, to, id, html, selected), block: true }).range(from, to));
  }
  // Link references (`[ref]: url`) and footnote definitions (`[^fn]: ...`)
  // carry no top-level token.map in markdown-it; apply live-preview formatting
  // so they never fall back to raw monospace text.
  for (let lineIndex = 0; lineIndex < state.doc.lines; lineIndex++) {
    if (coveredLines.has(lineIndex)) continue;
    if (state.doc.line(lineIndex + 1).text.trim()) decorateActiveRange(lineIndex, lineIndex + 1);
  }
  return Decoration.set(ranges, true);
}

/**
 * Publish the layout on the editor element: `typeset`, explicit `source`, or
 * `source-fallback` for a document past LIVE_PREVIEW_LIMIT. The benchmark and
 * the desktop test use this instead of inferring the state from whether a
 * widget happens to be visible in the viewport.
 */
const layoutMarker = ViewPlugin.fromClass(class {
  constructor(view) { this.publish(view); }
  update(update) { this.publish(update.view); }
  publish(view) {
    const source = view.state.field(modeField, false)?.source;
    view.dom.dataset.inkstoneLength = String(view.state.doc.length);
    view.dom.dataset.inkstoneLines = String(view.state.doc.lines);
    view.dom.dataset.inkstoneLayout = source ? 'source'
      : view.state.doc.length > LIVE_PREVIEW_LIMIT ? 'source-fallback' : 'typeset';
  }
});

/** Enter rendered block widgets one line at a time instead of jumping past them on ArrowDown / ArrowUp. */
function verticalBlockStep(view, forward) {
  const { state } = view;
  if (state.field(modeField, false)?.source) return false;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(range.head);
  const targetNumber = forward ? line.number + 1 : line.number - 1;
  if (targetNumber < 1 || targetNumber > state.doc.lines) return false;
  const next = view.moveVertically(range, forward);
  const nextLine = state.doc.lineAt(next.head).number;
  const skipped = forward
    ? (nextLine > targetNumber || next.head === range.head)
    : (nextLine < targetNumber || next.head === range.head);
  if (!skipped) return false;
  const target = state.doc.line(targetNumber);
  const col = Math.min(range.head - line.from, target.length);
  view.dispatch({ selection: { anchor: target.from + col }, scrollIntoView: true });
  return true;
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
      return tr.docChanged || tr.selection || tr.effects.some(e => e.is(modeEffect) || e.is(compositionEffect) || holdsTypeset(e) || e.is(refreshEffect))
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
      modeField, layoutMarker, preview, gutter.of([]), spelling.of(EditorView.contentAttributes.of({ id: 'write', spellcheck: 'true', 'aria-label': 'Markdown 文档编辑器' })),
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
      history({ minDepth: 100, newGroupDelay: 600 }),
      // Reordering a table keeps the document typeset, and its undo / redo has
      // to look the same instead of exposing the caret's block as Markdown.
      invertedEffects.of(tr => tr.effects.filter(effect => effect.is(reorderEffect))),
      drawSelection(), highlightActiveLine(), highlightSelectionMatches(), bracketMatching(), closeBrackets(), indentOnInput(),
      autocompletion({ override: [emojiCompletion], activateOnTyping: true, icons: false }),
      // `codeLanguages` gives the fence the caret is in a real parser (loaded on
      // demand by @codemirror/language-data); the extra highlight style maps its
      // tokens onto the same palette the rendered page uses.
      markdown({ codeLanguages: languages }), syntaxHighlighting(editorHighlightStyle), syntaxHighlighting(codeHighlightStyle),
      // Run before the Markdown language's own Enter binding, which inserts
      // an extra list/quote line before it lets the caret leave the container.
      Prec.highest(keymap.of([{ key: 'Enter', run: view => {
        const { doc, selection } = view.state;
        if (enclosingPreviewBlock(doc, selection.main.head)?.kind === 'math') return false;
        return containerEnter(view);
      } }])),
      previewField, previewDecorations, previewSchedulerFor(doc.id),
      EditorView.lineWrapping, placeholder('开始写作，或输入 # 创建标题'),
      // Panel labels and prompts follow the Chinese interface.
      EditorState.phrases.of(CHINESE_PHRASES),
      search({ top: true }),
      keymap.of([
        { key: 'ArrowDown', run: view => verticalBlockStep(view, true) },
        { key: 'ArrowUp', run: view => verticalBlockStep(view, false) },
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
        // The application menu owns ⌘⇧O on macOS and Ctrl+P on Windows / Linux.
        // macOS keeps ⌘P as an editor binding (Typora's habit), registered only
        // here: the renderer's own handler stays off in Electron, and the Windows
        // menu accelerator is never duplicated by a second key registration.
        ...(window.desktop && isMac ? [{ key: 'Mod-p', run: dispatch('quick-open') }] : []),
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
        // A cell editor lives inside a widget DOM. If that block was rebuilt by
        // an edit from elsewhere (reload, external change, undo of another
        // block), the cell is gone and its CodeMirror instance must not keep
        // document listeners alive.
        if (activeCellEdit && !activeCellEdit.element.isConnected) activeCellEdit.dispose();
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
    destroy() {
      if (activeCellEdit && view.dom.contains(activeCellEdit.element)) activeCellEdit.dispose();
      previewViews.delete(view);
      view.destroy();
    },
    undo() { undo(view); view.focus(); },
    redo() { redo(view); view.focus(); },
    setSource(value) { view.dispatch({ effects: [modeEffect.of(value), gutter.reconfigure(value ? lineNumbers() : [])] }); },
    /** Re-render every block after a preference that is baked into HTML.
     *  Formula auto-numbering is the current caller: unlike the old CSS
     *  counters, the number now has to be part of the KaTeX tree so references
     *  and exports agree with the reading view. */
    refreshRendered() {
      blockCache = { key: '', blocks: [], tokens: [], document: null, math: null };
      if (view.dom.isConnected) view.dispatch({ effects: refreshEffect.of(true) });
    },
    setSpellcheck(value) { view.dispatch({ effects: spelling.reconfigure(EditorView.contentAttributes.of({ id: 'write', spellcheck: String(value), 'aria-label': 'Markdown 文档编辑器' })) }); },
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
    /**
     * Commit the active in-cell Markdown draft before an explicit lifecycle
     * action reads the document (save, save as, close, document switch).
     *
     * Only a dirty, non-composing draft is committed: an unchanged cell stays
     * open, and background flushes never call this. The commit is an isolated
     * history step, so one undo removes exactly the committed draft and not
     * the typing that preceded it.
     */
    commitActiveCell({ focus = false } = {}) {
      const edit = activeCellEdit;
      if (!edit || !view.dom.contains(edit.element)) return false;
      if (!edit.element.isConnected) { edit.dispose(); return false; }
      if (edit.isComposing() || !edit.isDirty()) return false;
      edit.commit();
      if (focus) view.focus();
      return true;
    },
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
    /**
     * Minimal, selection-preserving edit (persisted table widths). An array of
     * changes becomes a single transaction, so one undo restores all of it.
     */
    applyChange(changes) {
      const list = (Array.isArray(changes) ? changes : [changes]).map(change => ({ ...change, insert: toLf(change.insert) }));
      view.dispatch({ changes: list });
      view.focus();
    },
    /**
     * A table row / column reorder. It is one isolated history step (typing
     * nearby and two consecutive reorders stay separate undo steps) and it
     * keeps the typeset layout, so the table the user dragged stays a table
     * instead of turning into the caret's source block.
     */
    applyReorder(changes) {
      const list = (Array.isArray(changes) ? changes : [changes]).map(change => ({ ...change, insert: toLf(change.insert) }));
      view.dispatch({ changes: list, effects: reorderEffect.of(true), annotations: isolateHistory.of('full') });
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
