// Link targets inside a document: the click handler, the active-block
// Mod+click and the desktop tests all have to agree on what a link points at,
// so the classification lives in one pure function.
//
// markdown-it percent-encodes every non-ASCII character and every space in a
// destination, which is why both the path and the anchor are decoded here: a
// link written as `./笔记 一.md#第一节` must find the same file the author
// meant, and the anchor must match the slug the renderer generated.

/** Links that leave the document for another application. */
export const EXTERNAL_PROTOCOL = /^(?:https?:|mailto:)/i;
// Windows drive letters look like a URL scheme (`C:`), and `file:` is resolved
// by the main process, so neither counts as an unknown protocol here.
const OTHER_PROTOCOL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function safeDecode(value) {
  const text = String(value ?? '');
  try { return decodeURIComponent(text); } catch { return text; }
}

/**
 * Classify one link target.
 * `{ kind: 'anchor', anchor }` stays inside the document,
 * `{ kind: 'external', href }` opens in the browser,
 * `{ kind: 'local', path, anchor, raw }` names another file.
 */
export function splitLinkTarget(href) {
  const text = String(href ?? '').trim();
  if (!text) return { kind: 'empty' };
  if (text.startsWith('#')) return { kind: 'anchor', anchor: safeDecode(text.slice(1)) };
  const hash = text.indexOf('#');
  const destination = hash < 0 ? text : text.slice(0, hash);
  const anchor = hash < 0 ? '' : safeDecode(text.slice(hash + 1));
  if (!destination) return { kind: 'anchor', anchor };
  if (EXTERNAL_PROTOCOL.test(destination)) return { kind: 'external', href: text };
  const isDriveLetter = /^[a-zA-Z]:[\\/]/.test(destination);
  if (!isDriveLetter && OTHER_PROTOCOL.test(destination) && !/^file:/i.test(destination)) return { kind: 'external', href: text };
  return { kind: 'local', path: safeDecode(destination), anchor, raw: destination };
}

/**
 * The inline Markdown link whose source range contains `offset` inside `line`
 * (`[文字](./other.md)`), used for Mod+click in the active block. Images are
 * not links; a reference-style link only resolves after a whole-document parse,
 * which the rendered block already covers.
 */
export function linkAt(line, offset) {
  const text = String(line ?? '');
  for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    if (match[1] === '!') continue;
    const start = match.index, end = start + match[0].length;
    if (offset < start || offset > end) continue;
    return { target: match[3].replace(/^<|>$/g, ''), label: match[2], from: start, to: end };
  }
  for (const match of text.matchAll(/<((?:https?:|mailto:)[^>\s]+)>/g)) {
    const start = match.index, end = start + match[0].length;
    if (offset < start || offset > end) continue;
    return { target: match[1], label: match[1], from: start, to: end };
  }
  return null;
}

/** The heading whose rendered id matches `anchor` (the renderer's own slugs). */
export function headingForAnchor(headings, anchor) {
  const wanted = safeDecode(String(anchor ?? '')).replace(/^#/, '');
  if (!wanted) return null;
  return (headings || []).find(heading => heading.id === wanted)
    || (headings || []).find(heading => heading.id === safeDecode(wanted))
    || null;
}
