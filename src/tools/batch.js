import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/batch.js';

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run an action across multiple symbols and/or timeframes', {
    symbols: z.array(z.string().min(1).max(120)).min(1).max(100).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string().min(1).max(20)).max(20).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
    action: z.enum(['screenshot', 'get_ohlcv', 'get_strategy_results', 'get_study_values', 'get_pine_tables']).describe('Action to run for each symbol/timeframe. get_study_values reads every visible indicator per symbol and is the one to use for universe scans.'),
    delay_ms: z.coerce.number().int().min(0).max(60000).optional().describe('Delay between iterations in ms (0-60000, default 2000)'),
    ohlcv_count: z.coerce.number().int().min(1).max(500).optional().describe('Bar count for get_ohlcv action (1-500, default 100)'),
    study_filter: z.string().optional().describe('For get_pine_tables: substring matching the indicator whose table to read. Omit for all.'),
    entity_id: z.string().min(1).max(200).optional().describe('Exact strategy entity ID for get_strategy_results; recommended when more than one strategy is present'),
    restore_start_state: z.coerce.boolean().optional().describe('Restore the starting chart symbol/timeframe in a guaranteed cleanup path (default true)'),
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count, entity_id, restore_start_state }) => {
    try { return jsonResult(await core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, entity_id, restore_start_state })); }
    catch (err) { return errorResult(err); }
  });
}
