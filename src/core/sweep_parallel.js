/**
 * Parallel strategy_sweep: distribute combos across N worker tabs.
 *
 * Why this exists: TradingView's backtest is single-threaded per chart and
 * CPU-bound. A 36-combo sweep through one chart takes ~17 minutes. Spawning
 * helper tabs and running ⌈total/N⌉ combos per worker drops wall time
 * roughly proportionally — capped by CPU saturation around 3-4 workers
 * on a single machine.
 *
 * Each worker:
 *   - Owns a dedicated CDP WebSocket (separate from the singleton in
 *     connection.js — workers must not pollute the user's active-tab
 *     persistence file).
 *   - Loads the same published Pine strategy as the master via the
 *     metaInfo injection path landed in commit c6f8e3d.
 *   - Runs its assigned combos serially with the same setSymbol →
 *     setTimeframe → setInputs → settle → readReportData sequence as
 *     the single-chart sweep, but using its own session.
 *
 * Cleanup: spawned tabs are closed via /json/close/<id> on completion
 * (best-effort; failures recorded in cleanup_warnings).
 */
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * Open a fresh TradingView chart tab and return its CDP target descriptor.
 * Uses /json/new which is the documented Chrome DevTools way to open a
 * new tab — Electron supports it for non-incognito contexts.
 */
async function _spawnTab() {
  // Encode the URL so the query parser doesn't fight us.
  const url = encodeURIComponent('https://www.tradingview.com/chart/');
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new?${url}`, { method: 'PUT' });
  if (!resp.ok) {
    // Some Chrome builds want POST; try once.
    const resp2 = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new?${url}`);
    if (!resp2.ok) throw new Error(`Failed to spawn tab: HTTP ${resp.status}`);
    return await resp2.json();
  }
  return await resp.json();
}

async function _closeTab(targetId) {
  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${targetId}`);
  } catch (_) { /* best-effort */ }
}

class SweepWorker {
  constructor({ id, target_id, ws_url }) {
    this.id = id;
    this.target_id = target_id;
    this.ws_url = ws_url;
    this.cdp = null;
    this.error = null;
  }

  async connect() {
    this.cdp = await CDP({ host: CDP_HOST, port: CDP_PORT, target: this.target_id });
    await this.cdp.Runtime.enable();
    await this.cdp.Page.enable();
    await this.cdp.DOM.enable();
  }

  async evaluate(expression, opts = {}) {
    const result = await this.cdp.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
    });
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'evaluation error';
      throw new Error(`worker ${this.id}: ${msg}`);
    }
    return result.result?.value;
  }

  /** Wait for window.TradingViewApi._activeChartWidgetWV.value() to exist. */
  async waitForChartApiReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = await this.evaluate(`
        (function() {
          try {
            var v = window.TradingViewApi
              && window.TradingViewApi._activeChartWidgetWV
              && window.TradingViewApi._activeChartWidgetWV.value
              && window.TradingViewApi._activeChartWidgetWV.value();
            return !!v;
          } catch(e) { return false; }
        })()
      `);
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`worker ${this.id}: chart API not ready after ${timeoutMs}ms`);
  }

  /**
   * Inject the master's published Pine onto this worker's chart by
   * replaying the captured metaInfo. Mirrors injectPublishedStudy in
   * state.js but runs against this worker's own CDP session so the
   * helper's singleton-evaluate isn't reused.
   */
  async injectStrategy({ metaInfo, inputs }) {
    const metaJson = JSON.stringify(metaInfo);
    const inputsJson = JSON.stringify(inputs || {});
    const result = await this.evaluate(`
      (async function() {
        try {
          var cw = window.TradingViewApi._activeChartWidgetWV.value();
          var meta = ${metaJson};
          var inputs = ${inputsJson};
          var sources = function() { try { return cw._chartWidget.model().model().dataSources().length; } catch(e) { return 0; } };
          var before = sources();
          var settle = function(ms) { return new Promise(function(r){ setTimeout(r, ms); }); };
          try { await cw.createStudy(meta); await settle(800); if (sources() > before) return { success: true, method: 'createStudy' }; } catch(e) {}
          try { var ret = cw._chartWidget.insertStudy(meta, []); if (ret && typeof ret.then === 'function') await ret; await settle(800); if (sources() > before) return { success: true, method: 'insertStudy' }; } catch(e) {}
          try { cw.insertStudyWithoutCheck(meta, inputs, false, [], null); await settle(800); if (sources() > before) return { success: true, method: 'insertStudyWithoutCheck' }; } catch(e) {}
          return { success: false, sources_before: before, sources_after: sources() };
        } catch(e) { return { success: false, reason: 'eval_error', error: e.message }; }
      })()
    `, { awaitPromise: true });
    return result || { success: false, reason: 'no_result' };
  }

  /** Find this worker's strategy entity_id (the only source with reportData). */
  async resolveStrategyEntityId() {
    return await this.evaluate(`
      (function() {
        try {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          for (var i = 0; i < sources.length; i++) {
            if (typeof sources[i].reportData === 'function') {
              var s = sources[i];
              return (typeof s.id === 'function' ? s.id() : s._id) || null;
            }
          }
          return null;
        } catch(e) { return null; }
      })()
    `);
  }

  async setSymbol(symbol) {
    return await this.evaluate(`
      window.TradingViewApi._activeChartWidgetWV.value().setSymbol(${JSON.stringify(symbol)})
    `);
  }

  async setTimeframe(timeframe) {
    return await this.evaluate(`
      window.TradingViewApi._activeChartWidgetWV.value().setResolution(${JSON.stringify(String(timeframe))})
    `);
  }

  async setInputs(entityId, inputs) {
    const expr = `
      (function() {
        try {
          var cw = window.TradingViewApi._activeChartWidgetWV.value();
          var study = cw.getStudyById(${JSON.stringify(entityId)});
          if (!study) return { ok: false, reason: 'study_not_found' };
          study.setInputValues(${JSON.stringify(Object.entries(inputs).map(([id, value]) => ({ id, value })))});
          return { ok: true };
        } catch(e) { return { ok: false, error: e.message }; }
      })()
    `;
    const result = await this.evaluate(expr);
    if (!result?.ok) throw new Error(`setInputs failed: ${JSON.stringify(result)}`);
  }

  async readMetrics() {
    return await this.evaluate(`
      (function() {
        try {
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          var strat = null;
          for (var i = 0; i < sources.length; i++) {
            if (typeof sources[i].reportData === 'function') { strat = sources[i]; break; }
          }
          if (!strat) return { metrics: {}, error: 'no_strategy' };
          var rd = strat.reportData();
          if (!rd || typeof rd !== 'object') return { metrics: {} };
          var metrics = {};
          var perf = rd.performance && rd.performance.all;
          if (perf && typeof perf === 'object') {
            for (var k of Object.keys(perf)) {
              var v = perf[k];
              if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') metrics[k] = v;
            }
          }
          if (rd.buyHoldPercent && Array.isArray(rd.buyHoldPercent) && rd.buyHoldPercent.length) metrics.buyHoldFinalPercent = rd.buyHoldPercent[rd.buyHoldPercent.length - 1];
          if (Array.isArray(rd.filledOrders)) metrics.filledOrderCount = rd.filledOrders.length;
          if (Array.isArray(rd.trades)) metrics.tradeCount = rd.trades.length;
          return { metrics: metrics };
        } catch(e) { return { metrics: {}, error: e.message }; }
      })()
    `);
  }

  async runCombo({ combo, entityId, settleMs }) {
    const start = Date.now();
    try {
      await this.setSymbol(combo.symbol);
      if (combo.timeframe) await this.setTimeframe(combo.timeframe);
      // Initial settle for chart load.
      await new Promise((r) => setTimeout(r, settleMs));
      if (Object.keys(combo.inputs || {}).length > 0) {
        await this.setInputs(entityId, combo.inputs);
      }
      // Settle for backtest re-compute.
      await new Promise((r) => setTimeout(r, 1000));
      const metricsRes = await this.readMetrics();
      return {
        symbol: combo.symbol,
        timeframe: combo.timeframe,
        inputs: combo.inputs,
        metrics: metricsRes?.metrics || {},
        worker_id: this.id,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      return {
        symbol: combo.symbol,
        timeframe: combo.timeframe,
        inputs: combo.inputs,
        error: err.message,
        worker_id: this.id,
        duration_ms: Date.now() - start,
      };
    }
  }

  async destroy() {
    try { if (this.cdp) await this.cdp.close(); } catch (_) {}
    await _closeTab(this.target_id);
  }
}

/**
 * Run combos across worker tabs in parallel. Returns the same shape as
 * strategySweep so result-aggregation code can treat it uniformly.
 *
 * combos: array of { symbol, timeframe, inputs }
 * metaInfo + entity-source-name: needed so each worker can replay the
 *   strategy onto its fresh tab.
 */
export async function runCombosParallel({
  combos,
  metaInfo,
  base_inputs = {},
  parallelism = 3,
  per_combo_settle_ms = 1500,
}) {
  if (!Array.isArray(combos) || combos.length === 0) {
    return { results: [], cleanup_warnings: [] };
  }
  const N = Math.max(1, Math.min(parallelism, 6, combos.length)); // hard ceiling 6
  const workers = [];
  const cleanup_warnings = [];

  // Spawn N tabs. If any fails, abort and clean up the rest.
  try {
    for (let i = 0; i < N; i++) {
      const target = await _spawnTab();
      const w = new SweepWorker({ id: i, target_id: target.id, ws_url: target.webSocketDebuggerUrl });
      await w.connect();
      workers.push(w);
    }
  } catch (err) {
    for (const w of workers) await w.destroy();
    throw new Error(`Failed to spawn worker pool (${workers.length}/${N}): ${err.message}`);
  }

  // Prep each worker: wait for chart API, inject strategy, resolve entity_id.
  await Promise.all(workers.map(async (w) => {
    try {
      await w.waitForChartApiReady();
      // Set initial symbol/timeframe to whatever the first combo uses, so
      // the subsequent injectStrategy targets a concrete chart state.
      await w.setSymbol(combos[0].symbol);
      if (combos[0].timeframe) await w.setTimeframe(combos[0].timeframe);
      await new Promise((r) => setTimeout(r, 2000));
      const inj = await w.injectStrategy({ metaInfo, inputs: base_inputs });
      if (!inj.success) {
        w.error = `inject failed: ${JSON.stringify(inj)}`;
        return;
      }
      const eid = await w.resolveStrategyEntityId();
      if (!eid) { w.error = 'no entity_id after inject'; return; }
      w.entity_id = eid;
    } catch (err) {
      w.error = `setup error: ${err.message}`;
    }
  }));

  const healthy = workers.filter((w) => !w.error);
  if (healthy.length === 0) {
    const reasons = workers.map((w) => `worker ${w.id}: ${w.error}`);
    for (const w of workers) await w.destroy();
    throw new Error(`All ${N} workers failed setup. ${reasons.join(' | ')}`);
  }

  // Distribute combos round-robin across healthy workers.
  const queues = healthy.map(() => []);
  for (let i = 0; i < combos.length; i++) {
    queues[i % healthy.length].push(combos[i]);
  }

  // Each worker drains its queue serially.
  const results = [];
  await Promise.all(healthy.map(async (w, qIdx) => {
    for (const combo of queues[qIdx]) {
      const r = await w.runCombo({ combo, entityId: w.entity_id, settleMs: per_combo_settle_ms });
      results.push(r);
    }
  }));

  // Note any failed-setup workers.
  for (const w of workers) {
    if (w.error) cleanup_warnings.push({ stage: 'worker_setup', worker_id: w.id, reason: w.error });
  }

  // Cleanup: close each worker tab.
  for (const w of workers) {
    try { await w.destroy(); } catch (err) { cleanup_warnings.push({ stage: 'worker_destroy', worker_id: w.id, error: err.message }); }
  }

  return {
    results,
    parallelism: healthy.length,
    requested_parallelism: parallelism,
    workers_failed_setup: workers.length - healthy.length,
    cleanup_warnings,
  };
}
