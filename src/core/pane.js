/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { symbolMatches } from '../wait.js';
import { strictResolve } from './_resolve.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';
const FOCUS_POLL_ATTEMPTS = 12;
const FOCUS_POLL_MS = 150;
const SYMBOL_POLL_ATTEMPTS = 20;
const SYMBOL_POLL_MS = 250;
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
 * WHICH PANE IS ACTUALLY ACTIVE, read independently of anything we just did.
 *
 * Resolved the same way list() does it: reference equality between the entries
 * in cwc.getAll() and the widget behind _activeChartWidgetWV. That is an
 * observation. `focused: idx` echoed back from the caller's own argument is not.
 *
 * Returns { index, total } or { index: null, total, reason } when the active
 * pane cannot be determined. A null index is NOT "pane 0"; treating an
 * unreadable state as a known one is how the wrong pane gets written to.
 */
async function _readActivePane(deps) {
  const observed = await deps.evaluate(`
    (function() {
      var cwc = ${CWC};
      var all;
      try { all = cwc.getAll(); } catch (e) { return { index: null, total: null, reason: 'getAll() threw: ' + e.message }; }
      var activeChart = null;
      try { activeChart = window.TradingViewApi._activeChartWidgetWV.value(); } catch (e) {}
      var activeWidget = activeChart && activeChart._chartWidget ? activeChart._chartWidget : null;
      if (!activeWidget) return { index: null, total: all.length, reason: 'no active chart widget' };
      for (var i = 0; i < all.length; i++) {
        if (all[i] === activeWidget) return { index: i, total: all.length };
      }
      return { index: null, total: all.length, reason: 'the active widget is not among the panes' };
    })()
  `);
  if (!observed || typeof observed !== 'object') {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Could not read which pane is active: the page returned nothing.',
    );
  }
  return observed;
}

/**
 * Symbol per pane index, plus whether that symbol actually RESOLVED.
 *
 * ms.symbol() is the label the chart was asked for, and it flips the instant
 * setSymbol is called. ms.symbolInfo() is the instrument the server resolved,
 * and it lands later or not at all. An earlier version of setSymbol below
 * polled the label only and reported verified: true on it, which meant it
 * confirmed a request rather than a result and returned while the pane was
 * still resolving. Anything acting in that window races the resolution, and a
 * pane whose symbol never resolves is the stuck-on-reconnect state described in
 * core/session_health.js.
 */
async function _paneSymbols(deps) {
  const rows = await deps.evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      var out = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var m = all[i].model ? all[i].model() : null;
          var ms = m ? m.mainSeries() : null;
          // symbolInfo() being non-null is NOT proof it describes the symbol
          // just requested. During a change the label flips first and
          // symbolInfo can still hold the PREVIOUS instrument, so a bare null
          // check reports the old symbol's resolution as the new one's.
          // Return what it actually resolved to and let the caller compare.
          var resolvedName = null;
          try {
            var si = ms ? ms.symbolInfo() : null;
            if (si) resolvedName = String(si.pro_name || si.full_name || si.name || '');
          } catch (e) { resolvedName = null; }
          out.push({
            index: i,
            symbol: ms ? ms.symbol() : null,
            resolved: resolvedName !== null,
            resolved_name: resolvedName
          });
        } catch (e) { out.push({ index: i, symbol: null, resolved: false, error: e.message }); }
      }
      return out;
    })()
  `);
  if (!Array.isArray(rows)) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Could not read pane symbols: the page returned nothing.');
  }
  const map = {};
  for (const r of rows) {
    map[r.index] = {
      symbol: r.symbol,
      resolved: !!r.resolved,
      resolved_name: r.resolved_name ?? null,
      // Captured one line earlier and then thrown away, so a pane whose
      // internals changed reported as "unreadable" with the real exception
      // deleted. Keep it.
      ...(r.error ? { read_error: r.error } : {}),
    };
  }
  return map;
}

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
/**
 * FOCUS USED TO REPORT A PANE IT NEVER CHECKED.
 *
 * It clicked _mainDiv and returned `focused: idx` straight from its own
 * argument. Whether the click landed, whether the div existed, whether the
 * chart honoured it: all three produced the same answer. That is the same
 * failure as the old tab_switch, which reported a switch it never performed
 * and left tab_close to close whatever happened to be active.
 *
 * It matters more here than it looks, because setSymbol() below calls focus()
 * and then writes to "the now-active chart". A focus that silently did nothing
 * meant pane_set_symbol(1, "X") overwrote pane 0.
 *
 * Click, then poll an independent read until the active pane really is the one
 * asked for, and refuse rather than report a move that did not happen.
 */
export async function focus({ index, _deps } = {}) {
  const idx = _paneIndex(index);
  const deps = _resolve(_deps);

  const before = await _readActivePane(deps);
  if (before.total != null && idx >= before.total) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Pane index ${idx} out of range (have ${before.total} pane(s)).`,
      { hint: 'Run pane_list and pass one of its zero-based pane indexes.' },
    );
  }
  if (before.index === idx) {
    return { success: true, focused_index: idx, total_panes: before.total, already_active: true, verified: true };
  }

  const clicked = await deps.evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      if (!chart._mainDiv) return { error: 'Pane ' + ${idx} + ' has no _mainDiv to click. TradingView internals changed.' };
      chart._mainDiv.click();
      return { clicked: true, total: all.length };
    })()
  `);
  if (!clicked || typeof clicked !== 'object') {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `Could not focus pane ${idx}: the page returned nothing.`);
  }
  if (clicked.error) {
    throw new ClassifiedError(
      /out of range/.test(clicked.error) ? CATEGORIES.INVALID_ARGUMENT : CATEGORIES.TV_UI_CHANGED,
      clicked.error,
    );
  }

  let last = before;
  for (let attempt = 1; attempt <= FOCUS_POLL_ATTEMPTS; attempt += 1) {
    await deps.wait(FOCUS_POLL_MS);
    last = await _readActivePane(deps);
    if (last.index === idx) {
      return { success: true, focused_index: idx, total_panes: last.total, verified: true, attempts: attempt };
    }
  }
  throw new ClassifiedError(
    CATEGORIES.TV_UI_CHANGED,
    `Clicked pane ${idx}, but after ${(FOCUS_POLL_ATTEMPTS * FOCUS_POLL_MS) / 1000}s the active pane is ` +
    `${last.index === null ? `still unreadable (${last.reason})` : last.index}. The focus did not take, so nothing that ` +
    'depends on it (pane_set_symbol, anything acting on "the active chart") should be trusted to hit pane ' + idx + '.',
  );
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

  // THIS FUNCTION USED TO WRITE BLIND TO WHATEVER WAS ACTIVE.
  //
  // It called focus(), waited 300ms, and set the symbol on
  // _activeChartWidgetWV, then returned { success: true, symbol } echoing back
  // the caller's own argument. Nothing checked that the focus landed, that the
  // symbol changed, or that it changed on the requested pane. Since focus()
  // also reported success without looking, a silently failed click meant
  // pane_set_symbol(1, "X") rewrote pane 0 and said it had done pane 1.
  //
  // Record every pane's symbol first, so afterwards we can say not only "the
  // target changed" but "nothing else did".
  const before = await _paneSymbols(deps);
  if (!(idx in before)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Pane index ${idx} out of range (have ${Object.keys(before).length} pane(s)).`,
      { hint: 'Run pane_list and pass one of its zero-based pane indexes.' },
    );
  }

  // focus() now throws when the pane did not actually become active, so this
  // is a gate rather than a formality.
  await focus({ index: idx, _deps });
  const active = await _readActivePane(deps);
  if (active.index !== idx) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `Refusing to set a symbol: pane ${idx} was focused but pane ` +
      `${active.index === null ? 'unknown' : active.index} is active. Writing now would change the wrong chart.`,
    );
  }

  await deps.evaluateAsync(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(cleanSymbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  let after = before;
  let matched = false;
  for (let attempt = 1; attempt <= SYMBOL_POLL_ATTEMPTS; attempt += 1) {
    await deps.wait(SYMBOL_POLL_MS);
    after = await _paneSymbols(deps);
    // THREE conditions, because two were not enough. The label matching says
    // the request was accepted. Something being resolved says the chart has AN
    // instrument. Only the resolved instrument matching the request says it has
    // THE one that was asked for: during a change the label flips first while
    // symbolInfo still holds the previous instrument, and checking only that it
    // is non-null reports the old symbol's resolution as the new one's.
    // after[idx] can be absent: a setLayout or a pane collapse during the poll
    // removes the pane out from under us. Without the guard that is a raw
    // TypeError escaping a function that otherwise keeps its error taxonomy,
    // and the failure path below already uses ?. for the same reason.
    const row = after[idx];
    if (!row) {
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        `Pane ${idx} disappeared while waiting for "${cleanSymbol}" to load. The layout changed underneath this call.`,
        { hint: 'Run pane_list to see the current layout before retrying.' },
      );
    }
    if (symbolMatches(row.symbol, cleanSymbol)
        && row.resolved
        && symbolMatches(row.resolved_name, cleanSymbol)) { matched = true; break; }
  }

  // Say what moved that should not have, whether or not the target took. A
  // collateral change is the more serious finding of the two.
  const collateral = Object.keys(after)
    .map(Number)
    .filter((i) => i !== idx && String(before[i]?.symbol ?? '') !== String(after[i]?.symbol ?? ''))
    .map((i) => ({ index: i, was: before[i]?.symbol ?? null, now: after[i]?.symbol ?? null }));

  if (collateral.length > 0) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `Setting pane ${idx} to "${cleanSymbol}" also changed ${collateral.length} other pane(s): ` +
      collateral.map((c) => `pane ${c.index} ${c.was} -> ${c.now}`).join(', ') +
      '. The write did not go where it was aimed.',
    );
  }

  if (!matched) {
    const labelOk = symbolMatches(after[idx]?.symbol, cleanSymbol);
    const secs = (SYMBOL_POLL_ATTEMPTS * SYMBOL_POLL_MS) / 1000;
    const stale = labelOk && after[idx]?.resolved
      && !symbolMatches(after[idx].resolved_name, cleanSymbol);
    throw new ClassifiedError(
      CATEGORIES.CHART_LOADING,
      stale
        ? `Pane ${idx} reads "${after[idx].symbol}" but after ${secs}s the instrument it has resolved is ` +
          `still "${after[idx].resolved_name}". The label changed and the data did not.`
        : labelOk
          ? `Pane ${idx} now reads "${after[idx].symbol}" but the symbol never RESOLVED after ${secs}s: ` +
            'the chart has the label without the instrument.'
          : `Set pane ${idx} to "${cleanSymbol}" but after ${secs}s it still reads ` +
            `"${after[idx]?.symbol ?? 'unreadable'}"` +
            `${after[idx]?.read_error ? ` (reading it threw: ${after[idx].read_error})` : ''}.`,
      {
        hint: labelOk
          ? 'A pane with a label but no resolved symbol is the stuck-on-reconnect state. Run tv_chart_health.'
          : 'The symbol may not exist on this account, or the chart is still loading. Run pane_list to see the current state.',
      },
    );
  }

  return {
    success: true,
    index: idx,
    // The symbol TradingView settled on, which may be qualified: ask for
    // BTCUSDT and get BINANCE:BTCUSDT. Report both rather than echoing the
    // request as though it were the result.
    symbol: after[idx].symbol,
    requested: cleanSymbol,
    previous: before[idx]?.symbol ?? null,
    // verified means the instrument resolved, not merely that the label changed.
    verified: true,
    symbol_resolved: true,
    // The instrument the server actually resolved, which is what proves the
    // data behind the label is the data that was asked for.
    resolved_name: after[idx].resolved_name,
    other_panes_unchanged: true,
  };
}
