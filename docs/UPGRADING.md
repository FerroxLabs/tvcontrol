# Upgrading TVControl

## npm installation

```bash
npm install -g @ferroxlabs/tvcontrol@2.2.0
tv --help
```

Restart the MCP client that launches TVControl so it reloads the new server process.

## Git checkout

The built-in updater only fast-forwards a clean checkout with a configured upstream:

```bash
tv update
```

Or update manually:

```bash
git pull --ff-only
npm ci
```

Never discard a dirty checkout to update it. Commit, stash, or move local work first.

## Post-upgrade verification

With TradingView Desktop running on the configured CDP port:

```bash
tv status
tv compatibility
tv capabilities
tv golden --workflows chart_analysis,pine_compile,watchlist
```

The first three commands are read-only. The listed golden workflows are also read-only; snapshot and replay checks require `--allow-mutations`.

## Behavior to know in 2.2.0

- TVControl coordinates chart mutations across MCP and CLI processes. A second mutation may wait briefly or return a classified busy response instead of interleaving with the first.
- `ui_evaluate` is not registered unless `TV_MCP_ADVANCED=1` is explicitly set.
- Chaos tests, mutation-capable soak scenarios, native watchdog installation, and native watchdog removal remain dry-run or disabled until their explicit safety flags are present.
- Support bundles, watchdog history, compatibility snapshots, and reliability receipts live under `~/.tv-mcp` unless an allowed output directory is supplied.
- TradingView Desktop upgrades can change internal APIs. Record or compare a compatibility snapshot before relying on a new Desktop build.

## Rollback

For npm installations:

```bash
npm install -g @ferroxlabs/tvcontrol@2.1.0
```

For Git installations, check out the desired release tag and run `npm ci`. Do not roll back while a sweep, replay, or watchdog installation is active.
