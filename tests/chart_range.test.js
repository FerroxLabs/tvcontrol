import test from 'node:test';
import assert from 'node:assert/strict';
import { setVisibleRange } from '../src/core/chart.js';

test('setVisibleRange requests older bars until the requested start is loaded', async () => {
  const states = [
    { firstTime: 200, more: true },
    { firstTime: 150, more: true },
    { firstTime: 90, more: true },
  ];
  let requests = 0;
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        if (expression.includes('requestMoreDataAvailable')) return states.shift();
        if (expression.includes('requestMoreData(1000)')) { requests += 1; return true; }
        if (expression.includes('zoomToBarsRange')) return undefined;
        if (expression.includes('getVisibleRange')) return { from: 100, to: 300 };
        throw new Error(`Unexpected expression: ${expression}`);
      },
    },
  });

  assert.equal(requests, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.history, {
    requests: 2,
    earliest_loaded: 90,
    reached_from: true,
    exhausted: false,
  });
});

test('setVisibleRange reports a partial range honestly when history is exhausted', async () => {
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        if (expression.includes('requestMoreDataAvailable')) return { firstTime: 200, more: false };
        if (expression.includes('zoomToBarsRange')) return undefined;
        if (expression.includes('getVisibleRange')) return { from: 200, to: 300 };
        throw new Error(`Unexpected expression: ${expression}`);
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.complete, false);
  assert.equal(result.history.exhausted, true);
  assert.match(result.note, /could not load the entire requested range/i);
});

test('setVisibleRange rejects inverted ranges', async () => {
  await assert.rejects(
    setVisibleRange({ from: 300, to: 100, _deps: { evaluate: async () => {} } }),
    (error) => error.category === 'invalid_argument',
  );
});
