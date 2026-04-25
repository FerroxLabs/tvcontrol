#!/usr/bin/env bash
# Example 06: Mini strategy parameter sweep.
#
# Prereqs:
#   - TradingView Desktop with --remote-debugging-port=9222
#   - A Pine **strategy** loaded on the chart (not a plain indicator).
#     If no strategy is present this script skips gracefully — add one in the
#     app ("Indicators & Strategies" → Built-ins → any *Strategy* entry) and
#     re-run.
#   - jq
#
# What this proves: you can parameter-sweep a live strategy across input
# combinations and get per-combo results in JSON. Uses --no-restore to keep
# the run focused on the sweep itself. `--max-combinations 3` keeps the
# example ~30s.

set -euo pipefail
cd "$(dirname "$0")/../.."

TV="node src/cli/index.js"

echo "→ Look for a strategy on the chart:"
STRAT=$($TV data strategy 2>&1 || true)
echo "$STRAT" | jq '{success, count, metric_count: (.metrics | length), error}' 2>/dev/null || echo "$STRAT"
SUCCESS=$(echo "$STRAT" | jq -r '.success // "false"' 2>/dev/null || echo "false")
METRIC_COUNT=$(echo "$STRAT" | jq -r '.metrics | keys | length' 2>/dev/null || echo "0")

if [ "$SUCCESS" != "true" ] || [ "$METRIC_COUNT" -eq 0 ]; then
  echo
  echo "⊘ skip — no strategy with populated backtest metrics on the active chart."
  echo "  Add a Pine strategy via TradingView's 'Indicators & Strategies' dialog"
  echo "  and make sure the Strategy Tester panel is open, then re-run this script."
  exit 0
fi

ENTITY=$(echo "$STRAT" | jq -r '.metrics.entity_id // .entity_id // empty')
if [ -z "$ENTITY" ]; then
  # Fallback: grab the first study from values as the strategy.
  ENTITY=$($TV values | jq -r '.studies[0].id // empty')
fi

if [ -z "$ENTITY" ]; then
  echo "⊘ skip — could not resolve a strategy entity_id from the chart."
  exit 0
fi

echo
echo "→ Sweep 3 length combos on AAPL 60m (entity $ENTITY):"
$TV sweep \
  --symbols AAPL \
  --timeframes 60 \
  --inputs '{"length":[10,20,30]}' \
  --entity-id "$ENTITY" \
  --max-combinations 3 \
  --no-restore \
  | jq '{run_id, total_combinations, completed, errored, duration_ms, best: .summary.best_by_net_profit}'

echo
echo "✓ Strategy sweep executed; see output above for per-combo results."
