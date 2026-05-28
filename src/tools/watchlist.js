import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      return errorResult(err);
    }
  });

  server.tool('watchlist_remove', 'Remove a symbol from the TradingView watchlist', {
    symbol: z.string().describe('Symbol to remove (e.g., AAPL)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.remove({ symbol })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('watchlist_export', 'Export the current watchlist to a JSON file on disk', {
    file_path: z.string().optional().describe('Destination path (default: ~/.tv-mcp/watchlists/watchlist-<timestamp>.json)'),
  }, async ({ file_path }) => {
    try { return jsonResult(await core.exportTo({ file_path })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('watchlist_import', 'Import symbols into the TradingView watchlist from a JSON file', {
    file_path: z.string().describe('Path to the JSON file previously exported by watchlist_export'),
    mode: z.enum(['merge', 'replace']).optional().default('merge').describe('merge = add missing symbols; replace = sync list to file'),
    dry_run: z.coerce.boolean().optional().default(false).describe('Preview changes without modifying the watchlist'),
  }, async ({ file_path, mode, dry_run }) => {
    try { return jsonResult(await core.importFrom({ file_path, mode, dry_run })); }
    catch (err) { return errorResult(err); }
  });
}
