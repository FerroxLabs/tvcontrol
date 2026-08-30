/**
 * watchlist_create exists because neither watchlist_import nor
 * watchlist_add_bulk can MAKE a list - both write into whichever list is
 * already active. Without a create, a first-run setup can only borrow a list
 * the user already had, which is precisely how a "fresh install" test ends up
 * riding on the tester's own account and proving nothing.
 *
 * The guards below are the ones that failure mode demands: a 200 that is not a
 * watchlist must not read as success, and a duplicate name must not be created
 * silently - two lists called `RebelUOS` on this account already produced one
 * real misdiagnosis.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createList } from '../src/core/watchlist.js';
import { CATEGORIES } from '../src/errors.js';

function deps(...responses) {
  let i = 0;
  const evaluate = async () => responses[i++];
  return { evaluate, evaluateAsync: evaluate };
}
const collection = (lists) => ({ ok: true, lists });
const L = (id, name, count = 3) => ({ id, name, count, sections: 0 });

describe('createList()', () => {
  it('creates the list and confirms it by re-reading the account', async () => {
    const _deps = deps(
      collection([L(1, 'Existing')]),                                   // duplicate-name check
      { ok: true, status: 200, id: 77, name: 'TC-TIDE', symbols: ['NASDAQ:AAPL', 'NYSE:GE'] },
      collection([L(1, 'Existing'), L(77, 'TC-TIDE', 2)]),              // read-back
    );
    const r = await createList({ name: 'TC-TIDE', symbols: ['NASDAQ:AAPL', 'NYSE:GE'], _deps });
    assert.equal(r.success, true);
    assert.equal(r.id, 77);
    assert.equal(r.stored, 2);
    assert.equal(r.confirmed_in_account, true,
      'the create response describing itself is not evidence; the account listing it is');
  });

  it('refuses a duplicate name rather than making a list nobody can tell apart', async () => {
    const _deps = deps(collection([L(9, 'TC-TIDE', 74)]));
    await assert.rejects(
      () => createList({ name: 'TC-TIDE', symbols: [], _deps }),
      (e) => {
        assert.equal(e.category, CATEGORIES.INVALID_ARGUMENT);
        assert.match(e.message, /already exists \(id 9/);
        assert.match(e.hint, /allow_duplicate_name/);
        return true;
      },
    );
  });

  it('creates anyway when the caller explicitly opts in', async () => {
    const _deps = deps(
      { ok: true, status: 200, id: 12, name: 'TC-TIDE', symbols: [] },
      collection([L(12, 'TC-TIDE', 0)]),
    );
    const r = await createList({ name: 'TC-TIDE', allow_duplicate_name: true, _deps });
    assert.equal(r.id, 12);
  });

  it('treats a 200 carrying no id as a failure, not an empty watchlist', async () => {
    const _deps = deps(
      collection([]),
      { ok: true, status: 200, raw: '{"s":"error"}' },
    );
    await assert.rejects(
      () => createList({ name: 'X', _deps }),
      (e) => {
        assert.equal(e.category, CATEGORIES.API_UNEXPECTED);
        assert.match(e.message, /no watchlist id/);
        return true;
      },
    );
  });

  it('reports symbols the server did not store instead of claiming them', async () => {
    const _deps = deps(
      collection([]),
      { ok: true, status: 200, id: 5, name: 'X', symbols: ['NASDAQ:AAPL'] },
      collection([L(5, 'X', 1)]),
    );
    const r = await createList({ name: 'X', symbols: ['NASDAQ:AAPL', 'NYSE:NOPE'], _deps });
    assert.deepEqual(r.missing, ['NYSE:NOPE']);
    assert.equal(r.requested, 2);
    assert.equal(r.stored, 1);
  });

  it('refuses an empty name', async () => {
    await assert.rejects(
      () => createList({ name: '   ', _deps: deps() }),
      (e) => e.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});
