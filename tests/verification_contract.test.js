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
import { create, deleteById, deleteAlerts } from '../src/core/alerts.js';
import { importFrom } from '../src/core/watchlist.js';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // as a successful removal, so a request that performed no POST at all still
    // returned success:true. NYSE:GE is genuinely absent here — not a bare
    // ticker that resolves to something stored, which is a separate case
    // covered below.
    const { _deps } = scriptedDeps({}, [
      LIST(['NASDAQ:AAPL']),
      LIST(['NASDAQ:AAPL']),
    ]);
    const r = await removeBulk({ symbols: ['NYSE:GE'], _deps });
    assert.equal(r.success, false, 'nothing was removed, so this is not a success');
    assert.equal(r.verified, false);
    assert.equal(r.removed_count, 0);
    assert.deepEqual(r.not_found, ['NYSE:GE']);
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

  it('names the listing it chose and the ones it passed over', async () => {
    // A ticker usually exists on several exchanges. Taking the top relevance
    // hit matches what TradingView's own autocomplete does; taking it SILENTLY
    // means the caller cannot tell NYSE:KO from a Frankfurt listing.
    const searchFetch = async () => ({
      ok: true,
      json: async () => ({ symbols: [
        { symbol: 'KO', exchange: 'NYSE', description: 'Coca-Cola' },
        { symbol: 'KO', exchange: 'FWB', description: 'Coca-Cola Frankfurt' },
      ] }),
    });
    const { _deps } = scriptedDeps({}, [LIST([]), POSTED, LIST(['NYSE:KO'])]);
    _deps.fetch = searchFetch;
    const r = await addBulk({ symbols: ['KO'], _deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.resolved, [{ from: 'KO', to: 'NYSE:KO', alternatives: ['FWB:KO'] }]);
  });

  it('the single-symbol add discloses the resolution too, not just the bulk one', async () => {
    // addBulk reported which listing it chose; add() dropped it. add() is the
    // path behind watchlist_add, which is what callers actually use.
    const { _deps } = scriptedDeps({}, [LIST([]), POSTED, LIST(['NYSE:KO'])]);
    _deps.fetch = async () => ({
      ok: true,
      json: async () => ({ symbols: [
        { symbol: 'KO', exchange: 'NYSE', description: 'Coca-Cola' },
        { symbol: 'KO', exchange: 'FWB', description: 'Frankfurt' },
      ] }),
    });
    const r = await add({ symbol: 'KO', _deps });
    assert.equal(r.symbol, 'NYSE:KO');
    assert.equal(r.resolved_from, 'KO');
    assert.deepEqual(r.alternatives, ['FWB:KO']);
  });

  it('an exchange-qualified symbol is passed through without a search call', async () => {
    let searched = false;
    const { _deps } = scriptedDeps({}, [LIST([]), POSTED, LIST(['NASDAQ:TSLA'])]);
    _deps.fetch = async () => { searched = true; return { ok: true, json: async () => ({ symbols: [] }) }; };
    const r = await addBulk({ symbols: ['NASDAQ:TSLA'], _deps });
    assert.equal(r.success, true);
    assert.equal(searched, false, 'a qualified symbol needs no resolution');
    assert.equal(r.resolved, undefined, 'nothing was resolved, so nothing is reported');
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

  it('remove accepts a bare ticker for a symbol that add stored exchange-prefixed', async () => {
    // ASYMMETRY BUG: add("KO") resolves and stores NYSE:KO. Without the same
    // courtesy on the way out, remove("KO") failed SYMBOL_UNKNOWN and you could
    // add something you could not remove with the same argument. The match here
    // is local, against the list just read — no symbol-search call.
    const { _deps, evaluate } = scriptedDeps({}, [
      LIST(['NYSE:KO', 'NASDAQ:MSFT']),
      POSTED,
      LIST(['NASDAQ:MSFT']),
    ]);
    const r = await removeBulk({ symbols: ['KO'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.removed_count, 1);
    const posted = evaluate.calls.find((c) => c.includes('remove'));
    assert.ok(posted.includes('NYSE:KO'), 'the stored form must be what gets removed');
  });

  it('an ambiguous bare ticker is refused rather than guessed', async () => {
    // Choosing one of two exchanges and deleting it is not recoverable.
    const { _deps } = scriptedDeps({}, [LIST(['NYSE:KO', 'LSE:KO'])]);
    await assert.rejects(
      () => removeBulk({ symbols: ['KO'], _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT && /more than one/.test(err.message),
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
  // `breakListAfter` exists because of a mutation test. The case named "the
  // verification read fails" originally broke EVERY list read, so it threw at
  // the pre-delete presence check and never reached the post-delete
  // verification at all. Reintroducing the original bug — treating a failed
  // post-delete read as proof of deletion — left every test passing.
  // A mock that fails only from the Nth read onward is what actually pins it.
  function alertDeps({ present, removeOnDelete = true, deleteOk = true, listBroken = false, breakListAfter = Infinity }) {
    let live = new Set(present.map(String));
    let listReads = 0;
    const calls = [];
    const evaluateAsync = async (expr) => {
      calls.push(expr);
      if (expr.includes('list_alerts')) {
        listReads += 1;
        if (listBroken || listReads > breakListAfter) return { alerts: [], error: 'session expired' };
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

  it('deleteById THROWS when it cannot read the list at all', async () => {
    const { _deps } = alertDeps({ present: [123], listBroken: true });
    await assert.rejects(
      () => deleteById({ alert_id: '123', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /cannot be verified|unconfirmed/.test(err.message),
    );
  });

  it('deleteById THROWS when the POST-DELETE verification read fails specifically', async () => {
    // THE ORIGINAL BUG, pinned precisely. list() returns
    // {success:false, alerts:[]} rather than throwing, so
    // `(after.alerts || []).some(...)` found nothing in an empty array and
    // concluded the alert was gone. An expired session was proof of deletion.
    //
    // The first read succeeds (the alert is there), the delete is accepted, and
    // only the confirming read fails — which is the exact shape of the defect
    // and the one a break-everything mock could never reach.
    const { _deps } = alertDeps({ present: [123], breakListAfter: 1 });
    await assert.rejects(
      () => deleteById({ alert_id: '123', _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /unconfirmed/.test(err.message),
    );
  });

  it('deleteAlerts THROWS when the post-delete verification read fails specifically', async () => {
    const { _deps } = alertDeps({ present: [1, 2], breakListAfter: 1 });
    await assert.rejects(
      () => deleteAlerts({ alert_ids: [1, 2], _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /unconfirmed/.test(err.message),
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
// alert creation: the frequency/resolution vocabulary, and the same verify rule
// ---------------------------------------------------------------------------

describe('alert_create frequency and resolution', () => {
  function createDeps({ ok = true, id = 777, listed = true } = {}) {
    const evaluateAsync = async (expr) => {
      if (expr.includes('list_alerts')) {
        return { alerts: listed ? [{ alert_id: id, symbol: 'X' }] : [] };
      }
      if (expr.includes('create_alert')) {
        return ok
          ? { ok: true, symbol: 'NASDAQ:AAPL', message: 'm', alert_id: id }
          : { ok: false, status: 200, error: 'invalid_request' };
      }
      return undefined;
    };
    return { _deps: { evaluateAsync, evaluate: evaluateAsync } };
  }

  // VERIFIED LIVE 2026-08-20: of seventeen plausible frequency strings the API
  // accepts exactly two. Guessing produced invalid_request every time, which is
  // an unhelpful thing to hand a caller when the real problem is a typo.
  for (const good of ['on_first_fire', 'on_bar_close']) {
    it(`accepts the ${good} frequency the API actually supports`, async () => {
      const { _deps } = createDeps();
      const r = await create({ condition: 'crossing', price: 100, frequency: good, _deps });
      assert.equal(r.success, true);
      assert.equal(r.frequency, good);
    });
  }

  for (const bad of ['once_per_bar', 'once_per_bar_close', 'once_per_minute', 'every_time']) {
    it(`refuses ${bad} up front rather than letting the API answer invalid_request`, async () => {
      const { _deps } = createDeps();
      await assert.rejects(
        () => create({ condition: 'crossing', price: 100, frequency: bad, _deps }),
        (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
      );
    });
  }

  it('accepts the resolution forms the API takes, and refuses the rest', async () => {
    for (const good of ['1', '15', '240', '1D', 'D', 'W', '1M']) {
      const { _deps } = createDeps();
      const r = await create({ condition: 'crossing', price: 100, resolution: good, _deps });
      assert.equal(r.resolution, good.toUpperCase(), `${good} should be accepted`);
    }
    const { _deps } = createDeps();
    await assert.rejects(
      () => create({ condition: 'crossing', price: 100, resolution: 'banana', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('does NOT throw when the confirmation read fails, because a retry would duplicate the alert', async () => {
    // Deliberate asymmetry with deleteById, which throws in the same situation.
    // The safe response to an unconfirmed DELETE is to look and try again. The
    // safe response to an unconfirmed CREATE is not to retry blind — the POST
    // already returned an id, so a retry makes a second alert.
    const evaluateAsync = async (expr) => {
      if (expr.includes('list_alerts')) return { alerts: [], error: 'session expired' };
      return { ok: true, symbol: 'NASDAQ:AAPL', message: 'm', alert_id: 777 };
    };
    const r = await create({ condition: 'crossing', price: 100, _deps: { evaluateAsync, evaluate: evaluateAsync } });
    assert.equal(r.success, true);
    assert.equal(r.verified, null, 'unconfirmed is not the same as confirmed');
    assert.match(r.verify_note, /duplicate/, 'the caller must be told why not to retry blind');
  });

  it('THROWS when the API accepts the alert but it is not in the list afterwards', async () => {
    // create() used to report success purely from its own POST response.
    const { _deps } = createDeps({ listed: false });
    await assert.rejects(
      () => create({ condition: 'crossing', price: 100, _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /does not appear/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// import replace mode: "replace" must replace the sections too
// ---------------------------------------------------------------------------

describe('importFrom replace mode and section headers', () => {
  it('removes an existing header that is not in the file, instead of leaving it and adding a duplicate', async () => {
    // The removal loop iterated current.symbols, which get() strips headers out
    // of, so replace left every existing header in place. The add loop then
    // worked from a header-free set and appended the incoming headers on top.
    // Replace produced DUPLICATE sections and reported them as restored.
    const file = join(tmpdir(), 'tvc-replace-headers.json');
    writeFileSync(file, JSON.stringify({
      schema_version: 2,
      exported_at: new Date().toISOString(),
      symbols: [{ symbol: 'NASDAQ:AAPL' }],
      entries: ['###KEEP', 'NASDAQ:AAPL'],
    }));

    const posts = [];
    let live = ['###KEEP', '###STALE', 'NASDAQ:AAPL'];
    const evaluateAsync = async (expr) => {
      if (expr.includes('active/')) return { ok: true, id: 7, name: 'T', symbols: [...live] };
      const m = expr.match(/'custom\/' \+ "7" \+ '\/' \+ "(append|remove)"/);
      const verb = m ? m[1] : (expr.includes("'remove'") || expr.includes('"remove"') ? 'remove' : 'append');
      const body = expr.match(/JSON\.stringify\((\[[^)]*\])\)\s*$/m);
      const syms = JSON.parse((expr.match(/body: JSON\.stringify\((\[.*?\])\)/) || [])[1] || '[]');
      posts.push({ verb, syms });
      if (verb === 'remove') live = live.filter((x) => !syms.includes(x));
      else for (const x of syms) if (!live.includes(x)) live.push(x);
      return { ok: true, status: 200 };
    };
    const _deps = { evaluate: evaluateAsync, evaluateAsync };

    const r = await importFrom({ file_path: file, mode: 'replace', _deps });
    const removedHeaders = posts.filter((p) => p.verb === 'remove').flatMap((p) => p.syms);
    const appendedHeaders = posts.filter((p) => p.verb === 'append').flatMap((p) => p.syms).filter((x) => String(x).startsWith('###'));

    assert.ok(removedHeaders.includes('###STALE'), 'a header absent from the file must be removed by a replace');
    assert.ok(!appendedHeaders.includes('###KEEP'), 'a header already present must not be appended again');
    assert.deepEqual(live.filter((x) => x === '###KEEP'), ['###KEEP'], 'exactly one KEEP header, not two');
    assert.equal(r.error_count, 0);
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
