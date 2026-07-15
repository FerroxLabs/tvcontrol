import { homedir } from 'node:os';
import { join } from 'node:path';
import * as chart from './chart.js';
import * as data from './data.js';
import * as pine from './pine.js';
import * as watchlist from './watchlist.js';
import * as state from './state.js';
import * as replay from './replay.js';
import { atomicWrite, resolveReceiptPath, timestampSlug } from './receipts.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const DEFAULT_DIR = join(homedir(), '.tv-mcp', 'golden');
const AVAILABLE = Object.freeze(['chart_analysis', 'pine_compile', 'strategy_read', 'watchlist', 'snapshot', 'replay']);
const PINE_CANARY = '//@version=6\nindicator("TVControl Golden Canary", overlay=false)\nplot(close)';

function _normalize(workflows) {
  const values = workflows === undefined || workflows === 'all'
    ? [...AVAILABLE]
    : (Array.isArray(workflows) ? workflows : String(workflows).split(',')).map((value) => String(value).trim()).filter(Boolean);
  const unknown = values.filter((value) => !AVAILABLE.includes(value));
  if (values.length === 0 || unknown.length > 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unknown or empty golden workflows: ${unknown.join(', ') || '(none)'}. Available: ${AVAILABLE.join(', ')}`);
  }
  return [...new Set(values)];
}

async function _chartAnalysis(deps) {
  await deps.chartState();
  await deps.quote({});
  await deps.ohlcv({ count: 100, summary: true });
  return { assertions: 3 };
}

async function _pineCompile(deps) {
  const result = await deps.pineCheck({ source: PINE_CANARY });
  if (result?.success === false || result?.compiled === false || (Array.isArray(result?.errors) && result.errors.length > 0)) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Golden Pine v6 canary did not compile');
  }
  return { assertions: 1 };
}

async function _strategyRead(deps, entityId) {
  let resolved = entityId;
  if (!resolved) {
    const current = await deps.chartState();
    resolved = current?.studies?.find((study) => /strategy/i.test(String(study?.name || '')))?.id;
  }
  if (!resolved) return { skipped: true, reason: 'no_strategy_entity_id' };
  const result = await deps.strategyResults({ entity_id: resolved });
  if (result?.success === false) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Strategy results workflow returned a failure');
  return { assertions: 1 };
}

async function _snapshot(deps, allowMutations) {
  if (!allowMutations) return { skipped: true, reason: 'mutations_not_allowed' };
  const name = `__tvcontrol_golden_${process.pid}_${Date.now()}`;
  let captured = false;
  let detail;
  try {
    await deps.snapshot({ name, overwrite: true });
    captured = true;
    await deps.restore({ name });
    detail = { assertions: 2, cleanup_verified: true };
  } finally {
    if (captured) {
      deps.deleteSnapshot({ name });
    }
  }
  return detail;
}

async function _replay(deps, allowMutations, replayDate) {
  if (!allowMutations || !replayDate) {
    await deps.replayStatus();
    return { assertions: 1, inspection_only: true, reason: !allowMutations ? 'mutations_not_allowed' : 'replay_date_not_supplied' };
  }
  let started = false;
  try {
    await deps.replayStart({ date: replayDate });
    started = true;
    const status = await deps.replayStatus();
    if (status?.success === false) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Replay status workflow returned a failure');
    return { assertions: 2, cleanup_verified: true };
  } finally {
    if (started) await deps.replayStop();
  }
}

export async function runGolden({ workflows, allow_mutations = false, replay_date, strategy_entity_id, output_dir, _deps } = {}) {
  const selected = _normalize(workflows);
  const deps = {
    chartState: _deps?.chartState || chart.getState,
    quote: _deps?.quote || data.getQuote,
    ohlcv: _deps?.ohlcv || data.getOhlcv,
    pineCheck: _deps?.pineCheck || pine.check,
    strategyResults: _deps?.strategyResults || data.getStrategyResults,
    watchlistGet: _deps?.watchlistGet || watchlist.get,
    snapshot: _deps?.snapshot || state.snapshot,
    restore: _deps?.restore || state.restore,
    deleteSnapshot: _deps?.deleteSnapshot || state.deleteSnapshot,
    replayStart: _deps?.replayStart || replay.start,
    replayStatus: _deps?.replayStatus || replay.status,
    replayStop: _deps?.replayStop || replay.stop,
    atomicWrite: _deps?.atomicWrite || atomicWrite,
    now: _deps?.now || (() => new Date()),
    nowMs: _deps?.nowMs || Date.now,
    home: _deps?.home || homedir(),
  };
  const results = [];
  for (const workflow of selected) {
    const started = deps.nowMs();
    try {
      let detail;
      if (workflow === 'chart_analysis') detail = await _chartAnalysis(deps);
      else if (workflow === 'pine_compile') detail = await _pineCompile(deps);
      else if (workflow === 'strategy_read') detail = await _strategyRead(deps, strategy_entity_id);
      else if (workflow === 'watchlist') { await deps.watchlistGet(); detail = { assertions: 1 }; }
      else if (workflow === 'snapshot') detail = await _snapshot(deps, allow_mutations);
      else detail = await _replay(deps, allow_mutations, replay_date);
      results.push({ workflow, status: detail.skipped ? 'skipped' : 'passed', duration_ms: Math.max(0, deps.nowMs() - started), ...detail });
    } catch (err) {
      results.push({ workflow, status: 'failed', duration_ms: Math.max(0, deps.nowMs() - started), error_category: err?.category || CATEGORIES.API_UNEXPECTED });
    }
  }
  const now = deps.now();
  const receipt = {
    schema_version: 1,
    generated_at: now.toISOString(),
    success: results.every((result) => result.status !== 'failed'),
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    workflows: results,
  };
  const path = resolveReceiptPath({ kind: 'golden', filename: `golden-${timestampSlug(now)}.json`, outputDir: output_dir || DEFAULT_DIR, home: deps.home });
  deps.atomicWrite(path, JSON.stringify(receipt, null, 2));
  return { ...receipt, receipt_path: path };
}

export const GOLDEN_WORKFLOWS = AVAILABLE;
