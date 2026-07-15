import test from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/core/pine.js';
import { symbolSearch } from '../src/core/chart.js';

test('Pine host compile always carries a bounded abort signal', async () => {
  let options;
  const result = await check({
    source: '//@version=6\nindicator("Test")',
    _deps: {
      fetch: async (_url, received) => {
        options = received;
        return { ok: true, json: async () => ({ result: {} }) };
      },
    },
  });
  assert.equal(result.success, true);
  assert.ok(options.signal instanceof globalThis.AbortSignal);
});

test('symbol search always carries a bounded abort signal', async () => {
  let options;
  const result = await symbolSearch({
    query: 'NVDA',
    _deps: {
      fetch: async (_url, received) => {
        options = received;
        return { ok: true, json: async () => ({ symbols: [] }) };
      },
    },
  });
  assert.equal(result.success, true);
  assert.ok(options.signal instanceof globalThis.AbortSignal);
});

test('host network failures are classified and actionable', async () => {
  const fetch = async () => { throw Object.assign(new Error('socket stalled'), { name: 'TimeoutError' }); };
  await assert.rejects(
    () => symbolSearch({ query: 'NVDA', _deps: { fetch } }),
    (err) => err.category === 'api_unexpected' && /timed out/.test(err.message) && /network access/.test(err.hint),
  );
});
