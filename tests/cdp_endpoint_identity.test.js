import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEndpointIsTradingView, TV_IDENTITY_MARKER } from '../src/connection.js';

// Both are REAL captures. Note they report the SAME `Browser` shape: TradingView
// is Electron. Anything that discriminates on `Browser` is a check that cannot
// fail, so these fixtures exist to make that mistake impossible to ship.
const TRADINGVIEW = {
  Browser: 'Chrome/146.0.7680.216',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TradingView/3.4.0 Chrome/146.0.7680.216 Electron/41.7.1 Safari/537.36 TVDesktop/3.4.0',
};
const CHROME = {
  Browser: 'Chrome/152.0.7977.65',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.65 Safari/537.36',
};

test('accepts the real TradingView desktop endpoint', async () => {
  const v = await assertEndpointIsTradingView(async () => TRADINGVIEW);
  assert.equal(v.Browser, 'Chrome/146.0.7680.216');
});

test('REFUSES a Chrome that owns the port, instead of blaming TradingView', async () => {
  await assert.rejects(
    () => assertEndpointIsTradingView(async () => CHROME),
    (err) => {
      assert.match(err.message, /NOT TradingView/i);
      // it must NAME what is really there - the whole point is an actionable message
      assert.match(err.message, /Chrome\/152/);
      return true;
    },
  );
});

test('the two endpoints are indistinguishable by Browser, so UA is the only discriminator', () => {
  // If this ever fails, `Browser` became discriminating and the guard could be
  // simplified. Until then, checking Browser would accept Chrome.
  assert.ok(TRADINGVIEW.Browser.startsWith('Chrome/'));
  assert.ok(CHROME.Browser.startsWith('Chrome/'));
  assert.ok(TRADINGVIEW['User-Agent'].includes(TV_IDENTITY_MARKER));
  assert.ok(!CHROME['User-Agent'].includes(TV_IDENTITY_MARKER));
});

test('tells the user the deaf-instance truth: freeing the port later does not heal it', async () => {
  await assert.rejects(
    () => assertEndpointIsTradingView(async () => CHROME),
    (err) => {
      assert.match(err.hint ?? '', /does NOT heal it|stays deaf/i);
      assert.match(err.hint ?? '', /kill_existing/);
      return true;
    },
  );
});

test('a missing User-Agent is refused, not treated as TradingView', async () => {
  await assert.rejects(() => assertEndpointIsTradingView(async () => ({ Browser: 'Chrome/1' })));
  await assert.rejects(() => assertEndpointIsTradingView(async () => ({})));
});
