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
  const parser = new MarkdownIt({ html: true, linkify: true, breaks: false, ...options }).use(footnote).use(taskLists, { enabled: true })
    // Typora 1.11+ accepts both $…$ / $$…$$ and \(…\) / \[…\].
    .use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { throwOnError: false, trust: false } })
    .use(mark).use(sub).use(sup).use(emoji);

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
