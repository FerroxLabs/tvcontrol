#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '..', 'src', 'tools');

const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js') && !f.startsWith('_'));
let total = 0;
const byFile = {};
for (const f of files) {
  const src = readFileSync(join(TOOLS_DIR, f), 'utf8');
  const matches = src.match(/server\.tool\(/g) || [];
  byFile[f] = matches.length;
  total += matches.length;
}

console.log(JSON.stringify({ total, by_file: byFile }, null, 2));
