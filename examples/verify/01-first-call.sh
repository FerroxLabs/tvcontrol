#!/usr/bin/env bash
# Example 01: First call (requires TradingView Desktop with CDP on port 9222).
#
# Prereqs:
#   - TradingView Desktop running with --remote-debugging-port=9222
#     (./scripts/launch_tv_debug_mac.sh on Mac, see examples/README.md for others)
#   - A chart open (any symbol, any timeframe)
#   - jq
#
# What this proves: TVControl can connect to the live TradingView app, read the
# current chart's state, and pull a real-time quote for the displayed symbol.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"

echo "→ Health check (CDP connection):"
STATUS=$($TV status)
echo "$STATUS" | jq '{success, cdp_connected, chart_symbol, chart_resolution, api_available}'
CDP=$(echo "$STATUS" | jq -r '.cdp_connected')
API=$(echo "$STATUS" | jq -r '.api_available')
[ "$CDP" = "true" ] || { echo "✗ CDP not connected — launch TradingView with --remote-debugging-port=9222"; exit 1; }
[ "$API" = "true" ] || { echo "✗ TradingView API not ready — open a chart in the app and retry"; exit 1; }

echo
echo "→ Current chart (symbol + timeframe):"
$TV symbol | jq '{symbol, resolution}'

echo
echo "→ Real-time quote for the displayed symbol:"
QUOTE=$($TV quote)
echo "$QUOTE" | jq '{symbol, last, close, volume, exchange, description}'
QOK=$(echo "$QUOTE" | jq -r '.success')
[ "$QOK" = "true" ] || { echo "✗ quote lookup failed"; exit 1; }

echo
echo "✓ Live connection works: health OK, chart readable, quote streamed."
