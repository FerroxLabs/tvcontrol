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
