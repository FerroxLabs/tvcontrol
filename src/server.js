#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { disconnect } from './connection.js';
import { flushNow as flushTelemetry } from './core/telemetry.js';
import { errorResult, instrument } from './tools/_format.js';
import { coordinateMcpHandler } from './core/coordination.js';
import { gateToolHandler } from './core/capabilities.js';
import { isReadonlyMode, isToolRegistered } from './core/readonly.js';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerVisionTools } from './tools/vision.js';
import { registerStateTools } from './tools/state.js';
import { registerSweepTools } from './tools/sweep.js';
import { discoverToolCatalog } from './core/capabilities.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// THE SERVER WAS LYING ABOUT ITSELF.
//
// Measured 2026-08-21: package.json said 2.2.6, npm shipped 2.2.6, and this
// file introduced itself to every client as version 2.2.1 with 102 tools while
// actually registering 103 of a 104-tool catalog. Three hand-maintained numbers,
// all wrong, none of them checked by anything. A tool count is the first thing
// an agent reads and the last thing anyone remembers to bump.
//
// Derive all three. The catalog scan is the same one tv_capability_matrix uses,
// so the server and the matrix can no longer disagree.
const _pkg = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const CATALOG = discoverToolCatalog();
const GATED = CATALOG.filter((name) => name === 'ui_evaluate');
const TOOL_COUNT = CATALOG.length;
const DEFAULT_COUNT = TOOL_COUNT - GATED.length;

// What this process will ACTUALLY register. Equals DEFAULT_COUNT in normal operation and
// drops to the read-only allowlist under TV_MCP_READONLY=1. The headline count and the
// description are derived from this rather than from DEFAULT_COUNT, because a read-only
// server that introduces itself with the full count is lying in the same way the 2.2.1
// hardcoded count was.
const READONLY = isReadonlyMode();
const REGISTERED_COUNT = CATALOG.filter((name) => isToolRegistered(name)).length;

const server = new McpServer(
  {
    name: 'tvcontrol',
    version: _pkg.version,
    description: `AI remote control for TradingView Desktop — ${REGISTERED_COUNT} MCP tools driving symbols, indicators, Pine Script, snapshots, sweeps, diagnostics, and live chart vision over CDP.`,
  },
  {
    instructions: `tvcontrol — ${REGISTERED_COUNT} tools for reading, diagnosing, and controlling a live TradingView Desktop chart over Chrome DevTools Protocol.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

Advanced (opt-in): ui_evaluate (run arbitrary page JS) is GATED behind the TV_MCP_ADVANCED=1 env var and is NOT registered by default. Of the ${TOOL_COUNT}-tool catalog, ${DEFAULT_COUNT} are available unless that flag is set.${READONLY ? `

READ-ONLY MODE IS ACTIVE (TV_MCP_READONLY=1). Only the ${REGISTERED_COUNT} tools that cannot mutate this TradingView account are registered in this session. Every mutating tool — watchlist edits, alert create/delete, drawing writes, indicator changes, Pine saves, replay, state_restore, tv_launch — is ABSENT from this list, not merely discouraged, and calling one returns an unknown-tool error. Chart navigation (symbol, timeframe, visible range, pane/tab/layout switching) IS available: it moves the view of anyone watching the chart, so restore what you changed when you are done.` : ''}

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  }
);

// Monkey-patch server.tool() to auto-wrap every handler with telemetry.
// This means instrument() fires for all tools without touching each tool file.
// Use rest args so we survive both the 4-arg form (name, desc, schema, handler)
// and the SDK's 3-arg form (name, schema, handler) — the latter would
// previously crash startup with `handler is undefined`.
const _origTool = server.tool.bind(server);
server.tool = (name, ...rest) => {
  // THE READ-ONLY GATE. One choke point, applied before anything else, so a tool added to any
  // tool file in future is denied under TV_MCP_READONLY=1 until it is named in the allowlist.
  // Skipping registration (rather than refusing at call time) is the point: the tool never
  // appears in tools/list, so there is nothing for an unattended agent to try.
  if (!isToolRegistered(name)) return undefined;
  const handler = rest[rest.length - 1];
  const gated = gateToolHandler(name, coordinateMcpHandler(name, handler));
  rest[rest.length - 1] = instrument(name, async (...args) => {
    try { return await gated(...args); }
    catch (err) { return errorResult(err); }
  });
  return _origTool(name, ...rest);
};

// Register all tool groups
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

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tvcontrol  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic, PBC.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

// Graceful shutdown: close the CDP WebSocket so TradingView's DevTools server
// releases the attached target session instead of leaking it on every MCP-host
// restart (sessions accumulate until Electron refuses new DevTools clients). A
// bare SIGTERM listener also suppresses Node's default-terminate, so without
// this exit the process would hang on `kill`. Flush telemetry here because
// process.exit() does not emit beforeExit.
let _shuttingDown = false;
async function _gracefulShutdown(code) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { flushTelemetry(); } catch { /* best-effort — exiting regardless */ }
  try { await disconnect(); } catch { /* best-effort — exiting regardless */ }
  process.exit(code);
}
process.on('SIGTERM', () => { _gracefulShutdown(0); });
process.on('SIGINT', () => { _gracefulShutdown(130); });

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
