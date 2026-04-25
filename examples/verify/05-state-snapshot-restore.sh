#!/usr/bin/env bash
# Example 05: Snapshot the chart, mutate it, restore, verify.
#
# Prereqs:
#   - TradingView Desktop with --remote-debugging-port=9222
#   - A chart open
#   - jq
#
# What this proves: you can capture the full chart state (symbol, timeframe,
# indicators, drawings), mutate the chart however you want, then restore it
# back to exactly where you started. Snapshot survives to disk under
# ~/.tv-mcp/snapshots/ so it's recoverable across sessions.
#
# Snapshots are stored in the TVControl data dir, not under this script's
# scratch directory, because the restore tool reads them from there.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"
SNAP="tvcontrol-example-05"

echo "→ Capture a snapshot of the current chart:"
SNAP_RESULT=$($TV state snapshot -n "$SNAP")
echo "$SNAP_RESULT" | jq '{success, name, studies_count, drawings_count, file_path}'
SNAP_OK=$(echo "$SNAP_RESULT" | jq -r '.success')
[ "$SNAP_OK" = "true" ] || { echo "✗ snapshot failed"; exit 1; }

# Record start state so we can verify restore worked.
START=$($TV symbol)
START_SYMBOL=$(echo "$START" | jq -r '.symbol')
START_TF=$(echo "$START" | jq -r '.resolution')
echo "  starting state: $START_SYMBOL @ $START_TF"

echo
echo "→ Mutate chart (switch to BTCUSD, 60m):"
$TV symbol BTCUSD | jq '{symbol, chart_ready}'
sleep 2
$TV timeframe 60 | jq '{timeframe, chart_ready}'
sleep 1
AFTER=$($TV symbol)
echo "  after mutation: $(echo "$AFTER" | jq -r '.symbol') @ $(echo "$AFTER" | jq -r '.resolution')"

echo
echo "→ Restore the snapshot:"
RESTORE=$($TV state restore -n "$SNAP")
echo "$RESTORE" | jq '{success, applied_count, skipped_count}'
sleep 2
FINAL=$($TV symbol)
FINAL_SYMBOL=$(echo "$FINAL" | jq -r '.symbol')
FINAL_TF=$(echo "$FINAL" | jq -r '.resolution')
echo "  after restore: $FINAL_SYMBOL @ $FINAL_TF"

[ "$FINAL_SYMBOL" = "$START_SYMBOL" ] || { echo "✗ restore failed: symbol $FINAL_SYMBOL ≠ $START_SYMBOL"; exit 1; }
[ "$FINAL_TF" = "$START_TF" ] || { echo "✗ restore failed: timeframe $FINAL_TF ≠ $START_TF"; exit 1; }

echo
echo "→ Clean up snapshot:"
$TV state delete -n "$SNAP" | jq '{success, name}'

echo
echo "✓ Snapshot → mutate → restore roundtrip verified on-chart."
