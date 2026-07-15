import { existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './receipts.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'watchdog_daemon.js');
const LABEL = 'com.ferroxlabs.tvcontrol-watchdog';
const WINDOWS_TASK = 'TVControl Watchdog';

function _xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replaceAll("'", '&apos;');
}

function _systemdArg(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function _validateInterval(intervalMs) {
  const parsed = Number(intervalMs);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'watchdog service interval_ms must be an integer from 1000 to 300000');
  }
  return parsed;
}

export function watchdogServicePlan({ platform = process.platform, interval_ms = 15_000, home = homedir(), node_path = process.execPath, daemon_path = DAEMON_PATH, uid = process.getuid?.() } = {}) {
  const intervalMs = _validateInterval(interval_ms);
  if (platform === 'darwin') {
    const definitionPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${_xml(node_path)}</string><string>${_xml(daemon_path)}</string><string>--interval-ms</string><string>${intervalMs}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${_xml(join(home, '.tv-mcp', 'watchdog-service.log'))}</string>
  <key>StandardErrorPath</key><string>${_xml(join(home, '.tv-mcp', 'watchdog-service.err.log'))}</string>
</dict></plist>
`;
    return {
      platform, manager: 'launchd', label: LABEL, definition_path: definitionPath, content,
      install_command: ['launchctl', 'bootstrap', `gui/${uid}`, definitionPath],
      uninstall_command: ['launchctl', 'bootout', `gui/${uid}`, definitionPath],
      status_command: ['launchctl', 'print', `gui/${uid}/${LABEL}`],
    };
  }
  if (platform === 'linux') {
    const definitionPath = join(home, '.config', 'systemd', 'user', 'tvcontrol-watchdog.service');
    const content = `[Unit]
Description=TVControl TradingView health watchdog
After=graphical-session.target

[Service]
Type=simple
ExecStart=${_systemdArg(node_path)} ${_systemdArg(daemon_path)} --interval-ms ${intervalMs}
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
    return {
      platform, manager: 'systemd-user', label: 'tvcontrol-watchdog.service', definition_path: definitionPath, content,
      install_commands: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', 'tvcontrol-watchdog.service'],
      ],
      uninstall_command: ['systemctl', '--user', 'disable', '--now', 'tvcontrol-watchdog.service'],
      post_uninstall_command: ['systemctl', '--user', 'daemon-reload'],
      status_command: ['systemctl', '--user', 'is-active', 'tvcontrol-watchdog.service'],
    };
  }
  if (platform === 'win32') {
    const definitionPath = join(home, '.tv-mcp', 'tvcontrol-watchdog-task.xml');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>${_xml(node_path)}</Command><Arguments>${_xml(`"${daemon_path}" --interval-ms ${intervalMs}`)}</Arguments></Exec></Actions>
</Task>
`;
    return {
      platform, manager: 'task-scheduler', label: WINDOWS_TASK, definition_path: definitionPath, content,
      install_command: ['schtasks.exe', '/Create', '/TN', WINDOWS_TASK, '/XML', definitionPath, '/F'],
      uninstall_command: ['schtasks.exe', '/Delete', '/TN', WINDOWS_TASK, '/F'],
      status_command: ['schtasks.exe', '/Query', '/TN', WINDOWS_TASK],
    };
  }
  throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unsupported watchdog service platform: ${platform}`);
}

function _run(command, deps) {
  const [file, ...args] = command;
  return String(deps.execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim().slice(0, 2000);
}

export function manageWatchdogService({ action = 'plan', apply = false, interval_ms = 15_000, _deps } = {}) {
  if (!['plan', 'install', 'uninstall', 'status'].includes(action)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unknown watchdog service action: ${action}`);
  }
  const deps = {
    platform: _deps?.platform || process.platform,
    home: _deps?.home || homedir(),
    nodePath: _deps?.nodePath || process.execPath,
    daemonPath: _deps?.daemonPath || DAEMON_PATH,
    uid: _deps?.uid ?? process.getuid?.(),
    existsSync: _deps?.existsSync || existsSync,
    unlinkSync: _deps?.unlinkSync || unlinkSync,
    execFileSync: _deps?.execFileSync || execFileSync,
    atomicWrite: _deps?.atomicWrite || atomicWrite,
  };
  const plan = watchdogServicePlan({ platform: deps.platform, interval_ms, home: deps.home, node_path: deps.nodePath, daemon_path: deps.daemonPath, uid: deps.uid });
  const safePlan = { ...plan };
  delete safePlan.content;
  if (action === 'plan') return { success: true, dry_run: true, ...safePlan };
  if (action === 'status') {
    let managerState = 'unknown';
    try { managerState = _run(plan.status_command, deps) || 'active'; } catch (_) { managerState = 'inactive_or_unavailable'; }
    return { success: true, definition_exists: deps.existsSync(plan.definition_path), manager_state: managerState, ...safePlan };
  }
  if (!apply) {
    return { success: true, dry_run: true, action, safety: `No OS service state changed. Re-run watchdog ${action} with --apply.`, ...safePlan };
  }
  try {
    if (action === 'install') {
      deps.atomicWrite(plan.definition_path, plan.content);
      for (const command of plan.install_commands || [plan.install_command]) _run(command, deps);
      return { success: true, installed: true, ...safePlan };
    }
    try { _run(plan.uninstall_command, deps); } catch (_) { /* definition is still removed */ }
    if (deps.existsSync(plan.definition_path)) deps.unlinkSync(plan.definition_path);
    if (plan.post_uninstall_command) {
      try { _run(plan.post_uninstall_command, deps); } catch (_) { /* already removed */ }
    }
    return { success: true, uninstalled: true, ...safePlan };
  } catch (err) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `Watchdog service ${action} failed`, {
      cause: err,
      hint: `Review the generated ${plan.manager} definition and run tv watchdog service-status before retrying.`,
    });
  }
}
