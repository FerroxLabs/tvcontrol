import CDP from 'chrome-remote-interface';
import { ClassifiedError, CATEGORIES } from './errors.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Persist the last-selected target_id across CLI invocations. The CLI spawns
// a fresh Node process per command, so the in-memory `client` can't survive
// a `tv tab switch` followed by `tv status`. Without persistence, every CLI
// call would re-pick the first target in /json/list — which is stable and
// unaffected by /json/activate. Writing the selected id here lets findChartTarget
// honor the user's last switch across separate processes.
const ACTIVE_TARGET_FILE = join(homedir(), '.tv-mcp', 'active-target.json');
function _readActiveTargetId() {
  try {
    const raw = readFileSync(ACTIVE_TARGET_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.target_id === 'string' ? parsed.target_id : null;
  } catch { return null; }
}
function _writeActiveTargetId(id) {
  try {
    mkdirSync(join(homedir(), '.tv-mcp'), { recursive: true });
    writeFileSync(ACTIVE_TARGET_FILE, JSON.stringify({ target_id: id, updated_at: new Date().toISOString() }));
  } catch { /* best-effort; MCP/CLI still works without persistence */ }
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new ClassifiedError(
          CATEGORIES.TV_NOT_RUNNING,
          'No TradingView chart target found. Is TradingView open with a chart?',
        );
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // Classify based on the last error we saw.
  const msg = lastError?.message || '';
  const code = lastError?.code || '';
  const isConnRefused = code === 'ECONNREFUSED' || /ECONNREFUSED|connect ECONNREFUSED|fetch failed/i.test(msg);
  throw new ClassifiedError(
    isConnRefused ? CATEGORIES.TV_NOT_RUNNING : CATEGORIES.CDP_DISCONNECTED,
    `CDP connection failed after ${MAX_RETRIES} attempts: ${msg}`,
    { cause: lastError },
  );
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // If the user previously selected a tab (via tab_switch), honor it —
  // /json/list order is stable and doesn't reflect /json/activate, so
  // without this pref the CLI would always re-pick tab 0.
  const lastSelected = _readActiveTargetId();
  if (lastSelected) {
    const pref = targets.find((t) => t.id === lastSelected && t.type === 'page');
    if (pref) return pref;
  }
  return targets.find((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find((t) => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

/**
 * Switch the live CDP session to a different Chrome target.
 *
 * tab_switch historically only called Chrome's /json/activate/<id> endpoint,
 * which brings the tab to front but leaves this module's CDP WebSocket still
 * attached to the OLD target. Every subsequent evaluate()/getClient() call
 * then routed to the previous tab, producing the confusing "status says BTC
 * but I switched to AAPL" bug. Call this after /json/activate to close the
 * old session cleanly and attach to the new target's DevTools endpoint.
 */
export async function reconnectToTarget(targetId) {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
  // Find the target by id (we don't use findChartTarget here because the
  // user may have switched to a non-chart tab — caller chose the id).
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const target = targets.find((t) => t.id === targetId);
  if (!target) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Target id ${targetId} not found in /json/list. It may have been closed.`,
    );
  }
  targetInfo = target;
  client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  await client.Page.enable();
  await client.DOM.enable();
  // Persist for CLI invocations that spawn fresh processes.
  _writeActiveTargetId(target.id);
  return { id: target.id, url: target.url, title: target.title };
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
