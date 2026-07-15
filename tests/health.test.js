import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthCheck, compatibilityCheck, compatibilitySnapshot, _isReconnectText } from '../src/core/health.js';

function depsFor(state) {
  return {
    getClient: async () => ({}),
    getTargetInfo: async () => ({
      url: 'https://www.tradingview.com/chart/test/?symbol=SECRET',
      title: 'TradingView',
    }),
    evaluate: async (expression) => {
      assert.match(expression, /ChartApiInstance/);
      return state;
    },
  };
}

test('healthCheck reports feed and compatibility health without leaking target query parameters', async () => {
  const result = await healthCheck({
    _deps: depsFor({
      symbol: 'NASDAQ:NVDA',
      resolution: '1D',
      chartType: 1,
      apiAvailable: true,
      datafeed: { state: 'connected', connected: true },
      compatibility: { compatible: true, checks: { active_chart: true }, missing: [], desktop_version: '3.3.0' },
    }),
  });
  assert.equal(result.healthy, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.target_url, 'https://www.tradingview.com/chart/');
  assert.equal(result.datafeed.state, 'connected');
});

test('healthCheck is degraded and actionable while TradingView is reconnecting', async () => {
  const result = await healthCheck({
    _deps: depsFor({
      symbol: 'NASDAQ:NVDA',
      resolution: '1D',
      chartType: 1,
      apiAvailable: true,
      datafeed: { state: 'reconnecting', connected: false, reconnect_indicator: true },
      compatibility: { compatible: true, checks: {}, missing: [], desktop_version: '3.3.0' },
    }),
  });
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'degraded');
  assert.match(result.warnings.join(' '), /reconnecting/);
});

test('compatibilityCheck reports missing critical capabilities', async () => {
  const result = await compatibilityCheck({
    _deps: depsFor({
      datafeed: { connected: null },
      compatibility: {
        compatible: false,
        checks: { main_series_bars: false },
        missing: ['main_series_bars'],
        desktop_version: '3.4.0',
      },
    }),
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missing, ['main_series_bars']);
  assert.equal(result.datafeed_probe_available, false);
});

test('reconnect banner detection covers common localized TradingView messages', () => {
  for (const message of ['Reconnecting...', 'Sin conexión', 'Verbindung verloren', 'Hors ligne', 'Sem conexão', 'กำลังเชื่อมต่อใหม่', '再接続中']) {
    assert.equal(_isReconnectText(message), true, message);
  }
  assert.equal(_isReconnectText('Connection settings'), false);
});

test('compatibility snapshots record once and report informational surface drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-compat-'));
  let signature = 'aaaa1111';
  const deps = {
    dir,
    compatibilityCheck: async () => ({ compatible: true, checks: { active_chart: true }, missing: [], desktop_version: '3.3.0' }),
    discover: async () => ({ apis: { chartApi: { available: true, methodCount: 10, method_signature: signature } } }),
  };
  try {
    const recorded = await compatibilitySnapshot({ action: 'record', _deps: deps });
    assert.equal(recorded.recorded, true);
    const unchanged = await compatibilitySnapshot({ action: 'compare', _deps: deps });
    assert.equal(unchanged.baseline_found, true);
    assert.deepEqual(unchanged.surface_drift, []);
    signature = 'bbbb2222';
    const drifted = await compatibilitySnapshot({ action: 'compare', _deps: deps });
    assert.equal(drifted.surface_drift.length, 1);
    const preserved = await compatibilitySnapshot({ action: 'record', _deps: deps });
    assert.equal(preserved.recorded, false, 'existing baseline is immutable without overwrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compatibility snapshot storage is bounded across Desktop versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-compat-bounded-'));
  let version = 0;
  const deps = {
    dir,
    compatibilityCheck: async () => ({ compatible: true, checks: {}, missing: [], desktop_version: `3.3.${version}` }),
    discover: async () => ({ apis: {} }),
  };
  try {
    for (version = 0; version < 23; version++) {
      assert.equal((await compatibilitySnapshot({ action: 'record', _deps: deps })).recorded, true);
    }
    const listed = await compatibilitySnapshot({ action: 'list', _deps: deps });
    assert.equal(listed.count, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
