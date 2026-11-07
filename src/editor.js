import { EditorState, StateEffect, StateField, Compartment, EditorSelection } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, drawSelection, highlightActiveLine, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectLine, selectParentSyntax, indentMore, indentLess, cursorDocStart, cursorDocEnd, deleteLine, deleteGroupBackward } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, syntaxTree } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { emojiCompletion } from './emoji.js';
import { renderMarkdown, renderDocument, renderDiagrams } from './markdown.js';
import { buildSourceMap, sourceOffsetAt, imageSourceOffset } from './source-map.js';
import { inlineMarks } from './inline-marks.js';
import { liveLine, revealFor } from './live-preview.js';
import { tableCellRanges, parseTables } from './table.js';

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
const modeField = StateField.define({ create: () => ({ source: false, composing: false, pristine: true }), update(value, tr) {
  for (const effect of tr.effects) {
    if (effect.is(modeEffect)) value = { ...value, source: effect.value };
    if (effect.is(compositionEffect)) value = { ...value, composing: effect.value };
  }
  // Typora shows a newly opened file fully typeset. Only the first real
  // interaction (a click, caret move or keystroke) reveals the active block.
  if (tr.docChanged || tr.selection) value = { ...value, pristine: false };
  return value;
} });

class MarkdownWidget extends WidgetType {
  constructor(source, from, to, id, html) { super(); Object.assign(this, { source, from, to, id, html }); }
  eq(other) { return this.source === other.source && this.from === other.from && this.to === other.to && this.id === other.id && this.html === other.html; }
  toDOM(view) {
    const element = document.createElement('div');
    element.className = 'md-widget prose';
    element.innerHTML = this.html;
    element.dataset.from = this.from;
    element.dataset.to = this.to;
    const sourceMap = buildSourceMap(element, this.source);
    // Fall back to the block start (after a heading marker) when a click lands
    // on generated UI with no source counterpart, e.g. math, diagrams, TOC.
    const fallback = this.source.match(/^#{1,6} /)?.[0].length || 0;
    const toDocOffset = offset => {
      const clamped = Math.min(Math.max(offset, 0), this.source.length);
      // CodeMirror positions always count its normalized internal line break
      // as one character. The configured CRLF separator is used only when
      // serializing text back out of the state.
      return Math.min(this.to, this.from + clamped);
    };
    // Consumed by resolveDocPosition for cross-block drag selection.
    element._inkstone = { map: sourceMap, source: this.source, fallback, toDoc: toDocOffset };
    // Right-click (or Alt+click) opens the full grid editor for this table.
    element.addEventListener('contextmenu', event => {
      const cell = event.target.closest('td, th');
      if (!cell) return;
      event.preventDefault();
      element.dispatchEvent(new CustomEvent('inkstone:table-edit', {
        bubbles: true,
        detail: { source: this.source, from: this.from, index: [...element.querySelectorAll('table')].indexOf(cell.closest('table')) }
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
            const parsed = parseTables(this.source);
            const target = parsed[tableIndex];
            // Dispatch on document: the widget may already have been replaced
            // by source lines while the pointer was moving.
            document.dispatchEvent(new CustomEvent('inkstone:table-width', {
              detail: {
                absoluteStart: target ? toDocOffset(target.start) : this.from,
                widths: widths.map(value => value * 100 / total)
              }
            }));
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp, { once: true });
        });
      });
    }
    element.addEventListener('mousedown', event => {
      // Right-click belongs to the context-menu handler (grid table editor).
      if (event.button !== 0) return;
      // The edge of a header cell belongs to the column resizer.
      const headerCell = event.target.closest('th');
      if (headerCell && event.clientX >= headerCell.getBoundingClientRect().right - 9) return;
      const link = event.target.closest('a');
      if (link && (event.metaKey || event.ctrlKey)) return;
      // The document-level handler owns outline/TOC navigation. Do not replace
      // the widget before the click event reaches that link.
      if (event.target.closest('[data-line]')) return;
      // Let generated controls (code copy) receive their own click.
      if (event.target.closest('[data-copy-code]')) return;
      if (event.target.matches('input[type="checkbox"]')) {
        event.preventDefault();
        const index = [...element.querySelectorAll('input[type="checkbox"]')].indexOf(event.target);
        const matches = [...this.source.matchAll(/^\s*[-*+] \[([ xX])\]/gm)];
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
        event.preventDefault();
        const tableIndex = [...element.querySelectorAll('table')].indexOf(cell.closest('table'));
        const detail = { source: this.source, from: this.from, index: tableIndex };
        if (event.altKey) {
          element.dispatchEvent(new CustomEvent('inkstone:table-edit', { bubbles: true, detail }));
          return;
        }
        const table = parseTables(this.source)[tableIndex];
        const row = cell.parentElement.rowIndex, column = cell.cellIndex;
        const lines = table ? this.source.slice(table.start, table.end).split('\n') : [];
        const lineIndex = row === 0 ? 0 : row + 1;
        let offset = table?.start || 0;
        for (let index = 0; index < lineIndex; index++) offset += lines[index].length + 1;
        const range = tableCellRanges(lines[lineIndex] || '')[column];
        if (!range) return;
        const original = (cell.childNodes[0]?.textContent || cell.textContent || '').trim();
        cell.replaceChildren(document.createTextNode(original));
        cell.contentEditable = 'plaintext-only';
        cell.classList.add('table-cell-editing');
        const commit = () => {
          if (!cell.isContentEditable) return;
          cell.contentEditable = 'false';
          const value = (cell.textContent || '').replace(/[\r\n]+/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();
          document.dispatchEvent(new CustomEvent('inkstone:table-cell-commit', {
            detail: { from: toDocOffset(offset + range.from), to: toDocOffset(offset + range.to), text: value }
          }));
        };
        cell.addEventListener('blur', commit, { once: true });
        cell.addEventListener('keydown', key => {
          if (key.key === 'Escape') {
            key.preventDefault();
            cell.textContent = original;
            cell.contentEditable = 'false';
            cell.classList.remove('table-cell-editing');
            view.focus();
          } else if (key.key === 'Enter' || key.key === 'Tab') {
            key.preventDefault();
            commit();
          }
        });
        queueMicrotask(() => {
          cell.focus();
          const selection = window.getSelection(), editingRange = document.createRange();
          editingRange.selectNodeContents(cell);
          selection.removeAllRanges(); selection.addRange(editingRange);
        });
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
let blockCache = { key: '', blocks: [], tokens: [] };
function parsedFor(source, id) {
  const key = `${id}\u0000${source}`;
  // One parse per document version. Selection-only updates reuse both the
  // block HTML and the token ranges, which keeps caret movement cheap even
  // in long technical documents.
  if (blockCache.key !== key) blockCache = { key, ...renderDocument(source, id) };
  return blockCache;
}

function liveDecorations(state, id) {
  const mode = state.field(modeField);
  if (mode.source || state.doc.length > 200000) return Decoration.none;
  const source = state.doc.toString();
  const { tokens, blocks } = parsedFor(source, id);
  const htmlByStart = new Map(blocks.map(block => [block.start, block.html]));
  const ranges = [], occupied = new Set();
  // Before any interaction, the caret at offset 0 must not turn the first
  // heading into an editable source line; the whole document is a reading view.
  const selection = mode.pristine ? [] : state.selection.ranges;
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
      // Code, tables, raw HTML and front matter must stay literal source.
      const literalBlock = /^(fence|code_block|table_open|front_matter|hr|html_block)$/.test(token.type);
      for (let number = start + 1; number <= end; number++) {
        const line = state.doc.line(number);
        const info = literalBlock ? { classes: [], prefix: null, plain: true, groups: [] } : liveLine(line.text);
        // Typora renders a completed syntax at once, even with the caret right
        // after the closing marker. Only a caret *inside* the element (or a
        // selection overlapping it) brings the source characters back.
        const reveal = literalBlock ? { groups: new Set(), prefix: false } : revealFor(info, selection.map(range => ({
          from: range.from - line.from, to: range.to - line.from
        })));
        const classes = ['cm-live-line', ...info.classes];
        if (number === start + 1 && token.type === 'heading_open') classes.push(`cm-heading-${token.tag.slice(1)}`);
        if (number === start + 1 && token.type === 'blockquote_open') classes.push('cm-live-quote');
        ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
        if (info.plain || literalBlock) {
          for (const mark of inlineMarks(line.text)) {
            ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(line.from + mark.from, line.from + mark.to));
          }
          continue;
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
          if (reveal.prefix) {
            ranges.push(Decoration.mark({ class: 'cm-md-mark' }).range(prefixFrom, prefixTo));
          } else if (info.prefix.kind === 'heading' || info.prefix.kind === 'quote') {
            ranges.push(Decoration.replace({ widget: hiddenMark }).range(prefixFrom, prefixTo));
          } else {
            ranges.push(Decoration.replace({
              widget: new PrefixWidget(info.prefix.kind, line.from + (info.prefix.checkOffset ?? 0), info.prefix.checked, info.prefix.label)
            }).range(prefixFrom, prefixTo));
          }
        }
      }
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
  const row = `|${Array(cells.length).fill('  ').join('|')}|`;
  view.dispatch({
    changes: { from: at, to: at, insert: `\n${row}` },
    selection: { anchor: at + 2 }, scrollIntoView: true
  });
  view.focus();
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

export function createEditor(parent, doc, onChange, onSelection, onCommand, onImage) {
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
      return tr.docChanged || tr.selection || tr.effects.some(e => e.is(modeEffect) || e.is(compositionEffect))
        ? liveDecorations(tr.state, doc.id) : value;
    },
    provide: field => EditorView.decorations.from(field)
  });
  const eol = doc.content.includes('\r\n') ? '\r\n' : '\n';
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const dispatch = name => () => { onCommand(name); return true; };
  // `view` is only referenced when a key is pressed, after construction.
  const edit = command => () => { command(view); view.focus(); return true; };
  const view = new EditorView({ parent, state: EditorState.create({
    doc: doc.content,
    extensions: [
      EditorState.lineSeparator.of(eol), modeField, preview, gutter.of([]), spelling.of(EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown 文档编辑器' })),
      // A longer grouping window keeps a continuous typing burst in one undo
      // step even when the caret crosses rendered block boundaries.
      history({ minDepth: 100, newGroupDelay: 600 }), drawSelection(), highlightActiveLine(), highlightSelectionMatches(), bracketMatching(), closeBrackets(), indentOnInput(),
      autocompletion({ override: [emojiCompletion], activateOnTyping: true, icons: false }),
      markdown(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, placeholder('开始写作，或输入 # 创建标题'),
      search({ top: true }),
      keymap.of([
        { key: 'Tab', run: view => tableTab(view, false) },
        { key: 'Shift-Tab', run: view => tableTab(view, true) },
        { key: 'Enter', run: paragraphEnter },
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
        if (update.docChanged) onChange(update.state.doc.sliceString(0, update.state.doc.length, eol));
        if (update.selectionSet || update.docChanged) onSelection(update);
      }),
      EditorView.domEventHandlers({
        compositionstart: () => { view.dispatch({ effects: compositionEffect.of(true) }); },
        compositionend: () => { requestAnimationFrame(() => { if (view.dom.isConnected) view.dispatch({ effects: compositionEffect.of(false) }); }); },
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
  return {
    view,
    undo() { undo(view); view.focus(); },
    redo() { redo(view); view.focus(); },
    setSource(value) { view.dispatch({ effects: [modeEffect.of(value), gutter.reconfigure(value ? lineNumbers() : [])] }); },
    setSpellcheck(value) { view.dispatch({ effects: spelling.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(value), 'aria-label': 'Markdown 文档编辑器' })) }); },
    find() { openSearchPanel(view); view.focus(); },
    setContent(value) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: 0 } }); view.focus(); },
    jump(line) { const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines)); view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true }); view.focus(); },
    jumpTop() { cursorDocStart(view); view.focus(); },
    jumpBottom() { cursorDocEnd(view); view.focus(); },
    jumpToSelection() { view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }); view.focus(); },
    selectLine() { selectLine(view); view.focus(); },
    selectScope() { selectScope(view); },
    deleteLine() { deleteLine(view); view.focus(); },
    deleteWord() { deleteGroupBackward(view); view.focus(); },
    indent() { indentMore(view); view.focus(); },
    outdent() { indentLess(view); view.focus(); },
    insert(text) { view.dispatch(view.state.replaceSelection(text)); view.focus(); },
    selectedText() {
      const range = view.state.selection.main;
      return range.empty ? view.state.doc.toString() : view.state.sliceDoc(range.from, range.to);
    },
    replaceRange(from, to, text) {
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
      view.focus();
    },
    caretOffset() { return view.state.selection.main.head; },
    /** Minimal, selection-preserving edit (used for persisted table widths). */
    applyChange({ from, to, insert }) {
      view.dispatch({ changes: { from, to, insert } });
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
