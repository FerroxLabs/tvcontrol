import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForChartReady } from '../src/wait.js';

test('waitForChartReady accepts TradingView canonical exchange prefixes', async () => {
  const states = [
    { isLoading: false, barCount: 100, currentSymbol: 'NASDAQ:MSFT', currentTf: '1D' },
    { isLoading: false, barCount: 100, currentSymbol: 'NASDAQ:MSFT', currentTf: '1D' },
    { isLoading: false, barCount: 100, currentSymbol: 'NASDAQ:MSFT', currentTf: '1D' },
  ];
  const ready = await waitForChartReady('MSFT', '1D', 1000, {
    evaluate: async () => states.shift() || states.at(-1),
    sleep: async () => {},
  });
  assert.equal(ready, true);
});

test('waitForChartReady rejects a stable chart on the wrong timeframe', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => { now += 250; return now; };
  try {
    const ready = await waitForChartReady('NASDAQ:MSFT', '60', 1000, {
      evaluate: async () => ({ isLoading: false, barCount: 100, currentSymbol: 'NASDAQ:MSFT', currentTf: '1D' }),
      sleep: async () => {},
    });
    assert.equal(ready, false);
  } finally {
    Date.now = originalNow;
  }
});

test('waitForChartReady does not accept a missing symbol when one is expected', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => { now += 250; return now; };
  try {
    const ready = await waitForChartReady('NASDAQ:MSFT', '1D', 1000, {
      evaluate: async () => ({ isLoading: false, barCount: 100, currentSymbol: '', currentTf: '1D' }),
      sleep: async () => {},
    });
    assert.equal(ready, false);
  } finally {
    Date.now = originalNow;
  }
});

test('waitForChartReady keeps exchange-qualified symbols distinct', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => { now += 250; return now; };
  try {
    const ready = await waitForChartReady('NYSE:AAPL', '1D', 1000, {
      evaluate: async () => ({ isLoading: false, barCount: 100, currentSymbol: 'NASDAQ:AAPL', currentTf: '1D' }),
      sleep: async () => {},
    });
    assert.equal(ready, false);
  } finally {
    Date.now = originalNow;
  }
});
