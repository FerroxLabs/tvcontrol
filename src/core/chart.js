/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
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

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
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
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  if (!ready) throw new ClassifiedError(CATEGORIES.CHART_LOADING, `Chart did not finish loading symbol ${symbol}`);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
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
  const { evaluate, sleep } = _resolve(_deps);
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
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await sleep(1500);
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
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
    return { success: true, action: 'add', indicator, entity_id: newIds[0], new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
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
