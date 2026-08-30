/**
 * layout_create / layout_save must not use the dialog-based save paths.
 *
 * Read live off TradingView Desktop 3.4.0 (2026-08-30), the tempting names all
 * resolve to a MODAL:
 *
 *   saveNewChart(e,t,i)  { this._createController.show(e,t,i) }
 *   createEmptyChart()   { this._createEmptyController?.show() }
 *   renameChart()        { this._renameController.show() }
 *
 * `.show()` returns immediately, so headlessly any of those would report
 * success while a dialog sat waiting for a human who is not there - the same
 * fire-and-forget failure layout_switch shipped for three releases. The two
 * that do the work without a dialog are:
 *
 *   createNewLayout(e)      -> createNewChart(e), returns the new id
 *   saveChartToServer(...)  -> _saveChartService.saveChartSilently(...)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/ui.js', import.meta.url), 'utf-8');
const tools = readFileSync(new URL('../src/tools/ui.js', import.meta.url), 'utf-8');

function bodyOf(name) {
  const start = core.indexOf(`export async function ${name}(`);
  assert.ok(start !== -1, `${name} was renamed or removed`);
  const next = core.indexOf('\nexport ', start + 10);
  const raw = core.slice(start, next === -1 ? undefined : next);
  return raw.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

const createBody = bodyOf('layoutCreate');
const saveBody = bodyOf('layoutSave');

describe('layout_create never opens a dialog', () => {
  it('uses createNewLayout, not the controller-backed creators', () => {
    assert.match(createBody, /createNewLayout/);
    for (const trap of ['saveNewChart', 'createEmptyChart', 'renameChart', 'showSaveAsChartDialog', 'saveChartAs']) {
      assert.doesNotMatch(createBody, new RegExp(trap),
        `${trap} resolves to controller.show() - it opens a modal and returns before anything is saved`);
    }
  });

  // REPOINTED TWICE, not deleted, and the second repoint is the important one.
  //
  // v1 asserted the live layout id changed. v2 replaced that with a URL
  // comparison "because the id lagged". It was not lagging - createNewLayout
  // moves the URL WITHOUT loading the chart, so the widget was correctly
  // reporting that it had not moved. Trusting the URL is what let a save write
  // the new name onto the user's own layout and RENAME IT, while reporting
  // confirmed_in_account: true about the wrong chart. The widget id is the
  // only honest signal, so it is back.
  it('waits for the WIDGET to move, never the URL', () => {
    assert.match(createBody, /now\.layout_id !== before\.layout_id/,
      'the URL moves without the chart loading; only the widget layout id is evidence');
    assert.doesNotMatch(createBody, /after_url === created\.before_url/,
      'a URL comparison is exactly the check that renamed a live user layout');
  });

  it('refuses to save when the widget never moved', () => {
    assert.match(createBody, /if \(!moved\)[\s\S]{0,400}throw new ClassifiedError/,
      'saving while the old chart is still loaded writes the new name onto the OLD layout');
    assert.match(createBody, /Refusing to save/,
      'the error has to say what it did NOT do, or a caller assumes a partial success');
  });

  it('will not navigate away from unsaved work without being told to', () => {
    assert.match(createBody, /before\.dirty && !discard_unsaved[\s\S]{0,300}throw new ClassifiedError/,
      'creating a layout navigates away from the current chart, which loses unsaved changes');
  });

  it('names the layout at SAVE time, because createNewLayout does not name anything', () => {
    assert.match(createBody, /layoutSave\(\{ name: title/,
      'measured: createNewLayout ignores its argument as a name; chartName on the save is what names it');
    assert.match(saveBody, /chartName/);
  });

  it('a named save that the account does not list is a failure', () => {
    assert.match(saveBody, /getSavedCharts/, 'the account listing it is the only evidence a save landed');
    // Assert the GUARD, not the message. The first version of this matched the
    // error text, which survives when the condition around it is disabled - so
    // it passed with the check neutered. A test that cannot go red is not a test.
    assert.match(saveBody, /if \(title && !\(r\.matches \|\| \[\]\)\.length\)[\s\S]{0,200}throw new ClassifiedError/,
      'reporting success on an unlisted save is exactly how layout_switch lied for three releases');
  });

  it('refuses an empty name', () => {
    assert.match(createBody, /INVALID_ARGUMENT/);
  });
});

describe('layout_save is silent', () => {
  it('uses saveChartToServer and no dialog path', () => {
    assert.match(saveBody, /saveChartToServer/);
    for (const trap of ['showSaveAsChartDialog', 'saveChartAs', 'saveNewChart']) {
      assert.doesNotMatch(saveBody, new RegExp(trap), `${trap} opens a modal`);
    }
  });

  it('reports whether unsaved changes remain rather than assuming the save landed', () => {
    assert.match(saveBody, /unsaved_changes_remaining/);
    assert.match(saveBody, /hasChanges/);
  });
});

describe('both tools are registered and reachable', () => {
  it('registers layout_create and layout_save', () => {
    assert.match(tools, /server\.tool\('layout_create'/);
    assert.match(tools, /server\.tool\('layout_save'/);
    assert.match(tools, /core\.layoutCreate\(/);
    assert.match(tools, /core\.layoutSave\(/);
  });
});

describe('layout_create hands back a chart that can actually be used', () => {
  // A brand-new chart has a widget long before it has a series. Measured on a
  // live run: indicator_add_from_search returned "TradingView accepted TC-TIDE
  // but no new study appeared" and chart_set_timeframe reported "Chart did not
  // finish loading", both within seconds of layout_create returning success.
  it('waits for a loaded series before it reports the layout', () => {
    assert.match(createBody, /waitForChartReady/,
      'layout_create must wait for real bars, not just for the widget id to change');
    const waitAt = createBody.indexOf('waitForChartReady');
    const saveAt = createBody.indexOf('layoutSave({');
    assert.ok(waitAt !== -1 && saveAt !== -1 && waitAt < saveAt,
      'the wait has to happen BEFORE the save, or the save races the load');
  });

  it('reports chart_ready from the wait, never as a literal', () => {
    // `chart_ready: true` would satisfy any grep for the field while telling
    // every caller the chart is usable whether or not it is - a field that
    // cannot be false is not a signal.
    assert.doesNotMatch(createBody, /chart_ready:\s*(true|false)\b/,
      'chart_ready must be derived from the readiness wait, not hard-coded');
    assert.match(createBody, /chart_ready:\s*chartReady/);
  });
});
