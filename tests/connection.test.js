/**
 * Offline tests for src/connection.js pure helpers.
 *
 * Covers hardening that previously had no regression test:
 *   - _isTradingViewUrl  (hostname-anchored target check; path-smuggle defense)
 *   - _looksLikeDisconnect (transport-vs-page-error classification; the
 *     "Order closed" over-match regression)
 *
 * The connection lifecycle (connect/getClient/evaluate) needs a live CDP
 * session and is exercised by examples/verify/*, not here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _isTradingViewUrl,
  _looksLikeDisconnect,
  _withConnectionTimeout,
  _acquireProcessConnectLock,
  fetchCdpResponse,
} from '../src/connection.js';

describe('_isTradingViewUrl()', () => {
  it('accepts canonical tradingview.com URLs', () => {
    assert.equal(_isTradingViewUrl('https://www.tradingview.com/chart/abc/'), true);
    assert.equal(_isTradingViewUrl('https://tradingview.com/'), true);
    assert.equal(_isTradingViewUrl('https://de.tradingview.com/chart/'), true);
  });

  it('rejects path-smuggled lookalikes (hostname must match, not the path)', () => {
    // The whole point of hostname-anchoring: a hostile page that puts the
    // keyword in its PATH must not be treated as TradingView.
    assert.equal(_isTradingViewUrl('https://evil.com/tradingview.com/chart'), false);
    assert.equal(_isTradingViewUrl('https://evil.com/?x=tradingview.com'), false);
  });

  it('rejects suffix lookalikes without the dot boundary', () => {
    assert.equal(_isTradingViewUrl('https://nottradingview.com/'), false);
    assert.equal(_isTradingViewUrl('https://tradingview.com.evil.com/'), false);
  });

  it('rejects non-strings and unparseable input', () => {
    assert.equal(_isTradingViewUrl(null), false);
    assert.equal(_isTradingViewUrl(undefined), false);
    assert.equal(_isTradingViewUrl(42), false);
    assert.equal(_isTradingViewUrl('not a url'), false);
    assert.equal(_isTradingViewUrl(''), false);
  });
});

describe('_looksLikeDisconnect()', () => {
  it('treats transport error codes as disconnects', () => {
    assert.equal(_looksLikeDisconnect({ code: 'ECONNREFUSED' }), true);
    assert.equal(_looksLikeDisconnect({ code: 'ECONNRESET' }), true);
    assert.equal(_looksLikeDisconnect({ code: 'EPIPE' }), true);
    assert.equal(_looksLikeDisconnect({ code: 'ETIMEDOUT' }), true);
    assert.equal(_looksLikeDisconnect({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), true);
  });

  it('treats disconnect-shaped messages as disconnects', () => {
    assert.equal(_looksLikeDisconnect({ message: 'WebSocket connection closed' }), true);
    assert.equal(_looksLikeDisconnect({ message: 'socket hang up' }), true);
    assert.equal(_looksLikeDisconnect({ message: 'CDP client not connected' }), true);
  });

  it('does NOT treat in-page JS throws as disconnects (regression guard)', () => {
    // These contain "closed"/"aborted" but are page-script errors surfaced by
    // evaluate() as "JS evaluation error: ...". Misclassifying them as a dead
    // transport silently re-picked a target and switched the user's tab.
    assert.equal(_looksLikeDisconnect({ message: 'JS evaluation error: Order closed' }), false);
    assert.equal(_looksLikeDisconnect({ message: 'JS evaluation error: connection aborted by strategy' }), false);
    assert.equal(_looksLikeDisconnect({ message: 'JS evaluation error: websocket handshake failed in user code' }), false);
  });

  it('returns false for unrelated errors and empty input', () => {
    assert.equal(_looksLikeDisconnect({ message: 'something unrelated happened' }), false);
    assert.equal(_looksLikeDisconnect({}), false);
    assert.equal(_looksLikeDisconnect(null), false);
  });
});

describe('_withConnectionTimeout()', () => {
  it('returns a prompt result and clears the timeout', async () => {
    assert.equal(await _withConnectionTimeout(Promise.resolve(7), 1000), 7);
  });

  it('bounds a hung renderer liveness probe', async () => {
    await assert.rejects(
      () => _withConnectionTimeout(new Promise(() => {}), 20, 'liveness'),
      (error) => error.code === 'ETIMEDOUT' && /liveness timed out/.test(error.message),
    );
  });
});

describe('fetchCdpResponse()', () => {
  it('always supplies a bounded abort signal to CDP HTTP calls', async () => {
    let request;
    const response = await fetchCdpResponse('/json/list', {
      timeoutMs: 1234,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true };
      },
    });
    assert.equal(response.ok, true);
    assert.equal(request.url, 'http://127.0.0.1:9222/json/list');
    assert.ok(request.options.signal);
  });

  it('rejects non-local path shapes before fetch', async () => {
    await assert.rejects(() => fetchCdpResponse('https://evil.example/'), /must start with/);
  });
});

describe('_acquireProcessConnectLock()', () => {
  it('serializes owners and releases only its own token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-lock-'));
    const lockFile = join(dir, 'connect.lock');
    try {
      const release = await _acquireProcessConnectLock({ lockFile, random: () => 0.5 });
      assert.equal(existsSync(lockFile), true);
      const bypass = await _acquireProcessConnectLock({ lockFile, waitMs: 0, random: () => 0.5 });
      bypass();
      assert.equal(existsSync(lockFile), true, 'timed-out waiter must not remove the owner lock');
      release();
      assert.equal(existsSync(lockFile), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a stale lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-stale-lock-'));
    const lockFile = join(dir, 'connect.lock');
    try {
      writeFileSync(lockFile, '{"token":"dead"}');
      const old = new Date(Date.now() - 120000);
      utimesSync(lockFile, old, old);
      const release = await _acquireProcessConnectLock({ lockFile, staleMs: 1000, random: () => 0.5 });
      assert.equal(existsSync(lockFile), true);
      release();
      assert.equal(existsSync(lockFile), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
