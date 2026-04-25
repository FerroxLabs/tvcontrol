import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '..', 'src', 'tools');
const SCRIPT = join(__dirname, '..', 'scripts', 'count_tools.js');

describe('count_tools.js', () => {
  it('returns a positive integer total matching live dir regex count', () => {
    const output = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    const result = JSON.parse(output);

    assert.ok(typeof result.total === 'number', 'total should be a number');
    assert.ok(result.total > 0, 'total should be positive');

    // Cross-check against our own regex scan
    const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js') && !f.startsWith('_'));
    let expected = 0;
    for (const f of files) {
      const src = readFileSync(join(TOOLS_DIR, f), 'utf8');
      const matches = src.match(/server\.tool\(/g) || [];
      expected += matches.length;
    }

    assert.equal(result.total, expected, `script reports ${result.total} but dir has ${expected}`);
  });
});
