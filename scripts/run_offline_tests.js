#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tests = readdirSync('tests')
  .filter((name) => name.endsWith('.test.js') && !['e2e.test.js', 'pine_api.test.js'].includes(name))
  .sort()
  .map((name) => join('tests', name));

const args = ['--test'];
if (Number(process.versions.node.split('.')[0]) >= 25) args.push('--test-force-exit');
args.push(...tests);

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
