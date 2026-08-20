// Regression test for the Pine-editor OPEN path, found 2026-08-20 while
// verifying the earlier silent-success fixes against a live chart.
//
// THE BUG WAS ORDER, NOT MECHANISM. openPanel tried
// bottomWidgetBar.activateScriptEditorTab() first and clicked
// [data-name="pine-dialog-button"] only as a fallback.
//
// MEASURED across three live environments, same 9-transition cycle:
//
//   macOS   + Desktop 3.3.0   old order FAILS   new order 9/9
//   Windows + Desktop 3.3.0   old order works   new order 9/9
//   Windows + Chrome web      old order works   new order 9/9
//
// The failure is macOS-specific. That is exactly why this test exists: on
// Windows the old order looks correct, so nothing on that platform would stop
// someone reverting it and silently breaking every Mac user.
//
// bottomWidgetBar exists on this build and its methods do not throw. They just
// leave the editor shut and apparently leave TradingView believing the editor
// is already open, so the click that follows is ignored. The failure was
// invisible from inside the page: every call was "successful".
//
// These tests read the source rather than the DOM because what has to hold is a
// property of the ORDER the source is written in, which no DOM fixture can pin.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/core/ui.js', import.meta.url), 'utf-8');

// The open branch: from the `acted` declaration to the start of the close branch.
const openBranch = (() => {
  const start = src.indexOf('var acted = false;');
  const end = src.indexOf("} else if (action === 'close'");
  assert.ok(start !== -1 && end !== -1 && end > start,
    'could not locate the open branch of openPanel; it was renamed or restructured');
  return src.slice(start, end);
})();

test('the open path reaches for the dialog button BEFORE bottomWidgetBar', () => {
  const dialog = openBranch.indexOf('pine-dialog-button');
  const widget = openBranch.indexOf('activateScriptEditorTab');

  assert.notStrictEqual(dialog, -1, 'the dialog button lookup is gone; open cannot work on Desktop 3.3.0');
  assert.notStrictEqual(widget, -1, 'the bottomWidgetBar fallback is gone; older builds lose their only path');
  assert.ok(dialog < widget,
    'bottomWidgetBar is tried before the dialog button. That exact order was measured to fail ' +
    'every time on Desktop 3.3.0: the widget-bar call leaves the editor shut and the later ' +
    'click is ignored. The dialog button must come first.');
});

test('bottomWidgetBar is a fallback, not an unconditional first call', () => {
  // It must sit behind an `else`, so a build WITH the dialog button never calls it.
  const widget = openBranch.indexOf('activateScriptEditorTab');
  const preceding = openBranch.slice(0, widget);
  const lastBrace = preceding.lastIndexOf('} else if');
  assert.ok(lastBrace !== -1 && lastBrace > openBranch.indexOf('pine-dialog-button'),
    'activateScriptEditorTab is not guarded by an else after the dialog-button branch, so it ' +
    'still runs on builds that have the dialog. That is the failing configuration.');
});

test('the open path still verifies instead of assuming', () => {
  // The whole family of bugs was "reported success without looking".
  assert.ok(/verified === false/.test(src),
    'the post-action verification is gone; openPanel is back to claiming success it never checked');
  assert.ok(/PINE_VISIBLE/.test(src),
    'the measured-visibility check is gone; existence in the DOM is not visibility');
});
