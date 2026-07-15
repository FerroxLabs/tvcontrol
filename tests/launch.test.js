import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch } from '../src/core/health.js';

const MSIX_DIR = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0_x64__vendor';
const MSIX_EXE = `${MSIX_DIR}\\TradingView.exe`;

function child() {
  const value = new EventEmitter();
  value.pid = 1234;
  value.unref = () => {};
  return value;
}

function windowsDeps({ directCdp = false } = {}) {
  const state = { spawned: [], copied: [], killed: 0, localStarted: false };
  return {
    state,
    deps: {
      platform: 'win32',
      localAppData: 'C:\\Users\\Test\\AppData\\Local',
      programFiles: 'C:\\Program Files',
      programFilesX86: 'C:\\Program Files (x86)',
      existsSync: (path) => path === MSIX_EXE || state.copied.some((entry) => path.startsWith(entry.destination)),
      execFileSync: (file, args) => {
        if (file === 'powershell') return MSIX_DIR;
        if (file === 'taskkill') { state.killed += 1; return ''; }
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
      },
      spawn: (path) => {
        state.spawned.push(path);
        if (path.includes('tvcontrol')) state.localStarted = true;
        return child();
      },
      spawnFailedEarly: async () => null,
      delay: async () => {},
      probeCdp: async () => ((directCdp || state.localStarted) ? { Browser: 'Chrome/140', 'User-Agent': 'TVDesktop/3.1' } : null),
      mkdirSync: () => {},
      readdirSync: () => ['TradingView.Desktop_3.0.0_x64__vendor'],
      rmSync: () => {},
      cpSync: (source, destination) => { state.copied.push({ source, destination }); },
    },
  };
}

test('Windows MSIX launch uses the installed package when CDP binds', async () => {
  const { deps, state } = windowsDeps({ directCdp: true });
  const result = await launch({ _deps: deps });
  assert.equal(result.success, true);
  assert.equal(result.binary, MSIX_EXE);
  assert.equal(result.msix_local_copy, undefined);
  assert.equal(state.copied.length, 0);
  assert.equal(state.killed, 0, 'launch must not kill an existing session by default');
  assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
});

test('launch only kills an existing session when explicitly requested', async () => {
  const { deps, state } = windowsDeps({ directCdp: true });
  const result = await launch({ kill_existing: true, _deps: deps });
  assert.equal(result.success, true);
  assert.equal(state.killed, 1);
});

test('Windows MSIX launch copies locally when the packaged app cannot bind CDP', async () => {
  const { deps, state } = windowsDeps();
  const result = await launch({ _deps: deps });
  assert.equal(result.success, true);
  assert.equal(result.msix_local_copy, true);
  assert.equal(state.spawned.length, 2);
  assert.equal(state.copied.length, 1);
  assert.equal(state.copied[0].source, MSIX_DIR);
  assert.match(result.binary, /tvcontrol\\desktop-cache/);
  assert.ok(state.killed >= 1, 'fallback must stop the package before launching the local copy');
});
