import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

/**
 * Is `current` the symbol that `expected` asked for?
 *
 * TradingView qualifies a bare ticker: ask for BTCUSDT and the chart reports
 * BINANCE:BTCUSDT. An exact string compare would call that a failure. Two
 * DIFFERENTLY qualified symbols are still a mismatch, so NASDAQ:AAPL never
 * matches NYSE:AAPL.
 *
 * Exported so pane.js verifies a symbol change by the same rule this file uses.
 * A second copy of this logic somewhere else is a second copy to drift.
 */
export function symbolMatches(current, expected) {
  return _symbolMatches(current, expected);
}

function _symbolMatches(current, expected) {
  if (!expected) return true;
  if (!current) return false;
  const normalize = (value) => String(value).trim().toUpperCase();
  const currentFull = normalize(current);
  const expectedFull = normalize(expected);
  if (currentFull === expectedFull) return true;
  const currentQualified = currentFull.includes(':');
  const expectedQualified = expectedFull.includes(':');
  if (currentQualified && expectedQualified) return false;
  const currentBare = currentFull.split(':').pop();
  const expectedBare = expectedFull.split(':').pop();
  return currentBare === expectedBare;
}

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT, _deps = {}) {
  const evaluatePage = _deps.evaluate || evaluate;
  const sleep = _deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluatePage(`
      (function() {
        // Check for loading spinner. offsetParent is null for position:fixed
        // elements even when visible, so a fixed overlay spinner would read as
        // "not loading" — check computed style instead of relying on offsetParent.
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = false;
        if (spinner) {
          var cs = window.getComputedStyle(spinner);
          isLoading = cs.display !== 'none' && cs.visibility !== 'hidden'
            && (spinner.offsetParent !== null || cs.position === 'fixed');
        }

        // Prefer the REAL series bar count from the chart model. The old DOM
        // scan of [class*="bar"] also matched toolbar/sidebar/scrollbar chrome,
        // which is stable from the first paint and gave a false "ready".
        var barCount = -1;
        try {
          var api = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
            && window.TradingViewApi._activeChartWidgetWV.value
            && window.TradingViewApi._activeChartWidgetWV.value();
          if (api && api._chartWidget) {
            var seriesBars = api._chartWidget.model().mainSeries().bars();
            if (seriesBars && typeof seriesBars.size === 'function') barCount = seriesBars.size();
          }
        } catch {}
        if (barCount === -1) {
          // Fallback only when the chart API isn't ready yet.
          try { barCount = document.querySelectorAll('[class*="bar"]').length; } catch {}
        }

        // Prefer canonical values from the chart API. Header text may be a
        // company description rather than a ticker and causes false timeouts.
        var symbolEl = document.querySelector('[data-name="legend-source-title"]')
          || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
        var currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';
        var currentTf = '';
        try {
          if (api) {
            currentSymbol = api.symbol() || currentSymbol;
            currentTf = api.resolution() || '';
          }
        } catch(e) {}

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol, currentTf: currentTf };
      })()
    `);

    if (!state) {
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Check symbol match if expected
    if (!_symbolMatches(state.currentSymbol, expectedSymbol)) {
      stableCount = 0;
      await sleep(POLL_INTERVAL);
      continue;
    }

    if (expectedTf && state.currentTf && String(state.currentTf).toUpperCase() !== String(expectedTf).toUpperCase()) {
      stableCount = 0;
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await sleep(POLL_INTERVAL);
  }

  // Timeout — caller MUST check the return value and treat false as
  // "chart never stabilized". The previous comment claimed "return true
  // anyway" but the code returned false; callers that ignored the boolean
  // (notably the sweep loop) silently produced metrics from half-loaded
  // charts.
  return false;
}

/**
 * Wait until the visible chart has a stable symbol, resolution, and canvas
 * size. This prevents screenshots taken immediately after navigation from
 * capturing the previous symbol or an intermediate loading frame.
 */
export async function waitForChartRender(timeout = 5000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var symbol = '', resolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          symbol = chart.symbol();
          resolution = chart.resolution();
        } catch(e) {}
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var loading = false;
        if (spinner) {
          var cs = window.getComputedStyle(spinner);
          loading = cs.display !== 'none' && cs.visibility !== 'hidden'
            && (spinner.offsetParent !== null || cs.position === 'fixed');
        }
        return {
          symbol: symbol,
          resolution: resolution,
          isLoading: loading,
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    if (!state || state.isLoading || !state.canvasWidth || !state.canvasHeight) {
      stableCount = 0;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const signature = [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|');
    if (signature === lastSignature) stableCount++;
    else {
      lastSignature = signature;
      stableCount = 0;
    }
    if (stableCount >= 3) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return false;
}
