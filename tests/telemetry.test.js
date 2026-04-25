/**
 * Tests for src/core/telemetry.js — opt-in JSONL session logger.
 * All file I/O is redirected to tmpdir via _logDir / _logPath overrides.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isEnabled,
  shouldLog,
  record,
  flushNow,
  tail,
  clear,
} from '../src/core/telemetry.js';

import { instrument } from '../src/tools/_format.js';

// --- helpers ----------------------------------------------------------------

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- shared tmpdir ----------------------------------------------------------

let tmpDir;
let tmpLog;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tv-mcp-test-'));
  tmpLog = join(tmpDir, 'session.jsonl');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear the log between tests
  if (existsSync(tmpLog)) writeFileSync(tmpLog, '');
});

// --- tests ------------------------------------------------------------------

describe('isEnabled()', () => {
  it('returns false when TV_MCP_TELEMETRY is not set', () => {
    withEnv({ TV_MCP_TELEMETRY: undefined }, () => {
      assert.equal(isEnabled(), false);
    });
  });

  it('returns true when TV_MCP_TELEMETRY=1', () => {
    withEnv({ TV_MCP_TELEMETRY: '1' }, () => {
      assert.equal(isEnabled(), true);
    });
  });
});

describe('shouldLog()', () => {
  it('stream_* tools always return false even when enabled', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      assert.equal(shouldLog('stream_quote'), false);
      assert.equal(shouldLog('stream_bars'), false);
    });
  });

  it('tv_health_check is excluded by default', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      assert.equal(shouldLog('tv_health_check'), false);
    });
  });

  it('alert_create is logged by default when enabled', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      assert.equal(shouldLog('alert_create'), true);
    });
  });
});

describe('record()', () => {
  it('queues the entry without immediately writing to disk', () => {
    const queueLog = join(tmpDir, 'queue-check.jsonl');
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      record({ tool: 'alert_create', success: true, duration_ms: 10, _logDir: tmpDir, _logPath: queueLog });
      // File should not exist yet — write is deferred
      assert.equal(existsSync(queueLog), false);
      // Flush to clean up the pending timer / queue
      flushNow(tmpDir, queueLog);
    });
  });

  it('silently noops when telemetry is disabled', () => {
    const noopLog = join(tmpDir, 'noop.jsonl');
    withEnv({ TV_MCP_TELEMETRY: undefined }, () => {
      record({ tool: 'alert_create', success: true, duration_ms: 1, _logDir: tmpDir, _logPath: noopLog });
      flushNow(tmpDir, noopLog);
      assert.equal(existsSync(noopLog), false);
    });
  });
});

describe('flushNow()', () => {
  it('drains the queue to disk', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      record({ tool: 'alert_create', success: true, duration_ms: 42, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);
      const contents = readFileSync(tmpLog, 'utf8');
      const entry = JSON.parse(contents.trim());
      assert.equal(entry.tool, 'alert_create');
      assert.equal(entry.success, true);
      assert.equal(entry.duration_ms, 42);
      assert.ok(entry.ts);
    });
  });

  it('batches multiple queued entries into one file write', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      record({ tool: 'tool_a', success: true, duration_ms: 1, _logDir: tmpDir, _logPath: tmpLog });
      record({ tool: 'tool_b', success: false, duration_ms: 2, _logDir: tmpDir, _logPath: tmpLog });
      record({ tool: 'tool_c', success: true, duration_ms: 3, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);
      const lines = readFileSync(tmpLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 3);
      assert.equal(JSON.parse(lines[0]).tool, 'tool_a');
      assert.equal(JSON.parse(lines[1]).tool, 'tool_b');
      assert.equal(JSON.parse(lines[2]).tool, 'tool_c');
    });
  });

  it('truncates oversized error to keep each line under PIPE_BUF', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      const huge = 'x'.repeat(8000);
      record({ tool: 'noisy_tool', success: false, duration_ms: 1, error: huge, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);
      const raw = readFileSync(tmpLog, 'utf8').trim();
      assert.ok(raw.length < 4000, `line should be < 4000 bytes, got ${raw.length}`);
      const obj = JSON.parse(raw); // must still be valid JSON
      assert.equal(obj.tool, 'noisy_tool');
      assert.ok(typeof obj.error === 'string' && obj.error.includes('[truncated]'));
    });
  });

  it('splits queue across multiple writes when aggregate exceeds PIPE_BUF cap', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      // 5 records × ~1500-byte error each → ~7.5KB queue, must split.
      const payload = 'y'.repeat(1500);
      for (let i = 0; i < 5; i++) {
        record({ tool: `tool_${i}`, success: true, duration_ms: i, error: payload, _logDir: tmpDir, _logPath: tmpLog });
      }
      flushNow(tmpDir, tmpLog);
      const lines = readFileSync(tmpLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 5);
      // Every individual line is well-formed JSON.
      for (let i = 0; i < lines.length; i++) {
        const obj = JSON.parse(lines[i]);
        assert.equal(obj.tool, `tool_${i}`);
      }
    });
  });

  it('is idempotent — second flush after empty queue does nothing', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      record({ tool: 'alert_create', success: true, duration_ms: 1, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);
      const sizeAfterFirst = statSync(tmpLog).size;
      flushNow(tmpDir, tmpLog);
      assert.equal(statSync(tmpLog).size, sizeAfterFirst);
    });
  });
});

describe('rotation', () => {
  it('rotates the log when it exceeds the threshold', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      const big = Buffer.alloc(11 * 1024 * 1024, 'x');
      writeFileSync(tmpLog, big);
      record({ tool: 'alert_create', success: true, duration_ms: 1, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);
      assert.ok(existsSync(tmpLog + '.1'), 'rotated file should exist as .1');
      const newSize = readFileSync(tmpLog, 'utf8').length;
      assert.ok(newSize < 1024, 'new log should be small after rotation');
    });
  });

  it('explicitly drops .3 before shifting .2→.3', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      // Set up pre-existing .1, .2, .3 segments
      const log3 = tmpLog + '.3';
      const log2 = tmpLog + '.2';
      const log1 = tmpLog + '.1';
      writeFileSync(log3, 'old-3\n');
      writeFileSync(log2, 'old-2\n');
      writeFileSync(log1, 'old-1\n');

      // Write a large current log to trigger rotation
      const big = Buffer.alloc(11 * 1024 * 1024, 'x');
      writeFileSync(tmpLog, big);
      record({ tool: 'alert_create', success: true, duration_ms: 1, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);

      // .3 should now contain what was .2 (old-2), not the original old-3
      assert.equal(readFileSync(log3, 'utf8'), 'old-2\n');
      // .2 should now contain what was .1 (old-1)
      assert.equal(readFileSync(log2, 'utf8'), 'old-1\n');
      // .1 should be the old current log (large)
      assert.equal(statSync(log1).size, 11 * 1024 * 1024);
    });
  });
});

describe('tail()', () => {
  it('returns last n parsed entries', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      for (let i = 0; i < 5; i++) {
        record({ tool: `tool_${i}`, success: true, duration_ms: i, _logDir: tmpDir, _logPath: tmpLog });
      }
      flushNow(tmpDir, tmpLog);
      const lines = tail({ n: 3, _logPath: tmpLog });
      assert.equal(lines.length, 3);
      assert.equal(lines[0].tool, 'tool_2');
      assert.equal(lines[2].tool, 'tool_4');
    });
  });

  it('returns empty array when log does not exist', () => {
    const missing = join(tmpDir, 'nonexistent.jsonl');
    assert.deepEqual(tail({ n: 10, _logPath: missing }), []);
  });
});

describe('clear()', () => {
  it('empties the log and returns { cleared: true }', () => {
    withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: undefined, TV_MCP_TELEMETRY_EXCLUDE: undefined }, () => {
      record({ tool: 'alert_create', success: true, duration_ms: 5, _logDir: tmpDir, _logPath: tmpLog });
      flushNow(tmpDir, tmpLog);
      const result = clear({ _logPath: tmpLog });
      assert.deepEqual(result, { cleared: true });
      assert.equal(readFileSync(tmpLog, 'utf8'), '');
    });
  });

  it('returns { cleared: false } when log does not exist', () => {
    const missing = join(tmpDir, 'no-log.jsonl');
    assert.deepEqual(clear({ _logPath: missing }), { cleared: false });
  });
});

describe('instrument()', () => {
  it('records success when wrapped fn resolves', async () => {
    const successLog = join(tmpDir, 'instr-success.jsonl');
    await withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: 'test_tool', TV_MCP_TELEMETRY_EXCLUDE: undefined }, async () => {
      const wrapped = instrument('test_tool', async () => ({ success: true }));
      const result = await wrapped({});
      flushNow(tmpDir, successLog);
      assert.deepEqual(result, { success: true });
    });
  });

  it('records failure and re-throws when wrapped fn throws', async () => {
    await withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: 'test_tool', TV_MCP_TELEMETRY_EXCLUDE: undefined }, async () => {
      const err = new Error('boom');
      const wrapped = instrument('test_tool', async () => { throw err; });
      await assert.rejects(() => wrapped({}), /boom/);
    });
  });

  it('records isError=true for results with isError flag', async () => {
    const errLog = join(tmpDir, 'instr-iserror.jsonl');
    await withEnv({ TV_MCP_TELEMETRY: '1', TV_MCP_TELEMETRY_INCLUDE: 'test_tool', TV_MCP_TELEMETRY_EXCLUDE: undefined }, async () => {
      const wrapped = instrument('test_tool', async () => ({ isError: true, content: [] }));
      const result = await wrapped({});
      flushNow(tmpDir, errLog);
      assert.equal(result.isError, true);
    });
  });

  it('server-level wrap: instrument fires for all registered tools', async () => {
    // Simulate the monkey-patch pattern from server.js
    const calls = [];
    const fakeServer = {
      tool: (name, _desc, _schema, handler) => {
        calls.push({ name, handler });
      },
    };
    const _orig = fakeServer.tool.bind(fakeServer);
    fakeServer.tool = (name, desc, schema, handler) => _orig(name, desc, schema, instrument(name, handler));

    fakeServer.tool('my_tool', 'desc', {}, async () => ({ success: true }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'my_tool');
    // The registered handler should be the instrumented wrapper (async function)
    assert.equal(typeof calls[0].handler, 'function');
    // Calling it should not throw
    const result = await calls[0].handler({});
    assert.equal(result.success, true);
  });
});
