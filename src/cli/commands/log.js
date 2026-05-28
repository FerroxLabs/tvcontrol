import { register } from '../router.js';
import { tail, clear } from '../../core/telemetry.js';

register('log', {
  description: 'Session telemetry log (requires TV_MCP_TELEMETRY=1)',
  subcommands: new Map([
    ['tail', {
      description: 'Print the last N lines from the telemetry log',
      options: {
        lines: { type: 'string', short: 'n', description: 'Number of lines (default 50)' },
      },
      handler: (opts) => {
        const n = opts.lines ? Number(opts.lines) : 50;
        return { lines: tail({ n }) };
      },
    }],
    ['clear', {
      description: 'Empty the telemetry log file',
      handler: () => clear(),
    }],
  ]),
});
