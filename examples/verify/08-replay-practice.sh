#!/usr/bin/env bash
# Example 08: Replay walkthrough — start, step, paper-trade, stop.
#
# Prereqs:
#   - TradingView Desktop with --remote-debugging-port=9222
#   - A chart open on an instrument that supports replay (most do).
#   - jq
#
# What this proves: bar-by-bar historical replay works end-to-end from the
# CLI — enter replay mode at a date, step forward, simulate a buy/close,
# read the status between actions, and cleanly exit replay.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"
REPLAY_DATE="2025-03-01"

cleanup() {
  # Always try to leave replay mode, even on script failure.
  $TV replay stop > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ Baseline replay status:"
$TV replay status | jq '{is_replay_available, is_replay_started}'

echo
echo "→ Start replay on $REPLAY_DATE:"
$TV replay start -d "$REPLAY_DATE" | jq '{success, date, current_date}'
sleep 2

echo
echo "→ Confirm replay mode:"
STATUS=$($TV replay status)
echo "$STATUS" | jq '{is_replay_started, current_date}'
STARTED=$(echo "$STATUS" | jq -r '.is_replay_started')
[ "$STARTED" = "true" ] || { echo "✗ replay did not start"; exit 1; }

echo
echo "→ Step forward 1 bar:"
$TV replay step | jq '{action, current_date}'

echo
echo "→ Paper-trade: buy → step → close:"
$TV replay trade buy | jq '{action, position, realized_pnl}'
$TV replay step | jq '{action, current_date}'
$TV replay trade close | jq '{action, position, realized_pnl}'

echo
echo "→ Stop replay:"
$TV replay stop | jq '{success, action}'

echo
echo "✓ Replay walkthrough completed: start → step → paper trade → stop."
