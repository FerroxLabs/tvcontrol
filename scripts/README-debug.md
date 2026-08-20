
## Pine editor diagnostics (added 2026-08-20)

Three scripts kept from the silent-save investigation. They exist because the
Pine editor lies about its own state in ways that are hard to see:

- `peek.mjs` — prints the LIVE editor buffer: line count, read-only flag, and a
  few feature markers. Run this BEFORE any push. A blank-looking buffer proves
  nothing about which saved script is bound, and this is the cheapest way to see
  what you are about to overwrite.
- `verify_finder.mjs` — runs the current `FIND_MONACO` from `src/core/pine.js`
  against the live page and prints what it resolved, alongside the pre-fix
  logic. Use it when TradingView ships a UI change and pushes start failing.
- `alleditors.mjs` — enumerates every Pine editor instance and its buffer. This
  is what exposed the bug: `getEditors()` returned three editors and index 0 was
  detached, so writes vanished while everything reported success.

`pine_save_focused.mjs` and `updatechart.mjs` are one-shot helpers: focus the
editor before sending the save chord (the same chord saves the CHART LAYOUT when
focus is elsewhere), and click "Update on chart", which is what actually pushes a
saved script to an already-added study.
