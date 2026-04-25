/**
 * Offline tests for src/core/watchlist.js — remove, exportTo, importFrom.
 * No TradingView connection required.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { remove, exportTo, importFrom } from '../src/core/watchlist.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';
import { scriptedDeps, emptyDeps } from './_helpers.js';

let TMP;

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tv-mcp-watchlist-test-'));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe('remove()', () => {
  it('rejects empty symbol', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => remove({ symbol: '', _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });

  it('rejects non-string symbol', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => remove({ symbol: null, _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });

  it('happy path — resolve + context-menu + post-remove verify', async () => {
    // Sequence under the new contract:
    //   1. _resolveStoredSymbol preflight (user input AAPL → stored AAPL)
    //   2. contextmenu dispatch on the row
    //   3. Remove menu item click
    //   4. _resolveStoredSymbol post-verify (symbol is gone)
    const { _deps, evaluate } = scriptedDeps({}, [
      { match: 'exact', symbolFull: 'AAPL' }, // resolve-before: found
      { found: true, dispatched: true },       // contextmenu
      { clicked: true },                        // Remove click
      { match: null },                          // resolve-after: gone
    ]);
    const result = await remove({ symbol: 'AAPL', _deps });
    assert.equal(result.success, true);
    assert.equal(result.action, 'removed');
    assert.equal(result.requested_symbol, 'AAPL');
    assert.equal(result.stored_symbol, 'AAPL');
    assert.equal(result.method, 'context_menu');
    assert.ok(evaluate.calls.some(c => c.includes('AAPL')));
  });

  it('fuzzy match — bare ticker resolves to exchange-prefixed stored form', async () => {
    const { _deps } = scriptedDeps({}, [
      { match: 'fuzzy', symbolFull: 'NASDAQ:AAPL' }, // resolve-before
      { found: true, dispatched: true },
      { clicked: true },
      { match: null },                                // resolve-after
    ]);
    const result = await remove({ symbol: 'AAPL', _deps });
    assert.equal(result.success, true);
    assert.equal(result.requested_symbol, 'AAPL');
    assert.equal(result.stored_symbol, 'NASDAQ:AAPL');
  });

  it('silent-success guard — throws when click reported but symbol still present', async () => {
    const { _deps } = scriptedDeps({}, [
      { match: 'exact', symbolFull: 'AAPL' },     // resolve-before
      { found: true, dispatched: true },           // menu opened
      { clicked: true },                            // click reported success
      { match: 'exact', symbolFull: 'AAPL' },     // resolve-after: STILL THERE
    ]);
    await assert.rejects(
      remove({ symbol: 'AAPL', _deps }),
      (err) => err.category === 'api_unexpected' && /still in the watchlist/i.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// exportTo()
// ---------------------------------------------------------------------------

describe('exportTo()', () => {
  it('writes JSON to a tmp path', async () => {
    const filePath = join(TMP, 'export-test.json');
    const { _deps } = scriptedDeps({}, [
      // get() calls evaluate once for the DOM scrape
      { symbols: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }], source: 'data_attributes' },
    ]);
    const result = await exportTo({ file_path: filePath, _deps });
    assert.equal(result.success, true);
    assert.equal(result.file_path, filePath);
    assert.equal(result.count, 2);
    // File must exist and be valid JSON
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(parsed.schema_version, 1);
    assert.ok(Array.isArray(parsed.symbols));
    assert.ok(parsed.exported_at);
  });

  it('rejects path with .. traversal', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => exportTo({ file_path: '/tmp/../etc/passwd', _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });

  it('rejects absolute path outside home and tmp', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => exportTo({ file_path: '/etc/watchlist.json', _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// importFrom()
// ---------------------------------------------------------------------------

describe('importFrom()', () => {
  it('rejects missing file (ENOENT)', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => importFrom({ file_path: join(TMP, 'does-not-exist.json'), _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });

  it('rejects malformed JSON', async () => {
    const bad = join(TMP, 'bad.json');
    writeFileSync(bad, 'not json at all');
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => importFrom({ file_path: bad, _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });

  it('rejects missing schema_version', async () => {
    const bad = join(TMP, 'no-schema.json');
    writeFileSync(bad, JSON.stringify({ symbols: [] }));
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => importFrom({ file_path: bad, _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        return true;
      },
    );
  });

  it('dry_run returns would_add and would_skip without touching state', async () => {
    const file = join(TMP, 'dry-run.json');
    writeFileSync(file, JSON.stringify({
      schema_version: 1,
      exported_at: new Date().toISOString(),
      symbols: [{ symbol: 'AAPL' }, { symbol: 'TSLA' }],
    }));

    // get() returns AAPL already present
    const { _deps, evaluate } = scriptedDeps({}, [
      { symbols: [{ symbol: 'AAPL' }], source: 'data_attributes' },
    ]);

    const result = await importFrom({ file_path: file, dry_run: true, _deps });
    assert.equal(result.success, true);
    assert.equal(result.dry_run, true);
    assert.deepEqual(result.would_add, ['TSLA']);
    assert.deepEqual(result.would_skip, ['AAPL']);
    // No mutation calls beyond get()
    assert.equal(evaluate.calls.length, 1);
  });

  it('mode=merge adds symbols not already present', async () => {
    const file = join(TMP, 'merge.json');
    writeFileSync(file, JSON.stringify({
      schema_version: 1,
      exported_at: new Date().toISOString(),
      symbols: [{ symbol: 'AAPL' }, { symbol: 'NVDA' }],
    }));

    // Sequence:
    //   call 0 — get() for current list → AAPL already present
    //   call 1..N — add() panel check for NVDA
    //   add() also calls getClient() — mock that via _deps
    const mockClient = {
      Input: {
        insertText: async () => {},
        dispatchKeyEvent: async () => {},
      },
    };
    const { _deps, evaluate } = scriptedDeps({}, [
      { symbols: [{ symbol: 'AAPL' }], source: 'data_attributes' }, // get() — AAPL already present
      { opened: false },     // add() panel state check
      [],                     // add() before-set (empty from evaluate's perspective)
      { found: true },        // add() addClicked
      ['NVDA'],               // add() after-set — NVDA was added
    ]);
    _deps.getClient = async () => mockClient;

    const result = await importFrom({ file_path: file, mode: 'merge', _deps });
    assert.equal(result.success, true);
    assert.equal(result.mode, 'merge');
    assert.deepEqual(result.skipped, ['AAPL']);
    assert.deepEqual(result.added, ['NVDA']);
    assert.deepEqual(result.errors, []);
  });
});
