/**
 * Offline tests for src/core/sweep_parallel.js.
 *
 * The full worker pool needs a live CDP session (spawns Chrome tabs), so this
 * covers the timeout backstop that bounds a hung combo — the core safety
 * mechanism for the parallel sweep. (Previously this module had zero coverage.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _withTimeout } from '../src/core/sweep_parallel.js';
import { CATEGORIES } from '../src/errors.js';

describe('_withTimeout()', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const result = await _withTimeout(Promise.resolve(42), 1000, 'fast');
    assert.equal(result, 42);
  });

  it('rejects with a classified timeout when the promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(() => r('late'), 1000));
    await assert.rejects(
      () => _withTimeout(slow, 50, 'worker 1 ES1!/15'),
      (err) => {
        assert.equal(err.name, 'ClassifiedError');
        assert.equal(err.category, CATEGORIES.CDP_DISCONNECTED);
        assert.ok(err.message.includes('timed out'));
        assert.ok(err.message.includes('worker 1 ES1!/15'), 'label surfaced in message');
        return true;
      },
    );
  });

  it('does not arm a timer when ms is falsy/zero (no bound)', async () => {
    // ms<=0 means "no timeout" — must pass the promise through unchanged.
    const result = await _withTimeout(Promise.resolve('through'), 0, 'x');
    assert.equal(result, 'through');
  });

  it('clears its timer on resolution (process is not held open)', async () => {
    // If the timer leaked unref-less, a fast resolve would still keep the
    // event loop alive ~ms. We assert the call returns ~immediately.
    const start = Date.now();
    await _withTimeout(Promise.resolve(1), 5000, 'x');
    assert.ok(Date.now() - start < 500, 'returned promptly, timer cleared');
  });
});
