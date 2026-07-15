import test from 'node:test';
import assert from 'node:assert/strict';
import { _findFreshLandingTarget } from '../src/core/tab.js';

test('tab creation selects only a newly created layout-picker target', () => {
  const targets = [
    { id: 'old-picker', type: 'page', title: 'New tab' },
    { id: 'chart', type: 'page', title: 'AAPL chart' },
    { id: 'fresh-picker', type: 'page', title: 'New tab' },
  ];
  const result = _findFreshLandingTarget(targets, new Set(['old-picker', 'chart']));
  assert.equal(result.id, 'fresh-picker');
});

test('tab creation never falls back to an existing layout-picker target', () => {
  const targets = [{ id: 'old-picker', type: 'page', title: 'New tab' }];
  assert.equal(_findFreshLandingTarget(targets, new Set(['old-picker'])), null);
});
