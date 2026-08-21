/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';
import { STUDY_RESOLVER_JS } from './_study_ref.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const DIALOG = '[data-name="indicators-dialog"]';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || evaluate,
    wait: deps?.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
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
    const result = await deps.evaluate(READ_RESULTS_JS);
    if (!result?.open) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Indicators dialog closed during search');
    return { success: true, query: cleanQuery, count: (result.results || []).slice(0, cap).length, results: (result.results || []).slice(0, cap) };
  } finally {
    await _closeDialog(deps.evaluate, deps.wait).catch(() => {});
  }
}

export async function addStudyFromSearch({ query, match, section, _deps } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'query is required');
  const want = String(match || cleanQuery).trim();
  const deps = _resolve(_deps);
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
    if (clicked?.error) throw new ClassifiedError(CATEGORIES.STUDY_NOT_FOUND, `${clicked.error}: ${want}`);
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

  return {
    success: unmatched.length === 0 && rejected.length === 0,
    entity_id,
    updated_inputs: updated,
    applied: after,
    ...(unmatched.length ? { not_found: unmatched, available_ids: result?.available_ids || [] } : {}),
    ...(rejected.length ? { rejected_by_study: rejected.map((k) => ({ id: k, requested: updated[k], actual: after[k] })) } : {}),
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
