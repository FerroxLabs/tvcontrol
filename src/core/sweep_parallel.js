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
import { ClassifiedError, CATEGORIES } from '../errors.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
// Per-call ceiling for a worker's Runtime.evaluate. Mirrors
// DEFAULT_EVAL_TIMEOUT_MS in connection.js — without it a hung backtest or a
// navigation-in-flight inside a worker tab leaves the evaluate promise pending
// forever, wedging that worker's whole queue and the outer Promise.all.
const WORKER_EVAL_TIMEOUT_MS = 20000;
// Coarse backstop around a whole combo (setSymbol → setInputs → readMetrics).
// Matches the serial sweep's DEFAULT_TIMEOUT_PER_COMBO_MS; overridable per run.
const DEFAULT_TIMEOUT_PER_COMBO_MS = 30000;

// Reject if `promise` doesn't settle within `ms`. Clears the timer on settle
// so the timeout handle can't leak. Mirrors withTimeout in sweep.js.
export async function _withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ClassifiedError(
      CATEGORIES.CDP_DISCONNECTED,
      `Parallel combo timed out after ${ms}ms${label ? ` (${label})` : ''}`,
    )), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

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
    if (!resp2.ok) {
      // Report BOTH statuses — the old message claimed the PUT status when
      // it was actually the GET fallback that failed last.
      throw new ClassifiedError(
        CATEGORIES.API_UNEXPECTED,
        `Failed to spawn tab: PUT HTTP ${resp.status}, GET HTTP ${resp2.status}`,
      );
    }
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
    const timeoutMs = opts.timeoutMs === undefined ? WORKER_EVAL_TIMEOUT_MS : opts.timeoutMs;
    const evalPromise = this.cdp.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
    });
    // Same unhandled-rejection guard as connection.evaluate(): if the timeout
    // wins the race, this CDP promise may reject later (tab closed / context
    // destroyed) and crash the whole sweep process unless it has a handler.
    evalPromise.catch(() => {});
    let result;
    if (timeoutMs && timeoutMs > 0) {
      let timer;
      const timeoutPromise = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new ClassifiedError(
          CATEGORIES.CDP_DISCONNECTED,
          `worker ${this.id}: evaluate timed out after ${timeoutMs}ms`,
        )), timeoutMs);
      });
      try {
        result = await Promise.race([evalPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      result = await evalPromise;
    }
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'evaluation error';
      throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `worker ${this.id}: ${msg}`);
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
    throw new ClassifiedError(
      CATEGORIES.CHART_LOADING,
      `worker ${this.id}: chart API not ready after ${timeoutMs}ms`,
    );
  }

  /**
   * Inject the master's published Pine onto this worker's chart by
   * replaying the captured metaInfo. Mirrors injectPublishedStudy in
   * state.js but runs against this worker's own CDP session so the
   * helper's singleton-evaluate isn't reused.
   *
   * Returns { success, method, pre_strategy_ids } — `pre_strategy_ids` is
   * the set of strategy entity_ids that existed BEFORE injection. The
   * caller passes that into resolveStrategyEntityId so it can find the
   * newly-injected source (not a pre-existing strategy from the user's
   * default layout — that was the binding bug we previously hit).
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
          var sources = function() { try { return cw._chartWidget.model().model().dataSources(); } catch(e) { return []; } };
          var strategyIds = function() {
            var ids = [];
            var srcs = sources();
            for (var i = 0; i < srcs.length; i++) {
              if (typeof srcs[i].reportData === 'function') {
                try {
                  var s = srcs[i];
                  var sid = typeof s.id === 'function' ? s.id() : s._id;
                  if (sid) ids.push(String(sid));
                } catch(e) {}
              }
            }
            return ids;
          };
          var pre_strategy_ids = strategyIds();
          var beforeLen = sources().length;
          var settle = function(ms) { return new Promise(function(r){ setTimeout(r, ms); }); };
          try { await cw.createStudy(meta); await settle(800); if (sources().length > beforeLen) return { success: true, method: 'createStudy', pre_strategy_ids: pre_strategy_ids }; } catch(e) {}
          try { var ret = cw._chartWidget.insertStudy(meta, []); if (ret && typeof ret.then === 'function') await ret; await settle(800); if (sources().length > beforeLen) return { success: true, method: 'insertStudy', pre_strategy_ids: pre_strategy_ids }; } catch(e) {}
          try { cw.insertStudyWithoutCheck(meta, inputs, false, [], null); await settle(800); if (sources().length > beforeLen) return { success: true, method: 'insertStudyWithoutCheck', pre_strategy_ids: pre_strategy_ids }; } catch(e) {}
          return { success: false, sources_before: beforeLen, sources_after: sources().length, pre_strategy_ids: pre_strategy_ids };
        } catch(e) { return { success: false, reason: 'eval_error', error: e.message }; }
      })()
    `, { awaitPromise: true });
    return result || { success: false, reason: 'no_result' };
  }

  /**
   * Find this worker's NEWLY-injected strategy entity_id. `exclude` is the
   * set of strategy ids that existed before injection — pass the
   * `pre_strategy_ids` returned by injectStrategy. Without that exclusion,
   * a default-layout chart with a pre-existing strategy would have this
   * function bind to the OLD strategy and every sweep metric would come
   * from the wrong source.
   */
  async resolveStrategyEntityId(exclude = []) {
    const excludeJson = JSON.stringify(exclude);
    return await this.evaluate(`
      (function() {
        try {
          var exclude = ${excludeJson};
          var seen = {};
          for (var i = 0; i < exclude.length; i++) seen[String(exclude[i])] = true;
          var sources = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources();
          for (var i = 0; i < sources.length; i++) {
            if (typeof sources[i].reportData === 'function') {
              var s = sources[i];
              var sid = (typeof s.id === 'function' ? s.id() : s._id) || null;
              if (sid && !seen[String(sid)]) return sid;
            }
          }
          // Fall back to first strategy if nothing was newly added (the
          // injection may have replaced an existing strategy in place).
          for (var j = 0; j < sources.length; j++) {
            if (typeof sources[j].reportData === 'function') {
              var s2 = sources[j];
              return (typeof s2.id === 'function' ? s2.id() : s2._id) || null;
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
    if (!result?.ok) {
      throw new ClassifiedError(
        CATEGORIES.API_UNEXPECTED,
        `setInputs failed: ${JSON.stringify(result)}`,
      );
    }
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
  timeout_per_combo_ms = DEFAULT_TIMEOUT_PER_COMBO_MS,
}) {
  if (!Array.isArray(combos) || combos.length === 0) {
    return { results: [], cleanup_warnings: [] };
  }
  const N = Math.max(1, Math.min(parallelism, 6, combos.length)); // hard ceiling 6
  const workers = [];
  const cleanup_warnings = [];

  // Spawn N tabs. If any fails, abort and clean up the rest. Push the
  // worker BEFORE connect() so a failed connect still leaves the spawned
  // tab tracked in `workers` and gets closed by the cleanup loop —
  // otherwise every connect-failure orphans a Chrome tab.
  try {
    for (let i = 0; i < N; i++) {
      const target = await _spawnTab();
      const w = new SweepWorker({ id: i, target_id: target.id, ws_url: target.webSocketDebuggerUrl });
      workers.push(w);
      await w.connect();
    }
  } catch (err) {
    for (const w of workers) await w.destroy();
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Failed to spawn worker pool (${workers.length}/${N}): ${err.message}`,
      { cause: err },
    );
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
      // Pass the pre-existing strategy ids so the resolver doesn't bind to
      // a stale strategy from the default layout.
      const eid = await w.resolveStrategyEntityId(inj.pre_strategy_ids || []);
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
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `All ${N} workers failed setup. ${reasons.join(' | ')}`,
    );
  }

  // Distribute combos round-robin across healthy workers.
  const queues = healthy.map(() => []);
  for (let i = 0; i < combos.length; i++) {
    queues[i % healthy.length].push(combos[i]);
  }

  // A Ctrl-C / kill mid-sweep skips the finally below and orphans 3-6
  // TradingView tabs. Register best-effort signal handlers that fire tab-close
  // requests for every spawned worker. These are fire-and-forget — the process
  // may exit before the async fetch lands (telemetry.js hard-exits on SIGINT),
  // but on SIGTERM and slower exits they reclaim the tabs. prependListener so
  // we at least dispatch the closes ahead of any exit handler. Removed in the
  // finally so a completed sweep doesn't leak listeners across runs.
  const _onTerminate = () => { for (const w of workers) { try { _closeTab(w.target_id); } catch {} } };
  process.prependListener('SIGINT', _onTerminate);
  process.prependListener('SIGTERM', _onTerminate);

  // Each worker drains its queue serially.
  const results = [];
  try {
    await Promise.all(healthy.map(async (w, qIdx) => {
      for (const combo of queues[qIdx]) {
        let r;
        try {
          // Per-combo backstop: a wedged combo must not stall this worker's
          // whole queue (and the outer Promise.all) indefinitely. runCombo
          // catches its own errors, so this race only fires on a genuine hang
          // that escapes the per-evaluate timeout.
          r = await _withTimeout(
            w.runCombo({ combo, entityId: w.entity_id, settleMs: per_combo_settle_ms }),
            timeout_per_combo_ms,
            `worker ${w.id} ${combo.symbol}/${combo.timeframe}`,
          );
        } catch (err) {
          r = {
            symbol: combo.symbol,
            timeframe: combo.timeframe,
            inputs: combo.inputs,
            error: err.message,
            worker_id: w.id,
          };
        }
        results.push(r);
      }
    }));
  } finally {
    // Cleanup MUST run whether the drain resolved or threw — a rejected drain
    // would otherwise leave every worker tab open (the orphaned-tab leak).
    process.removeListener('SIGINT', _onTerminate);
    process.removeListener('SIGTERM', _onTerminate);
    for (const w of workers) {
      if (w.error) cleanup_warnings.push({ stage: 'worker_setup', worker_id: w.id, reason: w.error });
    }
    for (const w of workers) {
      try { await w.destroy(); } catch (err) { cleanup_warnings.push({ stage: 'worker_destroy', worker_id: w.id, error: err.message }); }
    }
  }

  return {
    results,
    parallelism: healthy.length,
    requested_parallelism: parallelism,
    workers_failed_setup: workers.length - healthy.length,
    cleanup_warnings,
  };
}
