/**
 * Offline tests for src/core/sweep.js — strategySweep + cartesianProduct.
 * All filesystem operations go to a tmpdir — no writes to real ~/.tv-mcp.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cartesianProduct, strategySweep } from '../src/core/sweep.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

let TMP;

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tv-mcp-sweep-test-'));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal _deps for sweep tests.
 * - setSymbol / setTimeframe / waitForChartReady / setInputs are no-ops.
 * - getStrategyResults returns the provided metrics object.
 * - snapshot / restore are tracked.
 * - sleep is instant.
 * - writePartial writes to tmpdir via provided fn (or no-op).
 */
function makeDeps({
  metrics = { 'Net Profit': '1234.56', 'Sharpe Ratio': '1.5' },
  failOnCombo = null,
  snapshotFn = null,
  restoreFn = null,
  writePartialFn = null,
} = {}) {
  const calls = { snapshot: [], restore: [], setSymbol: [], setTimeframe: [], setInputs: [] };
  let comboIdx = 0;

  return {
    _deps: {
      setSymbol: async ({ symbol }) => { calls.setSymbol.push(symbol); },
      setTimeframe: async ({ timeframe }) => { calls.setTimeframe.push(timeframe); },
      waitForChartReady: async () => true,
      setInputs: async ({ inputs }) => { calls.setInputs.push(inputs); },
      getStrategyResults: async () => {
        const idx = comboIdx++;
        if (failOnCombo !== null && idx === failOnCombo) throw new Error(`combo ${idx} failed`);
        return { metrics };
      },
      snapshot: snapshotFn || (async ({ name }) => { calls.snapshot.push(name); return { success: true }; }),
      restore: restoreFn || (async ({ name }) => { calls.restore.push(name); return { success: true, restored: { applied: [], skipped: [] } }; }),
      sleep: async () => {},
      writePartial: writePartialFn || null,
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 1. cartesianProduct: 2×2×3 = 12 combos
// ---------------------------------------------------------------------------

describe('cartesianProduct()', () => {
  it('2×2×3 inputs returns 12 combos', () => {
    const result = cartesianProduct({ a: [1, 2], b: ['x', 'y'], c: [10, 20, 30] });
    assert.equal(result.length, 12);
    // Every combo has all three keys
    for (const combo of result) {
      assert.ok('a' in combo);
      assert.ok('b' in combo);
      assert.ok('c' in combo);
    }
    // Values are drawn from the provided arrays
    const aVals = new Set(result.map(c => c.a));
    assert.deepEqual(aVals, new Set([1, 2]));
  });

  it('empty inputs returns single empty-object combo', () => {
    const result = cartesianProduct({});
    assert.deepEqual(result, [{}]);
  });
});

// ---------------------------------------------------------------------------
// 2. max_combinations cap validation
// ---------------------------------------------------------------------------

describe('strategySweep() — validation', () => {
  it('max_combinations=50 with 100 requested throws ClassifiedError', async () => {
    await assert.rejects(
      () => strategySweep({
        symbols: ['ES1!', 'NQ1!'],
        timeframes: ['15', '60', '240'],
        inputs: { length: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] }, // 2×3×10=60 > 50
        entity_id: 'st_xxx',
        max_combinations: 50,
        restore_start_state: false,
      }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        assert.ok(err.message.includes('exceeds'));
        return true;
      },
    );
  });

  it('max_combinations=500 is the absolute cap — 501 throws', async () => {
    await assert.rejects(
      () => strategySweep({
        symbols: ['ES1!'],
        timeframes: ['15'],
        inputs: {},
        entity_id: 'st_xxx',
        max_combinations: 501,
        restore_start_state: false,
      }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        assert.ok(err.message.includes('cap'));
        return true;
      },
    );
  });

  it('missing symbols throws', async () => {
    await assert.rejects(
      () => strategySweep({ symbols: [], timeframes: ['15'], entity_id: 'st_x', restore_start_state: false }),
      (err) => { assert.ok(err instanceof ClassifiedError); return true; },
    );
  });

  it('missing entity_id throws', async () => {
    await assert.rejects(
      () => strategySweep({ symbols: ['ES1!'], timeframes: ['15'], restore_start_state: false }),
      (err) => { assert.ok(err instanceof ClassifiedError); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Happy path: 1 symbol × 1 TF × 1 input combo
// ---------------------------------------------------------------------------

describe('strategySweep() — happy path', () => {
  it('single-symbol single-TF single-input returns 1 result', async () => {
    const { _deps } = makeDeps({ metrics: { 'Net Profit': '500' } });
    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      inputs: { length: [20] },
      entity_id: 'st_xxx',
      restore_start_state: false,
      _deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.total_combinations, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].symbol, 'ES1!');
    assert.equal(result.results[0].timeframe, '15');
    assert.deepEqual(result.results[0].inputs, { length: 20 });
    assert.ok('metrics' in result.results[0]);
    assert.ok(result.run_id.startsWith('sweep_'));
  });
});

// ---------------------------------------------------------------------------
// 5. on_error='continue': failing combo records error, next combo runs
// ---------------------------------------------------------------------------

describe('strategySweep() — on_error', () => {
  it('on_error=continue with one failing combo → error field, rest succeed', async () => {
    // 3 combos: fail index 0, rest succeed
    const { _deps } = makeDeps({ failOnCombo: 0 });
    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15', '60', '240'],
      entity_id: 'st_xxx',
      restore_start_state: false,
      on_error: 'continue',
      _deps,
    });

    assert.equal(result.total_combinations, 3);
    assert.equal(result.errored, 1);
    assert.equal(result.completed, 2);
    const failed = result.results.find(r => r.error);
    assert.ok(failed, 'should have one errored result');
    assert.ok(failed.error.includes('failed'));
    // Remaining combos ran
    const succeeded = result.results.filter(r => !r.error);
    assert.equal(succeeded.length, 2);
  });

  // ---------------------------------------------------------------------------
  // 6. on_error='abort': throws on first failure
  // ---------------------------------------------------------------------------

  it('on_error=abort with one failing combo → throws', async () => {
    const { _deps } = makeDeps({ failOnCombo: 0 });
    await assert.rejects(
      () => strategySweep({
        symbols: ['ES1!'],
        timeframes: ['15'],
        inputs: { length: [20] },
        entity_id: 'st_xxx',
        restore_start_state: false,
        on_error: 'abort',
        _deps,
      }),
      (err) => {
        assert.ok(err.message.includes('failed'));
        return true;
      },
    );
  });

  it('on_error=abort writes partial checkpoint before re-throw (audit lens A4)', async () => {
    const writes = [];
    const { _deps } = makeDeps({ failOnCombo: 1 }); // first combo succeeds, second fails
    _deps.writePartial = (data) => { writes.push(JSON.parse(JSON.stringify(data))); };

    await assert.rejects(() => strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      inputs: { length: [20, 30, 40] }, // 3 combos
      entity_id: 'st_xxx',
      restore_start_state: false,
      on_error: 'abort',
      _deps,
    }));

    assert.ok(writes.length >= 1, 'expected at least one writePartialFn call before abort');
    const last = writes[writes.length - 1];
    assert.ok(Array.isArray(last.results), 'partial must include results array');
    assert.ok(last.results.length >= 2, 'partial must include both the succeeded combo and the failing one');
    const failed = last.results.find(r => r.error);
    assert.ok(failed, 'partial must include the failing combo entry so resume can detect it');
  });
});

describe('strategySweep() — cleanup_warnings on restore failure (audit lens B-CRIT)', () => {
  it('surfaces restore failure as cleanup_warnings in response, not silent', async () => {
    const { _deps } = makeDeps();
    _deps.restore = async () => { throw new Error('snapshot file corrupt'); };

    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      inputs: { length: [20] },
      entity_id: 'st_xxx',
      restore_start_state: true,
      _deps,
    });

    assert.ok(result.success);
    assert.ok(Array.isArray(result.cleanup_warnings), 'expected cleanup_warnings array');
    const restoreFailure = result.cleanup_warnings.find(c => c.stage === 'restore_start_state');
    assert.ok(restoreFailure, 'expected restore_start_state stage in cleanup_warnings');
    assert.ok(restoreFailure.error.includes('corrupt'));
    // also surfaced as a human-readable warning
    assert.ok(result.warnings && result.warnings.some(w => w.includes('Cleanup restore_start_state failed')));
  });

  it('surfaces deleteSnapshot failure as cleanup_warnings (audit lens B-CRIT)', async () => {
    const { _deps } = makeDeps();
    _deps.deleteSnapshot = async () => { throw new Error('ENOENT'); };

    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      inputs: { length: [20] },
      entity_id: 'st_xxx',
      restore_start_state: true,
      _deps,
    });

    assert.ok(result.cleanup_warnings.find(c => c.stage === 'delete_scratch_snapshot'));
  });
});

// ---------------------------------------------------------------------------
// 7. Partial checkpoint every 10 combos
// ---------------------------------------------------------------------------

describe('strategySweep() — partial checkpoint', () => {
  it('writes partial file every 10 combos', async () => {
    const sweepsDir = join(TMP, 'checkpoints');
    mkdirSync(sweepsDir, { recursive: true });

    let writeCount = 0;
    const capturedData = [];

    // 12 combos: 2 symbols × 2 TFs × 3 inputs
    const { _deps } = makeDeps({
      writePartialFn: (data) => {
        writeCount++;
        capturedData.push(JSON.parse(JSON.stringify(data)));
        const filePath = join(sweepsDir, `${data.run_id}.partial.json`);
        writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      },
    });

    const result = await strategySweep({
      symbols: ['ES1!', 'NQ1!'],
      timeframes: ['15', '60'],
      inputs: { length: [20, 50, 100] },
      entity_id: 'st_xxx',
      max_combinations: 500,
      restore_start_state: false,
      on_error: 'continue',
      _deps,
    });

    assert.equal(result.total_combinations, 12);
    // Should have triggered 1 checkpoint at combo 10
    assert.equal(writeCount, 1);
    assert.equal(capturedData[0].results.length, 10);
  });
});

// ---------------------------------------------------------------------------
// 8. resume_from_run_id skips completed combos
// ---------------------------------------------------------------------------

describe('strategySweep() — resume', () => {
  it('resume_from_run_id skips already-completed combos', async () => {
    const sweepsDir = join(TMP, 'resume');
    mkdirSync(sweepsDir, { recursive: true });

    // Write a partial file with 1 completed combo
    const run_id = 'sweep_test_resume';
    const partial = {
      run_id,
      results: [
        { symbol: 'ES1!', timeframe: '15', inputs: { length: 20 }, metrics: { 'Net Profit': '100' }, duration_ms: 50 },
      ],
    };
    writeFileSync(join(sweepsDir, `${run_id}.partial.json`), JSON.stringify(partial), 'utf8');

    const setSymbolCalls = [];
    const { _deps } = makeDeps();
    _deps.setSymbol = async ({ symbol }) => { setSymbolCalls.push(symbol); };

    const result = await strategySweep({
      symbols: ['ES1!', 'NQ1!'],
      timeframes: ['15'],
      inputs: { length: [20] },
      entity_id: 'st_xxx',
      max_combinations: 500,
      restore_start_state: false,
      resume_from_run_id: run_id,
      _deps,
      _sweeps_dir: sweepsDir,
    });

    // ES1!/15/length:20 was already done → only NQ1!/15/length:20 should run
    assert.equal(result.results.length, 2); // 1 prior + 1 new
    assert.equal(result.completed, 2);
    // setSymbol should only have been called for NQ1!
    assert.ok(!setSymbolCalls.includes('ES1!'), 'ES1! should have been skipped');
    assert.ok(setSymbolCalls.includes('NQ1!'), 'NQ1! should have run');
  });
});

// ---------------------------------------------------------------------------
// 9. restore_start_state: snapshot + restore calls are made
// ---------------------------------------------------------------------------

describe('strategySweep() — restore_start_state', () => {
  it('snapshot called before sweep and restore called after', async () => {
    const snapshotCalls = [];
    const restoreCalls = [];

    const { _deps } = makeDeps({
      snapshotFn: async ({ name }) => { snapshotCalls.push(name); return { success: true }; },
      restoreFn: async ({ name }) => { restoreCalls.push(name); return { success: true, restored: { applied: [], skipped: [] } }; },
    });

    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      entity_id: 'st_xxx',
      restore_start_state: true,
      _deps,
    });

    assert.equal(result.success, true);
    assert.equal(snapshotCalls.length, 1);
    assert.ok(snapshotCalls[0].startsWith('.sweep_start_'));
    assert.equal(restoreCalls.length, 1);
    assert.equal(restoreCalls[0], snapshotCalls[0], 'restore uses same name as snapshot');
  });
});

// ---------------------------------------------------------------------------
// 10. summary.best_by_net_profit picks highest metric
// ---------------------------------------------------------------------------

describe('strategySweep() — summary', () => {
  it('best_by_net_profit picks result with highest Net Profit', async () => {
    let comboIdx = 0;
    const profitValues = ['100', '9999', '500'];

    const { _deps } = makeDeps();
    _deps.getStrategyResults = async () => {
      const val = profitValues[comboIdx++ % profitValues.length];
      return { metrics: { 'Net Profit': val, 'Sharpe Ratio': '1.0' } };
    };

    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15', '60', '240'],
      entity_id: 'st_xxx',
      restore_start_state: false,
      _deps,
    });

    assert.equal(result.success, true);
    assert.ok(result.summary.best_by_net_profit !== null);
    const bestMetrics = result.summary.best_by_net_profit.metrics;
    assert.equal(bestMetrics['Net Profit'], '9999');
  });

  it('best_by_sharpe picks result with highest Sharpe Ratio', async () => {
    let comboIdx = 0;
    const sharpeValues = ['0.5', '3.2', '1.1'];

    const { _deps } = makeDeps();
    _deps.getStrategyResults = async () => {
      const val = sharpeValues[comboIdx++ % sharpeValues.length];
      return { metrics: { 'Net Profit': '100', 'Sharpe Ratio': val } };
    };

    const result = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15', '60', '240'],
      entity_id: 'st_xxx',
      restore_start_state: false,
      _deps,
    });

    assert.ok(result.summary.best_by_sharpe !== null);
    assert.equal(result.summary.best_by_sharpe.metrics['Sharpe Ratio'], '3.2');
  });
});

// ---------------------------------------------------------------------------
// 10b. M4 — same-symbol cooldown short-circuit
// ---------------------------------------------------------------------------

describe('strategySweep() — same-symbol cooldown', () => {
  it('uses same_symbol_cooldown_ms when (symbol, timeframe) unchanged', async () => {
    const sleeps = [];
    const { _deps } = makeDeps();
    _deps.sleep = async (ms) => { sleeps.push(ms); };

    await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['5'],
      inputs: { length: [10, 20, 30] }, // 3 combos, all same symbol+tf
      entity_id: 'st_x',
      cooldown_ms: 1500,
      same_symbol_cooldown_ms: 200,
      restore_start_state: false,
      _deps,
      _sweeps_dir: TMP,
    });

    // First combo: full cooldown (no prior). Subsequent two: short cooldown.
    assert.deepEqual(sleeps, [1500, 200, 200]);
  });

  it('uses full cooldown_ms when symbol changes', async () => {
    const sleeps = [];
    const { _deps } = makeDeps();
    _deps.sleep = async (ms) => { sleeps.push(ms); };

    await strategySweep({
      symbols: ['ES1!', 'NQ1!'],
      timeframes: ['5'],
      inputs: { length: [10, 20] }, // 2 symbols × 2 inputs = 4 combos
      entity_id: 'st_x',
      cooldown_ms: 1500,
      same_symbol_cooldown_ms: 200,
      restore_start_state: false,
      _deps,
      _sweeps_dir: TMP,
    });

    // Combos in order: (ES,10), (ES,20), (NQ,10), (NQ,20)
    // Full cooldown when symbol differs from prior; short when same.
    assert.deepEqual(sleeps, [1500, 200, 1500, 200]);
  });

  it('clamps same_symbol_cooldown_ms above cooldown_ms back to cooldown_ms', async () => {
    const sleeps = [];
    const { _deps } = makeDeps();
    _deps.sleep = async (ms) => { sleeps.push(ms); };

    await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['5'],
      inputs: { length: [10, 20] },
      entity_id: 'st_x',
      cooldown_ms: 100,
      same_symbol_cooldown_ms: 5000, // nonsense — must be clamped
      restore_start_state: false,
      _deps,
      _sweeps_dir: TMP,
    });

    assert.deepEqual(sleeps, [100, 100]);
  });
});

// ---------------------------------------------------------------------------
// 11. Cap fires before cartesian materialization (Fix 1)
// ---------------------------------------------------------------------------

describe('strategySweep() — cap pre-materialization', () => {
  it('huge cartesian (10000+) throws INVALID_ARGUMENT without array allocation', async () => {
    // 100 symbols × 100 timeframes × 2 inputs = 20000 combos; no array should be built
    const symbols = Array.from({ length: 100 }, (_, i) => `SYM${i}`);
    const timeframes = Array.from({ length: 100 }, (_, i) => String(i + 1));
    await assert.rejects(
      () => strategySweep({
        symbols,
        timeframes,
        inputs: { length: [10, 20] },
        entity_id: 'st_xxx',
        max_combinations: 100,
        restore_start_state: false,
      }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        assert.ok(err.message.includes('exceeds'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 12. restore_start_state runs in finally on on_error:abort (Fix 2)
// ---------------------------------------------------------------------------

describe('strategySweep() — restore in finally on abort', () => {
  it('restore is called even when on_error=abort triggers a throw', async () => {
    const restoreCalls = [];
    const { _deps } = makeDeps({
      failOnCombo: 0,
      snapshotFn: async ({ name }) => ({ success: true }),
      restoreFn: async ({ name }) => { restoreCalls.push(name); return { success: true, restored: { applied: [], skipped: [] } }; },
    });
    _deps.deleteSnapshot = async () => {};

    await assert.rejects(
      () => strategySweep({
        symbols: ['ES1!'],
        timeframes: ['15'],
        entity_id: 'st_xxx',
        restore_start_state: true,
        on_error: 'abort',
        _deps,
      }),
      () => true,
    );

    assert.equal(restoreCalls.length, 1, 'restore should have been called in finally');
    assert.ok(restoreCalls[0].startsWith('.sweep_start_'));
  });
});

// ---------------------------------------------------------------------------
// 13. Scratch snapshot deleted in finally (Fix 3)
// ---------------------------------------------------------------------------

describe('strategySweep() — snapshot cleanup in finally', () => {
  it('deleteSnapshot called after successful sweep', async () => {
    const deleteCalls = [];
    const { _deps } = makeDeps({
      snapshotFn: async ({ name }) => ({ success: true }),
      restoreFn: async ({ name }) => ({ success: true, restored: { applied: [], skipped: [] } }),
    });
    _deps.deleteSnapshot = async ({ name }) => { deleteCalls.push(name); };

    await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      entity_id: 'st_xxx',
      restore_start_state: true,
      _deps,
    });

    assert.equal(deleteCalls.length, 1, 'deleteSnapshot should have been called');
    assert.ok(deleteCalls[0].startsWith('.sweep_start_'));
  });
});

// ---------------------------------------------------------------------------
// 14. Dedup symbols reduces combo count (Fix 4)
// ---------------------------------------------------------------------------

describe('strategySweep() — dedup symbols', () => {
  it("['ES1!','ES1!','NQ1!'] deduped to 2 combos, not 3", async () => {
    const setSymbolCalls = [];
    const { _deps } = makeDeps();
    _deps.setSymbol = async ({ symbol }) => { setSymbolCalls.push(symbol); };

    const result = await strategySweep({
      symbols: ['ES1!', 'ES1!', 'NQ1!'],
      timeframes: ['15'],
      entity_id: 'st_xxx',
      restore_start_state: false,
      _deps,
    });

    assert.equal(result.total_combinations, 2);
    assert.equal(setSymbolCalls.length, 2);
    assert.ok(result.warnings && result.warnings.some(w => w.includes('Duplicate symbols')));
  });
});

// ---------------------------------------------------------------------------
// 15. Promise.race timeout timer cleared on success (Fix 5)
// ---------------------------------------------------------------------------

describe('strategySweep() — timeout cleanup', () => {
  it('no timer leak when getStrategyResults resolves before timeout', async () => {
    // Use a long timeout; getStrategyResults resolves instantly.
    // We verify by tracking active handles don't grow — proxy: run many combos without OOM/stall.
    const { _deps } = makeDeps();
    const result = await strategySweep({
      symbols: ['ES1!', 'NQ1!', 'GC1!', 'CL1!', 'ZB1!'],
      timeframes: ['1', '5', '15', '60'],
      entity_id: 'st_xxx',
      max_combinations: 500,
      timeout_per_combo_ms: 60000, // long timeout that should never fire
      restore_start_state: false,
      _deps,
    });
    // All 20 combos completed cleanly — timers were cleared
    assert.equal(result.total_combinations, 20);
    assert.equal(result.errored, 0);
  });
});

// ---------------------------------------------------------------------------
// 16. _deps propagation — downstream cores receive CDP-only subset (Fix 6)
// ---------------------------------------------------------------------------

describe('strategySweep() — _deps propagation', () => {
  it('setSymbol receives only CDP-level _deps keys, not sweep-level keys', async () => {
    let receivedDeps;
    const { _deps } = makeDeps();
    _deps.setSymbol = async ({ symbol, _deps: downstream }) => {
      receivedDeps = downstream;
    };
    // Provide sweep-level extras that must NOT leak downstream
    _deps.sleep = async () => {};
    _deps.writePartial = () => {};

    await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      entity_id: 'st_xxx',
      restore_start_state: false,
      _deps,
    });

    assert.ok(receivedDeps !== undefined, 'downstream _deps should be set');
    assert.ok(!('sleep' in receivedDeps), 'sleep must not leak downstream');
    assert.ok(!('writePartial' in receivedDeps), 'writePartial must not leak downstream');
    // CDP keys are present (may be undefined if not in test deps, but key should exist or not)
    const allowedKeys = new Set(['evaluate', 'evaluateAsync', 'waitForChartReady', 'getChartApi']);
    for (const k of Object.keys(receivedDeps)) {
      assert.ok(allowedKeys.has(k), `unexpected key in downstream _deps: ${k}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 17 & 18. INVALID_ARGUMENT for bad inputs (Fix 7)
// ---------------------------------------------------------------------------

describe('strategySweep() — INVALID_ARGUMENT category', () => {
  it('empty symbols array throws INVALID_ARGUMENT', async () => {
    await assert.rejects(
      () => strategySweep({ symbols: [], timeframes: ['15'], entity_id: 'st_x', restore_start_state: false }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('missing entity_id throws INVALID_ARGUMENT', async () => {
    await assert.rejects(
      () => strategySweep({ symbols: ['ES1!'], timeframes: ['15'], restore_start_state: false }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Cache: second run reuses first run's per-combo results
// ---------------------------------------------------------------------------

describe('strategySweep() — cache', () => {
  it('use_cache=true round-trips metrics without calling getStrategyResults', async () => {
    const cacheDir = join(TMP, 'cache-roundtrip');
    // First run — warms cache, gets real results.
    const first = makeDeps();
    const r1 = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      inputs: { length: [10, 20] },
      entity_id: 'st_cached',
      restore_start_state: false,
      use_cache: true,
      _cache_dir: cacheDir,
      _deps: first._deps,
    });
    assert.equal(r1.completed, 2, 'first run completes 2 combos');
    assert.equal(r1.cache_hits, 0, 'first run has no cache hits');
    assert.equal(first.calls.setInputs.length, 2, 'first run called setInputs for each combo');

    // Second run — same inputs, cache should short-circuit both combos.
    const second = makeDeps();
    const r2 = await strategySweep({
      symbols: ['ES1!'],
      timeframes: ['15'],
      inputs: { length: [10, 20] },
      entity_id: 'st_cached',
      restore_start_state: false,
      use_cache: true,
      _cache_dir: cacheDir,
      _deps: second._deps,
    });
    assert.equal(r2.cache_hits, 2, 'second run hits cache for every combo');
    assert.equal(r2.completed, 2, 'cached combos still count as completed');
    assert.equal(second.calls.setInputs.length, 0, 'second run skipped setInputs entirely');
    // All result rows carry cached:true
    for (const row of r2.results) assert.equal(row.cached, true);
  });

  it('different entity_id on same inputs does NOT share cache', async () => {
    const cacheDir = join(TMP, 'cache-entity-isolation');
    const a = makeDeps();
    await strategySweep({
      symbols: ['ES1!'], timeframes: ['15'], inputs: { length: [10] },
      entity_id: 'st_A', restore_start_state: false,
      use_cache: true, _cache_dir: cacheDir, _deps: a._deps,
    });
    const b = makeDeps();
    const rb = await strategySweep({
      symbols: ['ES1!'], timeframes: ['15'], inputs: { length: [10] },
      entity_id: 'st_B', restore_start_state: false,
      use_cache: true, _cache_dir: cacheDir, _deps: b._deps,
    });
    assert.equal(rb.cache_hits, 0, 'different entity_id must miss cache');
    assert.equal(b.calls.setInputs.length, 1, 'setInputs still runs for entity_B');
  });

  it('cache_max_age_ms=0 forces fresh computation', async () => {
    const cacheDir = join(TMP, 'cache-ttl');
    const a = makeDeps();
    await strategySweep({
      symbols: ['ES1!'], timeframes: ['15'], inputs: { length: [10] },
      entity_id: 'st_ttl', restore_start_state: false,
      use_cache: true, _cache_dir: cacheDir, _deps: a._deps,
    });
    const b = makeDeps();
    const rb = await strategySweep({
      symbols: ['ES1!'], timeframes: ['15'], inputs: { length: [10] },
      entity_id: 'st_ttl', restore_start_state: false,
      use_cache: true, cache_max_age_ms: 0, _cache_dir: cacheDir, _deps: b._deps,
    });
    assert.equal(rb.cache_hits, 0, 'cache_max_age_ms: 0 must force a miss');
  });
});
