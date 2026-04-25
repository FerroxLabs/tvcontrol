/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';
import { CATEGORIES } from '../errors.js';

// Categories that map to exit code 2 (connection / pre-flight failures).
// Shell scripts can use `if [ $? -eq 2 ]` to retry-with-launch logic.
const EXIT2_CATEGORIES = new Set([
  CATEGORIES.TV_NOT_RUNNING,
  CATEGORIES.CDP_DISCONNECTED,
]);

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    // Auto-pad to longest subcommand name + 2 (W4-L1). Was hardcoded
    // padEnd(12), so subcommand names ≥ 11 chars (e.g., "delete_by_id")
    // collided with their description text.
    const subWidth = Math.max(12, ...[...cmd.subcommands.keys()].map(k => k.length + 2));
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(subWidth)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name}${cmd.usage ? ' ' + cmd.usage : ' [options]'}\n`);
    console.log(cmd.description);
  }
  printOptionsBlock(cmd.options);
}

function _flagFor(k, v) {
  return v.short ? `-${v.short}, --${k}` : `    --${k}`;
}

function printOptionsBlock(opts) {
  if (!opts || Object.keys(opts).length === 0) return;
  console.log('\nOptions:');
  // Compute padding from the widest flag so long flags (--max-combinations)
  // do not collide with their description text. Min 20 for visual rhythm.
  const widest = Math.max(20, ...Object.entries(opts).map(([k, v]) => _flagFor(k, v).length + 2));
  for (const [k, v] of Object.entries(opts)) {
    console.log(`  ${_flagFor(k, v).padEnd(widest)}${v.description || ''}`);
  }
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  // Handle subcommands (e.g., tv pine get)
  let handler, options;
  if (cmd.subcommands) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      printCommandHelp(cmdName, cmd);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName}${sub.usage ? ' ' + sub.usage : ' [options]'}\n`);
        console.log(sub.description);
        printOptionsBlock(options);
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  }
}

async function execute(handler, values, positionals) {
  try {
    const result = await handler(values, positionals);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err) {
  const message = err.message || String(err);
  const category = err?.category;
  const hint = err?.hint;
  const payload = { success: false, error: message };
  if (category) payload.category = category;
  if (hint) payload.hint = hint;
  console.error(JSON.stringify(payload, null, 2));
  // Prefer the structured category for exit-code routing — it's stable across
  // error-message rephrasings. Fall back to regex match only for non-classified
  // errors (legacy throw new Error sites). W4-M4.
  if (category && EXIT2_CATEGORIES.has(category)) {
    process.exit(2);
  }
  if (!category && /CDP|connection|ECONNREFUSED|not running/i.test(message)) {
    process.exit(2);
  }
  process.exit(1);
}
