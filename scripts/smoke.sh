#!/usr/bin/env bash
# Comprehensive smoke test for tradingview-mcp.
#
# Runs every check that doesn't require TradingView Desktop:
#   1. Offline test suite (npm run test:offline)
#   2. Tool count sanity (scripts/count_tools.js)
#   3. CLI --help for every top-level command
#   4. MCP server boot (spawns, expects it to stay alive on stdio)
#   5. Integration test (all tool registrations load)
#
# Use this before shipping, after refactors, and in CI.
#
# Usage: ./scripts/smoke.sh [--quick]
#   --quick  skip MCP server boot check (saves ~3s)
#
# Exit codes:
#   0  all checks passed
#   1  a check failed (see output)

set -euo pipefail
cd "$(dirname "$0")/.."

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
RESET=$'\033[0m'

pass() { echo "${GREEN}✓${RESET} $1"; }
fail() { echo "${RED}✗${RESET} $1"; exit 1; }
info() { echo "${BLUE}→${RESET} $1"; }
warn() { echo "${YELLOW}⚠${RESET} $1"; }

echo "===================================="
echo "tradingview-mcp smoke test"
echo "===================================="
echo ""

# ── 1. Offline test suite ──────────────────────────────────────────────────
# Uses scripts/test-bounded.sh instead of `npm run test:offline` because
# Node 25's runner sometimes lingers ~30-60s per file after tests finish
# (transitive open handle from telemetry/connection imports). The wrapper
# completes in ~30s instead of ~17 minutes. Test bodies always finish
# cleanly — only shutdown lingers — so failures still fail loudly.
info "1/5  Running offline test suite..."
"$(dirname "$0")/test-bounded.sh" 90 \
    tests/sanitization.test.js tests/replay.test.js tests/pine_analyze.test.js \
    tests/cli.test.js tests/fixtures.test.js tests/errors.test.js \
    tests/watchlist.test.js tests/alerts.test.js tests/state.test.js \
    tests/sweep.test.js tests/vision.test.js tests/data_get_indicator.test.js \
    tests/telemetry.test.js tests/tool_count.test.js tests/integration.test.js \
    > /tmp/smoke-tests.log 2>&1 || true
# Node's test runner emits ✖ (U+2716 HEAVY MULTIPLICATION X) on failure,
# not ✘ (U+2718 HEAVY BALLOT X). The summary-line "ℹ fail N" alternative
# catches it too, but match both glyphs so a single signal isn't load-bearing.
if grep -qE "^[✖✘]|fail [1-9]" /tmp/smoke-tests.log; then
  warn "test output saved to /tmp/smoke-tests.log"
  tail -30 /tmp/smoke-tests.log
  fail "offline tests failed (real assertion failure detected)"
fi
pass_count=$(grep -cE "^\s*✔" /tmp/smoke-tests.log || echo 0)
if [[ "${pass_count}" -lt 300 ]]; then
  warn "fewer ✔ markers than expected (${pass_count} < 300) — investigate"
  tail -30 /tmp/smoke-tests.log
  fail "offline tests under-ran"
fi
pass "offline tests pass (${pass_count} ✔ markers; runner-shutdown linger ignored)"

# ── 2. Tool count sanity ───────────────────────────────────────────────────
info "2/5  Tool count sanity..."
tool_count=$(node scripts/count_tools.js 2>&1 | grep -o '"total": [0-9]*' | awk '{print $2}')
if [[ "${tool_count:-0}" -lt 80 ]]; then
  fail "tool count too low: ${tool_count} (expected >= 80)"
fi
pass "tool count: ${tool_count}"

# ── 3. CLI help sanity ─────────────────────────────────────────────────────
info "3/5  CLI --help sanity..."
if ! node src/cli/index.js --help > /tmp/smoke-cli.log 2>&1; then
  tail -5 /tmp/smoke-cli.log
  fail "tv --help exited non-zero"
fi
pass "tv --help works"

# Dynamically discover commands from the help output so this test doesn't rot
commands=$(node src/cli/index.js --help 2>&1 | sed -n '/^Commands:/,/^Run/p' | grep -E '^  [a-z]' | awk '{print $1}')
total_cmds=0
failed_cmds=0
for cmd in $commands; do
  total_cmds=$((total_cmds + 1))
  if ! node src/cli/index.js "$cmd" --help > /dev/null 2>&1; then
    warn "tv ${cmd} --help exit != 0"
    failed_cmds=$((failed_cmds + 1))
  fi
done
if (( failed_cmds > 0 )); then
  fail "${failed_cmds}/${total_cmds} subcommand help failures"
fi
pass "all ${total_cmds} subcommands respond to --help"

# ── 4. MCP server boot sanity ──────────────────────────────────────────────
# Spawn node with /dev/null stdin. The MCP stdio transport will exit cleanly
# on stdin EOF — that's correct behavior. We just need to confirm the startup
# banner made it to stderr and the process exited 0 (clean shutdown) or was
# killed by us (still ran fine).
if (( QUICK == 0 )); then
  info "4/5  MCP server boot sanity..."
  rm -f /tmp/smoke-mcp.stderr /tmp/smoke-mcp.stdout
  node src/server.js </dev/null >/tmp/smoke-mcp.stdout 2>/tmp/smoke-mcp.stderr &
  mcp_pid=$!
  # Give up to 3 seconds for banner + natural exit on stdin EOF
  banner_seen=0
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    if grep -q "tradingview-mcp" /tmp/smoke-mcp.stderr 2>/dev/null; then
      banner_seen=1
      break
    fi
  done
  # If the process is still running (shouldn't be, but just in case), kill it
  if kill -0 "$mcp_pid" 2>/dev/null; then
    kill "$mcp_pid" 2>/dev/null || true
  fi
  wait "$mcp_pid" 2>/dev/null || true
  if (( banner_seen == 1 )); then
    pass "MCP server boots and prints startup banner"
  else
    tail -10 /tmp/smoke-mcp.stderr 2>/dev/null
    fail "MCP server did not print expected startup banner"
  fi
else
  info "4/5  MCP server boot sanity (skipped via --quick)"
fi

# ── 5. Integration test (tool registration) ────────────────────────────────
info "5/5  Tool registration integration..."
if node --test tests/integration.test.js > /tmp/smoke-integration.log 2>&1; then
  pass "all tool groups register cleanly"
else
  tail -15 /tmp/smoke-integration.log
  fail "integration test failed"
fi

echo ""
echo "===================================="
echo "${GREEN}smoke test: ALL PASSED${RESET}"
echo "===================================="
