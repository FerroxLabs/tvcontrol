#!/usr/bin/env node
import { sampleWatchdog } from '../src/core/watchdog.js';

const index = process.argv.indexOf('--interval-ms');
const intervalMs = index >= 0 ? Number(process.argv[index + 1]) : 15_000;
if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
  process.stderr.write('watchdog_daemon: --interval-ms must be an integer from 1000 to 300000\n');
  process.exit(2);
}

let stopping = false;
let inFlight = false;
async function sample() {
  if (stopping || inFlight) return;
  inFlight = true;
  try { await sampleWatchdog(); }
  catch (err) { process.stderr.write(`watchdog_daemon: ${err?.category || 'sample_failed'}\n`); }
  finally { inFlight = false; }
}

await sample();
const timer = setInterval(() => { void sample(); }, intervalMs);

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  process.exitCode = 0;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
