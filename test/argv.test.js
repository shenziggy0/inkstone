import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import argvModule from '../electron/argv.cjs';
const { parseDocumentPaths } = argvModule;

test('command-line document paths ignore Electron switches and the app directory', () => {
  const working = path.resolve('/workspace/project');
  const result = parseDocumentPaths([
    path.resolve('/electron/electron'),
    working,
    '--no-sandbox',
    '--remote-debugging-port=9222',
    'note.md'
  ], working);
  assert.deepEqual(result, [path.resolve(working, 'note.md')], '项目目录不能被当成文档打开');
});

test('relative paths resolve against the caller working directory', () => {
  const working = path.resolve('/workspace/docs');
  assert.deepEqual(parseDocumentPaths(['inkstone', 'chapters/one.markdown'], working), [path.resolve(working, 'chapters/one.markdown')]);
  assert.deepEqual(parseDocumentPaths(['inkstone', '.\\notes\\today.txt'], working), [path.resolve(working, 'notes/today.txt')]);
});

test('only Markdown and text documents are accepted, once each', () => {
  const working = path.resolve('/workspace');
  const absolute = path.resolve('/docs/README.MDOWN');
  const result = parseDocumentPaths([
    'inkstone',
    'a.md', 'a.md', absolute, 'image.png', 'script.js', '-p', '', 'b.txt', 'c.md.bak'
  ], working);
  assert.deepEqual(result, [path.resolve(working, 'a.md'), absolute, path.resolve(working, 'b.txt')]);
});

test('malformed input yields no documents', () => {
  assert.deepEqual(parseDocumentPaths(null), []);
  assert.deepEqual(parseDocumentPaths([]), []);
  assert.deepEqual(parseDocumentPaths(['inkstone']), []);
  assert.deepEqual(parseDocumentPaths(['inkstone', 42, null, '--']), []);
});
