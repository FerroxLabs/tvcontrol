import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchStudies, setInputs, toggleVisibility } from '../src/core/indicators.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

describe('indicator settings and visibility', () => {
  it('rejects search result limits outside the public contract before opening the dialog', async () => {
    let evaluated = false;
    for (const limit of [0, -1, 1.5, 101, 'many']) {
      await assert.rejects(
        searchStudies({
          query: 'RSI',
          limit,
          _deps: { evaluate: async () => { evaluated = true; }, wait: async () => {} },
        }),
        (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
      );
    }
    assert.equal(evaluated, false);
  });

  it('sets a non-empty input object on the requested study', async () => {
    let expression;
    const result = await setInputs({
      entity_id: 'study-1',
      inputs: { length: 50, source: 'close' },
      _deps: {
        evaluate: async (value) => {
          expression = value;
          return { updated_inputs: { length: 50, source: 'close' } };
        },
        wait: async () => {},
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.updated_inputs, { length: 50, source: 'close' });
    // The expression no longer inlines getStudyById("study-1"): a Pine study's
    // id is a reference that cannot be serialized, so the study is resolved in
    // the page. What still has to be true is that the ref reaches the page
    // escaped, and that it is the ref the caller asked for.
    assert.match(expression, /__tvResolveStudy\(chart, "study-1"\)/);
    assert.match(expression, /chart\.getStudyById\(hits\[0\]\.id\)/,
      'resolution must go through the live handle, never a serialized id');
  });

  it('accepts a JSON-encoded input object', async () => {
    const result = await setInputs({
      entity_id: 'study-1', inputs: '{"length":21}',
      _deps: { evaluate: async () => ({ updated_inputs: { length: 21 } }), wait: async () => {} },
    });
    assert.equal(result.updated_inputs.length, 21);
  });

  it('rejects malformed or empty inputs as invalid_argument', async () => {
    for (const inputs of ['{bad json', {}, null]) {
      await assert.rejects(
        setInputs({ entity_id: 'study-1', inputs, _deps: { evaluate: async () => {}, wait: async () => {} } }),
        (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
      );
    }
  });

  it('classifies a missing study while setting inputs', async () => {
    await assert.rejects(
      setInputs({
        entity_id: 'missing', inputs: { length: 20 },
        _deps: { evaluate: async () => ({ error: 'Study not found: missing' }), wait: async () => {} },
      }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.STUDY_NOT_FOUND,
    );
  });

  it('toggles visibility and returns the observed value', async () => {
    // The observed value now comes back alongside what it WAS, so a caller can
    // tell "already hidden, nothing to do" from "I hid it". setVisible() is a
    // request; isVisible() is the answer.
    const result = await toggleVisibility({
      entity_id: 'study-1', visible: false,
      _deps: { evaluate: async () => ({ visible: false, was: true, wanted: false }), wait: async () => {} },
    });
    assert.equal(result.success, true);
    assert.equal(result.entity_id, 'study-1');
    assert.equal(result.visible, false);
    assert.equal(result.was, true);
    assert.equal(result.changed, true);
    assert.equal(result.verified, true);
  });

  it('flips the current state when visible is omitted', async () => {
    // Named toggleVisibility, it used to demand an explicit boolean, so the
    // most obvious call failed with an argument error.
    const result = await toggleVisibility({
      entity_id: 'study-1',
      _deps: { evaluate: async () => ({ visible: true, was: false, wanted: true }), wait: async () => {} },
    });
    assert.equal(result.success, true);
    assert.equal(result.changed, true);
  });

  it('requires a boolean visibility value when one is given', async () => {
    await assert.rejects(
      toggleVisibility({ entity_id: 'study-1', visible: 'false', _deps: { evaluate: async () => {}, wait: async () => {} } }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('classifies a missing study while toggling visibility', async () => {
    await assert.rejects(
      toggleVisibility({
        entity_id: 'missing', visible: true,
        _deps: { evaluate: async () => ({ error: 'Study not found: missing' }), wait: async () => {} },
      }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.STUDY_NOT_FOUND,
    );
  });
});
