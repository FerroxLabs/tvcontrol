// Regression test for batch_run's action list.
//
// get_study_values was DOCUMENTED BUT NEVER IMPLEMENTED. The server's own tool
// guide and the market-open scan skill both instruct callers to run
//   batch_run({ symbols: [...], action: "get_study_values" })
// as the core step of a universe scan. The enum did not contain it and neither
// did the core's VALID_ACTIONS, so every such call died at validation and the
// documented flagship workflow was impossible. Found by sweeping all 101 tools
// on 2026-08-20; verified working afterwards against AAPL and MSFT.
//
// There are TWO gates — the zod enum in the tool and VALID_ACTIONS in the core.
// Updating one and not the other still leaves the action dead, which is exactly
// what happened on the first attempt at this fix.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/batch.js', import.meta.url), 'utf-8');
const tool = readFileSync(new URL('../src/tools/batch.js', import.meta.url), 'utf-8');

test('the tool schema accepts get_study_values', () => {
  assert.ok(/get_study_values/.test(tool),
    'the zod enum no longer accepts get_study_values; the documented scan workflow fails at validation');
});

test('the core action allowlist accepts get_study_values', () => {
  const m = core.match(/const VALID_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'VALID_ACTIONS is gone or restructured');
  assert.ok(/get_study_values/.test(m[1]),
    'VALID_ACTIONS omits get_study_values, so the action passes schema validation and then dies in the core');
});

test('the core actually dispatches the action', () => {
  assert.ok(/action === 'get_study_values'/.test(core),
    'nothing handles get_study_values in the dispatch chain');
  assert.ok(/getStudyValues/.test(core),
    'getStudyValues is not imported or wired into deps');
});

test('all four actions are consistent between schema and core', () => {
  const m = core.match(/const VALID_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  const coreActions = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  const enumMatch = tool.match(/z\.enum\(\[([^\]]*)\]\)/);
  const toolActions = [...enumMatch[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepStrictEqual(toolActions, coreActions,
    'the tool enum and the core allowlist disagree; one of them will silently reject a documented action');
});

// ---------------------------------------------------------------------------
// get_pine_tables — added 2026-08-27 so a strategy's own decision table can be
// read across a universe in one call instead of a round trip per symbol.
//
// The note above names TWO gates. There are THREE. A string check proves the
// enum and VALID_ACTIONS agree; it cannot prove the dispatch chain routes the
// action anywhere, and an action that validates and then falls through to the
// wrong branch is exactly as dead as one that fails validation, while looking
// healthier. The last test here executes it.
// ---------------------------------------------------------------------------

test('the tool schema accepts get_pine_tables', () => {
  assert.ok(/get_pine_tables/.test(tool),
    'the zod enum no longer accepts get_pine_tables; the universe scan fails at validation');
});

test('the core accepts get_pine_tables', () => {
  assert.ok(/VALID_ACTIONS[^;]*get_pine_tables/s.test(core),
    'VALID_ACTIONS no longer contains get_pine_tables; the tool accepts a call the core refuses');
});

test('study_filter reaches the core rather than being dropped at the tool', () => {
  // Without this the tool advertises an argument it silently discards, and every
  // symbol comes back carrying every indicator on the chart.
  assert.ok(/study_filter/.test(tool), 'the tool no longer declares study_filter');
  assert.ok(/study_filter/.test(core), 'the core no longer accepts study_filter');
});

test('get_pine_tables DISPATCHES to the pine-table reader', async () => {
  const { batchRun } = await import('../src/core/batch.js');
  const called = [];
  const stub = (name, value) => async (...a) => { called.push(name); return value; };
  const res = await batchRun({
    symbols: ['NASDAQ:AAPL'],
    action: 'get_pine_tables',
    study_filter: 'Anything',
    delay_ms: 0,
    _deps: {
      getChartState: stub('getChartState', { symbol: 'X', resolution: '1D' }),
      setSymbol: stub('setSymbol', {}),
      setTimeframe: stub('setTimeframe', {}),
      waitForChartReady: async () => true,
      sleep: async () => {},
      getPineTables: stub('getPineTables', { studies: [{ name: 'Anything', tables: [{ rows: ['R'] }] }] }),
      // If dispatch routes to the wrong branch, one of these fires and the
      // assertion below names which — a silent wrong-branch is the failure mode.
      getStudyValues: stub('getStudyValues', {}),
      getOhlcv: stub('getOhlcv', {}),
      getStrategyResults: stub('getStrategyResults', {}),
      captureScreenshot: stub('captureScreenshot', {}),
    },
  });
  assert.ok(called.includes('getPineTables'),
    `get_pine_tables did not reach the pine-table reader; it called: ${called.join(', ')}`);
  for (const wrong of ['getStudyValues', 'getOhlcv', 'getStrategyResults', 'captureScreenshot']) {
    assert.ok(!called.includes(wrong), `get_pine_tables dispatched to ${wrong} instead`);
  }
  assert.equal(res.results[0].result.studies[0].tables[0].rows[0], 'R',
    'the reader\'s output did not survive back to the caller');
});
