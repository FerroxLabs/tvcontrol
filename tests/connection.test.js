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
import { _isTradingViewUrl, _looksLikeDisconnect } from '../src/connection.js';

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
