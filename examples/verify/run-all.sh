#!/usr/bin/env bash
# Run every example script in order and print a verdict table.
#
# CDP-required scripts are auto-skipped when TradingView isn't listening on
# port 9222, so you can run this from a clean machine and still get a useful
# pass/fail report on the OFFLINE paths.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

pass=0
fail=0
skipped=0
failures=()

if curl -s --max-time 1 http://localhost:9222/json/version >/dev/null 2>&1; then
  cdp="up"
else
  cdp="down"
fi
echo "TradingView CDP on :9222 → $cdp"
echo

for script in 0?-*.sh; do
  printf "=== %s ===\n" "$script"
  if grep -q "OFFLINE" "$script"; then
    mode="offline"
  else
    mode="online"
  fi

  if [ "$mode" = "online" ] && [ "$cdp" != "up" ]; then
    echo "⊘ $script (skipped — TradingView CDP not reachable)"
    skipped=$((skipped + 1))
    echo
    continue
  fi

  if bash "$script"; then
    echo "✓ $script"
    pass=$((pass + 1))
  else
    echo "✗ $script"
    fail=$((fail + 1))
    failures+=("$script")
  fi
  echo
done

echo "───────────────────────────────────────────"
echo "PASS: $pass   FAIL: $fail   SKIPPED: $skipped"
if [ "$fail" -gt 0 ]; then
  echo "Failing: ${failures[*]}"
fi
exit $((fail > 0))
