/**
 * layout_switch reported success without switching.
 *
 * loadChartFromServer() is fire-and-forget: the in-page promise resolves the
 * instant it is called, long before any chart loads. The function returned
 * { success: true, action: 'switched' } off the back of that.
 *
 * MEASURED 2026-08-21 on a live account with 451 saved layouts: switching a
 * 2-pane BINANCE:BTCUSDT chart to "MarketOverview" (ES1! 1D) returned
 * success:true TWICE while the chart never moved. On this build the call does
 * nothing at all, and the tool had been papering over that since it was written.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/ui.js', import.meta.url), 'utf-8');
const tools = readFileSync(new URL('../src/tools/ui.js', import.meta.url), 'utf-8');

const body = (() => {
  const start = core.indexOf('export async function layoutSwitch(');
  assert.ok(start !== -1, 'layoutSwitch was renamed or removed');
  const next = core.indexOf('\nexport ', start + 10);
  const raw = core.slice(start, next === -1 ? undefined : next);
  return raw.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*');
  }).join('\n');
})();

describe('layout_switch verification', () => {
  it('captures the chart state before switching', () => {
    assert.match(body, /beforeState/,
      'without a before state there is nothing to compare against, so a no-op is indistinguishable from a switch');
  });

  it('polls for the chart to actually change', () => {
    assert.match(body, /moved/,
      'loadChartFromServer resolves immediately; only the chart changing is evidence');
    assert.match(body, /afterState\.symbol !== beforeState\.symbol/,
      'the comparison must be against the real chart, not the API response');
  });

  it('THROWS when the chart never moved, instead of reporting a switch', () => {
    assert.match(body, /if \(!moved\)[\s\S]*?throw new ClassifiedError/,
      'a switch that did not happen must not return success');
    assert.ok(!/return \{ success: true, layout: result\.name \|\| name, layout_id: result\.id, source: result\.source, action: 'switched', unsaved_changes_discarded: dismissed \};/.test(body),
      'the unconditional success return is back');
  });


  it('reads the BEFORE state before firing the switch, not after', () => {
    // Found independently by two external audits. beforeState used to be read
    // AFTER the evaluateAsync that calls loadChartFromServer, which inverts the
    // check: a fast cached switch completes in the gap so before === after, and
    // a read taken during the teardown the switch just triggered returns null.
    // Either way `moved` can never become true and a SUCCESSFUL switch throws
    // "chart never changed", after which the caller retries and fires a second
    // switch. The verification could only fail successes, never catch one.
    const baselineAt = body.indexOf('const beforeState = await evaluate(');
    const fireAt = body.indexOf('loadChartFromServer');
    assert.ok(baselineAt !== -1, 'the baseline read is gone');
    assert.ok(fireAt !== -1, 'the switch call is gone');
    assert.ok(baselineAt < fireAt,
      'beforeState must be captured BEFORE loadChartFromServer is fired, or the check is inverted');
  });

  it('passes the saved-chart ENTRY to loadChart, never a bare id', () => {
    // TradingView Desktop 3.3.0: loadChartFromServer(id) is a shim reading
    //   async loadChartFromServer(e){ await (this._loadChartService?.loadChart(e,!1)) }
    // and loadChart builds its route from `entry.url` and passes the whole
    // object to backend.loadLayout(entry). Handing it a number makes
    // entry.url undefined, so it navigates to /chart/undefined/ and the chart
    // never moves - no throw, no rejection, just silence. That shipped for
    // three releases as "called but the chart never changed".
    assert.match(body, /svc\.loadChart\(match,/,
      'the switch must pass the resolved saved-chart entry, not an id');
    assert.ok(!/loadChartFromServer\(target\)/.test(body),
      'the bare-id call is back - that is the silent no-op on TV 3.3.0');
  });

  it('resolves a numeric id through the saved-chart list', () => {
    assert.match(body, /if \(\/\^\\\\d\+\$\/\.test\(target\)\)[\s\S]{0,400}String\(charts\[i\]\.id\) === target/,
      'an id must be looked up in the chart list so the entry object can be passed');
    assert.match(body, /No saved layout has id/,
      'an id with no matching layout must say so rather than falling through to a name search');
    // NOTE: these are source-contract assertions. They catch a deleted or
    // rewritten lookup, but they cannot catch every logic mutation (prefixing
    // the comparison with `false &&` leaves the asserted text intact). The
    // behavioural guarantee is covered by the live switch, not by this file.
  });

  it('REFUSES an ambiguous partial name instead of guessing', () => {
    // "TCTide" substring-matches "TCTide Crypto". The old code took the first
    // hit, so a stocks scan could silently run against the crypto book with no
    // error raised anywhere. A partial name may only resolve when it is unique.
    assert.match(body, /near\.length === 1/,
      'a partial name may only resolve when exactly one layout matches');
    assert.match(body, /ambiguous/,
      'multiple matches must be reported as ambiguous, not silently resolved');
    assert.ok(!/near\[0\][\s\S]{0,40}break/.test(body),
      'first-match-wins on a partial name is back');
  });

  it('classifies a bad layout name as the caller\'s error, not a TradingView UI change', () => {
    assert.match(body, /badArg \? CATEGORIES\.INVALID_ARGUMENT/,
      'an unknown or ambiguous name is a bad argument; telling the user to file a UI-change issue sends them chasing a bug that does not exist');
  });

  it('reports an unconfirmed switch rather than a failed one when there was no baseline', () => {
    assert.match(body, /if \(!beforeState\)[\s\S]*?verified: null/,
      'a missing baseline is unproven, not failed');
    assert.match(body, /NOT retried/,
      'the response must say why it did not retry');
  });
  it('does not discard unsaved chart work unless asked', () => {
    // It used to hunt every button for /open anyway|don't save|discard/i and
    // click it, deciding on the operator's behalf to bin their work.
    assert.match(body, /discard_unsaved/,
      'discarding must be opt-in');
    const i = tools.indexOf("server.tool('layout_switch'");
    assert.match(tools.slice(i, i + 1200), /discard_unsaved/,
      'the tool surface must expose the choice');
  });
});
