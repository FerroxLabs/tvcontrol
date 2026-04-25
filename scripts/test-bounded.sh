#!/usr/bin/env bash
# Run `node --test <files>` with a hard outer wall-clock guard.
# Works around a Node 25 quirk where the test runner sometimes lingers
# after all tests complete (open handle from a transitive timer).
#
# Exit code: forwarded from node, or 124 on timeout.
#
# Usage: ./scripts/test-bounded.sh <max_seconds> <test_files...>

set -uo pipefail

MAX="${1:-60}"
shift

node --test --test-timeout=15000 "$@" &
PID=$!

(
  sleep "$MAX"
  if kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "[test-bounded] hard kill after ${MAX}s — runner did not exit cleanly" >&2
    pkill -9 -P "$PID" 2>/dev/null
    kill -9 "$PID" 2>/dev/null
  fi
) &
WATCHER=$!

wait "$PID" 2>/dev/null
RC=$?
kill "$WATCHER" 2>/dev/null
wait "$WATCHER" 2>/dev/null

exit "$RC"
