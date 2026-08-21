/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { STUDY_RESOLVER_JS, isUsableStudyId } from './_study_ref.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

// chart.js is an INTERMEDIATE layer — outer callers (state.js, sweep.js)
// pass their full _deps bag through to chart.getState({_deps}). We don't
// strict-key-check here because the bag contains keys the outer caller
// uses but chart.js doesn't (paneList, drawingList, etc.). Strict-key
// checking is enforced at the public-API entry points only.

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    // Under TV_MCP_NO_CDP there is no browser, so there is nothing to settle
    // for. See _assertCdpAllowed in connection.js.
    sleep: deps?.sleep || (process.env.TV_MCP_NO_CDP
      ? (async () => {})
      : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))),
    fetch: deps?.fetch || globalThis.fetch,
  };
}

/**
 * AWAIT THE PROMISE. THIS IS THE BUG BEHIND THE BROKEN-PANE REPORTS.
 *
 * TradingView changed these to return Promises (createStudy returns
 * Promise<EntityId> as of charting library 1.15; the callback argument was
 * removed). Confirmed in the live Desktop build on 2026-08-21:
 *
 *     createStudy            async: true
 *     createMultipointShape  async: true
 *     setSymbol              async: true
 *     setResolution          async: true
 *
 * Calling them fire-and-forget and then sleeping a fixed interval before
 * reading the result is a race. Win it and everything looks fine. Lose it and
 * the study exists on the chart with NO server id, its id reads as [], and on
 * the pane's next reconnect create_study is sent with that [] and the server
 * answers "Invalid parameters" as a CRITICAL error, which destroys the chart
 * session. The pane then loops on reconnect forever and cannot recover: while
 * it is in that state symbolSameAsResolved() returns true, so re-setting the
 * same symbol is a silent no-op.
 *
 * That is why it struck at random and why the only apparent cure was rebuilding
 * the layout. See core/session_health.js for detection and repair.
 *
 * Builds an expression that resolves only when the call really finished.
 * `timeoutMs` bounds it so a hung call reports rather than hanging the tool.
 */
function awaited(call, timeoutMs = 15000) {
  return `
    (function() {
      return new Promise(function(resolve) {
        var settled = false;
        var done = function(v) { if (!settled) { settled = true; resolve(v); } };
        setTimeout(function() { done({ ok: false, reason: 'timeout' }); }, ${Number(timeoutMs)});
        try {
          var p = ${call};
          if (p && typeof p.then === 'function') {
            p.then(function(r) { done({ ok: true, value: (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean') ? r : null }); },
                   function(e) { done({ ok: false, reason: 'rejected', error: String(e && e.message || e) }); });
          } else {
            done({ ok: true, value: (typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean') ? p : null, sync: true });
          }
        } catch (e) { done({ ok: false, reason: 'threw', error: e.message }); }
      });
    })()
  `;
}

/**
 * A STUDY WITH NO id IS DAMAGED, AND IT USED TO BE REPORTED AS THOUGH IT WERE
 * NORMAL.
 *
 * CORRECTION: an earlier version of this note claimed TradingView gives every
 * Pine study an empty Array as its id. It does not. Measured on two panes of
 * one layout: the healthy pane's Pine studies had ids "Uqd28X" and "rExi1w",
 * the broken pane's had []. The empty Array means the study never registered
 * with the server, and such a study destroys its pane's chart session on the
 * next reconnect. It is reported here so the caller is warned, not so it can be
 * worked around. See core/session_health.js.
 *
 * The original note, still true, follows.
 *
 * Measured 2026-08-21 against TradingView Desktop: getAllStudies() gives
 * built-ins a string id ("T4x6LH") and gives every Pine study its own distinct
 * empty Array. getStudyById resolves that by reference identity, so a fresh []
 * throws "There is no such study". Serializing it over CDP is the same as
 * throwing it away. Four tools take an entity_id string, so every one of them
 * was unreachable for a Pine study, and the caller was told the id was []
 * rather than told why.
 *
 * getState now reports null for those, says the study is addressable by name,
 * and returns the script id from metaInfo so it is at least identifiable.
 * See _study_ref.js for the resolver the write paths use.
 *
 * The explanation lives out here rather than inside the template literal below:
 * everything in that literal is shipped to the browser on every single call,
 * and this comment alone was 700 bytes of prose per evaluate.
 */
export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        // See the note above getState(): a Pine study's id does not survive
        // serialization, so it is reported as null with a name to use instead.
        var dsByDesc = {};
        try {
          var srcs = chart._chartWidget.model().model().dataSources();
          for (var d = 0; d < srcs.length; d++) {
            try {
              var mi = srcs[d].metaInfo && srcs[d].metaInfo();
              if (mi && mi.description) dsByDesc[mi.description] = mi;
            } catch (e2) {}
          }
        } catch (e2) {}
        studies = allStudies.map(function(s) {
          var usable = (typeof s.id === 'string' && s.id.length > 0);
          var name = s.name || s.title || 'unknown';
          var out = { id: usable ? s.id : null, name: name };
          if (!usable) {
            out.addressable_by = 'name';
            out.id_note = 'This study has NO server id, which means it never finished registering. It will ' +
              'destroy this pane\\'s data session on the next reconnect. Run tv_repair_chart. Until then it ' +
              'can only be addressed by name.';
            var mi2 = dsByDesc[name];
            if (mi2 && mi2.id) out.script_id = String(mi2.id);
          }
          return out;
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        // BOTH SPELLINGS, DELIBERATELY. This field shipped as chartType
        // while symbol_info returns the same value as chart_type, and
        // chart_set_type takes chart_type as its argument. One value, three
        // places, two names, so an agent that learns the name here reads
        // undefined everywhere else. snake_case is canonical; the camelCase
        // key stays so existing callers do not break.
        // (No backticks in this comment: it lives inside a template literal.)
        chart_type: chart.chartType(),
        chartType: chart.chartType(),
        studies: studies,
        // A BROKEN PANE LOOKS EXACTLY LIKE A WORKING ONE FROM UP HERE.
        // symbol() and the study list keep answering while the pane's data
        // session is dead and it loops on reconnect forever. Report the
        // session so the caller is told rather than left guessing.
        _session: (function() {
          try {
            var w = chart._chartWidget;
            var cs = w && w._chartSession;
            var ms = w.model().model().mainSeries();
            var resolved = true;
            try { resolved = ms.symbolInfo() !== null; } catch (e) { resolved = false; }
            return {
              id: cs ? String(cs._sessionId || '') : '',
              state: cs ? cs._state : null,
              resolved: resolved
            };
          } catch (e) { return null; }
        })(),
      };
    })()
  `);
  const { _session, ...rest } = state || {};
  const out = { success: true, ...rest };

  // Surface the failure that otherwise costs someone their whole layout.
  const broken = [];
  const poisoned = (out.studies || []).filter((st) => st.id === null && st.addressable_by === 'name');
  const sessionDead = !!_session && !_session.id;
  if (sessionDead) broken.push('this pane has no live data session, so it cannot load bars');
  // An unresolved symbol is transiently normal on every symbol change. It only
  // means damage when there is no session to resolve it with. Reporting it
  // otherwise pushes the caller toward tv_repair_chart, which deletes studies.
  // Same rule as core/session_health.js, so the two cannot disagree.
  if (_session && _session.resolved === false && sessionDead) {
    broken.push(`the symbol ${out.symbol} never resolved, and there is no session to resolve it with`);
  }
  if (poisoned.length > 0) {
    broken.push(
      `${poisoned.length} stud${poisoned.length === 1 ? 'y has' : 'ies have'} no server id ` +
      `(${poisoned.map((st) => JSON.stringify(st.name)).join(', ')}), which kills this pane's ` +
      'session every time it reconnects',
    );
  }
  if (broken.length === 0 && _session && _session.resolved === false) {
    out.chart_health = {
      healthy: true,
      loading: true,
      note: `${out.symbol} has not resolved yet, but this pane has a live session. That is a normal `
        + 'mid-load state, not damage. Re-read in a moment.',
    };
  } else if (broken.length > 0) {
    out.chart_health = {
      healthy: false,
      problems: broken,
      fix: 'This pane cannot recover on its own: re-setting the same symbol is a silent no-op while it ' +
           'is in this state. Run tv_repair_chart to remove the unregistered studies and reconnect. ' +
           'Rebuilding the layout is not necessary.',
    };
  }
  return out;
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  const applied = await evaluateAsync(awaited(
    `${CHART_API}.setSymbol(${safeString(symbol)}, {})`,
  ));
  if (applied && applied.ok === false && applied.reason !== 'timeout') {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `setSymbol(${symbol}) failed: ${applied.error || applied.reason}`,
    );
  }
  const ready = await waitForChartReady(symbol);
  if (!ready) throw new ClassifiedError(CATEGORIES.CHART_LOADING, `Chart did not finish loading symbol ${symbol}`);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  const applied = await evaluateAsync(awaited(
    `${CHART_API}.setResolution(${safeString(timeframe)}, {})`,
  ));
  if (applied && applied.ok === false && applied.reason !== 'timeout') {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `setResolution(${timeframe}) failed: ${applied.error || applied.reason}`,
    );
  }
  const ready = await waitForChartReady(null, timeframe);
  if (!ready) throw new ClassifiedError(CATEGORIES.CHART_LOADING, `Chart did not finish loading timeframe ${timeframe}`);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate, evaluateAsync, sleep } = _resolve(_deps);
  let inputs;
  try {
    inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  } catch (err) {
    // Malformed caller JSON must read as INVALID_ARGUMENT, not the generic
    // api_unexpected ("TradingView returned unexpected shape") it would become
    // after toErrorPayload normalizes a raw SyntaxError.
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `inputs is not valid JSON: ${err.message}`,
      { hint: 'Pass inputs as a JSON object or a JSON-encoded object string, e.g. {"length": 50}.' },
    );
  }

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    // AWAIT createStudy. It returns Promise<EntityId>. Firing it and sleeping
    // 1500ms was a race, and losing that race leaves a study with no server id
    // that destroys the pane's chart session on its next reconnect. See the
    // note above awaited().
    const created = await evaluateAsync(awaited(
      `${CHART_API}.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)})`,
    ));
    if (created && created.ok === false && created.reason !== 'timeout') {
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        `createStudy("${indicator}") failed: ${created.error || created.reason}`,
        { hint: 'Use the FULL indicator name (e.g. "Relative Strength Index", not "RSI").' },
      );
    }
    // USE THE ID THE PROMISE RETURNED, NOT A DIFF OF THE STUDY LIST.
    //
    // createStudy resolves to the EntityId of the study IT created. Diffing
    // getAllStudies() before and after attributes ANY study that registered in
    // the meantime to this call, so a concurrent add elsewhere could make a
    // failed add here report success and leave the unregistered study behind.
    // The returned id is the only value that is about this call.
    //
    // The list diff stays as a fallback for the case where the promise
    // resolved without a usable value, and it is reported as a fallback.
    await sleep(250);
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const returnedId = (created && typeof created.value === 'string' && created.value.length > 0)
      ? created.value : null;
    const listDiff = (after || []).filter(id => !(before || []).includes(id));
    // A returned id must also be a study that is really on the chart. If
    // createStudy handed back an id the chart does not have, that is not a
    // success either.
    const returnedIsPresent = returnedId !== null && (after || []).includes(returnedId);
    const newIds = returnedIsPresent ? [returnedId] : listDiff;
    if (newIds.length === 0) {
      // Old behavior returned { success:false } with no category/hint, which an
      // agent can't act on — and a slow add that actually succeeded after the
      // settle window looked identical to a wrong indicator name, leading to
      // duplicate re-adds. Surface a categorized, actionable error instead.
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        `Indicator "${indicator}" did not appear on the chart after add.`,
        { hint: 'Use the FULL indicator name (e.g. "Relative Strength Index", not "RSI"). If the name is correct, the add may have exceeded the settle window — re-check chart_get_state before retrying so you do not add a duplicate.' },
      );
    }
    // NEVER LEAVE A LANDMINE.
    //
    // A study whose id is not a usable string never registered with the server.
    // It looks fine on screen and it will kill this pane's chart session the
    // next time the pane reconnects, at which point the pane loops forever and
    // the operator ends up rebuilding the layout. Reporting
    // `entity_id: []` and success, which is what this did, is the worst
    // outcome: the damage is deferred and untraceable.
    //
    // Take it back out and say so.
    const usable = newIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (usable.length === 0) {
      const cleanup = await evaluate(`
        (function() {
          try {
            var mm = ${CHART_API}._chartWidget.model().model();
            var srcs = mm.dataSources();
            for (var i = srcs.length - 1; i >= 0; i--) {
              try {
                var mi = srcs[i].metaInfo && srcs[i].metaInfo();
                if (!mi || String(mi.description) !== ${safeString(indicator)}) continue;
                var idv = null;
                try { idv = (typeof srcs[i].id === 'function') ? srcs[i].id() : null; } catch (e) {}
                if (typeof idv === 'string' && idv.length > 0) continue;
                mm.removeSource(srcs[i]);
                return { removed: true };
              } catch (e) {}
            }
            return { removed: false };
          } catch (e) { return { removed: false, error: e.message }; }
        })()
      `);
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        `"${indicator}" was added to the chart but TradingView never gave it a server id, ` +
        'so it would have destroyed this pane\'s data session on the next reconnect. ' +
        `It has been ${cleanup && cleanup.removed ? 'removed again' : 'LEFT ON THE CHART because it could not be removed'}.`,
        {
          hint: cleanup && cleanup.removed
            ? 'Retry the add. If it keeps happening, the chart session is probably already unhealthy: run tv_chart_health.'
            : 'Run tv_repair_chart to remove it before the pane reconnects.',
        },
      );
    }
    return {
      success: true,
      action: 'add',
      indicator,
      entity_id: usable[0],
      new_study_count: usable.length,
      // Say which evidence this rests on. An id straight from createStudy is
      // about this call; a list diff is an inference that a concurrent add
      // could have poisoned.
      id_source: returnedIsPresent ? 'createStudy_return' : 'study_list_diff',
      ...(returnedIsPresent ? {} : {
        id_note: 'createStudy did not return a usable id, so this id comes from comparing the study '
          + 'list before and after. If another study registered during the call, this could name the '
          + 'wrong one. Confirm with chart_get_state if it matters.',
      }),
    };
  } else if (action === 'remove') {
    if (!entity_id) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id required for remove action. Use chart_get_state to find study IDs.');
    // REMOVE USED TO RETURN A HARDCODED SUCCESS. It called removeEntity() and
    // said `success: true` without looking, so a typo'd id, a Pine study whose
    // id cannot be serialized, or a throw inside the page all reported the same
    // thing as a real removal. Count before, count after, and say which study
    // actually went.
    const removal = await evaluate(`
      (function() {
        var chart = ${CHART_API};
        ${STUDY_RESOLVER_JS()}
        var before = chart.getAllStudies().length;
        var r = __tvResolveStudy(chart, ${safeString(entity_id)});
        if (r.error) return { error: r.error };
        var name = r.resolved_name;
        try { chart.removeEntity(r.handle); } catch (e) { return { error: 'removeEntity threw: ' + e.message }; }
        var after = chart.getAllStudies().length;
        return { before: before, after: after, removed_name: name };
      })()
    `);
    if (!removal) {
      throw new ClassifiedError(CATEGORIES.API_UNEXPECTED,
        `Could not confirm removal of ${entity_id}: the page returned nothing.`);
    }
    if (removal.error) {
      throw new ClassifiedError(
        /no study matched/i.test(removal.error) ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED,
        removal.error);
    }
    if (removal.after >= removal.before) {
      throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED,
        `removeEntity was called for "${removal.removed_name}" but the chart still has ${removal.after} studies (was ${removal.before}). Nothing was removed.`);
    }
    return {
      success: true,
      action: 'remove',
      entity_id,
      removed_name: removal.removed_name,
      study_count_before: removal.before,
      study_count_after: removal.after,
    };
  } else {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'action must be "add" or "remove"');
  }
}

export async function getVisibleRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate, sleep } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  if (f >= t) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'from must be earlier than to');

  const history = { requests: 0, earliest_loaded: null, reached_from: false, exhausted: false };
  for (let attempt = 0; attempt < 25; attempt++) {
    const state = await evaluate(`
      (function() {
        var series = ${CHART_API}._chartWidget.model().mainSeries();
        var bars = series.bars();
        var first = bars.valueAt(bars.firstIndex());
        var more = true;
        try { more = series.requestMoreDataAvailable(); } catch (e) {}
        return { firstTime: first && first[0], more: more };
      })()
    `);
    history.earliest_loaded = state?.firstTime ?? history.earliest_loaded;
    if (state?.firstTime != null && state.firstTime <= f) {
      history.reached_from = true;
      break;
    }
    if (!state?.more) {
      history.exhausted = true;
      break;
    }
    await evaluate(`
      (function() {
        try { ${CHART_API}._chartWidget.model().mainSeries().requestMoreData(1000); return true; }
        catch (e) { return false; }
      })()
    `);
    history.requests += 1;
    await sleep(1800);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await sleep(500);
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  const actualRange = actual || { from: 0, to: 0 };
  const complete = !!actualRange.from && actualRange.from <= f;
  return {
    success: true,
    complete,
    requested: { from: f, to: t },
    actual: actualRange,
    history,
    ...(complete ? {} : { note: 'TradingView could not load the entire requested range; actual shows the range that was available.' }),
  };
}

export async function scrollToDate({ date, _deps }) {
  const { evaluate, sleep } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await sleep(500);
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type, _deps }) {
  const { fetch } = _resolve(_deps);
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  let resp;
  try {
    resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
      headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
      signal: globalThis.AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView symbol search failed: ${err?.name === 'TimeoutError' ? 'timed out after 10000ms' : err.message}`,
      { cause: err, hint: 'Check network access to symbol-search.tradingview.com and retry.' },
    );
  }
  if (!resp.ok) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
