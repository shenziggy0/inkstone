import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import { full as emoji } from 'markdown-it-emoji';
import hljs from 'highlight.js';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { readColumnWidths, injectColumnWidths } from './table.js';

export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const parser = new MarkdownIt({
  html: true, linkify: true, breaks: false,
  highlight(code, language) {
    if (language === 'mermaid') return `<pre class="mermaid">${escapeHTML(code)}</pre>`;
    const content = language && hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHTML(code);
    return `<pre class="code-block"><span class="code-language">${escapeHTML(language || 'text')}</span><code class="hljs">${content}</code></pre>`;
  }
}).use(footnote).use(taskLists, { enabled: true })
  // Typora 1.11+ accepts both $…$ / $$…$$ and \(…\) / \[…\].
  .use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { throwOnError: false, trust: false } })
  .use(mark).use(sub).use(sup).use(emoji);

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

parser.renderer.rules.front_matter = (tokens, index) => {
  const raw = tokens[index].content.replace(/^---[^\n]*\r?\n/, '').replace(/\r?\n(?:---|\.\.\.)\s*$/, '');
  const rows = raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon).trim() : '';
    const value = colon > 0 ? line.slice(colon + 1).trim() : line.trim();
    return `<div class="front-matter-row"><span class="front-matter-key">${escapeHTML(key)}</span><span class="front-matter-value">${escapeHTML(value)}</span></div>`;
  }).join('');
  return `<section class="front-matter" data-md-skip><div class="front-matter-label">文档属性</div>${rows}</section>`;
};

// ── GitHub style alerts ────────────────────────────────────────────────────
const ALERTS = { NOTE: '提示', TIP: '技巧', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' };
const defaultBlockquote = parser.renderer.rules.blockquote_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
parser.renderer.rules.blockquote_open = (tokens, index, options, env, self) => {
  // A blockquote wraps a paragraph, so the inline token is a few slots later.
  const inline = tokens.slice(index + 1, index + 6).find(token => token.type === 'inline');
  const match = inline?.content?.match(alertMarker);
  if (!match) return defaultBlockquote(tokens, index, options, env, self);
  const kind = match[1].toUpperCase();
  tokens[index].attrJoin('class', `alert alert-${kind.toLowerCase()}`);
  const first = inline.children?.[0];
  if (first?.type === 'text') first.content = first.content.replace(alertMarker, '');
  if (first?.content === '' && inline.children?.[1]?.type === 'softbreak') inline.children.splice(0, 2);
  inline.content = inline.content.replace(alertMarker, '');
  return `${defaultBlockquote(tokens, index, options, env, self)}<div class="alert-label" data-md-skip>${ALERTS[kind]}</div>`;
};

const headingRule = parser.renderer.rules.heading_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
parser.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const title = tokens[index + 1]?.content || '';
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
  env.slugs ||= {};
  const count = env.slugs[slug] || 0;
  env.slugs[slug] = count + 1;
  tokens[index].attrSet('id', count ? `${slug}-${count}` : slug);
  return headingRule(tokens, index, options, env, self);
};

export function headings(source) {
  const tokens = parser.parse(source, {}), result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open' && tokens[i].map) result.push({ title: tokens[i + 1]?.content || '', level: Number(tokens[i].tag.slice(1)), line: tokens[i].map[0] + 1 });
  }
  return result;
}

const tocItems = source => headings(source).map(h => `<li style="margin-left:${(h.level - 1) * 12}px"><a href="#" data-line="${h.line}">${escapeHTML(h.title)}</a></li>`).join('');

function finalizeHTML(html, documentId, toc) {
  const withToc = html.replace(/<p>\[toc\]<\/p>/gi, `<nav class="toc" aria-label="文内目录"><ul>${toc}</ul></nav>`);
  const clean = DOMPurify.sanitize(withToc, { USE_PROFILES: { html: true, svg: true, mathMl: true }, ADD_ATTR: ['data-line'], FORBID_TAGS: ['iframe', 'object', 'embed', 'style', 'form'], FORBID_ATTR: ['srcdoc'], ALLOW_DATA_ATTR: true });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const img of template.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!/^(https:|data:|blob:)/i.test(src)) {
      img.dataset.mdSrc = src;
      if (documentId && !/^[a-z]+:/i.test(src) && !src.startsWith('//')) img.src = `inkstone-asset://${documentId}/${encodeURIComponent(src)}`;
      else img.removeAttribute('src');
    }
    img.loading = 'lazy';
  }
  for (const link of template.content.querySelectorAll('a')) link.rel = 'noopener noreferrer';
  for (const checkbox of template.content.querySelectorAll('input')) checkbox.setAttribute('aria-label', '切换任务完成状态');
  // markdown-it-task-lists only recognises `[ ] ` when text follows the box.
  // A bare `- [ ]` line otherwise renders as literal `[ ]`, contradicting the
  // checkbox the live preview already shows while that line is being typed.
  // Normalise empty task items so the rendered and active block agree.
  for (const item of template.content.querySelectorAll('li')) {
    if (item.querySelector('input, pre, table, ul, ol, blockquote, img')) continue;
    const match = /^\[([ xX])\]$/.exec((item.textContent || '').trim());
    if (!match) continue;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'task-list-item-checkbox';
    input.setAttribute('aria-label', '切换任务完成状态');
    if (match[1] !== ' ') input.checked = true;
    item.classList.add('task-list-item', 'enabled');
    item.parentElement?.classList.add('contains-task-list');
    item.replaceChildren(input);
  }
  // A copy affordance on every fenced code block. Inserted after sanitising,
  // so no untrusted markup is reintroduced into the document.
  for (const pre of template.content.querySelectorAll('pre.code-block')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.dataset.copyCode = '';
    button.dataset.mdSkip = '';
    button.setAttribute('aria-label', '复制代码');
    button.textContent = '复制';
    pre.prepend(button);
  }
  return template.innerHTML;
}

export function renderMarkdown(source, documentId) {
  const text = source.replace(/^\uFEFF/, '');
  return injectColumnWidths(finalizeHTML(parser.render(text, {}), documentId, tocItems(text)), readColumnWidths(text));
}

/**
 * Render every top-level block against ONE parse of the whole document.
 * A shared `env` is what makes cross-block features work: reference-link
 * definitions, footnotes, duplicate heading slugs and [TOC] all need the
 * rest of the document, which a per-block parse cannot see.
 * Returns [{ start (0-based line), end, html }] keyed to editor block maps.
 */
export function renderDocument(source, documentId) {
  const text = source.replace(/^\uFEFF/, '');
  const env = {};
  const tokens = parser.parse(text, env);
  const groups = [];
  let current = null;
  for (const token of tokens) {
    if (token.level === 0 && token.map && token.nesting !== -1) {
      if (current) groups.push(current);
      current = { start: token.map[0], end: token.map[1], tokens: [token] };
    } else if (current) current.tokens.push(token);
  }
  if (current) groups.push(current);
  const toc = tocItems(text);
  const widths = readColumnWidths(text);
  let tableOffset = 0;
  const blocks = groups.map(group => {
    const html = finalizeHTML(parser.renderer.render(group.tokens, parser.options, env), documentId, toc);
    const withWidths = injectColumnWidths(html, widths, tableOffset);
    tableOffset += (html.match(/<table\b/g) || []).length;
    return { start: group.start, end: group.end, html: withWidths };
  });
  // Returning the tokens lets the editor reuse this single parse for its
  // decoration ranges instead of parsing the whole file on every caret move.
  return { tokens, blocks };
}

/** Backwards-compatible helper for callers that only need the HTML blocks. */
export function renderBlocks(source, documentId) {
  return renderDocument(source, documentId).blocks;
}

let mermaidModule;
let renderQueue = Promise.resolve();
export function renderDiagrams(container) {
  const jobs = [...container.querySelectorAll('pre.mermaid:not([data-processed])')];
  if (!jobs.length) return Promise.resolve();
  renderQueue = renderQueue.catch(() => {}).then(async () => {
    mermaidModule ||= (await import('mermaid')).default;
    mermaidModule.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral', suppressErrorRendering: true });
    for (const node of jobs) {
      if (!node.isConnected) continue;
      node.dataset.source ||= node.textContent;
      try {
        const { svg } = await mermaidModule.render(`diagram-${crypto.randomUUID()}`, node.dataset.source);
        node.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'], ADD_ATTR: ['dominant-baseline'] });
        node.dataset.processed = 'true';
        node.classList.remove('diagram-error');
      } catch (error) {
        node.dataset.processed = 'error';
        const message = `图表渲染失败：${String(error.message || error)}`;
        const label = document.createElement('div');
        label.className = 'diagram-error-message';
        label.setAttribute('data-md-skip', '');
        label.textContent = message;
        node.replaceChildren(label, document.createTextNode(node.dataset.source));
        node.title = message;
        node.classList.add('diagram-error');
      }
    }
  });
  return renderQueue;
}

/** Re-render existing diagrams after a theme change so colours follow. */
export function refreshDiagrams(root = document) {
  for (const node of root.querySelectorAll('pre.mermaid[data-processed]')) {
    if (node.dataset.source) node.textContent = node.dataset.source;
    node.removeAttribute('data-processed');
  }
  return renderDiagrams(root);
}

/**
 * Typora-style word count: each Han character is one word, while Latin
 * words count as one regardless of length. Intl.Segmenter alone would merge
 * a run of Chinese characters into a single "word", undercounting badly.
 */
export function statistics(source) {
  const text = source.replace(/^\uFEFF/, '');
  const characters = [...text].length;
  const nonWhitespace = [...text].filter(character => !/\s/u.test(character)).length;
  let words = 0;
  for (const part of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)) {
    if (!part.isWordLike) continue;
    const han = (part.segment.match(/[\p{Script=Han}]/gu) || []).length;
    words += han || 1;
  }
  return { characters, nonWhitespace, words, lines: text.split(/\r\n|\r|\n/).length, minutes: Math.max(1, Math.ceil(words / 250)) };
}
