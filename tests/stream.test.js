import test from 'node:test';
import assert from 'node:assert/strict';
import { _abortableStreamSleep, _streamReconnectDelay } from '../src/core/stream.js';

test('stream reconnect delay backs off exponentially and caps at 30 seconds', () => {
  const noJitter = () => 0.5;
  assert.equal(_streamReconnectDelay(1, noJitter), 750);
  assert.equal(_streamReconnectDelay(2, noJitter), 1500);
  assert.equal(_streamReconnectDelay(3, noJitter), 3000);
  assert.equal(_streamReconnectDelay(20, noJitter), 30000);
});

test('stream reconnect jitter stays within ten percent of the capped delay', () => {
  assert.equal(_streamReconnectDelay(1, () => 0), 675);
  assert.equal(_streamReconnectDelay(1, () => 1), 825);
  assert.equal(_streamReconnectDelay(20, () => 0), 27000);
  assert.equal(_streamReconnectDelay(20, () => 1), 30000);
});

test('stream reconnect sleep ends immediately when the stream is aborted', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const sleeping = _abortableStreamSleep(30_000, controller.signal);
  controller.abort();
  await sleeping;
  assert.ok(Date.now() - started < 1000);
});
