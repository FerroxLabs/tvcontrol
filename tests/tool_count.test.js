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

/**
 * THE SERVER USED TO LIE ABOUT ITSELF.
 *
 * Measured 2026-08-21: package.json 2.2.6, npm 2.2.6, and server.js
 * introducing itself as version 2.2.1 with "102 tools" while registering 103
 * of a 104-tool catalog. Three hand-maintained numbers, all wrong, none
 * checked. The tool-count test above compared the counting script to a regex
 * over the same files — it could not see any of it, because the server was
 * never in the loop.
 *
 * These read what the server actually says on the wire.
 */
describe('the server describes itself accurately', () => {
  const boot = () => {
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n';
    const out = execFileSync(process.execPath, [join(__dirname, '..', 'src', 'server.js')], {
      input: msgs, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const frames = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return {
      init: frames.find((f) => f.id === 1)?.result,
      tools: frames.find((f) => f.id === 2)?.result?.tools,
    };
  };

  it('advertises the version in package.json, not a hardcoded one', () => {
    const { init } = boot();
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(init.serverInfo.version, pkg.version);
  });

  it('advertises the number of tools it actually registers', () => {
    const { init, tools } = boot();
    assert.ok(Array.isArray(tools) && tools.length > 0, 'server returned no tools');
    const headline = Number(/tvcontrol — (\d+) tools/.exec(init.instructions)?.[1]);
    assert.equal(headline, tools.length,
      `instructions say ${headline} tools, tools/list returns ${tools.length}`);
    assert.match(init.serverInfo.description || init.instructions,
      new RegExp(`${tools.length} MCP tools|tvcontrol — ${tools.length} tools`));
  });

  it('the gated-tool sentence matches the real catalog and the real default', () => {
    const { init, tools } = boot();
    const m = /Of the (\d+)-tool catalog, (\d+) are available/.exec(init.instructions);
    assert.ok(m, 'the ui_evaluate gate sentence is missing from instructions');
    const [, catalog, byDefault] = m.map(Number);
    const total = JSON.parse(execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' })).total;
    assert.equal(catalog, total, 'catalog size in instructions does not match count_tools.js');
    assert.equal(byDefault, tools.length, 'default-available count does not match tools/list');
    assert.equal(catalog - byDefault, 1, 'exactly one tool (ui_evaluate) should be gated');
    assert.ok(!tools.some((t) => t.name === 'ui_evaluate'),
      'ui_evaluate must not be registered without TV_MCP_ADVANCED=1');
  });

  it('the README states the number of tools the server actually registers', () => {
    // Caught during the 2.3.0 pre-flight by booting the packed tarball: the
    // README said 106, which is the CATALOG total including the gated
    // ui_evaluate, while the server registers 105. A count in the README is a
    // claim about the product, and this release is entirely about claims that
    // do not match what the thing does.
    const { tools } = boot();
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    // The bold in the README runs to the end of the sentence, so anchoring on a
    // closing ** right after "MCP tools" matched nothing. The first version of
    // this test did exactly that and passed while the README was wrong, which
    // is the failure mode it exists to prevent. Match the number and the phrase
    // wherever they appear.
    const claims = [
      ...readme.matchAll(/(\d+)\s+MCP tools/g),
      ...readme.matchAll(/(\d+)\s+chart-control and diagnostic tools/g),
    ].map((m) => Number(m[1]));
    assert.ok(claims.length >= 1, 'the README no longer states a tool count');
    for (const claimed of claims) {
      assert.equal(claimed, tools.length,
        `README claims ${claimed} tools, the server registers ${tools.length}`);
    }
  });
});
