import { register } from '../router.js';
import { runChaos } from '../../core/chaos.js';
import { runSoak } from '../../core/soak.js';
import { readFileSync } from 'node:fs';
import { runGolden } from '../../core/golden.js';

register('chaos', {
  description: 'Run bounded TradingView recovery fault injection (dry-run by default)',
  options: {
    scenarios: { type: 'string', short: 's', description: 'Comma-separated: cdp_disconnect,renderer_stall,tab_cycle' },
    'allow-live-faults': { type: 'boolean', description: 'Required to inject faults into the live Desktop session' },
    'timeout-ms': { type: 'string', description: 'Bounded probe timeout in milliseconds (250-10000, default 1000)' },
    'output-dir': { type: 'string', description: 'Receipt directory within ~/.tv-mcp/' },
  },
  handler: (opts) => runChaos({
    scenarios: opts.scenarios,
    allow_live_faults: opts['allow-live-faults'],
    timeout_ms: opts['timeout-ms'] === undefined ? 1000 : Number(opts['timeout-ms']),
    output_dir: opts['output-dir'],
  }),
});

register('soak', {
  description: 'Run bounded long-duration health, stream, watchdog, restore, or sweep probes',
  options: {
    scenarios: { type: 'string', short: 's', description: 'Comma-separated: health,stream,watchdog,restore,sweep' },
    'duration-ms': { type: 'string', description: 'Duration in milliseconds (default 60000, max 24h)' },
    'interval-ms': { type: 'string', description: 'Delay between rounds (default 5000, min 250)' },
    'max-samples': { type: 'string', description: 'Hard sample cap (default 100000)' },
    'allow-mutations': { type: 'boolean', description: 'Required for restore and sweep scenarios' },
    'sweep-config': { type: 'string', description: 'JSON file passed to strategy sweep' },
    'output-dir': { type: 'string', description: 'Receipt directory within ~/.tv-mcp/' },
  },
  handler: async (opts) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const sweepConfig = opts['sweep-config'] ? JSON.parse(readFileSync(opts['sweep-config'], 'utf8')) : undefined;
      return await runSoak({
        scenarios: opts.scenarios,
        duration_ms: opts['duration-ms'] === undefined ? 60_000 : Number(opts['duration-ms']),
        interval_ms: opts['interval-ms'] === undefined ? 5_000 : Number(opts['interval-ms']),
        max_samples: opts['max-samples'] === undefined ? 100_000 : Number(opts['max-samples']),
        allow_mutations: opts['allow-mutations'],
        sweep_config: sweepConfig,
        output_dir: opts['output-dir'],
        signal: controller.signal,
      });
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  },
});

register('golden', {
  description: 'Run receipt-producing live workflows across chart, Pine, strategy, watchlist, snapshot, and replay',
  options: {
    workflows: { type: 'string', short: 'w', description: 'Comma-separated workflow names or all (default all)' },
    'allow-mutations': { type: 'boolean', description: 'Allow temporary snapshot restore and replay lifecycle checks' },
    'replay-date': { type: 'string', description: 'Replay start date (YYYY-MM-DD); requires --allow-mutations' },
    'strategy-entity-id': { type: 'string', description: 'Exact strategy entity ID; auto-detects names containing Strategy otherwise' },
    'output-dir': { type: 'string', description: 'Receipt directory within ~/.tv-mcp/' },
  },
  handler: (opts) => runGolden({
    workflows: opts.workflows,
    allow_mutations: opts['allow-mutations'],
    replay_date: opts['replay-date'],
    strategy_entity_id: opts['strategy-entity-id'],
    output_dir: opts['output-dir'],
  }),
});
