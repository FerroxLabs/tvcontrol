#!/usr/bin/env bash
# Example 09: Pine static analysis (OFFLINE — no TradingView required).
#
# What this proves: the offline Pine analyzer catches real bugs without ever
# touching TradingView. Great for CI, pre-commit hooks, or quick sanity checks.
#
# Exit 0 on success, non-zero if the analyzer fails to flag a known bad script.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"

echo "→ Analyze a script with an out-of-bounds array access:"
BAD=$(printf '%s\n' \
  '//@version=6' \
  'indicator("bad")' \
  'arr = array.from(1, 2, 3)' \
  'v = array.get(arr, 5)' \
  'plot(close)')

RESULT=$(echo "$BAD" | $TV pine analyze)
echo "$RESULT" | jq '{success, count, first: .diagnostics[0]}'

SUCCESS=$(echo "$RESULT" | jq -r '.success')
COUNT=$(echo "$RESULT" | jq -r '.count')
[ "$SUCCESS" = "true" ] || { echo "✗ analyzer did not return success=true"; exit 1; }
[ "$COUNT" -ge 1 ] || { echo "✗ expected ≥1 diagnostic, got $COUNT"; exit 1; }

FIRST_SEV=$(echo "$RESULT" | jq -r '.diagnostics[0].severity')
[ "$FIRST_SEV" = "error" ] || { echo "✗ expected first diagnostic severity=error, got $FIRST_SEV"; exit 1; }

echo
echo "→ Analyze a clean script for comparison:"
CLEAN=$(printf '%s\n' \
  '//@version=6' \
  'indicator("clean")' \
  'plot(ta.sma(close, 20))')

CLEAN_RESULT=$(echo "$CLEAN" | $TV pine analyze)
echo "$CLEAN_RESULT" | jq '{success, count}'
CLEAN_COUNT=$(echo "$CLEAN_RESULT" | jq -r '.count')
[ "$CLEAN_COUNT" = "0" ] || { echo "✗ clean script flagged $CLEAN_COUNT diagnostics"; exit 1; }

echo
echo "✓ Offline Pine analyzer catches real bugs and leaves clean code alone."
