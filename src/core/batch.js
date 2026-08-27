/**
 * Core batch execution logic.
 *
 * Drives the active chart through a symbol × timeframe grid, running one of
 * a small set of read actions per combo. Delegates each action to the
 * already-proven single-chart core function so behaviour stays consistent
 * with ad-hoc use (data_get_ohlcv, data_get_strategy_results, screenshot).
 */
import { getClient } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import * as chart from './chart.js';
import { getOhlcv, getStrategyResults, getStudyValues, getPineTables } from './data.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

// `get_pine_tables` is here because a Pine strategy's own decision table is the one output a
// universe scan most often wants, and reading it per symbol was previously only possible by
// driving set_symbol and data_get_pine_tables in a loop from outside. That loop cannot live in
// an agent (one round trip per symbol, 74 symbols) and it cannot always live in a script
// either: some hosts confine a skill's filesystem writes to the workspace and give a script no
// way to resolve this package. Running the sweep here removes both problems.
const VALID_ACTIONS = new Set(['screenshot', 'get_ohlcv', 'get_strategy_results', 'get_study_values', 'get_pine_tables']);

async function _captureScreenshot(symbol, tf) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const client = await getClient();
  const { data } = await client.Page.captureScreenshot({ format: 'png' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
  const filePath = join(SCREENSHOT_DIR, fname);
  writeFileSync(filePath, Buffer.from(data, 'base64'));
  return { file_path: filePath, size_bytes: data.length };
}

function _resolve(deps) {
  return {
    getChartState: deps?.getChartState || chart.getState,
    setSymbol: deps?.setSymbol || chart.setSymbol,
    setTimeframe: deps?.setTimeframe || chart.setTimeframe,
    waitForChartReady: deps?.waitForChartReady || waitForChartReady,
    getOhlcv: deps?.getOhlcv || getOhlcv,
    getStrategyResults: deps?.getStrategyResults || getStrategyResults,
    getStudyValues: deps?.getStudyValues || getStudyValues,
    getPineTables: deps?.getPineTables || getPineTables,
    captureScreenshot: deps?.captureScreenshot || _captureScreenshot,
    sleep: deps?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, entity_id, study_filter, restore_start_state = true, _deps }) {
  if (!VALID_ACTIONS.has(action)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unknown action: ${action}. Valid: ${[...VALID_ACTIONS].join(', ')}`);
  }
  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > 100 || symbols.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 120)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbols must contain 1-100 non-empty symbol strings (max 120 characters each)');
  }
  if (timeframes !== undefined && (!Array.isArray(timeframes) || timeframes.length > 20 || timeframes.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 20))) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'timeframes must contain at most 20 non-empty strings (max 20 characters each)');
  }
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms ?? 2000;
  if (!Number.isInteger(delay) || delay < 0 || delay > 60000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'delay_ms must be an integer from 0 to 60000');
  }
  if (symbols.length * tfs.length > 500) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'batch is limited to 500 symbol/timeframe combinations');
  }
  if (action === 'get_strategy_results' && entity_id !== undefined && (typeof entity_id !== 'string' || entity_id.length === 0 || entity_id.length > 200)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'entity_id must be a non-empty string no longer than 200 characters');
  }

  const deps = _resolve(_deps);
  const results = [];
  const original = restore_start_state ? await deps.getChartState({ _deps }) : null;
  let restoredStartState = !restore_start_state;
  let restoreError = null;

  try {
    for (const symbol of symbols) {
      for (const tf of tfs) {
        const combo = { symbol, timeframe: tf };
        try {
          await deps.setSymbol({ symbol, _deps });
          if (tf) await deps.setTimeframe({ timeframe: tf, _deps });

          // waitForChartReady returns false on timeout. Treat that as an
          // iteration failure so a stale chart can never be reported as fresh.
          // The explicit delay gives downstream reads a chance to pick up
          // newly rendered bars/studies after readiness is confirmed.
          const ready = await deps.waitForChartReady(symbol, tf);
          if (!ready) {
            throw new ClassifiedError(
              CATEGORIES.CHART_LOADING,
              `Chart did not finish loading ${symbol}${tf ? ` at ${tf}` : ''}`,
            );
          }
          await deps.sleep(delay);

          let actionResult;
          if (action === 'screenshot') {
            actionResult = await deps.captureScreenshot(symbol, tf);
          } else if (action === 'get_ohlcv') {
            actionResult = await deps.getOhlcv({ count: ohlcv_count, summary: true, _deps });
          } else if (action === 'get_strategy_results') {
            actionResult = await deps.getStrategyResults({ entity_id, _deps });
          } else if (action === 'get_pine_tables') {
            actionResult = await deps.getPineTables({ study_filter });
          } else if (action === 'get_study_values') {
            // THIS ACTION WAS DOCUMENTED BUT NEVER IMPLEMENTED. The server's
            // own tool guide and the market-open scan skill both instruct
            // callers to run batch_run({action:"get_study_values"}) to sweep a
            // universe in one call — it is the core step of that workflow. The
            // enum did not contain it, so every such call died at schema
            // validation and the documented flagship scan was impossible.
            // Found by sweeping all 101 tools on 2026-08-20.
            actionResult = await deps.getStudyValues({ _deps });
          }
          results.push({ ...combo, success: true, result: actionResult });
        } catch (err) {
          results.push({
            ...combo,
            success: false,
            error: err.message,
            category: err.category,
          });
        }
      }
    }
  } finally {
    if (restore_start_state && original?.symbol && original?.resolution) {
      try {
        await deps.setSymbol({ symbol: original.symbol, _deps });
        await deps.setTimeframe({ timeframe: original.resolution, _deps });
        restoredStartState = true;
      } catch (err) {
        restoreError = { error: err.message, category: err.category || CATEGORIES.API_UNEXPECTED };
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  return {
    // success reflects whether ANY iteration succeeded. Returning success:true
    // when every symbol/timeframe failed (the old behavior) masked a total
    // failure as a successful batch.
    success: results.length === 0 ? true : successCount > 0,
    total_iterations: results.length,
    successful: successCount,
    failed: results.length - successCount,
    restored_start_state: restoredStartState,
    ...(restoreError ? { restore_error: restoreError } : {}),
    results,
  };
}
