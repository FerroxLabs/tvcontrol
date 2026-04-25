# Watchlist and alerts

Two separate but related features — the watchlist in the right-hand dock,
and price alerts.

---

## Watchlist

### "Read my current watchlist"

> *Use `watchlist_get` and list every symbol. If the response says
> `source: panel_closed`, tell me to open the Watchlist panel in the app.*

**Tools fired:** `watchlist_get`

**Gotcha:** live reads need the right-side Watchlist panel open. With
it closed, you get `count: 0, source: panel_closed, symbols: []` —
that's not an empty watchlist, it's a closed panel.

---

### "Add these symbols"

> *Add AAPL, MSFT, and NVDA to my watchlist using `watchlist_add` (one
> call per symbol). Confirm with `watchlist_get` when done.*

**Tools fired:** `watchlist_add` (×3), `watchlist_get`

**Gotcha:** `watchlist_add` requires the panel open. Claude will surface
a "panel closed" error if it's not — tell it to `ui_open_panel` with
`panel: "watchlist"` first if that happens.

---

### "Back up my watchlist"

> *Export my watchlist to `/tmp/watchlist-backup.json` using
> `watchlist_export`. Then show me the contents.*

**Tools fired:** `watchlist_export`

**Why:** export works even with the panel closed, so it's safe as a
daily cron or backup before you mess with things.

---

### "Restore from a backup (dry run first)"

> *I've got a watchlist backup at `/tmp/watchlist-backup.json`. Preview
> the import using `watchlist_import` with `dry_run: true` so I can see
> which symbols would change before committing. If it looks right, run
> it again without dry_run.*

**Tools fired:** `watchlist_import` (dry run), `watchlist_import` (for real)

**Modes:**
- `mode: "merge"` (default) — adds imported symbols to the current list
- `mode: "replace"` — wipes current list, replaces with imported

---

## Alerts

### "Set an alert"

> *Create a price alert on my current symbol: `alert_create` with
> `condition: "greater_than"`, `price: 180`, `message: "AAPL broke 180"`.*

**Tools fired:** `alert_create`

**Expected:** the TradingView alert dialog fires and creates the alert.
Valid conditions: `"crossing"`, `"greater_than"`, `"less_than"`.

---

### "List and prune old alerts"

> *List my alerts with `alert_list`. Anything with a message that contains
> "test" — delete it via `alert_delete_by_id`. Report what you removed.*

**Tools fired:** `alert_list`, `alert_delete_by_id` (per match)

**Why `alert_delete_by_id` and not `alert_delete`?** `alert_delete` is the
legacy bulk-delete (supports `delete_all: true`). `alert_delete_by_id`
targets a single alert using its ID from `alert_list` — safer for
scripted pruning.

---

### "Nuke all my alerts"

> *Delete every alert I have using `alert_delete` with `delete_all: true`.
> Confirm with `alert_list` returning an empty array.*

**Tools fired:** `alert_delete`, `alert_list`

**Gotcha:** there's no undo. If you have alerts you care about, ask
Claude to `alert_list` first and export the results before the purge.

---

## Anti-patterns

- **Batch-adding 50 symbols** — the panel DOM gets sluggish around 30+
  watchlist ops. Break into smaller prompts or use `watchlist_import`
  with a JSON file instead.
- **Alerts as a log** — alerts expire, and TradingView free accounts
  have small limits. Use them for real triggers, not for marking dates.
- **Trusting `watchlist_get` when the panel's closed** — it returns
  zero symbols, not "please open the panel." Always check `source`.
