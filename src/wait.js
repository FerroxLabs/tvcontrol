import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
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

        // Get current symbol from header
        var symbolEl = document.querySelector('[data-name="legend-source-title"]')
          || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
        var currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check symbol match if expected
    if (expectedSymbol && state.currentSymbol && !state.currentSymbol.toUpperCase().includes(expectedSymbol.toUpperCase())) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
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

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — caller MUST check the return value and treat false as
  // "chart never stabilized". The previous comment claimed "return true
  // anyway" but the code returned false; callers that ignored the boolean
  // (notably the sweep loop) silently produced metrics from half-loaded
  // charts.
  return false;
}
