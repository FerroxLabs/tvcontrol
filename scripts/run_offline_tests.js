#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tests = readdirSync('tests')
  .filter((name) => name.endsWith('.test.js') && !['e2e.test.js', 'pine_api.test.js'].includes(name))
  .sort()
  .map((name) => join('tests', name));

const args = ['--test'];
// --test-force-exit landed in Node 22.0.0, not 25. With the gate set to 25 this
// suite HUNG FOREVER on Node 22: tests/state.test.js passes all 30 of its tests
// and then leaves a handle on the event loop, so the runner never exits. Node's
// TAP reporter buffers until the end, so the hang produced ZERO output rather
// than a visible failure, and `npm test` looked like it was still working.
//
// Measured on Node v22.23.1: gate at 25 -> killed at 600s with no output;
// gate at 22 -> whole suite completes.
//
// This makes the suite usable. It does NOT fix the leaked handle in
// state.test.js, it papers over it, and that handle is still worth finding.
if (Number(process.versions.node.split('.')[0]) >= 22) args.push('--test-force-exit');
args.push(...tests);

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
