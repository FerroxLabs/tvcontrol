import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReceiptPath } from '../src/core/receipts.js';

test('receipt paths default beneath the TVControl data directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'tvcontrol-home-'));
  try {
    assert.equal(
      resolveReceiptPath({ kind: 'soak', filename: 'run.json', home }),
      join(realpathSync(home), '.tv-mcp', 'soak', 'run.json'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('receipt paths allow an explicit nested TVControl directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'tvcontrol-home-'));
  try {
    const outputDir = join(home, '.tv-mcp', 'custom');
    assert.equal(
      resolveReceiptPath({ kind: 'soak', filename: 'run.json', outputDir, home }),
      join(realpathSync(home), '.tv-mcp', 'custom', 'run.json'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('receipt paths reject traversal outside the TVControl data directory', () => {
  assert.throws(
    () => resolveReceiptPath({ kind: 'soak', filename: 'run.json', outputDir: '/Users/alice/.tv-mcp/../Desktop', home: '/Users/alice' }),
    (error) => error.category === 'invalid_argument',
  );
});

test('receipt paths reject an in-boundary symlink that escapes the data directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'tvcontrol-receipts-'));
  try {
    const home = join(root, 'home');
    const data = join(home, '.tv-mcp');
    const outside = join(root, 'outside');
    mkdirSync(data, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(data, 'escape'), 'dir');
    assert.throws(
      () => resolveReceiptPath({ kind: 'soak', filename: 'run.json', outputDir: join(data, 'escape'), home }),
      (error) => error.category === 'invalid_argument',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
