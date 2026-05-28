import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['switch', {
      description: 'Switch to a tab by index',
      usage: '<index>',
      handler: (opts, positionals) => {
        _arg(positionals[0] !== undefined, 'Index required. Usage: tv tab switch 0');
        return core.switchTab({ index: positionals[0] });
      },
    }],
  ]),
});
