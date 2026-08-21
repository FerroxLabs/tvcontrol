/**
 * A PINE STUDY HAD NO ADDRESS.
 *
 * Measured against TradingView Desktop on 2026-08-21:
 *
 *   getAllStudies() -> [ { name: 'TC-RTA V6',   id: [] },
 *                        { name: 'sweep probe', id: [] },
 *                        { name: 'Volume',      id: 'T4x6LH' } ]
 *
 *   all[0].id === all[1].id            false   (each Pine study gets its own [])
 *   getAllStudies()[0].id === all[0].id true    (stable per study)
 *   getStudyById(all[0].id)            the study, 67 inputs
 *   getStudyById([])                   throws "There is no such study"
 *
 * The id is a reference, not data, so it cannot survive CDP serialization.
 * chart_get_state returned that `[]` to callers as their entity_id, and the
 * four tools that take an entity_id string all called getStudyById with it.
 * Every one of them was unreachable for a Pine study.
 *
 * These tests run the REAL page-side expression. The logic under test lives
 * inside a template literal that is evaluated in the browser, so a mock
 * evaluate() alone proves nothing about it: capture the generated JS and run
 * it here against a fake TradingView instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as chart from '../src/core/chart.js';
import { STUDY_RESOLVER_JS, isUsableStudyId } from '../src/core/_study_ref.js';
import { mockEvaluate } from './_helpers.js';

/** A fake TradingView chart with the id shapes the real one produces. */
function fakeChart({ studies, removeThrows = false, removeIsNoop = false } = {}) {
  const live = studies.map((s) => ({ ...s }));
  const api = {
    symbol: () => 'BINANCE:BTCUSDT',
    resolution: () => '30',
    chartType: () => 1,
    getAllStudies: () => live.map((s) => ({ id: s.id, name: s.name })),
    getStudyById: (id) => {
      // Reference identity, exactly like the real one.
      const hit = live.find((s) => s.id === id);
      if (!hit) throw new Error('There is no such study');
      return {
        getInputValues: () => hit.inputs || [],
        setInputValues: (v) => { hit.inputs = v; },
        isVisible: () => hit.visible !== false,
        setVisible: (v) => { hit.visible = v; },
      };
    },
    removeEntity: (id) => {
      if (removeThrows) throw new Error('boom');
      if (removeIsNoop) return;
      const i = live.findIndex((s) => s.id === id);
      if (i >= 0) live.splice(i, 1);
    },
    _chartWidget: {
      model: () => ({
        model: () => ({
          dataSources: () => live.map((s) => ({
            metaInfo: () => ({ description: s.name, id: s.scriptId || `${s.name}@tv-basicstudies` }),
          })),
        }),
      }),
    },
  };
  return { api, live };
}

/** Execute a captured page expression against a fake window. */
function runInPage(expression, api) {
  const window = { TradingViewApi: { _activeChartWidgetWV: { value: () => api } } };
  return new Function('window', `return (${expression});`)(window);
}

const PINE_A_ID = [];
const PINE_B_ID = [];
const STUDIES = [
  { name: 'TC-RTA V6', id: PINE_A_ID, scriptId: 'Script$USER;aaa@tv-scripting', inputs: [{ id: 'len', value: 9 }] },
  { name: 'sweep probe', id: PINE_B_ID, scriptId: 'Script$USER;bbb@tv-scripting', inputs: [{ id: 'len', value: 3 }] },
  { name: 'Volume', id: 'T4x6LH', inputs: [{ id: 'length', value: 20 }] },
];

describe('isUsableStudyId()', () => {
  it('accepts a non-empty string and rejects everything TradingView actually returns instead', () => {
    assert.equal(isUsableStudyId('T4x6LH'), true);
    assert.equal(isUsableStudyId([]), false, 'the empty array is what Pine studies get');
    assert.equal(isUsableStudyId(''), false);
    assert.equal(isUsableStudyId(null), false);
    assert.equal(isUsableStudyId(undefined), false);
    assert.equal(isUsableStudyId(0), false);
  });
});

describe('the study resolver runs in the page, where the reference still exists', () => {
  const resolve = (api, ref) =>
    runInPage(`(function(){ var chart = window.TradingViewApi._activeChartWidgetWV.value();
      ${STUDY_RESOLVER_JS()}
      var r = __tvResolveStudy(chart, ${JSON.stringify(ref)});
      return { error: r.error, name: r.resolved_name,
               inputs: r.study ? r.study.getInputValues() : null }; })()`, api);

  it('resolves a built-in study by its string id', () => {
    const { api } = fakeChart({ studies: STUDIES });
    const r = resolve(api, 'T4x6LH');
    assert.equal(r.error, null);
    assert.equal(r.name, 'Volume');
    assert.deepEqual(r.inputs, [{ id: 'length', value: 20 }]);
  });

  it('resolves a Pine study by name and gets THAT study, not the other one', () => {
    const { api } = fakeChart({ studies: STUDIES });
    const a = resolve(api, 'TC-RTA V6');
    const b = resolve(api, 'sweep probe');
    assert.equal(a.error, null);
    assert.equal(b.error, null);
    // Both ids serialize to []. Only reference identity tells them apart.
    assert.deepEqual(a.inputs, [{ id: 'len', value: 9 }]);
    assert.deepEqual(b.inputs, [{ id: 'len', value: 3 }]);
  });

  it('refuses an ambiguous name rather than picking one', () => {
    const dupes = [
      { name: 'Twin', id: [], inputs: [{ id: 'len', value: 1 }] },
      { name: 'Twin', id: [], inputs: [{ id: 'len', value: 2 }] },
    ];
    const { api } = fakeChart({ studies: dupes });
    const r = resolve(api, 'Twin');
    assert.match(r.error, /2 studies are named/);
    assert.equal(r.inputs, null);
  });

  it('names what IS on the chart when nothing matches', () => {
    const { api } = fakeChart({ studies: STUDIES });
    const r = resolve(api, 'Nope');
    assert.match(r.error, /no study matched/);
    assert.match(r.error, /TC-RTA V6/);
    assert.match(r.error, /T4x6LH/);
    assert.match(r.error, /address it by name/);
  });

  it('contains no backtick, so it is safe inside the template literals that embed it', () => {
    // Third time this project has been bitten by a template-literal escape.
    assert.ok(!STUDY_RESOLVER_JS().includes('`'), 'a backtick would terminate the host template literal');
  });
});

describe('chart.getState() stops handing out an unusable id', () => {
  const capture = async () => {
    const evaluate = mockEvaluate();
    await chart.getState({ _deps: { evaluate, evaluateAsync: evaluate } });
    return evaluate.calls[0];
  };

  it('reports null, not [], for a study TradingView gives no serializable id', async () => {
    const expr = await capture();
    const { api } = fakeChart({ studies: STUDIES });
    const state = runInPage(expr, api);
    const pine = state.studies.find((s) => s.name === 'TC-RTA V6');
    assert.equal(pine.id, null, 'an empty array must never be presented as an entity_id');
    assert.equal(pine.addressable_by, 'name');
    assert.match(pine.id_note, /Pass its name as entity_id/);
    assert.equal(pine.script_id, 'Script$USER;aaa@tv-scripting');
  });

  it('leaves a real string id alone and adds no noise to it', async () => {
    const expr = await capture();
    const { api } = fakeChart({ studies: STUDIES });
    const state = runInPage(expr, api);
    const builtin = state.studies.find((s) => s.name === 'Volume');
    assert.equal(builtin.id, 'T4x6LH');
    assert.equal(builtin.addressable_by, undefined);
    assert.equal(builtin.script_id, undefined);
  });
});

describe('manageIndicator remove proves the study went', () => {
  const captureRemove = async (entity_id) => {
    const evaluate = mockEvaluate();
    await chart.manageIndicator({ action: 'remove', entity_id, _deps: { evaluate, evaluateAsync: evaluate } })
      .catch(() => {});
    return evaluate.calls[evaluate.calls.length - 1];
  };

  it('removes a Pine study addressed by name and reports the counts', async () => {
    const expr = await captureRemove('sweep probe');
    const { api, live } = fakeChart({ studies: STUDIES });
    const r = runInPage(expr, api);
    assert.equal(r.error, undefined);
    assert.equal(r.removed_name, 'sweep probe');
    assert.equal(r.before, 3);
    assert.equal(r.after, 2);
    assert.ok(!live.some((s) => s.name === 'sweep probe'));
  });

  it('reports before === after when removeEntity did nothing, so the caller can refuse', async () => {
    const expr = await captureRemove('Volume');
    const { api } = fakeChart({ studies: STUDIES, removeIsNoop: true });
    const r = runInPage(expr, api);
    assert.equal(r.before, r.after, 'a no-op removal must not look like a successful one');
  });

  it('surfaces a throw from removeEntity instead of swallowing it', async () => {
    const expr = await captureRemove('Volume');
    const { api } = fakeChart({ studies: STUDIES, removeThrows: true });
    const r = runInPage(expr, api);
    assert.match(r.error, /removeEntity threw/);
  });

  it('throws rather than returning success when the count does not drop', async () => {
    const evaluate = async () => ({ before: 3, after: 3, removed_name: 'Volume' });
    evaluate.calls = [];
    await assert.rejects(
      () => chart.manageIndicator({ action: 'remove', entity_id: 'Volume', _deps: { evaluate, evaluateAsync: evaluate } }),
      /still has 3 studies/,
    );
  });

  it('throws when the page returns nothing at all', async () => {
    const evaluate = async () => undefined;
    await assert.rejects(
      () => chart.manageIndicator({ action: 'remove', entity_id: 'Volume', _deps: { evaluate, evaluateAsync: evaluate } }),
      /returned nothing/,
    );
  });
});

/**
 * snapshot() CAPTURED NO metaInfo FOR ANY STUDY, WHILE THE README PROMISED IT.
 *
 * The dataSource index was built as `if (srcId) dsById[srcId] = src`, and for a
 * Pine dataSource `src.id()` returns the empty string. Empty string is falsy,
 * so not one Pine study ever entered that map. The lookup missed, the fallback
 * loop searched only that same map so it missed too, and full_meta_info came
 * back null for exactly the studies that need it: private Pine, which restore
 * cannot rebuild any other way.
 *
 * Worse, with no metaInfo the study was not recognised as Pine, so its encoded
 * source input was stripped as "oversized". Measured on a real indicator:
 * 66 inputs captured instead of 67, and the missing one was the source blob.
 */
describe('snapshot attributes metaInfo to Pine studies', () => {
  const captureStudiesExpr = async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (/getStudyById\s*\(/.test(expr)) return [];
      if (expr.includes('getAllStudies')) return { symbol: 'A', resolution: 'D', chartType: 1, studies: [] };
      return undefined;
    };
    const state = await import('../src/core/state.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sa-'));
    await state.snapshot({
      name: 'x',
      _snapshots_dir: dir,
      _deps: {
        evaluate, evaluateAsync: evaluate, waitForChartReady: async () => true,
        getChartApi: async () => 'window.__api',
        paneList: async () => ({ panes: [{ index: 0, symbol: 'A', resolution: 'D' }] }),
        drawingList: async () => ({ shapes: [] }),
      },
    }).catch(() => {});
    return calls.find((c) => /getStudyById\s*\(/.test(c));
  };

  /** Fake chart whose dataSources behave like the real ones for Pine and built-ins. */
  function pageWith(studies) {
    const live = studies.map((s) => ({ ...s }));
    return {
      getAllStudies: () => live.map((s) => ({ id: s.id, name: s.name })),
      getStudyById: (id) => {
        const hit = live.find((s) => s.id === id);
        if (!hit) throw new Error('There is no such study');
        return { getInputValues: () => hit.inputs || [] };
      },
      _chartWidget: {
        model: () => ({
          model: () => ({
            dataSources: () => live.map((s) => ({
              // A Pine dataSource reports the EMPTY STRING as its id.
              id: () => (s.pine ? '' : s.id),
              metaInfo: () => ({
                description: s.name,
                id: s.pine ? `Script$USER;${s.name}@tv-scripting` : `${s.name}@tv-basicstudies`,
                ...(s.pine ? { scriptIdPart: `USER;${s.name}` } : {}),
              }),
            })),
          }),
        }),
      },
    };
  }

  const run = (expr, api) => {
    const window = { TradingViewApi: { _activeChartWidgetWV: { value: () => api } } };
    return new Function('window', `return (${expr});`)(window);
  };

  const BIG = 'x'.repeat(900);

  it('attributes metaInfo to a Pine study whose dataSource id is the empty string', async () => {
    const expr = await captureStudiesExpr();
    const api = pageWith([
      { name: 'TC-RTA V6', id: [], pine: true, inputs: [{ id: 'src', value: BIG }, { id: 'len', value: 9 }] },
      { name: 'Volume', id: 'T4x6LH', inputs: [{ id: 'length', value: 20 }] },
    ]);
    const out = run(expr, api);
    const pine = out.find((s) => s.name === 'TC-RTA V6');
    assert.ok(pine.full_meta_info, 'a Pine study must carry its metaInfo or restore cannot rebuild it');
    assert.equal(pine.scriptIdPart, 'USER;TC-RTA V6');
    assert.equal(pine.meta_unavailable_reason, null);
    assert.equal(pine.id, null, 'the empty-array id must not be recorded as an id');
  });

  it('keeps the oversized source input for Pine, which is the part restore needs', async () => {
    const expr = await captureStudiesExpr();
    const api = pageWith([
      { name: 'TC-RTA V6', id: [], pine: true, inputs: [{ id: 'src', value: BIG }, { id: 'len', value: 9 }] },
    ]);
    const pine = run(expr, api)[0];
    assert.equal(pine.inputs.length, 2, 'the encoded source blob must survive');
    assert.equal(pine.strippedInputs.length, 0);
  });

  it('still strips an oversized input from a built-in, which has no reason to carry one', async () => {
    const expr = await captureStudiesExpr();
    const api = pageWith([
      { name: 'Volume', id: 'T4x6LH', inputs: [{ id: 'junk', value: BIG }, { id: 'length', value: 20 }] },
    ]);
    const builtin = run(expr, api)[0];
    assert.equal(builtin.inputs.length, 1);
    assert.equal(builtin.strippedInputs.length, 1);
    assert.equal(builtin.strippedInputs[0].value_length, 900);
  });

  it('refuses to attribute metaInfo when two studies share a name, and says why', async () => {
    const expr = await captureStudiesExpr();
    const api = pageWith([
      { name: 'Twin', id: [], pine: true, inputs: [] },
      { name: 'Twin', id: [], pine: true, inputs: [] },
    ]);
    const out = run(expr, api);
    for (const s of out) {
      assert.equal(s.full_meta_info, null, 'guessing here would make restore rebuild the wrong script');
      assert.match(s.meta_unavailable_reason, /share this name/);
    }
  });

  it('resolves a built-in by its real dataSource id, not by name', async () => {
    const expr = await captureStudiesExpr();
    const api = pageWith([{ name: 'Volume', id: 'T4x6LH', inputs: [{ id: 'length', value: 20 }] }]);
    const builtin = run(expr, api)[0];
    assert.equal(builtin.id, 'T4x6LH');
    assert.equal(builtin.scriptIdPart, null, 'a built-in has no scriptIdPart');
  });
});
