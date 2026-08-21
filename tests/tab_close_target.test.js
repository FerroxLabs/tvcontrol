/**
 * tab_close destroyed a live chart tab during its own test on 2026-08-21.
 *
 * ROOT CAUSE, and it is a whole class of bug worth naming: switchTab and
 * closeTab do not share an index space. switchTab reasons about CHART TARGETS
 * (_list({ includeTargetIds: true })); closeTab acts on DOM
 * '.tabs-container .tab' elements. A "New tab" page occupies a strip slot and
 * owns no chart target, so the two disagree about which tab is Nth AND which
 * one is active. A switch that reported success had not moved the strip, and
 * closeTab then closed whatever really was active: the chart.
 *
 * closeTab also reported success purely from the tab COUNT dropping, which is
 * true no matter which tab died.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/tab.js', import.meta.url), 'utf-8');
const tools = readFileSync(new URL('../src/tools/tab.js', import.meta.url), 'utf-8');

const codeOf = (name) => {
  const start = core.indexOf(`export async function ${name}(`);
  assert.ok(start !== -1, `${name} was renamed or removed`);
  const next = core.indexOf('\nexport ', start + 10);
  const raw = core.slice(start, next === -1 ? undefined : next);
  // Strip comments: they describe the old behaviour by name, and a naive scan
  // would match the documentation instead of the code.
  return raw.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
};

describe('tab_close target safety', () => {
  it('reads the tab labels before closing, so the victim can be named', () => {
    assert.match(codeOf('closeTab'), /labels/,
      'closeTab cannot say which tab it destroyed');
  });

  it('refuses when no tab is marked active instead of closing an arbitrary one', () => {
    const c = codeOf('closeTab');
    assert.match(c, /active_index === -1[\s\S]{0,400}throw/,
      'an unidentifiable active tab must stop the close');
    assert.ok(!/\.tab'\)\[0\]/.test(c) && !/tab\)\[0\]/.test(c),
      'the fallback to the first tab is back; that closes a tab the operator may not be on');
  });

  it('does not report success from the tab count alone', () => {
    const c = codeOf('closeTab');
    assert.ok(!/success: after < before/.test(c),
      'a dropping count is true whichever tab died; it is not evidence the right one did');
    assert.match(c, /after\.count >= snapshot\.count[\s\S]{0,300}throw/,
      'a close that did not reduce the count must fail loudly');
  });

  it('lets the caller pin which tab may be closed', () => {
    assert.match(codeOf('closeTab'), /expect_title/,
      'there is no way to require that the right tab is the one closed');
    const i = tools.indexOf("server.tool('tab_close'");
    assert.ok(i !== -1);
    assert.match(tools.slice(i, i + 900), /expect_title/,
      'the tool surface does not expose the pin');
  });

  it('returns which tab it closed and what remains', () => {
    const c = codeOf('closeTab');
    assert.match(c, /closed: victim/);
    assert.match(c, /remaining:/);
  });
});

describe('tab_switch index-space honesty', () => {
  it('reports the tab strip its own view of what is active', () => {
    const c = codeOf('switchTab');
    assert.match(c, /active_tab_index/,
      'switchTab reports success from reconnectToTarget alone, which is what let the wrong tab be closed afterwards');
  });

  it('warns when the chart-target index and the visible tab index disagree', () => {
    assert.match(codeOf('switchTab'), /index_space_warning/,
      'the two index spaces can diverge silently; that divergence destroyed a chart tab');
  });
});

describe('closeTab proves WHICH tab went, not just that one did', () => {
  const core = readFileSync(new URL('../src/core/tab.js', import.meta.url), 'utf-8');
  const body = (() => {
    const start = core.indexOf('export async function closeTab(');
    const next = core.indexOf('\nexport ', start + 10);
    return core.slice(start, next === -1 ? undefined : next);
  })();

  it('compares the label multiset before and after, not only the count', () => {
    // The snapshot and the click run in SEPARATE CDP sessions and the click
    // re-queries .tab.active fresh, so it closes whatever is active at click
    // time. Reporting `closed: victim` from the stale snapshot on the strength
    // of a dropped count is a narrower version of the incident that closed the
    // operator's chart tab, in the function whose header claims to fix it.
    assert.match(body, /beforeTally|departed/,
      'the after-check must identify what actually left');
    assert.match(body, /victimWent/,
      'it must decide whether the named victim is the tab that went');
  });

  it('throws when the named victim is still open', () => {
    assert.match(body, /if \(victimWent === false\)[\s\S]*?throw new ClassifiedError/,
      'closing the wrong tab must not report success');
    assert.match(body, /still open/,
      'the message must say the victim survived');
  });

  it('does not hardcode verified: true', () => {
    assert.ok(!/\n\s*verified: true,/.test(body),
      'verified must come from the label comparison, not be asserted');
    assert.match(body, /verified: victimWent === true/);
  });
});
