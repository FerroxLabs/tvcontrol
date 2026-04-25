# Verify scripts

Bash scripts that exercise the `tv` CLI end-to-end. **Not required for
users** — they're for contributors and CI to confirm each feature still
works after a change, without having to open Claude Code and eyeball the
output.

If you just installed TVControl and want to see what it does, skip this
directory and go to [`../prompts/`](../prompts/) instead.

---

## How to run

Every script is idempotent and cleans up after itself.

```bash
# Offline checks (no TradingView required)
./examples/verify/00-verify-install.sh
./examples/verify/09-pine-static-analysis.sh

# Full battery (auto-skips online scripts when TV is down)
./examples/verify/run-all.sh
```

All scripts exit 0 on success, non-zero with a clear `✗` message on
failure, or exit 0 with a `⊘` "skipped — reason" message when a
precondition isn't met (no strategy loaded, watchlist panel closed, etc).

---

## Scripts

| Script | Mode | What it verifies |
|--------|------|------------------|
| `00-verify-install.sh` | OFFLINE | CLI loads, 88 tools registered, Pine analyzer works |
| `01-first-call.sh` | online | CDP health + chart state + live quote |
| `02-chart-vision-read.sh` | online | Multi-call `chart_vision_read` equivalent (state + quote + OHLCV + studies + screenshot) |
| `03-symbol-and-indicators.sh` | online | Symbol/timeframe change, add RSI + EMA, read values, cleanup |
| `04-pine-develop.sh` | online | Pine compile loop — draft, diagnose, fix, green (server-side) |
| `05-state-snapshot-restore.sh` | online | Snapshot → mutate → restore → verify |
| `06-strategy-sweep-mini.sh` | online | Parameter sweep (skips if no strategy loaded) |
| `07-watchlist-roundtrip.sh` | online | Watchlist read + export + import dry-run |
| `08-replay-practice.sh` | online | Historical replay — start, step, paper trade, stop |
| `09-pine-static-analysis.sh` | OFFLINE | Offline Pine analyzer catches real bugs |

OFFLINE scripts never require TradingView Desktop; `run-all.sh` detects
CDP automatically and skips online scripts when it's down.

---

## Adding a new verify script

Follow the header template the other scripts use:

```bash
#!/usr/bin/env bash
# Example NN: one-line description.
#
# Prereqs: ...
# What this proves: ...

set -euo pipefail
cd "$(dirname "$0")/../.."
TV="node src/cli/index.js"
```

Rules of the road:

- **Mark OFFLINE** in the header comment if the script doesn't need TV —
  `run-all.sh` greps for that token to decide whether to skip.
- **Check every response for `success`.** Silent failures are the enemy.
- **Clean up after yourself** — remove any indicators/snapshots/alerts
  the script creates. Users run these against their own charts.
- **Skip gracefully** when a precondition isn't met (no strategy, panel
  closed). Exit 0 with `⊘` and a message, not a hard fail.
