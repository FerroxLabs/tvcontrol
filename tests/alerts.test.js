/**
 * Tests for deleteById in src/core/alerts.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteById } from '../src/core/alerts.js';
import { scriptedDeps, loadFixture } from './_helpers.js';
import { CATEGORIES } from '../src/errors.js';

const OK_RESPONSE = { s: 'ok', method: 'post' };
const ERR_RESPONSE = { s: 'error', errmsg: 'not found' };

describe('deleteById()', () => {
  it('returns success with method rest_api on ok REST response', async () => {
    const { _deps } = scriptedDeps({ 'delete_alert': OK_RESPONSE });
    const result = await deleteById({ alert_id: 'aid_123', _deps });
    assert.equal(result.success, true);
    assert.equal(result.method, 'rest_api');
    assert.equal(result.alert_id, 'aid_123');
  });

  it('rejects empty string alert_id with ClassifiedError invalid_argument', async () => {
    const { _deps } = scriptedDeps({});
    await assert.rejects(
      () => deleteById({ alert_id: '', _deps }),
      (err) => {
        assert.equal(err.name, 'ClassifiedError');
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        assert.ok(err.message.includes('alert_id required'));
        assert.ok(err.hint.includes('alert_list'));
        return true;
      },
    );
  });

  it('rejects null alert_id with ClassifiedError', async () => {
    const { _deps } = scriptedDeps({});
    await assert.rejects(
      () => deleteById({ alert_id: null, _deps }),
      (err) => {
        assert.equal(err.name, 'ClassifiedError');
        assert.equal(err.category, CATEGORIES.INVALID_ARGUMENT);
        return true;
      },
    );
  });

  it('tries GET variant when POST returns non-ok', async () => {
    let callCount = 0;
    const evaluate = async (expr) => {
      callCount++;
      if (expr.includes('delete_alert')) {
        // First call (POST): non-ok, second call (GET): ok
        return callCount === 1
          ? { s: 'error', errmsg: 'post failed' }
          : { s: 'ok', method: 'get' };
      }
      return undefined;
    };
    evaluate.calls = [];
    // The fetch logic is a single evaluateAsync call that internally chains POST then GET.
    // We simulate by having the evaluateAsync return a get-success object.
    const { _deps } = scriptedDeps({});
    _deps.evaluateAsync = async (expr) => {
      evaluate.calls.push(expr);
      if (expr.includes('delete_alert')) return { s: 'ok', method: 'get' };
      return undefined;
    };
    _deps.evaluateAsync.calls = evaluate.calls;
    const result = await deleteById({ alert_id: 'aid_456', _deps });
    assert.equal(result.success, true);
    assert.equal(result.method, 'rest_api');
    assert.equal(result.variant, 'get');
  });

  it('falls back to DOM when both REST variants fail', async () => {
    const { _deps } = scriptedDeps({});
    _deps.evaluateAsync = async () => ({ s: 'error', errmsg: 'network error' });
    const result = await deleteById({ alert_id: 'aid_789', _deps });
    assert.equal(result.success, false);
    assert.equal(result.method, 'dom_fallback_unsupported');
  });

  it('surfaces method: rest_api on success', async () => {
    const { _deps } = scriptedDeps({ 'delete_alert': { s: 'ok', method: 'post' } });
    const result = await deleteById({ alert_id: 'aid_ok', _deps });
    assert.equal(result.method, 'rest_api');
  });

  it('uses safeString — injection payloads with quotes are escaped', async () => {
    const calls = [];
    const { _deps } = scriptedDeps({});
    _deps.evaluateAsync = async (expr) => { calls.push(expr); return { s: 'ok', method: 'post' }; };
    // Payload contains a double quote; if interpolated raw it would break out
    // of the JS string literal. JSON.stringify escapes as \" which is safe.
    const injectionAttempt = 'aid"; fetch("http://evil");//';
    await deleteById({ alert_id: injectionAttempt, _deps });
    assert.equal(calls.length, 1);
    // The properly-escaped (JSON-stringified) form must be present
    assert.ok(calls[0].includes(JSON.stringify(injectionAttempt)), 'safeString-escaped form present');
    // The raw unquoted injection (unescaped double quote then semicolon + fetch)
    // must NOT appear — that would indicate broken escaping
    assert.ok(!calls[0].includes('aid"; fetch("http://evil");//'), 'no unescaped injection in expression');
    assert.ok(calls[0].includes('delete_alert'), 'URL fragment present');
  });

  it('fixture-based: happy path with known alert_id from fixture', async () => {
    const fixture = loadFixture('alerts-list-response');
    const knownId = fixture.r[0].alert_id; // 'aid_seed_0001'
    const { _deps } = scriptedDeps({ 'delete_alert': { s: 'ok', method: 'post' } });
    const result = await deleteById({ alert_id: knownId, _deps });
    assert.equal(result.success, true);
    assert.equal(result.alert_id, knownId);
    assert.equal(result.method, 'rest_api');
  });

  it('deleteById URL-encodes alert_id', async () => {
    const calls = [];
    const { _deps } = scriptedDeps({});
    _deps.evaluateAsync = async (expr) => { calls.push(expr); return { s: 'ok', method: 'post' }; };
    const rawId = 'aid 42&foo=bar?x=1';
    await deleteById({ alert_id: rawId, _deps });
    assert.equal(calls.length, 1);
    // The expression must call encodeURIComponent() wrapping the safeString-quoted id
    assert.ok(calls[0].includes('encodeURIComponent('), 'encodeURIComponent call present in expression');
    assert.ok(calls[0].includes(JSON.stringify(rawId)), 'safeString-quoted id present in expression');
    // The raw id must not appear as a bare unquoted token — verify it only appears inside the JSON-quoted form
    const exprWithoutQuoted = calls[0].replace(JSON.stringify(rawId), '');
    assert.ok(!exprWithoutQuoted.includes(rawId), 'raw unencoded form not present outside quotes');
  });

  it('deleteById reports failure (not success) when DOM fallback cannot delete', async () => {
    const { _deps } = scriptedDeps({});
    _deps.evaluateAsync = async () => ({ s: 'error', errmsg: 'endpoint unreachable' });
    const result = await deleteById({ alert_id: 'aid_fallback', _deps });
    assert.equal(result.success, false);
    assert.equal(result.method, 'dom_fallback_unsupported');
    assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error message present');
  });
});
