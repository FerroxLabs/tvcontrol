import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addStudyFromSearch, searchStudies } from '../src/core/indicators.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

function deps(sequence) {
  const calls = [];
  let index = 0;
  return {
    _deps: {
      evaluate: async (expression) => {
        calls.push(expression);
        return sequence[index++];
      },
      wait: async () => {},
    },
    calls,
  };
}

describe('indicator dialog search', () => {
  it('returns bounded, section-labelled search results and closes the dialog', async () => {
    const { _deps, calls } = deps([
      'clicked',
      true,
      true,
      { open: true, results: [
        { title: 'Relative Strength Index', section: 'Technicals' },
        { title: 'RSI Strategy', section: 'Community Scripts' },
      ] },
      true,
    ]);
    const result = await searchStudies({ query: 'RSI', limit: 1, _deps });
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.results[0].section, 'Technicals');
    assert.ok(calls.at(-1).includes('close'));
  });

  it('adds the selected result and returns the new entity id', async () => {
    const { _deps } = deps([
      ['old-study'],
      'clicked',
      true,
      true,
      { clicked: 'VWAP', section: 'Technicals' },
      true,
      [{ id: 'old-study', name: 'Volume' }, { id: 'new-study', name: 'VWAP' }],
    ]);
    const result = await addStudyFromSearch({ query: 'VWAP', _deps });
    assert.equal(result.success, true);
    assert.equal(result.entity_id, 'new-study');
    assert.equal(result.added_from_search, 'VWAP');
  });

  it('classifies an absent result as study_not_found', async () => {
    const { _deps } = deps([
      [],
      'already',
      true,
      true,
      { error: 'No matching study found' },
      true,
    ]);
    await assert.rejects(
      addStudyFromSearch({ query: 'does-not-exist', _deps }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.STUDY_NOT_FOUND,
    );
  });
});
