import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetWatchdogForTests,
  sampleWatchdog,
  startWatchdog,
  stopWatchdog,
  watchdogHistory,
  watchdogStatus,
} from '../src/core/watchdog.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-watchdog-'));
  const historyPath = join(dir, 'incidents.json');
  let result = {
    healthy: true,
    chart_symbol: 'SECRET:SYMBOL',
    target_url: 'https://example.test/?account=secret',
    datafeed: { state: 'connected' },
    compatibility: { compatible: true, desktop_version: '3.3.0', missing: [] },
  };
  return {
    dir,
    historyPath,
    setResult(value) { result = value; },
    deps: { historyPath, healthCheck: async () => result },
  };
}

test('watchdog stores only state transitions and excludes chart/account details', async () => {
  _resetWatchdogForTests();
  const f = fixture();
  try {
    assert.equal((await sampleWatchdog({ _deps: f.deps })).changed, true);
    assert.equal((await sampleWatchdog({ _deps: f.deps })).changed, false);
    f.setResult({
      healthy: false,
      datafeed: { state: 'reconnecting' },
      compatibility: { compatible: true, desktop_version: '3.3.0', missing: [] },
    });
    assert.equal((await sampleWatchdog({ _deps: f.deps })).changed, true);
    const stored = readFileSync(f.historyPath, 'utf8');
    assert.doesNotMatch(stored, /SECRET|account|target_url|chart_symbol/);
    const history = watchdogHistory({ _deps: f.deps });
    assert.equal(history.count, 2);
    assert.equal(history.incidents[1].datafeed_state, 'reconnecting');
  } finally {
    _resetWatchdogForTests();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watchdog classifies probe failures without persisting raw errors', async () => {
  _resetWatchdogForTests();
  const f = fixture();
  f.deps.healthCheck = async () => { throw new Error('token=SUPER_SECRET'); };
  try {
    const result = await sampleWatchdog({ _deps: f.deps });
    assert.equal(result.sample.state, 'unreachable');
    assert.doesNotMatch(readFileSync(f.historyPath, 'utf8'), /SUPER_SECRET/);
  } finally {
    _resetWatchdogForTests();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watchdog preserves transition semantics across process-style resets', async () => {
  _resetWatchdogForTests();
  const f = fixture();
  try {
    assert.equal((await sampleWatchdog({ _deps: f.deps })).changed, true);
    _resetWatchdogForTests();
    assert.equal((await sampleWatchdog({ _deps: f.deps })).changed, false);
    assert.equal(watchdogHistory({ _deps: f.deps }).count, 1);
  } finally {
    _resetWatchdogForTests();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('watchdog start is idempotent and validates its interval', async () => {
  _resetWatchdogForTests();
  const f = fixture();
  try {
    await assert.rejects(() => startWatchdog({ interval_ms: 999, _deps: f.deps }), /1000/);
    assert.equal((await startWatchdog({ interval_ms: 60_000, _deps: f.deps })).started, true);
    assert.equal((await startWatchdog({ interval_ms: 60_000, _deps: f.deps })).started, false);
    assert.equal(watchdogStatus().running, true);
    assert.equal(stopWatchdog().stopped, true);
  } finally {
    _resetWatchdogForTests();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
