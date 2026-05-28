import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import { strategySweep } from '../core/sweep.js';

export function registerSweepTools(server) {
  // Naming note: tool names are <verb>_<noun> elsewhere (chart_get_state, etc.).
  // This tool is noun_noun ("strategy" + "sweep") because the noun "sweep" IS
  // the verb here — there is no shorter natural form. Renaming would be a
  // breaking change to MCP client configs; we keep it as-is.
  server.tool('strategy_sweep', 'Iterate a strategy across symbols × timeframes × indicator input combinations', {
    symbols: z.array(z.string()).min(1).describe('Symbols to sweep (e.g. ["ES1!", "NQ1!"])'),
    timeframes: z.array(z.string()).min(1).describe('Timeframes to sweep (e.g. ["15", "60"])'),
    inputs: z.record(z.array(z.union([z.string(), z.number()]))).optional()
      .describe('Input variations: { length: [20, 50], source: ["close", "hl2"] }'),
    entity_id: z.string().describe('Strategy study entity ID (from chart_get_state)'),
    max_combinations: z.coerce.number().int().min(1).max(500).optional()
      .describe('Max combinations allowed (default 100, abs cap 500)'),
    cooldown_ms: z.coerce.number().optional().describe('Cooldown between combos in ms (default 1500)'),
    same_symbol_cooldown_ms: z.coerce.number().optional()
      .describe('Shorter cooldown when only inputs change (same symbol+timeframe). Default 200ms; clamped to [0, cooldown_ms].'),
    timeout_per_combo_ms: z.coerce.number().optional().describe('Timeout per combo in ms (default 30000)'),
    on_error: z.enum(['continue', 'abort']).optional().describe('Error behavior (default "continue")'),
    restore_start_state: z.coerce.boolean().optional()
      .describe('Snapshot chart before sweep, restore after (default true)'),
    resume_from_run_id: z.string().optional().describe('Continue from a partial sweep run_id'),
    use_cache: z.coerce.boolean().optional()
      .describe('Reuse cached per-combo metrics from ~/.tv-mcp/sweep-cache/ within TTL (default true)'),
    cache_max_age_ms: z.coerce.number().optional()
      .describe('Cache entry TTL in ms (default 86_400_000 = 24h). Set 0 to force fresh.'),
    parallelism: z.coerce.number().int().min(1).max(6).optional()
      .describe('Spawn N worker tabs and run combos in parallel (default 1 = serial). Cap 6.'),
  }, async ({ symbols, timeframes, inputs, entity_id, max_combinations, cooldown_ms,
    same_symbol_cooldown_ms, timeout_per_combo_ms, on_error, restore_start_state,
    resume_from_run_id, use_cache, cache_max_age_ms, parallelism }) => {
    try {
      return jsonResult(await strategySweep({
        symbols, timeframes, inputs, entity_id, max_combinations, cooldown_ms,
        same_symbol_cooldown_ms, timeout_per_combo_ms, on_error, restore_start_state,
        resume_from_run_id, use_cache, cache_max_age_ms, parallelism,
      }));
    } catch (err) { return errorResult(err); }
  });
}
