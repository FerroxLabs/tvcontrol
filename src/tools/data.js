import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/data.js';

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().int().min(1).max(500).optional().describe('Number of bars to retrieve (1-500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  }, async ({ count, summary }) => {
    try { return jsonResult(await core.getOhlcv({ count, summary })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_strategy_results', 'Get strategy performance metrics. Pass entity_id when more than one strategy is loaded. Auto-opens Strategy Tester and unhides the selected strategy so TradingView computes its report.', {
    entity_id: z.string().optional().describe('Exact strategy entity ID from chart_get_state. Strongly recommended when more than one strategy is loaded.'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getStrategyResults({ entity_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_trades', 'Get the most recent strategy orders. Pass entity_id when more than one strategy is loaded. Auto-opens Strategy Tester and unhides the selected strategy.', {
    max_trades: z.coerce.number().int().min(1).max(20).optional().describe('Maximum trades to return (1-20, default 20)'),
    entity_id: z.string().optional().describe('Exact strategy entity ID from chart_get_state. Strongly recommended when more than one strategy is loaded.'),
  }, async ({ max_trades, entity_id }) => {
    try { return jsonResult(await core.getTrades({ max_trades, entity_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_equity', 'Get equity curve data from Strategy Tester. Pass entity_id when more than one strategy is loaded.', {
    entity_id: z.string().optional().describe('Exact strategy entity ID from chart_get_state. Strongly recommended when more than one strategy is loaded.'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getEquity({ entity_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('quote_get', 'Get quote data. A different symbol briefly switches the chart, serializes concurrent quote calls, and restores the original chart.', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart). Non-blank values cause a temporary chart switch and restore.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) {
      // Preserve a ClassifiedError's category/hint (was stripped by the manual
      // shape below); only synthesize the DOM-panel hint for unclassified errors.
      if (err?.category) return errorResult(err);
      return jsonResult({ success: false, error: err.message, category: 'tv_ui_changed', hint: 'Open the DOM panel in TradingView before using this tool.' }, true);
    }
  });

  server.tool('quote_batch', 'Get live quotes for MANY symbols in ONE request without touching the chart. Use this for watchlist and universe sweeps: 29 symbols return in about 270ms. quote_get switches the chart symbol and takes ~20s each, so never loop it.', {
    symbols: z.array(z.string()).min(1).max(500).describe('Exchange-prefixed symbols, e.g. ["NASDAQ:AAPL","BINANCE:BTCUSDT"]. Duplicates are collapsed. Symbols the endpoint does not know are reported in not_found rather than silently dropped.'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.getQuotes({ symbols })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return errorResult(err); }
  });
}
