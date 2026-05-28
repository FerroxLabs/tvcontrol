import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/batch.js';

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run an action across multiple symbols and/or timeframes', {
    symbols: z.array(z.string()).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string()).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
    action: z.enum(['screenshot', 'get_ohlcv', 'get_strategy_results']).describe('Action to run for each symbol/timeframe'),
    delay_ms: z.coerce.number().int().min(0).max(60000).optional().describe('Delay between iterations in ms (0-60000, default 2000)'),
    ohlcv_count: z.coerce.number().int().min(1).max(500).optional().describe('Bar count for get_ohlcv action (1-500, default 100)'),
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count }) => {
    try { return jsonResult(await core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count })); }
    catch (err) { return errorResult(err); }
  });
}
