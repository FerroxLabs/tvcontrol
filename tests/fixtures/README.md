# Test Fixtures

VCR-style captured data used by offline unit tests.

## Why fixtures

Mocks without real data risk testing our mocks instead of the code.
Fixtures are captured *once* against a live TradingView session and then
used by unit tests so we exercise the same response shapes the code will
see in production.

## Conventions

- One file per real-world response: `<area>-<action>.json` or `.html` for DOM snippets.
- JSON fixtures are pretty-printed (2-space indent) so diffs are readable.
- HTML fixtures are raw text. Keep them small — trim to the element we scrape.
- Add a comment at the top of every fixture noting the capture date + TV app version.
- Never include PII: alert_ids, account-specific layouts, or personal notes are OK
  (they're local-only), but strip anything that identifies other people.

## How to add a new fixture

1. Run the tool against a live TV session with the `TV_CAPTURE_FIXTURES=1` env var.
2. The tool writes the raw response to `tests/fixtures/<name>.json`.
3. Review the file — trim, anonymize, or simplify as appropriate.
4. Reference it from your unit test via `loadFixture('<name>')` or `loadFixtureRaw('<name>', 'html')`.

## How to use in a test

```js
import { loadFixture } from './_helpers.js';

const alertsResponse = loadFixture('alerts-list-response');
// ... use in a mock fetch or mock evaluate
```

## Refreshing fixtures

Fixtures rot. When TradingView changes a response shape, the corresponding test
will fail. Workflow:
1. Fail → inspect actual vs fixture
2. If the change is real (not a bug in our code), recapture the fixture
3. Update any assertions that depended on the old shape
4. Note the change in commit message: `test(fixtures): refresh alerts-list for TV 2.x`

## Current fixtures

| File | Shape | Used by |
|---|---|---|
| `alerts-list-response.json` | pricealerts.tradingview.com/list_alerts response | alerts tests |
| `chart-state.json` | chart_get_state return value | state tests |
| `pine-facade-list.json` | pine-facade.tradingview.com/list response | pine tests |
| `data-window.html` | Data Window DOM snippet | data_get_indicator DOM fallback tests |
