// Regression test for alert_delete_by_id, which was broken in the shipped 2.2.3.
//
// WHAT WENT WRONG. It POSTed to /delete_alert (SINGULAR). That endpoint does
// not exist. TradingView answers a missing endpoint with HTTP 200 and an error
// BODY, so the code saw a 200, fell through to a DOM path that cannot delete a
// single alert, and reported failure for something the API does fine.
//
// Probed against the live API on 2026-08-20:
//   POST /delete_alert?alert_id=N                  no such endpoint
//   POST /remove_alert?alert_id=N                  no such endpoint
//   POST /modify_alert?alert_id=N                  no such endpoint
//   POST /delete_alerts {payload:{alert_ids:[N]}}  {"s":"ok"}
//
// The id must also be a NUMBER in that array. Sent as a string the API returns
// a bare {"s":"error"} with no message — which is how the first attempt at
// this fix failed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/core/alerts.js', import.meta.url), 'utf-8');
const body = (() => {
  const start = src.indexOf('export async function deleteById');
  assert.ok(start !== -1, 'deleteById was renamed or removed');
  const next = src.indexOf('\nexport ', start + 10);
  const raw = src.slice(start, next === -1 ? undefined : next);
  // Strip line comments. The block above documents the dead endpoints by name,
  // and a naive scan would match the documentation instead of the code.
  return raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
})();

test('deleteById uses the plural endpoint that actually exists', () => {
  assert.ok(/delete_alerts/.test(body),
    'deleteById no longer posts to /delete_alerts, the only delete endpoint that exists');
  assert.ok(!/['"`\/]delete_alert\?/.test(body) && !/'delete_alert'/.test(body),
    'deleteById is back on the singular /delete_alert endpoint, which returns 200 with an error body');
});

test('the alert id is sent as a number, not a string', () => {
  assert.ok(/numericId/.test(body),
    'the numeric coercion is gone; a string id makes the API return a bare {"s":"error"}');
  assert.ok(/alert_ids:\s*\[\$\{numericId\}\]/.test(body),
    'alert_ids no longer interpolates the numeric id directly into the array');
});

test('deleteById confirms the deletion from an independent read', () => {
  // The read now goes through _survivingIds, which refuses to treat a FAILED
  // list() as an empty one. `(after.alerts || [])` used to turn an expired
  // session into proof that the alert was gone.
  assert.ok(/verified/.test(body) && /_survivingIds\(/.test(body),
    'the post-delete verification is gone; the API saying ok is the action reporting on itself');
});

test('a survivor or an unreadable list is an error, never a reported success', () => {
  // Both independent audits landed on this line. Behavioural coverage lives in
  // tests/verification_contract.js; this is the anti-reversion tripwire.
  assert.ok(!/return \{ success: true, source: 'pricealerts_api', alert_id: id, verified \}/.test(body),
    'success is hardcoded true again, so a surviving alert reports as deleted');
  assert.ok(/if \(!verified\)/.test(body),
    'the guard that throws when the alert survives is gone');
  assert.ok(/survivors === null/.test(body),
    'a failed verification read is being treated as proof of deletion again');
});

test('deleteById no longer has a DOM fallback that always reports failure', () => {
  assert.ok(!/dom_fallback_unsupported/.test(body),
    'the dead DOM fallback is back; it made a working API path look broken');
});

test('the id is normalised once, so a correct deletion is not reported unverified', () => {
  // Adversarial review found this: the request sent Number(id) while the
  // verification compared against the raw input string. "00123" deleted alert
  // 123 and then reported verified:false because "123" !== "00123".
  assert.ok(/const id = String\(numericId\)/.test(body),
    'the id used for verification is no longer derived from the numeric form, so padded or decimal input will report a correct deletion as unverified');
});

test('a non-integer or out-of-range id is rejected before it reaches the page', () => {
  assert.ok(/Number\.isSafeInteger/.test(body),
    'ids beyond MAX_SAFE_INTEGER would silently round and could delete the WRONG alert');
  assert.ok(/Number\.isInteger/.test(body),
    'a decimal id is accepted, which the API cannot use');
});
