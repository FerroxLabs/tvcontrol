/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { STUDY_RESOLVER_JS } from './_study_ref.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const DIALOG = '[data-name="indicators-dialog"]';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || evaluate,
    wait: deps?.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

const READ_RESULTS_JS = `
  (function() {
    var dlg = document.querySelector('${DIALOG}');
    if (!dlg) return { open: false };
    var scroll = dlg.querySelector('[class*="scroll"]') || dlg;
    var rows = scroll.querySelectorAll('[class*="container"]');
    var results = [], section = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var h3 = row.querySelector('h3');
      if (h3 && h3.parentElement === row) {
        section = (h3.textContent || '').trim();
        continue;
      }
      var titleEl = row.querySelector('[class*="title"]');
      if (!titleEl) continue;
      var title = (titleEl.textContent || '').trim();
      if (title) results.push({ title: title, section: section });
    }
    return { open: true, results: results };
  })()
`;

async function _openDialog(evaluateFn, wait) {
  const opened = await evaluateFn(`
    (function() {
      if (document.querySelector('${DIALOG}')) return 'already';
      var btn = document.querySelector('[data-name="open-indicators-dialog"]');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()
  `);
  if (opened === 'no-button') {
    throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Indicators toolbar button not found');
  }
  for (let i = 0; i < 20; i++) {
    await wait(200);
    if (await evaluateFn(`!!document.querySelector('${DIALOG} input')`)) return;
  }
  throw new ClassifiedError(CATEGORIES.CHART_LOADING, 'Indicators dialog did not become ready');
}

async function _typeQuery(evaluateFn, wait, query) {
  const typed = await evaluateFn(`
    (function() {
      var input = document.querySelector('${DIALOG} input');
      if (!input) return false;
      input.focus();
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${safeString(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  if (!typed) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Indicator search input not found');
  await wait(1200);
}

async function _closeDialog(evaluateFn, wait) {
  await evaluateFn(`
    (function() {
      var dlg = document.querySelector('${DIALOG}');
      if (!dlg) return false;
      var close = dlg.querySelector('[data-name="close"], [class*="close"] button, button[class*="close"]');
      if (!close) return false;
      close.click();
      return true;
    })()
  `);
  await wait(300);
}

/**
 * A known-positive control for the search surface itself.
 *
 * The dialog renders an empty result list in two situations that look identical to a reader:
 * the query genuinely matches nothing, and the indicator catalogue has not finished loading.
 * The second happens for tens of seconds after TradingView is relaunched, and the account's
 * own "My scripts" section is the last part to arrive. Reporting that as `count: 0` tells a
 * caller a private script is missing when it is merely late, and a caller acting on that will
 * send the user off to re-add something they already have.
 *
 * So an empty read is never returned until this control has been shown to match. It is a
 * built-in study present on every account; if even this returns nothing, the surface is not
 * answering and the honest answer is "not ready", not "not there".
 */
const READINESS_CONTROL_QUERY = 'RSI';
const EMPTY_RETRIES = 6;
const EMPTY_RETRY_MS = 500;

async function _readRows(evaluateFn) {
  const result = await evaluateFn(READ_RESULTS_JS);
  if (!result?.open) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Indicators dialog closed during search');
  return result.results || [];
}

/**
 * Read the result rows, and never hand back an unverified empty.
 *
 * Returns `{ rows, controlCount }`. `controlCount` is null when rows were found without
 * needing the control. Throws CHART_LOADING when the control also comes back empty.
 */
async function _readRowsOrProveEmpty(evaluateFn, wait, cleanQuery) {
  let rows = await _readRows(evaluateFn);
  for (let i = 0; rows.length === 0 && i < EMPTY_RETRIES; i++) {
    await wait(EMPTY_RETRY_MS);
    rows = await _readRows(evaluateFn);
  }
  if (rows.length > 0) return { rows, controlCount: null };

  await _typeQuery(evaluateFn, wait, READINESS_CONTROL_QUERY);
  const control = await _readRows(evaluateFn);
  if (control.length === 0) {
    throw new ClassifiedError(
      CATEGORIES.CHART_LOADING,
      `The indicator list is not answering: a control search for "${READINESS_CONTROL_QUERY}" also returned nothing, so an empty result for "${cleanQuery}" would be a false absence.`,
      { hint: 'TradingView is still loading its indicator catalogue - this is normal for a while after it starts. Wait a few seconds and search again. Do not tell the user the indicator is missing on the strength of this.' },
    );
  }
  return { rows: [], controlCount: control.length };
}

export async function searchStudies({ query, limit = 25, _deps } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'query is required');
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'limit must be an integer from 1 to 100');
  }
  const deps = _resolve(_deps);
  await _openDialog(deps.evaluate, deps.wait);
  try {
    await _typeQuery(deps.evaluate, deps.wait, cleanQuery);
    const { rows, controlCount } = await _readRowsOrProveEmpty(deps.evaluate, deps.wait, cleanQuery);
    const capped = rows.slice(0, cap);
    const out = { success: true, query: cleanQuery, count: capped.length, results: capped };
    if (rows.length === 0) {
      // Say WHY this zero can be trusted, so a caller can act on the absence.
      out.verified_empty = true;
      out.verified_by = { control_query: READINESS_CONTROL_QUERY, control_count: controlCount };
    }
    return out;
  } finally {
    await _closeDialog(deps.evaluate, deps.wait).catch(() => {});
  }
}

export async function addStudyFromSearch({ query, match, section, _deps } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'query is required');
  const want = String(match || cleanQuery).trim();
  const deps = _resolve(_deps);
  // A study cannot attach to a chart that has no series yet. On a chart created
  // seconds earlier this returned "TradingView accepted <name> but no new study
  // appeared" - the click landed, there was nothing to land on. Refuse up front
  // rather than half-adding: nothing has been created at this point, so the
  // caller can simply retry.
  if ((await deps.waitForChartReady(null, null, 30000, { evaluate: deps.evaluate })) !== true) {
    throw new ClassifiedError(
      CATEGORIES.CHART_LOADING,
      'The chart has no loaded series yet, so a study added now would not attach.',
      { hint: 'Wait for the chart to finish loading - chart_get_state shows when it has bars - then add the study. A chart created moments ago is the usual case.' },
    );
  }
  const before = await deps.evaluate(`${CHART_API}.getAllStudies().map(function(s){return s.id;})`);
  await _openDialog(deps.evaluate, deps.wait);

  let clicked;
  try {
    await _typeQuery(deps.evaluate, deps.wait, cleanQuery);
    clicked = await deps.evaluate(`
      (function() {
        var dlg = document.querySelector('${DIALOG}');
        if (!dlg) return { error: 'Indicators dialog closed' };
        var scroll = dlg.querySelector('[class*="scroll"]') || dlg;
        var want = ${safeString(want.toLowerCase())};
        var wantSection = ${section ? safeString(String(section).toLowerCase()) : 'null'};
        var rows = scroll.querySelectorAll('[class*="container"]');
        var currentSection = null, exact = null, contains = null;
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var h3 = row.querySelector('h3');
          if (h3 && h3.parentElement === row) { currentSection = (h3.textContent || '').trim().toLowerCase(); continue; }
          if (wantSection && currentSection !== wantSection) continue;
          var titleEl = row.querySelector('[class*="title"]');
          if (!titleEl) continue;
          var title = (titleEl.textContent || '').trim();
          var lower = title.toLowerCase();
          if (lower === want && !exact) exact = { row: row, title: title, section: currentSection };
          if (lower.indexOf(want) !== -1 && !contains) contains = { row: row, title: title, section: currentSection };
        }
        var pick = exact || contains;
        if (!pick) return { error: 'No matching study found' };
        pick.row.click();
        return { clicked: pick.title, section: pick.section };
      })()
    `);
    if (clicked?.error) {
      // Same trap as searchStudies: "no matching study" and "the catalogue has not loaded"
      // render identically. Prove the surface answers before blaming the study.
      if (clicked.error === 'No matching study found') {
        await _readRowsOrProveEmpty(deps.evaluate, deps.wait, cleanQuery);
      }
      throw new ClassifiedError(CATEGORIES.STUDY_NOT_FOUND, `${clicked.error}: ${want}`);
    }
    await deps.wait(1500);
  } finally {
    await _closeDialog(deps.evaluate, deps.wait).catch(() => {});
  }

  const after = await deps.evaluate(`${CHART_API}.getAllStudies().map(function(s){return {id:s.id,name:s.name||s.title||null};})`);
  const beforeSet = new Set(before || []);
  const added = (after || []).filter((study) => !beforeSet.has(study.id));
  if (added.length === 0) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `TradingView accepted "${clicked?.clicked || want}" but no new study appeared`, {
      hint: 'Re-check chart_get_state before retrying to avoid adding a duplicate.',
    });
  }
  return {
    success: true,
    added_from_search: clicked?.clicked,
    section: clicked?.section,
    entity_id: added[0].id,
    added_count: added.length,
  };
}

/**
 * Read a study's current input values back.
 *
 * `setInputs` could write them and nothing could read them, so a caller could never confirm
 * that a change landed, detect that someone had altered a setting by hand, or record the
 * configuration a result was produced under. An action with no confirmation is the same class
 * of defect as a chart read that does not say which chart it describes: it forces the caller
 * to assume, and assumptions are what this connector exists to remove.
 *
 * Where the study exposes input metadata, the human-readable name and type are attached. They
 * are a convenience only — `id` is the key `setInputs` takes, and the id is always returned.
 */
export async function getInputs({ entity_id, _deps } = {}) {
  const deps = _resolve(_deps);
  if (!entity_id) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'entity_id is required. Use chart_get_state to find study IDs.',
    );
  }
  const result = await deps.evaluate(`
    (function() {
      var chart = ${CHART_API};
      ${STUDY_RESOLVER_JS()}
      var __r = __tvResolveStudy(chart, ${safeString(entity_id)});
      if (__r.error) return { error: __r.error };
      var study = __r.study;
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };

      var values = [];
      try { values = study.getInputValues() || []; } catch (e) { return { error: 'getInputValues failed: ' + e.message }; }

      // Input metadata lives on the study's metaInfo and is not always present - a protected
      // or published script can withhold it. Missing metadata is not an error; the ids and
      // values are the contract.
      var meta = {};
      try {
        var mi = study.metaInfo && study.metaInfo();
        var defs = mi && mi.inputs;
        if (defs && defs.length) {
          for (var i = 0; i < defs.length; i++) {
            if (defs[i] && defs[i].id !== undefined) meta[defs[i].id] = { name: defs[i].name || null, type: defs[i].type || null };
          }
        }
      } catch (e) {}

      // OVERSIZED VALUES ARE REPORTED, NOT RETURNED.
      //
      // A protected or published Pine script carries its encoded source as an ordinary
      // input. Measured on a real strategy: 73 inputs, one of which was a 53KB blob. Handing
      // that back whole makes this tool unusable by the agents it exists for — it would
      // consume more of their context than every other reading in a scan combined, to say
      // nothing a caller can act on. So a long value is replaced by its length, and the fact
      // that it was replaced is stated. core/state.js does the same thing for the same
      // reason; the two must not disagree about what counts as too long.
      var MAX = 512;
      var out = [];
      var stripped = [];
      for (var j = 0; j < values.length; j++) {
        var v = values[j];
        var m = meta[v.id] || {};
        var entry = { id: v.id };
        var raw = v.value;
        if (typeof raw === 'string' && raw.length > MAX) {
          entry.value = null;
          entry.value_length = raw.length;
          entry.value_stripped = true;
          stripped.push({ id: v.id, value_length: raw.length });
        } else {
          entry.value = raw;
        }
        if (m.name) entry.name = m.name;
        if (m.type) entry.type = m.type;
        out.push(entry);
      }
      var name = null;
      try { var mi2 = study.metaInfo && study.metaInfo(); name = (mi2 && (mi2.description || mi2.shortDescription)) || null; } catch (e) {}
      return { inputs: out, stripped: stripped, study_name: name, metadata_available: Object.keys(meta).length > 0 };
    })()
  `);
  if (!result) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Could not read the study inputs; the chart may still be loading.');
  }
  if (result.error) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, result.error, { hint: 'Use chart_get_state to list the studies on this chart and their ids.' });
  }
  return {
    success: true,
    entity_id,
    study_name: result.study_name || null,
    count: result.inputs.length,
    inputs: result.inputs,
    ...(result.stripped && result.stripped.length
      ? {
        stripped_count: result.stripped.length,
        stripped: result.stripped,
        stripped_note: `${result.stripped.length} input(s) exceeded 512 characters and are reported by length instead of value. Protected Pine scripts carry their encoded source this way.`,
      }
      : {}),
    // Says WHY a name is missing rather than leaving the caller to guess the study is broken.
    ...(result.metadata_available ? {} : { note: 'This study did not expose input metadata, so only ids and values are reported. That is normal for protected or published scripts.' }),
  };
}

export async function setInputs({ entity_id, inputs: inputsRaw, _deps } = {}) {
  const deps = _resolve(_deps);
  let inputs;
  try {
    inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  } catch (err) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `inputs is not valid JSON: ${err.message}`,
      { hint: 'Pass inputs as a JSON object or a JSON-encoded object string, e.g. {"length": 50}.' },
    );
  }
  if (!entity_id) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const result = await deps.evaluate(`
    (function() {
      var chart = ${CHART_API};
      ${STUDY_RESOLVER_JS()}
      var __r = __tvResolveStudy(chart, ${safeString(entity_id)});
      if (__r.error) return { error: __r.error };
      var study = __r.study;
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      var availableIds = [];
      for (var i = 0; i < currentInputs.length; i++) {
        availableIds.push(currentInputs[i].id);
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      // READ BACK. setInputValues() returning is not evidence the study took
      // the value, and a study can silently clamp or reject one.
      var after = {};
      try {
        var reread = study.getInputValues();
        for (var j = 0; j < reread.length; j++) {
          if (updatedKeys.hasOwnProperty(reread[j].id)) after[reread[j].id] = reread[j].value;
        }
      } catch (e) {}
      return { updated_inputs: updatedKeys, available_ids: availableIds, after: after };
    })()
  `);

  if (result && result.error) {
    const isMissing = /not found/i.test(String(result.error));
    throw new ClassifiedError(isMissing ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED, result.error);
  }
  // NONE OF THE REQUESTED KEYS MATCHED AN INPUT ON THIS STUDY.
  // The loop only assigns where an input id equals a key you passed, so a
  // mismatch produced updated_inputs:{} and this returned success:true having
  // changed absolutely nothing. Study input ids are frequently not the friendly
  // name ("in_0", "length_1"), so this is the common case, not the rare one.
  const updated = result?.updated_inputs || {};
  const requested = Object.keys(inputs);
  const matched = Object.keys(updated);
  if (matched.length === 0) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `None of the requested inputs (${requested.join(', ')}) exist on this study, so nothing was changed`,
      {
        hint: `This study's input ids are: ${(result?.available_ids || []).join(', ') || '(none reported)'}. Call data_get_indicator with this entity_id to see them with their current values.`,
        details: { requested, available: result?.available_ids || [] },
      },
    );
  }

  // Partial match, and a value the study did not actually take, are both worth
  // saying out loud rather than folding into a flat success.
  const unmatched = requested.filter((k) => !matched.includes(k));
  const after = result?.after || {};
  const rejected = matched.filter((k) => after[k] !== undefined && String(after[k]) !== String(updated[k]));

  // AN ABSENT READ-BACK IS NOT A PASSING READ-BACK.
  //
  // `rejected` only considers keys PRESENT in `after`, so when the read-back
  // threw or returned nothing, `after` is {} and this reported
  // success:true, verified:true, applied:{}. The whole point of reading the
  // value back is to know it took, and no value means we do not know.
  const unverified = matched.filter((k) => after[k] === undefined);

  return {
    success: unmatched.length === 0 && rejected.length === 0 && unverified.length === 0,
    entity_id,
    updated_inputs: updated,
    applied: after,
    ...(unmatched.length ? { not_found: unmatched, available_ids: result?.available_ids || [] } : {}),
    ...(rejected.length ? { rejected_by_study: rejected.map((k) => ({ id: k, requested: updated[k], actual: after[k] })) } : {}),
    ...(unverified.length ? {
      unverified,
      verify_note: `${unverified.length} input(s) were set but did not come back in the read-back, so `
        + 'whether the study took them is unknown. They were NOT retried: setting an input twice is '
        + 'harmless but reporting an unknown as a success is not. Run data_get_indicator to see the '
        + 'current values.',
    } : {}),
    ...(unmatched.length || rejected.length
      ? { error: `${unmatched.length} input(s) did not exist and ${rejected.length} were changed by the study` }
      : {}),
    verified: rejected.length === 0,
  };
}

export async function toggleVisibility({ entity_id, visible, _deps } = {}) {
  const deps = _resolve(_deps);
  if (!entity_id) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id is required. Use chart_get_state to find study IDs.');
  // It is called toggleVisibility and it demanded an explicit boolean, so the
  // obvious call — "flip this study" — failed with an argument error. Omitting
  // visible now does what the name says: read the current state and invert it.
  if (visible !== undefined && typeof visible !== 'boolean') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'visible must be a boolean (true or false), or omitted to flip the current state');
  }

  const result = await deps.evaluate(`
    (function() {
      var chart = ${CHART_API};
      ${STUDY_RESOLVER_JS()}
      var __r = __tvResolveStudy(chart, ${safeString(entity_id)});
      if (__r.error) return { error: __r.error };
      var study = __r.study;
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var was = study.isVisible();
      var want = ${visible === undefined ? '!was' : String(visible)};
      study.setVisible(want);
      // The read-back is the evidence: setVisible() returning proves nothing.
      var actualVisible = study.isVisible();
      return { visible: actualVisible, was: was, wanted: want };
    })()
  `);

  if (result && result.error) {
    const isMissing = /not found/i.test(String(result.error));
    throw new ClassifiedError(isMissing ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED, result.error);
  }
  // The study can refuse: setVisible() is a request, isVisible() is the answer.
  if (result.wanted !== undefined && result.visible !== result.wanted) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `setVisible(${result.wanted}) was accepted but the study is still ${result.visible ? 'visible' : 'hidden'}`,
      { hint: 'Retry once; if it persists the study may be locked or on a pane that is itself hidden.' },
    );
  }
  return { success: true, entity_id, visible: result.visible, was: result.was, changed: result.was !== result.visible, verified: true };
}
