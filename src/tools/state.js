import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/state.js';

export function registerStateTools(server) {
  server.tool('state_snapshot', 'Capture full chart state (symbol, timeframe, studies, drawings, visible range) to a named snapshot file', {
    name: z.string().describe('Snapshot name (e.g., "my-setup"). No slashes or ".."'),
    overwrite: z.coerce.boolean().optional().default(false).describe('Overwrite existing snapshot with the same name (default: false)'),
  }, async ({ name, overwrite }) => {
    try { return jsonResult(await core.snapshot({ name, overwrite })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('state_restore', 'Restore a previously saved chart state snapshot by name', {
    name: z.string().describe('Snapshot name to restore'),
  }, async ({ name }) => {
    try { return jsonResult(await core.restore({ name })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('state_list', 'List all saved chart state snapshots sorted by capture date', {}, async () => {
    try { return jsonResult(core.list()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('state_delete', 'Delete a named chart state snapshot', {
    name: z.string().describe('Snapshot name to delete'),
  }, async ({ name }) => {
    try { return jsonResult(core.deleteSnapshot({ name })); }
    catch (err) { return errorResult(err); }
  });
}
