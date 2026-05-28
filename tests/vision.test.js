/**
 * Offline tests for src/core/vision.js — chartVisionRead().
 * All screenshot I/O is mocked via _deps. No real CDP or filesystem writes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { chartVisionRead } from '../src/core/vision.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tiny fake PNG bytes — 50 bytes, well under 1.5 MB. */
const FAKE_PNG = Buffer.alloc(50, 0xff);

/** Build a _deps object with all core fns stubbed to succeed. */
function makeDeps(overrides = {}) {
  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'tv-vision-test-'));
  } catch { tmpDir = tmpdir(); }

  const filePath = join(tmpDir, 'vision-fake.png');
  writeFileSync(filePath, FAKE_PNG);

  return {
    _tmpDir: tmpDir,
    _filePath: filePath,
    _deps: {
      captureScreenshot: async () => ({ success: true, method: 'cdp', file_path: filePath }),
      getState: async () => ({ success: true, symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] }),
      getQuote: async () => ({ success: true, symbol: 'AAPL', last: 150.00 }),
      getStudyValues: async () => ({ success: true, study_count: 0, studies: [] }),
      getPineLines: async () => ({ success: true, study_count: 0, studies: [] }),
      getPineLabels: async () => ({ success: true, study_count: 0, studies: [] }),
      getPineTables: async () => ({ success: true, study_count: 0, studies: [] }),
      getPineBoxes: async () => ({ success: true, study_count: 0, studies: [] }),
      getOhlcv: async () => ({ success: true, bar_count: 100, high: 151, low: 149 }),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chartVisionRead()', () => {

  it('1. default include fetches all sections', async () => {
    const { _deps } = makeDeps();
    const result = await chartVisionRead({ _deps });
    assert.ok(result.success);
    assert.ok('state' in result);
    assert.ok('quote' in result);
    assert.ok('study_values' in result);
    assert.ok('pine_lines' in result);
    assert.ok('pine_labels' in result);
    assert.ok('pine_tables' in result);
    assert.ok('pine_boxes' in result);
    assert.ok('ohlcv_summary' in result);
  });

  it('2. include=[image,quote] skips all other sections', async () => {
    const { _deps } = makeDeps();
    const result = await chartVisionRead({ include: ['image', 'quote'], _deps });
    assert.ok(result.success);
    assert.ok('quote' in result);
    assert.ok(!('state' in result));
    assert.ok(!('study_values' in result));
    assert.ok(!('pine_lines' in result));
    assert.ok(!('ohlcv_summary' in result));
  });

  it('2b. captureScreenshot is NOT called when "image" excluded from include', async () => {
    let captureCalls = 0;
    const { _deps } = makeDeps();
    _deps.captureScreenshot = async () => { captureCalls++; return { success: true, file_path: '/tmp/never' }; };
    const result = await chartVisionRead({ include: ['quote', 'state'], _deps });
    assert.equal(captureCalls, 0, 'captureScreenshot should NOT run when image not requested');
    assert.equal(result.image_mode, 'skipped');
    assert.equal(result.file_path, null);
  });

  it('3. max_image_bytes=100 forces file_only when image > limit', async () => {
    // FAKE_PNG is 50 bytes — use a larger buffer to exceed 100
    const { _tmpDir, _deps } = makeDeps();
    const bigPath = join(_tmpDir, 'big.png');
    writeFileSync(bigPath, Buffer.alloc(200, 0xab));
    _deps.captureScreenshot = async () => ({ success: true, method: 'cdp', file_path: bigPath });

    const result = await chartVisionRead({ max_image_bytes: 100, _deps });
    assert.equal(result.image_mode, 'file_only');
    assert.ok(!('image_base64' in result));
  });

  it('4. image_mode=inline includes image_base64 when bytes <= limit', async () => {
    // FAKE_PNG is 50 bytes, default limit is 1.5 MB
    const { _deps } = makeDeps();
    const result = await chartVisionRead({ include: ['image'], _deps });
    assert.equal(result.image_mode, 'inline');
    assert.ok(typeof result.image_base64 === 'string');
    assert.ok(result.image_base64.length > 0);
    assert.equal(result.image_size_bytes, FAKE_PNG.length);
  });

  it('5. one failing section pushes to warnings, does not throw', async () => {
    const { _deps } = makeDeps({
      getQuote: async () => { throw new Error('quote failed'); },
    });
    const result = await chartVisionRead({ _deps });
    assert.ok(result.success);
    assert.ok(Array.isArray(result.warnings));
    const warn = result.warnings.find(w => w.section === 'quote');
    assert.ok(warn, 'expected warning for quote section');
    assert.equal(warn.error, 'quote failed');
    // Other sections still present
    assert.ok('state' in result);
  });

  it('5b. failed section writes structured stub to result[section]', async () => {
    // Use a ClassifiedError-shaped object to verify category propagation.
    class ClassErr extends Error { constructor(m, cat, hint) { super(m); this.category = cat; this.hint = hint; } }
    const { _deps } = makeDeps({
      getPineLines: async () => { throw new ClassErr('pine boom', 'tv_ui_changed', 'restart TV'); },
    });
    const result = await chartVisionRead({ _deps });
    assert.ok(result.success);
    // Caller can now branch on result.pine_lines instead of guessing from absence.
    assert.ok(result.pine_lines, 'failed section must populate result[section]');
    assert.equal(result.pine_lines.success, false);
    assert.equal(result.pine_lines.error, 'pine boom');
    assert.equal(result.pine_lines.category, 'tv_ui_changed');
    assert.equal(result.pine_lines.hint, 'restart TV');
    // Sections that succeeded look unchanged.
    assert.ok(result.state && !('error' in result.state));
  });

  it('5c. excluded section is absent from result (caller can distinguish from failed)', async () => {
    const { _deps } = makeDeps();
    const result = await chartVisionRead({ include: ['state'], _deps });
    assert.ok('state' in result);
    assert.ok(!('quote' in result), 'quote was not requested → key absent');
    assert.ok(!('pine_lines' in result));
  });

  it('6. mime_type is always image/png', async () => {
    const { _deps } = makeDeps();
    const result = await chartVisionRead({ _deps });
    assert.equal(result.mime_type, 'image/png');
  });

  it('7a. sections fan out in parallel (total time ≈ slowest section, not sum)', async () => {
    const SECTION_DELAY_MS = 50;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const slow = (val) => async () => { await sleep(SECTION_DELAY_MS); return val; };

    const { _deps } = makeDeps({
      getState:        slow({ success: true, symbol: 'X', resolution: 'D', chartType: 1, studies: [] }),
      getQuote:        slow({ success: true, symbol: 'X', last: 1 }),
      getStudyValues:  slow({ success: true, study_count: 0, studies: [] }),
      getPineLines:    slow({ success: true, study_count: 0, studies: [] }),
      getPineLabels:   slow({ success: true, study_count: 0, studies: [] }),
      getPineTables:   slow({ success: true, study_count: 0, studies: [] }),
      getPineBoxes:    slow({ success: true, study_count: 0, studies: [] }),
      getOhlcv:        slow({ success: true, bar_count: 0 }),
    });

    const t0 = Date.now();
    const result = await chartVisionRead({ _deps });
    const elapsed = Date.now() - t0;
    assert.ok(result.success);
    // 8 sections × 50ms serial = 400ms. Parallel = ~50ms. Cap at 200ms to give CI breathing room.
    assert.ok(elapsed < 200, `expected parallel fan-out (<200ms), got ${elapsed}ms`);
  });

  it('7. file_path always present regardless of image_mode', async () => {
    // file_only case (large image)
    const { _tmpDir, _deps: depsLarge } = makeDeps();
    const largePath = join(_tmpDir, 'large.png');
    writeFileSync(largePath, Buffer.alloc(300, 0xcc));
    depsLarge.captureScreenshot = async () => ({ success: true, method: 'cdp', file_path: largePath });
    const largeResult = await chartVisionRead({ max_image_bytes: 100, _deps: depsLarge });
    assert.equal(largeResult.image_mode, 'file_only');
    assert.ok(typeof largeResult.file_path === 'string');
    assert.ok(largeResult.file_path.length > 0);

    // inline case
    const { _deps: depsSmall } = makeDeps();
    const smallResult = await chartVisionRead({ _deps: depsSmall });
    assert.equal(smallResult.image_mode, 'inline');
    assert.ok(typeof smallResult.file_path === 'string');
    assert.ok(smallResult.file_path.length > 0);
  });

});
