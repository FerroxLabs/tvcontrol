import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, add-bulk, remove, export, import)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      usage: '<symbol>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['add-bulk', {
      description: 'Add multiple symbols to the watchlist',
      usage: '<symbol> [symbol ...]',
      handler: (opts, positionals) => {
        _arg(positionals.length, 'Symbols required. Usage: tv watchlist add-bulk AAPL MSFT');
        return core.addBulk({ symbols: positionals });
      },
    }],
    ['remove', {
      description: 'Remove a symbol from the watchlist',
      usage: '<symbol> | --symbol <symbol>',
      options: {
        symbol: { type: 'string', short: 's', description: 'Symbol to remove (alternate form)' },
      },
      handler: (opts, positionals) => {
        const symbols = positionals.length ? positionals : (opts.symbol ? [opts.symbol] : []);
        _arg(symbols.length, 'Symbol required. Usage: tv watchlist remove AAPL [MSFT ...]');
        return symbols.length === 1 ? core.remove({ symbol: symbols[0] }) : core.removeBulk({ symbols });
      },
    }],
    ['export', {
      description: 'Export the watchlist to a JSON file',
      options: {
        file: { type: 'string', description: 'Destination file path (default: ~/.tv-mcp/watchlists/watchlist-<timestamp>.json)' },
      },
      handler: (opts) => core.exportTo({ file_path: opts.file }),
    }],
    ['import', {
      description: 'Import symbols into the watchlist from a JSON file',
      options: {
        file: { type: 'string', description: 'Path to the JSON file to import' },
        mode: { type: 'string', description: 'merge (default) or replace' },
        'dry-run': { type: 'boolean', description: 'Preview changes without applying them' },
      },
      handler: (opts) => {
        _arg(opts.file, 'File required. Usage: tv watchlist import --file <path>');
        return core.importFrom({ file_path: opts.file, mode: opts.mode, dry_run: opts['dry-run'] });
      },
    }],
  ]),
});
