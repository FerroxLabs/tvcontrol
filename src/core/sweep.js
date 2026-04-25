/**
 * Core strategy sweep logic.
 * Iterates a strategy across Cartesian product of symbols × timeframes × indicator inputs.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { safeString } from '../connection.js';
import { setSymbol as _setSymbol, setTimeframe as _setTimeframe } from './chart.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { setInputs as _setInputs } from './indicators.js';
import { getStrategyResults as _getStrategyResults } from './data.js';
import { snapshot as _snapshot, restore as _restore, deleteSnapshot as _deleteSnapshot } from './state.js';
import { runCombosParallel } from './sweep_parallel.js';
import { evaluate as _evalConn } from '../connection.js';
import { strictResolve } from './_resolve.js';

const _SWEEP_DEPS = new Set([
  'setSymbol', 'setTimeframe', 'waitForChartReady', 'setInputs',
  'getStrategyResults', 'snapshot', 'restore', 'deleteSnapshot',
  'sleep', 'writePartial',
  // CDP passthrough — read separately to build cdpDeps for downstream calls
  'evaluate', 'evaluateAsync', 'getChartApi',
]);

export const SWEEPS_DIR = join(homedir(), '.tv-mcp', 'sweeps');
export const SWEEP_CACHE_DIR = join(homedir(), '.tv-mcp', 'sweep-cache');
const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const MAX_CAP = 500;
const DEFAULT_MAX_COMBINATIONS = 100;
const DEFAULT_COOLDOWN_MS = 1500;
// When (symbol, timeframe) are unchanged from prior combo, the chart didn't
// reload — only inputs changed. A much shorter settle is sufficient.
// 100 combos × (1500-200) ≈ 130s saved on single-symbol single-tf sweeps.
const DEFAULT_SAME_SYMBOL_COOLDOWN_MS = 200;
const DEFAULT_TIMEOUT_PER_COMBO_MS = 30000;

/**
 * Build Cartesian product of an inputs object: { k: [v1, v2], k2: [a, b] }
 * Returns array of plain objects e.g. [{ k: v1, k2: a }, ...]
 */
export function cartesianProduct(inputs) {
  const keys = Object.keys(inputs);
  if (keys.length === 0) return [{}];
  const values = keys.map(k => inputs[k]);
  const result = [];
  function recurse(idx, current) {
    if (idx === keys.length) { result.push({ ...current }); return; }
    for (const v of values[idx]) {
      current[keys[idx]] = v;
      recurse(idx + 1, current);
    }
  }
  recurse(0, {});
  return result;
}

function _resolve(deps) {
  strictResolve(deps, _SWEEP_DEPS);
  return {
    setSymbol: deps?.setSymbol || _setSymbol,
    setTimeframe: deps?.setTimeframe || _setTimeframe,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    setInputs: deps?.setInputs || _setInputs,
    getStrategyResults: deps?.getStrategyResults || _getStrategyResults,
    snapshot: deps?.snapshot || _snapshot,
    restore: deps?.restore || _restore,
    deleteSnapshot: deps?.deleteSnapshot || _deleteSnapshot,
    sleep: deps?.sleep || ((ms) => new Promise(r => setTimeout(r, ms))),
    writePartial: deps?.writePartial || null,
  };
}

function _genRunId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `sweep_${ts}_${rand}`;
}

function _findMetric(metrics, ...keywords) {
  if (!metrics || typeof metrics !== 'object') return undefined;
  for (const key of Object.keys(metrics)) {
    const lower = key.toLowerCase().replace(/[_\s-]/g, '');
    if (keywords.some(kw => lower.includes(kw.toLowerCase().replace(/[_\s-]/g, '')))) {
      const raw = metrics[key];
      const num = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!isNaN(num)) return { key, value: num };
    }
  }
  return undefined;
}

function _bestByMetric(results, ...keywords) {
  let best = null;
  let bestVal = -Infinity;
  for (const r of results) {
    if (r.error || !r.metrics) continue;
    const found = _findMetric(r.metrics, ...keywords);
    if (found && found.value > bestVal) {
      bestVal = found.value;
      best = r;
    }
  }
  return best;
}

function _comboKey(symbol, timeframe, inputs) {
  return JSON.stringify({ symbol, timeframe, inputs });
}

/**
 * Cross-run memoization: hash {entity_id, symbol, timeframe, inputs} and
 * store PnL metrics keyed by that hash. A re-run that overlaps a previous
 * grid skips the whole TradingView round-trip for cache hits.
 *
 * entity_id is part of the key because different strategies produce
 * different PnL for the same inputs. Cache entries carry `cached_at` so
 * callers can age them out — backtest history evolves as new bars arrive.
 */
function _cacheHash(entity_id, symbol, timeframe, inputs) {
  const canonical = JSON.stringify({ e: entity_id, s: symbol, t: timeframe, i: inputs });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function _cacheLoad(hash, maxAgeMs, cacheDir) {
  // maxAgeMs <= 0 is an explicit "force fresh" sentinel — same-millisecond
  // writes would otherwise register age 0 and still pass `age > maxAgeMs`.
  if (maxAgeMs <= 0) return null;
  const dir = cacheDir || SWEEP_CACHE_DIR;
  const filePath = join(dir, `${hash}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const age = Date.now() - new Date(parsed.cached_at).getTime();
    if (age > maxAgeMs) return null; // expired
    return parsed;
  } catch { return null; }
}

function _cacheStore(hash, entry, cacheDir) {
  const dir = cacheDir || SWEEP_CACHE_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${hash}.json`);
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch { /* best-effort; sweep still works without cache */ }
}

function _writePartialDefault(runId, data, sweepsDir) {
  const dir = sweepsDir || SWEEPS_DIR;
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${runId}.partial.json`);
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function _loadPartial(runId, sweepsDir) {
  const dir = sweepsDir || SWEEPS_DIR;
  const filePath = join(dir, `${runId}.partial.json`);
  if (!existsSync(filePath)) throw new ClassifiedError(
    CATEGORIES.API_UNEXPECTED,
    `No partial file found for run_id: ${runId}`,
  );
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export async function strategySweep({
  symbols,
  timeframes,
  inputs = {},
  entity_id,
  max_combinations = DEFAULT_MAX_COMBINATIONS,
  cooldown_ms = DEFAULT_COOLDOWN_MS,
  same_symbol_cooldown_ms = DEFAULT_SAME_SYMBOL_COOLDOWN_MS,
  timeout_per_combo_ms = DEFAULT_TIMEOUT_PER_COMBO_MS,
  on_error = 'continue',
  restore_start_state = true,
  resume_from_run_id,
  use_cache,
  cache_max_age_ms = DEFAULT_CACHE_MAX_AGE_MS,
  parallelism = 1,
  _deps,
  _sweeps_dir,
  _snapshots_dir,
  _cache_dir,
} = {}) {
  // Default use_cache: on for production (no _deps), off for tests (with _deps)
  // unless the test explicitly opts in. Test isolation — unit tests mock
  // getStrategyResults; if cache hits happened to be present they'd skip
  // the mock and the test's setup/counters would all be off.
  if (use_cache === undefined) use_cache = !_deps;
  // --- Validation ---
  if (!Array.isArray(symbols) || symbols.length === 0)
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbols must be a non-empty array');
  if (!Array.isArray(timeframes) || timeframes.length === 0)
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'timeframes must be a non-empty array');
  if (!entity_id || typeof entity_id !== 'string')
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id is required');

  if (max_combinations < 1 || max_combinations > MAX_CAP)
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `max_combinations exceeds absolute cap of ${MAX_CAP}`,
      { hint: `Requested ${max_combinations}, cap is ${MAX_CAP}` },
    );

  // Fix 4: dedupe symbols and timeframes before cartesian build
  const dedupedSymbols = Array.from(new Set(symbols));
  const dedupedTimeframes = Array.from(new Set(timeframes));
  const symbolsDuped = dedupedSymbols.length < symbols.length;
  const timeframesDuped = dedupedTimeframes.length < timeframes.length;

  // Fix 1: compute product size BEFORE materializing cartesian product — prevents OOM
  const inputProductSize = Object.values(inputs).reduce(
    (acc, v) => acc * (Array.isArray(v) ? v.length : 1),
    1,
  );
  const totalRequested = dedupedSymbols.length * dedupedTimeframes.length * inputProductSize;

  if (totalRequested > max_combinations)
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Requested ${totalRequested} combinations exceeds max_combinations=${max_combinations}`,
      { hint: `cap: ${max_combinations}, requested: ${totalRequested}` },
    );

  const inputCombos = cartesianProduct(inputs);

  const deps = _resolve(_deps);
  const run_id = resume_from_run_id || _genRunId();
  const startTime = Date.now();

  // --- Build full combo list ---
  const allCombos = [];
  for (const symbol of dedupedSymbols) {
    for (const timeframe of dedupedTimeframes) {
      for (const inputCombo of inputCombos) {
        allCombos.push({ symbol, timeframe, inputs: inputCombo });
      }
    }
  }

  // --- Parallel branch: spawn worker tabs and dispatch combos across them ---
  // Only engage when parallelism > 1 AND we're running against real CDP
  // (no _deps). The serial loop below remains the default for single-tab
  // and DI test runs.
  if (parallelism > 1 && !_deps) {
    return await _runParallel({
      allCombos, parallelism, entity_id, run_id, startTime, use_cache,
      cache_max_age_ms, _cache_dir, symbolsDuped, timeframesDuped,
      dedupedSymbols, dedupedTimeframes, cooldown_ms,
    });
  }

  // --- Resume: load previously completed combos ---
  let priorResults = [];
  const completedKeys = new Set();
  if (resume_from_run_id) {
    const partial = _loadPartial(resume_from_run_id, _sweeps_dir);
    priorResults = partial.results || [];
    for (const r of priorResults) {
      if (!r.error) completedKeys.add(_comboKey(r.symbol, r.timeframe, r.inputs));
    }
  }

  // Fix 5: timeout helper that clears the timer on resolution to avoid leak
  async function withTimeout(promise, ms) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Fix 6: CDP-only subset to pass downstream so sweep-level mocks don't leak
  const cdpDeps = {
    evaluate: _deps?.evaluate,
    evaluateAsync: _deps?.evaluateAsync,
    waitForChartReady: _deps?.waitForChartReady,
    getChartApi: _deps?.getChartApi,
  };

  // --- Snapshot before sweep ---
  const startStateSnapshotName = restore_start_state ? `.sweep_start_${run_id}` : null;
  if (startStateSnapshotName) {
    await deps.snapshot({ name: startStateSnapshotName, _snapshots_dir });
  }

  const results = [...priorResults];
  let errored = priorResults.filter(r => r.error).length;
  let cache_hits = 0;
  const cleanup_warnings = [];

  const writePartialFn = deps.writePartial || ((data) => _writePartialDefault(run_id, data, _sweeps_dir));

  // Track prior combo so we can short-circuit cooldown when only inputs change.
  // same_symbol_cooldown_ms is clamped at cooldown_ms — never longer than the full cooldown.
  const sameSymbolCooldown = Math.min(
    Math.max(0, same_symbol_cooldown_ms),
    cooldown_ms,
  );
  let lastSymbol = null;
  let lastTimeframe = null;

  // Fix 2 & 3: wrap main loop in try/finally so restore + snapshot delete always run
  try {
    // --- Iterate combos ---
    for (const combo of allCombos) {
      const key = _comboKey(combo.symbol, combo.timeframe, combo.inputs);
      if (completedKeys.has(key)) continue;

      const comboStart = Date.now();

      // Cross-run memoization: if this exact {entity_id, symbol, timeframe,
      // inputs} triple was computed recently, skip the whole CDP round-trip.
      // Caller can force fresh computation with use_cache: false, or shorten
      // the TTL via cache_max_age_ms. Pre-chart setup (~15s per combo)
      // disappears entirely on hits.
      if (use_cache) {
        const hash = _cacheHash(entity_id, combo.symbol, combo.timeframe, combo.inputs);
        const cached = _cacheLoad(hash, cache_max_age_ms, _cache_dir);
        if (cached && cached.metrics) {
          results.push({
            symbol: combo.symbol,
            timeframe: combo.timeframe,
            inputs: combo.inputs,
            metrics: cached.metrics,
            duration_ms: 0,
            cached: true,
            cached_at: cached.cached_at,
          });
          cache_hits++;
          continue;
        }
      }

      try {
        await deps.setSymbol({ symbol: combo.symbol, _deps: cdpDeps });
        await deps.setTimeframe({ timeframe: combo.timeframe, _deps: cdpDeps });
        await deps.waitForChartReady(combo.symbol, combo.timeframe);

        if (Object.keys(combo.inputs).length > 0) {
          await deps.setInputs({ entity_id, inputs: combo.inputs });
        }

        const sameAsPrior = combo.symbol === lastSymbol && combo.timeframe === lastTimeframe;
        await deps.sleep(sameAsPrior ? sameSymbolCooldown : cooldown_ms);
        lastSymbol = combo.symbol;
        lastTimeframe = combo.timeframe;

        const stratResult = await withTimeout(deps.getStrategyResults(), timeout_per_combo_ms);

        // getStrategyResults now THROWS on error (W3.5 fix in adff091), so
        // success-path stratResult is always { success:true, metrics:{...} }.
        const combo_metrics = stratResult?.metrics ?? {};
        results.push({
          symbol: combo.symbol,
          timeframe: combo.timeframe,
          inputs: combo.inputs,
          metrics: combo_metrics,
          duration_ms: Date.now() - comboStart,
        });

        // Persist to cache on successful combo (has metrics). Skip for empty
        // results to avoid poisoning the cache with Strategy-Tester-closed
        // failures that will succeed on retry.
        if (use_cache && Object.keys(combo_metrics).length > 0) {
          const hash = _cacheHash(entity_id, combo.symbol, combo.timeframe, combo.inputs);
          _cacheStore(hash, {
            entity_id,
            symbol: combo.symbol,
            timeframe: combo.timeframe,
            inputs: combo.inputs,
            metrics: combo_metrics,
            cached_at: new Date().toISOString(),
          }, _cache_dir);
        }
      } catch (err) {
        errored++;
        if (on_error === 'abort') {
          // Record this failed combo before re-throwing so a resume_from_run_id
          // retry has the partial state — otherwise abort throws away every
          // combo completed so far AND the failure context.
          results.push({
            symbol: combo.symbol,
            timeframe: combo.timeframe,
            inputs: combo.inputs,
            error: err.message,
            duration_ms: Date.now() - comboStart,
          });
          try { writePartialFn({ run_id, results }); } catch (_) { /* best effort */ }
          throw err;
        }
        results.push({
          symbol: combo.symbol,
          timeframe: combo.timeframe,
          inputs: combo.inputs,
          error: err.message,
          duration_ms: Date.now() - comboStart,
        });
      }

      // Checkpoint every 10 completed
      const nonPriorCompleted = results.length - priorResults.length;
      if (nonPriorCompleted > 0 && nonPriorCompleted % 10 === 0) {
        writePartialFn({ run_id, results });
      }
    }
  } finally {
    // Cleanup MUST run on any exit. Capture failures into cleanup_warnings so
    // the user knows their start-state contract was not honored — silent
    // cleanup failure was a CRITICAL audit finding (lens B).
    if (startStateSnapshotName) {
      try { await deps.restore({ name: startStateSnapshotName, _snapshots_dir }); }
      catch (err) { cleanup_warnings.push({ stage: 'restore_start_state', error: err.message }); }
      try { await deps.deleteSnapshot({ name: startStateSnapshotName }); }
      catch (err) { cleanup_warnings.push({ stage: 'delete_scratch_snapshot', error: err.message }); }
    }
  }

  // --- Summary ---
  const bestByNetProfit = _bestByMetric(results, 'netprofit', 'net profit', 'net_profit');
  const bestBySharpe = _bestByMetric(results, 'sharpe', 'sharperatio', 'sharpe ratio');

  const summary = {
    best_by_net_profit: bestByNetProfit || null,
    best_by_sharpe: bestBySharpe || null,
    count_with_error: errored,
  };

  const warnings = [];
  if (symbolsDuped) warnings.push(`Duplicate symbols removed; running ${dedupedSymbols.length} unique symbol(s).`);
  if (timeframesDuped) warnings.push(`Duplicate timeframes removed; running ${dedupedTimeframes.length} unique timeframe(s).`);
  for (const cw of cleanup_warnings) {
    warnings.push(`Cleanup ${cw.stage} failed: ${cw.error}`);
  }

  return {
    success: true,
    run_id,
    total_combinations: allCombos.length,
    completed: results.filter(r => !r.error).length,
    errored,
    cache_hits,
    duration_ms: Date.now() - startTime,
    results,
    summary,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(cleanup_warnings.length > 0 ? { cleanup_warnings } : {}),
  };
}

/**
 * Parallel sweep path. Resolves the master strategy's metaInfo via the
 * existing CDP session, then dispatches combos across worker tabs that
 * each clone the strategy via state.injectPublishedStudy. Cache layer
 * still applies — hits short-circuit before any worker work happens.
 */
async function _runParallel({
  allCombos, parallelism, entity_id, run_id, startTime, use_cache,
  cache_max_age_ms, _cache_dir, symbolsDuped, timeframesDuped,
  dedupedSymbols, dedupedTimeframes, cooldown_ms,
}) {
  // Cache split: hits resolved instantly, misses dispatched to workers.
  const cachedResults = [];
  const todo = [];
  if (use_cache) {
    for (const combo of allCombos) {
      const hash = _cacheHash(entity_id, combo.symbol, combo.timeframe, combo.inputs);
      const hit = _cacheLoad(hash, cache_max_age_ms, _cache_dir);
      if (hit && hit.metrics) {
        cachedResults.push({
          symbol: combo.symbol,
          timeframe: combo.timeframe,
          inputs: combo.inputs,
          metrics: hit.metrics,
          duration_ms: 0,
          cached: true,
          cached_at: hit.cached_at,
        });
      } else {
        todo.push(combo);
      }
    }
  } else {
    todo.push(...allCombos);
  }

  // Pull metaInfo + base inputs of the master strategy so workers can replay.
  const studyContext = await _evalConn(`
    (function() {
      try {
        var cw = window.TradingViewApi._activeChartWidgetWV.value();
        var s = cw.getStudyById(${JSON.stringify(entity_id)});
        if (!s) return { ok: false, reason: 'master entity_id ' + ${JSON.stringify(entity_id)} + ' not on chart' };
        // Find the underlying dataSource for full metaInfo (same path as snapshot)
        var sources = cw._chartWidget.model().model().dataSources();
        var ds = null;
        for (var i = 0; i < sources.length; i++) {
          var d = sources[i];
          var did = d._id || (typeof d.id === 'function' ? d.id() : d.id);
          if (did === ${JSON.stringify(entity_id)}) { ds = d; break; }
        }
        if (!ds || typeof ds.metaInfo !== 'function') return { ok: false, reason: 'no metaInfo on master study' };
        function safe(v, depth, seen) {
          if (depth > 12 || v === null || v === undefined) return v;
          if (typeof v === 'function') return undefined;
          if (typeof v !== 'object') return v;
          if (seen.has(v)) return undefined; seen.add(v);
          if (Array.isArray(v)) return v.map(function(x){ return safe(x, depth+1, seen); });
          var o = {}; for (var k in v) try { var c = safe(v[k], depth+1, seen); if (c !== undefined) o[k] = c; } catch(e){} return o;
        }
        var meta = safe(ds.metaInfo(), 0, new Set());
        var inputs = {};
        try {
          var raw = s.getInputValues() || [];
          for (var j = 0; j < raw.length; j++) inputs[raw[j].id] = raw[j].value;
        } catch(e) {}
        return { ok: true, metaInfo: meta, base_inputs: inputs };
      } catch(e) { return { ok: false, reason: e.message }; }
    })()
  `);
  if (!studyContext?.ok) {
    throw new ClassifiedError(
      CATEGORIES.STUDY_NOT_FOUND,
      `Cannot run parallel sweep: ${studyContext?.reason || 'master strategy unreachable'}`,
      { hint: 'Make sure the strategy referenced by entity_id is loaded on the active chart, and the Strategy Tester panel is open.' },
    );
  }

  let workerResults = [];
  let workerInfo = { parallelism: 0, requested_parallelism: parallelism, workers_failed_setup: 0 };
  let parallel_cleanup_warnings = [];
  if (todo.length > 0) {
    const out = await runCombosParallel({
      combos: todo,
      metaInfo: studyContext.metaInfo,
      base_inputs: studyContext.base_inputs,
      parallelism,
      per_combo_settle_ms: cooldown_ms,
    });
    workerResults = out.results;
    workerInfo = {
      parallelism: out.parallelism,
      requested_parallelism: out.requested_parallelism,
      workers_failed_setup: out.workers_failed_setup,
    };
    parallel_cleanup_warnings = out.cleanup_warnings || [];
    // Cache the new successful results.
    if (use_cache) {
      for (const r of workerResults) {
        if (r.error) continue;
        const m = r.metrics || {};
        if (Object.keys(m).length === 0) continue;
        const hash = _cacheHash(entity_id, r.symbol, r.timeframe, r.inputs);
        _cacheStore(hash, {
          entity_id, symbol: r.symbol, timeframe: r.timeframe, inputs: r.inputs,
          metrics: m, cached_at: new Date().toISOString(),
        }, _cache_dir);
      }
    }
  }

  const results = [...cachedResults, ...workerResults];
  const errored = results.filter((r) => r.error).length;
  const cache_hits = cachedResults.length;
  const bestByNetProfit = _bestByMetric(results, 'netprofit', 'net profit', 'net_profit');
  const bestBySharpe = _bestByMetric(results, 'sharpe', 'sharperatio', 'sharpe ratio');

  const warnings = [];
  if (symbolsDuped) warnings.push(`Duplicate symbols removed; running ${dedupedSymbols.length} unique symbol(s).`);
  if (timeframesDuped) warnings.push(`Duplicate timeframes removed; running ${dedupedTimeframes.length} unique timeframe(s).`);
  if (workerInfo.workers_failed_setup > 0) {
    warnings.push(`${workerInfo.workers_failed_setup} worker(s) failed setup; ran on ${workerInfo.parallelism}/${workerInfo.requested_parallelism}.`);
  }
  for (const cw of parallel_cleanup_warnings) {
    warnings.push(`Worker cleanup ${cw.stage} (worker ${cw.worker_id}): ${cw.reason || cw.error}`);
  }

  return {
    success: true,
    run_id,
    total_combinations: allCombos.length,
    completed: results.filter((r) => !r.error).length,
    errored,
    cache_hits,
    parallelism: workerInfo.parallelism,
    duration_ms: Date.now() - startTime,
    results,
    summary: {
      best_by_net_profit: bestByNetProfit || null,
      best_by_sharpe: bestBySharpe || null,
      count_with_error: errored,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
