import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForChartReady, symbolMatches } from '../src/wait.js';

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

describe('symbolMatches asymmetry', () => {
  it('accepts a bare request that the chart qualified', () => {
    // Ask for BTCUSDT, chart reports BINANCE:BTCUSDT. Normal, and a match.
    assert.equal(symbolMatches('BINANCE:BTCUSDT', 'BTCUSDT'), true);
    assert.equal(symbolMatches('NASDAQ:AAPL', 'aapl'), true);
  });

  it('REFUSES a bare label when the caller named an exchange', () => {
    // Flagged by an external audit. If the caller said NASDAQ:AAPL they meant
    // NASDAQ, and an unqualified AAPL on the chart could be anything.
    // waitForChartReady would have confirmed the load either way.
    assert.equal(symbolMatches('AAPL', 'NASDAQ:AAPL'), false);
  });

  it('still refuses two different exchanges', () => {
    assert.equal(symbolMatches('NYSE:AAPL', 'NASDAQ:AAPL'), false);
  });

  it('matches identical symbols and treats an empty expectation as satisfied', () => {
    assert.equal(symbolMatches('NASDAQ:AAPL', 'NASDAQ:AAPL'), true);
    assert.equal(symbolMatches('anything', null), true);
    assert.equal(symbolMatches(null, 'NASDAQ:AAPL'), false);
  });
});
