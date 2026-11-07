const path = require('node:path');

const DOCUMENT = /\.(md|markdown|mdown|txt)$/i;

/**
 * File paths named on the command line (Windows "open with" / cold start).
 * Pure on purpose: no filesystem access, so it can be unit tested directly.
 * Electron injects its own switches and, in development, the app directory;
 * switches start with `-` and the app directory has no document extension, so
 * both are ignored. Relative paths resolve against the caller's working
 * directory (the `workingDirectory` of a second-instance event).
 */
function parseDocumentPaths(argv, workingDirectory = process.cwd()) {
  if (!Array.isArray(argv)) return [];
  const seen = new Set();
  const documents = [];
  // argv[0] is the executable (Electron or Inkstone.exe), never a document.
  for (const argument of argv.slice(1)) {
    if (typeof argument !== 'string' || !argument || argument.startsWith('-')) continue;
    if (!DOCUMENT.test(argument)) continue;
    const resolved = path.resolve(workingDirectory || process.cwd(), argument);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(resolved);
  }
  return documents;
}

module.exports = { parseDocumentPaths };
