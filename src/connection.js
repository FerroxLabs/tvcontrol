import CDP from 'chrome-remote-interface';
import { ClassifiedError, CATEGORIES } from './errors.js';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
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
  // Atomic write via tmp + rename. Without this, two concurrent CLI
  // invocations updating the active target can race and produce a torn JSON
  // file — the next process to read it falls back silently to "pick first
  // target" with no signal. Unique tmp suffix prevents the race itself.
  try {
    mkdirSync(join(homedir(), '.tv-mcp'), { recursive: true });
    const rand = Math.random().toString(36).slice(2, 8);
    const tmp = `${ACTIVE_TARGET_FILE}.${process.pid}.${rand}.tmp`;
    writeFileSync(tmp, JSON.stringify({ target_id: id, updated_at: new Date().toISOString() }));
    renameSync(tmp, ACTIVE_TARGET_FILE);
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
 *
 * Contract (asserted by tests/sanitization.test.js):
 *   null         -> 0    (deliberate: "null means zero" sentinel)
 *   number/'42'  -> the number (numeric strings are coerced)
 *   undefined    -> throw (missing argument)
 *   NaN/Inf      -> throw
 *   non-numeric / empty / whitespace string -> throw
 *   [], {}, boolean -> throw (Number() would silently coerce these to 0)
 * The null sentinel is intentional; callers reject null at their own boundary
 * if they don't want zero. The non-number rejections below close a
 * silent-corruption gap without breaking the null/numeric-string contract.
 */
export function requireFinite(value, name) {
  if (value === undefined) throw new Error(`${name} must be a finite number, got: ${value}`);
  if (value !== null) {
    if (typeof value === 'boolean' || typeof value === 'object')
      throw new Error(`${name} must be a finite number, got: ${value}`);
    if (typeof value === 'string' && value.trim() === '')
      throw new Error(`${name} must be a finite number, got empty/whitespace string`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

/**
 * Heuristic: is this error shaped like a CDP/WebSocket disconnect (vs an
 * in-page eval throw)? A disconnect means the cached `client` is dead and
 * needs replacement. A page-side throw means the client is still healthy.
 * Misclassifying the second as the first was a known bug — a transient JS
 * eval error would silently re-pick a target and switch the user's tab.
 */
export function _looksLikeDisconnect(err) {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.code || '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return true;
  // In-page JS throws are surfaced by evaluate() as "JS evaluation error: ...".
  // Their text routinely contains disconnect-shaped words ("Order closed",
  // "connection aborted") that must NOT be misread as a dead transport — the
  // WebSocket is healthy, only the page script threw. Misclassifying these was
  // the regression: it dropped the client and re-picked a target, silently
  // switching the user's tab. Isolate page throws before the heuristic.
  if (msg.startsWith('js evaluation error:')) return false;
  return /closed|disconnect|websocket|socket hang up|ws closed|inspector|connection|aborted|not connected/i.test(msg);
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch (err) {
      if (!_looksLikeDisconnect(err)) {
        // Transient in-page error — connection is healthy, just rethrow.
        // Without this guard, any eval throw would discard the client and
        // trigger findChartTarget(), potentially attaching to a different
        // tab than the user expected.
        throw err;
      }
      try { await client.close(); } catch {}
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

// Coalesce concurrent connection attempts behind a single in-flight promise.
// Two MCP tool calls that both observe a dead client would otherwise each
// open a CDP session; the module-level `client` keeps only the last,
// orphaning the other socket (permanent WebSocket leak) and possibly binding
// to a different tab than the first caller saw. One in-flight promise
// guarantees a single connect regardless of how many callers race in.
let _connectInFlight = null;

export async function connect() {
  if (_connectInFlight) return _connectInFlight;
  _connectInFlight = _connect();
  try {
    return await _connectInFlight;
  } finally {
    _connectInFlight = null;
  }
}

async function _connect() {
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
      // Build the session in a LOCAL and publish to the module-level singleton
      // only AFTER every enable() succeeds. Assigning `client` before the
      // enables (the old behavior) leaked a half-open socket whenever an
      // enable() threw: the retry opened another CDP() and overwrote the
      // reference without ever closing the partial one.
      const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      try {
        await c.Runtime.enable();
        await c.Page.enable();
        await c.DOM.enable();
      } catch (enableErr) {
        try { await c.close(); } catch {}
        throw enableErr;
      }
      client = c;
      targetInfo = target;
      return client;
    } catch (err) {
      lastError = err;
      // Non-transient: TV is reachable but has no chart target. Retrying
      // cannot help — burn-then-misclassify was a known bug.
      if (err instanceof ClassifiedError && err.category === CATEGORIES.TV_NOT_RUNNING) {
        throw err;
      }
      // Exponential backoff with jitter. Pure exponential makes multiple
      // tools that all reconnect after a TV restart retry in lockstep
      // (thundering herd); the random half spreads them out.
      const cap = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      const delay = cap / 2 + Math.random() * (cap / 2);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // If the final error was already a ClassifiedError, preserve its category.
  if (lastError instanceof ClassifiedError) throw lastError;
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

/**
 * Hostname-anchored TV check. Substring regex against the full URL is unsafe:
 * `evil.com/tradingview.com/chart/foo` would match, attaching to a hostile
 * page. Use the parsed hostname so attackers can't smuggle the keyword via
 * path components.
 */
export function _isTradingViewUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'tradingview.com' || h.endsWith('.tradingview.com');
  } catch { return false; }
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // If the user previously selected a tab (via tab_switch), honor it —
  // /json/list order is stable and doesn't reflect /json/activate, so
  // without this pref the CLI would always re-pick tab 0. Re-check the
  // URL: a persisted preference is stale if the tab was navigated away
  // from TradingView between processes.
  const lastSelected = _readActiveTargetId();
  if (lastSelected) {
    const pref = targets.find((t) => t.id === lastSelected && t.type === 'page' && _isTradingViewUrl(t.url));
    if (pref) return pref;
  }
  return targets.find((t) => t.type === 'page' && _isTradingViewUrl(t.url) && /\/chart/i.test(t.url))
    || targets.find((t) => t.type === 'page' && _isTradingViewUrl(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

// Default timeout for a single Runtime.evaluate. A hung TradingView page
// (renderer GC pause, infinite Promise, navigation in flight) would
// otherwise wedge the MCP tool call indefinitely and pin the singleton
// client. Callers needing a longer budget pass opts.timeoutMs explicitly;
// pass 0 (or any falsy non-undefined) to disable.
const DEFAULT_EVAL_TIMEOUT_MS = 20000;

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const { timeoutMs: _t, ...cdpOpts } = opts;
  const timeoutMs = _t === undefined ? DEFAULT_EVAL_TIMEOUT_MS : _t;
  const evalPromise = c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: cdpOpts.awaitPromise ?? false,
    ...cdpOpts,
  });
  // If the timeout below wins the Promise.race, evalPromise stays pending and
  // may reject later (page closed / context destroyed mid-eval). With no
  // handler attached, Node treats that late rejection as UNHANDLED and crashes
  // the whole MCP process. This no-op catch guarantees the abandoned promise
  // can never crash us; we still await evalPromise itself for the real result.
  evalPromise.catch(() => {});
  let result;
  if (timeoutMs && timeoutMs > 0) {
    let timer;
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`evaluate timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      result = await Promise.race([evalPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    result = await evalPromise;
  }
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression, opts = {}) {
  return evaluate(expression, { awaitPromise: true, ...opts });
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
  // Same atomic-publish discipline as _connect(): enable on a LOCAL, close on
  // failure, and publish the singleton (+ persist the active id) only once the
  // session is fully live. Avoids leaking a half-open socket and avoids
  // persisting a tab id we never actually attached to.
  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  try {
    await c.Runtime.enable();
    await c.Page.enable();
    await c.DOM.enable();
  } catch (enableErr) {
    try { await c.close(); } catch {}
    throw enableErr;
  }
  client = c;
  targetInfo = target;
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
    // Classify so a TradingView internal-API change surfaces as TV_UI_CHANGED
    // with a remediation hint instead of a cryptic minified stack trace.
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `${name} not available at ${path}`,
      { hint: 'TradingView may have changed its internal API paths. Run tv_discover to re-probe, or file an issue with your TradingView version.' },
    );
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
