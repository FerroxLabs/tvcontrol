# Changelog

All notable changes to TVControl are documented here. This project follows [Semantic Versioning](https://semver.org/).

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
