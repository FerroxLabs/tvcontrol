---
name: morning-prep
description: Daily morning scan — load saved morning layout, screenshot watchlist symbols, and summarize overnight pre-market state. Use when the user says "good morning", "morning prep", or asks for a pre-open briefing.
---

# Morning Prep Workflow

You are running the user's daily pre-market routine on TradingView.

## Step 1: Pull the Watchlist

1. `watchlist_get` — read the active watchlist symbols
2. If empty, ask the user to import one via `watchlist_import` (they may have a JSON backup saved from a prior `watchlist_export`)

Example watchlist: `["ES1!", "NQ1!", "CL1!", "GC1!", "DXY", "BTCUSD"]`.

## Step 2: Restore Morning Layout (if saved)

1. `state_list` — check for a snapshot tagged "morning" or similar
2. If found: `state_restore` with that snapshot id — this brings back the user's preferred indicators, drawings, timeframe, and chart type
3. If not found: proceed with current chart state and offer to `state_snapshot` with tag "morning" at the end

If `state_restore` fails with `CHART_LOADING`, wait ~2s and retry once.

## Step 3: Batch Screenshot the Watchlist

Use `batch_run` with `action: "screenshot"` and the full symbol list. This captures each symbol without manual `chart_set_symbol` loops.

```
batch_run({ symbols: <watchlist>, action: "screenshot" })
```

Screenshots save to `screenshots/` with timestamps — reference them in the summary.

## Step 4: Deep-Dive Top 5

Pick the 5 most-relevant symbols (user's main instruments, e.g., `ES1!`, `NQ1!`, `CL1!`, `GC1!`, `BTCUSD`). For each:

1. `chart_set_symbol` — switch the chart
2. `data_get_ohlcv` with `summary: true` — compact stats (overnight high/low, range, change%)
3. `quote_get` — live price snapshot

Keep OHLCV summary-only to avoid context bloat (see CLAUDE.md context rules).

## Step 5: Indicator Pulse

For the top-5 only:

1. `data_get_study_values` — RSI, MACD, EMAs currently on chart
2. `data_get_pine_labels` with `study_filter` if the user runs a custom profiler (e.g., "Profiler", "Session Stats")

If `data_get_indicator` is needed and returns `source: "dom_fallback"`, note that inputs were read from DOM (less reliable than API) — flag any suspicious readings.

## Step 6: Summarize to Chat

Produce a compact briefing:

- **Overnight leaders/laggards** — from batch screenshots + OHLCV change%
- **Key levels in range** — pulled from `data_get_pine_lines` if a levels indicator is loaded
- **Bias per instrument** — one line each (e.g., "ES1! — holding above PDH 5812, bullish above 5800")
- **Watch items** — alerts firing near current price (use `alert_list` to cross-reference)

## Cleanup

Offer to `state_snapshot` with tag `morning-<date>` so today's layout is reproducible tomorrow. If the user added throwaway drawings while prepping, `draw_clear` them before snapshotting.
