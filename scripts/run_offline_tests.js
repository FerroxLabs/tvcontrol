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

// THE SUITE SILENTLY DROPPED 13 TESTS AND STILL EXITED 0.
//
// Observed 2026-08-21: three consecutive runs of the SAME tree reported 638,
// 625 and 638 tests, all "pass, fail 0". Running the files directly always
// gives 638. --test-force-exit above races the leaked handle this script's own
// comment documents, and when it wins the run ends early — with a smaller
// passing suite and a zero exit code.
//
// A green suite whose denominator moves is not evidence. A count below the
// floor is now a hard failure, so a lost test looks like a failure instead of
// looking like success.
//
// RAISE THIS when you add tests. It is meant to be edited.
const EXPECTED_MIN_TESTS = 638;

const result = spawnSync(process.execPath, args, { encoding: 'utf-8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

const reported = Number((/^# tests (\d+)$/m.exec(result.stdout || '') || [])[1]);
if (Number.isFinite(reported) && reported < EXPECTED_MIN_TESTS) {
  process.stderr.write(
    `\nSUITE INCOMPLETE: ${reported} tests ran, expected at least ${EXPECTED_MIN_TESTS}.\n`
    + `${EXPECTED_MIN_TESTS - reported} test(s) never reported. This is the known race between\n`
    + `--test-force-exit and a leaked handle in tests/state.test.js. Re-run; if it persists,\n`
    + `find the handle rather than lowering the floor.\n`,
  );
  process.exit(1);
}
if (!Number.isFinite(reported)) {
  process.stderr.write('\nSUITE INCOMPLETE: no "# tests N" line was produced, so nothing can be concluded.\n');
  process.exit(1);
}

process.exit(result.status ?? 1);
