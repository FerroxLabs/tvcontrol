import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/health.js';
import * as watchdog from '../core/watchdog.js';
import { update } from '../core/update.js';
import { getCapabilityMatrix } from '../core/capabilities.js';
import { createSupportBundle } from '../core/support.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP, TradingView market-data connection, compatibility, and current chart state', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_compatibility_check', 'Canary for critical TradingView internal APIs used by TVControl. Reports the Desktop version and exactly which required capabilities are missing.', {}, async () => {
    try { return jsonResult(await core.compatibilityCheck()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_capability_matrix', 'Map every TVControl tool to its required TradingView APIs and report which tools are currently available or blocked.', {
    probe: z.coerce.boolean().optional().describe('Probe the live TradingView runtime (default true)'),
    force: z.coerce.boolean().optional().describe('Bypass the short compatibility cache (default false)'),
  }, async ({ probe, force }) => {
    try { return jsonResult(await getCapabilityMatrix({ probe: probe !== false, force })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_support_bundle', 'Create a privacy-safe compressed diagnostics bundle with identifiers, source code, URLs, titles, and secret-like values removed.', {
    telemetry_lines: z.coerce.number().int().min(0).max(500).optional().describe('Recent bounded telemetry records to include (default 100)'),
  }, async ({ telemetry_lines }) => {
    try { return jsonResult(await createSupportBundle({ telemetry_lines })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_compatibility_snapshot', 'Record, compare, or list immutable per-version TradingView API compatibility baselines. Critical failures and informational method drift are reported separately.', {
    action: z.enum(['compare', 'record', 'list']).optional().describe('Action (default compare)'),
    overwrite: z.coerce.boolean().optional().describe('Replace an existing version baseline when recording (default false)'),
  }, async ({ action, overwrite }) => {
    try { return jsonResult(await core.compatibilitySnapshot({ action, overwrite })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_watchdog_sample', 'Run one read-only health watchdog sample. Persists only state transitions and never chart symbols, URLs, or account data.', {}, async () => {
    try { return jsonResult(await watchdog.sampleWatchdog()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_watchdog_start', 'Start the read-only in-process health watchdog. Samples are coalesced and only state transitions are persisted.', {
    interval_ms: z.coerce.number().int().min(1000).max(300000).optional().describe('Sampling interval in milliseconds (default 15000)'),
  }, async ({ interval_ms }) => {
    try { return jsonResult(await watchdog.startWatchdog({ interval_ms })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_watchdog_stop', 'Stop the in-process health watchdog', {}, async () => {
    try { return jsonResult(watchdog.stopWatchdog()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_watchdog_status', 'Return watchdog runtime status and its latest privacy-safe sample', {}, async () => {
    try { return jsonResult(watchdog.watchdogStatus()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_watchdog_history', 'Return bounded privacy-safe watchdog state-transition history', {
    limit: z.coerce.number().int().min(1).max(500).optional().describe('Most recent transitions to return (default 100, max 500)'),
  }, async ({ limit }) => {
    try { return jsonResult(watchdog.watchdogHistory({ limit })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux.', {
    port: z.coerce.number().int().min(1).max(65535).optional().describe('CDP port 1-65535 (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Explicitly kill existing TradingView instances first (default false). This can discard unsaved TradingView state.'),
  }, async ({ port, kill_existing }) => {
    try { return jsonResult(await core.launch({ port, kill_existing })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tv_update', 'Safely fast-forward a clean git checkout from its configured upstream. Refuses package installs, untracked branches, dirty trees, and diverged history.', {}, async () => {
    try { return jsonResult(await update({})); }
    catch (err) { return errorResult(err); }
  });
}
