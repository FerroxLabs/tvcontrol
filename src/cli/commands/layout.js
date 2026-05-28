import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/ui.js';

register('layout', {
  description: 'Layout tools (list, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List saved chart layouts',
      handler: () => core.layoutList(),
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
