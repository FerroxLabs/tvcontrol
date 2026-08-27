/**
 * Public API for tradingview-mcp core.
 * Usage: import { chart, data, pine } from 'tradingview-mcp/core'
 */
export * as chart from './chart.js';
export * as data from './data.js';
export * as pine from './pine.js';
export * as health from './health.js';
export * as capture from './capture.js';
export * as drawing from './drawing.js';
export * as replay from './replay.js';
export * as alerts from './alerts.js';
export * as batch from './batch.js';
export * as watchlist from './watchlist.js';
export * as indicators from './indicators.js';
export * as ui from './ui.js';

// Everything under core/ that is PUBLIC and import-side-effect-free is part of this entry
// point. `telemetry` is deliberately excluded: it installs process-level 'beforeExit' and
// 'uncaughtException' handlers at module scope, so exporting it here would make merely
// importing this barrel hijack the host application's error handling. `chaos`, `soak` and
// `golden` are test harnesses, not API.
//
// The rest belong here. Nineteen modules were missing,
// including tab, state, pane and sweep, so `core.tab` was silently `undefined` for
// anyone importing the documented './core' path — a reach that throws no error and
// quietly selects whatever fallback the caller wrote for the failure case.
export * as capabilities from './capabilities.js';
export * as coordination from './coordination.js';
export * as pane from './pane.js';
export * as receipts from './receipts.js';
export * as session_health from './session_health.js';
export * as state from './state.js';
export * as stream from './stream.js';
export * as support from './support.js';
export * as sweep from './sweep.js';
export * as sweep_parallel from './sweep_parallel.js';
export * as tab from './tab.js';
export * as update from './update.js';
export * as vision from './vision.js';
export * as watchdog from './watchdog.js';
export * as watchdog_service from './watchdog_service.js';
