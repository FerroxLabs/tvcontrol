#!/usr/bin/env bash
# Example 00: Verify install (OFFLINE — no TradingView required).
#
# Prereqs:
#   - Node 18+
#   - jq (brew install jq / apt install jq)
#
# What this proves: the CLI runs, ships 88 tools, and Pine static analysis works
# without TradingView Desktop being open.
#
# Exit 0 on success, non-zero with a clear message otherwise.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"

echo "→ CLI help (first 3 lines):"
$TV --help | head -3

echo
echo "→ Tool count (expect 88):"
COUNT=$(node scripts/count_tools.js | jq -r '.total')
echo "  total=$COUNT"
[ "$COUNT" = "88" ] || { echo "✗ expected 88 tools, got $COUNT"; exit 1; }

echo
echo "→ Pine static analysis on a valid script (expect success=true, count=0):"
RESULT=$(printf '%s\n' \
  '//@version=6' \
  'indicator("verify")' \
  'plot(close)' | $TV pine analyze)
echo "$RESULT" | jq '{success, count}'
OK=$(echo "$RESULT" | jq -r '.success')
DIAG=$(echo "$RESULT" | jq -r '.count')
[ "$OK" = "true" ] && [ "$DIAG" = "0" ] || { echo "✗ analyze did not return success=true count=0"; exit 1; }

echo
echo "✓ Install verified: CLI runs, 88 tools registered, offline Pine analyzer works."
