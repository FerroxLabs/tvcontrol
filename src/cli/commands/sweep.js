import { register } from '../router.js';
import { _arg } from '../_arg.js';
import { strategySweep } from '../../core/sweep.js';

register('sweep', {
  description: 'Sweep a strategy across symbols × timeframes × input combinations',
  options: {
    symbols: { type: 'string', short: 's', description: 'Comma-separated symbols (e.g. ES1!,NQ1!)' },
    timeframes: { type: 'string', short: 't', description: 'Comma-separated timeframes (e.g. 15,60)' },
    inputs: { type: 'string', short: 'i', description: 'JSON input variations e.g. \'{"length":[20,50]}\'' },
    'entity-id': { type: 'string', short: 'e', description: 'Strategy study entity ID' },
    'max-combinations': { type: 'string', description: 'Max combinations (default 100, cap 500)' },
    'cooldown-ms': { type: 'string', description: 'Cooldown between combos in ms (default 1500)' },
    'same-symbol-cooldown-ms': { type: 'string', description: 'Cooldown when only inputs change between combos (default 200)' },
    'timeout-per-combo-ms': { type: 'string', description: 'Timeout per combo in ms (default 30000)' },
    'on-error': { type: 'string', description: '"continue" or "abort" (default continue)' },
    'no-restore': { type: 'boolean', description: 'Skip snapshot/restore of start state' },
    'no-cache': { type: 'boolean', description: 'Force fresh computation; ignore ~/.tv-mcp/sweep-cache/' },
    'cache-max-age-ms': { type: 'string', description: 'Cache TTL in ms (default 86_400_000 = 24h)' },
    parallelism: { type: 'string', short: 'p', description: 'Spawn N worker tabs (default 1, cap 6)' },
    resume: { type: 'string', short: 'r', description: 'Resume from a partial run_id' },
  },
  handler: (opts) => {
    _arg(opts.symbols, '--symbols required. Usage: tv sweep --symbols ES1!,NQ1! --timeframes 15,60 --entity-id st_xxx');
    _arg(opts.timeframes, '--timeframes required.');
    const entityId = opts['entity-id'];
    _arg(entityId, '--entity-id required.');

    const symbols = opts.symbols.split(',').map(s => s.trim());
    const timeframes = opts.timeframes.split(',').map(t => t.trim());
    const inputs = opts.inputs ? JSON.parse(opts.inputs) : {};

    return strategySweep({
      symbols,
      timeframes,
      inputs,
      entity_id: entityId,
      max_combinations: opts['max-combinations'] ? Number(opts['max-combinations']) : undefined,
      cooldown_ms: opts['cooldown-ms'] ? Number(opts['cooldown-ms']) : undefined,
      same_symbol_cooldown_ms: opts['same-symbol-cooldown-ms'] ? Number(opts['same-symbol-cooldown-ms']) : undefined,
      timeout_per_combo_ms: opts['timeout-per-combo-ms'] ? Number(opts['timeout-per-combo-ms']) : undefined,
      on_error: opts['on-error'] || undefined,
      restore_start_state: opts['no-restore'] ? false : true,
      use_cache: opts['no-cache'] ? false : undefined,
      cache_max_age_ms: opts['cache-max-age-ms'] ? Number(opts['cache-max-age-ms']) : undefined,
      parallelism: opts.parallelism ? Number(opts.parallelism) : undefined,
      resume_from_run_id: opts.resume || undefined,
    });
  },
});
