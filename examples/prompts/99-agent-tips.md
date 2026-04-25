# Agent tips: how to prompt TVControl well

Stuff you'll discover after an hour of using it. Read this before you
invest in longer sessions.

---

## Prompt shapes that work

### Name the tool when the intent is specific

*"Use `chart_vision_read` to read my chart."*

Faster and more reliable than *"tell me what's on my chart."* Claude will
still make the right call from the vague prompt most of the time, but
naming the tool removes the gamble — especially for tools with cheaper
alternatives (`chart_get_state` vs `chart_vision_read`).

### Give a stopping condition for loops

*"Step through replay until RSI drops below 30, then report the bar."*

Always better than *"step through replay until something interesting
happens."* Claude is not your oracle for "interesting."

### Frame output shape up front

*"Report back as a JSON object with `symbol`, `price`, `rsi`, `trend`."*

Keeps the response to something you can paste into another system
instead of re-asking for it structured.

### Ask for the cheap tool explicitly when you know

*"Pull a `summary: true` OHLCV — I don't need individual bars."*

Saves Claude from defaulting to the full 100-bar payload when you just
want the change percent.

---

## Prompt shapes that cause pain

### "Analyse my trade setup"

Too open. Claude will call 6+ tools and hand back a mini-essay. If you
want analysis, structure the ask: *"Using RSI(14), the last 50 bars, and
the current symbol, tell me if we're overbought or oversold and
whether volume confirms."*

### "Update my chart"

Update what? To what? Claude will guess. Say *"Switch to 15m and add
Bollinger Bands (20, 2)"* instead.

### "Run the sweep"

Missing: which strategy, which symbols, which inputs, how many combos.
Claude will either pick for you (risky) or ask follow-ups (slow).
Give it all four up front.

### Chained writes without confirmation

*"Snapshot, switch symbol, add 5 indicators, save Pine, start replay."*

Too many mutations in one turn. If any fail, you won't know which state
you ended up in. Break into 2–3 turns and read state between them.

---

## Timing gotchas

| Action | Wait before reading downstream |
|--------|--------------------------------|
| `chart_set_symbol` | 1–2 s |
| `chart_set_timeframe` | 1 s |
| `chart_manage_indicator add` | 1–2 s (longer for complex studies) |
| `pine_set_source` | ~500 ms |
| `replay_start` | 1–2 s |
| `state_restore` | 2–3 s for charts with many studies/drawings |

Claude knows about these, but if you chain actions aggressively it may
read state before TradingView has caught up. Telling it *"wait 2 seconds
between steps"* fixes this.

---

## Entity IDs are session-local

`chart_get_state` returns indicators like:

```json
{ "id": "XoM6VO", "name": "Relative Strength Index", ... }
```

The `id` is **not stable across sessions**, not stable across chart
reloads, and not stored in state snapshots (the snapshot re-creates
indicators and gets fresh IDs on restore). Rules:

- Always read fresh IDs at the start of a session.
- Refer to indicators by name ("my RSI") in natural language, not by ID.
- If Claude tries to use an ID from a previous turn after a snapshot
  restore, it'll get "study not found" — ask it to re-read state.

---

## Output size caps (keep context lean)

| Tool | Default | Cap |
|------|---------|-----|
| `data_get_ohlcv` | 100 bars | 500 |
| `data_get_trades` | 20 | 20 |
| `data_get_pine_labels` | 50 per study | configurable via `max_labels` |
| `pine_get_source` | full script | no cap — can hit 200 KB |

If a prompt is going to eat context, ask for summaries first:

*"Give me just a `summary: true` OHLCV and the top 3 Pine lines, not
everything."*

---

## Debugging tools that misbehave

1. `tv_health_check` — first stop. If `cdp_connected: false`, TradingView
   isn't listening.
2. `tv_discover` — reports which internal TradingView API paths are
   available. Useful when a tool says "API not available."
3. `tv_ui_state` — tells you which panels are open (watchlist, pine
   editor, strategy tester). Half of "X tool doesn't work" is "panel's
   closed."

---

## When in doubt: use the CLI equivalent

Every MCP tool has a matching `tv` CLI command. If an MCP call behaves
oddly, running the same op from the terminal gives you raw JSON without
LLM framing:

```
tv status
tv state
tv values
```

If the CLI succeeds but the MCP call fails, the issue is with how
Claude is calling the tool — usually a malformed argument. Paste the
JSON back to Claude and ask it to correct the call.

The shell scripts under [`../verify/`](../verify/) are short, inspectable
recipes that exercise the CLI end-to-end — handy when you need to
compare "tool output via CLI" against "tool output via Claude."
