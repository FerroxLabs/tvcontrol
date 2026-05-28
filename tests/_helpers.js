/**
 * Shared test helpers for tradingview-mcp.
 *
 * Two mock evaluate patterns exist in the codebase:
 *   1. Tracking-only — used where the test inspects .calls after the fact (sanitization-style).
 *   2. Scripted — used where the core function polls and the mock must return different values
 *      across calls (replay-style with response-map + optional sequence).
 *
 * Both patterns are exported so consumers can pick the right one. Keep local aliases if helpful.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

/**
 * Tracking-only mock evaluate. Returns undefined for every call.
 * Attaches `.calls` (array) for post-hoc inspection.
 * @returns {Function & { calls: string[] }}
 */
export function mockEvaluate() {
  const calls = [];
  const fn = async (expr) => { calls.push(expr); return undefined; };
  fn.calls = calls;
  return fn;
}

/**
 * Scripted mock evaluate.
 * @param {Record<string, any>} responses — map of expression substring → return value (function or value).
 *   The first key whose substring appears in the expression wins.
 * @param {Array<any>} [sequence] — if provided, the N-th call returns sequence[N] (overrides responses).
 * @returns {Function & { calls: string[] }}
 */
export function mockScriptedEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Build a `_deps` object backed by a tracking-only evaluate.
 * @param {object} [overrides] — override specific _deps fields.
 * @returns {{ _deps: object, evaluate: Function }}
 */
export function emptyDeps(overrides = {}) {
  const evaluate = mockEvaluate();
  return {
    _deps: {
      evaluate,
      evaluateAsync: evaluate,
      waitForChartReady: async () => true,
      getChartApi: async () => 'window.__api',
      getReplayApi: async () => 'window.__rp',
      getChartCollection: async () => 'window.__cwc',
      ...overrides,
    },
    evaluate,
  };
}

/**
 * Build a `_deps` object backed by a scripted evaluate.
 * @param {Record<string, any>} [responses]
 * @param {Array<any>} [sequence]
 * @returns {{ _deps: object, evaluate: Function }}
 */
export function scriptedDeps(responses = {}, sequence) {
  const evaluate = mockScriptedEvaluate(responses, sequence);
  return {
    _deps: {
      evaluate,
      evaluateAsync: evaluate,
      waitForChartReady: async () => true,
      getChartApi: async () => 'window.__api',
      getReplayApi: async () => 'window.__rp',
      getChartCollection: async () => 'window.__cwc',
    },
    evaluate,
  };
}

/**
 * Load a JSON fixture from tests/fixtures/<name>.json.
 * Throws if the fixture does not exist.
 */
export function loadFixture(name) {
  const path = join(FIXTURES_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Load a raw (unparsed) fixture. Useful for HTML snippets or text.
 * @param {string} name - filename base
 * @param {string} [ext='html'] - file extension
 */
export function loadFixtureRaw(name, ext = 'html') {
  const path = join(FIXTURES_DIR, `${name}.${ext}`);
  return readFileSync(path, 'utf8');
}
