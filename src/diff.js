/**
 * Line-level diff for the version history viewer. A bounded LCS keeps the
 * comparison exact for normal documents and cheap for very large ones.
 */
export function escapeDiff(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const MAX_LINES = 3000;
const MAX_CELLS = 1_500_000;

export function diffLines(before, after) {
  const left = before.split(/\r?\n/).slice(0, MAX_LINES);
  const right = after.split(/\r?\n/).slice(0, MAX_LINES);
  const rows = [];
  // Fall back to a positional comparison when the quadratic table is too big.
  if (left.length * right.length > MAX_CELLS) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (i >= left.length) rows.push({ type: 'add', text: right[i] });
      else if (i >= right.length) rows.push({ type: 'remove', text: left[i] });
      else if (left[i] === right[i]) rows.push({ type: 'equal', text: left[i] });
      else { rows.push({ type: 'remove', text: left[i] }, { type: 'add', text: right[i] }); }
    }
    return rows;
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
  return rows;
}

export function diffHTML(before, after) {
  const signs = { equal: ' ', add: '+', remove: '−' };
  const rows = diffLines(before, after).map(row =>
    `<div class="diff-line diff-${row.type}"><span class="diff-sign">${signs[row.type]}</span><code>${escapeDiff(row.text) || '&nbsp;'}</code></div>`
  ).join('');
  return `<div class="diff-view" role="table" aria-label="版本差异">${rows}</div>`;
}
