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
    getClient: deps?.getClient || _getClient,
  };
}

export async function get({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
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
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  // First ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) {
    throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, panelState.error, {
      hint: 'Open the Watchlist panel manually or via ui_open_panel({panel: "watchlist", action: "open"})',
    });
  }
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  const before = await _currentSymbolsSet(evaluate);

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      'Add symbol button not found in watchlist panel',
      { hint: 'TradingView UI may have changed. Try opening the watchlist panel manually first.' },
    );
  }
  await new Promise(r => setTimeout(r, 300));

  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 400));

  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  await new Promise(r => setTimeout(r, 300));

  // Verify: at least one new symbol appeared, AND one of them resolves from
  // the user's input. TradingView expands bare tickers (AAPL → NASDAQ:AAPL),
  // so trust the diff rather than assuming the input string is what got stored.
  // Poll (≤3s) instead of trusting a single fixed-delay snapshot — slow
  // autocomplete / network latency previously produced a false SYMBOL_UNKNOWN
  // even when the add succeeded a beat later.
  let added = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const after = await _currentSymbolsSet(evaluate);
    added = [...after].filter((s) => !before.has(s));
    if (added.length > 0) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (added.length === 0) {
    throw new ClassifiedError(
      CATEGORIES.SYMBOL_UNKNOWN,
      `Add reported click but watchlist unchanged for "${symbol}". TradingView likely rejected it (ambiguous, wrong exchange, or not found).`,
      { hint: 'Try prefixing with an exchange (e.g., NASDAQ:AAPL, BINANCE:BTCUSDT) and retry.' },
    );
  }
  return { success: true, action: 'added', requested_symbol: symbol, stored_symbol: added[0], added_count: added.length };
}

export async function remove({ symbol, _deps }) {
  if (!symbol || typeof symbol !== 'string') {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'symbol must be a non-empty string');
  }
  const { evaluate, getClient } = _resolve(_deps);

  // Resolve the user-supplied symbol against the stored exchange-prefixed
  // form. Bare "AAPL" → stored "NASDAQ:AAPL"; we need the stored string for
  // the data-symbol-full CSS selector to match.
  const resolved = await _resolveStoredSymbol(evaluate, symbol);
  if (!resolved) {
    throw new ClassifiedError(
      CATEGORIES.SYMBOL_UNKNOWN,
      `Symbol not found in watchlist: ${symbol}`,
      { hint: 'Call watchlist_get first to see exact stored symbol names (they may be exchange-prefixed).' },
    );
  }
  const rowSelector = `[data-symbol-full=${JSON.stringify(resolved)}]`;

  // Try context-menu approach: right-click the row, click Remove.
  const menuResult = await evaluate(`
    (function() {
      var row = document.querySelector(${safeString(rowSelector)});
      if (!row) return { found: false };
      var evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      row.dispatchEvent(evt);
      return { found: true, dispatched: true };
    })()
  `);

  let method = null;
  if (menuResult?.found) {
    await new Promise(r => setTimeout(r, 300));
    const removeClicked = await evaluate(`
      (function() {
        var items = document.querySelectorAll('[role="menuitem"], [data-name*="remove"], [class*="menuItem"]');
        for (var i = 0; i < items.length; i++) {
          var text = items[i].textContent.trim().toLowerCase();
          if (text === 'remove' || text === 'delete' || text === 'remove from watchlist') {
            items[i].click();
            return { clicked: true };
          }
        }
        return { clicked: false };
      })()
    `);
    if (removeClicked?.clicked) method = 'context_menu';
  }

  // Keyboard fallback: focus the row and press Delete.
  if (!method) {
    const focusResult = await evaluate(`
      (function() {
        var row = document.querySelector(${safeString(rowSelector)});
        if (!row) return { found: false };
        row.focus();
        return { found: true };
      })()
    `);
    if (focusResult?.found) {
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      method = 'keyboard';
    }
  }

  // Verify the symbol is actually gone. Previously both paths returned
  // success:true without checking — a right-click that missed or a Delete
  // keypress swallowed by a focused sibling silently reported success.
  await new Promise(r => setTimeout(r, 300));
  const stillThere = await _resolveStoredSymbol(evaluate, resolved);
  if (stillThere) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Remove reported a click but "${resolved}" is still in the watchlist`,
      { hint: 'The TradingView watchlist UI may have changed; try removing manually and filing an issue with the stored symbol name.' },
    );
  }
  if (!method) {
    // Row was present during resolve but we couldn't open the menu or focus it.
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `Found "${resolved}" in watchlist but couldn't dispatch the remove action`,
      { hint: 'The watchlist row selector may have changed. Try right-clicking the symbol manually and choosing Remove.' },
    );
  }
  return { success: true, action: 'removed', requested_symbol: symbol, stored_symbol: resolved, method };
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
