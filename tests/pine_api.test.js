/**
 * Live Pine facade checks. These require network access and are intentionally
 * excluded from npm test / test:offline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/core/pine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cli', 'index.js');

function runCli(source) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'pine', 'check'], {
      input: source,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (err) {
    return { exitCode: err.status, stderr: err.stderr || '' };
  }
}

describe('pine_check — live TradingView compile service', () => {
  it('compiles a valid Pine script through the core API', async () => {
    const result = await check({ source: '//@version=6\nindicator("API Test")\nplot(close)' });
    assert.equal(result.success, true);
    assert.equal(result.compiled, true);
  });

  it('returns compiler diagnostics for invalid Pine', async () => {
    const result = await check({ source: '//@version=6\nindicator("Bad")\nthis_function_does_not_exist()' });
    assert.equal(result.compiled, false);
    assert.ok(result.error_count > 0);
  });

  it('keeps CLI valid/invalid compile behavior wired end to end', () => {
    const valid = runCli('//@version=6\nindicator("test")\nplot(close)');
    assert.equal(valid.exitCode, 0);
    assert.equal(valid.result.compiled, true);

    const invalid = runCli('//@version=6\nindicator("test")\nplot(nonexistent_var)');
    assert.equal(invalid.exitCode, 0);
    assert.equal(invalid.result.compiled, false);
    assert.ok(invalid.result.error_count > 0);
  });
});
