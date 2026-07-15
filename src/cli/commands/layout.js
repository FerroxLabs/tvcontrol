import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/ui.js';

register('layout', {
  description: 'Layout tools (list, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List saved chart layouts',
      options: {
        limit: { type: 'string', description: 'Maximum layouts to return (1-100; default 50)' },
        offset: { type: 'string', description: 'Pagination offset' },
        details: { type: 'boolean', description: 'Include symbol, resolution, and modification metadata' },
      },
      handler: (opts) => core.layoutList({ limit: opts.limit, offset: opts.offset, include_details: opts.details }),
    }],
    ['switch', {
      description: 'Switch to a saved layout by name or ID',
      usage: '<layout_name>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Layout name required. Usage: tv layout switch "My Layout"');
        return core.layoutSwitch({ name: positionals.join(' ') });
      },
    }],
  ]),
});
