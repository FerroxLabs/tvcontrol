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
        'no-mobile-push': { type: 'boolean', description: 'Disable mobile push notification' },
        'expiration-days': { type: 'string', description: 'Expiration in days (1-365; default 30)' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
        mobile_push: !opts['no-mobile-push'],
        expiration_days: opts['expiration-days'] ? Number(opts['expiration-days']) : undefined,
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
        return core.deleteAlerts({ alert_id: opts.id, delete_all: opts.all });
      },
    }],
  ]),
});
