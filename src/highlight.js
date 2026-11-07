// Syntax highlighting is split in two: a small core plus the languages a
// technical Markdown document realistically contains, and a dynamic import for
// everything else. Bundling `highlight.js` as a whole used to put every one of
// its ~190 languages into the main chunk (~1.9 MB of source) even though a
// document can only use a handful; the renderer now pays for the languages it
// actually shows and loads the rest on demand.
import hljs from 'highlight.js/lib/core';
import plaintext from 'highlight.js/lib/languages/plaintext';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

/**
 * Languages that are registered with the core at startup. Keeping this list
 * short is the whole point of the change; each entry costs bundle size in every
 * session, so it only holds what a README, a technical note or a code sample in
 * a Markdown file is likely to contain.
 */
export const PRELOADED_LANGUAGES = [
  'plaintext', 'javascript', 'typescript', 'json', 'bash', 'python', 'java',
  'go', 'rust', 'c', 'cpp', 'csharp', 'css', 'xml', 'markdown', 'yaml', 'sql', 'diff'
];

for (const [name, grammar] of Object.entries({
  plaintext, javascript, typescript, json, bash, python, java, go, rust, c, cpp,
  csharp, css, xml, markdown, yaml, sql, diff
})) hljs.registerLanguage(name, grammar);

/**
 * Everything else is fetched when a document names it. Each loader is a static
 * `import()` so the bundler emits one chunk per language; nothing here is part
 * of the main bundle. Adding a language means adding one line.
 */
const LAZY = {
  apache: () => import('highlight.js/lib/languages/apache'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  coffeescript: () => import('highlight.js/lib/languages/coffeescript'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  dart: () => import('highlight.js/lib/languages/dart'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  julia: () => import('highlight.js/lib/languages/julia'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  matlab: () => import('highlight.js/lib/languages/matlab'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scheme: () => import('highlight.js/lib/languages/scheme'),
  scss: () => import('highlight.js/lib/languages/scss'),
  stylus: () => import('highlight.js/lib/languages/stylus'),
  swift: () => import('highlight.js/lib/languages/swift'),
  tcl: () => import('highlight.js/lib/languages/tcl'),
  toml: () => import('highlight.js/lib/languages/ini'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  vim: () => import('highlight.js/lib/languages/vim'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
  x86asm: () => import('highlight.js/lib/languages/x86asm')
};

// Fence labels that are really an alias of a language we can load. The real
// alias table lives inside each grammar, which is only available after loading,
// so the handful of spellings authors actually type are listed here.
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  py: 'python', py3: 'python',
  golang: 'go',
  rs: 'rust',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
  html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown',
  yml: 'yaml',
  psql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql',
  patch: 'diff',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext',
  kt: 'kotlin', kts: 'kotlin',
  hs: 'haskell',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang',
  fs: 'fsharp',
  ml: 'ocaml',
  pl: 'perl',
  rb: 'ruby',
  sc: 'scala',
  clj: 'clojure', cljs: 'clojure',
  objc: 'objectivec', 'objective-c': 'objectivec',
  proto: 'protobuf',
  tex: 'latex',
  toml: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  docker: 'dockerfile',
  mk: 'makefile', mak: 'makefile',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  vb: 'vbnet',
  viml: 'vim',
  asm: 'x86asm',
  hbs: 'xml'
};

const loading = new Map();
const failed = new Set();
const listeners = new Set();

/** True when the grammar for `language` (or one of its aliases) is registered. */
export const isHljsLanguage = language => !!(language && hljs.getLanguage(language));

/**
 * Highlight `code` as `language`.
 *
 * Returns `{ html, pending }`. `html` is null when the grammar is not loaded
 * yet — the caller keeps its escaped fallback for now and re-renders once the
 * `pending` language arrives, so a first paint never waits on a network-less
 * dynamic import.
 */
export function highlightCode(code, language) {
  if (language && hljs.getLanguage(language)) {
    return { html: hljs.highlight(String(code), { language, ignoreIllegals: true }).value, pending: false };
  }
  if (!language) return { html: null, pending: false };
  return { html: null, pending: !!requestLanguage(language) };
}

/**
 * Start loading one language, if it is known to the lazy table. Returns the
 * promise, or null when nothing can be loaded for that label (an unknown fence
 * language simply stays plain, exactly as before).
 */
export function requestLanguage(language) {
  const key = String(language || '').trim().toLowerCase();
  const name = ALIASES[key] || key;
  if (hljs.getLanguage(name)) return null;
  if (failed.has(name)) return null;
  if (loading.has(name)) return loading.get(name);
  const load = LAZY[name];
  if (!load) return null;
  const promise = load()
    .then(module => {
      const grammar = module?.default || module;
      if (typeof grammar !== 'function') throw new Error(`语言包无效：${name}`);
      hljs.registerLanguage(name, grammar);
      // The grammar brings its own aliases, so `hs` starts working once
      // `haskell` is loaded.
      if (key !== name) hljs.registerLanguage(key, grammar);
      for (const listener of listeners) { try { listener(name); } catch { /* a listener must not break the others */ } }
      return true;
    })
    .catch(() => { failed.add(name); return false; });
  loading.set(name, promise);
  return promise;
}

/** Subscribe to "a language just became available". Returns an unsubscribe. */
export function onLanguageLoaded(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every fence label used by `source`, in document order, without repeats. */
export function fenceLanguages(source) {
  const names = new Set();
  for (const match of String(source ?? '').matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/gm)) {
    const name = match[1].toLowerCase();
    if (name && name !== 'mermaid') names.add(name);
  }
  return [...names];
}

/**
 * Load every language a document needs before it is rendered for an export.
 * The export must match what the editor shows, so it waits here instead of
 * shipping a code block whose language would silently stay unhighlighted.
 */
export async function ensureLanguages(source) {
  const pending = fenceLanguages(source).map(name => requestLanguage(name));
  const results = await Promise.all(pending);
  return results.filter(Boolean).length;
}

export default hljs;
