import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetCapabilityCacheForTests,
  discoverToolCatalog,
  gateToolHandler,
  getCapabilityMatrix,
} from '../src/core/capabilities.js';

describe('capability matrix', () => {
  beforeEach(() => _resetCapabilityCacheForTests());

  it('discovers the complete static tool catalog including multiline registrations', () => {
    const names = discoverToolCatalog();
    assert.ok(names.includes('chart_vision_read'));
    assert.ok(names.includes('tv_capability_matrix'));
    assert.ok(names.includes('tv_support_bundle'));
    assert.equal(names.length, new Set(names).size);
  });

  it('reports blocked tools when a known required API is absent', async () => {
    const result = await getCapabilityMatrix({
      _deps: {
        catalog: () => ['chart_get_state', 'tv_health_check'],
        now: () => 1,
        compatibilityCheck: async () => ({ checks: { active_chart: false } }),
      },
    });
    assert.equal(result.blocked, 1);
    assert.equal(result.available, 1);
    assert.deepEqual(result.tools[0].missing, ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies']);
  });

  it('reports the advanced arbitrary-JS tool as disabled unless explicitly enabled', async () => {
    const previous = process.env.TV_MCP_ADVANCED;
    try {
      delete process.env.TV_MCP_ADVANCED;
      const result = await getCapabilityMatrix({ probe: false, _deps: { catalog: () => ['ui_evaluate'] } });
      assert.equal(result.disabled, 1);
      assert.equal(result.registered, 0);
      assert.equal(result.tools[0].status, 'disabled');
    } finally {
      if (previous === undefined) delete process.env.TV_MCP_ADVANCED;
      else process.env.TV_MCP_ADVANCED = previous;
    }
  });

  it('fails closed only when the probe explicitly confirms missing APIs', async () => {
    let called = 0;
    const gated = gateToolHandler('chart_set_symbol', async () => { called++; return 'ok'; }, {
      _deps: {
        now: () => 1,
        compatibilityCheck: async () => ({ checks: { active_chart: true, chart_symbol: false } }),
      },
    });
    await assert.rejects(gated(), /chart_symbol/);
    assert.equal(called, 0);
  });

  it('passes through when the compatibility probe itself is unavailable', async () => {
    const gated = gateToolHandler('chart_set_symbol', async () => 'recovery-path', {
      _deps: { now: () => 1, compatibilityCheck: async () => { throw new Error('offline'); } },
    });
    assert.equal(await gated(), 'recovery-path');
  });
});
