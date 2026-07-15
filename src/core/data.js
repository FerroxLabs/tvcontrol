/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { waitForChartReady } from '../wait.js';
import * as ui from './ui.js';
import { strictResolve } from './_resolve.js';

const _DATA_DEPS = new Set(['evaluate', 'evaluateAsync', 'openPanel', 'wait', 'waitForChartReady']);

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const roundPrice = (value) => (value == null ? null : Math.round(value * 1e8) / 1e8);
// Cap the equity-curve payload. A 1m-over-a-year backtest produces hundreds of
// thousands of points; serializing that across CDP (returnByValue) can breach
// V8 string limits / max payload and OOM the Node process. Downsample to at
// most this many points (the final point is always preserved exactly).
const MAX_EQUITY_BARS = 5000;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;
let _quoteLock = Promise.resolve();

// Shared page-context strategy resolver. TradingView strategies are identified
// by explicit strategy metadata or their reportData API. In particular,
// is_price_study is not a reliable discriminator on current Desktop builds.
const FIND_STRATEGY_JS = `
  function _strategyIdOf(s) {
    try {
      var id = typeof s.id === 'function' ? s.id() : (s.id || s._id);
      return id === null || id === undefined ? null : String(id);
    } catch (e) { return null; }
  }
  function _reportOf(s) {
    try {
      var rd = s.reportData();
      if (rd && typeof rd.value === 'function') rd = rd.value();
      return rd;
    } catch (e) { return null; }
  }
  function findStrategies() {
    var chart = ${CHART_API}._chartWidget;
    var sources = chart.model().model().dataSources();
    var strategies = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], mi = null;
      try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
      var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy);
      if ((isStrat || typeof s.reportData === 'function') && typeof s.reportData === 'function') {
        strategies.push({ s: s, id: _strategyIdOf(s), name: mi ? (mi.description || mi.shortDescription) : null });
      }
    }
    return strategies;
  }
  function findStrategy(requestedId) {
    var strategies = findStrategies();
    if (requestedId) {
      for (var i = 0; i < strategies.length; i++) {
        if (strategies[i].id === String(requestedId)) {
          return {
            strat: strategies[i].s,
            report: _reportOf(strategies[i].s),
            id: strategies[i].id,
            name: strategies[i].name,
            strategy_count: strategies.length
          };
        }
      }
      return null;
    }
    for (var j = 0; j < strategies.length; j++) {
      var rd = _reportOf(strategies[j].s);
      if (rd && rd.performance) {
        return { strat: strategies[j].s, report: rd, id: strategies[j].id, name: strategies[j].name, strategy_count: strategies.length };
      }
    }
    if (strategies.length) {
      return { strat: strategies[0].s, report: null, id: strategies[0].id, name: strategies[0].name, strategy_count: strategies.length };
    }
    return null;
  }
  function unhideStrategies(requestedId) {
    var unhidden = [];
    var strategies = findStrategies();
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i].s;
      if (requestedId && strategies[i].id !== String(requestedId)) continue;
      try {
        var visible = null;
        try { visible = s.properties().visible.value(); } catch (e) {}
        if (visible !== false) continue;
        var done = false;
        try { s.properties().visible.setValue(true); done = true; } catch (e) {}
        if (!done) {
          try {
            var id = typeof s.id === 'function' ? s.id() : s.id;
            var st = ${CHART_API}.getStudyById(id);
            if (st) { st.setVisible(true); done = true; }
          } catch (e) {}
        }
        if (done) unhidden.push(strategies[i].name || 'strategy');
      } catch (e) {}
    }
    return unhidden;
  }
`;

// Allowlist of (collectionName, mapKey) pairs known to TradingView's internal
// _primitivesCollection. Both values are interpolated raw into the evaluate
// string for property access (`pc.${collectionName}` etc.) so any new value
// MUST be reviewed and added here. Defense-in-depth allowlist.
const ALLOWED_GRAPHICS_COLLECTIONS = Object.freeze({
  dwglines:       new Set(['lines']),
  dwglabels:      new Set(['labels']),
  dwgtablecells:  new Set(['tableCells']),
  dwgboxes:       new Set(['boxes']),
});

function buildGraphicsJS(collectionName, mapKey, filter) {
  const allowedKeys = ALLOWED_GRAPHICS_COLLECTIONS[collectionName];
  if (!allowedKeys || !allowedKeys.has(mapKey)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `buildGraphicsJS: (collectionName, mapKey) not in allowlist: (${collectionName}, ${mapKey})`,
      { hint: `Allowed: ${JSON.stringify(Object.fromEntries(Object.entries(ALLOWED_GRAPHICS_COLLECTIONS).map(([k, v]) => [k, [...v]])))}` },
    );
  }
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new ClassifiedError(CATEGORIES.CHART_LOADING, 'Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
      // Guard the divisor: first.open can legitimately be 0 (some synthetic /
      // crypto instruments) or absent, which would otherwise yield "Infinity%"
      // or "NaN%" and poison any consumer (e.g. chart_vision_read) that parses
      // the field as a number.
      change_pct: first.open ? Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%' : 'N/A',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

function _resolve(deps) {
  strictResolve(deps, _DATA_DEPS);
  return {
    evaluate,
    evaluateAsync,
    openPanel: ui.openPanel,
    wait: (ms) => new Promise(r => setTimeout(r, ms)),
    waitForChartReady,
    ...deps,
  };
}

export async function getIndicator({ entity_id, _deps } = {}) {
  const deps = _resolve(_deps);

  const data = await deps.evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) {
    const isStudyMissing = /not found/i.test(String(data.error));
    throw new ClassifiedError(
      isStudyMissing ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED,
      data.error,
    );
  }

  let inputs = data?.inputs;
  let hadEncrypted = false;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) { hadEncrypted = true; return false; }
      return true;
    });
  }

  if (!hadEncrypted) {
    return { success: true, entity_id, visible: data?.visible, inputs, source: 'api' };
  }

  // Encrypted inputs detected — fall back to DOM Data Window scrape.
  // Restore the panel to its prior state when we leave (don't surprise the user
  // with a Data Window panel they didn't open themselves).
  const openResult = await deps.openPanel({ panel: 'data-window', action: 'open' });
  const openedBy_us = openResult?.was_open === false;
  await deps.wait(300);

  try {
    const domValues = await deps.evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="data-window"]');
        if (!panel) return null;
        var rows = panel.querySelectorAll('.data-window-row, [class*="row"]');
        var out = {};
        for (var i = 0; i < rows.length; i++) {
          var title = rows[i].querySelector('.data-window-title, [class*="title"]');
          var value = rows[i].querySelector('.data-window-value, [class*="value"]');
          if (title && value) {
            out[title.textContent.trim()] = value.textContent.trim();
          }
        }
        return out;
      })()
    `);

    if (domValues === null || domValues === undefined) {
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        'Data Window panel not accessible',
        { hint: 'Open Data Window manually or file an issue' },
      );
    }

    return { success: true, entity_id, visible: data?.visible, inputs, source: 'dom_fallback', dom_values: domValues };
  } finally {
    if (openedBy_us) {
      try { await deps.openPanel({ panel: 'data-window', action: 'close' }); } catch (_) { /* best effort */ }
    }
  }
}

async function _readStrategyReportData(deps, entityId) {
  return await deps.evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var requestedId = ${safeString(entityId || '')};
        var found = findStrategy(requestedId);
        if (!found) return {metrics: {}, source: 'internal_api', error: requestedId ? 'Requested strategy not found on chart: ' + requestedId : 'No strategy found on chart. Add a strategy indicator first.', hasStrategy: false};
        var metrics = {};
        try {
          var rd = found.report;
          if (rd && typeof rd === 'object') {
            var perf = rd.performance && rd.performance.all;
            if (perf && typeof perf === 'object') {
              var pkeys = Object.keys(perf);
              for (var p = 0; p < pkeys.length; p++) {
                var pval = perf[pkeys[p]];
                if (pval !== null && pval !== undefined && typeof pval !== 'function' && typeof pval !== 'object') {
                  metrics[pkeys[p]] = pval;
                }
              }
            }
            if (rd.buyHoldPercent && Array.isArray(rd.buyHoldPercent) && rd.buyHoldPercent.length) {
              metrics.buyHoldFinalPercent = rd.buyHoldPercent[rd.buyHoldPercent.length - 1];
            }
            if (Array.isArray(rd.filledOrders)) metrics.filledOrderCount = rd.filledOrders.length;
            if (Array.isArray(rd.trades)) metrics.tradeCount = rd.trades.length;
            if (rd.currency) metrics.currency = rd.currency;
          }
        } catch(e) { return {metrics: {}, source: 'internal_api', error: 'reportData read failed: ' + e.message, hasStrategy: true}; }
        return {metrics: metrics, source: 'internal_api', hasStrategy: true, entity_id: found.id, strategy: found.name, strategy_count: found.strategy_count};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message, hasStrategy: false}; }
    })()
  `);
}

async function _ensureStrategyTesterReady(deps, entityId, maxWaitMs = 6000) {
  const unhidden = await deps.evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      var requestedId = ${safeString(entityId || '')};
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
      return unhideStrategies(requestedId);
    })()
  `);
  const deadline = Date.now() + maxWaitMs;
  let status = 'timeout';
  while (Date.now() < deadline) {
    const ready = await deps.evaluate(`
      (function() {
        ${FIND_STRATEGY_JS}
        var requestedId = ${safeString(entityId || '')};
        var found = findStrategy(requestedId);
        if (!found) return 'no-strategy';
        return found.report && found.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (ready === 'ready' || ready === 'no-strategy') {
      status = ready;
      break;
    }
    await deps.wait(500);
  }
  return { status, unhidden: unhidden || [] };
}

export async function getStrategyResults({ entity_id, _deps } = {}) {
  const deps = _resolve(_deps);
  const ready = await _ensureStrategyTesterReady(deps, entity_id);
  let results = await _readStrategyReportData(deps, entity_id);
  const metricCount = Object.keys(results?.metrics || {}).length;

  // Auto-open the Strategy Tester panel and retry when we found a strategy
  // but got empty metrics — TradingView only computes reportData when the
  // panel is active. The previous behaviour silently returned count:0 and
  // callers (notably strategy_sweep) would think every combo was zero-PnL.
  if (results?.hasStrategy && metricCount === 0 && !results.error) {
    try {
      await deps.openPanel({ panel: 'strategy-tester', action: 'open' });
      await deps.wait(2000);
      results = await _readStrategyReportData(deps, entity_id);
    } catch (_) { /* fall through; we'll surface the empty-metrics path below */ }
  }

  if (results?.error) {
    const isUserState = /no strategy found|requested strategy not found/i.test(results.error);
    throw new ClassifiedError(
      isUserState ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED,
      results.error,
      isUserState ? { hint: 'Add a strategy indicator (chart_manage_indicator) before calling getStrategyResults.' } : undefined,
    );
  }

  const finalCount = Object.keys(results?.metrics || {}).length;
  if (results?.hasStrategy && finalCount === 0) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Strategy found but backtest metrics are empty',
      {
        hint: 'TradingView computes backtest data only when the Strategy Tester panel has been activated this session. Open it manually (or via ui_open_panel({panel: "strategy-tester", action: "open"})) and retry.',
      },
    );
  }

  return {
    success: true,
    count: finalCount,
    source: results?.source,
    entity_id: results?.entity_id,
    strategy: results?.strategy,
    strategy_count: results?.strategy_count,
    metrics: results?.metrics || {},
    ...(ready.unhidden.length > 0 && { unhidden_strategies: ready.unhidden }),
  };
}

export async function getTrades({ max_trades, entity_id, _deps } = {}) {
  const deps = _resolve(_deps);
  const limit = max_trades == null ? MAX_TRADES : Number(max_trades);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRADES) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `max_trades must be an integer from 1 to ${MAX_TRADES}.`,
    );
  }
  const ready = await _ensureStrategyTesterReady(deps, entity_id);
  const trades = await deps.evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var requestedId = ${safeString(entity_id || '')};
        var found = findStrategy(requestedId);
        if (!found) return {trades: [], source: 'internal_api', error: requestedId ? 'Requested strategy not found on chart: ' + requestedId : 'No strategy found on chart.'};
        var strat = found.strat;
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'ordersData() returned non-array.'};
        var result = [];
        var start = Math.max(0, orders.length - ${limit});
        for (var t = start; t < orders.length; t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) { var v = o[okeys[k]]; if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') trade[okeys[k]] = v; }
            result.push(trade);
          }
        }
        return {trades: result, total_orders: orders.length, entity_id: found.id, strategy: found.name, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  if (trades?.error) {
    // Old contract returned success:true with an embedded `error`, which is
    // indistinguishable from a legitimately flat backtest. Throw so the caller
    // gets a categorized failure (matching getStrategyResults).
    const noStrategy = /no strategy|requested strategy not found/i.test(trades.error);
    throw new ClassifiedError(
      noStrategy ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED,
      `getTrades: ${trades.error}`,
      noStrategy ? { hint: 'Load a strategy and open the Strategy Tester panel (ui_open_panel({panel:"strategy-tester", action:"open"})), then retry.' } : undefined,
    );
  }
  return {
    success: true,
    count: trades?.trades?.length || 0,
    total_orders: trades?.total_orders ?? 0,
    entity_id: trades?.entity_id,
    strategy: trades?.strategy,
    source: trades?.source,
    trades: trades?.trades || [],
    ...(ready.unhidden.length > 0 && { unhidden_strategies: ready.unhidden }),
  };
}

export async function getEquity({ entity_id, _deps } = {}) {
  const deps = _resolve(_deps);
  const ready = await _ensureStrategyTesterReady(deps, entity_id);
  const equity = await deps.evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var requestedId = ${safeString(entity_id || '')};
        var found = findStrategy(requestedId);
        if (!found) return {data: [], source: 'internal_api', error: requestedId ? 'Requested strategy not found on chart: ' + requestedId : 'No strategy found on chart.'};
        var strat = found.strat;
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) {
            if (eq.length > ${MAX_EQUITY_BARS}) {
              var stride0 = Math.ceil(eq.length / ${MAX_EQUITY_BARS});
              for (var ei = 0; ei < eq.length; ei += stride0) data.push(eq[ei]);
              if (data[data.length-1] !== eq[eq.length-1]) data.push(eq[eq.length-1]);
            } else { data = eq; }
          }
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            // Downsample with a stride instead of pushing every bar — an
            // unbounded firstIndex..lastIndex walk is the OOM/payload risk.
            var total = end - start + 1;
            var stride = total > ${MAX_EQUITY_BARS} ? Math.ceil(total / ${MAX_EQUITY_BARS}) : 1;
            for (var i = start; i <= end; i += stride) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
            if (stride > 1) { var vl = bars.valueAt(end); if (vl) data.push({time: vl[0], equity: vl[1], drawdown: vl[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, entity_id: found.id, strategy: found.name, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, entity_id: found.id, strategy: found.name, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  if (equity?.error) {
    const noStrategy = /no strategy|requested strategy not found/i.test(equity.error);
    throw new ClassifiedError(
      noStrategy ? CATEGORIES.STUDY_NOT_FOUND : CATEGORIES.API_UNEXPECTED,
      `getEquity: ${equity.error}`,
      noStrategy ? { hint: 'Load a strategy and open the Strategy Tester panel (ui_open_panel({panel:"strategy-tester", action:"open"})), then retry.' } : undefined,
    );
  }
  const hasData = (equity?.data?.length || 0) > 0;
  const hasSummary = !!(equity?.equity_summary && Object.keys(equity.equity_summary).length > 0);
  return {
    success: hasData || hasSummary,
    complete: hasData,
    data_points: equity?.data?.length || 0,
    entity_id: equity?.entity_id,
    strategy: equity?.strategy,
    source: equity?.source,
    data: equity?.data || [],
    equity_summary: equity?.equity_summary,
    note: equity?.note || (!hasData ? 'No equity curve was exposed for the selected strategy.' : undefined),
    ...(ready.unhidden.length > 0 && { unhidden_strategies: ready.unhidden }),
  };
}

export async function getQuote({ symbol, _deps } = {}) {
  const deps = _resolve(_deps);
  const run = _quoteLock.then(() => _getQuoteInternal({ symbol, deps }));
  _quoteLock = run.then(() => {}, () => {});
  return run;
}

async function _getQuoteInternal({ symbol, deps }) {
  const requested = String(symbol || '').trim();
  let originalSymbol = null;
  let needsRestore = false;
  let quoteResult;
  let operationError = null;
  let restoreError = null;

  try {
    if (requested) {
      try { originalSymbol = await deps.evaluate(`${CHART_API}.symbol()`); } catch (_) { /* classified below */ }
      if (!originalSymbol || typeof originalSymbol !== 'string') {
        throw new ClassifiedError(
          CATEGORIES.CHART_LOADING,
          'Cannot switch quote symbols because the starting chart symbol could not be captured',
        );
      }
      const normalize = (value) => String(value).trim().toUpperCase();
      const originalFull = normalize(originalSymbol);
      const requestedFull = normalize(requested);
      const bothQualified = originalFull.includes(':') && requestedFull.includes(':');
      const sameSymbol = originalFull === requestedFull
        || (!bothQualified && originalFull.split(':').pop() === requestedFull.split(':').pop());
      if (!sameSymbol) {
        needsRestore = true;
        await deps.evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(requested)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        const ready = await deps.waitForChartReady(requested);
        if (!ready) throw new ClassifiedError(CATEGORIES.CHART_LOADING, `Quote symbol ${requested} did not finish loading`);
      }
    }

    const data = await deps.evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) { var bidV = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(bidV)) quote.bid = bidV; }
          if (askEl) { var askV = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(askV)) quote.ask = askV; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close)) {
      throw new ClassifiedError(CATEGORIES.CHART_LOADING, 'Could not retrieve quote. The chart may still be loading.');
    }
    quoteResult = { success: true, ...data };
  } catch (err) {
    operationError = err;
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await deps.evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        const restored = await deps.waitForChartReady(originalSymbol);
        if (!restored) {
          throw new ClassifiedError(
            CATEGORIES.CHART_LOADING,
            `Original quote symbol ${originalSymbol} did not finish restoring`,
          );
        }
      } catch (err) {
        restoreError = { error: err.message, category: err.category || CATEGORIES.API_UNEXPECTED };
      }
    }
  }
  if (operationError) {
    if (restoreError) {
      throw new ClassifiedError(
        CATEGORIES.API_UNEXPECTED,
        `${operationError.message}; chart restoration also failed: ${restoreError.error}`,
        {
          cause: operationError,
          hint: 'The quote operation failed and the starting chart could not be restored. Verify the active symbol before continuing.',
        },
      );
    }
    throw operationError;
  }
  return {
    ...quoteResult,
    ...(needsRestore ? { restored_start_state: !restoreError } : {}),
    ...(restoreError ? { restore_error: restoreError } : {}),
  };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) {
    throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, data?.error || 'DOM panel not found.');
  }
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues({ _deps } = {}) {
  const deps = _resolve(_deps);
  const data = await deps.evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          var entityId = null;
          var inputs = [];
          try { entityId = typeof s.id === 'function' ? s.id() : (s.id || null); } catch(e) {}
          try {
            var rawInputs = typeof s.getInputValues === 'function' ? s.getInputValues() : [];
            if (Array.isArray(rawInputs)) {
              for (var ri = 0; ri < rawInputs.length; ri++) {
                var input = rawInputs[ri];
                if (!input || !input.id) continue;
                if (typeof input.value === 'string' && input.value.length > 500) continue;
                inputs.push({ id: input.id, value: input.value });
              }
            }
          } catch(e) {}
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ entity_id: entityId, name: name, inputs: inputs, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = roundPrice(v.y);
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, count: 0, studies: [] };

  const studies = raw.map(s => {
    // Null-proto containers: tid/row/col come from page-supplied indicator
    // data. A malicious study naming a row/col "__proto__" would otherwise walk
    // the prototype chain on the assignment below and pollute Object.prototype.
    // Object.create(null) has no prototype to poison.
    const tables = Object.create(null);
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = Object.create(null);
      if (!tables[tid][v.row]) tables[tid][v.row] = Object.create(null);
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low = v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, count: studies.length, studies };
}
