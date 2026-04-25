/**
 * Tests for src/errors.js — ClassifiedError class, category enum, toErrorPayload.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES,
  DEFAULT_HINTS,
  ClassifiedError,
  isClassified,
  toErrorPayload,
} from '../src/errors.js';

describe('CATEGORIES enum', () => {
  it('exposes 11 categories', () => {
    assert.equal(Object.keys(CATEGORIES).length, 11);
  });

  it('is frozen (cannot add categories at runtime)', () => {
    assert.throws(() => { CATEGORIES.NEW = 'new'; }, /read only|Cannot add property|object is not extensible|frozen/i);
  });

  it('has a default hint for every category', () => {
    for (const cat of Object.values(CATEGORIES)) {
      assert.ok(DEFAULT_HINTS[cat], `missing hint for ${cat}`);
      assert.ok(DEFAULT_HINTS[cat].length > 10, `hint too short for ${cat}`);
    }
  });
});

describe('ClassifiedError', () => {
  it('is an Error subclass', () => {
    const err = new ClassifiedError(CATEGORIES.TV_NOT_RUNNING, 'test');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ClassifiedError);
    assert.equal(err.name, 'ClassifiedError');
  });

  it('populates category and default hint', () => {
    const err = new ClassifiedError(CATEGORIES.CHART_LOADING, 'still loading');
    assert.equal(err.category, 'chart_loading');
    assert.equal(err.hint, DEFAULT_HINTS[CATEGORIES.CHART_LOADING]);
  });

  it('accepts a custom hint', () => {
    const err = new ClassifiedError(CATEGORIES.SYMBOL_UNKNOWN, 'bad tick', { hint: 'try ES1!' });
    assert.equal(err.hint, 'try ES1!');
  });

  it('preserves a cause', () => {
    const root = new Error('ECONNREFUSED');
    const err = new ClassifiedError(CATEGORIES.TV_NOT_RUNNING, 'CDP failed', { cause: root });
    assert.equal(err.cause, root);
  });

  it('rejects unknown categories', () => {
    assert.throws(
      () => new ClassifiedError('not_a_real_category', 'x'),
      /Unknown error category/,
    );
  });

  it('serializes via toJSON to the response shape', () => {
    const err = new ClassifiedError(CATEGORIES.STUDY_NOT_FOUND, 'missing id xyz');
    const json = err.toJSON();
    assert.equal(json.success, false);
    assert.equal(json.error, 'missing id xyz');
    assert.equal(json.category, 'study_not_found');
    assert.ok(json.hint);
  });
});

describe('isClassified()', () => {
  it('returns true for ClassifiedError instances', () => {
    assert.equal(isClassified(new ClassifiedError(CATEGORIES.TV_NOT_RUNNING, 'x')), true);
  });

  it('returns false for plain Error', () => {
    assert.equal(isClassified(new Error('x')), false);
  });

  it('returns false for non-errors', () => {
    assert.equal(isClassified('string'), false);
    assert.equal(isClassified(null), false);
    assert.equal(isClassified(undefined), false);
    assert.equal(isClassified({ message: 'x' }), false);
  });
});

describe('toErrorPayload()', () => {
  it('passes through classified errors', () => {
    const err = new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'not running');
    const payload = toErrorPayload(err);
    assert.equal(payload.category, 'replay_not_started');
    assert.equal(payload.error, 'not running');
    assert.ok(payload.hint);
  });

  it('wraps plain Error as api_unexpected', () => {
    const payload = toErrorPayload(new Error('boom'));
    assert.equal(payload.success, false);
    assert.equal(payload.error, 'boom');
    assert.equal(payload.category, 'api_unexpected');
    assert.ok(payload.hint);
  });

  it('handles non-Error throwables', () => {
    const payload = toErrorPayload('raw string error');
    assert.equal(payload.error, 'raw string error');
    assert.equal(payload.category, 'api_unexpected');
  });

  it('handles undefined gracefully', () => {
    const payload = toErrorPayload(undefined);
    assert.ok(payload.error);
    assert.equal(payload.category, 'api_unexpected');
  });
});
