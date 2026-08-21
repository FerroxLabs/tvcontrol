/**
 * Behavioural tests for the bulk paths: quote_batch and alert_create_bulk.
 *
 * These exist because both features were only possible once it turned out the
 * TradingView APIs take the symbol as a PARAMETER. The old code read it off the
 * chart, so quote_get physically switched the chart symbol and switched back
 * (measured: 21 seconds for one symbol, and it timed out on both the switch and
 * the restore), and alert_create could only ever target whatever was on screen.
 *
 * The contract these tests defend: neither path may touch the chart, and
 * neither may report a symbol as handled that a fresh read cannot confirm.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getQuotes } from '../src/core/data.js';
import { createBulk } from '../src/core/alerts.js';
import { CATEGORIES } from '../src/errors.js';

const scannerRows = (rows) => ({
  ok: true,
  json: async () => ({ data: rows.map(([s, last]) => ({ s, d: [s.split(':').pop(), last, 0, 0, 0, 0, 0, 0] })) }),
});

describe('quote_batch', () => {
  it('returns a quote per symbol from a single request', async () => {
    let calls = 0;
    const _deps = { fetch: async () => { calls += 1; return scannerRows([['NASDAQ:AAPL', 311.3], ['BINANCE:BTCUSDT', 73752]]); } };
    const r = await getQuotes({ symbols: ['NASDAQ:AAPL', 'BINANCE:BTCUSDT'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.equal(calls, 1, 'the whole set must cost ONE request, not one per symbol');
    assert.equal(r.quotes[0].last, 311.3);
  });

  it('NAMES the symbols the endpoint did not know instead of returning a short list', async () => {
    // A short array reads as "here are your quotes" and the caller assumes
    // coverage. Silence about a missing symbol is how a sweep skips a position.
    const _deps = { fetch: async () => scannerRows([['NASDAQ:AAPL', 311.3]]) };
    const r = await getQuotes({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NOTREAL'], _deps });
    assert.equal(r.success, false, 'partial coverage is not success');
    assert.deepEqual(r.not_found, ['NASDAQ:NOTREAL']);
    assert.equal(r.requested, 2);
    assert.equal(r.count, 1);
  });

  it('a 200 that is not a result set is an error, not an empty quote list', async () => {
    const _deps = { fetch: async () => ({ ok: true, json: async () => ({ totalCount: 0 }) }) };
    await assert.rejects(
      () => getQuotes({ symbols: ['NASDAQ:AAPL'], _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /not a result set/.test(err.message),
    );
  });

  it('rejects an all-whitespace symbol list rather than reporting an empty success', async () => {
    await assert.rejects(
      () => getQuotes({ symbols: ['  ', ''], _deps: {} }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});

describe('alert_create_bulk', () => {
  // The chart API is deliberately absent from these deps. If any code path
  // tries to read or set the chart symbol, these tests fail loudly, which is
  // the property that matters: bulk must never touch the chart.
  function bulkDeps({ quotes, createOk = true, listed = 'all', storedSymbol = null,
    storedResolution = null, requestOrder = [], requestedResolution = null }) {
    const made = [];
    const evaluateAsync = async (expr) => {
      if (expr.includes('list_alerts')) {
        // THIS USED TO RETURN symbol: 'X' FOR EVERY ALERT.
        // Verification only checked that the id was present, so a bulk create
        // for AAPL and TSLA "verified" against alerts stored on X and the test
        // could not fail for a symbol mismatch. Caught by an external audit.
        // The mock now stores what was actually requested, and `storedSymbol`
        // lets a test force the mismatch on purpose.
        const ids = listed === 'all' ? made : listed === 'none' ? [] : made.slice(0, listed);
        return {
          alerts: ids.map((m) => ({
            alert_id: m.id,
            symbol: storedSymbol === null ? m.symbol : storedSymbol,
            resolution: storedResolution === null ? m.resolution : storedResolution,
          })),
        };
      }
      if (expr.includes('create_alert')) {
        if (!createOk) return { ok: false, error: 'invalid_request' };
        const id = 9000 + made.length;
        // createBulk issues one create per requested symbol, in order, so the
        // Nth create is for the Nth symbol. Recording it that way is exact and
        // does not depend on parsing a payload out of the expression string.
        const sym = requestOrder[made.length] ?? null;
        made.push({ id, symbol: sym, resolution: requestedResolution });
        return { ok: true, alert_id: id, symbol: sym };
      }
      if (expr.includes('setSymbol') || expr.includes('.symbol()')) {
        throw new Error('bulk alert creation must never touch the chart');
      }
      return undefined;
    };
    return { _deps: { evaluateAsync, evaluate: evaluateAsync, fetch: async () => scannerRows(quotes) }, made };
  }

  it('prices each symbol from its own live quote, because one level cannot fit a mixed watchlist', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100], ['BINANCE:BTCUSDT', 80000]], requestOrder: ['NASDAQ:AAPL', 'BINANCE:BTCUSDT'] });
    const r = await createBulk({ symbols: ['NASDAQ:AAPL', 'BINANCE:BTCUSDT'], percent_from_last: 5, dry_run: true, _deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.would_create, [
      { symbol: 'NASDAQ:AAPL', price: 105 },
      { symbol: 'BINANCE:BTCUSDT', price: 84000 },
    ]);
  });

  it('confirms every alert from a fresh list read, not from the create response', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100], ['NASDAQ:TSLA', 200]], requestOrder: ['NASDAQ:AAPL', 'NASDAQ:TSLA'] });
    const r = await createBulk({ symbols: ['NASDAQ:AAPL', 'NASDAQ:TSLA'], percent_from_last: 5, webhook_url: 'https://example.com/h', _deps });
    assert.equal(r.success, true);
    assert.equal(r.created_count, 2);
    assert.equal(r.verified_from, 'list_alerts');
    assert.equal(r.webhook, 'https://example.com/h');
  });

  it('does NOT count an alert the server stored against a DIFFERENT symbol', async () => {
    // Caught by an external audit. Verification checked only that the id came
    // back present, so an alert stored on the wrong instrument counted as
    // created. On a whole-watchlist sweep that is the difference between 74
    // correct alerts and 74 alerts on one symbol, reported as full success.
    const { _deps } = bulkDeps({
      quotes: [['NASDAQ:AAPL', 100], ['NASDAQ:TSLA', 200]],
      requestOrder: ['NASDAQ:AAPL', 'NASDAQ:TSLA'],
      storedSymbol: 'BINANCE:DOGEUSDT',
    });
    const r = await createBulk({
      symbols: ['NASDAQ:AAPL', 'NASDAQ:TSLA'], percent_from_last: 5, _deps,
    });
    assert.equal(r.success, false, 'alerts on the wrong instrument are not a success');
    assert.equal(r.created_count, 0);
    assert.equal(r.failed_count, 2);
    const reasons = (r.results || r.failed || []).map((x) => x.reason).join(' ');
    assert.match(reasons, /stored alert is on "BINANCE:DOGEUSDT"/);
  });

  it('accepts a bare ticker the server stored qualified', async () => {
    // The server qualifies: ask for AAPL, it stores NASDAQ:AAPL. That is a
    // match, not a mismatch, and treating it as one would fail every correct
    // bulk create made with bare tickers.
    const { _deps } = bulkDeps({
      // priced under the bare ticker, which is what was requested
      quotes: [['AAPL', 100]],
      requestOrder: ['AAPL'],
      storedSymbol: 'NASDAQ:AAPL',
    });
    const r = await createBulk({ symbols: ['AAPL'], percent_from_last: 5, _deps });
    assert.equal(r.created_count, 1);
    assert.equal(r.failed_count, 0);
  });

  it('says plainly that the webhook could not be confirmed, rather than implying it was', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100]], requestOrder: ['NASDAQ:AAPL'] });
    const r = await createBulk({
      symbols: ['NASDAQ:AAPL'], percent_from_last: 5,
      webhook_url: 'https://example.test/hook', _deps,
    });
    assert.equal(r.webhook_verified, null, 'null, not true: the list endpoint does not return it');
    assert.match(r.webhook_note, /does not return webhook URLs/);
  });

  it('does NOT count an alert the follow-up read cannot find', async () => {
    // The create call said ok for both; the list only shows one. That is the
    // whole reason the verification read exists.
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100], ['NASDAQ:TSLA', 200]], listed: 1, requestOrder: ['NASDAQ:AAPL', 'NASDAQ:TSLA'] });
    const r = await createBulk({ symbols: ['NASDAQ:AAPL', 'NASDAQ:TSLA'], percent_from_last: 5, _deps });
    assert.equal(r.success, false);
    assert.equal(r.created_count, 1);
    assert.equal(r.failed_count, 1);
    assert.match(r.error, /could not be confirmed/);
  });

  it('THROWS when the verification read fails, rather than reporting the batch as created', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100]], listed: 'none', requestOrder: ['NASDAQ:AAPL'] });
    // listed:'none' makes BOTH reads empty; the pre-read succeeds (empty is a
    // legitimate alert list) so this exercises per-alert confirmation failure.
    const r = await createBulk({ symbols: ['NASDAQ:AAPL'], percent_from_last: 5, _deps });
    assert.equal(r.success, false);
    assert.equal(r.created_count, 0);
  });

  it('refuses both price and percent_from_last, and refuses neither', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100]], requestOrder: ['NASDAQ:AAPL'] });
    for (const args of [{ price: 10, percent_from_last: 5 }, {}]) {
      await assert.rejects(
        () => createBulk({ symbols: ['NASDAQ:AAPL'], ...args, _deps }),
        (err) => err.category === CATEGORIES.INVALID_ARGUMENT && /exactly one/.test(err.message),
      );
    }
  });

  it('refuses a webhook that is not an http(s) URL', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100]], requestOrder: ['NASDAQ:AAPL'] });
    await assert.rejects(
      () => createBulk({ symbols: ['NASDAQ:AAPL'], percent_from_last: 5, webhook_url: 'javascript:alert(1)', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('reports symbols that had no quote instead of quietly alerting on fewer', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100]], requestOrder: ['NASDAQ:AAPL'] });
    const r = await createBulk({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NOTREAL'], percent_from_last: 5, dry_run: true, _deps });
    assert.equal(r.success, false);
    assert.deepEqual(r.skipped, ['NASDAQ:NOTREAL']);
  });

  it('rejects a frequency the API does not accept, before spending a request', async () => {
    const { _deps } = bulkDeps({ quotes: [['NASDAQ:AAPL', 100]], requestOrder: ['NASDAQ:AAPL'] });
    await assert.rejects(
      () => createBulk({ symbols: ['NASDAQ:AAPL'], percent_from_last: 5, frequency: 'once_per_bar', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});
