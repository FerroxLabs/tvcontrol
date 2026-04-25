# Screening, optimization, and signal scanning

The meatier use cases — scan a watchlist for a signal, optimize a strategy's
parameters, scrape bar data across symbols, detect setups live. These are
the prompts that show why an agent-driven TradingView MCP exists.

---

## "Optimize my strategy on this timeframe"

The marquee use case. You have a Pine strategy that's profitable on one
timeframe; you want to know if it works on another and what settings win.

> *I have my Pine strategy loaded on the active chart. Use
> `data_get_strategy_results` to read baseline metrics on the current
> timeframe, then switch to a different timeframe and check baseline
> there too. If the new timeframe isn't profitable, run `strategy_sweep`
> across a small basket of symbols with two of the strategy's input
> parameters varied across a small grid. Report the best config per
> symbol as a markdown table; flag any symbol where no config was
> profitable.*

**Tools fired:** `data_get_strategy_results` → `chart_set_timeframe` →
`data_get_strategy_results` → `strategy_sweep` (typically 20–40 combos,
~10–20 min on a single chart).

**Pattern of useful findings (composite from real runs, numbers
generalised):**

| Symbol | Verdict |
|--------|---------|
| Symbol A | ✅ profitable on the new timeframe with tuned inputs |
| Symbol B | ⚠ marginal — basically breakeven, not worth the noise |
| Symbol C | ⚠ marginal |
| Symbol D | ❌ no profitable config — strategy doesn't work here |

The non-obvious finding from this kind of sweep is usually:
**which symbols a strategy actually works on isn't the obvious one.**
A strategy that's solid on BTC may fail there at a faster timeframe and
work on a smaller-cap pair instead. That's exactly what this workflow
surfaces — it lets you separate "the idea is good" from "the idea is
good *here*".

**Gotchas:**
- The Strategy Tester panel must be open for TradingView to compute
  backtest metrics. `data_get_strategy_results` auto-opens it now,
  but the first read may have to wait ~2s for a fresh recompute.
- Commission drag bites hard at lower timeframes. A strategy whose
  gross profit barely covers commission at 4h may go deeply negative
  at 30m purely because trade frequency triples. Watch
  `metrics.commissionPaid` against `metrics.grossProfit`.
- `strategy_sweep` runs per-combo in TradingView's in-browser backtest
  engine. Each combo takes ~15-25s on a single chart.

**Cache + parallel speed-ups (new):**
- Results persist to `~/.tv-mcp/sweep-cache/` keyed by
  `{entity_id, symbol, timeframe, inputs}`. Re-running the same grid
  skips every cache hit. Pass `use_cache: false` or
  `cache_max_age_ms: 0` to force fresh.
- Pass `parallelism: 3` (or up to 6) and the sweep spawns worker tabs
  that share the load. Each tab clones the master strategy via the
  injected metaInfo path. Realistic speed-up is ~2-3x — beyond that
  the per-machine CPU budget for parallel backtests saturates.

---

## "Extend a sweep that hit a boundary"

If the best result is at the edge of your grid, you haven't found the peak
— you've found the edge. Push past it.

> *The best result in that sweep was `in_3=7` on every profitable symbol.
> `in_3=7` is the boundary of my grid. Run another `strategy_sweep` on
> ETHUSDT only, with `in_3 ∈ [7, 10, 12, 15]` (keep in_1=20). If the
> trend is monotonic, we've found a real gradient; if it plateaus, 7 is
> the plateau and we should look at other inputs.*

**Tools fired:** `strategy_sweep` (4 combos, ~2 minutes).

**Why:** cheap follow-up sweep. Monotonic improvement in the first sweep
is a strong hint that the grid was too narrow.

---

## "Scan my watchlist for a buy signal"

No single tool does this — it's a loop pattern. Slower than a real
screener but works against any indicator you can compute on-chart.

> *Go through my watchlist. For each symbol, switch the chart to it (30m
> timeframe), wait 2 seconds, and use `data_get_study_values` to read my
> indicator values. Flag any symbol where RSI is below 30 AND close is
> above the 20-EMA. Report the hits as a table, and restore the original
> symbol when done.*

**Tools fired:** `watchlist_get` → loop { `chart_set_symbol` →
`chart_set_timeframe` → `data_get_study_values` } → `chart_set_symbol`
(restore).

**Expected runtime:** ~3-5 seconds per symbol. 20 symbols → ~60-90s.

**Gotchas:**
- Requires the RSI and EMA to be loaded on your chart up front — the
  loop reads what's already there rather than adding them per symbol
  (faster, and you know which settings are in use).
- For speed, snapshot the chart first (`state_snapshot`) and restore at
  the end in case anything goes sideways mid-loop.
- If you want to *add* indicators per symbol, do that once on the first
  iteration and remove them once at the end — adding/removing on every
  symbol is slow and has race conditions.

---

## "Alert me on a live setup"

Same loop, but with alert creation or webhook on hit.

> *Every time I ask you to "scan", go through my watchlist with the above
> pattern. For any symbol that hits the buy setup, create a TradingView
> alert via `alert_create` with `condition: "greater_than"`, the current
> price as the threshold, and message "TVControl hit: RSI<30 + EMA20
> crossover on <symbol>". Report which alerts you created.*

**Tools fired:** same loop + `alert_create` per hit.

**Extending to webhooks:** TradingView alerts themselves support webhook
URLs in their message body — set the alert's webhook URL in the UI once,
then the alert fires over HTTP when the condition hits. TVControl doesn't
make outbound HTTP itself; alerts do. For Claude-fires-HTTP-on-signal
(no TradingView alert involved), wrap the scan loop in a prompt that
ends with "if any hits, print a curl command and let me run it."

---

## "Scrape bar data across my watchlist"

Fastest known-good path. Single-symbol OHLCV (`data_get_ohlcv`) works;
the one-shot `batch_run` with `action: "get_ohlcv"` is currently broken
(uses a flaky `exportData()` internal API).

> *Loop my crypto watchlist on daily bars. For each symbol, set the chart
> to it on timeframe D, wait 2 seconds, and call `data_get_ohlcv` with
> `summary: true`. Return a markdown table with symbol, close, 100-day
> change %, and average daily volume. Restore my original symbol when
> done.*

**Tools fired:** loop { `chart_set_symbol` → `chart_set_timeframe` →
`data_get_ohlcv` }.

**Expected runtime:** ~2s per symbol. 20 symbols → ~40s.

**For large watchlists (50+):** snapshot first, then run without the
restore step — it's idempotent enough that a bad run can be redone without
losing state.

---

## "Read a backtest off a loaded strategy"

Once any strategy is loaded on the chart, TradingView runs the backtest
natively. TVControl reads the results.

> *Read the backtest metrics for the strategy on my chart using
> `data_get_strategy_results`. Report net profit, profit factor, total
> trades, win rate, and max drawdown if available. If any metrics are
> missing, tell me which.*

**Tools fired:** `data_get_strategy_results`, optionally
`data_get_trades` and `data_get_equity`.

**Gotcha:** TradingView only computes backtest metrics when the Strategy
Tester panel is open/visible. If `data_get_strategy_results` returns
`count: 0, metrics: {}` without an error, ask Claude to
`ui_open_panel` with `panel: "strategy-tester"` and retry.

**Strategy type matters.** The finder looks for sources with a
`reportData()` function — only real Pine strategies expose that. Plain
indicators (even ones with `performance()`) won't match. This was
actively broken until commit 0bd6911 patched the inverted predicate.

---

## "Which input changes matter?"

Before sweeping 38 inputs blindly, probe which ones actually affect PnL.

> *Run `strategy_sweep` with a 3-combo probe on my current chart only,
> varying just `in_1 ∈ [5, 10, 20]` with all other inputs at default.
> Report whether the net profit differs across the 3 runs. If the
> numbers are identical, `in_1` is decorative for this strategy.*

**Tools fired:** `strategy_sweep` (3 combos, ~90s).

**Why:** before committing to a 30+ combo run, you want to confirm that
the input you're sweeping actually moves PnL. A 3-combo probe takes ~90s
and tells you whether the parameter has any signal at all — if all three
results are identical, the input is decorative and you've saved 15+
minutes of pointless backtest cycles.

---

## Anti-patterns and hard limits

- **Sweeping plain indicators.** `strategy_sweep` optimizes *strategies*,
  not indicators. A plain RSI has no PnL — there's no objective function.
  Wrap your signal in a `strategy(...)` Pine template first.
- **Sweeping 500 combos on a whim.** That's the cap, not a default. 36
  combos took 17.5 minutes in the real optimization above. Scale up only
  after a focused grid gives you direction.
- **Ignoring commission.** At fast timeframes a strategy can pay more in
  commission than it makes in gross profit. A "profitable at 4h, losing
  at 30m" gap is usually commission drag from triple the trade frequency,
  not the strategy logic being wrong.
- **Assuming 30m data reaches back as far as 4h data.** It doesn't. On
  Binance crypto, 4h goes back ~8 years, 30m ~2 years. Backtests on
  faster timeframes are shorter and higher-variance — treat results
  with more skepticism.
- **Using `batch_run` for OHLCV right now.** Broken — uses a flaky
  `exportData()` internal API and returns "Uncaught (in promise)" on
  every symbol. Use the loop pattern instead. Tracking: needs a rewrite
  to the direct-bars path that `data_get_ohlcv` already uses.
