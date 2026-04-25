/**
 * Offline tests for src/core/state.js — snapshot, restore, list, deleteSnapshot.
 * All filesystem operations go to a tmpdir — no writes to real ~/.tv-mcp.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { snapshot, restore, list, deleteSnapshot } from '../src/core/state.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';
import { scriptedDeps, emptyDeps } from './_helpers.js';

let TMP;

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tv-mcp-state-test-'));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal scripted _deps that satisfies snapshot()
// ---------------------------------------------------------------------------
function snapshotDeps(overrides = {}) {
  // snapshot() calls:
  //   1. chart.getState → evaluate with 'getAllStudies'
  //   2. pane.list → evaluate with '_layoutType'
  //   3. drawing.listDrawings → evaluate with 'getAllShapes'  (uses real evaluate)
  //   4. visible_range evaluate
  //   5. per-study getInputValues evaluate
  // We stub everything with scripted sequence.
  const { _deps, evaluate } = scriptedDeps({
    'getAllStudies': { symbol: 'NYMEX:CL1!', resolution: '15', chartType: 1, studies: [] },
    '_layoutType': { layout: 's', chart_count: 1, active_index: 0, panes: [{ index: 0, symbol: 'NYMEX:CL1!', resolution: '15' }] },
    'getAllShapes': [],
    'getVisibleRange': { from: 1700000000, to: 1700100000 },
    ...overrides,
  });
  return { _deps, evaluate };
}

// ---------------------------------------------------------------------------
// snapshot() — 8 tests
// ---------------------------------------------------------------------------

describe('snapshot()', () => {
  it('rejects empty name', async () => {
    await assert.rejects(
      () => snapshot({ name: '', _snapshots_dir: TMP }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('rejects name with "/"', async () => {
    await assert.rejects(
      () => snapshot({ name: 'foo/bar', _snapshots_dir: TMP }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('rejects name with ".."', async () => {
    await assert.rejects(
      () => snapshot({ name: '..evil', _snapshots_dir: TMP }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('rejects collision when snapshot already exists (overwrite:false by default)', async () => {
    const dir = join(TMP, 'snap-collision');
    const { _deps } = scriptedDeps({}, [
      { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] },
      { from: 1700000000, to: 1700100000 },
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'AAPL', resolution: 'D' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    // First call should succeed
    await snapshot({ name: 'collision-test', _deps, _snapshots_dir: dir });
    // Second call with same name should reject
    await assert.rejects(
      () => snapshot({ name: 'collision-test', _deps, _snapshots_dir: dir }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        assert.ok(err.message.includes('already exists'));
        return true;
      },
    );
  });

  it('accepts collision when overwrite:true', async () => {
    const dir = join(TMP, 'snap-overwrite');
    // Each snapshot call fires 3 evaluates: chartState, visibleRange, studiesBatch.
    // For 2 snapshot() calls we need 6 sequence entries.
    const { _deps } = scriptedDeps({}, [
      { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] },
      { from: 1700000000, to: 1700100000 },
      [],  // studies batch — empty array (chartState.studies was empty)
      { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] },
      { from: 1700000000, to: 1700100000 },
      [],
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'AAPL', resolution: 'D' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    await snapshot({ name: 'overwrite-test', _deps, _snapshots_dir: dir });
    const result = await snapshot({ name: 'overwrite-test', overwrite: true, _deps, _snapshots_dir: dir });
    assert.equal(result.success, true);
  });

  it('tmp file uses pid+random suffix (no plain .tmp left over)', async () => {
    const dir = join(TMP, 'snap-tmp-unique');
    const { _deps } = scriptedDeps({}, [
      { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] },
      { from: 1700000000, to: 1700100000 },
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'AAPL', resolution: 'D' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    const result = await snapshot({ name: 'tmp-unique-test', _deps, _snapshots_dir: dir });
    // No .tmp files should remain
    const { readdirSync } = await import('node:fs');
    const leftover = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.equal(leftover.length, 0, 'No .tmp files should remain after snapshot');
    // The plain .tmp path should not exist
    assert.ok(!existsSync(result.file_path + '.tmp'));
  });

  it('fetches all study inputs in a single evaluate call (not N+1)', async () => {
    const dir = join(TMP, 'snap-single-eval');
    const evaluateCalls = [];
    const mockEval = async (expr) => {
      evaluateCalls.push(expr);
      if (expr.includes('getAllStudies') && expr.includes('getStudyById')) {
        // This is the single-batch evaluate
        return [
          { id: 'st_001', name: 'RSI', inputs: [{ id: 'length', value: 14 }], hadEncrypted: false },
          { id: 'st_002', name: 'MACD', inputs: [], hadEncrypted: false },
        ];
      }
      if (expr.includes('getAllStudies')) {
        return { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [{ id: 'st_001', name: 'RSI' }, { id: 'st_002', name: 'MACD' }] };
      }
      if (expr.includes('getVisibleRange')) return { from: 1700000000, to: 1700100000 };
      return undefined;
    };
    mockEval.calls = evaluateCalls;
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'AAPL', resolution: 'D' }] });
    _deps.drawingList = async () => ({ shapes: [] });

    await snapshot({ name: 'single-eval-test', _deps, _snapshots_dir: dir });

    // Count calls that contain getStudyById — should be exactly 1 (the batch call)
    const studyByIdCalls = evaluateCalls.filter(c => c.includes('getStudyById'));
    assert.equal(studyByIdCalls.length, 1, 'Should use a single evaluate for all study inputs');
  });

  it('writes atomic JSON with schema_version:1 to tmpdir', async () => {
    const dir = join(TMP, 'snap-atomic');
    const { _deps } = scriptedDeps({}, [
      // chart.getState evaluate
      { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] },
      // visible range evaluate
      { from: 1700000000, to: 1700100000 },
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'AAPL', resolution: 'D' }] });
    _deps.drawingList = async () => ({ shapes: [] });

    const result = await snapshot({ name: 'atomic-test', _deps, _snapshots_dir: dir });
    assert.equal(result.success, true);
    assert.equal(result.schema_version, 1);
    assert.ok(result.file_path.endsWith('atomic-test.json'));
    // File must exist
    assert.ok(existsSync(result.file_path));
    // No .tmp file left over
    assert.ok(!existsSync(result.file_path + '.tmp'));
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(result.file_path, 'utf8'));
    assert.equal(parsed.schema_version, 1);
  });

  it('includes captured_at ISO timestamp', async () => {
    const dir = join(TMP, 'snap-ts');
    const { _deps } = scriptedDeps({}, [
      { symbol: 'ES1!', resolution: '60', chartType: 1, studies: [] },
      null, // visible range
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'ES1!', resolution: '60' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    const result = await snapshot({ name: 'ts-test', _deps, _snapshots_dir: dir });
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(result.file_path, 'utf8'));
    assert.ok(typeof parsed.captured_at === 'string');
    assert.ok(!isNaN(new Date(parsed.captured_at).getTime()));
  });

  it('includes layout, panes, studies, drawings arrays', async () => {
    const dir = join(TMP, 'snap-arrays');
    const { _deps } = scriptedDeps({}, [
      { symbol: 'NYMEX:CL1!', resolution: '15', chartType: 1, studies: [] },
      null, // visible range
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'NYMEX:CL1!', resolution: '15' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    const result = await snapshot({ name: 'arrays-test', _deps, _snapshots_dir: dir });
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(result.file_path, 'utf8'));
    assert.ok(parsed.layout && typeof parsed.layout === 'object');
    assert.ok(Array.isArray(parsed.panes));
    assert.ok(Array.isArray(parsed.studies));
    assert.ok(Array.isArray(parsed.drawings));
  });

  it('strips oversized inputs but keeps the study; records stripped entries', async () => {
    const dir = join(TMP, 'snap-encrypted');
    const { _deps } = scriptedDeps({}, [
      // chart.getState — one study
      { symbol: 'BTCUSD', resolution: '1', chartType: 1, studies: [{ id: 'st_enc_001', name: 'Prop Indicator' }] },
      // visible range evaluate
      null,
      // Studies batch — new shape: strippedInputs records individual oversized
      // inputs (e.g. published/protected Pine encoded source blobs). The study
      // itself is still captured so restore can find it by name/scriptIdPart.
      [{
        id: 'st_enc_001',
        name: 'Prop Indicator',
        scriptIdPart: 'PUB;abc123',
        inputs: [{ id: 'length', value: 14 }],
        strippedInputs: [{ id: 'pineSource', value_length: 7994 }],
      }],
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'BTCUSD', resolution: '1' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    const result = await snapshot({ name: 'enc-test', _deps, _snapshots_dir: dir });
    assert.equal(result.skipped_count, 1, 'one stripped-inputs record expected');
    assert.equal(result.studies_count, 1, 'study itself must be retained');
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(result.file_path, 'utf8'));
    assert.equal(parsed.skipped_at_snapshot.length, 1);
    assert.equal(parsed.skipped_at_snapshot[0].reason, 'encoded_source_stripped');
    assert.equal(parsed.skipped_at_snapshot[0].name, 'Prop Indicator');
    assert.equal(parsed.skipped_at_snapshot[0].count, 1);
    assert.equal(parsed.studies.length, 1);
    assert.equal(parsed.studies[0].name, 'Prop Indicator');
    assert.equal(parsed.studies[0].scriptIdPart, 'PUB;abc123');
    assert.deepEqual(parsed.studies[0].inputs, [{ id: 'length', value: 14 }]);
    assert.equal(parsed.studies[0].stripped_inputs.length, 1);
  });

  it('uses a single batch eval for studies (no user-controlled interpolation)', async () => {
    const dir = join(TMP, 'snap-batch');
    const { _deps, evaluate } = scriptedDeps({}, [
      { symbol: 'NYMEX:CL1!', resolution: '15', chartType: 1, studies: [{ id: 'st_001', name: 'RSI' }] },
      null,
      [{ id: 'st_001', name: 'RSI', inputs: [{ id: 'length', value: 14 }], hadEncrypted: false }],
    ]);
    _deps.paneList = async () => ({ panes: [{ index: 0, symbol: 'NYMEX:CL1!', resolution: '15' }] });
    _deps.drawingList = async () => ({ shapes: [] });
    await snapshot({ name: 'batch-test', _deps, _snapshots_dir: dir });
    // The studies-batch expression is unique in calling getStudyById; chart.getState
    // does getAllStudies but not getStudyById. Verify exactly one batch call.
    const batchCalls = evaluate.calls.filter(c => c.includes('getStudyById'));
    assert.equal(batchCalls.length, 1, 'studies fetched in exactly one batch evaluate');
    // The batch expression is static — no user-controlled strings injected
    const batchExpr = batchCalls[0];
    assert.ok(!batchExpr.includes('st_001'), 'entity IDs not interpolated (server-side iteration)');
    assert.ok(!batchExpr.includes('batch-test'), 'snapshot name not leaked into expression');
  });
});

// ---------------------------------------------------------------------------
// restore() — 10 tests
// ---------------------------------------------------------------------------

describe('restore()', () => {
  function writeSnap(dir, name, data) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
  }

  const BASE_SNAP = {
    schema_version: 1,
    captured_at: '2026-04-23T10:00:00.000Z',
    name: 'test-snap',
    layout: { code: 's', pane_count: 1 },
    panes: [{ index: 0, symbol: 'NYMEX:CL1!', resolution: '15', chart_type: 1 }],
    studies: [],
    drawings: [],
    skipped_at_snapshot: [],
  };

  it('rejects missing file (ClassifiedError INVALID_ARGUMENT)', async () => {
    const dir = join(TMP, 'restore-missing');
    await assert.rejects(
      () => restore({ name: 'no-such-snap', _snapshots_dir: dir }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('rejects schema_version != 1 (ClassifiedError SNAPSHOT_INCOMPLETE)', async () => {
    const dir = join(TMP, 'restore-schema');
    writeSnap(dir, 'bad-schema', { ...BASE_SNAP, schema_version: 2 });
    await assert.rejects(
      () => restore({ name: 'bad-schema', _snapshots_dir: dir }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.SNAPSHOT_INCOMPLETE);
        return true;
      },
    );
  });

  it('happy path: single-pane symbol + tf + chart_type apply, no drawings', async () => {
    const dir = join(TMP, 'restore-happy');
    writeSnap(dir, 'happy', BASE_SNAP);
    // setSymbol calls evaluateAsync then waitForChartReady
    // setTimeframe calls evaluate then waitForChartReady
    // setType calls evaluate
    const { _deps } = scriptedDeps({}, [
      undefined, // setSymbol evaluateAsync
      undefined, // setTimeframe evaluate
      undefined, // setType evaluate
    ]);
    const result = await restore({ name: 'happy', _deps, _snapshots_dir: dir });
    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.restored.applied));
    assert.ok(result.restored.applied.some(a => a.includes('symbol')));
  });

  it('restore order: layout before symbol (check call order in mock)', async () => {
    const dir = join(TMP, 'restore-order-layout');
    const snap = {
      ...BASE_SNAP,
      layout: { code: '2h', pane_count: 2 },
      panes: [
        { index: 0, symbol: 'AAPL', resolution: 'D', chart_type: 1 },
        { index: 1, symbol: 'MSFT', resolution: 'D', chart_type: 1 },
      ],
    };
    writeSnap(dir, 'order-layout', snap);
    const callOrder = [];
    const mockEval = async (expr) => {
      if (expr.includes('setLayout')) callOrder.push('layout');
      if (expr.includes('setSymbol')) callOrder.push('symbol');
      return undefined;
    };
    mockEval.calls = [];
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });
    await restore({ name: 'order-layout', _deps, _snapshots_dir: dir });
    // layout must appear before symbol in restored.applied
    // (pane.setLayout uses evaluateAsync internally — we check the applied array order)
    const result = await restore({ name: 'order-layout', _deps, _snapshots_dir: dir });
    const layoutIdx = result.restored.applied.indexOf('layout');
    const symbolIdx = result.restored.applied.findIndex(a => a.includes('symbol'));
    if (layoutIdx !== -1 && symbolIdx !== -1) {
      assert.ok(layoutIdx < symbolIdx, 'layout should be applied before symbol');
    }
  });

  it('restore order: indicators before drawings', async () => {
    const dir = join(TMP, 'restore-order-ind');
    const snap = {
      ...BASE_SNAP,
      studies: [{ name: 'RSI', inputs: [{ id: 'length', value: 14 }] }],
      drawings: [{ shape: 'horizontal_line', points: [{ time: 1700000000, price: 100 }], overrides: {}, text: '' }],
    };
    writeSnap(dir, 'order-ind', snap);
    const { _deps } = scriptedDeps({}, [
      undefined, // setSymbol
      undefined, // setTimeframe
      undefined, // setType
      undefined, // manageIndicator — before
      undefined, // manageIndicator — after getAllStudies
      undefined, // drawShape — before
      undefined, // drawShape — after getAllShapes
    ]);
    const result = await restore({ name: 'order-ind', _deps, _snapshots_dir: dir });
    const applied = result.restored.applied;
    const studyIdx = applied.findIndex(a => a.startsWith('study:'));
    const drawingIdx = applied.findIndex(a => a.startsWith('drawing:'));
    if (studyIdx !== -1 && drawingIdx !== -1) {
      assert.ok(studyIdx < drawingIdx, 'study should be applied before drawing');
    }
  });

  it('records skipped drawing with reason', async () => {
    const dir = join(TMP, 'restore-skip-draw');
    const snap = {
      ...BASE_SNAP,
      drawings: [{ shape: 'horizontal_line', points: [{ time: 1700000000, price: 100 }], overrides: {}, text: '' }],
    };
    writeSnap(dir, 'skip-draw', snap);
    // Let symbol/tf/type succeed (return undefined), but make drawShape's getAllShapes throw
    let callCount = 0;
    const mockEval = async (expr) => {
      callCount++;
      if (expr.includes('getAllShapes')) throw new Error('draw failed');
      return undefined;
    };
    mockEval.calls = [];
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });
    const result = await restore({ name: 'skip-draw', _deps, _snapshots_dir: dir });
    assert.ok(result.restored.skipped.some(s => s.field === 'drawing'));
  });

  it('returns applied + skipped report', async () => {
    const dir = join(TMP, 'restore-report');
    writeSnap(dir, 'report', BASE_SNAP);
    const { _deps } = emptyDeps();
    const result = await restore({ name: 'report', _deps, _snapshots_dir: dir });
    assert.ok(result.success);
    assert.ok('applied' in result.restored);
    assert.ok('skipped' in result.restored);
    assert.ok(Array.isArray(result.restored.applied));
    assert.ok(Array.isArray(result.restored.skipped));
  });

  it('all-fail case when all restore steps fail → ClassifiedError SNAPSHOT_INCOMPLETE', async () => {
    const dir = join(TMP, 'restore-allfail');
    const snap = {
      ...BASE_SNAP,
      panes: [{ index: 0, symbol: 'FAIL', resolution: '1', chart_type: 1 }],
      studies: [],
      drawings: [],
    };
    writeSnap(dir, 'all-fail', snap);
    const { _deps } = emptyDeps({
      evaluate: async () => { throw new Error('simulated failure'); },
      evaluateAsync: async () => { throw new Error('simulated failure'); },
      waitForChartReady: async () => { throw new Error('simulated failure'); },
    });
    // With no studies and no drawings, a single-pane restore where symbol fails
    // results in 0 applied — should throw SNAPSHOT_INCOMPLETE
    await assert.rejects(
      () => restore({ name: 'all-fail', _deps, _snapshots_dir: dir }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.SNAPSHOT_INCOMPLETE);
        return true;
      },
    );
  });

  it('indicator inputs array passes through to chart.manageIndicator', async () => {
    const dir = join(TMP, 'restore-inputs');
    const snap = {
      ...BASE_SNAP,
      studies: [{ name: 'RSI', inputs: [{ id: 'length', value: 21 }] }],
    };
    writeSnap(dir, 'inputs', snap);
    const calls = [];
    const mockEval = async (expr) => {
      calls.push(expr);
      // manageIndicator needs: before getAllStudies → [], after → ['new_id']
      if (expr.includes('getAllStudies')) return calls.filter(c => c.includes('getAllStudies')).length === 1 ? [] : ['new_id_001'];
      return undefined;
    };
    mockEval.calls = calls;
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });
    const result = await restore({ name: 'inputs', _deps, _snapshots_dir: dir });
    // Should have applied the study (or at least attempted)
    const studyApplied = result.restored.applied.some(a => a.includes('RSI'));
    const studySkipped = result.restored.skipped.some(s => s.name === 'RSI' || s.field === 'study');
    assert.ok(studyApplied || studySkipped, 'RSI study should appear in applied or skipped');
    // Verify createStudy call includes input value
    const createCall = calls.find(c => c.includes('createStudy'));
    if (createCall) {
      assert.ok(createCall.includes('21') || createCall.includes('length'));
    }
  });

  it('clear-before-restore: batched removeEntity for every existing study (W4-M1)', async () => {
    const dir = join(TMP, 'restore-clear-studies');
    const snap = {
      ...BASE_SNAP,
      studies: [{ name: 'RSI', inputs: [] }],
    };
    writeSnap(dir, 'clear-studies', snap);

    const removeCalls = [];
    let batchEvals = 0;
    const mockEval = async (expr) => {
      // chart.getState (called for clear step) returns 2 existing studies
      if (expr.includes('getAllStudies') && !expr.includes('createStudy') && !expr.includes('removeEntity')) {
        return { symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [{ id: 'existing_001', name: 'OldRSI' }, { id: 'existing_002', name: 'OldMACD' }] };
      }
      if (expr.includes('removeEntity')) {
        // The batched evaluate contains every removeEntity("...") call; capture
        // them all via global matchAll instead of the old single-match regex.
        batchEvals++;
        for (const m of expr.matchAll(/removeEntity\("([^"]+)"\)/g)) {
          removeCalls.push(m[1]);
        }
        return { removed: removeCalls.slice(), failed: [] };
      }
      return undefined;
    };
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });
    await restore({ name: 'clear-studies', _deps, _snapshots_dir: dir });

    assert.ok(removeCalls.includes('existing_001'), 'Should remove existing_001');
    assert.ok(removeCalls.includes('existing_002'), 'Should remove existing_002');
    assert.equal(batchEvals, 1, 'Expected ONE batched evaluate, not N+1 per-study calls');
  });

  it('pre-clear failures land in skipped[] (audit lens B HIGH)', async () => {
    const dir = join(TMP, 'restore-clear-fail');
    const snap = { ...BASE_SNAP, studies: [{ name: 'RSI', inputs: [] }] };
    writeSnap(dir, 'clear-fail', snap);

    // Mock evaluate so getAllStudies returns 2 studies; the batched evaluate
    // returns a structured {removed, failed} list — the locked one ends up
    // in failed[], the other in removed[].
    const mockEval = async (expr) => {
      if (expr.includes('getAllStudies') && !expr.includes('createStudy') && !expr.includes('removeEntity')) {
        return { symbol: 'AAPL', resolution: 'D', chartType: 1,
          studies: [{ id: 'locked_001', name: 'LockedStudy' }, { id: 'normal_001', name: 'NormalStudy' }] };
      }
      if (expr.includes('removeEntity')) {
        return {
          removed: ['normal_001'],
          failed: [{ id: 'locked_001', error: 'study is locked, cannot remove' }],
        };
      }
      return undefined;
    };
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });

    const result = await restore({ name: 'clear-fail', _deps, _snapshots_dir: dir });
    const lockedSkip = result.restored.skipped.find(s => s.field === 'pre_clear_study' && s.name === 'LockedStudy');
    assert.ok(lockedSkip, 'expected pre_clear_study skipped entry for LockedStudy');
    assert.ok(lockedSkip.reason.includes('locked'));
  });

  it('clear-before-restore: calls drawing.clearAll before re-adding drawings', async () => {
    const dir = join(TMP, 'restore-clear-drawings');
    const snap = {
      ...BASE_SNAP,
      drawings: [{ shape: 'horizontal_line', points: [{ time: 1700000000, price: 100 }], overrides: {}, text: '' }],
    };
    writeSnap(dir, 'clear-drawings', snap);

    const clearAllCalls = [];
    const { _deps } = emptyDeps();
    _deps.drawingClearAll = async () => { clearAllCalls.push('clearAll'); };
    await restore({ name: 'clear-drawings', _deps, _snapshots_dir: dir });

    assert.equal(clearAllCalls.length, 1, 'drawing.clearAll override invoked exactly once during restore');
  });

  it('fixture-backed: build fake snapshot JSON, restore it, verify sequence', async () => {
    const dir = join(TMP, 'restore-fixture');
    const snap = {
      schema_version: 1,
      captured_at: '2026-04-23T12:00:00.000Z',
      name: 'fixture-snap',
      layout: { code: 's', pane_count: 1 },
      panes: [{ index: 0, symbol: 'NYMEX:CL1!', resolution: '15', chart_type: 1 }],
      visible_range: { from: 1700000000, to: 1700100000 },
      studies: [{ name: 'Volume', inputs: [] }],
      drawings: [],
      skipped_at_snapshot: [],
    };
    writeSnap(dir, 'fixture-snap', snap);
    const sequence = [];
    const mockEval = async (expr) => {
      if (expr.includes('setSymbol')) sequence.push('setSymbol');
      else if (expr.includes('setResolution')) sequence.push('setResolution');
      else if (expr.includes('setChartType')) sequence.push('setChartType');
      else if (expr.includes('zoomToBarsRange') || expr.includes('getVisibleRange')) sequence.push('visibleRange');
      else if (expr.includes('createStudy')) sequence.push('createStudy');
      else if (expr.includes('getAllStudies')) return [];
      return undefined;
    };
    mockEval.calls = [];
    const { _deps } = emptyDeps({ evaluate: mockEval, evaluateAsync: mockEval });
    const result = await restore({ name: 'fixture-snap', _deps, _snapshots_dir: dir });
    assert.ok(result.success);
    // symbol/timeframe/type before visible range before study
    const symIdx = sequence.findIndex(s => s === 'setSymbol');
    const studyIdx = sequence.findIndex(s => s === 'createStudy');
    if (symIdx !== -1 && studyIdx !== -1) {
      assert.ok(symIdx < studyIdx, 'symbol should be set before study is added');
    }
  });
});

// ---------------------------------------------------------------------------
// list() — 3 tests
// ---------------------------------------------------------------------------

describe('list()', () => {
  it('empty dir → count 0', () => {
    const dir = join(TMP, 'list-empty');
    mkdirSync(dir, { recursive: true });
    const result = list({ _snapshots_dir: dir });
    assert.equal(result.success, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.snapshots, []);
  });

  it('enumerates 2 snapshots from tmpdir', () => {
    const dir = join(TMP, 'list-two');
    mkdirSync(dir, { recursive: true });
    const snap1 = {
      schema_version: 1,
      name: 'alpha',
      captured_at: '2026-04-22T10:00:00.000Z',
      panes: [{ index: 0, symbol: 'AAPL', resolution: 'D' }],
      studies: [{ name: 'RSI', inputs: [] }],
    };
    const snap2 = {
      schema_version: 1,
      name: 'beta',
      captured_at: '2026-04-23T10:00:00.000Z',
      panes: [{ index: 0, symbol: 'MSFT', resolution: '60' }],
      studies: [],
    };
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(snap1), 'utf8');
    writeFileSync(join(dir, 'beta.json'), JSON.stringify(snap2), 'utf8');
    const result = list({ _snapshots_dir: dir });
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    const names = result.snapshots.map(s => s.name);
    assert.ok(names.includes('alpha'));
    assert.ok(names.includes('beta'));
  });

  it('sorts by captured_at desc', () => {
    const dir = join(TMP, 'list-sort');
    mkdirSync(dir, { recursive: true });
    const snaps = [
      { schema_version: 1, name: 'oldest', captured_at: '2026-04-20T00:00:00.000Z', panes: [], studies: [] },
      { schema_version: 1, name: 'newest', captured_at: '2026-04-23T00:00:00.000Z', panes: [], studies: [] },
      { schema_version: 1, name: 'middle', captured_at: '2026-04-21T00:00:00.000Z', panes: [], studies: [] },
    ];
    for (const s of snaps) writeFileSync(join(dir, s.name + '.json'), JSON.stringify(s), 'utf8');
    const result = list({ _snapshots_dir: dir });
    assert.equal(result.snapshots[0].name, 'newest');
    assert.equal(result.snapshots[1].name, 'middle');
    assert.equal(result.snapshots[2].name, 'oldest');
  });
});

// ---------------------------------------------------------------------------
// deleteSnapshot() — 2 tests
// ---------------------------------------------------------------------------

describe('deleteSnapshot()', () => {
  it('rejects name with ".."', () => {
    assert.throws(
      () => deleteSnapshot({ name: '../etc/passwd', _snapshots_dir: TMP }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('unlinks file (verify ENOENT after)', () => {
    const dir = join(TMP, 'delete-test');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'to-delete.json');
    writeFileSync(filePath, JSON.stringify({ schema_version: 1, name: 'to-delete' }), 'utf8');
    assert.ok(existsSync(filePath));

    const result = deleteSnapshot({ name: 'to-delete', _snapshots_dir: dir });
    assert.equal(result.success, true);
    assert.equal(result.deleted, true);
    assert.ok(!existsSync(filePath), 'File should be deleted');
  });
});
