/**
 * Typora's `sequence` and `flow` fences.
 *
 * Typora renders these with js-sequence-diagrams and flowchart.js, which are
 * *not* Mermaid aliases: handing the fence body to Mermaid produces a syntax
 * error. This module therefore parses a deliberately small, allow-listed
 * subset of each language and emits deterministic SVG. No dependency is added
 * and no network is touched, so the editor, the reading view and the exported
 * HTML/PDF all use the same offline renderer.
 *
 * ── Compatible subset ──────────────────────────────────────────────────────
 * sequence (js-sequence grammar):
 *   Title: text
 *   participant Alice          (declares / orders a participant)
 *   Alice->Bob: message        solid, filled arrow
 *   Alice-->Bob: message       dashed, filled arrow
 *   Alice->>Bob: message       solid, open arrow
 *   Alice-->>Bob: message      dashed, open arrow
 *   Note left of Alice: text
 *   Note right of Alice: text
 *   Note over Alice: text
 *   Note over Alice,Bob: text
 *   # whole-line comment       `\n` inside a label is a line break
 *
 * flow (flowchart.js grammar):
 *   id=>start|end|operation|subroutine|condition|inputoutput|input|output: text
 *     (`id` is an ASCII identifier: letters, digits, `_`, `.`, `-`)
 *   a->b->c                    chained connections
 *   cond(yes)->e / cond(no)->op
 *   cond(yes, right)->e        direction hints are accepted and ignored
 *   multi-line node text       a line without ->, => or @> continues the last
 *   # whole-line comment
 *
 * Everything outside that subset is rejected with a readable, line-numbered
 * Chinese error instead of being rendered approximately. In particular:
 *   - no raw HTML (all text is escaped into SVG text nodes);
 *   - no `:>` link targets, `@>` style payloads, URLs or click callbacks;
 *   - no flowchart.js `parallel` symbol, `|state` styling or `align-next`;
 *   - a connection label belongs to the arrow's source endpoint;
 *   - no js-sequence `alt`/`opt`/`loop`/autonumber (they are not in the
 *     upstream grammar either; Mermaid's `mermaid` fence remains the choice
 *     for those constructs).
 *
 * The output contains only shapes, text and a `<marker>` per arrow head. It
 * carries no document-derived ids, classes, event handlers or references:
 * the only ids are the renderer's own sanitised marker ids, and the only text
 * is escaped document text plus fixed accessibility labels.
 */

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const DEFAULT_PALETTE = {
  ink: '#333333',
  muted: '#777777',
  rule: '#c8c8c8',
  paper: '#ffffff',
  soft: '#f6f8fa'
};
const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\([0-9a-z.,%\s/+-]+\)|[a-z]{3,24})$/i;

let serial = 0;

export const NATIVE_DIAGRAM_KINDS = new Set(['sequence', 'flow']);

/** Fence labels that are diagrams rather than highlighted code. */
export const DIAGRAM_FENCE_LANGUAGES = new Set(['mermaid', 'sequence', 'flow']);

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function syntaxError(line, message) {
  const error = new Error(message);
  error.line = line;
  return error;
}

/** Resolve a CSS custom property to a concrete colour, or fall back. */
function safeColor(value, fallback) {
  const text = String(value ?? '').trim();
  return COLOR.test(text) ? text : fallback;
}

function paletteOf(input) {
  const palette = { ...DEFAULT_PALETTE };
  for (const key of Object.keys(palette)) {
    if (input && input[key] !== undefined) palette[key] = safeColor(input[key], palette[key]);
  }
  return palette;
}

const clip = (text, limit = 48) => {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};
const unescapeLabel = text => String(text).replace(/\\n/g, '\n');
const lineWidth = (text, size) => [...String(text)].reduce((width, character) => width + characterWidth(character) * size, 0);
const maxLineWidth = (lines, size) => Math.max(0, ...lines.map(line => lineWidth(line, size)));

/**
 * Approximate advance width of one character relative to the font size. The
 * layout only needs to be stable and generous enough for the box to contain the
 * label; the browser does the exact shaping.
 */
function characterWidth(character) {
  if (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character)) return 1;
  if (/[MW@#%&]/u.test(character)) return .78;
  if (/[ilI.,:;'!|]/u.test(character)) return .32;
  return .56;
}

/**
 * Greedy wrap at a pixel budget. Latin words are preferred over arbitrary
 * breaks, while CJK text wraps between characters. Explicit line breaks
 * (including js-sequence's `\n` escape) are preserved.
 */
export function wrapLabel(text, limit, size = 13) {
  const width = Math.max(24, Number(limit) || 24);
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let current = '';
    let used = 0;
    let lastSpace = -1;
    for (const character of paragraph) {
      const advance = characterWidth(character) * size;
      if (used + advance > width && current.trim()) {
        if (lastSpace > 0) {
          lines.push(current.slice(0, lastSpace).trimEnd());
          current = current.slice(lastSpace + 1);
          used = lineWidth(current, size);
        } else {
          lines.push(current);
          current = '';
          used = 0;
        }
        lastSpace = -1;
        if (character === ' ') continue;
      }
      if (character === ' ') lastSpace = current.length;
      current += character;
      used += advance;
    }
    lines.push(current.trimEnd());
  }
  return lines.length ? lines : [''];
}

function bounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  return {
    add(x1, y1, x2, y2) {
      minX = Math.min(minX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxX = Math.max(maxX, x1, x2);
      maxY = Math.max(maxY, y1, y2);
    },
    text(x, baseline, text, size) {
      const half = lineWidth(text, size) / 2;
      this.add(x - half, baseline - size, x + half, baseline + size * .3);
    },
    get minX() { return minX; },
    get minY() { return minY; },
    get maxX() { return maxX; },
    get maxY() { return maxY; }
  };
}

function svgText({ x, y, text, size = 13, fill, anchor = 'middle', weight }) {
  const attributes = `x="${round(x)}" y="${round(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"`;
  return `<text ${attributes}${weight ? ` font-weight="${weight}"` : ''}>${escapeHTML(text)}</text>`;
}

const round = value => Math.round(value * 100) / 100;

function arrowMarker(id, kind, palette) {
  const fill = palette.ink;
  if (kind === 'open') {
    return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1,1 L9,5 L1,9" fill="none" stroke="${fill}" stroke-width="1.5"/></marker>`;
  }
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${fill}"/></marker>`;
}

// ── sequence ───────────────────────────────────────────────────────────────

/** Parse the js-sequence subset documented at the top of this file. */
export function parseSequence(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const actors = new Map();
  const order = [];
  const events = [];
  let title = null;

  const actor = (raw, line) => {
    let name = String(raw).trim();
    if (/^".*"$/.test(name)) name = name.slice(1, -1).trim();
    if (!name) throw syntaxError(line, '参与者名称为空。');
    if (!actors.has(name)) {
      const record = { key: name, label: name, index: order.length };
      actors.set(name, record);
      order.push(record);
    }
    return actors.get(name);
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;

    let match;
    if ((match = /^title\s*:\s*(.*)$/i.exec(text))) {
      if (!match[1].trim()) throw syntaxError(line, 'Title 后缺少标题文字。');
      title = unescapeLabel(match[1].trim());
      return;
    }
    if ((match = /^participant\s+(.+)$/i.exec(text))) {
      actor(match[1], line);
      return;
    }
    if (/^note\b/i.test(text)) {
      if ((match = /^note\s+(left\s+of|right\s+of)\s+(.+?)\s*:\s*(.*)$/i.exec(text))) {
        const placement = /^left/i.test(match[1]) ? 'left' : 'right';
        const who = actor(match[2], line);
        if (!match[3].trim()) throw syntaxError(line, 'Note 后缺少文字。');
        events.push({ type: 'note', placement, from: who, to: who, text: unescapeLabel(match[3].trim()) });
        return;
      }
      if ((match = /^note\s+over\s+(.+?)\s*:\s*(.*)$/i.exec(text))) {
        const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
        if (names.length < 1 || names.length > 2) {
          throw syntaxError(line, 'Note over 只支持一个或两个参与者。');
        }
        if (!match[2].trim()) throw syntaxError(line, 'Note 后缺少文字。');
        const who = names.map(name => actor(name, line));
        events.push({
          type: 'note', placement: 'over',
          from: who[0], to: who[who.length - 1], text: unescapeLabel(match[2].trim())
        });
        return;
      }
      throw syntaxError(line, 'Note 语法应为“Note left of A: 文本”“Note right of A: 文本”或“Note over A[,B]: 文本”。');
    }

    const signal = /^(.+?)\s*(-->>|->>|-->|->)\s*(.+?)\s*:\s*(.*)$/.exec(text);
    if (signal) {
      const from = actor(signal[1], line);
      const to = actor(signal[3], line);
      if (!signal[4].trim()) throw syntaxError(line, '消息后缺少文字。');
      events.push({
        type: 'message',
        from, to,
        dashed: signal[2].startsWith('--'),
        open: signal[2].endsWith('>>'),
        text: unescapeLabel(signal[4].trim())
      });
      return;
    }

    throw syntaxError(line, `无法识别“${clip(text)}”。支持 Title、participant、A->B: 文本、A-->B: 文本、A->>B: 文本、A-->>B: 文本与 Note。`);
  });

  if (!order.length) throw syntaxError(1, '时序图为空。');
  return { title, actors: order, events };
}

function layoutSequence(diagram, palette, id) {
  const size = 13, lineHeight = 18, actorHeight = 30, notePad = 9, padding = 18;
  const actorWidth = actor => Math.max(80, Math.round(lineWidth(actor.label, size)) + 36);
  const actorWidths = diagram.actors.map(actorWidth);
  const maxActorWidth = Math.max(...actorWidths);
  const messageLines = diagram.events.filter(event => event.type === 'message')
    .map(event => wrapLabel(event.text, 360, size));
  const widestMessage = Math.max(0, ...messageLines.map(lines => maxLineWidth(lines, size)));
  const columnWidth = Math.max(160, maxActorWidth + 44, Math.min(360, widestMessage) + 52);
  const messageWrap = Math.min(320, columnWidth - 50);
  const noteWrap = 210;

  const centers = diagram.actors.map((actor, index) => index * columnWidth);
  const events = diagram.events.map(event => ({
    ...event,
    lines: wrapLabel(event.text, event.type === 'note' ? noteWrap : messageWrap, size)
  }));

  let cursor = actorHeight + 34;
  for (const event of events) {
    if (event.type === 'message') {
      event.arrowY = cursor + event.lines.length * lineHeight + 2;
      cursor = event.arrowY + (event.from === event.to ? 46 : 32);
    } else {
      const textWidth = maxLineWidth(event.lines, size);
      event.width = Math.max(150, Math.min(250, textWidth + notePad * 2));
      if (event.placement === 'over' && event.from !== event.to) {
        event.width = Math.max(event.width, Math.abs(centers[event.to.index] - centers[event.from.index]) + 40);
      }
      event.height = event.lines.length * lineHeight + notePad * 2;
      event.top = cursor;
      cursor = event.top + event.height + 16;
    }
  }
  const endY = cursor + 6;

  const box = bounds();
  const parts = [];
  for (const index of diagram.actors.keys()) {
    const x = centers[index];
    box.add(x, actorHeight, x, endY);
    parts.push(`<line x1="${round(x)}" y1="${actorHeight}" x2="${round(x)}" y2="${round(endY)}" stroke="${palette.muted}" stroke-width="1" stroke-dasharray="4 4"/>`);
  }

  for (const event of events) {
    if (event.type === 'message') {
      const x1 = centers[event.from.index], x2 = centers[event.to.index];
      const marker = event.open ? `${id}-open` : `${id}-filled`;
      const dash = event.dashed ? ' stroke-dasharray="5 4"' : '';
      if (event.from === event.to) {
        const path = `M ${x1} ${event.arrowY - 20} H ${x1 + 40} V ${event.arrowY} H ${x1}`;
        parts.push(`<path d="${path}" fill="none" stroke="${palette.ink}" stroke-width="1.4"${dash} marker-end="url(#${marker})"/>`);
        event.lines.forEach((line, index) => {
          const baseline = event.arrowY - 10 - (event.lines.length - 1 - index) * lineHeight;
          parts.push(svgText({ x: x1 + 48, y: baseline, text: line, size, fill: palette.ink, anchor: 'start' }));
          box.text(x1 + 48 + lineWidth(line, size) / 2, baseline, line, size);
        });
        box.add(x1, event.arrowY - 20, x1 + 40, event.arrowY);
        continue;
      }
      const direction = x2 >= x1 ? 1 : -1;
      const path = `M ${round(x1)} ${round(event.arrowY)} H ${round(x2 - direction * 1)}`;
      parts.push(`<path d="${path}" fill="none" stroke="${palette.ink}" stroke-width="1.4"${dash} marker-end="url(#${marker})"/>`);
      const middle = (x1 + x2) / 2;
      event.lines.forEach((line, index) => {
        const baseline = event.arrowY - 8 - (event.lines.length - 1 - index) * lineHeight;
        parts.push(svgText({ x: middle, y: baseline, text: line, size, fill: palette.ink }));
        box.text(middle, baseline, line, size);
      });
      box.add(Math.min(x1, x2), event.arrowY, Math.max(x1, x2), event.arrowY);
      continue;
    }

    const fromX = centers[event.from.index];
    const toX = centers[event.to.index];
    let x1, x2;
    if (event.placement === 'left') {
      x2 = fromX - 14;
      x1 = x2 - event.width;
    } else if (event.placement === 'right') {
      x1 = fromX + 14;
      x2 = x1 + event.width;
    } else {
      const middle = (fromX + toX) / 2;
      x1 = middle - event.width / 2;
      x2 = middle + event.width / 2;
    }
    const top = event.top, bottom = top + event.height;
    const fold = 10;
    parts.push(`<path d="M ${round(x1)} ${round(top)} H ${round(x2 - fold)} L ${round(x2)} ${round(top + fold)} V ${round(bottom)} H ${round(x1)} Z" fill="${palette.soft}" stroke="${palette.rule}" stroke-width="1"/>`);
    parts.push(`<path d="M ${round(x2 - fold)} ${round(top)} V ${round(top + fold)} H ${round(x2)}" fill="none" stroke="${palette.rule}" stroke-width="1"/>`);
    event.lines.forEach((line, index) => {
      const baseline = top + notePad + size + index * lineHeight - 2;
      parts.push(svgText({ x: x1 + notePad, y: baseline, text: line, size, fill: palette.ink, anchor: 'start' }));
      box.text(x1 + notePad + lineWidth(line, size) / 2, baseline, line, size);
    });
    box.add(x1, top, x2, bottom);
  }

  diagram.actors.forEach((actor, index) => {
    const x = centers[index], width = actorWidths[index];
    parts.push(`<rect x="${round(x - width / 2)}" y="0" width="${width}" height="${actorHeight}" rx="4" fill="${palette.paper}" stroke="${palette.muted}" stroke-width="1"/>`);
    parts.push(svgText({ x, y: 20, text: actor.label, size, fill: palette.ink, weight: 600 }));
    box.add(x - width / 2, 0, x + width / 2, actorHeight);
  });

  let titleLines = [];
  let titleHeight = 0;
  if (diagram.title) {
    titleLines = wrapLabel(diagram.title, 520, 15);
    titleHeight = titleLines.length * 22 + 8;
    titleLines.forEach((line, index) => {
      const baseline = -titleHeight + 18 + index * 22;
      const center = (box.minX + box.maxX) / 2;
      parts.push(svgText({ x: center, y: baseline, text: line, size: 15, fill: palette.ink, weight: 600 }));
      box.text(center, baseline, line, 15);
    });
  }

  const width = Math.ceil(box.maxX - box.minX + padding * 2);
  const height = Math.ceil(box.maxY - box.minY + padding * 2);
  const dx = padding - box.minX;
  const dy = padding - box.minY;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="时序图" font-family="${FONT}">
<title>时序图</title>
<defs>${arrowMarker(`${id}-filled`, 'filled', palette)}${arrowMarker(`${id}-open`, 'open', palette)}</defs>
<g transform="translate(${round(dx)} ${round(dy)})">
${parts.join('\n')}
</g>
</svg>`;
}

// ── flow ───────────────────────────────────────────────────────────────────

const FLOW_TYPES = new Set(['start', 'end', 'operation', 'subroutine', 'condition', 'inputoutput', 'input', 'output']);
const DIRECTIONS = new Set(['top', 'right', 'bottom', 'left']);

function parseEndpoint(raw, line, nodes) {
  const text = String(raw).trim();
  const match = /^([A-Za-z_][\w.-]*)\s*(?:\(([^)]*)\))?$/.exec(text);
  if (!match) throw syntaxError(line, `无法识别连接节点“${clip(text)}”。`);
  const key = match[1];
  if (!nodes.has(key)) throw syntaxError(line, `连接引用了未定义的节点“${key}”。`);
  const tokens = (match[2] || '').split(',').map(token => token.trim()).filter(Boolean);
  let label = '';
  for (const token of tokens) {
    // flowchart.js accepts a direction hint here. The automatic layout does
    // not use it, so it is consumed and deliberately not stored: keeping an
    // unread `direction` field on every edge would only look like state.
    if (DIRECTIONS.has(token.toLowerCase())) continue;
    if (/^align-next\b/i.test(token)) throw syntaxError(line, '不支持 align-next 布局选项。');
    if (!label) label = token;
    else throw syntaxError(line, `无法识别连接参数“${clip(token)}”。`);
  }
  return { node: nodes.get(key), label };
}

/** Parse the flowchart.js subset documented at the top of this file. */
export function parseFlow(source) {
  const raw = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const merged = [];
  raw.forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    if (text.includes('->') || text.includes('=>') || text.includes('@>')) {
      merged.push({ text, line: index + 1 });
    } else if (merged.length) {
      merged[merged.length - 1].text += '\n' + text;
    } else {
      throw syntaxError(index + 1, '无法识别的流程图行。');
    }
  });

  const nodes = new Map();
  const edges = [];
  const definitionEntries = new Set();
  for (const entry of merged) {
    if (entry.text.includes('@>')) {
      throw syntaxError(entry.line, '不支持节点样式（@>）；图表中不允许注入样式或回调。');
    }
    if (/:>/.test(entry.text)) {
      throw syntaxError(entry.line, '不支持链接目标（:>）；图表中不允许点击回调或远程地址。');
    }
    // A definition header is authoritative: once `id=>` is present, the rest
    // of the line must be a supported definition. Silently skipping a header
    // whose body does not match made a broken node disappear while the rest of
    // the chart rendered successfully.
    const header = /^([A-Za-z_][\w.-]*)\s*(?:\(([^)]*)\))?\s*=>\s*([\s\S]*)$/.exec(entry.text);
    if (!header) continue;
    definitionEntries.add(entry);
    const key = header[1];
    if (header[2] && header[2].trim()) {
      throw syntaxError(entry.line, `不支持节点选项（${clip(header[2])}）。`);
    }
    const body = header[3];
    if (/^\s*\|/.test(body)) throw syntaxError(entry.line, '不支持节点状态样式（|state）。');
    const head = /^([A-Za-z]+)/.exec(body);
    if (!head) {
      throw syntaxError(entry.line, `节点“${key}”缺少类型；应为“${key}=>operation: 文本”等。`);
    }
    const type = head[1].toLowerCase();
    const rest = body.slice(head[1].length);
    if (/^\s*\|/.test(rest)) throw syntaxError(entry.line, '不支持节点状态样式（|state）。');
    const tail = /^\s*(?::\s*([\s\S]*))?$/.exec(rest);
    if (!tail) {
      throw syntaxError(entry.line, `无法识别节点“${key}”的定义正文“${clip(rest.trim())}”；支持 id=>type: 文本，不支持状态样式（|state）、节点选项或其他修饰。`);
    }
    if (type === 'parallel') throw syntaxError(entry.line, '暂不支持 parallel 节点；支持 start、end、operation、subroutine、condition、inputoutput、input、output。');
    if (!FLOW_TYPES.has(type)) throw syntaxError(entry.line, `不支持的节点类型“${head[1]}”；支持 start、end、operation、subroutine、condition、inputoutput、input、output。`);
    if (nodes.has(key)) throw syntaxError(entry.line, `节点“${key}”重复定义。`);
    const content = unescapeLabel((tail[1] || '').trim());
    if (/\|\s*[^\s|]+\s*$/.test(content)) {
      throw syntaxError(entry.line, '不支持节点状态样式（|state）。');
    }
    nodes.set(key, { id: key, type, text: content });
  }

  for (const entry of merged) {
    if (definitionEntries.has(entry)) continue;
    if (!entry.text.includes('->')) throw syntaxError(entry.line, `无法识别“${clip(entry.text)}”。`);
    const segments = entry.text.split('->').map(segment => segment.trim());
    if (segments.some(segment => !segment)) throw syntaxError(entry.line, '连接“->”两侧都必须有节点。');
    for (let index = 0; index + 1 < segments.length; index++) {
      const from = parseEndpoint(segments[index], entry.line, nodes);
      const to = parseEndpoint(segments[index + 1], entry.line, nodes);
      if (index + 2 >= segments.length && to.label) {
        throw syntaxError(entry.line, '连接标签必须写在箭头起点一侧。');
      }
      edges.push({
        from: from.node,
        to: to.node,
        label: from.label
      });
    }
  }

  if (!nodes.size) throw syntaxError(1, '流程图为空。');
  return { nodes: [...nodes.values()], edges };
}

function measureFlowNode(node) {
  const size = 13, lineHeight = 18;
  if (node.type !== 'condition') {
    const lines = wrapLabel(node.text, 220, size);
    const width = Math.max(140, Math.round(maxLineWidth(lines, size)) + 34);
    const height = Math.max(44, lines.length * lineHeight + 22);
    return { lines, width, height };
  }
  let width = 180;
  let lines = [];
  let height = 84;
  for (let attempt = 0; attempt < 4; attempt++) {
    lines = wrapLabel(node.text, Math.max(90, width * .55), size);
    height = Math.max(84, lines.length * lineHeight + 50);
    const textWidth = maxLineWidth(lines, size);
    const allowed = width * Math.max(.35, 1 - (lines.length - 1) * lineHeight / height);
    if (textWidth <= allowed || width >= 420) break;
    width = Math.min(420, Math.ceil(textWidth / allowed * width + 10));
  }
  return { lines, width, height };
}

function layoutFlow(diagram, palette, id) {
  const size = 13, lineHeight = 18, rowGap = 74, nodeGap = 32, padding = 20;
  const nodes = diagram.nodes;
  const edges = diagram.edges;
  if (!nodes.length) throw syntaxError(1, '流程图为空。');
  for (const node of nodes) Object.assign(node, measureFlowNode(node));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from.id).push(edge);

  // Depth-first search marks the edges that close a cycle. They are routed
  // around the outside instead of widening their target's rank forever.
  const state = new Map();
  const postorder = [];
  const visit = node => {
    state.set(node.id, 1);
    for (const edge of outgoing.get(node.id)) {
      const target = state.get(edge.to.id) || 0;
      if (target === 1) { edge.back = true; continue; }
      if (target === 0) visit(edge.to);
    }
    state.set(node.id, 2);
    postorder.push(node.id);
  };
  for (const node of nodes) if (!state.get(node.id)) visit(node);

  const order = [...postorder].reverse();
  const rank = new Map(order.map(key => [key, 0]));
  for (const key of order) {
    for (const edge of outgoing.get(key)) {
      if (edge.back) continue;
      rank.set(edge.to.id, Math.max(rank.get(edge.to.id), rank.get(key) + 1));
    }
  }

  const rows = new Map();
  for (const node of nodes) {
    const key = rank.get(node.id) ?? 0;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(node);
  }
  let y = 0;
  for (const key of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(key);
    const total = row.reduce((width, node) => width + node.width, 0) + nodeGap * (row.length - 1);
    let x = -total / 2;
    for (const node of row) {
      node.cx = x + node.width / 2;
      node.top = y;
      x += node.width + nodeGap;
    }
    y += Math.max(...row.map(node => node.height)) + rowGap;
  }

  const box = bounds();
  const parts = [];
  for (const node of nodes) box.add(node.cx - node.width / 2, node.top, node.cx + node.width / 2, node.top + node.height);

  let lane = Math.max(...nodes.map(node => node.cx + node.width / 2)) + 34;
  for (const edge of edges) {
    const from = byId.get(edge.from.id), to = byId.get(edge.to.id);
    const marker = `${id}-arrow`;
    let labelX, labelY;
    if (edge.back || edge.from === edge.to) {
      const laneX = lane;
      lane += 18;
      if (edge.from === edge.to) {
        const sx = from.cx + from.width / 2;
        const centerY = from.top + from.height / 2;
        const startY = centerY - 8, endY = centerY + 16;
        parts.push(`<path d="M ${round(sx)} ${round(startY)} H ${round(laneX)} V ${round(endY)} H ${round(sx)}" fill="none" stroke="${palette.ink}" stroke-width="1.5" marker-end="url(#${marker})"/>`);
        labelX = (sx + laneX) / 2;
        labelY = startY - 7;
        box.add(sx, startY, laneX, endY);
      } else {
        const sx = from.cx + from.width / 2, sy = from.top + from.height / 2;
        const tx = to.cx + to.width / 2, ty = to.top + to.height / 2;
        parts.push(`<path d="M ${round(sx)} ${round(sy)} H ${round(laneX)} V ${round(ty)} H ${round(tx + 1)}" fill="none" stroke="${palette.ink}" stroke-width="1.5" marker-end="url(#${marker})"/>`);
        labelX = (sx + laneX) / 2;
        labelY = sy - 7;
        box.add(sx, Math.min(sy, ty), laneX, Math.max(sy, ty));
      }
    } else {
      const sx = from.cx, sy = from.top + from.height;
      const tx = to.cx, ty = to.top - 2;
      const middle = (sy + ty) / 2;
      const path = Math.abs(sx - tx) < .5
        ? `M ${round(sx)} ${round(sy)} V ${round(ty)}`
        : `M ${round(sx)} ${round(sy)} V ${round(middle)} H ${round(tx)} V ${round(ty)}`;
      parts.push(`<path d="${path}" fill="none" stroke="${palette.ink}" stroke-width="1.5" marker-end="url(#${marker})"/>`);
      // Keep a label off the vertical line; a centred label would be struck
      // through by the arrow and become hard to read.
      labelX = Math.abs(sx - tx) < .5 ? sx + 18 : (sx + tx) / 2;
      labelY = middle - 7;
      box.add(Math.min(sx, tx), sy, Math.max(sx, tx), ty);
    }
    box.add(labelX - 1, labelY - 13, labelX + 1, labelY);
    if (edge.label) {
      parts.push(svgText({ x: labelX, y: labelY, text: edge.label, size: 12, fill: palette.muted }));
      box.text(labelX, labelY, edge.label, 12);
    }
  }

  for (const node of nodes) {
    const left = node.cx - node.width / 2, right = node.cx + node.width / 2;
    const top = node.top, bottom = node.top + node.height;
    let shape;
    if (node.type === 'start' || node.type === 'end') {
      shape = `<rect x="${round(left)}" y="${round(top)}" width="${node.width}" height="${node.height}" rx="${node.height / 2}" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="1.5"/>`;
    } else if (node.type === 'condition') {
      shape = `<polygon points="${round(node.cx)},${round(top)} ${round(right)},${round(top + node.height / 2)} ${round(node.cx)},${round(bottom)} ${round(left)},${round(top + node.height / 2)}" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="1.5"/>`;
    } else if (node.type === 'inputoutput' || node.type === 'input' || node.type === 'output') {
      shape = `<polygon points="${round(left + 12)},${round(top)} ${round(right)},${round(top)} ${round(right - 12)},${round(bottom)} ${round(left)},${round(bottom)}" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="1.5"/>`;
    } else {
      shape = `<rect x="${round(left)}" y="${round(top)}" width="${node.width}" height="${node.height}" rx="3" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="1.5"/>`;
      if (node.type === 'subroutine') {
        shape += `<line x1="${round(left + 7)}" y1="${round(top + 1)}" x2="${round(left + 7)}" y2="${round(bottom - 1)}" stroke="${palette.ink}" stroke-width="1.2"/>`;
        shape += `<line x1="${round(right - 7)}" y1="${round(top + 1)}" x2="${round(right - 7)}" y2="${round(bottom - 1)}" stroke="${palette.ink}" stroke-width="1.2"/>`;
      }
    }
    parts.push(shape);
    const first = top + node.height / 2 - (node.lines.length - 1) * lineHeight / 2 + 4;
    node.lines.forEach((line, index) => {
      const baseline = first + index * lineHeight;
      parts.push(svgText({ x: node.cx, y: baseline, text: line, size, fill: palette.ink }));
      box.text(node.cx, baseline, line, size);
    });
  }

  const width = Math.ceil(box.maxX - box.minX + padding * 2);
  const height = Math.ceil(box.maxY - box.minY + padding * 2);
  const dx = padding - box.minX;
  const dy = padding - box.minY;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="流程图" font-family="${FONT}">
<title>流程图</title>
<defs>${arrowMarker(`${id}-arrow`, 'filled', palette)}</defs>
<g transform="translate(${round(dx)} ${round(dy)})">
${parts.join('\n')}
</g>
</svg>`;
}

// ── public entry point ─────────────────────────────────────────────────────

/**
 * Render one native diagram fence. Returns `{ svg, error }`; an error is a
 * ready-to-display Chinese message that already names the diagram kind and the
 * source line. Never throws for malformed document input.
 */
export function renderNativeDiagram(kind, source, options = {}) {
  const type = String(kind || '').toLowerCase();
  if (!NATIVE_DIAGRAM_KINDS.has(type)) return { svg: null, error: `不支持的图表类型：${clip(kind, 24)}。` };
  const palette = paletteOf(options.palette);
  const requested = String(options.idPrefix || '');
  const prefix = `inkstone-${type}-${requested.replace(/[^a-zA-Z0-9_-]/g, '') || (++serial)}`;
  try {
    const diagram = type === 'sequence' ? parseSequence(source) : parseFlow(source);
    const svg = type === 'sequence' ? layoutSequence(diagram, palette, prefix) : layoutFlow(diagram, palette, prefix);
    return { svg, error: null };
  } catch (error) {
    const label = type === 'sequence' ? '时序图' : '流程图';
    return { svg: null, error: `${label}第 ${Number(error?.line) || 1} 行：${error?.message || String(error)}` };
  }
}
