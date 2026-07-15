import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSoak } from '../src/core/soak.js';

function clock(step = 1) {
  let value = 0;
  return { nowMs: () => value++, sleep: async (ms) => { value += Math.max(ms, step); } };
}

describe('soak runner', () => {
  it('runs bounded read scenarios and writes a summary receipt', async () => {
    let receipt;
    const time = clock();
    const result = await runSoak({
      scenarios: ['health', 'stream'], duration_ms: 10_000, interval_ms: 250, max_samples: 4,
      _deps: {
        ...time,
        now: () => new Date('2026-07-15T00:00:00Z'),
        healthCheck: async () => ({ healthy: true }),
        getOhlcv: async () => ({ success: true }),
        atomicWrite: (_path, data) => { receipt = JSON.parse(data); },
      },
    });
    assert.equal(result.samples, 4);
    assert.equal(result.success, true);
    assert.equal(receipt.scenarios.health.samples, 2);
    assert.equal(receipt.scenarios.stream.samples, 2);
  });

  it('rejects mutation scenarios without explicit permission', async () => {
    await assert.rejects(
      () => runSoak({ scenarios: 'restore', duration_ms: 1, interval_ms: 250 }),
      /allow_mutations/,
    );
  });

  it('always deletes temporary restore snapshots', async () => {
    const calls = [];
    const time = clock();
    const result = await runSoak({
      scenarios: 'restore', duration_ms: 10_000, interval_ms: 250, max_samples: 1, allow_mutations: true,
      _deps: {
        ...time,
        snapshot: async () => calls.push('snapshot'),
        restore: async () => { calls.push('restore'); throw new Error('restore failed'); },
        deleteSnapshot: () => calls.push('delete'),
        atomicWrite: () => {},
      },
    });
    assert.deepEqual(calls, ['snapshot', 'restore', 'delete']);
    assert.equal(result.scenarios.restore.failed, 1);
  });

  it('returns a partial receipt when cancelled', async () => {
    const controller = new AbortController();
    const time = clock();
    const result = await runSoak({
      scenarios: 'health', duration_ms: 10_000, interval_ms: 250, max_samples: 10, signal: controller.signal,
      _deps: {
        ...time,
        healthCheck: async () => { controller.abort(); return { healthy: true }; },
        atomicWrite: () => {},
      },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.samples, 1);
  });
});
