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
    assert.match(body, /if \(!moved\)[\s\S]{0,400}throw/,
      'a switch that did not happen must not return success');
    assert.ok(!/return \{ success: true, layout: result\.name \|\| name, layout_id: result\.id, source: result\.source, action: 'switched', unsaved_changes_discarded: dismissed \};/.test(body),
      'the unconditional success return is back');
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
