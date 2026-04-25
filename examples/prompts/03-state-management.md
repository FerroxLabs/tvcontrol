# Saving and restoring chart state

State snapshots capture the full shape of your chart — symbol, timeframe,
chart type, every indicator with its inputs, and every drawing. They write to
`~/.tv-mcp/snapshots/<name>.json` and survive across sessions.

---

## "Save my current setup"

> *Snapshot my chart as `monday-focus` using `state_snapshot`.*

**Tools fired:** `state_snapshot`

**Expected:** a confirmation with `studies_count`, `drawings_count`, and
the file path under `~/.tv-mcp/snapshots/`.

---

## "Experiment on a copy, then restore"

> *Snapshot the current chart as `pre-experiment`. Then switch to BTCUSD 60m,
> add a MACD and a Bollinger Bands, and tell me what you see. When I say
> "back to normal," restore the `pre-experiment` snapshot.*

**Tools fired:** `state_snapshot` → `chart_set_symbol` +
`chart_set_timeframe` + `chart_manage_indicator` (×2) →
`data_get_study_values` → (on your trigger) `state_restore`

**Why this is useful:** lets you explore without fear. Restore puts the
chart back to *exactly* where you were — indicators, inputs, drawings,
everything.

---

## "List my saved snapshots"

> *Use `state_list` to show me every snapshot I've got, sorted newest first.*

**Tools fired:** `state_list`

**Expected:** a table with snapshot name, created-at, studies count, and
drawings count.

---

## "Swap between two named setups"

> *I work on two setups — `day-trade` and `swing-trade`. Restore
> `day-trade` now. Later I'll ask you to swap to `swing-trade`.*

**Tools fired:** `state_restore`

Good pattern for a multi-session workflow: capture both setups once, then
flip between them with a sentence.

---

## "Clean up old snapshots"

> *List my snapshots with `state_list`. Delete any whose name starts with
> `tmp-` using `state_delete`.*

**Tools fired:** `state_list` → `state_delete` (for each match)

**Gotcha:** `state_delete` rejects path traversal (`../`, `/`) — snapshot
names are safe identifiers only.

---

## "Export a snapshot JSON so I can share it"

> *Restore `monday-focus`, then take a screenshot, then show me the full
> contents of `~/.tv-mcp/snapshots/monday-focus.json` so I can share it
> with a colleague.*

**Tools fired:** `state_restore`, `capture_screenshot`

Claude will then read the JSON file from disk and paste it. The snapshot
file format is `schema_version: 1` with `symbol`, `timeframe`, `studies`,
and `drawings` — portable across machines if the receiver has TVControl.

---

## Anti-patterns

- **"Save the chart"** without a name — Claude will invent one. Always name
  your snapshots so you can find them later.
- **Assuming indicator entity IDs survive** — they don't. A snapshot captures
  the indicator config; the entity IDs are regenerated on restore. Reference
  studies by name after a restore, not by the old ID.
- **Relying on snapshots to version Pine scripts** — snapshots capture
  the indicator's *config*, not the Pine source. Use `pine_save` for script
  persistence.
