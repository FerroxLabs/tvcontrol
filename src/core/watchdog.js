/**
 * Read-only TradingView health watchdog.
 *
 * It records state transitions only (not every sample), bounds history, and
 * deliberately excludes chart symbols, URLs, account data, and page content.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { healthCheck } from './health.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const HISTORY_PATH = join(homedir(), '.tv-mcp', 'watchdog-incidents.json');
const MAX_HISTORY = 500;
const DEFAULT_INTERVAL_MS = 15_000;

let timer = null;
let startedAt = null;
let intervalMs = null;
let lastSample = null;
let lastStateKey = null;
let sampleInFlight = null;

function _deps(overrides) {
  return {
    healthCheck: overrides?.healthCheck || healthCheck,
    historyPath: overrides?.historyPath || HISTORY_PATH,
    existsSync: overrides?.existsSync || existsSync,
    mkdirSync: overrides?.mkdirSync || mkdirSync,
    readFileSync: overrides?.readFileSync || readFileSync,
    renameSync: overrides?.renameSync || renameSync,
    writeFileSync: overrides?.writeFileSync || writeFileSync,
    now: overrides?.now || (() => new Date()),
  };
}

function _readHistory(deps) {
  if (!deps.existsSync(deps.historyPath)) return [];
  try {
    const value = JSON.parse(deps.readFileSync(deps.historyPath, 'utf8'));
    return Array.isArray(value?.incidents) ? value.incidents.slice(-MAX_HISTORY) : [];
  } catch (_) {
    return [];
  }
}

function _writeHistory(incidents, deps) {
  deps.mkdirSync(dirname(deps.historyPath), { recursive: true });
  const tmp = `${deps.historyPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  deps.writeFileSync(tmp, JSON.stringify({ schema_version: 1, incidents: incidents.slice(-MAX_HISTORY) }, null, 2));
  deps.renameSync(tmp, deps.historyPath);
}

function _safeSample(result, now) {
  return {
    at: now.toISOString(),
    state: result?.healthy === true ? 'healthy' : 'degraded',
    datafeed_state: String(result?.datafeed?.state || 'unknown').slice(0, 80),
    compatible: result?.compatibility?.compatible === true,
    desktop_version: result?.compatibility?.desktop_version || null,
    critical_missing: Array.isArray(result?.compatibility?.missing)
      ? result.compatibility.missing.map((value) => String(value).slice(0, 120)).slice(0, 30)
      : [],
  };
}

function _safeFailure(err, now) {
  return {
    at: now.toISOString(),
    state: 'unreachable',
    datafeed_state: 'unknown',
    compatible: false,
    desktop_version: null,
    critical_missing: [],
    error_category: err?.category || CATEGORIES.CDP_DISCONNECTED,
  };
}

function _stateKey(sample) {
  return JSON.stringify([
    sample.state,
    sample.datafeed_state,
    sample.compatible,
    sample.desktop_version,
    sample.critical_missing,
    sample.error_category || null,
  ]);
}

async function _sampleOnce(deps) {
  const now = deps.now();
  let sample;
  try {
    sample = _safeSample(await deps.healthCheck(), now);
  } catch (err) {
    sample = _safeFailure(err, now);
  }

  const history = _readHistory(deps);
  // CLI samples run in fresh processes. Seed the transition state from disk so
  // a restart does not manufacture another identical "healthy" incident.
  if (lastStateKey === null && history.length > 0) {
    lastStateKey = _stateKey(history[history.length - 1]);
  }
  const key = _stateKey(sample);
  const changed = key !== lastStateKey;
  if (changed) {
    history.push(sample);
    _writeHistory(history, deps);
    lastStateKey = key;
  }
  lastSample = sample;
  return { success: true, changed, sample };
}

export async function sampleWatchdog({ _deps } = {}) {
  // Coalesce overlapping timer/manual samples so a slow renderer cannot cause
  // an unbounded pile-up of health probes.
  if (sampleInFlight) return sampleInFlight;
  const deps = _deps ? _deps : undefined;
  sampleInFlight = _sampleOnce(_depsForSample(deps));
  try { return await sampleInFlight; }
  finally { sampleInFlight = null; }
}

function _depsForSample(overrides) {
  return _deps(overrides);
}

export async function startWatchdog({ interval_ms = DEFAULT_INTERVAL_MS, _deps } = {}) {
  const parsed = Number(interval_ms);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'watchdog interval_ms must be an integer from 1000 to 300000');
  }
  if (timer) return { success: true, started: false, reason: 'already_running', ...watchdogStatus() };

  intervalMs = parsed;
  startedAt = new Date().toISOString();
  await sampleWatchdog({ _deps });
  timer = setInterval(() => { void sampleWatchdog({ _deps }); }, parsed);
  if (typeof timer.unref === 'function') timer.unref();
  return { success: true, started: true, ...watchdogStatus() };
}

export function stopWatchdog() {
  const wasRunning = !!timer;
  if (timer) clearInterval(timer);
  timer = null;
  startedAt = null;
  intervalMs = null;
  return { success: true, stopped: wasRunning };
}

export function watchdogStatus() {
  return {
    running: !!timer,
    started_at: startedAt,
    interval_ms: intervalMs,
    last_sample: lastSample,
  };
}

export function watchdogHistory({ limit = 100, _deps } = {}) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `watchdog history limit must be an integer from 1 to ${MAX_HISTORY}`);
  }
  const incidents = _readHistory(_depsForSample(_deps));
  return { success: true, count: incidents.length, incidents: incidents.slice(-parsed) };
}

export function _resetWatchdogForTests() {
  stopWatchdog();
  lastSample = null;
  lastStateKey = null;
  sampleInFlight = null;
}
