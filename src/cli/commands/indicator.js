import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as chartCore from '../../core/chart.js';
import * as indCore from '../../core/indicators.js';
import * as dataCore from '../../core/data.js';

register('indicator', {
  description: 'Indicator tools (add, remove, toggle, set, get)',
  subcommands: new Map([
    ['add', {
      description: 'Add an indicator to the chart',
      usage: '<indicator_name> [-i <json>]',
      options: {
        inputs: { type: 'string', short: 'i', description: 'JSON input overrides' },
      },
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Indicator name required. Usage: tv indicator add "Volume"');
        return chartCore.manageIndicator({ action: 'add', indicator: positionals.join(' '), inputs: opts.inputs });
      },
    }],
    ['remove', {
      description: 'Remove an indicator by entity ID',
      usage: '<entity_id>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Entity ID required. Usage: tv indicator remove eFu1Ot');
        return chartCore.manageIndicator({ action: 'remove', indicator: '', entity_id: positionals[0] });
      },
    }],
    ['toggle', {
      description: 'Show or hide an indicator',
      usage: '<entity_id> [--visible | --hidden]',
      options: {
        visible: { type: 'boolean', description: 'Show (true) or hide (false)' },
        hidden: { type: 'boolean', description: 'Hide the indicator' },
      },
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Entity ID required. Usage: tv indicator toggle eFu1Ot --visible');
        const visible = opts.hidden ? false : (opts.visible !== undefined ? opts.visible : true);
        return indCore.toggleVisibility({ entity_id: positionals[0], visible });
      },
    }],
    ['set', {
      description: 'Change indicator input values',
      usage: '<entity_id> -i <json>',
      options: {
        inputs: { type: 'string', short: 'i', description: 'JSON input overrides, e.g. \'{"length": 50}\'' },
      },
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Entity ID required. Usage: tv indicator set eFu1Ot -i \'{"in_3": 20}\'');
        _arg(opts.inputs, 'Inputs required. Usage: tv indicator set eFu1Ot -i \'{"in_3": 20}\'');
        return indCore.setInputs({ entity_id: positionals[0], inputs: opts.inputs });
      },
    }],
    ['get', {
      description: 'Get indicator info and inputs',
      usage: '<entity_id>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Entity ID required. Usage: tv indicator get eFu1Ot');
        return dataCore.getIndicator({ entity_id: positionals[0] });
      },
    }],
  ]),
});
