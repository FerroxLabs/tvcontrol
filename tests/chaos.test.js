import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runChaos } from '../src/core/chaos.js';

describe('chaos harness', () => {
  it('is a dry-run unless live faults are explicitly allowed', async () => {
    let touched = false;
    const result = await runChaos({ scenarios: 'cdp_disconnect', _deps: { disconnect: async () => { touched = true; } } });
    assert.equal(result.dry_run, true);
    assert.equal(touched, false);
  });

  it('disconnects, reconnects, and verifies health', async () => {
    const calls = [];
    let receipt;
    const result = await runChaos({
      scenarios: ['cdp_disconnect'], allow_live_faults: true,
      _deps: {
        disconnect: async () => calls.push('disconnect'),
        getClient: async () => calls.push('connect'),
        healthCheck: async () => ({ healthy: true }),
        atomicWrite: (_path, data) => { receipt = JSON.parse(data); },
        now: () => new Date('2026-07-15T00:00:00Z'),
      },
    });
    assert.deepEqual(calls, ['disconnect', 'connect']);
    assert.equal(result.success, true);
    assert.equal(receipt.scenarios[0].cleanup_verified, true);
  });

  it('observes a bounded renderer timeout and verifies the next evaluation', async () => {
    const client = { Runtime: { evaluate: async ({ expression }) => expression === '1 + 1' ? { result: { value: 2 } } : new Promise(() => {}) } };
    let calls = 0;
    const result = await runChaos({
      scenarios: ['renderer_stall'], allow_live_faults: true,
      _deps: {
        getClient: async () => client,
        withConnectionTimeout: async (promise) => {
          calls++;
          if (calls === 1) throw new Error('timeout');
          return promise;
        },
        healthCheck: async () => ({ healthy: true }),
        atomicWrite: () => {},
      },
    });
    assert.equal(result.scenarios[0].renderer_responsive, true);
  });

  it('restores the tab count and attempts cleanup when the primary close fails', async () => {
    let count = 2;
    let closes = 0;
    const result = await runChaos({
      scenarios: ['tab_cycle'], allow_live_faults: true,
      _deps: {
        getTargetInfo: async () => ({ id: 'original' }),
        reconnectToTarget: async () => {},
        tabList: async () => ({ tab_count: count }),
        tabNew: async () => ({ tab_count: ++count }),
        tabClose: async () => {
          closes++;
          if (closes === 1) throw new Error('first close failed');
          count--;
          return { tabs_after: count };
        },
        tabSwitch: async () => {},
        healthCheck: async () => ({ healthy: true }),
        atomicWrite: () => {},
      },
    });
    assert.equal(closes, 2);
    assert.equal(count, 2);
    assert.equal(result.success, false);
  });
});
