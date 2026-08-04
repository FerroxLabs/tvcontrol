/**
 * MCP protocol tests — speaks JSON-RPC to src/server.js over real stdio.
 *
 * Every other test in this suite exercises the CLI or the core modules
 * directly, and neither path ever converts a tool's Zod schema to JSON Schema.
 * That conversion happens only inside the MCP SDK's `tools/list` handler, so a
 * schema the SDK cannot convert takes down every MCP client while 512 offline
 * tests stay green — which is exactly what shipped in 2.2.0: a one-argument
 * `z.record()` (valid in Zod v3, invalid in v4) made `tools/list` answer
 * `-32603 Cannot read properties of undefined (reading '_zod')` and every
 * host — Claude Code, Codex, Cursor, Wayland — saw zero tools.
 *
 * These tests are the only ones that would have caught it.
 *
 * Run: node --test tests/mcp_stdio.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');
const COUNT_SCRIPT = join(__dirname, '..', 'scripts', 'count_tools.js');

const TIMEOUT_MS = 30_000;

/**
 * The environment an MCP host actually leaves a server with: nothing on POSIX,
 * and on Windows only the variables the OS itself needs — without USERPROFILE,
 * `os.homedir()` has nothing to resolve and the `~/.tv-mcp` directory the
 * connection module creates at import time lands somewhere unwritable.
 */
const BARE_ENV = process.platform === 'win32'
  ? Object.fromEntries(
    ['SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'TEMP', 'TMP']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  )
  : {};

/**
 * Drive one initialize -> initialized -> tools/list exchange and resolve with
 * the raw JSON-RPC response to `tools/list`.
 *
 * Spawned bare, from the temp directory, on purpose: MCP hosts launch servers
 * detached from the user's shell, so anything the server needs from PATH, the
 * working directory, or an inherited variable has to fail here rather than in
 * someone's editor.
 */
function toolsList({ env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: tmpdir(),
      env: { ...BARE_ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(`no tools/list response within ${TIMEOUT_MS}ms; stderr: ${stderr.slice(0, 500)}`));
    }, TIMEOUT_MS);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      err ? reject(err) : resolve(value);
    }

    function send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); }

    child.on('error', finish);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let cut;
      while ((cut = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, cut).trim();
        stdout = stdout.slice(cut + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // not framing we own
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          finish(null, msg);
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tvcontrol-tests', version: '1.0.0' },
      },
    });
  });
}

describe('MCP server over stdio', () => {
  it('answers tools/list without an error', async () => {
    const response = await toolsList();
    assert.equal(response.error, undefined, `tools/list failed: ${JSON.stringify(response.error)}`);
    assert.ok(Array.isArray(response.result?.tools), 'tools/list returned no tools array');
  });

  it('publishes the whole catalog minus the tools gated off by default', async () => {
    // The catalog is counted by regex over src/tools/; ui_evaluate is the one
    // tool that stays unregistered without TV_MCP_ADVANCED=1. Deriving the
    // expected number keeps this honest when tools are added or removed --
    // a hardcoded 101 would pass while half the catalog silently vanished.
    const { total } = JSON.parse(execFileSync(process.execPath, [COUNT_SCRIPT], { encoding: 'utf8' }));
    const response = await toolsList();
    assert.equal(response.result.tools.length, total - 1, 'published tool count does not match the catalog');

    const names = response.result.tools.map((t) => t.name);
    assert.ok(!names.includes('ui_evaluate'), 'ui_evaluate must stay gated behind TV_MCP_ADVANCED=1');
  });

  it('registers ui_evaluate only when TV_MCP_ADVANCED=1', async () => {
    // Negative control for the assertion above: without it, a server that
    // published nothing at all would satisfy "ui_evaluate is absent".
    const response = await toolsList({ env: { TV_MCP_ADVANCED: '1' } });
    const names = response.result.tools.map((t) => t.name);
    assert.ok(names.includes('ui_evaluate'), 'TV_MCP_ADVANCED=1 did not register ui_evaluate');
  });

  it('converts every tool schema to a usable JSON Schema', async () => {
    // The Zod-to-JSON-Schema conversion is the step that broke. A tool whose
    // schema degrades to `{}` or loses its properties is still counted above
    // but is unusable by a model, so check the shape rather than the count.
    const response = await toolsList();
    const broken = response.result.tools.filter(
      (t) => !t.inputSchema || t.inputSchema.type !== 'object' || typeof t.inputSchema.properties !== 'object'
    );
    assert.deepEqual(broken.map((t) => t.name), [], 'tools with an unusable inputSchema');
  });

  it('keeps the schema for strategy_sweep, the tool whose z.record broke 2.2.0', async () => {
    const response = await toolsList();
    const sweep = response.result.tools.find((t) => t.name === 'strategy_sweep');
    assert.ok(sweep, 'strategy_sweep missing from tools/list');

    const inputs = sweep.inputSchema.properties?.inputs;
    assert.ok(inputs, 'strategy_sweep lost its `inputs` property');
    // z.record(z.string(), z.array(...)) must survive as an object with typed
    // values. The one-arg form left the value type undefined, which is what
    // made the SDK throw on `_zod`.
    assert.equal(inputs.type, 'object', '`inputs` did not convert to an object schema');
    assert.equal(inputs.additionalProperties?.type, 'array', '`inputs` lost its value type');
  });
});
