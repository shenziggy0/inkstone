'use strict';

/**
 * The one image destination shape a configured `typora-root-url` redirects:
 * exactly one leading slash. `//host/share` keeps its old network meaning, and
 * a relative or drive path is never touched.
 */
const ROOTED_IMAGE = /^\/(?!\/)/;

/** True when the document or the app-wide fallback configures an image root. */
function hasConfiguredImageRoot(frontMatterRoot, globalRoot) {
  return Boolean(
    (typeof frontMatterRoot === 'string' && frontMatterRoot.trim()) ||
    (typeof globalRoot === 'string' && globalRoot.trim())
  );
}

const isImage = node => Boolean(
  node && typeof node === 'object' && !Array.isArray(node) &&
  node.t === 'Image' && Array.isArray(node.c) && Array.isArray(node.c[2])
);

/**
 * Rewrite only `Image` destinations that start with one `/`, in place.
 *
 * `resolveAsset(src)` is the caller's shared, security-checked resolver. A
 * successful result replaces the destination and keeps the attribute list, alt
 * inlines and title untouched. A refused or unreadable image is replaced by its
 * alt inlines, so Pandoc never gets a chance to read a host-absolute path or a
 * network destination; the visible fallback is the document's own alt text.
 *
 * Everything else in the Pandoc AST — metadata, links, math, footnotes, tables,
 * relative image paths and `//host` destinations — is left byte-for-byte alone.
 */
async function rewriteRootImages(ast, resolveAsset) {
  if (!ast || typeof ast !== 'object') throw new TypeError('Pandoc AST 无效。');
  if (typeof resolveAsset !== 'function') throw new TypeError('resolveAsset 必须是函数。');
  const report = { rootImages: 0, rewritten: 0, unresolved: [] };

  async function visit(node) {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const item = node[index];
        if (isImage(item) && typeof item.c[2][0] === 'string' && ROOTED_IMAGE.test(item.c[2][0])) {
          const src = item.c[2][0];
          report.rootImages++;
          try {
            const resolved = await resolveAsset(src);
            if (typeof resolved !== 'string' || !resolved) throw new Error('图片路径无效。');
            item.c[2][0] = resolved;
            report.rewritten++;
          } catch (error) {
            // Never leave `/…` behind: Pandoc would resolve it against the host
            // filesystem. The alt inlines are the document's own fallback text.
            report.unresolved.push({ src, code: error && error.code ? String(error.code) : null });
            const alt = Array.isArray(item.c[1]) ? item.c[1] : [];
            // A Markdown image may nest another image in its alt inlines.
            // Validate those single-slash destinations too before promoting
            // the alt into the surrounding block; otherwise a missing outer
            // root image would smuggle a nested host path past the same rule.
            await visit(alt);
            node.splice(index, 1, ...alt);
            index += alt.length - 1;
          }
          continue;
        }
        await visit(item);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) await visit(value);
    }
  }

  await visit(ast);
  return report;
}

module.exports = { ROOTED_IMAGE, hasConfiguredImageRoot, rewriteRootImages };
