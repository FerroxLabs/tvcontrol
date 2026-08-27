/**
 * TV_MCP_READONLY=1 must actually remove the mutating tools from the wire.
 *
 * These tests BOOT THE REAL SERVER as a subprocess and read tools/list. They do not use a
 * mock server, on purpose. 2.4.0 shipped two tools that were dead through MCP while 736
 * offline tests passed, because the registration mock recorded names and threw the handler
 * away. A mock cannot prove a gate either: the gate lives in src/server.js's server.tool
 * wrapper, which a mock server never runs. The only thing that settles it is what a client
 * sees after initialize.
 *
 * The suite therefore asserts on: the exact registered set under the flag, the set WITHOUT
 * the flag (so a vacuous pass is impossible), the flag beating TV_MCP_ADVANCED, an actual
 * tools/call of a blocked tool, and an actual tools/call of an allowed one (a registered tool
 * whose handler is broken would answer with a wiring TypeError instead of a CDP error).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READONLY_TOOLS, isReadonlyMode, isToolRegistered } from '../src/core/readonly.js';
import { discoverToolCatalog, getCapabilityMatrix, _resetCapabilityCacheForTests } from '../src/core/capabilities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');

// Booting costs ~1s, so each distinct environment is booted once and reused.
const _booted = new Map();

function boot(env = {}, calls = []) {
  const key = JSON.stringify([env, calls]);
  if (_booted.has(key)) return _booted.get(key);

  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ...calls.map((call, i) => ({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: call })),
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const childEnv = { ...process.env, TV_MCP_NO_CDP: '1' };
  delete childEnv.TV_MCP_READONLY;
  delete childEnv.TV_MCP_ADVANCED;
  Object.assign(childEnv, env);

  const out = execFileSync(process.execPath, [SERVER], {
    input: msgs, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'ignore'], env: childEnv,
  });
  const frames = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const value = {
    init: frames.find((f) => f.id === 1)?.result,
    names: (frames.find((f) => f.id === 2)?.result?.tools || []).map((t) => t.name).sort(),
    tools: frames.find((f) => f.id === 2)?.result?.tools || [],
    calls: calls.map((_, i) => frames.find((f) => f.id === 10 + i)),
  };
  _booted.set(key, value);
  return value;
}

// Named one by one rather than derived, so this list is a claim a reviewer can check rather
// than a restatement of the code under test. Every one of these reaches the operator's real
// account, real chart, real files or the local install.
const MUST_NEVER_REGISTER = [
  'alert_create', 'alert_create_bulk', 'alert_delete', 'alert_delete_by_id',
  'chart_manage_indicator', 'chart_set_type',
  'draw_shape', 'draw_clear', 'draw_remove_one',
  'indicator_add_from_search', 'indicator_set_inputs', 'indicator_toggle_visibility',
  'pane_set_layout',
  'pine_new', 'pine_open', 'pine_save', 'pine_set_source', 'pine_compile', 'pine_smart_compile', 'pine_check',
  'replay_start', 'replay_step', 'replay_autoplay', 'replay_stop', 'replay_trade',
  'state_restore', 'state_delete',
  'strategy_sweep',
  'tab_new', 'tab_close',
  'tv_launch', 'tv_repair_chart', 'tv_update', 'tv_support_bundle', 'tv_compatibility_snapshot',
  'tv_watchdog_start', 'tv_watchdog_stop',
  'ui_click', 'ui_evaluate', 'ui_fullscreen', 'ui_hover', 'ui_keyboard',
  'ui_mouse_click', 'ui_open_panel', 'ui_scroll', 'ui_type_text',
  'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove', 'watchlist_remove_bulk',
  'watchlist_import', 'watchlist_export',
];

describe('read-only allowlist integrity', () => {
  it('every allowlisted name exists in the live tool catalog', () => {
    const catalog = new Set(discoverToolCatalog());
    const ghosts = READONLY_TOOLS.filter((name) => !catalog.has(name));
    assert.deepEqual(ghosts, [], `allowlist names no real tool: ${ghosts.join(', ')}`);
  });

  it('lists each tool once', () => {
    assert.equal(READONLY_TOOLS.length, new Set(READONLY_TOOLS).size);
  });

  it('accounts for every tool in the catalog', () => {
    const catalog = discoverToolCatalog();
    const allowed = new Set(READONLY_TOOLS);
    const denied = catalog.filter((name) => !allowed.has(name));
    // Every catalog tool is either allowed or on the named deny list. A new tool lands here
    // as an unclassified name, which is the point: it has to be looked at.
    const unclassified = denied.filter((name) => !MUST_NEVER_REGISTER.includes(name));
    assert.deepEqual(unclassified, [],
      `these catalog tools are neither allowlisted nor named as mutating: ${unclassified.join(', ')}`);
    assert.equal(allowed.size + denied.length, catalog.length);
  });

  it('contains no tool that writes to the account, the chart or the install', () => {
    const leaked = MUST_NEVER_REGISTER.filter((name) => READONLY_TOOLS.includes(name));
    assert.deepEqual(leaked, [], `mutating tool(s) in the read-only allowlist: ${leaked.join(', ')}`);
  });

  it('isToolRegistered lets read-only beat TV_MCP_ADVANCED', () => {
    assert.equal(isToolRegistered('ui_evaluate', { TV_MCP_ADVANCED: '1' }), true);
    assert.equal(isToolRegistered('ui_evaluate', { TV_MCP_READONLY: '1', TV_MCP_ADVANCED: '1' }), false);
    assert.equal(isToolRegistered('watchlist_remove_bulk', {}), true);
    assert.equal(isToolRegistered('watchlist_remove_bulk', { TV_MCP_READONLY: '1' }), false);
    assert.equal(isToolRegistered('chart_get_state', { TV_MCP_READONLY: '1' }), true);
  });

  it('treats only the literal "1" as read-only', () => {
    assert.equal(isReadonlyMode({}), false);
    assert.equal(isReadonlyMode({ TV_MCP_READONLY: '0' }), false);
    assert.equal(isReadonlyMode({ TV_MCP_READONLY: 'true' }), false);
    assert.equal(isReadonlyMode({ TV_MCP_READONLY: '1' }), true);
  });

  it('denies an unknown future tool by default', () => {
    // The gate is an allowlist, so a tool nobody has classified yet is off, not on.
    assert.equal(isToolRegistered('some_tool_added_next_week', { TV_MCP_READONLY: '1' }), false);
    assert.equal(isToolRegistered('some_tool_added_next_week', {}), true);
  });
});

describe('the read-only server registers only the allowlist', () => {
  it('tools/list returns exactly the read-only allowlist', () => {
    const { names } = boot({ TV_MCP_READONLY: '1' });
    assert.deepEqual(names, [...READONLY_TOOLS].sort());
  });

  it('the same build registers the mutating tools when the flag is absent', () => {
    // Without this the test above could pass because the tools were deleted, not gated.
    const { names } = boot({});
    for (const name of ['watchlist_remove_bulk', 'alert_delete', 'draw_clear', 'pine_save', 'tv_launch', 'state_delete']) {
      assert.ok(names.includes(name), `${name} should be registered when TV_MCP_READONLY is unset`);
    }
    assert.equal(names.length, discoverToolCatalog().length - 1, 'only ui_evaluate is gated by default');
  });

  it('keeps ui_evaluate off even when TV_MCP_ADVANCED=1 is also set', () => {
    const { names } = boot({ TV_MCP_READONLY: '1', TV_MCP_ADVANCED: '1' });
    assert.ok(!names.includes('ui_evaluate'), 'arbitrary page JS must not be reachable in a read-only session');
    assert.deepEqual(names, [...READONLY_TOOLS].sort());
  });

  it('introduces itself with the count it actually registered', () => {
    const { init, names } = boot({ TV_MCP_READONLY: '1' });
    const headline = Number(/tvcontrol — (\d+) tools/.exec(init.instructions)?.[1]);
    assert.equal(headline, names.length, `instructions say ${headline} tools, tools/list returns ${names.length}`);
    assert.match(init.instructions, /READ-ONLY MODE IS ACTIVE/);
  });

  it('refuses a blocked tool at the protocol layer, not by asking nicely', () => {
    const { calls } = boot({ TV_MCP_READONLY: '1' }, [
      { name: 'watchlist_remove_bulk', arguments: { symbols: ['NASDAQ:AAPL'] } },
    ]);
    const text = JSON.stringify(calls[0]);
    assert.match(text, /not found/, `expected an unknown-tool refusal, got: ${text.slice(0, 300)}`);
    assert.ok(!/"success":\s*true/.test(text), 'a blocked tool must never report success');
  });

  it('an allowed tool still EXECUTES its handler', () => {
    // The 2.4.0 failure was a registered tool whose handler was dead. Registration proves
    // nothing; the result does. With TV_MCP_NO_CDP set, a correctly wired handler reaches the
    // connection layer and returns a classified CDP error. A miswired one answers with a
    // TypeError from its own body.
    const { calls } = boot({ TV_MCP_READONLY: '1' }, [{ name: 'chart_get_state', arguments: {} }]);
    const text = JSON.stringify(calls[0]);
    assert.match(text, /cdp_disconnected|TV_MCP_NO_CDP/, `chart_get_state did not reach the connection layer: ${text.slice(0, 300)}`);
    assert.ok(!/is not a function|Cannot read properties of undefined|is not defined/.test(text),
      `chart_get_state handler is miswired: ${text.slice(0, 300)}`);
    assert.ok(!/not found/.test(text), 'chart_get_state must be callable in read-only mode');
  });
});

describe('batch_run cannot become a mutation bypass', () => {
  it('publishes a read-only action enum on the wire', () => {
    // batch_run drives the chart across a symbol grid and runs `action` at each stop. If a
    // mutating action is ever added to that enum, registering batch_run under read-only would
    // hand back everything this gate removed. Pinning the enum as the SERVER PUBLISHES IT
    // means such an action fails here rather than shipping.
    const { tools } = boot({ TV_MCP_READONLY: '1' });
    const batch = tools.find((t) => t.name === 'batch_run');
    assert.ok(batch, 'batch_run must stay available — a universe scan cannot work without it');
    const actions = batch.inputSchema?.properties?.action?.enum;
    assert.deepEqual([...actions].sort(),
      ['get_ohlcv', 'get_pine_tables', 'get_strategy_results', 'get_study_values', 'screenshot'],
      'batch_run gained or lost an action — reclassify it before touching this list');
  });

  it('restores the starting symbol and timeframe by default', () => {
    // The other half of why navigation is acceptable: the scan puts the chart back.
    const { tools } = boot({ TV_MCP_READONLY: '1' });
    const batch = tools.find((t) => t.name === 'batch_run');
    assert.match(batch.inputSchema.properties.restore_start_state.description, /default true/i);
  });
});

describe('the capability matrix reports the read-only session honestly', () => {
  const withEnv = async (env, fn) => {
    const previous = process.env.TV_MCP_READONLY;
    try {
      if (env === null) delete process.env.TV_MCP_READONLY;
      else process.env.TV_MCP_READONLY = env;
      _resetCapabilityCacheForTests();
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.TV_MCP_READONLY;
      else process.env.TV_MCP_READONLY = previous;
      _resetCapabilityCacheForTests();
    }
  };

  it('marks mutating tools disabled under the flag and available without it', async () => {
    const catalog = () => ['chart_get_state', 'watchlist_remove_bulk'];

    const off = await withEnv(null, () => getCapabilityMatrix({ probe: false, _deps: { catalog } }));
    assert.equal(off.readonly_mode, false);
    assert.equal(off.registered, 2);

    const on = await withEnv('1', () => getCapabilityMatrix({ probe: false, _deps: { catalog } }));
    assert.equal(on.readonly_mode, true);
    assert.equal(on.registered, 1);
    assert.equal(on.tools.find((t) => t.tool === 'watchlist_remove_bulk').status, 'disabled');
    assert.equal(on.tools.find((t) => t.tool === 'chart_get_state').registered, true);
  });
});
