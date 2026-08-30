import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addStudyFromSearch, searchStudies } from '../src/core/indicators.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

// chartReady defaults true so these fixtures keep testing what they were written
// to test - result parsing and study selection. The gate that depends on it has
// its own test below, where chartReady is false.
function deps(sequence, { chartReady = true } = {}) {
  const calls = [];
  let index = 0;
  return {
    _deps: {
      evaluate: async (expression) => {
        calls.push(expression);
        return sequence[index++];
      },
      wait: async () => {},
      waitForChartReady: async () => chartReady,
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

  // REPOINTED (not relaxed): addStudyFromSearch now proves the search surface answers before
  // it blames the study, so this fixture carries the six empty re-reads and the control query
  // that probe performs. The assertion is unchanged - a real absence is still study_not_found.
  it('classifies an absent result as study_not_found once the surface is shown to answer', async () => {
    const { _deps } = deps([
      [],
      'already',
      true,
      true,
      { error: 'No matching study found' },
      ...Array(7).fill({ open: true, results: [] }),
      true,
      { open: true, results: [{ title: 'Relative Strength Index', section: 'Technicals' }] },
      true,
    ]);
    await assert.rejects(
      addStudyFromSearch({ query: 'does-not-exist', _deps }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.STUDY_NOT_FOUND,
    );
  });

  // The buyer-path defect, 2026-08-30: 42s after TradingView was relaunched, a search for the
  // private study TC-TIDE returned `success: true, count: 0` on an account that owns it. The
  // skill read that as "not favourited" and sent the user away. An empty list and an unloaded
  // list are the same pixels; only a control query tells them apart.
  it('refuses to report an empty result when the control query is also empty', async () => {
    const { _deps } = deps([
      'clicked',
      true,
      true,
      ...Array(7).fill({ open: true, results: [] }),
      true,
      { open: true, results: [] },
      true,
    ]);
    await assert.rejects(
      searchStudies({ query: 'TC-TIDE', _deps }),
      (error) => error instanceof ClassifiedError
        && error.category === CATEGORIES.CHART_LOADING
        && /false absence/.test(error.message),
    );
  });

  it('reports an empty result only once the control query proves the list answers', async () => {
    const { _deps } = deps([
      'clicked',
      true,
      true,
      ...Array(7).fill({ open: true, results: [] }),
      true,
      { open: true, results: [
        { title: 'Relative Strength Index', section: 'Technicals' },
        { title: 'RSI Strategy', section: 'Community Scripts' },
      ] },
      true,
    ]);
    const result = await searchStudies({ query: 'no-such-study', _deps });
    assert.equal(result.count, 0);
    assert.equal(result.verified_empty, true);
    assert.equal(result.verified_by.control_count, 2);
  });

  it('does not run the control query when the search already matched', async () => {
    const { _deps, calls } = deps([
      'clicked',
      true,
      true,
      { open: true, results: [{ title: 'TC-TIDE', section: 'My scripts' }] },
      true,
    ]);
    const result = await searchStudies({ query: 'TC-TIDE', _deps });
    assert.equal(result.count, 1);
    assert.equal(result.verified_empty, undefined);
    assert.equal(calls.filter((c) => c.includes('RSI')).length, 0);
  });

  // MEASURED on a live run: seconds after layout_create, this returned
  // "TradingView accepted TC-TIDE but no new study appeared" - the click landed
  // on a chart that had no series to attach to. Nothing is created at this
  // point, so refusing is safe and a retry costs nothing.
  it('refuses to add a study to a chart that has no series yet', async () => {
    const { _deps, calls } = deps([], { chartReady: false });
    await assert.rejects(
      addStudyFromSearch({ query: 'TC-TIDE', _deps }),
      (error) => error instanceof ClassifiedError && error.category === CATEGORIES.CHART_LOADING,
    );
    assert.equal(calls.length, 0, 'it must refuse BEFORE touching the page');
  });
});
