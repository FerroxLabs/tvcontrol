import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { focus, list, setLayout, setSymbol } from '../src/core/pane.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

const paneDeps = ({ evaluate, evaluateAsync } = {}) => ({
  evaluate: evaluate || (async () => undefined),
  evaluateAsync: evaluateAsync || (async () => undefined),
  wait: async () => {},
});


/**
 * A mock TradingView with panes that behave.
 *
 * The old tests handed focus() a stub returning { focused: 1, total: 2 } and
 * asserted it came back out. That could not distinguish a focus that worked
 * from one that did nothing, which is precisely the bug those functions had.
 *
 * This models the two things that matter: which pane is active, and what each
 * pane's symbol is. `focusWorks: false` reproduces the silent no-op click.
 * `writesToPane` sends the symbol write somewhere other than the active pane,
 * reproducing the collateral damage.
 */
function mockPage({ symbols = ['NASDAQ:AAPL', 'NASDAQ:NVDA'], active = 0, focusWorks = true, writesToPane = null } = {}) {
  const state = { symbols: [...symbols], active };
  const calls = [];
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('_mainDiv.click()')) {
      const m = /all\[(\d+)\]/.exec(expr);
      const want = m ? Number(m[1]) : null;
      if (want !== null && want >= state.symbols.length) return { error: `Pane index ${want} out of range (have ${state.symbols.length} panes)` };
      if (focusWorks && want !== null) state.active = want;
      return { clicked: true, total: state.symbols.length };
    }
    if (expr.includes('the active widget is not among the panes')) {
      return { index: state.active, total: state.symbols.length };
    }
    if (expr.includes('mainSeries()') && expr.includes('out.push')) {
      return state.symbols.map((symbol, index) => ({ index, symbol }));
    }
    return undefined;
  };
  const evaluateAsync = async (expr) => {
    calls.push(expr);
    const m = /setSymbol\("([^"]+)"/.exec(expr);
    if (m) {
      const target = writesToPane === null ? state.active : writesToPane;
      state.symbols[target] = m[1];
    }
  };
  return { _deps: { evaluate, evaluateAsync, wait: async () => {} }, state, calls };
}

describe('pane management', () => {
  it('lists panes and maps the friendly layout name', async () => {
    const result = await list({
      _deps: paneDeps({
        evaluate: async () => ({
          layout: '2h', chart_count: 2, active_index: 1,
          panes: [
            { index: 0, symbol: 'NASDAQ:AAPL', resolution: 'D', active: false },
            { index: 1, symbol: 'NASDAQ:NVDA', resolution: 'D', active: true },
          ],
        }),
      }),
    });
    assert.equal(result.success, true);
    assert.equal(result.layout_name, '2 horizontal');
    assert.equal(result.active_index, 1);
    assert.equal(result.panes.length, 2);
  });

  it('sets a valid layout and returns the resulting pane state', async () => {
    const expressions = [];
    const result = await setLayout({
      layout: '2x2',
      _deps: paneDeps({
        evaluateAsync: async (expression) => expressions.push(expression),
        evaluate: async () => ({ layout: '4', chart_count: 4, active_index: 0, panes: [] }),
      }),
    });
    assert.equal(result.layout, '4');
    assert.equal(result.chart_count, 4);
    assert.match(expressions[0], /setLayout\("4"\)/);
  });

  it('focuses a valid pane index and confirms it from an independent read', async () => {
    const page = mockPage({ active: 0 });
    const result = await focus({ index: 1, _deps: page._deps });
    assert.equal(result.success, true);
    assert.equal(result.focused_index, 1);
    assert.equal(result.total_panes, 2);
    assert.equal(result.verified, true);
    assert.equal(page.state.active, 1, 'the page really moved');
  });

  it('returns already_active without clicking when the pane is the active one', async () => {
    const page = mockPage({ active: 1 });
    const result = await focus({ index: 1, _deps: page._deps });
    assert.equal(result.already_active, true);
    assert.equal(result.verified, true);
    assert.ok(!page.calls.some((c) => c.includes('_mainDiv.click()')), 'no need to click');
  });

  it('THROWS when the click does nothing, instead of reporting the focus it was asked for', async () => {
    // The original returned { focused: 1 } here, echoing the caller's argument.
    const page = mockPage({ active: 0, focusWorks: false });
    await assert.rejects(
      focus({ index: 1, _deps: page._deps }),
      (err) => err instanceof ClassifiedError
        && err.category === CATEGORIES.TV_UI_CHANGED
        && /the active pane is 0/.test(err.message)
        && /pane_set_symbol/.test(err.message),
    );
  });

  it('throws when the active pane cannot be read at all, rather than assuming pane 0', async () => {
    const _deps = {
      evaluate: async (expr) => (expr.includes('the active widget is not among the panes')
        ? { index: null, total: 2, reason: 'no active chart widget' }
        : { clicked: true, total: 2 }),
      evaluateAsync: async () => {},
      wait: async () => {},
    };
    await assert.rejects(
      focus({ index: 1, _deps }),
      /still unreadable \(no active chart widget\)/,
    );
  });

  for (const index of ['hello', -1, 1.5, Number.NaN, undefined]) {
    it(`rejects invalid pane index ${String(index)}`, async () => {
      await assert.rejects(
        focus({ index, _deps: paneDeps() }),
        (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
      );
    });
  }

  it('classifies an out-of-range pane index as invalid_argument', async () => {
    await assert.rejects(
      focus({ index: 4, _deps: paneDeps({ evaluate: async () => ({ error: 'Pane index 4 out of range' }) }) }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('trims the symbol, writes to the requested pane, and proves it landed', async () => {
    const page = mockPage({ symbols: ['NASDAQ:TSLA', 'NASDAQ:NVDA'], active: 1 });
    const result = await setSymbol({ index: 0, symbol: ' NASDAQ:AAPL ', _deps: page._deps });
    assert.match(page.calls.find((c) => c.includes('setSymbol(')), /setSymbol\("NASDAQ:AAPL"/);
    assert.equal(result.success, true);
    assert.equal(result.index, 0);
    assert.equal(result.symbol, 'NASDAQ:AAPL');
    assert.equal(result.previous, 'NASDAQ:TSLA');
    assert.equal(result.verified, true);
    assert.equal(result.other_panes_unchanged, true);
    assert.deepEqual(page.state.symbols, ['NASDAQ:AAPL', 'NASDAQ:NVDA']);
  });

  it('accepts a bare ticker that TradingView qualifies, and reports what it settled on', async () => {
    const page = mockPage({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'], active: 0 });
    page._deps.evaluateAsync = async (expr) => {
      const m = /setSymbol\("([^"]+)"/.exec(expr);
      if (m) page.state.symbols[page.state.active] = `BINANCE:${m[1]}`;
    };
    const result = await setSymbol({ index: 0, symbol: 'BTCUSDT', _deps: page._deps });
    assert.equal(result.requested, 'BTCUSDT');
    assert.equal(result.symbol, 'BINANCE:BTCUSDT', 'report what the chart settled on, not the request');
  });

  it('REFUSES TO WRITE when the focus did not take, so the wrong pane is never changed', async () => {
    // This is the whole point. Old behaviour: focus silently fails, the write
    // goes to whatever was active, and success is reported for the wrong pane.
    const page = mockPage({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'], active: 0, focusWorks: false });
    await assert.rejects(setSymbol({ index: 1, symbol: 'NASDAQ:TSLA', _deps: page._deps }));
    assert.deepEqual(page.state.symbols, ['NASDAQ:AAPL', 'NASDAQ:NVDA'], 'nothing was written anywhere');
  });

  it('catches a write that landed on another pane and names what moved', async () => {
    const page = mockPage({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'], active: 0, writesToPane: 1 });
    await assert.rejects(
      setSymbol({ index: 0, symbol: 'NASDAQ:TSLA', _deps: page._deps }),
      (err) => err instanceof ClassifiedError
        && /also changed 1 other pane/.test(err.message)
        && /pane 1 NASDAQ:NVDA -> NASDAQ:TSLA/.test(err.message),
    );
  });

  it('throws when the symbol never appears, rather than echoing the request back', async () => {
    const page = mockPage({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'], active: 0 });
    page._deps.evaluateAsync = async () => {};  // the write silently does nothing
    await assert.rejects(
      setSymbol({ index: 0, symbol: 'NASDAQ:TSLA', _deps: page._deps }),
      /it still reads "NASDAQ:AAPL"/,
    );
  });

  it('re-checks the active pane between focusing and writing, and refuses if it moved', async () => {
    // focus() succeeds, then something else takes focus before the write. The
    // window is small but the consequence is writing to the wrong chart, and
    // the old code had no check here at all: it focused, waited 300ms, and
    // wrote to whatever _activeChartWidgetWV happened to be by then.
    const page = mockPage({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'], active: 0 });
    let activeReads = 0;
    const realEvaluate = page._deps.evaluate;
    page._deps.evaluate = async (expr) => {
      const out = await realEvaluate(expr);
      if (expr.includes('the active widget is not among the panes')) {
        activeReads += 1;
        // The read that focus() uses to confirm says pane 1. The next one,
        // taken by setSymbol just before it writes, says focus has been stolen.
        if (activeReads >= 3) return { index: 0, total: 2 };
      }
      return out;
    };
    await assert.rejects(
      setSymbol({ index: 1, symbol: 'NASDAQ:TSLA', _deps: page._deps }),
      (err) => err instanceof ClassifiedError
        && err.category === CATEGORIES.TV_UI_CHANGED
        && /Refusing to set a symbol/.test(err.message)
        && /pane 0 is active/.test(err.message),
    );
    assert.deepEqual(page.state.symbols, ['NASDAQ:AAPL', 'NASDAQ:NVDA'], 'nothing was written');
  });

  it('rejects an out-of-range pane before touching anything', async () => {
    const page = mockPage({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'] });
    await assert.rejects(
      setSymbol({ index: 5, symbol: 'NASDAQ:TSLA', _deps: page._deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT && /out of range/.test(err.message),
    );
    assert.deepEqual(page.state.symbols, ['NASDAQ:AAPL', 'NASDAQ:NVDA']);
  });

  it('rejects a blank pane symbol', async () => {
    await assert.rejects(
      setSymbol({ index: 0, symbol: '  ', _deps: paneDeps() }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});
