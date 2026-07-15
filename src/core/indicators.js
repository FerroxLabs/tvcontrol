/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';
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
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys };
    })()
  `);

  if (result && result.error) {
    const isMissing = /not found/i.test(String(result.error));
    throw new ClassifiedError(isMissing ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED, result.error);
  }
  return { success: true, entity_id, updated_inputs: result.updated_inputs };
}

export async function toggleVisibility({ entity_id, visible, _deps } = {}) {
  const deps = _resolve(_deps);
  if (!entity_id) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'visible must be a boolean (true or false)');

  const result = await deps.evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) {
    const isMissing = /not found/i.test(String(result.error));
    throw new ClassifiedError(isMissing ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED, result.error);
  }
  return { success: true, entity_id, visible: result.visible };
}
