/**
 * Line-level diff for the version history viewer. A bounded LCS keeps the
 * comparison exact for normal documents and cheap for very large ones.
 */
export function escapeDiff(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const MAX_LINES = 3000;
const MAX_CELLS = 1_500_000;

export function compareLines(before, after) {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  const rows = [];
  const approximate = Math.max(left.length, right.length) > MAX_LINES ||
    left.length * right.length > MAX_CELLS;
  // Compare every line by position when the exact comparison exceeds its budget.
  if (approximate) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (i >= left.length) rows.push({ type: 'add', text: right[i] });
      else if (i >= right.length) rows.push({ type: 'remove', text: left[i] });
      else if (left[i] === right[i]) rows.push({ type: 'equal', text: left[i] });
      else { rows.push({ type: 'remove', text: left[i] }, { type: 'add', text: right[i] }); }
    }
    return { rows, approximate };
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { rows.push({ type: 'equal', text: left[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { rows.push({ type: 'remove', text: left[i++] }); }
    else { rows.push({ type: 'add', text: right[j++] }); }
  }
  while (i < left.length) rows.push({ type: 'remove', text: left[i++] });
  while (j < right.length) rows.push({ type: 'add', text: right[j++] });
  return { rows, approximate };
}

export function diffLines(before, after) {
  return compareLines(before, after).rows;
}

const signs = { equal: ' ', add: '+', remove: '−' };
export const POSITIONAL_DIFF_NOTE = '按行位置比较，已覆盖全文，结果可能不是最小差异。';

export function renderDiffRows(rows, start = 0, end = rows.length) {
  return rows.slice(start, end).map(row =>
    `<div class="diff-line diff-${row.type}"><span class="diff-sign">${signs[row.type]}</span><code>${escapeDiff(row.text) || '&nbsp;'}</code></div>`
  ).join('');
}

export function diffHTML(before, after) {
  const { rows, approximate } = compareLines(before, after);
  const note = approximate ? `<p class="dialog-description">${POSITIONAL_DIFF_NOTE}</p>` : '';
  return `${note}<div class="diff-view" role="table" aria-label="版本差异">${renderDiffRows(rows)}</div>`;
}
