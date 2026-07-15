import { homedir } from 'node:os';
import { join } from 'node:path';
import { disconnect, getClient, getTargetInfo, reconnectToTarget, _withConnectionTimeout } from '../connection.js';
import { healthCheck } from './health.js';
import * as tab from './tab.js';
import { atomicWrite, resolveReceiptPath, timestampSlug } from './receipts.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const DEFAULT_DIR = join(homedir(), '.tv-mcp', 'chaos');
const AVAILABLE = Object.freeze(['cdp_disconnect', 'renderer_stall', 'tab_cycle']);

function _normalizeScenarios(scenarios) {
  const values = scenarios === undefined
    ? [...AVAILABLE]
    : (Array.isArray(scenarios) ? scenarios : String(scenarios).split(',')).map((value) => String(value).trim()).filter(Boolean);
  const unknown = values.filter((value) => !AVAILABLE.includes(value));
  if (unknown.length > 0 || values.length === 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unknown or empty chaos scenarios: ${unknown.join(', ') || '(none)'}. Available: ${AVAILABLE.join(', ')}`);
  }
  return [...new Set(values)];
}

async function _assertHealthy(deps) {
  const health = await deps.healthCheck();
  if (health?.healthy !== true) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Recovery health assertion failed', {
      hint: 'Run tv status and tv compatibility before attempting another fault injection.',
    });
  }
  return true;
}

async function _cdpDisconnect(deps) {
  await deps.disconnect();
  await deps.getClient();
  await _assertHealthy(deps);
  return { recovery: 'reconnected', cleanup_verified: true };
}

async function _rendererStall(deps, timeoutMs) {
  const client = await deps.getClient();
  let timedOut = false;
  try {
    await deps.withConnectionTimeout(
      client.Runtime.evaluate({ expression: `new Promise(function(resolve){ setTimeout(resolve, ${timeoutMs * 5}); })`, awaitPromise: true, returnByValue: true }),
      timeoutMs,
      'intentional chaos renderer promise',
    );
  } catch (_) { timedOut = true; }
  if (!timedOut) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Renderer-stall scenario did not trigger the timeout boundary');
  const response = await deps.withConnectionTimeout(
    client.Runtime.evaluate({ expression: '1 + 1', returnByValue: true }),
    timeoutMs,
    'renderer recovery probe',
  );
  if (response?.result?.value !== 2) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Renderer did not respond after the bounded stall');
  await _assertHealthy(deps);
  return { timeout_observed: true, renderer_responsive: true, cleanup_verified: true };
}

async function _tabCycle(deps) {
  const originalTarget = await deps.getTargetInfo();
  const before = await deps.tabList();
  const originalCount = Number(before?.tab_count ?? before?.count);
  if (!Number.isInteger(originalCount) || originalCount < 1) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Could not establish the original TradingView tab count');
  let opened = false;
  let cleanupVerified = false;
  try {
    const created = await deps.tabNew({});
    opened = Number(created?.tab_count ?? created?.count) === originalCount + 1;
    if (!opened) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Sacrificial TradingView tab was not created');
    const closed = await deps.tabClose();
    cleanupVerified = Number(closed?.tabs_after) === originalCount;
    if (!cleanupVerified) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Sacrificial TradingView tab was not closed');
  } finally {
    if (opened && !cleanupVerified) {
      try { await deps.tabClose(); } catch (_) {}
    }
    try {
      if (originalTarget?.id) await deps.reconnectToTarget(originalTarget.id);
      else await deps.tabSwitch({ index: Math.max(0, originalCount - 1) });
    } catch (_) {}
  }
  const after = await deps.tabList();
  cleanupVerified = Number(after?.tab_count ?? after?.count) === originalCount;
  if (!cleanupVerified) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Tab count was not restored after chaos test');
  await _assertHealthy(deps);
  return { tabs_before: originalCount, tabs_after: originalCount, cleanup_verified: true };
}

export async function runChaos({ scenarios, allow_live_faults = false, timeout_ms = 1000, output_dir, _deps } = {}) {
  const selected = _normalizeScenarios(scenarios);
  const timeoutMs = Number(timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'chaos timeout_ms must be an integer from 250 to 10000');
  }
  if (!allow_live_faults) {
    return {
      success: true,
      dry_run: true,
      planned_scenarios: selected,
      safety: 'No fault was injected. Re-run with --allow-live-faults to execute against TradingView Desktop.',
    };
  }
  const deps = {
    disconnect: _deps?.disconnect || disconnect,
    getClient: _deps?.getClient || getClient,
    getTargetInfo: _deps?.getTargetInfo || getTargetInfo,
    reconnectToTarget: _deps?.reconnectToTarget || reconnectToTarget,
    withConnectionTimeout: _deps?.withConnectionTimeout || _withConnectionTimeout,
    healthCheck: _deps?.healthCheck || healthCheck,
    tabList: _deps?.tabList || tab.list,
    tabNew: _deps?.tabNew || tab.newTab,
    tabClose: _deps?.tabClose || tab.closeTab,
    tabSwitch: _deps?.tabSwitch || tab.switchTab,
    atomicWrite: _deps?.atomicWrite || atomicWrite,
    now: _deps?.now || (() => new Date()),
    home: _deps?.home || homedir(),
  };
  const results = [];
  for (const scenario of selected) {
    const started = Date.now();
    try {
      const detail = scenario === 'cdp_disconnect'
        ? await _cdpDisconnect(deps)
        : scenario === 'renderer_stall'
          ? await _rendererStall(deps, timeoutMs)
          : await _tabCycle(deps);
      results.push({ scenario, passed: true, duration_ms: Date.now() - started, ...detail });
    } catch (err) {
      results.push({ scenario, passed: false, duration_ms: Date.now() - started, error_category: err?.category || CATEGORIES.API_UNEXPECTED });
    }
  }
  const now = deps.now();
  const receipt = {
    schema_version: 1,
    generated_at: now.toISOString(),
    success: results.every((result) => result.passed),
    scenarios: results,
  };
  const path = resolveReceiptPath({ kind: 'chaos', filename: `chaos-${timestampSlug(now)}.json`, outputDir: output_dir || DEFAULT_DIR, home: deps.home });
  deps.atomicWrite(path, JSON.stringify(receipt, null, 2));
  return { ...receipt, receipt_path: path };
}

export const CHAOS_SCENARIOS = AVAILABLE;
