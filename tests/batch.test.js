import test from 'node:test';
import assert from 'node:assert/strict';
import { batchRun } from '../src/core/batch.js';

function deps(events, overrides = {}) {
  return {
    getChartState: async () => ({ symbol: 'NASDAQ:AAPL', resolution: '1D' }),
    setSymbol: async ({ symbol }) => { events.push(['symbol', symbol]); },
    setTimeframe: async ({ timeframe }) => { events.push(['timeframe', timeframe]); },
    waitForChartReady: async () => true,
    getOhlcv: async () => ({ close: 100 }),
    getStrategyResults: async (args) => { events.push(['strategy', args.entity_id]); return { net_profit: 1 }; },
    sleep: async () => {},
    ...overrides,
  };
}

test('batch restores the starting chart after successful iterations', async () => {
  const events = [];
  const result = await batchRun({
    symbols: ['NASDAQ:NVDA'],
    timeframes: ['60'],
    action: 'get_ohlcv',
    delay_ms: 0,
    _deps: deps(events),
  });
  assert.equal(result.success, true);
  assert.equal(result.restored_start_state, true);
  assert.deepEqual(events.slice(-2), [['symbol', 'NASDAQ:AAPL'], ['timeframe', '1D']]);
});

test('batch restores the starting chart even when an iteration fails', async () => {
  const events = [];
  const result = await batchRun({
    symbols: ['NASDAQ:NVDA'],
    action: 'get_ohlcv',
    delay_ms: 0,
    _deps: deps(events, { getOhlcv: async () => { throw new Error('renderer failed'); } }),
  });
  assert.equal(result.success, false);
  assert.equal(result.restored_start_state, true);
  assert.deepEqual(events.slice(-2), [['symbol', 'NASDAQ:AAPL'], ['timeframe', '1D']]);
});

test('batch fails an iteration when chart readiness times out', async () => {
  const events = [];
  let readCalled = false;
  const result = await batchRun({
    symbols: ['NASDAQ:NVDA'],
    timeframes: ['60'],
    action: 'get_ohlcv',
    delay_ms: 0,
    _deps: deps(events, {
      waitForChartReady: async () => false,
      getOhlcv: async () => { readCalled = true; return { close: 100 }; },
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].category, 'chart_loading');
  assert.match(result.results[0].error, /did not finish loading NASDAQ:NVDA at 60/);
  assert.equal(readCalled, false);
  assert.equal(result.restored_start_state, true);
  assert.deepEqual(events.slice(-2), [['symbol', 'NASDAQ:AAPL'], ['timeframe', '1D']]);
});

test('batch carries exact strategy entity ID into every strategy read', async () => {
  const events = [];
  await batchRun({
    symbols: ['NASDAQ:NVDA'],
    action: 'get_strategy_results',
    entity_id: 'strategy-123',
    delay_ms: 0,
    _deps: deps(events),
  });
  assert.ok(events.some((event) => event[0] === 'strategy' && event[1] === 'strategy-123'));
});

test('batch rejects empty or unbounded work before touching the chart', async () => {
  await assert.rejects(() => batchRun({ symbols: [], action: 'get_ohlcv' }), /1-100/);
  await assert.rejects(() => batchRun({ symbols: Array(100).fill('AAPL'), timeframes: Array(6).fill('D'), action: 'get_ohlcv' }), /500/);
});
