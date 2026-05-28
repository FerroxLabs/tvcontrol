/**
 * Opt-in JSONL session telemetry.
 * Enable with TV_MCP_TELEMETRY=1. Off by default.
 *
 * Log file: ~/.tv-mcp/session.jsonl
 * Format: {"ts":"ISO","tool":"...","success":true,"duration_ms":42,"error":"...","category":"..."}
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(homedir(), '.tv-mcp');
const LOG_PATH = join(LOG_DIR, 'session.jsonl');
const ROTATION_BYTES = 10 * 1024 * 1024; // 10MB
const FLUSH_INTERVAL_MS = 500;
// PIPE_BUF on macOS is 512 and on Linux 4096. Keep every appendFileSync write
// at or below MAX_BATCH_BYTES so concurrent writers cannot interleave.
const MAX_BATCH_BYTES = 4000;
// Cap a single record so it can never exceed MAX_BATCH_BYTES on its own.
// A line longer than this is truncated (preserving valid JSON) before queueing.
const MAX_LINE_BYTES = 3900;
// These names must match the `server.tool(name, ...)` registrations EXACTLY.
// If you rename one of the tools below, update this Set or the rename-target
// will silently start being telemetered (which the user opted OUT of via the
// default exclude). Drift is enforced by the
// "telemetry DEFAULT_EXCLUDE entries match real registered tool names (L9)"
// test in tests/integration.test.js — it parses this Set literally from
// source and asserts each entry is a registered tool name.
const DEFAULT_EXCLUDE = new Set([
  'tv_health_check',  // polled constantly by health checks
  'chart_get_state',  // polled by every read workflow
]);

// Security-sensitive tools are ALWAYS logged for audit, even when telemetry is
// otherwise disabled and even if a user puts them in TV_MCP_TELEMETRY_EXCLUDE.
// ui_evaluate runs arbitrary JS in the authenticated TradingView page (full
// RCE surface); every invocation must leave a trace on disk so an operator can
// reconstruct what was executed. This is a hard floor, not an opt-in.
const FORCE_LOG = new Set([
  'ui_evaluate',
]);

let _queue = [];
let _flushTimer = null;

export function isEnabled() {
  return process.env.TV_MCP_TELEMETRY === '1';
}

export function shouldLog(toolName) {
  // Hard floor: security-sensitive tools are logged unconditionally, before
  // the enable/exclude checks below can suppress them.
  if (FORCE_LOG.has(toolName)) return true;
  if (!isEnabled()) return false;
  if (toolName.startsWith('stream_')) return false;
  // Env var overrides: TV_MCP_TELEMETRY_INCLUDE, TV_MCP_TELEMETRY_EXCLUDE (comma-separated)
  const includeRaw = process.env.TV_MCP_TELEMETRY_INCLUDE || '';
  const excludeRaw = process.env.TV_MCP_TELEMETRY_EXCLUDE || '';
  const include = includeRaw ? new Set(includeRaw.split(',').map(s => s.trim())) : null;
  const exclude = excludeRaw ? new Set(excludeRaw.split(',').map(s => s.trim())) : DEFAULT_EXCLUDE;
  if (include) return include.has(toolName);
  return !exclude.has(toolName);
}

export function record({ tool, success, duration_ms, error, category, _logDir = LOG_DIR, _logPath = LOG_PATH }) {
  if (!shouldLog(tool)) return;
  const line = _serializeBounded({ tool, success, duration_ms, error, category });
  _queue.push(line);
  _scheduleFlush(_logDir, _logPath);
}

function _serializeBounded({ tool, success, duration_ms, error, category }) {
  const base = {
    ts: new Date().toISOString(),
    tool, success,
    duration_ms,
    ...(error && { error }),
    ...(category && { category }),
  };
  let line = JSON.stringify(base) + '\n';
  if (line.length <= MAX_LINE_BYTES) return line;
  // Over the cap — truncate the error field (most likely the bloat source).
  if (typeof base.error === 'string') {
    const overshoot = line.length - MAX_LINE_BYTES;
    const room = base.error.length - overshoot - 16; // 16 bytes for "...[truncated]"
    base.error = room > 0 ? base.error.slice(0, room) + '...[truncated]' : '[truncated]';
    line = JSON.stringify(base) + '\n';
  }
  // Last resort: keep category + a head/tail preview so operators searching
  // for failures still get a meaningful signal — never drop everything.
  if (line.length > MAX_LINE_BYTES) {
    if (typeof base.error === 'string' && base.error.length > 200) {
      const head = base.error.slice(0, 100);
      const tail = base.error.slice(-100);
      base.error = `${head}...[truncated middle]...${tail}`;
    }
    base.note = 'record exceeded line cap; error truncated, category preserved';
    line = JSON.stringify(base) + '\n';
  }
  // Ultra-pathological: even after preview-truncation the line is still too
  // big (e.g. tool name itself is huge). Drop error but keep category.
  if (line.length > MAX_LINE_BYTES) {
    delete base.error;
    base.note = 'record exceeded line cap; error dropped, category preserved';
    line = JSON.stringify(base) + '\n';
  }
  return line;
}

function _scheduleFlush(_logDir, _logPath) {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushNow(_logDir, _logPath);
  }, FLUSH_INTERVAL_MS);
  // Don't keep the node process alive just for this timer — let it be
  // drained at beforeExit instead. Critical when tests import modules that
  // trigger record() (e.g. via instrument wrapper).
  if (_flushTimer && typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

export function flushNow(_logDir = LOG_DIR, _logPath = LOG_PATH) {
  if (_queue.length === 0) return;
  // Snapshot the queue and clear ONLY after every appendFileSync succeeds.
  // Earlier code cleared mid-loop, which lost any buffered records if the
  // final write threw (disk full, EACCES). On any failure we keep the
  // snapshot so the next flush retries, but cap retention to avoid unbounded
  // growth in pathological disk-full scenarios (~256KB ceiling).
  const drained = _queue.slice();
  try {
    mkdirSync(_logDir, { recursive: true });
    rotateIfNeeded(_logPath);
    // Each appendFileSync call must be ≤ MAX_BATCH_BYTES so concurrent writers
    // can't interleave (PIPE_BUF guarantees atomicity below that threshold).
    // record() already caps individual line length to MAX_LINE_BYTES so a single
    // line can never exceed the batch budget on its own.
    let batch = '';
    for (const line of drained) {
      if (batch.length + line.length > MAX_BATCH_BYTES && batch.length > 0) {
        appendFileSync(_logPath, batch);
        batch = '';
      }
      batch += line;
    }
    if (batch.length > 0) appendFileSync(_logPath, batch);
    // All writes succeeded — drop the drained portion from the live queue.
    _queue.splice(0, drained.length);
  } catch {
    // Best-effort: if writes failed mid-flush, leave the queue alone so the
    // next flush retries. Cap at 64KB worth of retained records to bound
    // memory growth on a persistently-failing disk.
    const RETENTION_LIMIT_BYTES = 64 * 1024;
    let total = 0;
    for (const l of _queue) total += l.length;
    while (total > RETENTION_LIMIT_BYTES && _queue.length > 0) {
      total -= _queue[0].length;
      _queue.shift();
    }
  }
}

function rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < ROTATION_BYTES) return;
    // Explicitly drop segment .3 (oldest), then shift .2→.3, .1→.2, current→.1
    if (existsSync(path + '.3')) unlinkSync(path + '.3');
    if (existsSync(path + '.2')) renameSync(path + '.2', path + '.3');
    if (existsSync(path + '.1')) renameSync(path + '.1', path + '.2');
    renameSync(path, path + '.1');
  } catch { /* best effort */ }
}

// Flush on every reasonable exit path so users with TV_MCP_TELEMETRY=1
// don't lose their session log to Ctrl-C or an uncaught exception (which
// is exactly the case telemetry was meant to capture).
process.on('beforeExit', () => flushNow());
process.on('SIGTERM', () => flushNow());
process.on('SIGINT', () => { flushNow(); process.exit(130); });
process.on('uncaughtException', (err) => {
  // Best-effort flush, then re-raise so the runtime takes its default action
  // (process exits with code 1 and prints the stack).
  try { flushNow(); } catch { /* never let flush mask the real error */ }
  // Re-raise asynchronously so the original handler still sees the exception
  // — synchronously throwing from inside this listener would be swallowed.
  setImmediate(() => { throw err; });
});

export function tail({ n = 50, _logPath = LOG_PATH } = {}) {
  if (!existsSync(_logPath)) return [];
  const lines = readFileSync(_logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

export function clear({ _logPath = LOG_PATH } = {}) {
  if (!existsSync(_logPath)) return { cleared: false };
  writeFileSync(_logPath, '');
  return { cleared: true };
}
