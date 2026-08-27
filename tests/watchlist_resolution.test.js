/**
 * Offline tests for the watchlist RESOLUTION surface added in 2.4.0:
 * list(), getById(), and the disputed-active-list signal.
 *
 * These exist because the failure they guard against is silent. A scan that resolves the
 * wrong watchlist produces a report that is internally consistent, correctly formatted, and
 * about the wrong market — there is nothing for a reader to notice. Every refusal below is
 * therefore a feature, not an inconvenience.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { list, getById } from '../src/core/watchlist.js';
import { CATEGORIES } from '../src/errors.js';

// The two calls getById makes, in order: the custom/ collection, then custom/<id>/.
function deps(...responses) {
  let i = 0;
  const evaluate = async () => responses[i++];
  return { evaluate, evaluateAsync: evaluate };
}
const collection = (lists) => ({ ok: true, lists });
const L = (id, name, count = 3) => ({ id, name, count, sections: 0 });

describe('list()', () => {
  it('reports duplicate names so a caller never resolves one by accident', async () => {
    const _deps = deps(collection([L(1, 'RebelUOS'), L(2, 'RebelUOS'), L(3, 'Unique')]));
    const r = await list({ _deps });
    assert.equal(r.count, 3);
    assert.deepEqual(r.duplicate_names, ['RebelUOS']);
  });

  it('counts names that collide with Object prototype keys', async () => {
    // A plain object literal silently loses this: `dupes['__proto__'] = 1` does not create
    // an own property, so two lists named __proto__ reported no duplicates at all and the
    // refusal below would never fire for them.
    const _deps = deps(collection([L(1, '__proto__'), L(2, '__proto__'), L(3, 'constructor')]));
    const r = await list({ _deps });
    assert.deepEqual(r.duplicate_names, ['__proto__']);
  });

  it('flags records with no id rather than returning something unselectable', async () => {
    const _deps = deps(collection([L(1, 'Good'), { id: null, name: 'Broken', count: 0, sections: 0 }]));
    const r = await list({ _deps });
    assert.equal(r.unusable_count, 1);
  });

  it('fails closed when the endpoint returns 200 carrying an error body', async () => {
    const _deps = deps({ ok: false, shape: ['s', 'errmsg'] });
    await assert.rejects(() => list({ _deps }), (e) => e.category === CATEGORIES.API_UNEXPECTED);
  });
});

describe('getById()', () => {
  it('resolves by id and returns membership without section headers', async () => {
    const _deps = deps(
      collection([L(342401475, 'TC-MASTER-WATCHLIST')]),
      { ok: true, id: 342401475, name: 'TC-MASTER-WATCHLIST', symbols: ['###HEADER', 'NASDAQ:SOUN', 'NYSE:IONQ'] },
    );
    const r = await getById({ name_or_id: '342401475', _deps });
    assert.equal(r.count, 2);
    assert.equal(r.resolved_by, 'id');
    assert.deepEqual(r.symbols.map((x) => x.symbol), ['NASDAQ:SOUN', 'NYSE:IONQ']);
    assert.deepEqual(r.sections, ['###HEADER']);
    assert.equal(r.entries.length, 3, 'entries keeps the stored list verbatim');
  });

  it('REFUSES a name that matches more than one list, and names both ids', async () => {
    const _deps = deps(collection([L(170009392, 'RebelUOS'), L(70348184, 'RebelUOS')]));
    await assert.rejects(
      () => getById({ name_or_id: 'RebelUOS', _deps }),
      (e) => e.category === CATEGORIES.INVALID_ARGUMENT
        && /170009392/.test(e.message) && /70348184/.test(e.message),
    );
  });

  it('falls back to a case-insensitive name match', async () => {
    const _deps = deps(
      collection([L(5, 'RebelUOS')]),
      { ok: true, id: 5, name: 'RebelUOS', symbols: ['BINANCE:BTCUSDT'] },
    );
    const r = await getById({ name_or_id: 'rebeluos', _deps });
    assert.equal(r.watchlist_id, 5);
  });

  it('prefers an EXACT name match over a case-insensitive one', async () => {
    const _deps = deps(
      collection([L(1, 'Core'), L(2, 'CORE')]),
      { ok: true, id: 1, name: 'Core', symbols: ['AMEX:SPY'] },
    );
    const r = await getById({ name_or_id: 'Core', _deps });
    assert.equal(r.watchlist_id, 1, 'the exactly-matching list wins outright');
  });

  it('REFUSES when the argument is one list\'s id and another list\'s name', async () => {
    const _deps = deps(collection([L(777, 'Alpha'), L(2, '777')]));
    await assert.rejects(
      () => getById({ name_or_id: '777', _deps }),
      (e) => e.category === CATEGORIES.INVALID_ARGUMENT && /both the id/.test(e.message),
    );
  });

  it('REFUSES when the server returns a different list than the one asked for', async () => {
    // A redirect, a cached body, or a server-side reinterpretation of the id would otherwise
    // hand back a different universe under the name the caller believes it selected.
    const _deps = deps(
      collection([L(100, 'Wanted')]),
      { ok: true, id: 999, name: 'Something Else', symbols: ['NASDAQ:AAPL'] },
    );
    await assert.rejects(
      () => getById({ name_or_id: '100', _deps }),
      (e) => e.category === CATEGORIES.API_UNEXPECTED && /returned 999/.test(e.message),
    );
  });

  it('requires an argument rather than defaulting to the active list', async () => {
    await assert.rejects(
      () => getById({ _deps: deps() }),
      (e) => e.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('names the available lists when nothing matches', async () => {
    const _deps = deps(collection([L(1, 'Alpha'), L(2, 'Beta')]));
    await assert.rejects(
      () => getById({ name_or_id: 'Gamma', _deps }),
      (e) => /Alpha \(1\)/.test(e.hint || '') && /Beta \(2\)/.test(e.hint || ''),
    );
  });
});
