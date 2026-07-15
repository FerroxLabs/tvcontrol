import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const MUTATION_LOCK_FILE = join(homedir(), '.tv-mcp', 'mutation.lock');

export const MUTATING_MCP_TOOLS = new Set([
  'tv_launch', 'tv_update', 'tv_compatibility_snapshot', 'tv_watchdog_sample', 'tv_support_bundle',
  'chart_set_symbol', 'chart_set_timeframe', 'chart_set_type', 'chart_set_visible_range', 'chart_scroll_to_date', 'chart_manage_indicator',
  'pine_get_source', 'pine_set_source', 'pine_compile', 'pine_get_errors', 'pine_get_console', 'pine_smart_compile', 'pine_new', 'pine_open', 'pine_save',
  'draw_shape', 'draw_remove_one', 'draw_clear',
  'alert_create', 'alert_delete', 'alert_delete_by_id',
  'batch_run', 'strategy_sweep',
  'quote_get', 'data_get_indicator', 'data_get_strategy_results', 'data_get_trades', 'data_get_equity',
  'replay_start', 'replay_step', 'replay_stop', 'replay_autoplay', 'replay_trade',
  'indicator_search', 'indicator_add_from_search', 'indicator_set_inputs', 'indicator_toggle_visibility',
  'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove', 'watchlist_remove_bulk', 'watchlist_export', 'watchlist_import',
  'layout_switch', 'pane_set_layout', 'pane_focus', 'pane_set_symbol',
  'tab_new', 'tab_close', 'tab_switch',
  'state_snapshot', 'state_restore', 'state_delete', 'capture_screenshot',
  'ui_click', 'ui_evaluate', 'ui_fullscreen', 'ui_hover', 'ui_keyboard', 'ui_mouse_click', 'ui_open_panel', 'ui_scroll', 'ui_type_text',
]);

export const MUTATING_CLI_COMMANDS = new Set([
  'launch', 'update', 'compatibility', 'watchdog.sample', 'symbol', 'timeframe', 'type', 'range', 'scroll', 'sweep', 'screenshot', 'quote',
  'pine.get', 'pine.set', 'pine.compile', 'pine.raw-compile', 'pine.errors', 'pine.console', 'pine.save', 'pine.new', 'pine.open',
  'draw.shape', 'draw.remove', 'draw.clear',
  'alert.create', 'alert.delete',
  'replay.start', 'replay.step', 'replay.stop', 'replay.autoplay', 'replay.trade',
  'indicator.search', 'indicator.add-search', 'indicator.add', 'indicator.remove', 'indicator.toggle', 'indicator.set',
  'watchlist.add', 'watchlist.add-bulk', 'watchlist.remove', 'watchlist.export', 'watchlist.import',
  'layout.switch', 'pane.layout', 'pane.focus', 'pane.symbol',
  'tab.new', 'tab.close', 'tab.switch',
  'state.snapshot', 'state.restore', 'state.delete',
  'data.strategy', 'data.trades', 'data.equity', 'data.indicator',
  'ui.click', 'ui.keyboard', 'ui.hover', 'ui.scroll', 'ui.eval', 'ui.type', 'ui.panel', 'ui.fullscreen', 'ui.mouse',
  'log.clear', 'support', 'chaos', 'soak', 'golden', 'watchdog.install', 'watchdog.uninstall',
]);

/**
 * Acquire a token-owned filesystem lease. The heartbeat prevents a long
 * strategy sweep from looking stale, while token verification prevents an
 * expired owner from deleting a successor's lock during cleanup.
 */
export async function acquireFileLock({
  lockFile,
  purpose = 'operation',
  waitMs = 30000,
  staleMs = 300000,
  heartbeatMs = 10000,
  failOnTimeout = true,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  if (!lockFile) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'lockFile is required');
  mkdirSync(dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${now()}-${random().toString(36).slice(2)}`;
  const deadline = now() + waitMs;

  while (true) {
    try {
      writeFileSync(lockFile, JSON.stringify({ token, pid: process.pid, purpose, created_at: now() }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (now() - statSync(lockFile).mtimeMs > staleMs) {
          unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
      }
      if (now() >= deadline) {
        if (!failOnTimeout) return () => {};
        let owner = null;
        try { owner = JSON.parse(readFileSync(lockFile, 'utf8')); } catch (_) {}
        throw new ClassifiedError(
          CATEGORIES.API_UNEXPECTED,
          `Timed out waiting for another TVControl mutation (${owner?.purpose || 'unknown'})`,
          { hint: 'Wait for the running mutation to finish. If its process crashed, the lease will recover automatically after the stale timeout.' },
        );
      }
      await sleep(50 + Math.floor(random() * 100));
    }
  }

  const heartbeat = heartbeatMs > 0 ? setInterval(() => {
    try {
      const current = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (current?.token === token) {
        const stamp = new Date();
        utimesSync(lockFile, stamp, stamp);
      }
    } catch (_) { /* lease was removed or replaced */ }
  }, heartbeatMs) : null;
  heartbeat?.unref?.();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      const current = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (current?.token === token) unlinkSync(lockFile);
    } catch (_) { /* stale cleanup or another owner already replaced it */ }
  };
}

export async function withMutationLock(purpose, fn, options = {}) {
  const release = await acquireFileLock({
    lockFile: options.lockFile || MUTATION_LOCK_FILE,
    purpose,
    waitMs: options.waitMs ?? 30000,
    staleMs: options.staleMs ?? 300000,
    heartbeatMs: options.heartbeatMs ?? 10000,
    ...options,
  });
  try {
    return await fn();
  } finally {
    release();
  }
}

export function coordinateMcpHandler(name, handler) {
  if (!MUTATING_MCP_TOOLS.has(name)) return handler;
  return (...args) => withMutationLock(`mcp:${name}`, () => handler(...args));
}

export function coordinateCliHandler(name, handler) {
  if (!MUTATING_CLI_COMMANDS.has(name)) return handler;
  return (...args) => withMutationLock(`cli:${name}`, () => handler(...args));
}
