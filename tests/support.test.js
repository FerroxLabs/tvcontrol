import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createSupportBundle, redactSupportValue } from '../src/core/support.js';

describe('support bundle', () => {
  it('redacts account-linked fields, secrets, email, and home paths recursively', () => {
    const clean = redactSupportValue({
      chart_symbol: 'NASDAQ:AAPL',
      nested: { title: 'Private layout', safe: '/Users/alice/logs/a.txt', note: 'alice@example.com abcdefghijklmnopqrstuvwxyz1234567890' },
    }, { home: '/Users/alice' });
    assert.equal(clean.chart_symbol, undefined);
    assert.equal(clean.nested.title, undefined);
    assert.equal(clean.nested.safe, '~/logs/a.txt');
    assert.doesNotMatch(clean.nested.note, /alice@example|abcdefghijklmnopqrstuvwxyz/);
  });

  it('writes a compressed bounded bundle without raw private values', async () => {
    let writtenPath;
    let written;
    const result = await createSupportBundle({
      telemetry_lines: 2,
      output_dir: '/Users/alice/.tv-mcp/support-test',
      _deps: {
        now: () => new Date('2026-07-15T00:00:00.000Z'),
        home: '/Users/alice',
        healthCheck: async () => ({ chart_symbol: 'NASDAQ:SECRET', target_url: 'https://example.test/chart/private' }),
        compatibilityCheck: async () => ({ checks: { active_chart: true } }),
        compatibilitySnapshot: async () => ({ success: true }),
        watchdogHistory: () => ({ incidents: [{ state: 'healthy' }] }),
        getCapabilityMatrix: async () => ({ tools: [{ tool: 'chart_get_state', status: 'available' }] }),
        tail: ({ n }) => [{ tool: 'x', message: `alice@example.com n=${n}`, raw: 'NASDAQ:SECRET' }],
        atomicWrite: (path, data) => { writtenPath = path; written = data; },
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.file_path, writtenPath);
    const decoded = gunzipSync(written).toString('utf8');
    assert.doesNotMatch(decoded, /NASDAQ:SECRET|private|alice@example/);
    const payload = JSON.parse(decoded);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.sections.health.ok, true);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  });

  it('rejects output directories outside the TVControl data boundary', async () => {
    let wrote = false;
    await assert.rejects(
      createSupportBundle({
        output_dir: '/Users/alice/Desktop',
        _deps: {
          home: '/Users/alice',
          healthCheck: async () => ({}),
          compatibilityCheck: async () => ({}),
          compatibilitySnapshot: async () => ({}),
          watchdogHistory: () => ({}),
          getCapabilityMatrix: async () => ({}),
          tail: () => [],
          atomicWrite: () => { wrote = true; },
        },
      }),
      (error) => error.category === 'invalid_argument' && /\.tv-mcp/.test(error.message),
    );
    assert.equal(wrote, false);
  });
});
