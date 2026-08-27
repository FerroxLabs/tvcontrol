import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityCheck } from './health.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { isReadonlyMode, isToolRegistered } from './readonly.js';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const CACHE_MS = 10_000;
let cachedProbe = null;

const FAMILY_REQUIREMENTS = Object.freeze({
  chart_get_state: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies'],
  chart_set_symbol: ['active_chart', 'chart_symbol'],
  chart_set_timeframe: ['active_chart', 'chart_resolution'],
  chart_set_type: ['active_chart'],
  chart_manage_indicator: ['active_chart', 'chart_studies'],
  chart_get_visible_range: ['active_chart', 'chart_widget_model'],
  chart_set_visible_range: ['active_chart', 'chart_widget_model'],
  chart_scroll_to_date: ['active_chart', 'chart_widget_model'],
  symbol_info: ['active_chart', 'chart_symbol'],
  data_get_ohlcv: ['main_series_bars'],
  quote_get: ['main_series_bars'],
  data_get_indicator: ['chart_studies'],
  data_get_strategy_results: ['chart_studies', 'model_data_sources'],
  data_get_trades: ['chart_studies', 'model_data_sources'],
  data_get_equity: ['chart_studies', 'model_data_sources'],
  data_get_study_values: ['chart_studies'],
  data_get_pine_lines: ['model_data_sources'],
  data_get_pine_labels: ['model_data_sources'],
  data_get_pine_tables: ['model_data_sources'],
  data_get_pine_boxes: ['model_data_sources'],
  depth_get: ['main_series'],
  draw_shape: ['model_data_sources'],
  draw_list: ['model_data_sources'],
  draw_clear: ['model_data_sources'],
  draw_remove_one: ['model_data_sources'],
  draw_get_properties: ['model_data_sources'],
  indicator_set_inputs: ['chart_studies'],
  indicator_toggle_visibility: ['chart_studies'],
  batch_run: ['active_chart', 'chart_symbol', 'chart_resolution'],
  strategy_sweep: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies', 'model_data_sources'],
  state_snapshot: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies'],
  state_restore: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies'],
  chart_vision_read: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies', 'main_series_bars'],
  pane_list: ['chart_widget_model'],
  pane_set_layout: ['chart_widget_model'],
  pane_focus: ['chart_widget_model'],
  pane_set_symbol: ['chart_widget_model'],
  replay_start: ['active_chart'],
  replay_step: ['active_chart'],
  replay_autoplay: ['active_chart'],
  replay_stop: ['active_chart'],
  replay_trade: ['active_chart'],
  replay_status: ['active_chart'],
  alert_create: ['main_series'],
});

export function discoverToolCatalog({ _deps } = {}) {
  const deps = {
    readdirSync: _deps?.readdirSync || readdirSync,
    readFileSync: _deps?.readFileSync || readFileSync,
    toolsDir: _deps?.toolsDir || TOOLS_DIR,
  };
  const names = new Set();
  for (const file of deps.readdirSync(deps.toolsDir).filter((value) => value.endsWith('.js')).sort()) {
    const source = deps.readFileSync(join(deps.toolsDir, file), 'utf8');
    for (const match of source.matchAll(/server\.tool\s*\(\s*['"]([^'"]+)['"]/g)) names.add(match[1]);
  }
  return [...names].sort();
}

export function requiredCapabilitiesForTool(name) {
  if (FAMILY_REQUIREMENTS[name]) return [...FAMILY_REQUIREMENTS[name]];
  if (name.startsWith('chart_')) return ['active_chart'];
  return [];
}

async function _probe(deps, force = false) {
  const now = deps.now();
  if (!force && cachedProbe && now - cachedProbe.at < CACHE_MS) return cachedProbe.value;
  const value = await deps.compatibilityCheck();
  cachedProbe = { at: now, value };
  return value;
}

export async function getCapabilityMatrix({ probe = true, force = false, _deps } = {}) {
  const deps = {
    compatibilityCheck: _deps?.compatibilityCheck || compatibilityCheck,
    catalog: _deps?.catalog || (() => discoverToolCatalog({ _deps })),
    now: _deps?.now || Date.now,
  };
  let live = null;
  let probeError = null;
  if (probe) {
    try { live = await _probe(deps, force); }
    catch (err) { probeError = err?.category || CATEGORIES.CDP_DISCONNECTED; }
  }
  const checks = live?.checks || null;
  const tools = deps.catalog().map((name) => {
    const requires = requiredCapabilitiesForTool(name);
    const missing = checks ? requires.filter((capability) => checks[capability] !== true) : [];
    // Same predicate the server registers by, so the matrix cannot claim a tool is
    // available in a session where the server never registered it.
    const registered = isToolRegistered(name);
    return {
      tool: name,
      requires,
      status: !registered ? 'disabled' : (checks ? (missing.length === 0 ? 'available' : 'blocked') : 'unknown'),
      ...(missing.length > 0 ? { missing } : {}),
      registered,
      registered_by_default: name !== 'ui_evaluate',
    };
  });
  return {
    success: true,
    readonly_mode: isReadonlyMode(),
    probe_status: checks ? 'available' : (probe ? 'unavailable' : 'not_requested'),
    ...(probeError ? { probe_error_category: probeError } : {}),
    desktop_version: live?.desktop_version || null,
    tool_count: tools.length,
    registered: tools.filter((tool) => tool.registered).length,
    available: tools.filter((tool) => tool.status === 'available').length,
    blocked: tools.filter((tool) => tool.status === 'blocked').length,
    unknown: tools.filter((tool) => tool.status === 'unknown').length,
    disabled: tools.filter((tool) => tool.status === 'disabled').length,
    tools,
  };
}

export function gateToolHandler(name, handler, { _deps } = {}) {
  const requires = requiredCapabilitiesForTool(name);
  if (requires.length === 0) return handler;
  const deps = {
    compatibilityCheck: _deps?.compatibilityCheck || compatibilityCheck,
    now: _deps?.now || Date.now,
  };
  return async (...args) => {
    let live;
    try { live = await _probe(deps); }
    catch (_) { return handler(...args); }
    const checks = live?.checks;
    if (!checks) return handler(...args);
    const missing = requires.filter((capability) => checks[capability] !== true);
    if (missing.length > 0) {
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        `${name} is unavailable because TradingView is missing required capabilities: ${missing.join(', ')}`,
        { hint: 'Run tv capabilities and tv compatibility. Update TVControl or TradingView, then retry after the compatibility canary is green.' },
      );
    }
    return handler(...args);
  };
}

export function _resetCapabilityCacheForTests() {
  cachedProbe = null;
}
