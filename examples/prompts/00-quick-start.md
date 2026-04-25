# First 5 minutes with TVControl

Paste these into Claude Code (or Codex / Gemini with MCP support) after you've
added the `tvcontrol` MCP server. Claude decides which tools to call — these
prompts are framed so the right ones fire.

**Before you start:**
- TradingView Desktop open, with a chart loaded on any symbol.
- Launch TV with CDP enabled — on macOS: `./scripts/launch_tv_debug_mac.sh`.
- Confirm Claude Code sees the MCP server: ask "list your available MCP tools"
  and look for names starting with `chart_`, `pine_`, `data_`, `state_`.

---

## 1. "Can you see my chart?"

> **Prompt:** *Check my TradingView connection and tell me what chart I'm
> looking at.*

**What Claude will do:** call `tv_health_check` (or `chart_get_state`) and
report the symbol, timeframe, and chart type.

**Expected:** a one-line summary like `You're on NASDAQ:AAPL at 15m, Candles`.
If Claude says "no connection," TradingView isn't listening on port 9222 — run
the launch script again.

---

## 2. "Read the chart and tell me what's going on."

> **Prompt:** *Read my chart and give me a one-paragraph summary. Include
> symbol, timeframe, last price, visible indicators with their current
> values, and the move over the last 100 bars.*

**What Claude will do:** call `chart_vision_read` — a single tool that returns
a screenshot, current state, live indicator values, Pine graphics, and an
OHLCV summary in one response. This is the marquee read-only tool.

**Expected:** a paragraph grounded in real data, e.g. "AAPL 15m, last 273.64,
RSI 52, +2.1% over the last 25 hours…"

**Gotcha:** if no indicators are loaded, the studies list will just be
`Volume`. Add a few via Claude before re-asking.

---

## 3. "Switch the chart for me."

> **Prompt:** *Switch the chart to SPY on the 1-hour timeframe and give me a
> fresh summary.*

**What Claude will do:** call `chart_set_symbol` then `chart_set_timeframe`,
wait a moment, then `chart_vision_read` again.

**Expected:** the chart in front of you actually changes, and Claude hands
back a summary for the new instrument.

**Gotcha:** symbols sometimes need an exchange prefix (e.g. `NASDAQ:AAPL`,
`NYMEX:CL1!`). Plain tickers usually resolve; say "try again with the
NASDAQ prefix" if one doesn't.

---

## 4. "Add an indicator and tell me its value."

> **Prompt:** *Add the 14-period RSI to my chart, wait for it to load, and
> tell me the current reading.*

**What Claude will do:** call `chart_manage_indicator` with
`"Relative Strength Index"`, capture the returned `entity_id`, sleep briefly,
then `data_get_study_values` to read the RSI value.

**Expected:** "RSI(14) is currently 52.13."

**Gotcha:** built-in names are spelled out — `Relative Strength Index`, not
`RSI`. Claude handles this, but if you see `entity_id: null` the name was
wrong.

---

## 5. "Save my layout so I can come back to it."

> **Prompt:** *Snapshot my current chart state and name the snapshot
> `focus-session`. I want to experiment for a bit.*

**What Claude will do:** call `state_snapshot` with `name: "focus-session"`.

**Expected:** confirmation like "Saved — 3 studies, 2 drawings, stored as
focus-session.json". You can now ask Claude to restore it at any time:

> *Restore the `focus-session` snapshot.*

---

## Where to go next

| Workflow | See |
|----------|-----|
| Deep chart analysis | [`01-chart-analysis.md`](./01-chart-analysis.md) |
| Pine Script development with Claude | [`02-pine-development.md`](./02-pine-development.md) |
| Snapshot / restore chart state | [`03-state-management.md`](./03-state-management.md) |
| Strategy parameter sweeps | [`04-strategy-sweep.md`](./04-strategy-sweep.md) |
| Historical replay practice | [`05-replay-practice.md`](./05-replay-practice.md) |
| Watchlist + alerts | [`06-watchlist-and-alerts.md`](./06-watchlist-and-alerts.md) |
| Agent tips and anti-patterns | [`99-agent-tips.md`](./99-agent-tips.md) |
