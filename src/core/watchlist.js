/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient, safeString } from '../connection.js';
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { parseJsonSafe } from './_json.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
    wait: deps?.wait || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

const WATCHLIST_BUTTON_JS = `(document.querySelector('[data-name="base-watchlist-widget-button"]')
  || document.querySelector('[data-name="base"]')
  || document.querySelector('[aria-label="Watchlist, details, and news"]')
  || document.querySelector('[aria-label^="Watchlist"]'))`;

async function _ensureWatchlistOpen(evaluate, wait, maxWaitMs = 5000) {
  const state = await evaluate(`
    (function() {
      var btn = ${WATCHLIST_BUTTON_JS};
      if (!btn) return { error: 'Watchlist button not found' };
      var right = document.querySelector('[class*="layout__area--right"]');
      var open = !!(right && right.offsetWidth > 50);
      var ready = open && !!(document.querySelector('[data-name="add-symbol-button"]')
        || right.querySelector('[data-symbol-full]'));
      if (ready) return { opened: false, ready: true };
      if (!open) btn.click();
      return { opened: !open, ready: false };
    })()
  `);
  if (state?.error) {
    throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, state.error, {
      hint: 'TradingView changed the Watchlist control. Open it manually and run tv discover before retrying.',
    });
  }
  if (state?.ready) return state;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(`
      (function() {
        var right = document.querySelector('[class*="layout__area--right"]');
        return !!(right && right.offsetWidth > 50
          && (document.querySelector('[data-name="add-symbol-button"]') || right.querySelector('[data-symbol-full]')));
      })()
    `);
    if (ready) return { opened: !!state?.opened, ready: true };
    await wait(250);
  }
  throw new ClassifiedError(CATEGORIES.CHART_LOADING, 'Watchlist panel did not become ready within 5 seconds', {
    hint: 'Confirm a watchlist is selected in the right sidebar, then retry.',
  });
}

// ---------------------------------------------------------------------------
// THE WATCHLIST API. Everything below used to be DOM automation: click the add
// button, right-click a row and hunt for "Remove" in a context menu. That is
// why watchlist_remove was broken in 2.2.3 — it reported a click and the symbol
// stayed put. Worse, the DOM read disagreed with reality: watchlist_get said
// TSLA/NVDA/AMD were absent while the account actually held all three, because
// the DOM only contains rendered rows.
//
// TradingView has a real authenticated REST API for this. Discovered and
// verified against a live account on 2026-08-20:
//
//   GET  /api/v1/symbols_list/active/              the active list {id,name,symbols[]}
//   GET  /api/v1/symbols_list/custom/              every custom list
//   POST /api/v1/symbols_list/custom/<id>/append/  body ["NASDAQ:TSLA"] -> full list
//   POST /api/v1/symbols_list/custom/<id>/remove/  body ["NASDAQ:TSLA"] -> full list
//
// The body must be a JSON ARRAY. A query string or an object returns 422 with
// {"non_field_errors":["Expected a list of items but got type \"dict\"."]}.
// Both mutations return the updated list, but we still re-read: a response
// describing the action is the action reporting on itself.
const WL_API = 'https://www.tradingview.com/api/v1/symbols_list/';

// Section headers are real entries in the stored list. They start with ### and
// are not tradable symbols, so membership counts must exclude them.
function _isHeader(s) { return String(s).startsWith('###'); }

async function _apiActive(evaluateAsync) {
  const r = await evaluateAsync(`
    (async function(){
      try {
        var res = await fetch(${JSON.stringify(WL_API)} + 'active/', { credentials: 'include' });
        if (!res.ok) return { ok: false, status: res.status };
        var j = await res.json();
        return { ok: true, id: j.id, name: j.name, symbols: j.symbols || [] };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!r || !r.ok) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Could not read the active watchlist (${r && r.status ? 'status ' + r.status : (r && r.error) || 'unknown'})`,
      { hint: 'Confirm you are logged in to TradingView in the attached session.' },
    );
  }
  return r;
}

async function _apiMutate(evaluateAsync, listId, verb, symbols) {
  const r = await evaluateAsync(`
    (async function(){
      try {
        var res = await fetch(${JSON.stringify(WL_API)} + 'custom/' + ${JSON.stringify(String(listId))} + '/' + ${JSON.stringify(verb)} + '/', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(${JSON.stringify(symbols)})
        });
        var text = await res.text();
        return { ok: res.ok, status: res.status, raw: text.slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!r || !r.ok) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Watchlist ${verb} failed (status ${(r && r.status) || '?'}): ${(r && (r.raw || r.error)) || 'unknown'}`,
    );
  }
  return r;
}

export async function get({ _deps } = {}) {
  const { evaluate, evaluateAsync, wait } = _resolve(_deps);

  // MEMBERSHIP COMES FROM THE API, NOT THE DOM. The DOM only holds rendered
  // rows, so a long or scrolled list reports symbols as absent that the account
  // actually holds. Measured 2026-08-20: it claimed TSLA/NVDA/AMD were gone
  // while all three were in the stored list.
  const api = await _apiActive(evaluateAsync);
  const symbols = api.symbols.filter((x) => !_isHeader(x));
  const sections = api.symbols.filter((x) => _isHeader(x));

  // Prices only exist in the rendered widget. Best effort: enrich if the panel
  // is open, otherwise return membership without quotes rather than failing.
  let quotes = {};
  try {
    await _ensureWatchlistOpen(evaluate, wait);
    const rows = await evaluate(`
      (function() {
        function norm(t) { return String(t || '').replace(/−/g, '-').trim(); }
        var out = {};
        var nodes = document.querySelectorAll('[data-symbol-full]');
        for (var i = 0; i < nodes.length; i++) {
          var full = nodes[i].getAttribute('data-symbol-full');
          if (!full || out[full]) continue;
          var cells = nodes[i].querySelectorAll('[class*="cell"]');
          var vals = [];
          for (var c = 0; c < cells.length; c++) vals.push(norm(cells[c].textContent));
          out[full] = vals;
        }
        return out;
      })()
    `);
    if (rows && typeof rows === 'object') quotes = rows;
  } catch { /* panel closed or layout changed; membership still stands */ }

  return {
    success: true,
    watchlist: api.name,
    watchlist_id: api.id,
    count: symbols.length,
    symbols: symbols.map((sym) => (quotes[sym] && quotes[sym].length ? { symbol: sym, cells: quotes[sym] } : { symbol: sym })),
    sections,
    quotes_available: Object.keys(quotes).length > 0,
    source: 'symbols_list_api',
  };
}

// Fuzzy-match a user-supplied symbol against the watchlist's actual
// data-symbol-full values. Users commonly pass bare tickers ("AAPL") while
// TradingView stores the exchange-prefixed form ("NASDAQ:AAPL"). Exact hit
// wins; otherwise suffix/prefix match by ticker. Returns the stored form
// or null if not present.
async function _resolveStoredSymbol(evaluate, symbol) {
  const result = await evaluate(`
    (function() {
      var want = ${JSON.stringify(String(symbol).toUpperCase())};
      var rows = document.querySelectorAll('[data-symbol-full]');
      var stored = [];
      for (var i = 0; i < rows.length; i++) {
        var sf = rows[i].getAttribute('data-symbol-full') || '';
        if (!sf) continue;
        stored.push(sf);
        var up = sf.toUpperCase();
        if (up === want) return { match: 'exact', symbolFull: sf };
      }
      for (var j = 0; j < stored.length; j++) {
        var up2 = stored[j].toUpperCase();
        if (up2.endsWith(':' + want) || up2.startsWith(want + ':')) {
          return { match: 'fuzzy', symbolFull: stored[j] };
        }
      }
      return { match: null };
    })()
  `);
  return result?.symbolFull || null;
}

async function _currentSymbolsSet(evaluate) {
  const r = await evaluate(`
    (function() {
      var rows = document.querySelectorAll('[data-symbol-full]');
      var out = [];
      var seen = {};
      for (var i = 0; i < rows.length; i++) {
        var sf = rows[i].getAttribute('data-symbol-full') || '';
        if (sf && !seen[sf]) { seen[sf] = true; out.push(sf); }
      }
      return out;
    })()
  `);
  return new Set(Array.isArray(r) ? r : []);
}

export async function add({ symbol, _deps }) {
  if (!symbol || typeof symbol !== 'string') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbol must be a non-empty string');
  }
  const res = await addBulk({ symbols: [symbol], _deps });
  const one = res.results && res.results[0];
  return {
    success: res.success,
    symbol: (one && one.symbol) || symbol,
    already_present: (one && one.already_present) || false,
    watchlist: res.watchlist,
    count: res.count,
    verified: res.verified,
  };
}

export async function addBulk({ symbols, _deps }) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbols must be a non-empty array');
  }
  const { evaluateAsync } = _resolve(_deps);
  const before = await _apiActive(evaluateAsync);
  const had = new Set(before.symbols.map(String));
  const wanted = symbols.map((x) => String(x).trim()).filter(Boolean);
  const missing = wanted.filter((x) => !had.has(x));

  if (missing.length) await _apiMutate(evaluateAsync, before.id, 'append', missing);

  // VERIFY from a fresh read, not from the mutation's own response.
  const after = await _apiActive(evaluateAsync);
  const now = new Set(after.symbols.map(String));
  const results = wanted.map((x) => ({ symbol: x, added: now.has(x), already_present: had.has(x) }));
  const allThere = results.every((r) => r.added);
  return {
    success: allThere,
    watchlist: after.name,
    watchlist_id: after.id,
    count: after.symbols.filter((x) => !_isHeader(x)).length,
    added_count: results.filter((r) => r.added && !r.already_present).length,
    results,
    verified: allThere,
    source: 'symbols_list_api',
  };
}

export async function remove({ symbol, _deps }) {
  if (!symbol || typeof symbol !== 'string') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbol must be a non-empty string');
  }
  const res = await removeBulk({ symbols: [symbol], _deps });
  const one = res.results && res.results[0];
  if (one && one.removed === false && one.was_present === false) {
    throw new ClassifiedError(
      CATEGORIES.SYMBOL_UNKNOWN,
      `Symbol not found in watchlist: ${symbol}`,
      { hint: 'Call watchlist_get for exact stored names; they are exchange-prefixed (e.g. NASDAQ:TSLA).' },
    );
  }
  return {
    success: res.success,
    symbol: (one && one.symbol) || symbol,
    watchlist: res.watchlist,
    count: res.count,
    verified: res.verified,
  };
}

export async function removeBulk({ symbols, _deps }) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbols must be a non-empty array');
  }
  const { evaluateAsync } = _resolve(_deps);
  const before = await _apiActive(evaluateAsync);
  const had = new Set(before.symbols.map(String));
  const wanted = symbols.map((x) => String(x).trim()).filter(Boolean);
  const present = wanted.filter((x) => had.has(x));

  if (present.length) await _apiMutate(evaluateAsync, before.id, 'remove', present);

  const after = await _apiActive(evaluateAsync);
  const now = new Set(after.symbols.map(String));
  const results = wanted.map((x) => ({ symbol: x, was_present: had.has(x), removed: had.has(x) && !now.has(x) }));
  const ok = results.every((r) => !r.was_present || r.removed);
  return {
    success: ok,
    watchlist: after.name,
    watchlist_id: after.id,
    count: after.symbols.filter((x) => !_isHeader(x)).length,
    removed_count: results.filter((r) => r.removed).length,
    not_found: results.filter((r) => !r.was_present).map((r) => r.symbol),
    results,
    verified: ok,
    source: 'symbols_list_api',
  };
}

function _isUnder(child, parent) {
  if (!parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Allowlist check for export/import paths. Three fixes vs the original:
 *   1. `path.resolve` first so relative paths (`../../foo`) are anchored to
 *      cwd before the check — was the bypass surface in the original.
 *   2. Use `sep`-boundary prefix match so `/Users/sean.evil/foo` does NOT
 *      match home `/Users/sean` (substring-prefix flaw).
 *   3. Reject null bytes (Node's fs throws on them anyway, but rejecting
 *      early gives a clean ClassifiedError).
 * The original `..` substring check is no longer needed — `path.resolve`
 * normalises any traversal away, and any path that resolves outside the
 * allowlist is rejected on its merits.
 */
function _isPathAllowed(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) return false;
  const resolved = resolve(filePath);
  const home = homedir();
  const tmp = tmpdir();
  return _isUnder(resolved, home)
    || _isUnder(resolved, '/tmp')
    || _isUnder(resolved, '/var/folders')
    || _isUnder(resolved, tmp);
}

export async function exportTo({ file_path, _deps } = {}) {
  let filePath = file_path;
  if (!filePath) {
    const now = new Date();
    const ts = now.toISOString().replace(/T/, '-').replace(/:/g, '').replace(/\..+/, '');
    filePath = join(homedir(), '.tv-mcp', 'watchlists', `watchlist-${ts}.json`);
  }

  if (!_isPathAllowed(filePath)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Path rejected: ${filePath}. Paths must not contain ".." and absolute paths must be under home directory or /tmp.`,
    );
  }

  mkdirSync(dirname(filePath), { recursive: true });

  const result = await get({ _deps });
  const exported_at = new Date().toISOString();
  const payload = { schema_version: 1, exported_at, symbols: result.symbols };

  // Unique tmp suffix prevents concurrent exports from overwriting each
  // other's sidecar file — was a known race on the hardcoded `.tmp` name.
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.${process.pid}.${rand}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, filePath);

  return { success: true, file_path: filePath, count: result.symbols.length, exported_at };
}

export async function importFrom({ file_path, mode = 'merge', dry_run = false, _deps } = {}) {
  // Mirror the allowlist exportTo enforces — without this gate, importFrom
  // could read arbitrary JSON from anywhere on the filesystem (e.g.
  // ~/.ssh/-shaped files, /etc/*) and reflect contents back to the caller.
  if (!_isPathAllowed(file_path)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Path rejected: ${file_path}. Paths must resolve under home directory or system tmp.`,
    );
  }
  if (!existsSync(file_path)) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `File not found: ${file_path}`);
  }

  let parsed;
  try {
    parsed = parseJsonSafe(readFileSync(file_path, 'utf8'));
  } catch {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `Failed to parse JSON from: ${file_path}`);
  }

  if (parsed?.schema_version !== 1 || !Array.isArray(parsed?.symbols)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Invalid file shape. Expected { schema_version: 1, symbols: [...] }.',
    );
  }

  const incoming = parsed.symbols.map(s => s.symbol).filter(Boolean);
  const current = await get({ _deps });
  const currentSet = new Set(current.symbols.map(s => s.symbol));

  if (dry_run) {
    const would_add = incoming.filter(s => !currentSet.has(s));
    const would_skip = incoming.filter(s => currentSet.has(s));
    return { success: true, dry_run: true, would_add, would_skip };
  }

  const added = [];
  const skipped = [];
  const errors = [];

  if (mode === 'replace') {
    // Remove symbols not in incoming
    const incomingSet = new Set(incoming);
    for (const s of current.symbols) {
      if (!incomingSet.has(s.symbol)) {
        try {
          await remove({ symbol: s.symbol, _deps });
        } catch (err) {
          errors.push({ symbol: s.symbol, error: err.message });
        }
      }
    }
    // Refresh current set after removals
    currentSet.clear();
    const refreshed = await get({ _deps });
    for (const s of refreshed.symbols) currentSet.add(s.symbol);
  }

  for (const sym of incoming) {
    if (currentSet.has(sym)) {
      skipped.push(sym);
      continue;
    }
    try {
      await add({ symbol: sym, _deps });
      added.push(sym);
      currentSet.add(sym);
    } catch (err) {
      errors.push({ symbol: sym, error: err.message });
    }
  }

  // Honest success: any per-symbol failure means the import was not clean.
  // Surface error_count at the top level so callers branching on result can
  // see "succeeded with N partial failures" without iterating errors[].
  return {
    success: errors.length === 0,
    mode,
    added,
    skipped,
    added_count: added.length,
    skipped_count: skipped.length,
    error_count: errors.length,
    errors,
  };
}
