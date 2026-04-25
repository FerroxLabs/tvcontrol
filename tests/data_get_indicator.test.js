/**
 * Tests for getIndicator() — API path and DOM Data Window fallback (W3.4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getIndicator } from '../src/core/data.js';
import { ClassifiedError, CATEGORIES } from '../src/errors.js';
import { loadFixtureRaw } from './_helpers.js';

// Fixture DOM values matching data-window.html
const DOM_VALUES = { 'RSI': '58.24', 'EMA 200': '4521.37', 'Volume': '1,284,500' };

/**
 * Build a _deps object for getIndicator tests.
 * @param {object} studyResult - value returned for getStudyById expression
 * @param {any} domResult - value returned for data-window expression (null = not accessible)
 */
function makeDeps({ studyResult, domResult = DOM_VALUES, panelWasOpen = true } = {}) {
  const calls = [];
  const openPanelCalls = [];

  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('getStudyById')) return studyResult;
    if (expr.includes('data-window')) return domResult;
    return undefined;
  };
  evaluate.calls = calls;

  const openPanel = async (args) => {
    openPanelCalls.push(args);
    return { success: true, panel: args.panel, action: args.action, was_open: panelWasOpen, performed: panelWasOpen ? 'already_open' : 'opened' };
  };
  openPanel.calls = openPanelCalls;

  const waits = [];
  const wait = async (ms) => { waits.push(ms); };

  return { _deps: { evaluate, openPanel, wait }, evaluate, openPanel, waits };
}

// ── Test 1: Non-encrypted happy path ─────────────────────────────────────

describe('getIndicator — non-encrypted happy path', () => {
  it('returns source=api and no dom_values when inputs are short', async () => {
    const { _deps } = makeDeps({
      studyResult: {
        visible: true,
        inputs: [{ id: 'length', value: 14 }, { id: 'src', value: 'close' }],
      },
    });

    const result = await getIndicator({ entity_id: 'rsi_1', _deps });

    assert.equal(result.success, true);
    assert.equal(result.source, 'api');
    assert.equal(result.entity_id, 'rsi_1');
    assert.equal(result.visible, true);
    assert.ok(Array.isArray(result.inputs));
    assert.equal(result.inputs.length, 2);
    assert.equal('dom_values' in result, false);
  });
});

// ── Test 2: Encrypted input detected → fallback triggered ────────────────

describe('getIndicator — encrypted input triggers DOM fallback', () => {
  it('calls openPanel and scrapes dom_values when any input.value >500 chars', async () => {
    const { _deps, openPanel } = makeDeps({
      studyResult: {
        visible: true,
        inputs: [{ id: 'x', value: 'a'.repeat(600) }],
      },
    });

    const result = await getIndicator({ entity_id: 'enc_1', _deps });

    assert.equal(result.source, 'dom_fallback');
    assert.ok(result.dom_values);
    assert.equal(openPanel.calls.length, 1);
  });
});

// ── Test 3: Fallback scrapes fixture data and returns dom_values ──────────

describe('getIndicator — DOM fallback returns fixture values', () => {
  it('dom_values contains all 3 rows from data-window.html fixture', async () => {
    // Verify fixture is readable (exercises loadFixtureRaw)
    const html = loadFixtureRaw('data-window', 'html');
    assert.ok(html.includes('RSI'));
    assert.ok(html.includes('EMA 200'));
    assert.ok(html.includes('Volume'));

    const { _deps } = makeDeps({
      studyResult: {
        visible: false,
        inputs: [{ id: 'blob', value: 'b'.repeat(501) }],
      },
      domResult: DOM_VALUES,
    });

    const result = await getIndicator({ entity_id: 'enc_2', _deps });

    assert.equal(result.source, 'dom_fallback');
    assert.deepEqual(result.dom_values, DOM_VALUES);
    assert.equal(result.dom_values['RSI'], '58.24');
    assert.equal(result.dom_values['EMA 200'], '4521.37');
    assert.equal(result.dom_values['Volume'], '1,284,500');
  });
});

// ── Test 4: Panel not accessible → ClassifiedError TV_UI_CHANGED ─────────

describe('getIndicator — panel not accessible throws ClassifiedError', () => {
  it('throws ClassifiedError(TV_UI_CHANGED) when evaluate returns null for data-window', async () => {
    const { _deps } = makeDeps({
      studyResult: {
        visible: true,
        inputs: [{ id: 'enc', value: 'c'.repeat(600) }],
      },
      domResult: null,
    });

    await assert.rejects(
      () => getIndicator({ entity_id: 'enc_3', _deps }),
      (err) => {
        assert.ok(err instanceof ClassifiedError);
        assert.equal(err.category, CATEGORIES.TV_UI_CHANGED);
        assert.match(err.message, /Data Window panel not accessible/);
        assert.match(err.hint, /Open Data Window manually/);
        return true;
      },
    );
  });
});

// ── Test 5: Study not found → throws Error (existing behavior) ───────────

describe('getIndicator — study not found preserves existing behavior', () => {
  it('throws Error when study returns error field', async () => {
    const { _deps } = makeDeps({
      studyResult: { error: 'Study not found: stale_id' },
    });

    await assert.rejects(
      () => getIndicator({ entity_id: 'stale_id', _deps }),
      /Study not found: stale_id/,
    );
  });
});

// ── Test 6: openPanel called with correct args before scrape ─────────────

describe('getIndicator — openPanel called with data-window open before scrape', () => {
  it('openPanel receives {panel: "data-window", action: "open"}', async () => {
    const { _deps, openPanel } = makeDeps({
      studyResult: {
        visible: true,
        inputs: [{ id: 'blob', value: 'd'.repeat(600) }],
      },
    });

    await getIndicator({ entity_id: 'enc_4', _deps });

    assert.equal(openPanel.calls.length, 1);
    assert.equal(openPanel.calls[0].panel, 'data-window');
    assert.equal(openPanel.calls[0].action, 'open');
  });
});

// ── Test 7: 300ms wait between openPanel and scrape ──────────────────────

describe('getIndicator — 300ms wait between openPanel and scrape', () => {
  it('wait(300) is called and openPanel precedes it', async () => {
    const { _deps, openPanel, waits } = makeDeps({
      studyResult: {
        visible: true,
        inputs: [{ id: 'enc', value: 'e'.repeat(600) }],
      },
    });

    await getIndicator({ entity_id: 'enc_5', _deps });

    assert.equal(waits.length, 1, 'exactly one wait call');
    assert.equal(waits[0], 300, 'waits 300ms');
    // openPanel must have been called (i.e., it happened before the wait)
    assert.equal(openPanel.calls.length, 1);
  });
});

// ── Test 8: source field always present on success ────────────────────────

describe('getIndicator — source field always present on success', () => {
  it('source=api when no encrypted inputs', async () => {
    const { _deps } = makeDeps({
      studyResult: { visible: true, inputs: [{ id: 'len', value: 20 }] },
    });
    const r = await getIndicator({ entity_id: 'clean_1', _deps });
    assert.ok('source' in r);
    assert.equal(r.source, 'api');
  });

  it('source=dom_fallback when encrypted inputs present', async () => {
    const { _deps } = makeDeps({
      studyResult: { visible: true, inputs: [{ id: 'enc', value: 'f'.repeat(600) }] },
    });
    const r = await getIndicator({ entity_id: 'enc_6', _deps });
    assert.ok('source' in r);
    assert.equal(r.source, 'dom_fallback');
  });
});

// ── Test 9: M7 — restore Data Window panel state after fallback ──────────

describe('getIndicator — restores prior Data Window panel state (M7)', () => {
  it('closes panel after scrape when panel was closed before', async () => {
    const { _deps, openPanel } = makeDeps({
      studyResult: { visible: true, inputs: [{ id: 'enc', value: 'g'.repeat(600) }] },
      panelWasOpen: false,
    });
    await getIndicator({ entity_id: 'enc_close', _deps });
    assert.equal(openPanel.calls.length, 2, 'expected open + close');
    assert.equal(openPanel.calls[0].action, 'open');
    assert.equal(openPanel.calls[1].action, 'close');
  });

  it('leaves panel open when panel was already open before', async () => {
    const { _deps, openPanel } = makeDeps({
      studyResult: { visible: true, inputs: [{ id: 'enc', value: 'h'.repeat(600) }] },
      panelWasOpen: true,
    });
    await getIndicator({ entity_id: 'enc_keep', _deps });
    assert.equal(openPanel.calls.length, 1, 'no close when user already had it open');
    assert.equal(openPanel.calls[0].action, 'open');
  });

  it('still closes panel when scrape throws (finally fires)', async () => {
    const { _deps, openPanel } = makeDeps({
      studyResult: { visible: true, inputs: [{ id: 'enc', value: 'i'.repeat(600) }] },
      domResult: null, // forces TV_UI_CHANGED throw
      panelWasOpen: false,
    });
    await assert.rejects(() => getIndicator({ entity_id: 'enc_throw', _deps }));
    const closes = openPanel.calls.filter(c => c.action === 'close');
    assert.equal(closes.length, 1, 'close must run even on error');
  });
});
