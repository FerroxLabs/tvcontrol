/**
 * Every registered MCP tool handler must be WIRED to something that exists.
 *
 * tests/integration.test.js asserts that tools register. Its mock server discards the
 * handler, so a handler whose body reaches for a module member that is not there registers
 * perfectly and fails only when a user calls it. That is not hypothetical: 2.4.0 shipped two
 * new watchlist tools calling `core.watchlist.list()` inside a file where `core` IS the
 * watchlist module. Both were dead through MCP. 736 offline tests passed.
 *
 * This runs every handler with no TradingView attached. A correctly wired handler fails at
 * the CONNECTION and returns a formatted error. A miswired one throws a TypeError from the
 * reference itself, before any I/O is attempted, and that is what this catches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerHealthTools } from '../src/tools/health.js';
import { registerChartTools } from '../src/tools/chart.js';
import { registerPineTools } from '../src/tools/pine.js';
import { registerDataTools } from '../src/tools/data.js';
import { registerCaptureTools } from '../src/tools/capture.js';
import { registerDrawingTools } from '../src/tools/drawing.js';
import { registerAlertTools } from '../src/tools/alerts.js';
import { registerBatchTools } from '../src/tools/batch.js';
import { registerReplayTools } from '../src/tools/replay.js';
import { registerIndicatorTools } from '../src/tools/indicators.js';
import { registerWatchlistTools } from '../src/tools/watchlist.js';
import { registerUiTools } from '../src/tools/ui.js';
import { registerPaneTools } from '../src/tools/pane.js';
import { registerTabTools } from '../src/tools/tab.js';
import { registerStateTools } from '../src/tools/state.js';
import { registerSweepTools } from '../src/tools/sweep.js';
import { registerVisionTools } from '../src/tools/vision.js';

function capturingServer() {
  const tools = [];
  return { tool: (name, desc, schema, handler) => tools.push({ name, handler }), _tools: tools };
}

function allTools() {
  const s = capturingServer();
  for (const reg of [registerHealthTools, registerChartTools, registerPineTools, registerDataTools,
    registerCaptureTools, registerDrawingTools, registerAlertTools, registerBatchTools,
    registerReplayTools, registerIndicatorTools, registerWatchlistTools, registerUiTools,
    registerPaneTools, registerTabTools, registerStateTools, registerSweepTools, registerVisionTools]) {
    reg(s);
  }
  return s._tools;
}

// A miswired reference. Anything else is a legitimate runtime failure with no chart attached.
const MISWIRED = /is not a function|Cannot read properties of undefined|is not defined|is not a constructor/i;

describe('every tool handler is wired to something that exists', () => {
  it('registers handlers, not just names', () => {
    const tools = allTools();
    assert.ok(tools.length > 100, `expected the full catalog, got ${tools.length}`);
    for (const t of tools) assert.equal(typeof t.handler, 'function', `${t.name} registered no handler`);
  });

  // Two handlers dereference a REQUIRED argument before they touch any module, so calling
  // them with {} produces the same message shape as a wiring fault. They are named here
  // rather than loosening the pattern, so a genuinely miswired handler still fails this
  // test. Keep this list short; a growing list means the check is being worked around.
  const ARG_SHAPE_ONLY = new Set(['pine_analyze', 'ui_open_panel']);

  it('no handler throws a wiring error when invoked', async () => {
    // TV_MCP_NO_CDP makes the connection layer refuse immediately instead of waiting on a
    // port that is not there, so this stays an offline test.
    process.env.TV_MCP_NO_CDP = '1';
    const broken = [];
    for (const t of allTools()) {
      if (ARG_SHAPE_ONLY.has(t.name)) continue;
      // The result must be INSPECTED, not merely awaited. Every handler wraps its body in
      // try/catch and RETURNS a formatted error, so a miswired reference never reaches a
      // catch block here. The first version of this test only caught throws, and the very
      // mutant it was written for survived it untouched.
      try {
        const res = await t.handler({});
        const text = JSON.stringify(res ?? '');
        if (MISWIRED.test(text)) broken.push(`${t.name}: ${text.slice(0, 160)}`);
      } catch (err) {
        if (MISWIRED.test(err?.message || '')) broken.push(`${t.name}: ${err.message}`);
      }
    }
    delete process.env.TV_MCP_NO_CDP;
    assert.deepEqual(broken, [], `miswired handler(s):\n  ${broken.join('\n  ')}`);
  });
});
