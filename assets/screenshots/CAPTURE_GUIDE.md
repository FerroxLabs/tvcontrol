# Screenshot capture guide

The README's "See it in action" section embeds four screenshots from
`assets/screenshots/`. Drop captured PNGs at the listed filenames and
they render automatically.

**General hygiene before any capture:**
- Switch to a clean public symbol — `SPY`, `AAPL`, `BTCUSDT`, `ES1!`.
  **Never use a layout containing a private/published Pine strategy.**
- Use built-in indicators only: RSI, EMA, Bollinger Bands, MACD.
- Hide TradingView's right-side Watchlist + Alerts panels (those leak
  symbols you actually trade).
- Crop tight. ~1600px wide is plenty for GitHub. Save as PNG.
- Target ~300–500 KB per screenshot. Use `pngquant` or similar if needed.

---

## `01-chart-vision-read.png`

Side-by-side composite. **Left:** Claude Code window showing the prompt
*"Use `chart_vision_read` to summarise my chart — symbol, timeframe, last
price, indicators, and 100-bar move."* and Claude's structured response
below. **Right:** TradingView showing the same symbol with two visible
indicators.

Setup steps:
1. Switch to SPY 1h, add RSI(14) and EMA(20).
2. In Claude Code, paste the prompt above. Wait for the response.
3. Capture the Claude window + the TV window side-by-side
   (macOS: `Cmd+Shift+4`, then drag across both).
4. Crop tight to the relevant content; save as
   `assets/screenshots/01-chart-vision-read.png`.

---

## `02-strategy-sweep.png`

Terminal screenshot showing `tv sweep` results. Use a built-in study
wrapped in a generic strategy (e.g., "Volatility Stop Strategy" if your
account has it, or any built-in `strategy()` indicator) — **not your
private published Pine.**

Recommended capture:
1. Add the built-in strategy to a clean SPY chart.
2. Find its entity_id: `tv state | jq '.studies'` (or use `chart_get_state`).
3. Run a small sweep:
   ```
   tv sweep --symbols SPY --timeframes 60,240 --inputs '{"length":[10,20]}' \
     --entity-id <id> --max-combinations 4 --no-cache --no-restore
   ```
4. Pipe through a JSON viewer or `jq` for color, screenshot the terminal.
5. Save as `assets/screenshots/02-strategy-sweep.png`.

---

## `03-pine-develop.png`

Three-panel composite or a single Claude Code window showing the
draft → compile → error → fix → green sequence.

Setup steps:
1. In Claude Code, paste:
   *"Write me a Pine v6 RSI crossover strategy with a deliberate syntax
   error in the entry condition. Compile with `pine_check`, show me the
   error, then fix it and recompile until it's green."*
2. Wait for the iteration to complete.
3. Screenshot the Claude window with the full conversation visible
   (the error response + the fix + the green compile).
4. Save as `assets/screenshots/03-pine-develop.png`.

---

## `04-replay-practice.png`

TradingView in replay mode + Claude Code narrating alongside.

Setup steps:
1. Switch to a clean SPY 1h chart.
2. In Claude Code, paste:
   *"Start replay on 2025-01-15 using `replay_start`, step forward 10
   bars with `replay_step`, narrate the move at each bar. Then `replay_stop`."*
3. While the replay runs, capture both windows showing the date stamp
   on TV (top-left of the chart) and Claude's bar-by-bar narration.
4. Save as `assets/screenshots/04-replay-practice.png`.

---

## Optional: dark-mode CLI shot

For a developer-audience screenshot, a clean terminal session works:

```
$ tv status        # → cdp_connected: true, chart_symbol: SPY
$ tv quote         # → last: 567.89
$ tv values        # → RSI: 52.13, EMA20: 565.4
$ tv ohlcv -s      # → 100 bars, +2.04%
```

Use a high-contrast dark theme, monospace font, no shell prompt junk in
frame. Save as `assets/screenshots/05-cli-flow.png` — uncomment the
matching block in the README to embed it.
