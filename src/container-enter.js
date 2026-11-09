import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';

const taskBox = /^\[[ xX]?\](?:[ \t]+|$)/;

function listPrefix(state, item) {
  const mark = item.getChild('ListMark');
  const line = state.doc.lineAt(mark.from);
  const marker = state.sliceDoc(mark.from, mark.to).replace(/^\d+/, number => String(Number(number) + 1));
  const task = taskBox.test(state.sliceDoc(mark.to, line.to).trimStart());
  return state.sliceDoc(line.from, mark.from) + marker + (task ? ' [ ] ' : ' ');
}

/** End an empty item or quote at the cursor, keeping its enclosing structure. */
export function containerEnter({ state, dispatch }) {
  const { doc, selection } = state;
  const { head, empty } = selection.main;
  if (!empty || selection.ranges.length !== 1) return false;
  const line = doc.lineAt(head);
  if (head !== line.to) return false;

  let node = syntaxTree(state).resolveInner(head, -1);
  let item = null, mark = null, orderedTask = false;
  for (; node; node = node.parent) {
    if (/^(?:FencedCode|CodeBlock|HTMLBlock)$/.test(node.name)) return false;
    if (node.name === 'ListItem') {
      const marker = node.getChild('ListMark');
      if (!marker || marker.from < line.from) break;
      const content = state.sliceDoc(marker.to, head).trim();
      const task = taskBox.exec(content);
      if (node.to <= head && !content.slice(task?.[0].length ?? 0)) {
        item = node;
        mark = marker;
      } else {
        orderedTask = node.parent.name === 'OrderedList' && !!task;
      }
      break;
    }
    if (node.name === 'Blockquote') {
      mark = node.getChildren('QuoteMark').findLast(marker => marker.from >= line.from && marker.to <= head);
      if (mark && state.sliceDoc(mark.to, head).trim()) mark = null;
      break;
    }
  }
  if (!mark && !orderedTask) return false;

  if (orderedTask) {
    return insertNewlineContinueMarkup({
      state,
      dispatch(transaction) {
        const next = transaction.newSelection.main.head;
        const nextLine = transaction.newDoc.lineAt(next);
        if (nextLine.number <= line.number || !/\d+[.)][ \t]*$/.test(nextLine.text.slice(0, next - nextLine.from))) {
          dispatch(transaction);
          return;
        }
        dispatch(state.update(transaction, {
          changes: { from: next, insert: '[ ] ' },
          selection: { anchor: next + 4 },
          sequential: true
        }));
      }
    });
  }

  const outerItem = item?.parent.parent;
  const parentPrefix = state.sliceDoc(line.from, mark.from);
  const outdentList = outerItem?.name === 'ListItem';
  // Compact nesting (>> ) still needs a separator after returning to > .
  const prefix = outdentList ? listPrefix(state, outerItem) : parentPrefix.replace(/>$/, '> ');
  // A bare line break lets the next paragraph become a lazy continuation of
  // the preceding list or quote. Add a separator within the enclosing block.
  const previous = line.number > 1 ? doc.line(line.number - 1).text : '';
  const next = line.number < doc.lines ? doc.line(line.number + 1).text : '';
  const blank = prefix.trimEnd();
  const separatesParagraph = !outdentList && /^[> \t]*$/.test(prefix);
  const separator = separatesParagraph && previous.trim() && previous.trimEnd() !== blank
    ? blank + '\n' : '';
  const insert = separator + prefix;
  const followingSeparator = separatesParagraph && next.trim() && next.trimEnd() !== blank
    ? '\n' + blank : '';
  dispatch(state.update({
    changes: { from: line.from, to: line.to, insert: insert + followingSeparator },
    selection: { anchor: line.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  }));
  return true;
}
