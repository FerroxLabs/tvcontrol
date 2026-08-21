/**
 * indicator_set_inputs reported success while changing nothing.
 *
 * The in-page loop only assigns where a study input's `id` equals a key you
 * passed. Study input ids are frequently NOT the friendly name — "in_0",
 * "length_1" — so a mismatch is the common case. On a mismatch updatedKeys
 * stayed {}, setInputValues() was still called, and the function returned
 * { success: true, updated_inputs: {} }. Caught live on 2026-08-21 asking an
 * RSI for length:21.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setInputs, toggleVisibility } from '../src/core/indicators.js';
import { CATEGORIES } from '../src/errors.js';

const depsFor = (payload) => ({ _deps: { evaluate: async () => payload } });

describe('indicator_set_inputs', () => {
  it('THROWS when no requested key matches an input, instead of reporting success', async () => {
    const { _deps } = depsFor({ updated_inputs: {}, available_ids: ['in_0', 'in_1'], after: {} });
    await assert.rejects(
      () => setInputs({ entity_id: 'abc', inputs: { length: 21 }, _deps }),
      (err) => {
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        assert.match(err.message, /nothing was changed/);
        return true;
      },
    );
  });

  it('names the ids the study actually has, so the caller can correct the call', async () => {
    const { _deps } = depsFor({ updated_inputs: {}, available_ids: ['in_0', 'length_1'], after: {} });
    await assert.rejects(
      () => setInputs({ entity_id: 'abc', inputs: { length: 21 }, _deps }),
      (err) => /in_0/.test(err.hint) && /length_1/.test(err.hint),
    );
  });

  it('reports a partial match rather than folding it into a flat success', async () => {
    const { _deps } = depsFor({ updated_inputs: { length: 21 }, available_ids: ['length', 'source'], after: { length: 21 } });
    const r = await setInputs({ entity_id: 'abc', inputs: { length: 21, bogus: 1 }, _deps });
    assert.equal(r.success, false, 'one requested input did not exist, so this was not clean');
    assert.deepEqual(r.not_found, ['bogus']);
  });

  it('reports a value the study silently changed', async () => {
    // setInputValues() is a request; getInputValues() is the answer. A study
    // that clamps 500 to 200 must not be reported as having taken 500.
    const { _deps } = depsFor({ updated_inputs: { length: 500 }, available_ids: ['length'], after: { length: 200 } });
    const r = await setInputs({ entity_id: 'abc', inputs: { length: 500 }, _deps });
    assert.equal(r.success, false);
    assert.equal(r.verified, false);
    assert.deepEqual(r.rejected_by_study, [{ id: 'length', requested: 500, actual: 200 }]);
  });

  it('is a clean success when everything applied and read back unchanged', async () => {
    const { _deps } = depsFor({ updated_inputs: { length: 21 }, available_ids: ['length'], after: { length: 21 } });
    const r = await setInputs({ entity_id: 'abc', inputs: { length: 21 }, _deps });
    assert.equal(r.success, true);
    assert.equal(r.verified, true);
  });
});

describe('indicator_toggle_visibility', () => {
  it('flips the current state when visible is omitted, as the name promises', async () => {
    // It demanded an explicit boolean, so "flip this study" failed with an
    // argument error on the most obvious call.
    const { _deps } = depsFor({ visible: true, was: false, wanted: true });
    const r = await toggleVisibility({ entity_id: 'abc', _deps });
    assert.equal(r.success, true);
    assert.equal(r.changed, true);
    assert.equal(r.visible, true);
  });

  it('THROWS when the study did not take the requested visibility', async () => {
    const { _deps } = depsFor({ visible: false, was: false, wanted: true });
    await assert.rejects(
      () => toggleVisibility({ entity_id: 'abc', visible: true, _deps }),
      (err) => err.category === CATEGORIES.API_UNEXPECTED && /still hidden/.test(err.message),
    );
  });

  it('still rejects a non-boolean visible', async () => {
    const { _deps } = depsFor({});
    await assert.rejects(
      () => toggleVisibility({ entity_id: 'abc', visible: 'yes', _deps }),
      (err) => err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });
});
