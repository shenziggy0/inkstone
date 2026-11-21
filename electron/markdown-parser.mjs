import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import { full as emoji } from 'markdown-it-emoji';
import katex from 'katex';

export function createMarkdownParser(options = {}) {
  const parser = new MarkdownIt({ html: true, linkify: true, breaks: true, ...options }).use(footnote).use(taskLists, { enabled: true })
    // Typora 1.11+ accepts both $…$ / $$…$$ and \(…\) / \[…\].
    .use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { throwOnError: false, trust: false } })
    .use(mark).use(sub).use(sup).use(emoji);

  // Align CJK emphasis/strike/mark punctuation flanking with Typora.
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  if (!parser.inline.State.prototype._inkstoneCjkPatched) {
    const defaultScanDelims = parser.inline.State.prototype.scanDelims;
    parser.inline.State.prototype.scanDelims = function (start, canSplitWord) {
      const result = defaultScanDelims.call(this, start, canSplitWord);
      if (!canSplitWord) return result;
      const pos = start + result.length;
      const before = start > 0 ? this.src.slice(Math.max(0, start - 2), start).slice(-1) : ' ';
      const after = pos < this.posMax ? this.src.slice(pos, Math.min(this.posMax, pos + 2))[0] : ' ';
      const sBefore = /\s/.test(before), sAfter = /\s/.test(after);
      if (!sAfter && CJK.test(before)) result.can_open = true;
      if (!sBefore && CJK.test(after)) result.can_close = true;
      return result;
    };
    parser.inline.State.prototype._inkstoneCjkPatched = true;
  }

  // Typora renders local images referenced as `file:///…` URLs. markdown-it drops
  // any `file:` destination before it becomes an image token, so allow that one
  // scheme here; opening such a link still goes through the `openExternal`
  // allow-list (https/http/mailto only), so this only affects image rendering.
  const defaultValidateLink = parser.validateLink.bind(parser);
  parser.validateLink = url => /^file:/i.test(url) || defaultValidateLink(url);

  // ── YAML Front Matter ──────────────────────────────────────────────────────
  // Registered before `hr` so a leading `---` block is metadata, not a rule.
  parser.block.ruler.before('hr', 'front_matter', (state, startLine, endLine, silent) => {
    if (startLine !== 0 || state.blkIndent !== 0) return false;
    const first = state.src.slice(state.bMarks[0] + state.tShift[0], state.eMarks[0]).trim();
    if (first !== '---') return false;
    let close = -1;
    for (let line = 1; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim();
      if (text === '---' || text === '...') { close = line; break; }
    }
    if (close < 0) return false;
    if (silent) return true;
    const token = state.push('front_matter', '', 0);
    token.map = [0, close + 1];
    token.content = state.getLines(0, close + 1, state.blkIndent, false);
    token.hidden = true;
    state.line = close + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  return parser;
}
