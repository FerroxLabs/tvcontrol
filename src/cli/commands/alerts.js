import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['delete', {
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
        id: { type: 'string', short: 'i', description: 'Alert ID to delete' },
      },
      handler: (opts) => {
        _arg(opts.id || opts.all, '--id <alert_id> or --all required. Usage: tv alert delete --id 12345  |  tv alert delete --all');
        return opts.id
          ? core.deleteById({ alert_id: opts.id })
          : core.deleteAlerts({ delete_all: opts.all });
      },
    }],
  ]),
});
