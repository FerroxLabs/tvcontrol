#!/usr/bin/env bash
# Example 03: Change symbol/timeframe, add indicators, read their values.
#
# Prereqs:
#   - TradingView Desktop with --remote-debugging-port=9222
#   - A chart open in the app
#   - jq
#
# What this proves: the end-to-end "drive the chart" loop — set symbol, set
# timeframe, add indicators, wait for them to load, read their live values,
# and clean up after yourself. Captures entity IDs so nothing is hard-coded.
#
# Cleans up the indicators it adds before exiting.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"

echo "→ Switch to AAPL on the 15-minute timeframe:"
$TV symbol AAPL | jq '{symbol, chart_ready}'
sleep 2
$TV timeframe 15 | jq '{timeframe, chart_ready}'
sleep 1

echo
echo "→ Add Relative Strength Index:"
RSI=$($TV indicator add "Relative Strength Index")
echo "$RSI" | jq '{indicator, entity_id, new_study_count}'
RSI_ID=$(echo "$RSI" | jq -r '.entity_id')
[ -n "$RSI_ID" ] && [ "$RSI_ID" != "null" ] || { echo "✗ no entity_id returned from indicator add"; exit 1; }

echo
echo "→ Add Moving Average Exponential:"
EMA=$($TV indicator add "Moving Average Exponential")
echo "$EMA" | jq '{indicator, entity_id, new_study_count}'
EMA_ID=$(echo "$EMA" | jq -r '.entity_id')
[ -n "$EMA_ID" ] && [ "$EMA_ID" != "null" ] || { echo "✗ no entity_id returned from indicator add"; exit 1; }

echo
echo "→ Give the studies ~2s to compute, then read live values:"
sleep 2
VALUES=$($TV values)
echo "$VALUES" | jq '{count, studies: [.studies[] | {name, values}]}'
COUNT=$(echo "$VALUES" | jq -r '.count')
[ "$COUNT" -ge 2 ] || echo "  (heads up: expected ≥2 studies, got $COUNT — chart may still be loading)"

echo
echo "→ Cleanup — remove the indicators we added:"
$TV indicator remove "$RSI_ID" | jq '{action, entity_id}'
$TV indicator remove "$EMA_ID" | jq '{action, entity_id}'

echo
echo "✓ Symbol/timeframe changed, indicators added + read + removed."
