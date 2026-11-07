/**
 * Newline handling for documents that come from disk.
 *
 * CodeMirror keeps LF internally, so every line break the editor inserts is a
 * real one-character break. The file's own style is restored on the way out
 * instead of being configured as the editor's line separator (a configured
 * separator makes CodeMirror split lines on "\r\n" while the code keeps
 * inserting "\n", leaving stray carriage returns inside line contents).
 *
 * A file with mixed endings keeps each untouched line's original newline; only
 * the edited region is normalized to the style the file mostly uses.
 */

const BOM = '\uFEFF';

/** Split text into lines while remembering each line's own line break. */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\n') continue;
    const end = index > start && text[index - 1] === '\r' ? index - 1 : index;
    lines.push({ text: text.slice(start, end), break: text.slice(end, index + 1) });
    start = index + 1;
  }
  lines.push({ text: text.slice(start), break: '' });
  return lines;
}

/** Disk text -> the LF text CodeMirror holds internally. */
export function toLf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

/** Which newline style a file uses, and whether it mixes the two. */
export function detectEol(text) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/(?<!\r)\n/g) || []).length;
  // A tie (or a file without any line break) falls back to CRLF only when the
  // file actually contains CRLF; otherwise LF is the safe default.
  const eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n';
  return { bom, eol, crlf, lf, mixed: crlf > 0 && lf > 0 };
}

/**
 * Remember the state a document was opened with. The baseline is the disk text
 * without its BOM, which is what lets mixed files keep per-line endings.
 */
export function createEolContext(text) {
  const detected = detectEol(text);
  return { ...detected, baseline: detected.bom ? text.slice(1) : text };
}

/**
 * LF text -> text in the file's newline style.
 *
 * Pure LF / pure CRLF files are converted wholesale. For mixed files the
 * unchanged common prefix and suffix lines keep their original break, and the
 * changed region uses the file's majority style.
 */
export function applyEol(text, context) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const eol = context?.eol || '\n';
  if (!context?.mixed) return bom + body.replace(/\n/g, eol);
  const baseline = splitLines(context.baseline);
  const lines = splitLines(body);
  let prefix = 0;
  while (prefix < lines.length && prefix < baseline.length && lines[prefix].text === baseline[prefix].text) prefix++;
  let suffix = 0;
  while (suffix < lines.length - prefix && suffix < baseline.length - prefix
    && lines[lines.length - 1 - suffix].text === baseline[baseline.length - 1 - suffix].text) suffix++;
  const shift = baseline.length - lines.length;
  let output = bom;
  for (const [index, line] of lines.entries()) {
    output += line.text;
    if (!line.break) continue;
    const source = index < prefix ? baseline[index]
      : index >= lines.length - suffix ? baseline[index + shift]
        : null;
    // A matched baseline line may have had no final break (its old last line),
    // in which case the newly typed break uses the majority style.
    output += source?.break ? source.break : eol;
  }
  return output;
}
