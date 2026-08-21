#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tests = readdirSync('tests')
  .filter((name) => name.endsWith('.test.js') && !['e2e.test.js', 'pine_api.test.js'].includes(name))
  .sort()
  .map((name) => join('tests', name));

const args = ['--test'];
// NO --test-force-exit. It used to be here because tests/state.test.js left a
// handle on the event loop and the runner never exited. That handle was a live
// CDP WebSocket: restore() called drawing.clearAll() and pane.setLayout()
// without passing _deps, so the "unit" test ran removeAllShapes() against the
// operator's real chart. Both now thread _deps, and TV_MCP_NO_CDP below makes
// any future escape throw instead of connecting.
//
// Force-exit was not just papering over that — it was CAUSING the count wobble
// documented below, by racing the run to a close and taking live tests with it.
// Measured after the fix: 638/638 every run, suite exits on its own in ~14s.
args.push(...tests);

// process.exit() USED TO RACE THE PIPE FLUSH.
//
// stdout.write() followed by process.exit() truncates when stdout is a pipe:
// `npm test | tail` ended mid-suite with no summary while a redirect to a file
// was complete. On a FAILING CI run the diagnostics are exactly what gets lost.
// Setting process.exitCode and returning lets Node drain first.
//
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
const EXPECTED_MIN_TESTS = 733;

// HERMETIC. Any core function that reaches the real browser instead of its
// injected _deps now throws and fails the test that did it. Before this flag,
// tests/state.test.js was calling removeAllShapes() on the operator's live
// chart every run and reporting "ok".
const result = spawnSync(process.execPath, args, {
  encoding: 'utf-8',
  env: { ...process.env, TV_MCP_NO_CDP: '1' },
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

// process.exit() USED TO RACE THE PIPE FLUSH.
//
// stdout.write() followed immediately by process.exit() truncates when stdout
// is a pipe: `npm test | tail` ended mid-suite with no summary, while a
// redirect to a file was complete. On a FAILING CI run the diagnostics are
// exactly what gets lost. Reported by an external audit. Setting
// process.exitCode and letting the script end lets Node drain first.
//
// The count gate below reads the in-memory stdout, so it is unaffected either
// way; this is purely about what a human or a CI log actually sees.
const fail = (message) => {
  process.stderr.write(message);
  process.exitCode = 1;
};

if (result.error) {
  fail(`${result.error.message}\n`);
} else {
  // NODE EMITS THE COUNT TWO DIFFERENT WAYS AND THIS ONLY KNEW ONE OF THEM.
  //
  // Node 22's default reporter prints TAP-style "# tests 708". Node 25 prints
  // "\u2139 tests 708". This regex matched only the first, so on Node 25 a
  // completed, fully passing run was rejected as SUITE INCOMPLETE and the gate
  // failed over a glyph. Reported by an external audit that ran the suite on
  // v25.8.1 and hit exactly that.
  const reported = Number(
    (/^(?:#|\u2139)\s*tests\s+(\d+)\s*$/m.exec(result.stdout || '') || [])[1],
  );

  if (!Number.isFinite(reported)) {
    fail('\nSUITE INCOMPLETE: no test-count line ("# tests N" or "\u2139 tests N") was produced, '
      + 'so nothing can be concluded.\n');
  } else if (reported < EXPECTED_MIN_TESTS) {
    fail(
      `\nSUITE INCOMPLETE: ${reported} tests ran, expected at least ${EXPECTED_MIN_TESTS}.\n`
      + `${EXPECTED_MIN_TESTS - reported} test(s) never reported, so this run proves nothing even\n`
      + 'though it may say "pass". Find out which file stopped early rather than lowering the floor.\n',
    );
  } else {
    process.exitCode = result.status ?? 1;
  }
}
