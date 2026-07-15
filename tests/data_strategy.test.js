import test from 'node:test';
import assert from 'node:assert/strict';
import { getStrategyResults, getTrades, getEquity, getQuote } from '../src/core/data.js';

function strategyDeps(finalResult) {
  return {
    wait: async () => {},
    openPanel: async () => ({ success: true }),
    evaluate: async (expression) => {
      if (expression.includes('return unhideStrategies(')) return ['Hidden Strategy'];
      if (expression.includes("return found.report && found.report.performance")) return 'ready';
      return finalResult;
    },
  };
}

test('getStrategyResults returns real report metrics and reports auto-unhidden strategies', async () => {
  const result = await getStrategyResults({
    _deps: strategyDeps({
      hasStrategy: true,
      strategy: 'Debit Spread Model',
      strategy_count: 1,
      source: 'internal_api',
      metrics: { netProfit: 1250, totalTrades: 12 },
    }),
  });
  assert.equal(result.success, true);
  assert.equal(result.strategy, 'Debit Spread Model');
  assert.equal(result.metrics.netProfit, 1250);
  assert.deepEqual(result.unhidden_strategies, ['Hidden Strategy']);
});

test('getStrategyResults binds every page read to the requested strategy entity ID', async () => {
  const expressions = [];
  const result = await getStrategyResults({
    entity_id: 'st_target_42',
    _deps: {
      wait: async () => {},
      openPanel: async () => ({ success: true }),
      evaluate: async (expression) => {
        expressions.push(expression);
        if (expression.includes('return unhideStrategies(requestedId)')) return [];
        if (expression.includes("return found.report && found.report.performance")) return 'ready';
        return {
          hasStrategy: true,
          entity_id: 'st_target_42',
          strategy: 'Target Strategy',
          strategy_count: 2,
          source: 'internal_api',
          metrics: { netProfit: 42 },
        };
      },
    },
  });

  assert.equal(result.entity_id, 'st_target_42');
  assert.equal(result.metrics.netProfit, 42);
  assert.ok(expressions.length >= 3);
  assert.ok(expressions.every((expression) => expression.includes('st_target_42')));
});

test('getTrades returns the latest bounded orders from the selected strategy', async () => {
  const expressions = [];
  const result = await getTrades({
    max_trades: 2,
    entity_id: 'st_credit_7',
    _deps: {
      ...strategyDeps(),
      evaluate: async (expression) => {
        expressions.push(expression);
        if (expression.includes('return unhideStrategies(requestedId)')) return [];
        if (expression.includes("return found.report && found.report.performance")) return 'ready';
        return {
          trades: [{ id: 2 }, { id: 3 }],
          total_orders: 3,
          entity_id: 'st_credit_7',
          strategy: 'Credit Spread Model',
          source: 'internal_api',
        };
      },
    },
  });
  assert.equal(result.count, 2);
  assert.equal(result.total_orders, 3);
  assert.equal(result.entity_id, 'st_credit_7');
  assert.equal(result.strategy, 'Credit Spread Model');
  assert.ok(expressions.every((expression) => expression.includes('st_credit_7')));
});

test('getEquity binds readiness and data reads to the requested strategy', async () => {
  const expressions = [];
  const result = await getEquity({
    entity_id: 'st_equity_9',
    _deps: {
      wait: async () => {},
      openPanel: async () => ({ success: true }),
      evaluate: async (expression) => {
        expressions.push(expression);
        if (expression.includes('return unhideStrategies(requestedId)')) return [];
        if (expression.includes("return found.report && found.report.performance")) return 'ready';
        return {
          data: [{ time: 1, equity: 100 }],
          entity_id: 'st_equity_9',
          strategy: 'Equity Target',
          source: 'internal_api',
        };
      },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.entity_id, 'st_equity_9');
  assert.ok(expressions.every((expression) => expression.includes('st_equity_9')));
});

test('getTrades rejects an invalid direct-call limit before opening TradingView', async () => {
  let opened = false;
  await assert.rejects(
    getTrades({
      max_trades: -1,
      _deps: {
        ...strategyDeps({ trades: [] }),
        openPanel: async () => { opened = true; },
      },
    }),
    (error) => error.category === 'invalid_argument' && /1 to 20/.test(error.message),
  );
  assert.equal(opened, false);
});

test('getQuote temporarily switches symbols and always restores the original chart', async () => {
  const switched = [];
  const result = await getQuote({
    symbol: 'MSFT',
    _deps: {
      openPanel: async () => {},
      wait: async () => {},
      waitForChartReady: async () => true,
      evaluateAsync: async (expression) => {
        const match = expression.match(/setSymbol\(("(?:[^"\\]|\\.)*")/);
        if (match) switched.push(JSON.parse(match[1]));
      },
      evaluate: async (expression) => {
        if (expression.trim().endsWith('.symbol()')) return 'NASDAQ:AAPL';
        return { symbol: 'NASDAQ:MSFT', last: 420.5, close: 420.5 };
      },
    },
  });
  assert.equal(result.symbol, 'NASDAQ:MSFT');
  assert.equal(result.restored_start_state, true);
  assert.deepEqual(switched, ['MSFT', 'NASDAQ:AAPL']);
});

test('getQuote surfaces a restore failure instead of silently hiding chart drift', async () => {
  let calls = 0;
  const result = await getQuote({
    symbol: 'MSFT',
    _deps: {
      openPanel: async () => {},
      wait: async () => {},
      waitForChartReady: async () => true,
      evaluateAsync: async () => {
        calls++;
        if (calls === 2) throw new Error('restore failed');
      },
      evaluate: async (expression) => expression.trim().endsWith('.symbol()')
        ? 'NASDAQ:AAPL'
        : { symbol: 'NASDAQ:MSFT', last: 420.5, close: 420.5 },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.restored_start_state, false);
  assert.match(result.restore_error.error, /restore failed/);
});

test('getQuote reports an incomplete restore when the original chart never becomes ready', async () => {
  let readinessChecks = 0;
  const result = await getQuote({
    symbol: 'MSFT',
    _deps: {
      openPanel: async () => {},
      wait: async () => {},
      waitForChartReady: async () => ++readinessChecks === 1,
      evaluateAsync: async () => {},
      evaluate: async (expression) => expression.trim().endsWith('.symbol()')
        ? 'NASDAQ:AAPL'
        : { symbol: 'NASDAQ:MSFT', last: 420.5, close: 420.5 },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.restored_start_state, false);
  assert.equal(result.restore_error.category, 'chart_loading');
  assert.match(result.restore_error.error, /did not finish restoring/);
});

test('getQuote restores the original chart even when the requested symbol times out', async () => {
  const switched = [];
  await assert.rejects(
    getQuote({
      symbol: 'MSFT',
      _deps: {
        openPanel: async () => {},
        wait: async () => {},
        waitForChartReady: async (symbol) => symbol === 'NASDAQ:AAPL',
        evaluateAsync: async (expression) => {
          const match = expression.match(/setSymbol\(("(?:[^"\\]|\\.)*")/);
          if (match) switched.push(JSON.parse(match[1]));
        },
        evaluate: async (expression) => expression.trim().endsWith('.symbol()') ? 'NASDAQ:AAPL' : null,
      },
    }),
    (error) => error.category === 'chart_loading',
  );
  assert.deepEqual(switched, ['MSFT', 'NASDAQ:AAPL']);
});

test('getQuote refuses to mutate the chart when the starting symbol is unavailable', async () => {
  let switched = false;
  await assert.rejects(
    getQuote({
      symbol: 'MSFT',
      _deps: {
        openPanel: async () => {},
        wait: async () => {},
        waitForChartReady: async () => true,
        evaluateAsync: async () => { switched = true; },
        evaluate: async () => null,
      },
    }),
    (error) => error.category === 'chart_loading' && /starting chart symbol/.test(error.message),
  );
  assert.equal(switched, false);
});

test('getQuote switches when qualified tickers match but exchanges differ', async () => {
  const switched = [];
  const result = await getQuote({
    symbol: 'NYSE:AAPL',
    _deps: {
      openPanel: async () => {},
      wait: async () => {},
      waitForChartReady: async () => true,
      evaluateAsync: async (expression) => {
        const match = expression.match(/setSymbol\(("(?:[^"\\]|\\.)*")/);
        if (match) switched.push(JSON.parse(match[1]));
      },
      evaluate: async (expression) => expression.trim().endsWith('.symbol()')
        ? 'NASDAQ:AAPL'
        : { symbol: 'NYSE:AAPL', last: 100, close: 100 },
    },
  });
  assert.equal(result.restored_start_state, true);
  assert.deepEqual(switched, ['NYSE:AAPL', 'NASDAQ:AAPL']);
});

test('getQuote reports chart drift when quote loading and restoration both fail', async () => {
  await assert.rejects(
    getQuote({
      symbol: 'MSFT',
      _deps: {
        openPanel: async () => {},
        wait: async () => {},
        waitForChartReady: async () => false,
        evaluateAsync: async () => {},
        evaluate: async (expression) => expression.trim().endsWith('.symbol()') ? 'NASDAQ:AAPL' : null,
      },
    }),
    (error) => error.category === 'api_unexpected'
      && /did not finish loading/.test(error.message)
      && /restoration also failed/.test(error.message)
      && /Verify the active symbol/.test(error.hint),
  );
});
