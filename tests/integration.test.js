import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import all register functions
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
// Power-toolkit additions:
import { registerStateTools } from '../src/tools/state.js';
import { registerSweepTools } from '../src/tools/sweep.js';
import { registerVisionTools } from '../src/tools/vision.js';

function mockServer() {
  const tools = [];
  return { tool: (name, desc, schema, handler) => tools.push({name, desc}), _tools: tools };
}

describe('MCP tool registration — integration', () => {
  it('registers all tool groups without throwing', () => {
    const server = mockServer();
    registerHealthTools(server);
    registerChartTools(server);
    registerPineTools(server);
    registerDataTools(server);
    registerCaptureTools(server);
    registerDrawingTools(server);
    registerAlertTools(server);
    registerBatchTools(server);
    registerReplayTools(server);
    registerIndicatorTools(server);
    registerWatchlistTools(server);
    registerUiTools(server);
    registerPaneTools(server);
    registerTabTools(server);
    registerStateTools(server);
    registerSweepTools(server);
    registerVisionTools(server);
    assert.ok(server._tools.length > 0);
  });

  it('registers power-toolkit tools (smoke)', () => {
    const server = mockServer();
    // Register only the new ones
    registerAlertTools(server);
    registerWatchlistTools(server);
    registerStateTools(server);
    registerSweepTools(server);
    registerVisionTools(server);
    const names = server._tools.map(t => t.name);

    // Alert delete by id
    assert.ok(names.includes('alert_delete_by_id'), 'alert_delete_by_id registered');
    // Watchlist CRUD
    assert.ok(names.includes('watchlist_remove'));
    assert.ok(names.includes('watchlist_export'));
    assert.ok(names.includes('watchlist_import'));
    // State
    assert.ok(names.includes('state_snapshot'));
    assert.ok(names.includes('state_restore'));
    assert.ok(names.includes('state_list'));
    assert.ok(names.includes('state_delete'));
    // Sweep
    assert.ok(names.includes('strategy_sweep'));
    // Vision
    assert.ok(names.includes('chart_vision_read'));
  });

  it('telemetry DEFAULT_EXCLUDE entries match real registered tool names (L9)', async () => {
    const server = mockServer();
    registerHealthTools(server);
    registerChartTools(server);
    registerPineTools(server);
    registerDataTools(server);
    registerCaptureTools(server);
    registerDrawingTools(server);
    registerAlertTools(server);
    registerBatchTools(server);
    registerReplayTools(server);
    registerIndicatorTools(server);
    registerWatchlistTools(server);
    registerUiTools(server);
    registerPaneTools(server);
    registerTabTools(server);
    registerStateTools(server);
    registerSweepTools(server);
    registerVisionTools(server);
    const registered = new Set(server._tools.map(t => t.name));

    // Re-import the source to read the literal DEFAULT_EXCLUDE rather than
    // using the runtime export (kept private). The contract: every excluded
    // name must correspond to an actually-registered tool, otherwise a rename
    // would silently start being telemetered.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/core/telemetry.js', import.meta.url), 'utf8');
    const m = src.match(/DEFAULT_EXCLUDE\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'could not locate DEFAULT_EXCLUDE in telemetry.js');
    // Capture every quoted string. Use \w+ so an accidental TYPO (uppercase,
    // digits) is still extracted — otherwise the drift detector would silently
    // skip malformed entries instead of failing on them.
    const excluded = [...m[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1]);
    assert.ok(excluded.length >= 2, `expected at least 2 DEFAULT_EXCLUDE entries, found ${excluded.length}: ${JSON.stringify(excluded)}`);
    // Sanity: the canonical pair must be present (either typo would drop one
    // and fail this assertion before the per-name check runs).
    assert.ok(excluded.includes('tv_health_check'), `DEFAULT_EXCLUDE missing canonical 'tv_health_check' — got ${JSON.stringify(excluded)}`);
    assert.ok(excluded.includes('chart_get_state'), `DEFAULT_EXCLUDE missing canonical 'chart_get_state' — got ${JSON.stringify(excluded)}`);
    for (const name of excluded) {
      assert.ok(registered.has(name), `DEFAULT_EXCLUDE entry "${name}" is not a registered tool — rename drift`);
    }
  });

  it('strictResolve catches typoed _deps keys', async () => {
    // Public-API entry points (state, sweep, vision, data) strict-check
    // their _deps. A typo'd key should throw a TypeError rather than
    // silently fall through to the real CDP function.
    const { snapshot } = await import('../src/core/state.js');
    await assert.rejects(
      () => snapshot({
        name: 'typo-test',
        _snapshots_dir: '/tmp/should-never-write',
        _deps: {
          evaluate: async () => ({}),
          paaneList: async () => ({}), // typo
        },
      }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /paaneList/);
        assert.match(err.message, /Unknown _deps/);
        return true;
      },
    );
  });

  it('ui_evaluate is gated behind TV_MCP_ADVANCED (arbitrary-JS RCE surface)', () => {
    const prev = process.env.TV_MCP_ADVANCED;
    try {
      delete process.env.TV_MCP_ADVANCED;
      const off = mockServer();
      registerUiTools(off);
      assert.ok(!off._tools.some(t => t.name === 'ui_evaluate'),
        'ui_evaluate must NOT be registered without TV_MCP_ADVANCED=1');

      process.env.TV_MCP_ADVANCED = '1';
      const on = mockServer();
      registerUiTools(on);
      assert.ok(on._tools.some(t => t.name === 'ui_evaluate'),
        'ui_evaluate must be registered when TV_MCP_ADVANCED=1');
    } finally {
      if (prev === undefined) delete process.env.TV_MCP_ADVANCED;
      else process.env.TV_MCP_ADVANCED = prev;
    }
  });

  it('no raw "throw new Error" left in src/core/ — all errors must be ClassifiedError', async () => {
    // CI guard: every error thrown from src/core/ must carry a category +
    // hint so MCP clients can branch + display remediation steps. Any new
    // raw `throw new Error(...)` in src/core/*.js will fail this test.
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/core/', import.meta.url);
    const offenders = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = readFileSync(new URL(f, dir), 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/throw\s+new\s+Error\s*\(/.test(lines[i])) {
          offenders.push(`src/core/${f}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    assert.equal(offenders.length, 0,
      `Found ${offenders.length} raw throw new Error sites in src/core/ — convert to ClassifiedError:\n${offenders.join('\n')}`);
  });

  it('every tool name is unique (no collisions)', () => {
    const server = mockServer();
    registerHealthTools(server);
    registerChartTools(server);
    registerPineTools(server);
    registerDataTools(server);
    registerCaptureTools(server);
    registerDrawingTools(server);
    registerAlertTools(server);
    registerBatchTools(server);
    registerReplayTools(server);
    registerIndicatorTools(server);
    registerWatchlistTools(server);
    registerUiTools(server);
    registerPaneTools(server);
    registerTabTools(server);
    registerStateTools(server);
    registerSweepTools(server);
    registerVisionTools(server);
    const names = server._tools.map(t => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, 'duplicate tool names: ' + JSON.stringify(names.filter((n, i) => names.indexOf(n) !== i)));
  });
});
