import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireFileLock,
  coordinateCliHandler,
  coordinateMcpHandler,
} from '../src/core/coordination.js';

test('file lease serializes owners and never lets a timed-out waiter remove the owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-coordination-'));
  const lockFile = join(dir, 'mutation.lock');
  try {
    const release = await acquireFileLock({ lockFile, heartbeatMs: 0, random: () => 0.5 });
    assert.equal(existsSync(lockFile), true);
    await assert.rejects(
      () => acquireFileLock({ lockFile, waitMs: 0, heartbeatMs: 0, random: () => 0.5 }),
      /Timed out waiting/,
    );
    assert.equal(existsSync(lockFile), true);
    release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file lease recovers stale owners', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-coordination-stale-'));
  const lockFile = join(dir, 'mutation.lock');
  try {
    writeFileSync(lockFile, '{"token":"dead","purpose":"old sweep"}');
    const old = new Date(Date.now() - 120000);
    utimesSync(lockFile, old, old);
    const release = await acquireFileLock({ lockFile, staleMs: 1000, heartbeatMs: 0 });
    release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coordination wraps mutations but leaves read-only handlers untouched', () => {
  const handler = async () => 1;
  assert.notEqual(coordinateMcpHandler('chart_set_symbol', handler), handler);
  assert.notEqual(coordinateMcpHandler('quote_get', handler), handler, 'transient chart switches must serialize');
  assert.notEqual(coordinateMcpHandler('data_get_strategy_results', handler), handler, 'panel/unhide reads mutate UI state');
  assert.notEqual(coordinateMcpHandler('tv_update', handler), handler, 'repository updates must serialize');
  assert.equal(coordinateMcpHandler('chart_get_state', handler), handler);
  assert.notEqual(coordinateCliHandler('symbol', handler), handler);
  assert.equal(coordinateCliHandler('chart-state', handler), handler);
});
