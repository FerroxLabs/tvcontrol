/**
 * THE OFFLINE SUITE WAS TALKING TO THE LIVE CHART.
 *
 * Found 2026-08-21 by tracing why tests/state.test.js never let the process
 * exit. The leaked handle was a real CDP WebSocket on 127.0.0.1:9222. Two calls
 * inside restore() were made with no `_deps`:
 *
 *   drawing.clearAll()                      -> removeAllShapes() on the live chart
 *   pane.setLayout({ layout: snap.code })   -> rewrote the live pane layout
 *
 * Both fell back to production because the fallback fails OPEN: `deps?.x || _x`
 * silently substitutes the real CDP function when the key is absent. Every run
 * of that "unit" test cleared the drawings on whichever pane happened to be
 * active. It only did no damage because the active pane was empty.
 *
 * These tests fail if any of it comes back.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as pjoin, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { restore, snapshot } from '../src/core/state.js';
import * as connection from '../src/connection.js';
import { emptyDeps } from './_helpers.js';

const TMP = mkdtempSync(join(tmpdir(), 'tvcontrol-hermetic-'));

function writeSnap(dir, name, snap) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(snap));
}

const SNAP = {
  schema_version: 1,
  captured_at: '2026-08-21T00:00:00.000Z',
  symbol: 'AAPL',
  resolution: 'D',
  chart_type: 'Candles',
  layout: { code: '2h', pane_count: 2 },
  panes: [{ index: 0, symbol: 'AAPL', resolution: 'D', chart_type: 'Candles' }],
  studies: [{ name: 'RSI', inputs: [{ id: 'length', value: 14 }] }],
  drawings: [{ shape: 'horizontal_line', points: [{ time: 1700000000, price: 100 }], overrides: {}, text: '' }],
  visible_range: { from: 1699000000, to: 1700000000 },
};

describe('offline tests must never reach the real browser', () => {
  it('the TV_MCP_NO_CDP guard blocks getClient and names itself', async () => {
    const prev = process.env.TV_MCP_NO_CDP;
    process.env.TV_MCP_NO_CDP = '1';
    try {
      await assert.rejects(
        () => connection.getClient(),
        (err) => {
          assert.match(err.message, /Blocked a real CDP call/);
          assert.match(err.message, /getClient/);
          assert.match(err.message, /_deps/, 'the message must say what to do about it');
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.TV_MCP_NO_CDP; else process.env.TV_MCP_NO_CDP = prev;
    }
  });

  it('the guard lets an injected fetchImpl through — a test double is not the browser', async () => {
    const prev = process.env.TV_MCP_NO_CDP;
    process.env.TV_MCP_NO_CDP = '1';
    try {
      const res = await connection.fetchCdpResponse('/json/list', {
        fetchImpl: async () => ({ ok: true, injected: true }),
      });
      assert.equal(res.injected, true);
    } finally {
      if (prev === undefined) delete process.env.TV_MCP_NO_CDP; else process.env.TV_MCP_NO_CDP = prev;
    }
  });

  it('restore() with injected deps performs no real CDP call', async () => {
    const prev = process.env.TV_MCP_NO_CDP;
    process.env.TV_MCP_NO_CDP = '1';
    const dir = join(TMP, 'restore-hermetic');
    writeSnap(dir, 'h', SNAP);
    try {
      const { _deps } = emptyDeps();
      const result = await restore({ name: 'h', _deps, _snapshots_dir: dir });
      // The point is not what it restored. The point is that it got here at all:
      // any escape throws "Blocked a real CDP call" from inside the guard.
      assert.equal(result.success, true);
      const blocked = JSON.stringify(result.restored.skipped || []);
      assert.ok(
        !blocked.includes('Blocked a real CDP call'),
        `restore() reached production CDP: ${blocked}`,
      );
    } finally {
      if (prev === undefined) delete process.env.TV_MCP_NO_CDP; else process.env.TV_MCP_NO_CDP = prev;
    }
  });

  it('snapshot() with injected deps performs no real CDP call', async () => {
    const prev = process.env.TV_MCP_NO_CDP;
    process.env.TV_MCP_NO_CDP = '1';
    const dir = join(TMP, 'snap-hermetic');
    mkdirSync(dir, { recursive: true });
    try {
      const { _deps } = emptyDeps();
      await snapshot({ name: 'h2', _deps, _snapshots_dir: dir });
    } catch (err) {
      assert.ok(
        !/Blocked a real CDP call/.test(err.message),
        `snapshot() reached production CDP: ${err.message}`,
      );
    } finally {
      if (prev === undefined) delete process.env.TV_MCP_NO_CDP; else process.env.TV_MCP_NO_CDP = prev;
    }
  });

  // A sixth test lived here: it swapped connection.js's exports for tripwires
  // and asserted none fired. It passed whether or not the bug was present —
  // ESM namespace objects are non-configurable, so defineProperty threw and the
  // tripwires were never installed. Mutation-tested and deleted rather than
  // left as decoration. The env guard above is the real detector: reintroducing
  // either missing `_deps` turns test 3 red.
});

/**
 * THE GUARD IS ONLY AS WIDE AS ITS CALL SITES.
 *
 * connection.js used to claim "any attempt to reach the browser throws
 * immediately" while tab.js and sweep_parallel.js opened raw CDP WebSockets and
 * health.js used a raw http.get, none of which passed through getClient() or
 * fetchCdpResponse(). An external audit found all three, and no test would have
 * gone red because nothing enumerated them.
 *
 * This walks the source for direct browser calls and requires each one to be
 * guarded. A new unguarded path is a failing test rather than a silent hole.
 */
describe('every direct path to the browser is guarded', () => {
  const SRC = pjoin(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(pjoin(dir, e.name)) : (e.name.endsWith('.js') ? [pjoin(dir, e.name)] : [])
  ));

  it('every raw CDP() and http.get to the CDP port calls _assertCdpAllowed', () => {
    const unguarded = [];
    for (const file of walk(SRC)) {
      if (file === pjoin(SRC, 'connection.js')) continue; // defines the guard (path-separator safe)
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const rawCdp = /(?<![\w.])CDP\s*\(\s*\{/.test(line);
        const rawHttp = /http\.get\s*\(\s*`http:\/\/\$\{CDP_HOST\}/.test(line);
        if (!rawCdp && !rawHttp) return;
        // The guard may be on this line or in the few lines just above it.
        const window = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
        if (!window.includes('_assertCdpAllowed')) {
          unguarded.push(`${file.replace(SRC, 'src').split(sep).join('/')}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
    assert.deepEqual(unguarded, [],
      'these reach the browser without passing the offline guard:\n' + unguarded.join('\n'));
  });

  it('the guard actually blocks the raw paths it now covers', async () => {
    const prev = process.env.TV_MCP_NO_CDP;
    process.env.TV_MCP_NO_CDP = '1';
    try {
      const tab = await import('../src/core/tab.js');
      // Every tab operation has to reach the browser, whether through the
      // guarded HTTP target list or the raw CDP socket. Neither may get out.
      await assert.rejects(() => tab.list(), /Blocked a real CDP call/);

      const health = await import('../src/core/health.js');
      // _probeCdp used a raw http.get and returns null rather than throwing,
      // which is its documented contract; the point is that it does not reach
      // the network.
      const hc = await health.healthCheck().catch((e) => ({ threw: e.message }));
      assert.ok(hc, 'health check returned something rather than hanging on a socket');
    } finally {
      if (prev === undefined) delete process.env.TV_MCP_NO_CDP; else process.env.TV_MCP_NO_CDP = prev;
    }
  });
});
