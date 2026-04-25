# Strategy parameter sweeps

Run a Pine strategy across symbols × timeframes × input combinations and get
back a results table. Claude picks good defaults (cooldown, max combinations)
but you can override anything.

---

## Precondition: you need a strategy loaded

`strategy_sweep` only works if a Pine **strategy** (not an indicator) is
already on the chart. Load one via TradingView's "Indicators & Strategies"
dialog — any Built-in with "Strategy" in its name works, or your own. Check
with:

> *Use `data_get_strategy_results` to confirm there's a strategy on the
> chart. If not, tell me which one to add.*

**Tools fired:** `data_get_strategy_results`, `chart_get_state`

---

## "Sweep a single input over a small grid"

> *Sweep the `length` input on my strategy from 10 to 50 in steps of 10,
> on AAPL 60m. Cap it at 5 combinations. Use `strategy_sweep` and report
> the best by net profit.*

**Tools fired:** `chart_get_state` (for entity_id) → `strategy_sweep`

**Expected:** a run_id, completed count, and the winning combo's inputs
+ net profit + Sharpe ratio.

**Gotcha:** Claude needs the strategy's `entity_id`. It reads this from
`chart_get_state` automatically — but if you have multiple studies, tell
Claude which name is the strategy.

---

## "Symbols × timeframes × inputs"

> *Run `strategy_sweep` on my loaded strategy across AAPL and MSFT, on 15m
> and 60m timeframes, with `length: [10, 20, 30]`. Cap at 12 combinations.
> Keep the default cooldown. Report top 3 by net profit.*

**Tools fired:** `strategy_sweep`

**Expected run time:** ~2–3 minutes for 12 combos with default 1500 ms
cooldown. Claude will tell you the run_id up front; the final summary
comes when all combos complete.

**Budget rule of thumb:** ~15–20 seconds per combo including cooldown.

---

## "Resume an interrupted run"

> *Something died mid-sweep. The run_id was `sweep_1777019729989_2lr5dr`.
> Call `strategy_sweep` with `resume: "<that_run_id>"` to continue from
> where we left off.*

**Tools fired:** `strategy_sweep` (resume mode)

**Why:** sweep writes partial-progress to disk every combo. Resume skips
completed combos and only runs what's missing.

---

## "Give me the results as a table, not a blob"

> *After the sweep, format the results as a markdown table with columns
> for symbol, timeframe, inputs, net profit, Sharpe, and error (if any).
> Sort by net profit descending.*

**Tools fired:** `strategy_sweep` + Claude formatting

Very useful for journaling. Paste the markdown table straight into a PR
or doc.

---

## "Short-circuit same-symbol combos"

> *Sweep just the `length` input [10, 20, 30, 40, 50] on ES1! 60m. Since we're
> not changing symbol, set `same_symbol_cooldown_ms: 200` so it runs fast.*

**Tools fired:** `strategy_sweep`

**Why:** when only inputs change, the chart doesn't have to re-download
bars — a 200 ms cooldown is plenty. Default 1500 ms is tuned for
symbol/timeframe switches.

---

## Anti-patterns

- **Sweeping 500 combinations on a whim** — it's the cap, not a default.
  Start with 5–10 to verify the response shape, then scale up.
- **Forgetting `--no-restore`** (or its absence) — by default sweep
  snapshots start-state, runs, and restores. That's usually what you
  want, but it adds 1–2 s per end. Ask Claude to skip restore for pure
  exploration runs.
- **Asking "which inputs are best?"** without the constraint of what
  inputs your strategy actually exposes. Run `data_get_indicator` with
  the strategy's entity_id first to list them.
