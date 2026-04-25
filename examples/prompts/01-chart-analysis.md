# Chart analysis prompts

Ways to get Claude to read, summarise, and compare what's on your TradingView
chart. All of these work verbatim — copy, paste, iterate.

---

## One-shot "read everything"

> *Read my chart using `chart_vision_read` and give me: current price,
> timeframe, all visible indicators with live values, any custom Pine lines
> or labels, and a one-line note on the recent price action.*

**Tools fired:** `chart_vision_read`

That single tool call replaces a 5+ call sequence. Use it as your default
"read the room" prompt.

---

## Step-by-step analysis (when you want to see the pieces)

> *Walk me through my chart. Start with `chart_get_state` to list indicators
> and their entity IDs, then `data_get_study_values` for the live readings,
> then `data_get_ohlcv` with `summary: true` for the move. Summarise after
> each step.*

**Tools fired:** `chart_get_state` → `data_get_study_values` → `data_get_ohlcv`

Good when you want Claude to narrate what it's doing or when the one-shot
read returns something surprising and you want to dig in.

---

## "What levels is my Pine script drawing?"

> *My custom indicator draws horizontal price levels and labels. Use
> `data_get_pine_lines` and `data_get_pine_labels` to read them and list
> every level with its associated label, sorted high to low.*

**Tools fired:** `data_get_pine_lines`, `data_get_pine_labels`

Regular data tools can't see custom Pine drawings — these tools are the
only way to access them. Tell Claude the indicator's name if you have
several on the chart (`study_filter: "Profiler"`).

---

## Side-by-side symbol comparison

> *Compare AAPL, MSFT, and NVDA on the 1-hour chart. For each, give me last
> price, 100-bar change percent, and current RSI(14). Use `batch_run` with
> `action: "get_ohlcv"` to pull them together, and switch the chart to each
> in turn if you need per-symbol indicator values.*

**Tools fired:** `batch_run`, `chart_set_symbol`, `chart_manage_indicator`

**Gotcha:** for live RSI across symbols, Claude has to switch the chart
and wait between each. Takes ~10–15s for three symbols. Ask for just
batch OHLCV stats if you want speed.

---

## "What does the screenshot show?"

> *Take a screenshot of my chart and describe it. Use `capture_screenshot`
> and then actually look at the image — don't just describe the filename.*

**Tools fired:** `capture_screenshot`

Claude Code can read the PNG directly and reason about what the chart
looks like visually. Good for "is this a breakout?" style questions
where the numbers alone don't tell the story.

---

## Structured report (great for end-of-session journaling)

> *Give me a structured JSON report on the current chart with these keys:
> symbol, timeframe, chart_type, last_price, change_pct_100_bars,
> key_levels_from_pine (array), active_indicators (array of name + value),
> screenshot_path. Use the right tools to populate every field.*

**Tools fired:** `chart_get_state`, `quote_get`, `data_get_ohlcv`,
`data_get_pine_lines`, `data_get_study_values`, `capture_screenshot`

Forces Claude into a deterministic output shape you can paste into a
journal, ticket, or pipeline.

---

## Anti-patterns

- **"Show me every bar"** — asks Claude to pull the full 500-bar OHLCV. Burns
  context with almost no value. Ask for `summary: true` or a specific count
  like 20.
- **"Read my Pine script"** — complex scripts can be 200 KB. If you actually
  want to see the source, say so explicitly; otherwise ask Claude to compile
  or describe instead.
- **"Analyse all my indicators"** without a `study_filter` — for the Pine
  graphics tools, Claude will scan every indicator. Naming the one you want
  is 10× faster.
