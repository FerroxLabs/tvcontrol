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
import { getOhlcv, getStrategyResults } from './data.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

const VALID_ACTIONS = new Set(['screenshot', 'get_ohlcv', 'get_strategy_results']);

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

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
  if (!VALID_ACTIONS.has(action)) {
    return {
      success: false,
      error: `Unknown action: ${action}. Valid: ${[...VALID_ACTIONS].join(', ')}`,
      category: 'invalid_argument',
    };
  }
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms ?? 2000;
  const results = [];

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        await chart.setSymbol({ symbol });
        if (tf) await chart.setTimeframe({ timeframe: tf });

        // waitForChartReady tolerates brief transitions; the explicit delay
        // gives downstream reads a chance to pick up fresh bars/studies.
        await waitForChartReady(symbol);
        await new Promise((r) => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          actionResult = await _captureScreenshot(symbol, tf);
        } else if (action === 'get_ohlcv') {
          // Use the direct-bars path (same as data_get_ohlcv). Returns a
          // summary with open/close/high/low/change and last_5_bars.
          actionResult = await getOhlcv({ count: ohlcv_count, summary: true });
        } else if (action === 'get_strategy_results') {
          // Uses the internal-API finder (post-fix) that correctly locates
          // overlay strategies and reports from reportData().performance.all.
          actionResult = await getStrategyResults();
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

  const successCount = results.filter((r) => r.success).length;
  return {
    success: true,
    total_iterations: results.length,
    successful: successCount,
    failed: results.length - successCount,
    results,
  };
}
