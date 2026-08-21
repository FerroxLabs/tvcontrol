import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/replay.js';

export function registerReplayTools(server) {
  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date', {
    date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD format). If omitted, selects first available date.'),
  }, async ({ date }) => {
    try { return jsonResult(await core.start({ date })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try { return jsonResult(await core.step()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('replay_autoplay', 'Turn autoplay on or off in replay mode, optionally setting the speed. Pass enabled to say which state you want; omit it to flip whatever the current state is. Confirms the result by reading autoplay back.', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Note this is a DELAY, not a multiplier: 1 is rejected.'),
    enabled: z.boolean().optional().describe('true to start autoplay, false to stop it. Omit to flip the current state.'),
  }, async ({ speed, enabled }) => {
    try { return jsonResult(await core.autoplay({ speed, enabled })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: z.string().describe('Trade action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status()); }
    catch (err) { return errorResult(err); }
  });
}
