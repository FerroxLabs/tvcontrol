#!/usr/bin/env bash
# Example 02: "Chart vision read" via CLI (requires live TV on CDP).
#
# Prereqs:
#   - TradingView Desktop running with --remote-debugging-port=9222
#   - A chart open
#   - jq
#
# Note: the MCP tool `chart_vision_read` returns screenshot bytes + state in a
# single call, which is ideal for an LLM agent. The CLI can't embed binary
# image bytes in JSON, so this script shows the equivalent multi-call path:
# status + quote + OHLCV summary + indicator values + a PNG written to disk.
# Combined, they are what `chart_vision_read` returns in one call.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"
OUT_DIR="/tmp/tvcontrol-examples"
mkdir -p "$OUT_DIR"

echo "→ Chart state:"
$TV status | jq '{chart_symbol, chart_resolution, api_available}'

echo
echo "→ Quote snapshot:"
$TV quote | jq '{symbol, last, close, volume}'

echo
echo "→ OHLCV summary (last 100 bars):"
$TV ohlcv -s | jq '{count, period, open, close, high, low, change, change_pct}'

echo
echo "→ Live indicator values:"
$TV values | jq '{count, studies: [.studies[] | {name, values}]}'

echo
echo "→ Screenshot to disk:"
SHOT_RESULT=$($TV screenshot -o tvcontrol-example-02)
echo "$SHOT_RESULT" | jq '{success, method, file_path, size_bytes}'
PATH_OUT=$(echo "$SHOT_RESULT" | jq -r '.file_path')
if [ -n "$PATH_OUT" ] && [ -f "$PATH_OUT" ]; then
  cp "$PATH_OUT" "$OUT_DIR/chart-vision-read.png"
  echo "  copied to: $OUT_DIR/chart-vision-read.png"
fi

echo
echo "✓ One-shot chart inspection: state + quote + OHLCV + studies + screenshot."
echo "  (For LLM agents, use the MCP tool 'chart_vision_read' to get this in a single call with PNG bytes inline.)"
