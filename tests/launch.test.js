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

// ---------------------------------------------------------------------------
// AN ALREADY-OPEN TRADINGVIEW IS THE COMMON CASE, NOT A BROKEN INSTALL.
// Measured on a real buyer run: TradingView was open the ordinary way, the OS
// refused a second copy, `tv_launch` threw a bare "exited immediately with code
// 0", and the agent - having no remedy named anywhere in the error - told a
// non-technical user to relaunch from a terminal. The remedy is a parameter on
// this same tool, so the error has to name it.
// ---------------------------------------------------------------------------

const TV_MAC = '/Applications/TradingView.app/Contents/MacOS/TradingView';

function macDeps({ running, killed = { n: 0 } } = {}) {
  return {
    platform: 'darwin',
    home: '/Users/test',
    existsSync: (p) => p === TV_MAC,
    execFileSync: (file) => {
      if (file === 'pgrep') {
        if (!running) { const e = new Error('no match'); e.status = 1; throw e; }
        return '4321\n';
      }
      if (file === 'pkill') { killed.n += 1; return ''; }
      throw new Error(`Unexpected command: ${file}`);
    },
    spawn: () => child(),
    spawnFailedEarly: async () => 'exited immediately with code 0',
    delay: async () => {},
    probeCdp: async () => null,
  };
}

test('an already-running TradingView is reported as such, and names kill_existing', async () => {
  await assert.rejects(
    () => launch({ _deps: macDeps({ running: true }) }),
    (err) => {
      assert.match(err.message, /already running without the control port/i);
      assert.match(err.message, /refused a second copy/i);
      assert.match(err.hint, /kill_existing: true/);
      assert.match(err.hint, /unsaved/i, 'the hint must warn that a restart discards unsaved work');
      return true;
    },
  );
});

test('a genuine startup failure is NOT relabelled as an already-running instance', async () => {
  await assert.rejects(
    () => launch({ _deps: macDeps({ running: false }) }),
    (err) => {
      assert.match(err.message, /failed during startup/i);
      assert.doesNotMatch(err.message, /already running/i);
      assert.doesNotMatch(err.hint ?? '', /kill_existing/);
      return true;
    },
  );
});
