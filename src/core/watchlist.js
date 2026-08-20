/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient } from '../connection.js';
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { symbolSearch } from './chart.js';
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
        // Hand back what the server actually said. Do NOT default symbols to []
        // here: an error body would then be indistinguishable from an empty
        // watchlist, and the caller would report success on a failed read.
        return { ok: true, id: j && j.id, name: j && j.name, symbols: j && j.symbols, raw_keys: j ? Object.keys(j).slice(0, 12) : [] };
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
  // A 200 carrying an error payload is the signature failure of this whole
  // codebase. {"s":"error"} has no id and no symbols array, and without this
  // gate it would surface as a perfectly healthy watchlist containing nothing.
  if (r.id === undefined || r.id === null || !Array.isArray(r.symbols)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The watchlist endpoint returned 200 but not a watchlist (keys: ${(r.raw_keys || []).join(', ') || 'none'})`,
      { hint: 'Usually an expired session. Reload TradingView, confirm you are logged in, and retry.' },
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

  // Prices only exist in the rendered widget, and the widget is not guaranteed
  // to be showing the list the API calls "active". MEASURED on a live account
  // 2026-08-20: the API returned RebelUOS (29 crypto symbols) while the panel
  // rendered a different list entirely (59 equities). Zero overlap.
  //
  // So enrichment is keyed by symbol and MATCHED, never assumed. The previous
  // shape set quotes_available from "the DOM gave me some rows", which was true
  // while not one of the 29 returned symbols carried a price — the same lie
  // this module exists to stop telling, just smaller.
  let quotes = {};
  let domSymbolCount = 0;
  try {
    await _ensureWatchlistOpen(evaluate, wait);
    const rows = await evaluate(`
      (function() {
        function norm(t) { return String(t || '').replace(/\u2212/g, '-').trim(); }
        var out = {};
        var nodes = document.querySelectorAll('[data-symbol-full]');
        for (var i = 0; i < nodes.length; i++) {
          var full = nodes[i].getAttribute('data-symbol-full');
          if (!full || out[full]) continue;
          // The cells live under the [data-symbol-full] element itself on the
          // current build. Climbing to a '[class*="row"]' ancestor finds
          // nothing — that class no longer exists — so try the node first and
          // only climb if it is barren.
          var cells = nodes[i].querySelectorAll('[class*="cell"]');
          if (!cells.length) {
            var up = nodes[i].closest('[class*="row"]') || nodes[i].parentElement;
            if (up) cells = up.querySelectorAll('[class*="cell"]');
          }
          var vals = [];
          for (var c = 0; c < cells.length; c++) {
            var t = norm(cells[c].textContent);
            if (t) vals.push(t);
          }
          if (vals.length) out[full] = vals;
        }
        return out;
      })()
    `);
    if (rows && typeof rows === 'object') quotes = rows;
    domSymbolCount = Object.keys(quotes).length;
  } catch { /* panel closed or layout changed; membership still stands */ }

  const enriched = symbols.map((sym) => (quotes[sym] && quotes[sym].length ? { symbol: sym, cells: quotes[sym] } : { symbol: sym }));
  const matchedQuotes = enriched.filter((x) => x.cells).length;

  return {
    success: true,
    watchlist: api.name,
    watchlist_id: api.id,
    count: symbols.length,
    symbols: enriched,
    sections,
    // The stored list VERBATIM, headers included and in order. A backup that
    // drops section structure is not a backup of this watchlist.
    entries: api.symbols.map(String),
    // True only when a symbol IN THIS LIST actually carries a price.
    quotes_available: matchedQuotes > 0,
    quotes_matched: matchedQuotes,
    // The panel is rendering symbols, none of which are in this list. Almost
    // always means the visible watchlist is not the active one. Worth saying
    // out loud rather than returning a silently price-free list.
    ...(matchedQuotes === 0 && domSymbolCount > 0
      ? { quote_note: `The watchlist panel is showing ${domSymbolCount} symbol(s) from a different list, so no prices could be attached. Membership below is authoritative.` }
      : {}),
    source: 'symbols_list_api',
  };
}

// Reject what cannot be acted on BEFORE any read or mutation. The old code
// trimmed and then filtered empties away, so watchlist_add("   ") reduced to
// an empty wanted[] and `[].every(...)` returned true: success on a call that
// touched nothing. An empty array is not evidence of success.
//
// Duplicates are collapsed here too. Posting ["A","A"] made added_count report
// two additions for one actual row.
function _cleanSymbols(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbols must be a non-empty array');
  }
  const seen = new Set();
  const out = [];
  for (const raw of symbols) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  if (out.length === 0) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'No usable symbols: every entry was empty or whitespace',
      { hint: 'Pass exchange-prefixed symbols, e.g. ["NASDAQ:TSLA"]. Call watchlist_get for the exact stored spelling.' },
    );
  }
  return out;
}

// A BARE TICKER IS STORED VERBATIM. Confirmed against the live API on
// 2026-08-20: POST /append/ with ["KO"] stores the literal string "KO", it does
// not resolve to "NYSE:KO". The old DOM path went through TradingView's own
// autocomplete and therefore always wrote the exchange-qualified form; the REST
// rewrite lost that, and the verification made it worse rather than better —
// the follow-up read finds the exact string we posted, so add() cheerfully
// reported success for a row TradingView may never resolve to an instrument.
//
// So resolve first and post the resolved form. If it cannot be resolved, that
// is a caller error worth stopping on, not a broken row worth creating.
async function _resolveBare(sym, _deps) {
  if (sym.includes(':')) return sym;           // already exchange-qualified
  if (_isHeader(sym)) return sym;              // section furniture, not a symbol
  let found;
  try {
    const r = await symbolSearch({ query: sym, _deps });
    found = (r.results || []).find((x) => String(x.symbol).toUpperCase() === sym.toUpperCase());
  } catch (err) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Could not resolve the bare ticker "${sym}" (symbol search failed: ${err.message})`,
      { hint: `Pass the exchange-prefixed form directly, e.g. NASDAQ:${sym.toUpperCase()}.` },
    );
  }
  if (!found || !found.full_name || !found.full_name.includes(':')) {
    throw new ClassifiedError(
      CATEGORIES.SYMBOL_UNKNOWN,
      `"${sym}" does not resolve to a TradingView instrument`,
      { hint: 'Call symbol_search to find the exchange-prefixed name, then pass that.' },
    );
  }
  return found.full_name;
}

// Both mutations read the active list before and after. If the operator (or
// another tab) switches the active watchlist mid-flight, the "after" read
// describes a DIFFERENT list, and a symbol that list already contained would
// verify as a successful add to a list we never touched.
function _assertSameList(before, after, verb) {
  if (String(before.id) !== String(after.id)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The active watchlist changed during the ${verb} (${before.name} -> ${after.name}); the result could not be verified`,
      { hint: 'Avoid switching watchlists while a bulk operation runs, then retry.' },
    );
  }
}

export async function add({ symbol, _deps }) {
  if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'symbol must be a non-empty string');
  }
  const res = await addBulk({ symbols: [symbol], _deps });
  const one = res.results && res.results[0];
  // THROW when the independent read says it did not take. The single-symbol
  // contract is "it worked or you get an error" — importFrom and the CLI both
  // rely on that, and returning {success:false} instead let a failed add be
  // counted as added one layer up.
  if (!res.success) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The API accepted the add but ${symbol} is still not in ${res.watchlist}`,
      { hint: 'TradingView may have rejected the symbol. Confirm the exchange-prefixed spelling with symbol_search.' },
    );
  }
  return {
    success: true,
    symbol: (one && one.symbol) || symbol,
    already_present: (one && one.already_present) || false,
    watchlist: res.watchlist,
    count: res.count,
    verified: res.verified,
  };
}

export async function addBulk({ symbols, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const requested = _cleanSymbols(symbols);
  const before = await _apiActive(evaluateAsync);
  const had = new Set(before.symbols.map(String));

  // Resolve bare tickers BEFORE the membership check, so "AAPL" is compared
  // against the stored "NASDAQ:AAPL" rather than being posted as a new row.
  const resolved = [];
  for (const sym of requested) {
    resolved.push(had.has(sym) ? sym : await _resolveBare(sym, _deps));
  }
  const wanted = [...new Set(resolved)];
  const missing = wanted.filter((x) => !had.has(x));

  if (missing.length) await _apiMutate(evaluateAsync, before.id, 'append', missing);

  // VERIFY from a fresh read, not from the mutation's own response.
  const after = await _apiActive(evaluateAsync);
  _assertSameList(before, after, 'add');
  const now = new Set(after.symbols.map(String));
  const results = wanted.map((x) => ({ symbol: x, added: now.has(x), already_present: had.has(x) }));
  const allThere = results.every((r) => r.added);
  return {
    success: allThere,
    watchlist: after.name,
    watchlist_id: after.id,
    count: after.symbols.filter((x) => !_isHeader(x)).length,
    added_count: results.filter((r) => r.added && !r.already_present).length,
    not_added: results.filter((r) => !r.added).map((r) => r.symbol),
    results,
    verified: allThere,
    source: 'symbols_list_api',
  };
}

export async function remove({ symbol, _deps }) {
  if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
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
  // Present before, still present after: the API said ok and nothing happened.
  if (!res.success) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The API accepted the removal but ${symbol} is still in ${res.watchlist}`,
      { hint: 'Retry once; if it persists, remove it in the TradingView UI and report the symbol.' },
    );
  }
  return {
    success: true,
    symbol: (one && one.symbol) || symbol,
    watchlist: res.watchlist,
    count: res.count,
    verified: res.verified,
  };
}

export async function removeBulk({ symbols, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const wanted = _cleanSymbols(symbols);
  const before = await _apiActive(evaluateAsync);
  const had = new Set(before.symbols.map(String));
  const present = wanted.filter((x) => had.has(x));

  if (present.length) await _apiMutate(evaluateAsync, before.id, 'remove', present);

  const after = await _apiActive(evaluateAsync);
  _assertSameList(before, after, 'remove');
  const now = new Set(after.symbols.map(String));
  const results = wanted.map((x) => ({ symbol: x, was_present: had.has(x), removed: had.has(x) && !now.has(x) }));

  // "You asked me to remove AAPL, I did nothing, here is success:true" is the
  // 2.2.3 bug wearing a different hat. A symbol that was never there was NOT
  // removed. not_found is still reported separately so the caller can tell the
  // two failure shapes apart.
  const removedAll = results.every((r) => r.removed);
  const notFound = results.filter((r) => !r.was_present).map((r) => r.symbol);
  const survived = results.filter((r) => r.was_present && !r.removed).map((r) => r.symbol);
  return {
    success: removedAll,
    watchlist: after.name,
    watchlist_id: after.id,
    count: after.symbols.filter((x) => !_isHeader(x)).length,
    removed_count: results.filter((r) => r.removed).length,
    not_found: notFound,
    survived,
    results,
    verified: removedAll,
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
      CATEGORIES.INVALID_ARGUMENT,
      `Path rejected: ${filePath}. Paths must not contain ".." and absolute paths must be under home directory or /tmp.`,
    );
  }

  mkdirSync(dirname(filePath), { recursive: true });

  const result = await get({ _deps });
  const exported_at = new Date().toISOString();
  // schema_version 2 adds `entries`: the stored list verbatim, headers in place
  // and in order. Version 1 kept only the tradable symbols, so an export ->
  // replace-import round-trip silently destroyed the operator's section
  // structure — ten headers, on the live account this was measured against.
  // `symbols` stays for readers of the old shape.
  const payload = {
    schema_version: 2,
    exported_at,
    watchlist: result.watchlist,
    symbols: result.symbols,
    entries: result.entries || result.symbols.map((x) => x.symbol),
    sections: result.sections || [],
  };

  // Unique tmp suffix prevents concurrent exports from overwriting each
  // other's sidecar file — was a known race on the hardcoded `.tmp` name.
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.${process.pid}.${rand}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, filePath);

  return {
    success: true,
    file_path: filePath,
    count: result.symbols.length,
    section_count: (result.sections || []).length,
    schema_version: 2,
    exported_at,
  };
}

export async function importFrom({ file_path, mode = 'merge', dry_run = false, _deps } = {}) {
  // Mirror the allowlist exportTo enforces — without this gate, importFrom
  // could read arbitrary JSON from anywhere on the filesystem (e.g.
  // ~/.ssh/-shaped files, /etc/*) and reflect contents back to the caller.
  // A bad path, a missing file or malformed JSON are CALLER errors. Filing
  // them under API_UNEXPECTED sent people to look at TradingView for a typo in
  // their own argument.
  if (!_isPathAllowed(file_path)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Path rejected: ${file_path}. Paths must resolve under home directory or system tmp.`,
    );
  }
  if (!existsSync(file_path)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `File not found: ${file_path}`);
  }

  let parsed;
  try {
    parsed = parseJsonSafe(readFileSync(file_path, 'utf8'));
  } catch {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Failed to parse JSON from: ${file_path}`);
  }

  const version = parsed?.schema_version;
  if ((version !== 1 && version !== 2) || !Array.isArray(parsed?.symbols)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'Invalid file shape. Expected { schema_version: 1 | 2, symbols: [...] }.',
    );
  }

  // Version 2 carries `entries`: the stored list verbatim, section headers in
  // place. Replaying those restores the operator's structure instead of
  // flattening ten sections into an undifferentiated list. Confirmed live on
  // 2026-08-20 that the append endpoint accepts a ### header entry.
  const incoming = Array.isArray(parsed.entries) && parsed.entries.length
    ? parsed.entries.map(String).filter(Boolean)
    : parsed.symbols.map(s => s.symbol).filter(Boolean);
  const current = await get({ _deps });
  // Compare against the STORED entries, headers included, so a section that is
  // already there is skipped rather than duplicated.
  const currentSet = new Set(current.entries && current.entries.length
    ? current.entries.map(String)
    : current.symbols.map(s => s.symbol));

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
          // remove() throws when its own verify read fails, but check the
          // returned flag too: this loop is the layer where a failure that is
          // merely REPORTED rather than thrown used to disappear.
          const r = await remove({ symbol: s.symbol, _deps });
          if (r && r.success === false) {
            errors.push({ symbol: s.symbol, error: 'removal was not confirmed by the follow-up read' });
          }
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

  const sections_restored = [];
  for (const sym of incoming) {
    if (currentSet.has(sym)) {
      skipped.push(sym);
      continue;
    }
    if (_isHeader(sym)) {
      // A header is list furniture, not an instrument, so it must not go
      // through symbol resolution. Post it directly and confirm from a read.
      try {
        const { evaluateAsync } = _resolve(_deps);
        const beforeH = await _apiActive(evaluateAsync);
        await _apiMutate(evaluateAsync, beforeH.id, 'append', [sym]);
        const afterH = await _apiActive(evaluateAsync);
        if (afterH.symbols.map(String).includes(sym)) {
          sections_restored.push(sym);
          currentSet.add(sym);
        } else {
          errors.push({ symbol: sym, error: 'the section header was not confirmed by the follow-up read' });
        }
      } catch (err) {
        errors.push({ symbol: sym, error: err.message });
      }
      continue;
    }
    try {
      // Never push to added[] on the strength of "the call returned". add()
      // throws on a failed verification now; the explicit success check is the
      // second lock, because this exact line reported imports that never
      // happened as clean successes.
      const r = await add({ symbol: sym, _deps });
      if (r && r.success === false) {
        errors.push({ symbol: sym, error: 'the add was not confirmed by the follow-up read' });
        continue;
      }
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
    sections_restored,
    section_count: sections_restored.length,
    error_count: errors.length,
    errors,
  };
}
