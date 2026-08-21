/**
 * state_snapshot recorded a HARDCODED layout code of 's'.
 *
 * Every snapshot ever taken claimed a single-chart layout regardless of the
 * real one, while pane_count correctly said 2, 3 or 4. state_restore then
 * applied setLayout('s'), COLLAPSED the operator's multi-pane layout, and
 * listed "layout" in applied[] as though it had succeeded.
 *
 * Measured live on 2026-08-21: snapshotting a 2-pane chart produced
 * { code: 's', pane_count: 2 } — a payload that contradicts itself — and
 * restoring it destroyed the layout.
 *
 * Second, related defect: pane.list() draws layout from cwc._layoutType,
 * chart_count from cwc.inlineChartsCount, and panes from cwc.getAll(). The
 * first two go stale. A live 2-pane layout reported layout "s" with
 * inlineChartsCount 1 while getAll() returned two widgets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { list as paneList } from '../src/core/pane.js';

const stateSrc = readFileSync(new URL('../src/core/state.js', import.meta.url), 'utf-8');

const paneDeps = (payload) => ({ _deps: { evaluate: async () => payload } });

describe('pane_list authority', () => {
  it('reports the number of chart widgets that actually exist, not the stale count', async () => {
    const { _deps } = paneDeps({
      layout: 's', chart_count: 1, real_pane_count: 2, active_index: 0,
      panes: [{ index: 0, symbol: 'A', active: true }, { index: 1, symbol: 'B', active: false }],
    });
    const r = await paneList({ _deps });
    assert.equal(r.chart_count, 2, 'getAll() is the only source describing what is on screen');
    assert.equal(r.reported_chart_count, 1, 'the stale figure is still surfaced, but not as the answer');
  });

  it('flags the layout code as unreliable when it contradicts the pane count', async () => {
    const { _deps } = paneDeps({
      layout: 's', chart_count: 1, real_pane_count: 2, active_index: 0,
      panes: [{ index: 0, symbol: 'A' }, { index: 1, symbol: 'B' }],
    });
    const r = await paneList({ _deps });
    assert.equal(r.layout_code_reliable, false);
    assert.match(r.layout_warning, /stale/);
    assert.match(r.layout_warning, /pane_set_layout/, 'the warning must name the call that would destroy the layout');
  });

  it('says the code IS reliable when everything agrees', async () => {
    const { _deps } = paneDeps({
      layout: '2h', chart_count: 2, real_pane_count: 2, active_index: 0,
      panes: [{ index: 0, symbol: 'A' }, { index: 1, symbol: 'B' }],
    });
    const r = await paneList({ _deps });
    assert.equal(r.layout_code_reliable, true);
    assert.equal(r.layout_warning, undefined);
    assert.equal(r.chart_count, 2);
  });
});

describe('state_snapshot layout capture', () => {
  it('does not hardcode the layout code', () => {
    // The literal that caused it: `code: 's',`
    assert.ok(!/layout:\s*\{\s*\n\s*code:\s*'s'\s*,/.test(stateSrc),
      "the snapshot is hardcoding code:'s' again, so every multi-pane snapshot lies about the layout");
    assert.match(stateSrc, /paneLayout && paneLayout\.reliable \? paneLayout\.code : null/,
      'the snapshot must take the real code, and only when it can be trusted');
  });
});

describe('state_restore layout safety', () => {
  it('refuses a single-chart code that contradicts a multi-pane count', () => {
    assert.match(stateSrc, /SINGLE_CODES/,
      'restore will replay a contradictory "s" code and collapse the layout again');
    const i = stateSrc.indexOf('SINGLE_CODES');
    const block = stateSrc.slice(i, i + 1200);
    assert.match(block, /skipped\.push/,
      'a contradictory code must be skipped and explained, not applied');
  });

  it('confirms the applied layout from a fresh read before claiming success', () => {
    const i = stateSrc.indexOf('SINGLE_CODES');
    const block = stateSrc.slice(i, i + 2000);
    assert.match(block, /after\.chart_count === snap\.layout\.pane_count/,
      'setLayout reports on itself; only a re-read proves the pane count landed');
    assert.match(block, /applied\.push\('layout'\)/);
  });
});
