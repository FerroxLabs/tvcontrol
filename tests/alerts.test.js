/**
 * Tests for deleteById in src/core/alerts.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create, deleteById } from '../src/core/alerts.js';
import { scriptedDeps, emptyDeps } from './_helpers.js';
import { CATEGORIES } from '../src/errors.js';

const OK_RESPONSE = { s: 'ok', method: 'post' };
const ERR_RESPONSE = { s: 'error', errmsg: 'not found' };

describe('create()', () => {
  it('uses the authenticated alert API and applies the requested condition', async () => {
    const calls = [];
    const result = await create({
      condition: 'greater_than',
      price: 500,
      message: 'Breakout',
      _deps: {
        // create() now re-reads the alert list to confirm the alert exists.
        // The POST response is the action reporting on itself; it is not
        // evidence that anything was created.
        evaluateAsync: async (expression) => {
          calls.push(expression);
          if (expression.includes('list_alerts')) {
            return { alerts: [{ alert_id: 'a1', symbol: 'NASDAQ:AAPL' }] };
          }
          return { ok: true, symbol: 'NASDAQ:AAPL', message: 'Breakout', alert_id: 'a1' };
        },
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.condition, 'greater');
    assert.equal(result.condition_applied, true);
    assert.equal(result.mobile_push, true);
    assert.equal(result.verified, true, 'a fresh read must confirm the alert exists');
    assert.match(calls[0], /pricealerts\.tradingview\.com\/create_alert/);
  });

  it('rejects unsupported conditions before making a request', async () => {
    await assert.rejects(
      create({ condition: 'approximately', price: 500, _deps: { evaluateAsync: async () => {} } }),
      (error) => error.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});

describe('deleteById()', () => {
  // REWRITTEN 2026-08-20. The old contract — POST /delete_alert, then a GET
  // variant, then a DOM fallback — was fiction. Probed against the live API:
  //
  //   POST /delete_alert?alert_id=N                  no such endpoint
  //   POST /remove_alert?alert_id=N                  no such endpoint
  //   POST /modify_alert?alert_id=N                  no such endpoint
  //   POST /delete_alerts {payload:{alert_ids:[N]}}  {"s":"ok"}
  //
  // TradingView answers a missing endpoint with HTTP 200 and an error BODY, so
  // the old code read the 200, fell through to a DOM path that cannot delete a
  // single alert, and returned success:false for something the API does fine.
  //
  // Alert ids are numeric (e.g. 5418097596). Sent as a string the API returns a
  // bare {"s":"error"} with no message, so the numeric coercion is deliberate
  // and load-bearing — and it makes injection impossible by construction.

  it('rejects a missing alert_id', async () => {
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => deleteById({ alert_id: '', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('rejects a non-numeric alert_id instead of sending it', async () => {
    // The API cannot use it, so failing here beats a bare {"s":"error"} later.
    const { _deps } = emptyDeps();
    await assert.rejects(
      () => deleteById({ alert_id: 'aid_123', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT && /positive integer/i.test(err.message),
    );
  });

  it('an injection payload cannot reach the page — it is not a number', async () => {
    const { _deps, evaluate } = emptyDeps();
    await assert.rejects(
      () => deleteById({ alert_id: '1"; fetch("http://evil");//', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
    assert.equal(evaluate.calls.length, 0, 'nothing should be evaluated for a rejected id');
  });

  it('posts to the plural endpoint and verifies from a fresh list read', async () => {
    // THREE calls now, not two. A presence read comes FIRST, because the
    // endpoint accepts an id that never existed and the after-the-fact absence
    // check then passes trivially — measured live on 2026-08-20.
    const { _deps, evaluate } = scriptedDeps({}, [
      { alerts: [{ alert_id: 5418097596, symbol: 'X' }] },  // list() — target IS there
      { ok: true, status: 200 },                            // delete_alerts
      { alerts: [{ alert_id: 999, symbol: 'X' }] },         // list() — target gone
    ]);
    const result = await deleteById({ alert_id: '5418097596', _deps });
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.alert_id, '5418097596');
    const posted = evaluate.calls[1];
    assert.ok(posted.includes('delete_alerts'), 'must use the plural endpoint');
    assert.ok(posted.includes('5418097596'), 'the id must reach the request body');
    assert.ok(!posted.includes('"5418097596"'), 'the id must be a number, not a quoted string');
  });

  it('refuses to "delete" an alert that never existed', async () => {
    // Measured live: the endpoint returns ok for any id, and "it is not in the
    // list afterwards" is trivially true for something that was never there.
    // success:true verified:true for a no-op is the same shape as the bug this
    // whole module was rewritten to remove.
    const { _deps } = scriptedDeps({}, [
      { alerts: [{ alert_id: 111, symbol: 'X' }] },   // list() — target absent
    ]);
    await assert.rejects(
      () => deleteById({ alert_id: '999999999999', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT && /never|exists/.test(err.message),
    );
  });

  it('SILENT-SUCCESS GUARD — API says ok but the alert is still listed', async () => {
    // This test used to assert only `verified === false` and let
    // `success === true` stand beside it. Two independent audits pointed at
    // this exact test: by accepting that pair it PERMITTED the defect it was
    // named after. A caller branching on success — the documented convention
    // everywhere in this codebase — saw a clean delete. The contract is now
    // that a survivor throws.
    const { _deps } = scriptedDeps({}, [
      { alerts: [{ alert_id: 5418097596, symbol: 'X' }] },   // present before
      { ok: true, status: 200 },
      { alerts: [{ alert_id: 5418097596, symbol: 'X' }] },   // still there
    ]);
    await assert.rejects(
      () => deleteById({ alert_id: '5418097596', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /still in the list/.test(err.message),
    );
  });

  it('throws a classified error when the API rejects the delete', async () => {
    const { _deps } = scriptedDeps({}, [
      { alerts: [{ alert_id: 5418097596, symbol: 'X' }] },   // present before
      { ok: false, status: 200, error: 'code=no_such_endpoint' },
    ]);
    await assert.rejects(
      () => deleteById({ alert_id: '5418097596', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED,
    );
  });
});
