# Changelog

All notable changes to TVControl are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [2.3.0] - 2026-08-21

Minor, not a patch: two new tools and several changed return shapes.

### Added

- **`alert_create_bulk`** — create price alerts across many symbols, or the
  whole active watchlist, in one call. Does not touch the chart. Each alert can
  carry a `webhook_url`, so every fire posts to your own endpoint instead of
  your inbox. `percent_from_last` prices each alert from that symbol's own live
  price, which is the only level that means the same thing across a mixed
  watchlist. `dry_run: true` returns the full plan without creating anything.
  The whole batch is verified with a single read of the alert list afterwards.
  Measured: 29-symbol dry run in 536ms; three real webhook alerts created and
  verified in 2s.
- **`quote_batch`** — live quotes for many symbols in one server-side request.
  29 symbols in 272ms. Names the symbols it could not resolve rather than
  returning a shorter list. `quote_get` switches the chart symbol and takes
  about 20s each, so it must never be looped.
- **`tests/study_addressing.test.js`** executes the real page-side JS against
  a fake TradingView, so logic that lives inside an `evaluate()` template is
  covered rather than assumed.
- **`tests/hermetic_deps.test.js`** and a `TV_MCP_NO_CDP` guard that makes any
  real browser call from an offline test throw and name itself.

### Fixed

- **A Pine study had no address, so four tools could never reach one.**
  TradingView gives a built-in study a string id ("T4x6LH") and gives every
  Pine study its own distinct empty Array. `getStudyById` resolves that by
  reference identity, so a fresh `[]` throws "There is no such study": the id
  is a handle, not data, and it cannot survive serialization. `chart_get_state`
  was returning that `[]` to callers as their `entity_id`, and
  `data_get_indicator`, `indicator_set_inputs`, `indicator_toggle_visibility`
  and `chart_manage_indicator` all take an `entity_id` string. On a product
  whose users keep their work in Pine, none of them worked on it.

  `chart_get_state` now reports `id: null` with `addressable_by: "name"` and
  the `script_id` from metaInfo, and all four tools resolve the study in the
  page, where the reference still exists. Verified live: a 66-input Pine
  indicator read, hidden, shown and had an input set and reverted, all by name.
  An ambiguous name is refused rather than guessed.
- **`chart_manage_indicator` remove returned a hardcoded success.** It called
  `removeEntity` and said `success: true` without looking, so a bad id, a
  Pine study, or a throw inside the page all reported the same thing as a real
  removal. It now counts before and after and names the study that went.
- **The offline test suite was calling `removeAllShapes()` on the live chart.**
  `restore()` called `drawing.clearAll()` and `pane.setLayout()` with no
  `_deps`, and the dependency fallback fails open, so both resolved to the real
  CDP functions. Every `npm test` cleared the drawings on whichever pane was
  active. It did no damage only because that pane was empty. `snapshot()` had
  the same hole in three read paths. All five now thread `_deps`.
- **The test count moved between runs of the same tree** — 638, 625, 638, all
  reported green. `--test-force-exit`, added to work around the hang caused by
  the leak above, was racing the run to a close and taking live tests with it.
  Removed. Four consecutive runs now report 645/645 and the suite exits on its
  own in about 13s, down from roughly 40s.
- **The server misdescribed itself to every client.** It announced version
  2.2.1 with "102 tools" while shipping 2.2.6 and registering 103 of a
  104-tool catalog. Version and both counts are now derived at startup and
  asserted against what the server actually returns on the wire.
- **`pine_new` reported `new_script_created` and created nothing.** It replaced
  the editor buffer with a template. It now refuses to overwrite a non-trivial
  buffer without `confirm_overwrite: true`, and fails closed when it cannot
  read the buffer to check.
- **A concurrency test asserted wall-clock time** and failed on a loaded
  machine while the code under test was correct. It now counts how many
  sections are in flight at once, which is the property it was trying to prove.

### Changed

- `README` corrected: 103 tools and 645 tests, not 102 and 512, and it now
  documents the watchlist-wide alert sweep.

## [2.2.6] - 2026-08-20

Two independent adversarial audits (Kimi K3, Codex 5.6) reviewed 2.2.5 with full
repository access. Both returned the same verdict — do not ship — and converged,
separately, on the same defect class: **an action that did not happen was
reporting success.** That is the bug this project keeps rediscovering, and the
2.2.5 fixes had reintroduced it one layer up from where it was fixed.

Live testing against a real account then found three more that neither audit
could see from the source.

### Fixed — success now requires verification, everywhere

- **`alert_delete_by_id` reported success while the alert was still there.** The
  independent read set `verified: false` and `success: true` sat right beside
  it. Every caller in this codebase branches on `success`.
- **`alert_delete_by_id` treated a failed verification read as proof of
  deletion.** `list()` returns `{success: false, alerts: []}` rather than
  throwing, so `(after.alerts || []).some(...)` found nothing in an empty array
  and concluded the alert was gone. An expired session was being recorded as
  evidence.
- **`alert_delete_by_id` "deleted" alerts that never existed.** Found live: id
  `999999999999` returned `success: true, verified: true`. The endpoint accepts
  any id, and "it is not in the list afterwards" is trivially true of something
  that was never in the list. Presence is now established first.
- **`alert_delete` (the bulk path, and the one the CLI uses) had no verification
  at all.** `deleted_count` was `ids.length` — the number requested, presented
  as the number that happened. A partial success in a batch of 50 reported all
  50 deleted.
- **`alert_create` trusted its own POST response.** It now confirms the alert
  exists from a separate read.
- **`watchlist_import` counted failed adds as added.** `add()` returned
  `{success: false}` instead of throwing, and the import loop only treated a
  throw as failure. A symbol that never arrived was reported in `added` with
  top-level `success: true`. `add()` and `remove()` now throw when their own
  verification fails.
- **`watchlist_remove_bulk` called symbols it never touched "removed".** The
  rule was `!was_present || removed`, which defines absence as success.
  Removing `AAPL` from a list holding `NASDAQ:AAPL` posted nothing and reported
  success. `not_found` and `survived` are now reported separately, and neither
  counts as a removal.
- **A whitespace-only symbol reported success.** `["   "]` filtered to `[]`, and
  `[].every(...)` is `true`.
- **`watchlist_get` turned a 200-with-error-body into an empty watchlist.**
  `{"s":"error"}` has no `id` and no `symbols` array; the shape is now checked.
- **Mutations could be verified against a different watchlist.** If the active
  list changed mid-flight, list B could confirm a mutation to list A.
- **`pine_list_scripts` reported an empty library when the fetch failed.** It
  returned `success: true, total: 0` with the error in a field nobody reads.
  That tells someone with 276 scripts that they have none.
- **`batch_run` with `get_study_values` could report an all-green scan that read
  nothing.** `getStudyValues` returned `success: true, count: 0` whether the
  chart had no indicators or the extraction had broken. It now distinguishes
  the two, and reports how many studies it actually saw.

### Fixed — found by live testing, not by either audit

- **A bare ticker was stored verbatim.** `POST /append/` with `["KO"]` stores
  the literal string `"KO"`; it does not resolve to `NYSE:KO`. The old DOM path
  went through TradingView's own autocomplete and always wrote the qualified
  form. The REST rewrite lost that, and verification made it *worse*, because
  the read-back finds the exact string that was posted — so a row TradingView
  may never resolve verified as a success. Bare tickers now resolve through
  symbol search before being posted, and one that resolves to nothing is
  refused.
- **`quotes_available` was true while no returned symbol had a price.** The
  panel was rendering a different watchlist entirely: 59 DOM symbols, 29 API
  symbols, zero overlap. It now reports what actually matched and says plainly
  when the visible list is not the active one.
- **`watchlist_export` destroyed section structure.** Schema 2 adds `entries` —
  the stored list verbatim, headers in place and in order. Verified on a live
  39-entry watchlist with 10 sections: exported, order preserved, restorable.

### Added

- **`alert_create` takes `frequency` and `resolution`.** Both were hardcoded, so
  an agent could only ever create a one-shot alert on the 1-minute series. The
  vocabulary had to be determined empirically against the live API: of seventeen
  plausible frequency names, it accepts exactly **two** — `on_first_fire` and
  `on_bar_close`. Everything else returns a bare `invalid_request`. Bad values
  are now refused up front with a message that names the valid ones.
- **`tv pine list` gained `--filter`, `--limit` and `--offset`.** Paging landed
  in 2.2.5 without CLI flags, so scripts past the first 50 were unreachable and
  `next_offset` was advice the CLI could not take.

### Changed

- Caller mistakes in `watchlist_export` / `watchlist_import` (bad path, missing
  file, malformed JSON) are now `invalid_argument` rather than `api_unexpected`,
  which had been sending people to look at TradingView for their own typo.
- Duplicate symbols in bulk calls are collapsed, so `added_count` counts rows
  rather than requests.
- Dead code the 2.2.5 rewrite orphaned has been removed.

### Tests

Both audits made the same criticism of the 2.2.5 tests, and it was correct: they
assert that strings appear in the source, and every one of them passed while the
defects above were live. Two of them actively *permitted* the bug by asserting
`verified: false` alongside `success: true`.

`tests/verification_contract.test.js` is behavioural and exercises the failure
paths. 13 of its cases fail against the pre-fix source; the ones that pass are
happy-path cases that were already correct. The source-text tests are kept, but
as what they are: anti-reversion tripwires, not evidence of correctness.

571 offline tests. Verified live: watchlist 29 → 30 → 29, bare `KO` resolved to
`NYSE:KO` and removed, garbage ticker refused, alerts 164 → 165 → 164, phantom
delete refused, export round-trip preserving all 39 entries and 10 sections.

### Fixed — second audit round, on the fixes themselves

The 2.2.6 fixes were put back through the same adversarial review that rejected
2.2.5. It found four more, three of them in code written that same night.

- **`watchlist_import` in `replace` mode duplicated every section header.** The
  removal loop iterated the header-free symbol list, so existing headers were
  never removed; the add loop then worked from a header-free set and appended
  the incoming headers on top of them. A "replace" produced two of each section
  and reported them as restored. Replace now operates on the stored entries,
  headers included.
- **`watchlist_add` hid which listing it picked.** A bare ticker usually exists
  on several exchanges — `KO` is NYSE, and also Frankfurt. `addBulk` disclosed
  the choice and the alternatives; `add`, which is what `watchlist_add`
  actually calls, dropped them. Both report `resolved_from` and `alternatives`
  now.
- **You could add a symbol you could not then remove.** `add("KO")` resolved and
  stored `NYSE:KO`; `remove("KO")` did not resolve, found nothing spelled `KO`,
  and reported that the symbol was not in the watchlist, which was false.
  `removeBulk` now matches a bare ticker against the list it just read — a local
  match, not a search call. An ambiguous ticker is refused rather than guessed,
  because deleting the wrong row is not recoverable.
- **The section header paths skipped the same-list guard** that the symbol paths
  carry, so a watchlist switched mid-operation could have the wrong list answer
  for whether a header landed.

### Changed

- `alert_create` deliberately does **not** throw when its confirmation read
  fails, while `alert_delete_by_id` does. The asymmetry was flagged in review
  and kept: the safe response to an unconfirmed delete is to look and retry,
  but retrying an unconfirmed create makes a second alert. Creation reports
  `verified: null` with a note explaining why not to retry blind.
- `watchlist_import` no longer claims more than it can deliver. The API appends
  at the end of the list, so import restores membership faithfully but can only
  reproduce *order* when building from empty. It says so now.

### Tests

Mutation testing on the new suite found a test that could not fail for the
reason it claimed. "deleteById throws when the verification read fails" broke
*every* list read, so it threw at the pre-delete presence check and never
reached the post-delete verification — meaning the original 2.2.5 bug could have
been reintroduced in the post-delete path with the whole suite still green. The
mock can now fail from the Nth read onward, and the replacement test was
confirmed to fail against that exact mutation.

Two follow-ups the review asked for on the way to passing:

- **`data_get_study_values` had no behavioural test.** Its fix was verified only
  by a string-grep asserting the function appears in `batch.js`, which proves
  wiring and not behaviour. It matters more than most: `batch_run` stamps
  success on whatever this returns, so a broken read becomes an all-green scan
  that read nothing. Four behavioural cases now cover a broken read, a chart
  with indicators that yield nothing, a genuinely bare chart, and a normal read.
- **The alert resolution check claimed to be a whitelist and was not.** The
  pattern accepts any 1-to-4-digit minute count, deliberately, because
  TradingView supports resolutions this probe did not enumerate and rejecting a
  legitimate one is worse than forwarding it. It fails closed — an unsupported
  value comes back `invalid_request` and `create()` throws — so the comment now
  says it is a shape check rather than the authority on what is accepted.

584 offline tests.

## [2.2.5] - 2026-08-20

### Fixed

- **`chart_get_state` now returns `chart_type` as well as `chartType`.** The same value was called `chartType` here, `chart_type` in `symbol_info`, and taken as `chart_type` by `chart_set_type` — one value, three places, two spellings. An agent that learns the name from `chart_get_state` reads `undefined` everywhere else. That happened twice while sweeping the tool surface, and both times produced a false "this tool is broken" conclusion about a tool that worked perfectly. Both keys are emitted so nothing breaks; snake_case is canonical.

### Notes

- 2.2.4 was tagged but never published to npm. Publish 2.2.5 instead; it contains everything 2.2.4 did.

## [2.2.4] - 2026-08-20

Found by calling all 101 registered tools against a live account and verifying each effect from an independent read, rather than by reading code. Three of them were broken in ways that reported success or returned nothing usable.

### Fixed

- **The watchlist is rebuilt on TradingView's REST API.** Every operation used to be DOM automation — press the add button, or right-click a row and hunt for "Remove" in a context menu. Measured against a live account: `watchlist_remove` reported a click and left the symbol in place; `watchlist_remove_bulk` returned `removed_count: 0`; and `watchlist_get` reported three symbols absent while the account held all of them, because the DOM only contains *rendered* rows. That read is the worst of the three — a membership check that silently under-reports is more dangerous than one that fails, because callers act on it. `get`, `add`, `add_bulk`, `remove` and `remove_bulk` now use `/api/v1/symbols_list/`, and each verifies the result from a second read instead of trusting the mutation's own response. Section headers (`###CORE BASKET`) no longer inflate symbol counts. Price data is still read from the widget when it is open, best-effort.
- **`batch_run` gained `get_study_values`, the action it always documented.** The server's tool guide and the market-open scan skill both instruct callers to run `batch_run({action: "get_study_values"})` to sweep a universe in one call — it is the central step of that workflow. The action existed in neither the schema enum nor the core's allowlist, so every such call died at validation and the documented scan was impossible. Now implemented, and verified returning full indicator values for AAPL and MSFT.
- **`alert_delete_by_id` called an endpoint that does not exist.** `POST /delete_alert` (singular) answers with HTTP 200 and an error *body*, so the old code read the 200, fell through to a DOM path that cannot delete a single alert, and returned failure for something the API does fine. It now posts to `/delete_alerts` with a one-element array — and the id must be numeric, since a string returns a bare `{"s":"error"}`. Verified live: 164 alerts → create → 165 → delete → 164.

### Added

- `tests/watchlist_api.test.js`, `tests/batch_actions.test.js` and `tests/alert_delete_endpoint.test.js`. All are confirmed to fail against the pre-fix source. The batch test asserts that the tool's enum and the core's allowlist agree, because updating one without the other leaves the action dead — which is how the first attempt at that fix failed.

### Notes

- A tool that fails without a readable reason cannot be debugged. Several failures in this sweep surfaced as `undefined: undefined`; where those turned out to be caller error, the tools now say so.
- 54 of 101 tools mutate live state and were exercised with save/verify/restore against a real account. The remainder are documented as deliberately skipped rather than quietly untested.

## [2.2.3] - 2026-08-20

### Fixed

- The Pine editor is reachable again. `document.querySelector('.monaco-editor.pine-editor-monaco')` returned a collapsed 0x0 node that TradingView keeps in the DOM permanently and that carries no React fiber, so every caller concluded the editor was closed while it was plainly open on screen. The finder now measures each candidate's bounding box and takes the first one with real dimensions.
- Edits reach the chart instead of vanishing. The push path wrote into `getEditors()[0]`, which is detached from any DOM node. Four consecutive rounds of edits compiled clean, reported "Saved", never bumped the script version and never appeared on the chart. The editor is now selected by matching its DOM node against the visible container.
- `pine_save` no longer reports success it did not verify. It returns `saved: true | false | null`, where `null` means unknown. Previously an unverifiable save was indistinguishable from a confirmed one.
- `ui_open_panel('pine-editor', 'open')` works on macOS. It called `bottomWidgetBar.activateScriptEditorTab()` first and clicked `[data-name="pine-dialog-button"]` only as a fallback. On macOS the widget-bar call leaves the editor shut and leaves TradingView believing it is already open, so the click that follows is ignored. The dialog button is now tried first on any build that has it, with the widget bar kept for older builds. Measured against live charts: macOS + Desktop 3.3.0 failed every time before the change and passes 9 of 9 open/close transitions after; Windows + Desktop 3.3.0 and Windows + Chrome passed both before and after, which is why this went unnoticed.
- `ui_open_panel` verifies the panel actually changed state before returning success, and raises a classified `tv_ui_changed` error naming the dialog when it does not. It previously returned success unconditionally, which sent callers hunting for imaginary bugs downstream.
- `npm test` completes. `--test-force-exit` was gated on Node >= 25, but the flag has existed since Node 22.0.0. Without it `tests/state.test.js` passes all 30 of its tests and then holds the event loop open, and because Node's TAP reporter buffers to the end, the hang produced no output at all rather than a visible failure. The gate is now 22. The leaked handle itself is still open and worth finding.
- `js-yaml` bumped to 4.3.1 for CVE-2026-59870. It arrives through `eslint`, a devDependency, so it was never in what customers install; the failing `npm audit` step was blocking CI on every platform.

### Removed

- `skills/market-open-report`. It was built for Wayland Desktop's Smart Trader Assistant and only lived in this repo because that is where the MCP tools it drives were being written. It should never have shipped here. Four of its files are in 2.2.2 and cannot be withdrawn, npm's unpublish window having closed; they are gone from 2.2.3 onward. No strategy research, backtest data or audit was ever in a published package.

### Added

- `tests/pine_editor_finder.test.js` reproduces the exact production DOM — two `.monaco-editor.pine-editor-monaco` nodes with the first collapsed to 0x0, and three editors with index 0 detached — and is confirmed to fail against the pre-fix finder.
- `tests/ui_open_panel_order.test.js` pins the open-path ordering. It exists because the bug is macOS-specific: on Windows the old order looks correct, so nothing on that platform would object to reverting the fix.
- `.githooks/pre-push` refuses to push private research to this public remote. It scans every commit in the range rather than the net diff, because a push uploads all of them and a file added in one commit and deleted in a later one stays browsable on GitHub.

### Note on 2.2.2

2.2.2 was published on 2026-08-05 from a working tree that was never committed. `main` still read 2.2.1, no `v2.2.2` tag was cut, and no changelog entry was written. That is also how four `skills/market-open-report` files reached npm. Releases are cut from `main` from this version onward.

## [2.2.1] - 2026-08-04

### Fixed

- `tools/list` no longer fails, so MCP clients see the full tool catalog again. In 2.2.0 the request answered `-32603 Cannot read properties of undefined (reading '_zod')` and every host — Claude Code, Codex, Cursor, Wayland — reported zero tools. The cause was a one-argument `z.record()` in `strategy_sweep`: valid under Zod 3, invalid under Zod 4, which requires an explicit key type. The CLI was never affected.
- `zod` is now a declared dependency pinned to `4.3.6`. It was previously imported in 17 source files but resolved transitively through the MCP SDK, so the SDK's own dependency range decided which major version TVControl ran against — which is how a Zod major landed without a TVControl change.

### Added

- `tests/mcp_stdio.test.js` drives `initialize` and `tools/list` against `src/server.js` over real stdio, with an empty environment and a foreign working directory, and checks that every published tool converts to a usable JSON Schema. No previous test spoke MCP: the CLI and core paths never perform schema conversion, so the entire offline suite passed while the MCP server was unusable.

## [2.2.0] - 2026-07-15

### Added

- Expanded the MCP catalog from 88 to 102 chart-control and diagnostic tools.
- Added a per-tool capability matrix and runtime gating against live TradingView compatibility checks.
- Added immutable, versioned compatibility snapshots with critical-failure and informational-drift reporting.
- Added privacy-safe compressed support bundles with recursive identifier, secret, path, URL, title, source, and raw-error redaction.
- Added an in-process health watchdog plus bounded transition history.
- Added dry-run-first native watchdog service management for launchd, systemd user services, and Windows Task Scheduler.
- Added bounded chaos scenarios for CDP disconnects, renderer stalls, and tab lifecycle recovery.
- Added health, stream, watchdog, restore, and sweep soak scenarios with abort-safe receipts.
- Added receipt-producing golden workflows for chart, Pine, strategy, watchlist, snapshot, and replay operations.
- Added bulk watchlist add/remove, indicator-dialog search/add, bounded layout pagination, and saved-layout tab creation.
- Added a safe clean-checkout updater that only performs verified fast-forward updates.
- Added cross-process mutation coordination with token-owned, heartbeating filesystem leases.
- Added dedicated pane and indicator-settings regression suites.

### Changed

- Connection handling now uses configurable shared CDP endpoints, bounded HTTP/renderer timeouts, coalesced reconnects, and safer disconnect classification.
- Health checks now report Desktop version, market-data state, reconnect banners, compatibility, and actionable degradation reasons without retaining chart identifiers.
- Native tab management now drives the TradingView Desktop shell tab strip and restores/cleans up tab state more reliably.
- Strategy reads bind to exact entity IDs, unhide the selected strategy when needed, cap returned data, and report incomplete results honestly.
- Quote reads serialize temporary symbol switches and always attempt to restore the starting chart.
- Watchlist, alert, batch, capture, chart-range, stream, Pine, and sweep paths gained stricter validation, bounded waits, and cleanup reporting.
- Windows launch supports Store/MSIX installations and a versioned local fallback when the protected package cannot expose CDP.
- CI now runs lint, offline tests, dependency audit, and package checks on Linux, macOS, and Windows with Node 18 and 22.
- CI uses the Node 24-based official checkout and setup-node action runtimes.
- Offline Pine API checks were separated from live public-service compilation checks so the default suite remains deterministic.
- Dependencies are pinned and package contents are controlled by an explicit npm `files` allowlist.

### Security

- Arbitrary page-context JavaScript remains disabled by default behind `TV_MCP_ADVANCED=1` and is force-logged when used.
- TradingView target matching is hostname-anchored, CDP string interpolation uses JSON encoding, and disk JSON ingestion rejects prototype-pollution keys.
- Export/import and receipt paths are bounded; subprocess execution uses argument arrays rather than shell interpolation.
- Mutation locks prevent concurrent agents from interleaving destructive chart operations.

### Fixed

- Pane focus and symbol operations now reject negative, fractional, non-numeric, and out-of-range indexes with classified `invalid_argument` responses.
- Batch reads now fail safely when chart readiness times out instead of reading stale symbol or timeframe data.
- Indicator search limits now reject fractional and out-of-range values before opening the TradingView dialog.
- Chart readiness and quote switching now preserve exchange-qualified symbol identity, refuse unsafe mutations when starting state is unknown, and verify restoration completion.
- `tab_new` always creates and selects a fresh Desktop tab instead of reusing an existing layout-picker target.
- CLI signal handling no longer suppresses ordinary Ctrl-C termination, and stream reconnect waits are interruptible.
- Reliability receipts and support bundles reject output directories outside `~/.tv-mcp/`.
- Offline receipt and source-scan tests now use platform-native paths on Windows.
- State-changing batch, quote, sweep, and snapshot operations surface restoration and cleanup failures instead of silently leaving chart drift.
- Streaming reconnect backoff, telemetry flushing, screenshot naming, and parallel sweep worker cleanup are bounded and deterministic.

## [2.1.0] - 2026-05-28

- Published TVControl under the `@ferroxlabs/tvcontrol` npm scope.
- Moved project ownership and public documentation to Ferrox Labs.
- Shipped the initial security and stability hardening release with 88 MCP tools.

[2.2.0]: https://github.com/FerroxLabs/tvcontrol/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/FerroxLabs/tvcontrol/releases/tag/v2.1.0
