/**
 * TV_MCP_READONLY=1 — register ONLY the tools that cannot mutate the user's TradingView state.
 *
 * WHY THIS EXISTS
 *
 * An MCP grant is server-level, not per-tool. A host that is allowed to talk to tvcontrol at
 * all is allowed to call every tool tvcontrol registers. That is fine when a human approves
 * each call. It is not fine for an UNATTENDED run — a scheduled 07:00 briefing, a cron job, a
 * CI agent — where nobody approves anything and the account on the other end is a real trading
 * account. In that context the same grant that lets an agent read a Pine table also lets it
 * call watchlist_remove_bulk, alert_delete, draw_clear, pine_save or tv_launch.
 *
 * With TV_MCP_READONLY=1 the mutating tools are NOT REGISTERED. They are absent from
 * tools/list and a call to one is rejected by the MCP layer as an unknown tool. The safety
 * property is structural, not a promise the model is asked to keep.
 *
 * THE LINE THIS ALLOWLIST DRAWS
 *
 * Read-only here means "cannot change anything the user owns", not "does not touch the app":
 *
 *   ALLOWED — pure reads; reads that open and close a panel to get their answer; reads that
 *   write a NEW local artifact (a screenshot, a state snapshot file); and chart NAVIGATION —
 *   symbol, timeframe, visible range, pane focus, tab and layout switching. Navigation moves
 *   the view of a human who may be watching, which is why it is called out rather than waved
 *   through, but it destroys nothing and is undone by navigating back. A universe scan cannot
 *   work without it: reading a Pine table for 74 symbols means setting the symbol 74 times.
 *
 *   DENIED — anything that PERSISTS or DESTROYS: watchlist edits, alert create/delete,
 *   drawing writes, indicator add/remove/retune, Pine buffer writes and saves, replay (which
 *   takes the chart out of realtime and can place simulated trades), state_restore (documented
 *   destructive — it makes the chart MATCH the snapshot, dropping studies and drawings),
 *   state_delete, layout structure changes, tab create/close, strategy_sweep (it rewrites
 *   indicator inputs), and every process-level action: tv_launch, tv_update, tv_repair_chart,
 *   watchdog start/stop. Raw UI actuation (ui_click, ui_keyboard, ui_type_text, ui_mouse_click,
 *   ui_scroll, ui_hover, ui_fullscreen, ui_open_panel) is denied because it is a general-purpose
 *   mutation primitive: anything the mouse can do to the account, it can do.
 *
 * THREE CALLS WORTH ARGUING WITH — deliberate, and cheap to reverse if you disagree:
 *
 *   watchlist_export — non-mutating for TradingView, but it takes a caller-supplied
 *   destination path and overwrites it. The path allowlist keeps that inside $HOME or /tmp,
 *   which still covers plenty of files somebody cares about. A read tool that can clobber a
 *   file is not a read tool in an unattended run.
 *
 *   tv_support_bundle / tv_compatibility_snapshot — non-mutating for TradingView, but one
 *   packages identifiers, URLs and source into a durable artifact and the other records a
 *   compatibility BASELINE that later runs compare themselves against. Neither has any read
 *   value for an unattended brief, and both leave something behind that nobody reviewed.
 *
 *   pine_check — posts caller-supplied Pine source to a third-party compile endpoint. It
 *   changes nothing, but paired with pine_get_source it is an egress path for a private
 *   strategy. Breaking one half of that pair costs an unattended run nothing.
 *
 * FAIL CLOSED. The allowlist is an ENUMERATION, so a tool added tomorrow is denied under
 * readonly until somebody puts it in this list on purpose. tests/readonly.test.js asserts
 * every name here exists in the live catalog, so the list cannot rot into fiction either.
 */

/**
 * Tools registered when TV_MCP_READONLY=1. Grouped by why, not alphabetically, so the
 * classification is reviewable.
 */
export const READONLY_TOOLS = Object.freeze([
  // Diagnostics and health — pure reads.
  'tv_health_check',
  'tv_chart_health',
  'tv_discover',
  'tv_compatibility_check',
  'tv_capability_matrix',
  'tv_ui_state',
  'tv_watchdog_sample',
  'tv_watchdog_status',
  'tv_watchdog_history',

  // Chart reads.
  'chart_get_state',
  'chart_get_visible_range',
  'symbol_info',
  'symbol_search',
  'chart_vision_read',

  // Chart NAVIGATION — restorable view changes, required by any universe scan.
  'chart_set_symbol',
  'chart_set_timeframe',
  'chart_set_visible_range',
  'chart_scroll_to_date',
  'pane_focus',
  'pane_set_symbol',
  'tab_switch',
  'layout_switch',

  // Layout / pane / tab reads.
  'pane_list',
  'tab_list',
  'layout_list',
  'layout_get_active',

  // Market and study data reads.
  'data_get_ohlcv',
  'data_get_indicator',
  'data_get_study_values',
  'data_get_strategy_results',
  'data_get_trades',
  'data_get_equity',
  'data_get_pine_lines',
  'data_get_pine_labels',
  'data_get_pine_tables',
  'data_get_pine_boxes',
  'quote_get',
  'quote_batch',
  'depth_get',

  // Watchlist reads.
  'watchlist_list',
  'watchlist_get',
  'watchlist_get_by_id',

  // Alert, drawing and indicator reads.
  'alert_list',
  'draw_list',
  'draw_get_properties',
  'indicator_search',
  'indicator_get_inputs',

  // Pine reads and offline static analysis.
  'pine_get_source',
  'pine_get_errors',
  'pine_get_console',
  'pine_list_scripts',
  'pine_analyze',

  // Replay status is a read; every other replay verb changes chart mode.
  'replay_status',

  // Local artifacts: state_snapshot and capture_screenshot write a new file and touch
  // nothing on the account. state_restore and state_delete are on the other side of the line.
  'state_list',
  'state_snapshot',
  'capture_screenshot',

  // ui_find_element reports positions; it does not click.
  'ui_find_element',

  // batch_run's action enum contains read actions ONLY (screenshot, get_ohlcv,
  // get_strategy_results, get_study_values, get_pine_tables) and it restores the starting
  // symbol/timeframe in a finally block. It is the tool a universe scan is built on.
  // tests/readonly.test.js pins that enum, so adding a mutating action there fails the suite
  // instead of silently opening a hole in this gate.
  'batch_run',
]);

const _ALLOWED = new Set(READONLY_TOOLS);

/** True when the server was started with TV_MCP_READONLY=1. */
export function isReadonlyMode(env = process.env) {
  return env.TV_MCP_READONLY === '1';
}

/**
 * The single answer to "does this tool get registered in this process".
 * Used by src/server.js (which enforces it) and by the capability matrix (which reports it),
 * so the server and its own self-description cannot disagree.
 *
 * Readonly WINS over TV_MCP_ADVANCED: ui_evaluate runs arbitrary JS in the authenticated page,
 * so a readonly session must not expose it even if the advanced flag is also set.
 */
export function isToolRegistered(name, env = process.env) {
  if (isReadonlyMode(env)) return _ALLOWED.has(name);
  return name !== 'ui_evaluate' || env.TV_MCP_ADVANCED === '1';
}
