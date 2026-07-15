import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manageWatchdogService, watchdogServicePlan } from '../src/core/watchdog_service.js';

describe('watchdog native service', () => {
  it('generates launchd, systemd user, and Task Scheduler definitions with absolute paths', () => {
    const common = { home: '/Users/test & user', node_path: '/opt/node & runtime', daemon_path: '/repo/watchdog daemon.js', interval_ms: 15000, uid: 501 };
    const mac = watchdogServicePlan({ ...common, platform: 'darwin' });
    const linux = watchdogServicePlan({ ...common, platform: 'linux' });
    const windows = watchdogServicePlan({ ...common, platform: 'win32' });
    assert.match(mac.content, /&amp;/);
    assert.match(mac.definition_path, /LaunchAgents/);
    assert.match(linux.content, /systemd|ExecStart/);
    assert.match(windows.content, /Task version/);
    assert.doesNotMatch(windows.content, /node & runtime/);
  });

  it('is dry-run by default for install and uninstall', () => {
    let touched = false;
    const deps = {
      platform: 'linux', home: '/tmp/test', nodePath: '/node', daemonPath: '/daemon',
      atomicWrite: () => { touched = true; }, execFileSync: () => { touched = true; }, existsSync: () => false,
    };
    assert.equal(manageWatchdogService({ action: 'install', _deps: deps }).dry_run, true);
    assert.equal(manageWatchdogService({ action: 'uninstall', _deps: deps }).dry_run, true);
    assert.equal(touched, false);
  });

  it('writes then activates a systemd user service only with apply', () => {
    const calls = [];
    const result = manageWatchdogService({
      action: 'install', apply: true,
      _deps: {
        platform: 'linux', home: '/tmp/test', nodePath: '/node', daemonPath: '/daemon',
        atomicWrite: (path) => calls.push(['write', path]),
        execFileSync: (file, args) => { calls.push([file, ...args]); return 'ok'; },
        existsSync: () => false,
      },
    });
    assert.equal(result.installed, true);
    assert.equal(calls[0][0], 'write');
    assert.deepEqual(calls[1].slice(0, 3), ['systemctl', '--user', 'daemon-reload']);
    assert.deepEqual(calls[2].slice(0, 4), ['systemctl', '--user', 'enable', '--now']);
  });

  it('removes a definition even if the manager says it is already absent', () => {
    let removed = false;
    const result = manageWatchdogService({
      action: 'uninstall', apply: true,
      _deps: {
        platform: 'darwin', home: '/tmp/test', nodePath: '/node', daemonPath: '/daemon', uid: 501,
        execFileSync: () => { throw new Error('not loaded'); },
        existsSync: () => true,
        unlinkSync: () => { removed = true; },
      },
    });
    assert.equal(result.uninstalled, true);
    assert.equal(removed, true);
  });
});
