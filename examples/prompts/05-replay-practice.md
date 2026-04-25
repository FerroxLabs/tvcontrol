# Historical replay practice

TradingView's replay mode lets you step bar-by-bar through history. Claude
can drive the whole thing, so you can narrate trades instead of clicking.

---

## "Take me back to a specific date"

> *Start replay on March 1, 2025 using `replay_start`. Confirm we're in
> replay mode by calling `replay_status` and telling me the current bar
> timestamp.*

**Tools fired:** `replay_start`, `replay_status`

**Expected:** "Replay started at 2025-03-01. Current bar timestamp:
1740787199 (Feb 28 close)."

---

## "Step through and narrate"

> *Step forward 10 bars with `replay_step`, narrating what happens at each
> step: price, any signal from my RSI, any drawing that gets hit. Don't
> take any trades yet.*

**Tools fired:** `replay_step` (×10), `quote_get` between steps

**Gotcha:** narration between steps adds latency. If you want pure
speed, ask Claude to "step 10 bars and summarise the move" instead.

---

## "Paper trade a setup"

> *Step to the next bar. If RSI crosses above 30, call `replay_trade` with
> `action: "buy"`. Step 5 bars forward, then `replay_trade close`. Report
> the realized PnL.*

**Tools fired:** `replay_step`, `data_get_study_values`, `replay_trade`,
`replay_status`

**Expected:** a trade opens and closes in the live chart, and Claude
reports the PnL from `replay_status`.

**Gotcha:** `replay_trade` only works in replay mode. If you see
"replay not started," Claude forgot step 1 — say "call replay_start
first."

---

## "Autoplay at 2x speed"

> *Enable autoplay at 500ms per bar using `replay_autoplay`. Wake me up
> when the current date hits 2025-03-15.*

**Tools fired:** `replay_autoplay`, `replay_status` (polled)

**Why this is fun:** you can leave autoplay running and ask Claude
to monitor for a specific condition (date reached, level broken,
indicator crossover) and then alert you.

---

## "Always leave replay cleanly"

> *Stop replay with `replay_stop` and return to realtime. Confirm by
> reading `replay_status` and checking `is_replay_started` is false.*

**Tools fired:** `replay_stop`, `replay_status`

**Habit:** end every replay session with a clean stop. Otherwise the
chart stays frozen at your replay date and confuses future you.

---

## Full practice session (one copy-paste)

> *Load a replay session for me:
> 1. Snapshot current chart as `pre-replay` using `state_snapshot`.
> 2. Switch to AAPL 15m with `chart_set_symbol` / `chart_set_timeframe`.
> 3. Add RSI(14) with `chart_manage_indicator`.
> 4. `replay_start` at 2025-02-15.
> 5. Step 20 bars with `replay_step`, narrate, and flag any RSI crossovers.
> 6. When I say "stop," call `replay_stop` and `state_restore pre-replay`.*

**Tools fired:** the lot — full session in one prompt.

---

## Anti-patterns

- **"Replay the whole week"** — autoplay works, but Claude won't automatically
  poll for you. Give it a stopping condition: a date, a PnL threshold, an
  indicator event.
- **Taking trades without a plan** — `replay_trade` has no validation. Tell
  Claude your entry/exit rules up front so it doesn't just alternate buys.
- **Forgetting to stop replay** — leaving replay on means your next "what's
  my chart" question returns data from whatever historical date you left it
  at. Ask Claude to stop + restore when you're done.
