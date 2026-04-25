import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/state.js';

register('state', {
  description: 'Chart state snapshot tools (snapshot, restore, list, delete)',
  subcommands: new Map([
    ['snapshot', {
      description: 'Capture current chart state to a named snapshot',
      options: {
        name: { type: 'string', short: 'n', description: 'Snapshot name' },
      },
      handler: (opts) => {
        _arg(opts.name, 'Name required. Usage: tv state snapshot --name <name>');
        return core.snapshot({ name: opts.name });
      },
    }],
    ['restore', {
      description: 'Restore chart state from a named snapshot',
      options: {
        name: { type: 'string', short: 'n', description: 'Snapshot name' },
      },
      handler: (opts) => {
        _arg(opts.name, 'Name required. Usage: tv state restore --name <name>');
        return core.restore({ name: opts.name });
      },
    }],
    ['list', {
      description: 'List all saved snapshots',
      handler: () => core.list(),
    }],
    ['delete', {
      description: 'Delete a named snapshot',
      options: {
        name: { type: 'string', short: 'n', description: 'Snapshot name' },
      },
      handler: (opts) => {
        _arg(opts.name, 'Name required. Usage: tv state delete --name <name>');
        return core.deleteSnapshot({ name: opts.name });
      },
    }],
  ]),
});
