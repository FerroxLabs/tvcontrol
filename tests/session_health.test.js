/**
 * THE BUG THAT COST A LAYOUT.
 *
 * One pane sits in a reconnect loop forever while the rest of the layout is
 * fine, and nothing the operator does from the UI fixes it. Diagnosed live on
 * 2026-08-21 by instrumenting the chart session:
 *
 *     14ms   connect
 *     14ms   _sendCreateSession   sid=cs_xm4Yn7i7Qkxa   state=1
 *     108ms  _onCriticalError     "Invalid parameters"
 *            method: create_study   args: [[], st4, sds_18, Script@tv-scripting-101!, ...]
 *
 * A study whose id never registered with the server reads as [], the chart
 * replays create_study with it on every reconnect, and the server kills the
 * session as a critical error. The pane cannot self-heal because
 * symbolSameAsResolved() returns true while symbolInfo() is null, so
 * re-setting the same symbol is a silent no-op.
 *
 * These tests run against a fake TradingView whose ids have the real shapes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inspect, repair, isPoisonedId } from '../src/core/session_health.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';

/**
 * Fake chart collection. `id: null` on a study means "never registered",
 * which is what the real page reports as an empty Array.
 */
function mockCharts(panes) {
  const state = panes.map((p) => ({
    sessionId: p.sessionId === undefined ? 'cs_ok' : p.sessionId,
    state: p.state === undefined ? 2 : p.state,
    connected: p.connected === undefined ? true : p.connected,
    symbol: p.symbol || 'BINANCE:BTCUSDT',
    resolved: p.resolved === undefined ? true : p.resolved,
    studies: (p.studies || []).map((s) => ({ ...s })),
    removeFails: !!p.removeFails,
    connectFails: !!p.connectFails,
  }));
  const calls = { removed: [], connected: [] };

  const evaluate = async (expr) => {
    if (expr.includes('out.panes.push(p)') || expr.includes('var out = { panes: [], socket: {} }')) {
      return {
        socket: { connected: true, disconnect_count: 0, connections_limit_reached: false },
        panes: state.map((p, i) => ({
          index: i,
          session_id: p.sessionId,
          session_state: p.state,
          session_connected: p.connected,
          symbol: p.symbol,
          resolution: '30',
          symbol_resolved: p.resolved,
          series_status: p.resolved ? 3 : 2,
          studies: p.studies
            // the page-side filter drops TradingView's own event sources
            .filter((s) => !String(s.sourceId || '').startsWith('ESD$'))
            .map((s) => ({ name: s.name, id: s.id ?? null, pine: !!s.pine, script_id: s.scriptId || null })),
        })),
      };
    }
    if (expr.includes('mm.removeSource(found)')) {
      // EXECUTE THE REAL EXPRESSION, do not reimplement it.
      //
      // The first version of this mock pattern-matched the expression and
      // applied its own removal logic. Mutation testing showed the two guards
      // that actually matter, "only remove a study with no id" and "never
      // touch TradingView's own event sources", could both be deleted from the
      // source without a single test failing, because no test ever ran them.
      // They live inside the page expression, so the page is where they have
      // to be exercised.
      const build = (p, idx) => ({
        model: () => ({
          model: () => {
            const mm = {
              dataSources: () => p.studies.map((st) => ({
                metaInfo: () => ({ description: st.name, id: st.scriptId || `${st.name}@tv-basicstudies` }),
                id: () => (st.sourceId !== undefined ? st.sourceId : (st.id === null ? [] : st.id)),
                __st: st,
              })),
              removeSource: (src) => {
                if (p.removeFails) throw new Error('nope');
                const at = p.studies.indexOf(src.__st);
                if (at >= 0) { p.studies.splice(at, 1); calls.removed.push({ pane: idx, name: src.__st.name }); }
              },
            };
            return mm;
          },
        }),
      });
      const window = {
        TradingViewApi: { _chartWidgetCollection: { getAll: () => state.map((p, i) => build(p, i)) } },
      };
      return new Function('window', `return (${expr});`)(window);
    }

    if (expr.includes('cs.connect()')) {
      const m = /getAll\(\)\[(\d+)\]/.exec(expr);
      const idx = m ? Number(m[1]) : 0;
      calls.connected.push(idx);
      const p = state[idx];
      if (!p.connectFails && !p.studies.some((s) => isPoisonedId(s.id))) {
        p.sessionId = 'cs_healed'; p.state = 2; p.connected = true; p.resolved = true;
      }
      return true;
    }
    return undefined;
  };

  return { _deps: { evaluate, evaluateAsync: evaluate, wait: async () => {} }, state, calls };
}

const HEALTHY = [{ studies: [{ name: 'Volume', id: 'T4x6LH' }, { name: 'TC-RTA V6', id: 'Uqd28X', pine: true }] }];
const POISONED = [{
  sessionId: '', state: 0, connected: false, resolved: false,
  studies: [{ name: 'Volume', id: '363Hwd' }, { name: 'TC-RTA V6', id: null, pine: true }],
}];

describe('isPoisonedId()', () => {
  it('accepts only a non-empty string', () => {
    assert.equal(isPoisonedId('Uqd28X'), false);
    assert.equal(isPoisonedId(null), true, 'the page reports an unregistered study as []');
    assert.equal(isPoisonedId(''), true);
    assert.equal(isPoisonedId(undefined), true);
    assert.equal(isPoisonedId([]), true);
    assert.equal(isPoisonedId(0), true);
  });
});

describe('tv_chart_health finds the pane that cannot fix itself', () => {
  it('calls a healthy layout healthy and offers no advice', async () => {
    const page = mockCharts(HEALTHY);
    const r = await inspect({ _deps: page._deps });
    assert.equal(r.healthy, true);
    assert.deepEqual(r.problems, []);
    assert.equal(r.advice, undefined);
    assert.equal(r.panes[0].poisoned_studies.length, 0);
  });

  it('names the study that kills the session, and says that is what it does', async () => {
    const page = mockCharts(POISONED);
    const r = await inspect({ _deps: page._deps });
    assert.equal(r.healthy, false);
    assert.deepEqual(r.panes[0].poisoned_studies, ['TC-RTA V6']);
    const joined = r.problems.join(' ');
    assert.match(joined, /TC-RTA V6/);
    assert.match(joined, /kills this pane's chart session every time it reconnects/);
    assert.match(joined, /no live chart session/);
    assert.match(r.advice, /tv_repair_chart/);
    assert.match(r.advice, /Rebuilding the layout is not necessary/);
  });

  it('reports only the broken pane when its neighbour is fine', async () => {
    const page = mockCharts([...HEALTHY, ...POISONED]);
    const r = await inspect({ _deps: page._deps });
    assert.equal(r.panes[0].healthy, true);
    assert.equal(r.panes[1].healthy, false);
    assert.ok(r.problems.every((t) => t.startsWith('pane 1:')));
  });

  it('throws rather than guessing when the page returns nothing', async () => {
    const _deps = { evaluate: async () => undefined, evaluateAsync: async () => undefined, wait: async () => {} };
    await assert.rejects(() => inspect({ _deps }), /returned nothing usable/);
  });
});

describe('tv_repair_chart', () => {
  it('refuses to touch a healthy layout', async () => {
    const page = mockCharts(HEALTHY);
    const r = await repair({ _deps: page._deps });
    assert.equal(r.action, 'nothing_to_repair');
    assert.deepEqual(page.calls.removed, []);
    assert.deepEqual(page.calls.connected, []);
  });

  it('dry_run reports the plan and changes nothing', async () => {
    const page = mockCharts(POISONED);
    const r = await repair({ dry_run: true, _deps: page._deps });
    assert.equal(r.action, 'dry_run');
    assert.deepEqual(r.plan, [{ pane: 0, remove: ['TC-RTA V6'] }]);
    assert.deepEqual(page.calls.removed, []);
    assert.deepEqual(page.calls.connected, []);
    assert.equal(page.state[0].studies.length, 2, 'nothing was removed');
  });

  it('removes the poisoned study, reconnects, and comes back healthy', async () => {
    const page = mockCharts(POISONED);
    const r = await repair({ _deps: page._deps });
    assert.equal(r.action, 'repaired');
    assert.deepEqual(r.removed_studies, ['TC-RTA V6']);
    assert.equal(r.healthy, true);
    assert.deepEqual(page.calls.connected, [0]);
    assert.equal(page.state[0].sessionId, 'cs_healed');
  });

  it('removes ONLY the poisoned copy when a healthy study shares its name', async () => {
    // This happens for real: restore adds a second copy of an indicator that is
    // already on the chart. Removing the working one would be the worse bug.
    const page = mockCharts([{
      sessionId: '', state: 0, connected: false, resolved: false,
      studies: [
        { name: 'TC-RTA V6', id: '690mk1', pine: true },
        { name: 'TC-RTA V6', id: null, pine: true },
        { name: 'Volume', id: '363Hwd' },
      ],
    }]);
    const r = await repair({ _deps: page._deps });
    assert.equal(r.healthy, true);
    const left = page.state[0].studies.map((s) => `${s.name}=${s.id}`);
    assert.deepEqual(left, ['TC-RTA V6=690mk1', 'Volume=363Hwd']);
  });

  it('never offers TradingView\'s own event sources for removal', async () => {
    // Dividends / Splits / Earnings / roll dates hang off every chart. A repair
    // tool must not be able to delete them, and must not depend on them always
    // having valid ids to be safe.
    const page = mockCharts([{
      sessionId: '', state: 0, connected: false, resolved: false,
      studies: [
        // These have NO usable id either, which is the case that actually
        // needs the deny-list: with an id present, the "skip anything already
        // registered" check would protect them and this test would prove
        // nothing. TradingView attaches these to every chart and they must
        // survive a repair regardless of what state their id is in.
        { name: 'Dividends', id: null, scriptId: 'Dividends@tv-basicstudies' },
        { name: 'Earnings', id: null, scriptId: 'Earnings@tv-basicstudies' },
        { name: 'RollDatesCalculator', id: null, scriptId: 'BarSetContinuousRollDates@tv-corestudies' },
        { name: 'TC-RTA V6', id: null, pine: true },
      ],
    }]);
    const r = await repair({ _deps: page._deps });
    assert.deepEqual(r.removed_studies, ['TC-RTA V6']);
    assert.ok(page.state[0].studies.some((s) => s.name === 'Dividends'), 'Dividends must survive');
    assert.ok(page.state[0].studies.some((s) => s.name === 'Earnings'), 'Earnings must survive');
    assert.ok(page.state[0].studies.some((s) => s.name === 'RollDatesCalculator'), 'roll dates must survive');
    assert.deepEqual(page.calls.removed.map((x) => x.name), ['TC-RTA V6'],
      'the repair must have removed exactly one thing');
  });

  it('tells the operator what it removed and how to put it back', async () => {
    const page = mockCharts(POISONED);
    const r = await repair({ _deps: page._deps });
    assert.match(r.re_add_hint, /indicator_add_from_search/);
    assert.match(r.re_add_hint, /Do NOT use state_restore/,
      'the restore path is what created the broken study');
  });

  it('says so when the studies are gone but the session still will not come back', async () => {
    const page = mockCharts([{ ...POISONED[0], connectFails: true }]);
    const r = await repair({ _deps: page._deps });
    assert.equal(r.healthy, false);
    assert.ok(Array.isArray(r.still_broken) && r.still_broken.length === 1);
    assert.match(r.note, /tv_health_check/);
  });

  it('reports a study it could not remove rather than claiming a repair', async () => {
    const page = mockCharts([{ ...POISONED[0], removeFails: true }]);
    const r = await repair({ _deps: page._deps });
    assert.equal(r.removed[0].removed, false);
    assert.match(r.removed[0].reason, /removeSource threw/);
    assert.equal(r.healthy, false);
  });

  it('rejects a pane index that does not exist', async () => {
    const page = mockCharts(POISONED);
    await assert.rejects(
      () => repair({ pane: 9, _deps: page._deps }),
      (err) => err instanceof ClassifiedError && err.category === CATEGORIES.INVALID_ARGUMENT,
    );
  });

  it('repairs only the pane it was asked to', async () => {
    const page = mockCharts([POISONED[0], POISONED[0]]);
    const r = await repair({ pane: 1, _deps: page._deps });
    assert.deepEqual(page.calls.removed.map((x) => x.pane), [1]);
    assert.deepEqual(page.calls.connected, [1]);
    assert.equal(r.removed.every((x) => x.pane === 1), true);
  });
});
