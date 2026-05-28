import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/pane.js';

register('pane', {
  description: 'Chart pane/layout tools (list, layout, focus, symbol)',
  subcommands: new Map([
    ['list', {
      description: 'List all panes in the current layout',
      handler: () => core.list(),
    }],
    ['layout', {
      description: 'Set chart grid layout (s, 2h, 2v, 2x2, 4, 6, 8)',
      usage: '<layout>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Layout required. Usage: tv pane layout 2x2');
        return core.setLayout({ layout: positionals[0] });
      },
    }],
    ['focus', {
      description: 'Focus a specific pane by index',
      usage: '<index>',
      handler: (opts, positionals) => {
        _arg(positionals[0] !== undefined, 'Index required. Usage: tv pane focus 0');
        return core.focus({ index: positionals[0] });
      },
    }],
    ['symbol', {
      description: 'Set symbol on a specific pane',
      usage: '<index> <symbol>',
      handler: (opts, positionals) => {
        _arg(positionals.length >= 2, 'Usage: tv pane symbol 1 ES1!');
        return core.setSymbol({ index: positionals[0], symbol: positionals[1] });
      },
    }],
  ]),
});
