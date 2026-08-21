/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { strictResolve } from './_resolve.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';
const _PANE_DEPS = new Set(['evaluate', 'evaluateAsync', 'wait']);

function _resolve(deps) {
  strictResolve(deps, _PANE_DEPS);
  return {
    evaluate,
    evaluateAsync,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...deps,
  };
}

function _paneIndex(index) {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Pane index must be a non-negative integer; received ${JSON.stringify(index)}`,
      { hint: 'Run pane_list and pass one of its zero-based pane indexes.' },
    );
  }
  return value;
}

const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list({ _deps } = {}) {
  const deps = _resolve(_deps);
  const result = await deps.evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();

      // Resolve the active pane's underlying chart widget so we can mark
      // each pane active: true/false by reference equality.
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeWidget = activeChart && activeChart._chartWidget ? activeChart._chartWidget : null;

      var panes = [];
      var activeIndex = null;
      for (var i = 0; i < all.length; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          var isActive = activeWidget ? (c === activeWidget) : false;
          if (isActive) activeIndex = i;
          panes.push({ index: i, symbol: sym, resolution: res || null, active: isActive });
        } catch(e) { panes.push({ index: i, error: e.message, active: false }); }
      }

      // THREE SOURCES THAT CAN DISAGREE, AND TWO OF THEM GO STALE.
      // layoutType comes from cwc._layoutType, count from cwc.inlineChartsCount,
      // and panes from cwc.getAll(). MEASURED 2026-08-21: a live 2-pane layout
      // reported layoutType "s" and inlineChartsCount 1 while getAll() returned
      // two chart widgets. getAll() is the only one describing what is actually
      // on screen, so it is the authority; the other two are reported as claims.
      return {
        layout: layoutType,
        chart_count: count,
        real_pane_count: all.length,
        active_index: activeIndex,
        panes: panes
      };
    })()
  `);

  // Trust the widgets that exist over the layout code that claims to describe
  // them. Feeding a stale "s" back into setLayout collapses a multi-pane layout,
  // which is exactly how state_restore destroyed one.
  // Only override the reported count when there is an OBSERVATION to override
  // it with. An empty panes array is the absence of evidence, not evidence of
  // zero charts — falling back to 0 there would replace one wrong number with a
  // worse one.
  const observed = result.real_pane_count ?? ((result.panes || []).length || null);
  const realCount = observed ?? result.chart_count;
  const codeDisagrees = observed !== null && result.chart_count !== observed;

  return {
    success: true,
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: realCount,
    active_index: result.active_index,
    panes: result.panes,
    // Say plainly when the layout CODE cannot be trusted, so no caller feeds it
    // back into setLayout and collapses the layout.
    layout_code_reliable: !codeDisagrees,
    ...(codeDisagrees
      ? {
        reported_chart_count: result.chart_count,
        layout_warning: `TradingView reports layout "${result.layout}" with ${result.chart_count} chart(s), but ${realCount} chart widget(s) actually exist. The layout code is stale. Do NOT pass it to pane_set_layout or snapshot it as authoritative.`,
      }
      : {}),
  };
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout, _deps } = {}) {
  const deps = _resolve(_deps);
  if (typeof layout !== 'string' || !layout.trim()) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'layout is required');
  }
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Unknown layout "${layout}".`,
      { hint: `Available layouts:\n${available}` },
    );
  }

  await deps.evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await deps.wait(500);

  const state = await list({ _deps });
  return {
    success: true,
    layout: resolved,
    layout_name: LAYOUT_NAMES[resolved],
    chart_count: state.chart_count,
    panes: state.panes,
  };
}

/**
 * Focus a specific pane by index.
 */
export async function focus({ index, _deps } = {}) {
  const idx = _paneIndex(index);
  const deps = _resolve(_deps);
  const result = await deps.evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      // Click the main div to activate it
      if (chart._mainDiv) chart._mainDiv.click();
      return { focused: ${idx}, total: all.length };
    })()
  `);

  if (result?.error) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, result.error);
  return { success: true, focused_index: result.focused, total_panes: result.total };
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export async function setSymbol({ index, symbol, _deps } = {}) {
  const idx = _paneIndex(index);
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbol is required');
  const deps = _resolve(_deps);

  // Focus the target pane first
  await focus({ index: idx, _deps });
  await deps.wait(300);

  // Now set symbol on the now-active chart
  await deps.evaluateAsync(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(cleanSymbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  return { success: true, index: idx, symbol: cleanSymbol };
}
