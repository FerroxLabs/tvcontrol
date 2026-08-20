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
  // The DOM context-menu contract these tests used to assert is GONE. It was
  // measured broken against a live account on 2026-08-20: remove reported a
  // click and the symbol stayed. watchlist is now built on TradingView's
  // symbols_list REST API, so the contract is: read the list, POST the
  // mutation, read the list AGAIN, and report what the second read proves.
  //
  // removeBulk makes exactly three evaluateAsync calls, which is what the
  // sequences below supply:
  //   1. GET  active/           list before
  //   2. POST custom/<id>/remove/
  //   3. GET  active/           list after, for verification

  it('rejects empty symbol', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => remove({ symbol: '', _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        // INVALID_ARGUMENT, not API_UNEXPECTED: an empty symbol is a caller
        // error, and classifying it as an API fault sent people looking at
        // TradingView instead of their own call.
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
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
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('happy path — the second read proves the symbol is gone', async () => {
    const { _deps, evaluate } = scriptedDeps({}, [
      { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
      { ok: true, status: 200 },
      { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:MSFT'] },
    ]);
    const result = await remove({ symbol: 'NASDAQ:AAPL', _deps });
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.symbol, 'NASDAQ:AAPL');
    assert.equal(result.count, 1);
    assert.ok(evaluate.calls.some((c) => c.includes('remove')));
  });

  it('SILENT-SUCCESS GUARD — the API says ok but the symbol is still there', async () => {
    // This is the exact failure that shipped in 2.2.3, now caught by the
    // second read instead of being reported as success.
    //
    // Returning {success:false} was not enough. importFrom called remove() in
    // a try/catch and only counted a THROW as a failure, so a removal that
    // reported its own failure still vanished from the import report. The
    // single-symbol contract is "it worked, or you get an error".
    const { _deps } = scriptedDeps({}, [
      { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:AAPL'] },
      { ok: true, status: 200 },
      { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:AAPL'] },
    ]);
    await assert.rejects(
      () => remove({ symbol: 'NASDAQ:AAPL', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /still in/.test(err.message),
    );
  });

  it('symbol not in the list throws SYMBOL_UNKNOWN rather than silently passing', async () => {
    const { _deps } = scriptedDeps({}, [
      { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:MSFT'] },
      { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:MSFT'] },
    ]);
    await assert.rejects(
      () => remove({ symbol: 'NASDAQ:AAPL', _deps }),
      (err) => err.category === CATEGORIES.SYMBOL_UNKNOWN,
    );
  });

  it('section headers are not counted as symbols', async () => {
    const { _deps } = scriptedDeps({}, [
      { ok: true, id: 42, name: 'T', symbols: ['###CORE BASKET', 'NASDAQ:AAPL', 'NASDAQ:MSFT'] },
      { ok: true, status: 200 },
      { ok: true, id: 42, name: 'T', symbols: ['###CORE BASKET', 'NASDAQ:MSFT'] },
    ]);
    const result = await remove({ symbol: 'NASDAQ:AAPL', _deps });
    assert.equal(result.count, 1, '### entries are list furniture, not tradable symbols');
  });
});

// ---------------------------------------------------------------------------
// exportTo()
// ---------------------------------------------------------------------------

describe('exportTo()', () => {
  it('writes JSON to a tmp path', async () => {
    const filePath = join(TMP, 'export-test.json');
    // get() now sources membership from the symbols_list API. Keyed by
    // substring so the DOM price-enrichment calls (which are best-effort and
    // may not fire at all) cannot shift a positional sequence.
    const { _deps } = scriptedDeps({
      "active/": { ok: true, id: 42, name: 'Test', symbols: ['AAPL', 'MSFT'] },
      'data-symbol-full': {},
    });
    const result = await exportTo({ file_path: filePath, _deps });
    assert.equal(result.success, true);
    assert.equal(result.file_path, filePath);
    assert.equal(result.count, 2);
    // File must exist and be valid JSON
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    // schema_version 2: `entries` preserves section headers and order, so an
    // export -> replace-import round-trip no longer destroys the structure.
    assert.equal(parsed.schema_version, 2);
    assert.ok(Array.isArray(parsed.entries), 'the faithful ordered list must be present');
    assert.ok(Array.isArray(parsed.symbols));
    assert.ok(parsed.exported_at);
  });

  it('rejects path with .. traversal', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => exportTo({ file_path: '/tmp/../etc/passwd', _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
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
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
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
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
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
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
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
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
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

    // get() reports AAPL already present, from the API
    const { _deps, evaluate } = scriptedDeps({
      "active/": { ok: true, id: 42, name: 'Test', symbols: ['AAPL'] },
      'data-symbol-full': {},
    });

    const result = await importFrom({ file_path: file, dry_run: true, _deps });
    assert.equal(result.success, true);
    assert.equal(result.dry_run, true);
    assert.deepEqual(result.would_add, ['TSLA']);
    assert.deepEqual(result.would_skip, ['AAPL']);
    // A dry run must not mutate anything: no append/remove POST is issued.
    assert.ok(!evaluate.calls.some((c) => /custom\/.*\/(append|remove)/.test(c)),
      'dry_run issued a mutation call');
  });

  it('mode=merge adds symbols not already present', async () => {
    const file = join(TMP, 'merge.json');
    writeFileSync(file, JSON.stringify({
      schema_version: 1,
      exported_at: new Date().toISOString(),
      symbols: [{ symbol: 'NASDAQ:AAPL' }, { symbol: 'NASDAQ:NVDA' }],
    }));

    // add() no longer types into a panel — it POSTs to the append endpoint and
    // then re-reads to confirm. The list therefore has to GROW between the two
    // reads, which is what makes this a real test of the verification rather
    // than of the mock.
    let listReads = 0;
    const { _deps } = scriptedDeps({
      "active/": () => {
        listReads += 1;
        // read 1: importFrom's get()      -> AAPL only
        // read 2: addBulk's before-read   -> AAPL only
        // read 3: addBulk's verify-read   -> AAPL + NVDA
        return listReads >= 3
          ? { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'] }
          : { ok: true, id: 42, name: 'Test', symbols: ['NASDAQ:AAPL'] };
      },
      'append': { ok: true, status: 200 },
      'data-symbol-full': {},
    });

    const result = await importFrom({ file_path: file, mode: 'merge', _deps });
    assert.equal(result.success, true);
    assert.equal(result.mode, 'merge');
    assert.deepEqual(result.skipped, ['NASDAQ:AAPL']);
    assert.deepEqual(result.added, ['NASDAQ:NVDA']);
    assert.deepEqual(result.errors, []);
  });
});
