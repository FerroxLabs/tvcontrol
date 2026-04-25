# TVControl examples

This is what TVControl looks like in practice — the prompts you paste into
Claude Code to drive your TradingView chart, and the tool calls that fire
behind the scenes.

**If you just added `tvcontrol` to your Claude Code MCP config, start here.**

---

## 1. Wire it up (2 minutes)

1. Open [`mcp-config.example.json`](./mcp-config.example.json).
2. Copy the `mcpServers.tvcontrol` block into your Claude Code settings
   under `mcpServers`. Replace `/absolute/path/to/tvcontrol` with the
   full path to this repo on your machine.
3. Launch TradingView Desktop with CDP on — on macOS:
   `./scripts/launch_tv_debug_mac.sh` (Linux and Windows equivalents live
   in the same directory).
4. Restart Claude Code so it picks up the new MCP server.
5. Ask Claude: *"list your available MCP tools, filter to ones starting
   with chart_"*. Expect to see `chart_get_state`, `chart_vision_read`,
   and friends.

If that list is empty, the MCP server isn't wired up correctly — check
the path in your config and that `node src/server.js` runs from the
repo without errors.

---

## 2. Try these prompts

The `prompts/` directory is a curated library you can paste straight into
Claude Code. Each file lists the prompt, which MCP tools it'll fire,
what to expect, and the common gotchas.

| Workflow | File |
|----------|------|
| **First 5 minutes** — one-line prompts to confirm the setup works | [`prompts/00-quick-start.md`](./prompts/00-quick-start.md) |
| **Chart analysis** — read, summarise, compare | [`prompts/01-chart-analysis.md`](./prompts/01-chart-analysis.md) |
| **Pine Script development** — write, compile, debug, save | [`prompts/02-pine-development.md`](./prompts/02-pine-development.md) |
| **State management** — snapshot, restore, swap setups | [`prompts/03-state-management.md`](./prompts/03-state-management.md) |
| **Strategy sweeps** — parameter grids across symbols/timeframes | [`prompts/04-strategy-sweep.md`](./prompts/04-strategy-sweep.md) |
| **Replay practice** — historical bar-by-bar with paper trades | [`prompts/05-replay-practice.md`](./prompts/05-replay-practice.md) |
| **Watchlist and alerts** | [`prompts/06-watchlist-and-alerts.md`](./prompts/06-watchlist-and-alerts.md) |
| **Agent tips and anti-patterns** | [`prompts/99-agent-tips.md`](./prompts/99-agent-tips.md) |

---

## 3. The first prompt to try

Paste this into Claude Code:

> *Check my TradingView connection. Then use `chart_vision_read` to read
> my chart and give me a one-paragraph summary — symbol, timeframe, last
> price, visible indicators with values, and the last-100-bars move.*

Expect Claude to fire `tv_health_check` then `chart_vision_read`, and come
back with a grounded paragraph about your actual chart. If it does, you're
up and running — head into `prompts/` for the rest.

---

## Optional: verify shell scripts

For developers and CI, there's a set of bash scripts under
[`verify/`](./verify/) that exercise the `tv` CLI end-to-end against the
same tools Claude calls. They're not required for users; they're how
contributors smoke-test changes without opening Claude Code.

```
./examples/verify/00-verify-install.sh   # offline — no TradingView needed
./examples/verify/run-all.sh             # full battery, auto-skips when TV is down
```

See [`verify/README.md`](./verify/README.md) for the full list.

---

## Troubleshooting the MCP setup

- **Claude says "no MCP servers available"** → the config wasn't reloaded.
  Fully quit Claude Code and reopen.
- **`tv_health_check` returns `cdp_connected: false`** → TradingView
  isn't running with `--remote-debugging-port=9222`. Fully quit TV
  (`pkill -9 -f TradingView` on Mac) and re-run the launch script.
- **Tools work in the CLI but not from Claude** → usually a bad argument
  shape. Run the equivalent `tv` command directly and paste the JSON back
  to Claude.
- **Tool returns `api_available: false`** → TradingView's internal chart
  API isn't loaded yet. Open any chart in the app and retry.
