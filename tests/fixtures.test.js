/**
 * Tests that exercise the fixture infrastructure itself.
 * If these break, every fixture-backed test is suspect.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, loadFixtureRaw } from './_helpers.js';

describe('loadFixture()', () => {
  it('loads a JSON fixture by name', () => {
    const data = loadFixture('alerts-list-response');
    assert.ok(data, 'fixture loaded');
    assert.equal(data.s, 'ok', 'has expected shape');
    assert.ok(Array.isArray(data.r), 'alerts array present');
    assert.ok(data.r.length >= 2, 'at least two seed alerts');
  });

  it('loads chart-state fixture', () => {
    const state = loadFixture('chart-state');
    assert.equal(state.success, true);
    assert.equal(state.symbol, 'NYMEX:CL1!');
    assert.ok(Array.isArray(state.studies));
    assert.equal(state.studies.length, 3);
  });

  it('loads pine-facade-list fixture', () => {
    const scripts = loadFixture('pine-facade-list');
    assert.ok(Array.isArray(scripts));
    assert.ok(scripts.length >= 2);
    assert.ok(scripts[0].scriptIdPart);
  });

  it('throws if fixture does not exist', () => {
    assert.throws(
      () => loadFixture('does-not-exist-xyz'),
      /ENOENT|no such file/i,
    );
  });
});

describe('loadFixtureRaw()', () => {
  it('loads an HTML fixture by name', () => {
    const html = loadFixtureRaw('data-window', 'html');
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('data-name="data-window"'));
    assert.ok(html.includes('RSI'));
  });

  it('defaults to .html extension', () => {
    const html = loadFixtureRaw('data-window');
    assert.ok(html.includes('data-window'));
  });

  it('throws if fixture does not exist', () => {
    assert.throws(
      () => loadFixtureRaw('does-not-exist-xyz'),
      /ENOENT|no such file/i,
    );
  });
});
