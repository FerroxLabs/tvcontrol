import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGolden } from '../src/core/golden.js';

function baseDeps(overrides = {}) {
  let tick = 0;
  return {
    now: () => new Date('2026-07-15T00:00:00Z'),
    nowMs: () => tick++,
    atomicWrite: () => {},
    chartState: async () => ({ studies: [] }),
    quote: async () => ({ success: true }),
    ohlcv: async () => ({ success: true }),
    pineCheck: async () => ({ success: true, errors: [] }),
    strategyResults: async () => ({ success: true }),
    watchlistGet: async () => ({ success: true }),
    replayStatus: async () => ({ success: true }),
    ...overrides,
  };
}

describe('golden workflows', () => {
  it('passes the read-only chart, Pine, and watchlist workflows', async () => {
    const result = await runGolden({ workflows: ['chart_analysis', 'pine_compile', 'watchlist'], _deps: baseDeps() });
    assert.equal(result.success, true);
    assert.equal(result.passed, 3);
  });

  it('skips strategy and snapshot cleanly when prerequisites are absent', async () => {
    const result = await runGolden({ workflows: ['strategy_read', 'snapshot'], _deps: baseDeps() });
    assert.equal(result.skipped, 2);
    assert.equal(result.failed, 0);
  });

  it('uses the exact strategy entity id', async () => {
    let seen;
    const result = await runGolden({
      workflows: 'strategy_read', strategy_entity_id: 'strategy-123',
      _deps: baseDeps({ strategyResults: async (args) => { seen = args.entity_id; return { success: true }; } }),
    });
    assert.equal(seen, 'strategy-123');
    assert.equal(result.passed, 1);
  });

  it('cleans up snapshot and replay mutations in guaranteed paths', async () => {
    const calls = [];
    const result = await runGolden({
      workflows: ['snapshot', 'replay'], allow_mutations: true, replay_date: '2026-01-02',
      _deps: baseDeps({
        snapshot: async () => calls.push('snapshot'),
        restore: async () => calls.push('restore'),
        deleteSnapshot: () => calls.push('delete'),
        replayStart: async () => calls.push('replay-start'),
        replayStatus: async () => { calls.push('replay-status'); return { success: true }; },
        replayStop: async () => calls.push('replay-stop'),
      }),
    });
    assert.deepEqual(calls, ['snapshot', 'restore', 'delete', 'replay-start', 'replay-status', 'replay-stop']);
    assert.equal(result.passed, 2);
  });

  it('records failures without storing error messages', async () => {
    let receipt;
    const result = await runGolden({
      workflows: 'watchlist',
      _deps: baseDeps({
        watchlistGet: async () => { throw new Error('private watchlist name'); },
        atomicWrite: (_path, data) => { receipt = data; },
      }),
    });
    assert.equal(result.failed, 1);
    assert.doesNotMatch(receipt, /private watchlist name/);
  });

  it('fails the Pine workflow when the service returns compiled=false', async () => {
    const result = await runGolden({ workflows: 'pine_compile', _deps: baseDeps({ pineCheck: async () => ({ success: true, compiled: false }) }) });
    assert.equal(result.failed, 1);
  });
});
