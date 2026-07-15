import { register } from '../router.js';
import * as core from '../../core/health.js';
import * as watchdog from '../../core/watchdog.js';
import { update } from '../../core/update.js';
import { getCapabilityMatrix } from '../../core/capabilities.js';
import { createSupportBundle } from '../../core/support.js';
import { manageWatchdogService } from '../../core/watchdog_service.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

register('launch', {
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'kill-existing': { type: 'boolean', description: 'Explicitly kill existing TradingView instances first' },
    'no-kill': { type: 'boolean', description: 'Deprecated compatibility flag; launching is non-destructive by default' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: opts['kill-existing'] === true && opts['no-kill'] !== true,
  }),
});

register('compatibility', {
  description: 'Check APIs or record/compare/list versioned compatibility baselines',
  options: {
    record: { type: 'boolean', description: 'Record an immutable baseline for this Desktop version' },
    compare: { type: 'boolean', description: 'Compare with this Desktop version baseline' },
    list: { type: 'boolean', description: 'List recorded Desktop version baselines' },
    overwrite: { type: 'boolean', description: 'Replace an existing baseline (requires --record)' },
  },
  handler: (opts) => {
    const actions = ['record', 'compare', 'list'].filter((name) => opts[name]);
    if (actions.length > 1) throw new Error('Use only one of --record, --compare, or --list');
    if (opts.overwrite && !opts.record) throw new Error('--overwrite requires --record');
    if (actions.length === 0) return core.compatibilityCheck();
    return core.compatibilitySnapshot({ action: actions[0], overwrite: opts.overwrite });
  },
});

register('capabilities', {
  description: 'Show per-tool TradingView API requirements and runtime availability',
  options: {
    offline: { type: 'boolean', description: 'Show the matrix without probing TradingView' },
    force: { type: 'boolean', description: 'Bypass the short compatibility cache' },
  },
  handler: (opts) => getCapabilityMatrix({ probe: !opts.offline, force: opts.force }),
});

register('support', {
  description: 'Create a privacy-safe compressed diagnostics bundle',
  options: {
    'telemetry-lines': { type: 'string', short: 'n', description: 'Recent telemetry records (0-500, default 100)' },
    'output-dir': { type: 'string', description: 'Bundle directory within ~/.tv-mcp/' },
  },
  handler: (opts) => createSupportBundle({
    telemetry_lines: opts['telemetry-lines'] === undefined ? 100 : Number(opts['telemetry-lines']),
    output_dir: opts['output-dir'],
  }),
});

register('watchdog', {
  description: 'Sample health or inspect bounded state-transition history',
  subcommands: new Map([
    ['sample', {
      description: 'Run one read-only watchdog sample',
      handler: () => watchdog.sampleWatchdog(),
    }],
    ['status', {
      description: 'Show in-process watchdog status (primarily useful in MCP)',
      handler: () => watchdog.watchdogStatus(),
    }],
    ['history', {
      description: 'Show recent privacy-safe state transitions',
      options: { limit: { type: 'string', short: 'n', description: 'Number of transitions (default 100, max 500)' } },
      handler: (opts) => watchdog.watchdogHistory({ limit: opts.limit ? Number(opts.limit) : undefined }),
    }],
    ['service-plan', {
      description: 'Show the native OS watchdog service definition and commands without changing state',
      options: { 'interval-ms': { type: 'string', description: 'Sampling interval (default 15000)' } },
      handler: (opts) => manageWatchdogService({ action: 'plan', interval_ms: opts['interval-ms'] === undefined ? 15_000 : Number(opts['interval-ms']) }),
    }],
    ['install', {
      description: 'Install the native OS watchdog service (dry-run unless --apply)',
      options: {
        apply: { type: 'boolean', description: 'Write and activate the native service definition' },
        'interval-ms': { type: 'string', description: 'Sampling interval (default 15000)' },
      },
      handler: (opts) => manageWatchdogService({ action: 'install', apply: opts.apply, interval_ms: opts['interval-ms'] === undefined ? 15_000 : Number(opts['interval-ms']) }),
    }],
    ['uninstall', {
      description: 'Remove the native OS watchdog service (dry-run unless --apply)',
      options: { apply: { type: 'boolean', description: 'Deactivate and remove the native service definition' } },
      handler: (opts) => manageWatchdogService({ action: 'uninstall', apply: opts.apply }),
    }],
    ['service-status', {
      description: 'Inspect the native OS watchdog service',
      handler: () => manageWatchdogService({ action: 'status' }),
    }],
  ]),
});

register('update', {
  description: 'Safely update a clean git checkout from its configured upstream',
  handler: () => update({}),
});
