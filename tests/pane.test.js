import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { focus, list, setLayout, setSymbol } from '../src/core/pane.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

const paneDeps = ({ evaluate, evaluateAsync } = {}) => ({
  evaluate: evaluate || (async () => undefined),
  evaluateAsync: evaluateAsync || (async () => undefined),
  wait: async () => {},
});

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

  it('focuses a valid pane index', async () => {
    const result = await focus({
      index: 1,
      _deps: paneDeps({ evaluate: async () => ({ focused: 1, total: 2 }) }),
    });
    assert.deepEqual(result, { success: true, focused_index: 1, total_panes: 2 });
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

  it('focuses before setting a pane symbol and trims the symbol', async () => {
    const calls = [];
    const result = await setSymbol({
      index: 0,
      symbol: ' NASDAQ:AAPL ',
      _deps: paneDeps({
        evaluate: async () => { calls.push('focus'); return { focused: 0, total: 2 }; },
        evaluateAsync: async (expression) => { calls.push(expression); },
      }),
    });
    assert.equal(calls[0], 'focus');
    assert.match(calls[1], /setSymbol\("NASDAQ:AAPL"/);
    assert.deepEqual(result, { success: true, index: 0, symbol: 'NASDAQ:AAPL' });
  });

  it('rejects a blank pane symbol', async () => {
    await assert.rejects(
      setSymbol({ index: 0, symbol: '  ', _deps: paneDeps() }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});
