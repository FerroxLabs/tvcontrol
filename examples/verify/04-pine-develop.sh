#!/usr/bin/env bash
# Example 04: Pine develop loop — write, compile (server-side), fix, re-compile.
#
# Prereqs:
#   - TradingView Desktop with --remote-debugging-port=9222
#   - jq
#
# What this proves: the full Pine editing loop — draft a script, hit the server
# compile endpoint to get real compiler diagnostics, fix the error, and
# re-compile to green. Uses `pine check` (server-side) so the Pine Editor
# panel doesn't need to be open. For the full editor flow (set source, save,
# persist to TradingView account), open the Pine Editor in the app first and
# call `tv pine set` then `tv pine save`.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"
OUT_DIR="/tmp/tvcontrol-examples"
mkdir -p "$OUT_DIR"

echo "→ Draft a Pine script with a deliberate bug (references undefined function):"
cat > "$OUT_DIR/draft-v1.pine" <<'PINE'
//@version=6
indicator("TVControl Demo v1", overlay=true)
length = input.int(20, "Length")
plot(undefined_fn(close, length))
PINE

echo "→ Server-side compile check:"
BAD=$($TV pine check -f "$OUT_DIR/draft-v1.pine")
echo "$BAD" | jq '{success, compiled, error_count, first_error: .errors[0]}'
ERRS=$(echo "$BAD" | jq -r '.error_count')
[ "$ERRS" -ge 1 ] || { echo "✗ expected compile errors, got $ERRS"; exit 1; }

echo
echo "→ Fix the script (swap undefined_fn for ta.sma):"
cat > "$OUT_DIR/draft-v2.pine" <<'PINE'
//@version=6
indicator("TVControl Demo v2", overlay=true)
length = input.int(20, "Length")
plot(ta.sma(close, length))
PINE

echo "→ Re-compile:"
GOOD=$($TV pine check -f "$OUT_DIR/draft-v2.pine")
echo "$GOOD" | jq '{success, compiled, error_count, warning_count}'
COMPILED=$(echo "$GOOD" | jq -r '.compiled')
[ "$COMPILED" = "true" ] || { echo "✗ fixed script did not compile"; exit 1; }

echo
echo "✓ Pine develop loop works: draft → compile → diagnose → fix → green."
echo "  (Full editor persistence: open Pine Editor panel, then 'tv pine set < file' and 'tv pine save'.)"
