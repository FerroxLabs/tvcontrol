import { homedir } from 'node:os';
import { join } from 'node:path';
import { healthCheck } from './health.js';
import { sampleWatchdog } from './watchdog.js';
import { getOhlcv } from './data.js';
import * as state from './state.js';
import { strategySweep } from './sweep.js';
import { atomicWrite, resolveReceiptPath, timestampSlug } from './receipts.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const DEFAULT_DIR = join(homedir(), '.tv-mcp', 'soak');
const AVAILABLE = Object.freeze(['health', 'stream', 'watchdog', 'restore', 'sweep']);
const MUTATING = new Set(['restore', 'sweep']);
const MAX_FAILURES = 20;

function _abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function _normalize(scenarios) {
  const values = scenarios === undefined
    ? ['health', 'stream', 'watchdog']
    : (Array.isArray(scenarios) ? scenarios : String(scenarios).split(',')).map((value) => String(value).trim()).filter(Boolean);
  const unknown = values.filter((value) => !AVAILABLE.includes(value));
  if (values.length === 0 || unknown.length > 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unknown or empty soak scenarios: ${unknown.join(', ') || '(none)'}. Available: ${AVAILABLE.join(', ')}`);
  }
  return [...new Set(values)];
}

function _percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function _runScenario(name, iteration, deps, sweepConfig) {
  if (name === 'health') {
    const result = await deps.healthCheck();
    if (result?.healthy !== true) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Health soak sample was degraded');
    return;
  }
  if (name === 'stream') {
    const result = await deps.getOhlcv({ count: 1, summary: true });
    if (result?.success === false) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'OHLCV stream sample failed');
    return;
  }
  if (name === 'watchdog') {
    const result = await deps.sampleWatchdog();
    if (result?.success === false) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Watchdog soak sample failed');
    return;
  }
  if (name === 'restore') {
    const snapshotName = `__tvcontrol_soak_${process.pid}_${iteration}`;
    try {
      await deps.snapshot({ name: snapshotName, overwrite: true });
      await deps.restore({ name: snapshotName });
    } finally {
      try { deps.deleteSnapshot({ name: snapshotName }); } catch (_) {}
    }
    return;
  }
  if (!sweepConfig || typeof sweepConfig !== 'object') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'sweep soak scenario requires a sweep_config object');
  }
  await deps.strategySweep(sweepConfig);
}

export async function runSoak({
  scenarios,
  duration_ms = 60_000,
  interval_ms = 5_000,
  max_samples = 100_000,
  allow_mutations = false,
  sweep_config,
  output_dir,
  signal,
  _deps,
} = {}) {
  const selected = _normalize(scenarios);
  const durationMs = Number(duration_ms);
  const intervalMs = Number(interval_ms);
  const maxSamples = Number(max_samples);
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'soak duration_ms must be an integer from 1 to 86400000');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'soak interval_ms must be an integer from 250 to 300000');
  }
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 100_000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'soak max_samples must be an integer from 1 to 100000');
  }
  const blocked = selected.filter((name) => MUTATING.has(name));
  if (blocked.length > 0 && !allow_mutations) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Mutating soak scenarios require allow_mutations=true: ${blocked.join(', ')}`);
  }
  const deps = {
    healthCheck: _deps?.healthCheck || healthCheck,
    getOhlcv: _deps?.getOhlcv || getOhlcv,
    sampleWatchdog: _deps?.sampleWatchdog || sampleWatchdog,
    snapshot: _deps?.snapshot || state.snapshot,
    restore: _deps?.restore || state.restore,
    deleteSnapshot: _deps?.deleteSnapshot || state.deleteSnapshot,
    strategySweep: _deps?.strategySweep || strategySweep,
    atomicWrite: _deps?.atomicWrite || atomicWrite,
    nowMs: _deps?.nowMs || Date.now,
    now: _deps?.now || (() => new Date()),
    sleep: _deps?.sleep || _abortableSleep,
    home: _deps?.home || homedir(),
  };
  const startedMs = deps.nowMs();
  const durations = [];
  const failures = [];
  const perScenario = Object.fromEntries(selected.map((name) => [name, { samples: 0, passed: 0, failed: 0 }]));
  let samples = 0;
  let cancelled = false;
  let iteration = 0;

  while (samples < maxSamples && deps.nowMs() - startedMs < durationMs) {
    if (signal?.aborted) { cancelled = true; break; }
    iteration++;
    for (const name of selected) {
      if (signal?.aborted || samples >= maxSamples || deps.nowMs() - startedMs >= durationMs) break;
      const started = deps.nowMs();
      try {
        await _runScenario(name, iteration, deps, sweep_config);
        perScenario[name].passed++;
      } catch (err) {
        perScenario[name].failed++;
        failures.push({ scenario: name, iteration, error_category: err?.category || CATEGORIES.API_UNEXPECTED });
        if (failures.length > MAX_FAILURES) failures.shift();
      }
      const elapsed = Math.max(0, deps.nowMs() - started);
      durations.push(elapsed);
      if (durations.length > maxSamples) durations.shift();
      perScenario[name].samples++;
      samples++;
    }
    if (signal?.aborted) { cancelled = true; break; }
    if (samples < maxSamples && deps.nowMs() - startedMs < durationMs) await deps.sleep(intervalMs, signal);
  }
  cancelled ||= signal?.aborted === true;
  const now = deps.now();
  const failed = Object.values(perScenario).reduce((sum, item) => sum + item.failed, 0);
  const receipt = {
    schema_version: 1,
    generated_at: now.toISOString(),
    success: failed === 0 && !cancelled,
    cancelled,
    elapsed_ms: Math.max(0, deps.nowMs() - startedMs),
    samples,
    failures: failures.slice(-MAX_FAILURES),
    latency_ms: {
      min: durations.length ? Math.min(...durations) : null,
      max: durations.length ? Math.max(...durations) : null,
      average: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
      p95: _percentile(durations, 0.95),
    },
    scenarios: perScenario,
  };
  const path = resolveReceiptPath({ kind: 'soak', filename: `soak-${timestampSlug(now)}.json`, outputDir: output_dir || DEFAULT_DIR, home: deps.home });
  deps.atomicWrite(path, JSON.stringify(receipt, null, 2));
  return { ...receipt, receipt_path: path };
}

export const SOAK_SCENARIOS = AVAILABLE;
