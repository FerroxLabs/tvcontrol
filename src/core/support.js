import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { healthCheck, compatibilityCheck, compatibilitySnapshot } from './health.js';
import { watchdogHistory } from './watchdog.js';
import { getCapabilityMatrix } from './capabilities.js';
import { tail } from './telemetry.js';
import { atomicWrite, resolveReceiptPath, timestampSlug } from './receipts.js';

const DEFAULT_DIR = join(homedir(), '.tv-mcp', 'support');
const DROP_KEY = /(?:symbol|ticker|url|title|account|email|message|error|raw|command|args|source|script|token|cookie|session|chart[_-]?id|layout[_-]?id|entity[_-]?id|file[_-]?path|target)/i;
const MAX_STRING = 500;

function _sanitizeString(value, home) {
  return value
    .replaceAll(home, '~')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g, '[redacted-secret]')
    .replace(/([?&](?:token|session|auth|key|id)=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, MAX_STRING);
}

export function redactSupportValue(value, { home = homedir(), depth = 0 } = {}) {
  if (depth > 12) return '[depth-limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return _sanitizeString(value, home);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactSupportValue(item, { home, depth: depth + 1 }));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      if (DROP_KEY.test(key)) continue;
      result[key] = redactSupportValue(item, { home, depth: depth + 1 });
    }
    return result;
  }
  return String(value).slice(0, MAX_STRING);
}

async function _settle(name, fn, home) {
  try { return [name, { ok: true, value: redactSupportValue(await fn(), { home }) }]; }
  catch (err) { return [name, { ok: false, error_category: err?.category || 'api_unexpected' }]; }
}

export async function createSupportBundle({ output_dir, telemetry_lines = 100, _deps } = {}) {
  const limit = Math.max(0, Math.min(500, Number(telemetry_lines) || 0));
  const deps = {
    healthCheck: _deps?.healthCheck || healthCheck,
    compatibilityCheck: _deps?.compatibilityCheck || compatibilityCheck,
    compatibilitySnapshot: _deps?.compatibilitySnapshot || compatibilitySnapshot,
    watchdogHistory: _deps?.watchdogHistory || watchdogHistory,
    getCapabilityMatrix: _deps?.getCapabilityMatrix || getCapabilityMatrix,
    tail: _deps?.tail || tail,
    atomicWrite: _deps?.atomicWrite || atomicWrite,
    now: _deps?.now || (() => new Date()),
    home: _deps?.home || homedir(),
  };
  const packagePath = join(fileURLToPath(new URL('../..', import.meta.url)), 'package.json');
  let version = null;
  try { version = JSON.parse(readFileSync(packagePath, 'utf8')).version || null; } catch (_) {}
  const sections = Object.fromEntries(await Promise.all([
    _settle('health', deps.healthCheck, deps.home),
    _settle('compatibility', deps.compatibilityCheck, deps.home),
    _settle('compatibility_baseline', () => deps.compatibilitySnapshot({ action: 'compare' }), deps.home),
    _settle('watchdog', () => deps.watchdogHistory({ limit: 100 }), deps.home),
    _settle('capabilities', () => deps.getCapabilityMatrix({ probe: true }), deps.home),
    _settle('telemetry', () => deps.tail({ n: limit }), deps.home),
  ]));
  const now = deps.now();
  const payload = {
    schema_version: 1,
    generated_at: now.toISOString(),
    privacy: 'Identifiers, symbols, URLs, titles, source code, account data, and secret-like values are removed.',
    environment: { platform: platform(), arch: arch(), node: process.version, tvcontrol_version: version },
    sections,
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload, null, 2)), { level: 9 });
  const path = resolveReceiptPath({
    kind: 'support',
    filename: `tvcontrol-support-${timestampSlug(now)}.json.gz`,
    outputDir: output_dir || DEFAULT_DIR,
    home: deps.home,
  });
  deps.atomicWrite(path, compressed);
  return {
    success: true,
    file_path: path,
    bytes: compressed.byteLength,
    sha256: createHash('sha256').update(compressed).digest('hex'),
    sections: Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, section.ok ? 'included' : `unavailable:${section.error_category}`])),
  };
}
