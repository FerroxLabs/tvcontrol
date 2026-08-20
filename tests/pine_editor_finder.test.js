// Regression test for the two silent Pine-editor resolution bugs found
// 2026-08-20, both of which let four rounds of script edits vanish while every
// signal in the UI reported success.
//
// The fake DOM below is not a generic mock. It reproduces the exact shape the
// live page had:
//   * TWO `.monaco-editor.pine-editor-monaco` nodes, the FIRST one collapsed to
//     0x0 and carrying no React fiber
//   * THREE editors from getEditors(), with index 0 DETACHED from any DOM node
// Under those conditions the old finder returned null and the old push wrote
// into the detached editor.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/core/pine.js', import.meta.url), 'utf-8');
const match = src.match(/const FIND_MONACO = `([\s\S]*?)`;/);

test('FIND_MONACO is still extractable from pine.js', () => {
  assert.ok(match, 'FIND_MONACO template not found; the finder was renamed or restructured');
});

function makeDom() {
  const box = (w, h) => ({ getBoundingClientRect: () => ({ width: w, height: h }) });

  const visibleNode = {
    ...box(937, 751),
    contains: (n) => n === visibleNode || n === visibleInner,
    parentElement: null,
  };
  const visibleInner = { ...box(937, 751), contains: () => false, parentElement: visibleNode };
  visibleNode.__notFiber = 1;

  const collapsedNode = { ...box(0, 0), contains: () => false, parentElement: null };

  // the detached editor: real object, no DOM node. Writing here is the bug.
  const detached = { _v: 'DETACHED', getValue() { return this._v; },
                     setValue(v) { this._v = v; }, getDomNode: () => null };
  const other    = { _v: 'OTHER', getValue() { return this._v; },
                     setValue(v) { this._v = v; }, getDomNode: () => collapsedNode };
  const real     = { _v: 'REAL', getValue() { return this._v; },
                     setValue(v) { this._v = v; }, getDomNode: () => visibleInner };

  const env = { editor: { getEditors: () => [detached, other, real] } };
  // the fiber lives one level up from the visible node, as it does live
  const holder = { ...box(937, 751), contains: () => false, parentElement: null };
  visibleNode.parentElement = holder;
  holder['__reactFiber$abc'] = { memoizedProps: { value: { monacoEnv: env } }, return: null };

  return {
    document: {
      querySelectorAll: (sel) =>
        sel === '.monaco-editor.pine-editor-monaco' ? [collapsedNode, visibleNode] : [],
      querySelector: (sel) =>
        sel === '.monaco-editor.pine-editor-monaco' ? collapsedNode : null,
    },
    expected: real,
    detached,
  };
}

test('the finder skips the collapsed 0x0 node and the detached editor', () => {
  const { document, expected, detached } = makeDom();
  // Parenthesised deliberately: FIND_MONACO starts with a newline, and
  // `return\n(function...)` is an automatic-semicolon-insertion trap that
  // returns undefined and looks exactly like a finder failure.
  const finder = new Function('document', 'return (' + match[1] + ');');
  const found = finder(document);

  assert.ok(found, 'finder returned null on a page where the editor IS visible');
  assert.notStrictEqual(found.editor, detached,
    'finder picked getEditors()[0], the DETACHED editor: writes there compile ' +
    'clean, report Saved, never bump the script version, and never reach the chart');
  assert.strictEqual(found.editor, expected,
    'finder did not resolve the editor attached to the visible container');
  assert.strictEqual(found.editor.getValue(), 'REAL');
});

test('the finder does not reintroduce the two known-bad patterns', () => {
  const body = match[1];
  assert.ok(!/querySelector\(\s*'\.monaco-editor\.pine-editor-monaco'\s*\)/.test(body),
    "querySelector on the monaco class returns the COLLAPSED node first; use querySelectorAll plus a geometry check");
  assert.ok(!/getEditors\(\)\s*;?[\s\S]{0,120}editors\[0\]/.test(body),
    'editors[0] is the detached instance; match the editor to the container by DOM node');
  assert.ok(/getBoundingClientRect/.test(body),
    'the finder must pick the container by geometry, not by document order');
  assert.ok(/getDomNode/.test(body),
    'the finder must match the editor to the container by DOM node');
});
