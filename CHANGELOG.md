# Changelog

All notable changes to TVControl are documented here. This project follows [Semantic Versioning](https://semver.org/).

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
