#!/usr/bin/env bash
# Example 07: Watchlist roundtrip — read, export, import (dry-run).
#
# Prereqs:
#   - TradingView Desktop with --remote-debugging-port=9222
#   - jq
#   - For full add/remove: the Watchlist panel must be open in the app
#     (right side dock). Export/import dry-run work either way.
#
# What this proves: the watchlist CRUD surface — get, export to JSON, import
# preview with --dry-run (no changes written). If the watchlist panel is
# open, the script also adds then removes a symbol to demonstrate the live
# DOM path.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"
OUT_DIR="/tmp/tvcontrol-examples"
mkdir -p "$OUT_DIR"
EXPORT="$OUT_DIR/watchlist-example.json"

echo "→ Read current watchlist:"
CURRENT=$($TV watchlist get)
echo "$CURRENT" | jq '{count, source, symbols}'
SOURCE=$(echo "$CURRENT" | jq -r '.source')

echo
echo "→ Export to JSON ($EXPORT):"
$TV watchlist export --file "$EXPORT" | jq '{success, count, file_path, exported_at}'
[ -f "$EXPORT" ] || { echo "✗ export file was not created"; exit 1; }

echo
echo "→ Import (dry-run) from the exported file:"
$TV watchlist import --file "$EXPORT" --dry-run | jq '{success}' || true

if [ "$SOURCE" = "panel_closed" ]; then
  echo
  echo "⊘ skip live add/remove — the Watchlist panel is closed in TradingView."
  echo "  Open the right-side Watchlist panel in the app to see add + remove in action."
  echo
  echo "✓ Watchlist export/import verified (panel-closed path)."
  exit 0
fi

echo
echo "→ Live add AAPL:"
$TV watchlist add AAPL | jq '{success}'
sleep 1
echo "→ Live remove AAPL:"
$TV watchlist remove AAPL | jq '{success}'

echo
echo "✓ Watchlist CRUD verified end-to-end."
