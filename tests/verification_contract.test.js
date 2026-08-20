/**
 * BEHAVIOURAL tests for the verification contract.
 *
 * Two independent audits (Kimi K3, Codex 5.6) reviewed the 2.2.5 changes and
 * both reached the same verdict: do not ship. Both said the same thing about
 * the tests that existed at the time — `watchlist_api`, `alert_delete_endpoint`,
 * `pine_list_paging` and `field_naming` assert that certain STRINGS appear in
 * the source. They are anti-reversion tripwires and they are useful as that,
 * but every one of them passed while the bugs below were live.
 *
 * So this file asserts BEHAVIOUR, and specifically FAILURE behaviour: what a
 * tool does when the mutation is accepted and the follow-up read proves it did
 * not happen. That is the shape of every bug this project keeps finding, and
 * it is the shape a source-text test cannot see.
 *
 * Every test here was confirmed to FAIL against the pre-fix source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { add, addBulk, remove, removeBulk, get } from '../src/core/watchlist.js';
import { deleteById, deleteAlerts } from '../src/core/alerts.js';
import { listScripts } from '../src/core/pine.js';
import { CATEGORIES } from '../src/errors.js';
import { scriptedDeps } from './_helpers.js';

const LIST = (symbols, id = 42, name = 'Test') => ({ ok: true, id, name, symbols });
const POSTED = { ok: true, status: 200 };

// ---------------------------------------------------------------------------
// watchlist: an action that did not happen must never report success
// ---------------------------------------------------------------------------

describe('watchlist verification contract', () => {
  it('add() THROWS when the append is accepted but the symbol is not there afterwards', async () => {
    // The API returning 200 is the action reporting on itself. Only the second
    // read is evidence. Returning {success:false} here was not enough: the
    // caller in importFrom counted it as added.
    const { _deps } = scriptedDeps({}, [
      LIST(['NASDAQ:MSFT']),
      POSTED,
      LIST(['NASDAQ:MSFT']),
    ]);
    await assert.rejects(
      () => add({ symbol: 'NASDAQ:TSLA', _deps }),
      (err) => {
        assert.equal(err.category, CATEGORIES.API_UNEXPECTED);
        assert.match(err.message, /still not in/);
        return true;
      },
    );
  });

  it('remove() THROWS when the symbol survives the removal', async () => {
    const { _deps } = scriptedDeps({}, [
      LIST(['NASDAQ:AAPL']),
      POSTED,
      LIST(['NASDAQ:AAPL']),
    ]);
    await assert.rejects(
      () => remove({ symbol: 'NASDAQ:AAPL', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /still in/.test(err.message),
    );
  });

  it('removeBulk() does NOT call a symbol that was never present "removed"', async () => {
    // Old rule was `!was_present || removed`, which defines "it was not there"
    // as a successful removal. Asking to remove AAPL from a list holding
    // NASDAQ:AAPL performed no POST at all and returned success:true.
    const { _deps } = scriptedDeps({}, [
      LIST(['NASDAQ:AAPL']),
      LIST(['NASDAQ:AAPL']),
    ]);
    const r = await removeBulk({ symbols: ['AAPL'], _deps });
    assert.equal(r.success, false, 'nothing was removed, so this is not a success');
    assert.equal(r.verified, false);
    assert.equal(r.removed_count, 0);
    assert.deepEqual(r.not_found, ['AAPL']);
  });

  it('removeBulk() separates "never there" from "would not go"', async () => {
    const { _deps } = scriptedDeps({}, [
      LIST(['NASDAQ:AAPL', 'NASDAQ:MSFT']),
      POSTED,
      LIST(['NASDAQ:AAPL']),
    ]);
    const r = await removeBulk({ symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NYSE:GE'], _deps });
    assert.equal(r.success, false);
    assert.deepEqual(r.survived, ['NASDAQ:AAPL'], 'was there, still there');
    assert.deepEqual(r.not_found, ['NYSE:GE'], 'never there at all');
    assert.equal(r.removed_count, 1);
  });

  it('a whitespace-only symbol is rejected, not silently reported as success', async () => {
    // `["   "]` used to filter down to [], and `[].every(...)` is true, so the
    // tool reported success on a call that touched nothing.
    const { _deps } = scriptedDeps({}, [LIST([]), LIST([])]);
    await assert.rejects(
      () => addBulk({ symbols: ['   ', ''], _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('duplicate input is collapsed so added_count reflects rows, not requests', async () => {
    const { _deps, evaluate } = scriptedDeps({}, [
      LIST([]),
      POSTED,
      LIST(['NASDAQ:TSLA']),
    ]);
    const r = await addBulk({ symbols: ['NASDAQ:TSLA', 'NASDAQ:TSLA'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.added_count, 1, 'one row was created, so the count is one');
    const post = evaluate.calls.find((c) => c.includes('append'));
    assert.equal((post.match(/NASDAQ:TSLA/g) || []).length, 1, 'the symbol is posted once');
  });

  it('a bare ticker is resolved before it is posted, not stored verbatim', async () => {
    // MEASURED LIVE 2026-08-20: POST /append/ with ["KO"] stores the literal
    // string "KO". It does not resolve to "NYSE:KO". The old DOM path went
    // through TradingView's own autocomplete and always wrote the qualified
    // form; the REST rewrite lost that, and verification made it worse — the
    // read-back finds the exact string we posted, so a broken row verified
    // as a success.
    const searchFetch = async () => ({
      ok: true,
      json: async () => ({ symbols: [{ symbol: 'KO', exchange: 'NYSE', description: 'Coca-Cola' }] }),
    });
    const { _deps, evaluate } = scriptedDeps({}, [
      LIST([]),
      POSTED,
      LIST(['NYSE:KO']),
    ]);
    _deps.fetch = searchFetch;
    const r = await addBulk({ symbols: ['KO'], _deps });
    assert.equal(r.success, true);
    const posted = evaluate.calls.find((c) => c.includes('append'));
    assert.ok(posted.includes('NYSE:KO'), 'the resolved form must be what gets posted');
    assert.ok(!/\["KO"\]/.test(posted), 'the bare ticker must not reach the API');
  });

  it('a ticker that resolves to nothing is refused, not stored as a broken row', async () => {
    const searchFetch = async () => ({ ok: true, json: async () => ({ symbols: [] }) });
    const { _deps } = scriptedDeps({}, [LIST([])]);
    _deps.fetch = searchFetch;
    await assert.rejects(
      () => addBulk({ symbols: ['ZZQQXNOTREAL'], _deps }),
      (err) => err.category === CATEGORIES.SYMBOL_UNKNOWN,
    );
  });

  it('a 200 carrying an error body is not an empty watchlist', async () => {
    // {"s":"error"} has no id and no symbols array. Defaulting symbols to []
    // turned an expired session into a healthy, empty list.
    const { _deps } = scriptedDeps({}, [{ ok: true, s: 'error', raw_keys: ['s'] }]);
    await assert.rejects(
      () => get({ _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /not a watchlist/.test(err.message),
    );
  });

  it('switching the active watchlist mid-mutation is refused, not verified against the wrong list', async () => {
    // Verifying an add to list 42 by reading list 99 can succeed purely because
    // list 99 already held the symbol.
    const { _deps } = scriptedDeps({}, [
      LIST(['NASDAQ:MSFT'], 42, 'Alpha'),
      POSTED,
      LIST(['NASDAQ:TSLA'], 99, 'Beta'),
    ]);
    await assert.rejects(
      () => addBulk({ symbols: ['NASDAQ:TSLA'], _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /changed during/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// alerts: the same contract, on the path that deletes real money-relevant state
// ---------------------------------------------------------------------------

describe('alert deletion verification contract', () => {
  // A stateful mock, because deletion now reads the list TWICE: once to prove
  // the alert exists (an id that was never there cannot be deleted, however
  // convenient it is to count it as one) and once to prove it is gone. A
  // positional sequence cannot express "the same read, before and after".
  function alertDeps({ present, removeOnDelete = true, deleteOk = true, listBroken = false }) {
    let live = new Set(present.map(String));
    const calls = [];
    const evaluateAsync = async (expr) => {
      calls.push(expr);
      if (expr.includes('list_alerts')) {
        if (listBroken) return { alerts: [], error: 'session expired' };
        return { alerts: [...live].map((id) => ({ alert_id: Number(id), symbol: 'X' })) };
      }
      if (expr.includes('delete_alerts')) {
        if (deleteOk && removeOnDelete) {
          const posted = [...(expr.match(/alert_ids:\s*\[([^\]]*)\]/) || [])][1] || '';
          for (const raw of posted.split(',')) {
            const t = raw.trim();
            if (t) live.delete(t);
          }
        }
        return { ok: deleteOk, status: 200, error: deleteOk ? '' : 'nope' };
      }
      return undefined;
    };
    return { _deps: { evaluateAsync, evaluate: evaluateAsync }, calls };
  }

  it('deleteById THROWS when the alert is still in the list afterwards', async () => {
    // This returned success:true with verified:false. An agent branching on
    // success — which is the documented convention — saw a clean delete.
    const { _deps } = alertDeps({ present: [123], removeOnDelete: false });
    await assert.rejects(
      () => deleteById({ alert_id: '123', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /still in the list/.test(err.message),
    );
  });

  it('deleteById THROWS when the verification read itself fails', async () => {
    // list() returns {success:false, alerts:[]} rather than throwing when the
    // session has expired. `(after.alerts || []).some(...)` then found nothing
    // and concluded the alert was deleted. An expired session was proof.
    const { _deps } = alertDeps({ present: [123], listBroken: true });
    await assert.rejects(
      () => deleteById({ alert_id: '123', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /cannot be verified|unconfirmed/.test(err.message),
    );
  });

  it('deleteById succeeds only when a fresh read can no longer find the alert', async () => {
    const { _deps } = alertDeps({ present: [123, 456] });
    const r = await deleteById({ alert_id: '123', _deps });
    assert.equal(r.success, true);
    assert.equal(r.verified, true);
  });

  it('deleteById normalises the id once, so "00123" verifies against 123', async () => {
    const { _deps } = alertDeps({ present: [123, 456] });
    const r = await deleteById({ alert_id: '00123', _deps });
    assert.equal(r.success, true);
    assert.equal(r.verified, true, 'the request and the check must agree on spelling');
  });

  it('deleteById refuses an id that was never in the list', async () => {
    // MEASURED LIVE 2026-08-20: id 999999999999 returned success:true
    // verified:true. The endpoint accepts anything and the absence check is
    // trivially satisfied by something that never existed.
    const { _deps } = alertDeps({ present: [456] });
    await assert.rejects(
      () => deleteById({ alert_id: '999999999999', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('deleteAlerts counts what a fresh read proves, not what was requested', async () => {
    // deleted_count was ids.length — the number asked for. A partial success
    // in a batch reported every id deleted. Here 1 and 3 exist and go; 2 never
    // existed, so it is reported as not_found rather than counted as deleted.
    const { _deps } = alertDeps({ present: [1, 3] });
    const r = await deleteAlerts({ alert_ids: [1, 2, 3], _deps });
    assert.equal(r.requested_count, 3);
    assert.equal(r.deleted_count, 2, 'only the two that really existed and really went');
    assert.deepEqual(r.not_found, [2]);
    assert.equal(r.success, false, 'one requested id did not exist, so this batch was not clean');
  });

  it('deleteAlerts reports survivors when the API accepts but nothing moves', async () => {
    const { _deps } = alertDeps({ present: [1, 2], removeOnDelete: false });
    const r = await deleteAlerts({ alert_ids: [1, 2], _deps });
    assert.equal(r.success, false);
    assert.equal(r.deleted_count, 0);
    assert.deepEqual(r.survived, [1, 2]);
  });

  it('deleteAlerts rejects a non-numeric id instead of sending it and getting a bare error', async () => {
    const { _deps } = alertDeps({ present: [1] });
    await assert.rejects(
      () => deleteAlerts({ alert_ids: ['not-a-number'], _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});

// ---------------------------------------------------------------------------
// pine: an unreadable library is not an empty one
// ---------------------------------------------------------------------------

describe('pine_list_scripts failure contract', () => {
  it('a failed facade fetch throws instead of reporting an empty library', async () => {
    // Returning success:true, total:0 with the error in a side field tells
    // someone who owns 276 scripts that they own none.
    const { _deps } = scriptedDeps({ 'pine-facade': { scripts: [], error: 'Failed to fetch' } });
    await assert.rejects(
      () => listScripts({ _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /Could not list Pine scripts/.test(err.message),
    );
  });
});
