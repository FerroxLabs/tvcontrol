/**
 * The published `tvcontrol` bin IS the MCP server, and it is executable.
 *
 * npm/bun resolve `npx <pkg>` to the bin whose NAME matches the package name, so for
 * `@ferroxlabs/tvcontrol` that key is `tvcontrol`. Wayland Core spawns exactly that tuple
 * (`bun x --bun @ferroxlabs/tvcontrol@<ver>`) and speaks JSON-RPC to its stdout.
 *
 * TWO things have to hold and only ONE of them is a package.json string:
 *   1. bin.tvcontrol points at src/server.js (not the human `tv` CLI, which prints a usage
 *      block to STDOUT and exits 0 — straight onto Core's JSON-RPC channel).
 *   2. src/server.js starts with a shebang. The installed shim at node_modules/.bin/tvcontrol
 *      is a symlink to the target FILE; without `#!/usr/bin/env node` the shell runs it and
 *      it dies with `import: command not found`, exit 2.
 *
 * So this test spawns the INSTALLED SHIM, never `node <path>` — spawning through node
 * bypasses the shebang and stays green on a build whose real spawn produces nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

/** Complete a real MCP stdio handshake against `cmd argv`. Resolves a report, never throws. */
// Under `shell: true` the direct child is cmd.exe, so killing it orphans the
// real node process, which keeps a handle on the temp dir and makes the
// teardown rmdir fail with EBUSY. Kill the whole tree on Windows.
function killTree(child) {
  if (!child.pid) return;
  if (IS_WIN) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function probe(cmd, argv, cwd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    let nonJson = '';
    const result = { ok: false, toolCount: -1, nonJson: '', stderr: '', exit: null };
    const timer = setTimeout(() => {
      result.reason = 'PROBE_ERROR timeout initialize';
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish();
    }, 30000);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      result.nonJson = nonJson.trim();
      result.stderr = err.trim().split('\n').slice(0, 4).join('\n');
      killTree(child);
      resolve(result);
    }
    child.on('error', (e) => { result.reason = `PROBE_ERROR spawn ${e.message}`; finish(); });
    child.on('exit', (code) => { result.exit = code; setTimeout(finish, 50); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { nonJson += line + '\n'; continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          result.toolCount = msg.result?.tools?.length ?? -1;
          result.ok = result.toolCount > 0;
          finish();
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bin-entrypoint-probe', version: '0' } },
    }) + '\n');
  });
}

test('bin.tvcontrol names the MCP server, not the human CLI', () => {
  assert.equal(pkg.bin.tvcontrol, 'src/server.js',
    `bin.tvcontrol is ${JSON.stringify(pkg.bin.tvcontrol)}; npx resolves the package-name bin and Core needs the MCP server`);
});

test('the bin target carries a shebang so the installed shim is executable', () => {
  // A Windows checkout (core.autocrlf) rewrites LF to CRLF, so line 1 arrives as
  // "#!/usr/bin/env node\r". Strip ONLY a trailing CR: a genuinely missing or wrong
  // shebang still fails, which is the whole point of this test.
  const firstLine = fs.readFileSync(path.join(REPO, pkg.bin.tvcontrol), 'utf8').split('\n')[0].replace(/\r$/, '');
  assert.equal(firstLine, '#!/usr/bin/env node',
    `bin target ${pkg.bin.tvcontrol} line 1 is ${JSON.stringify(firstLine)}; without a shebang the shim is run by the shell and dies with "import: command not found"`);
});

// Two separate Windows traps. execFileSync does no PATHEXT resolution, so bare
// 'npm' is ENOENT; and since the CVE-2024-27980 mitigation (Node 18.20.2 /
// 20.12.2) child_process REFUSES to spawn a .cmd at all without `shell: true`,
// which surfaces as EINVAL. Both are avoided by going through the shell on
// Windows only. Under `shell: true` the args are re-parsed by cmd.exe, so any
// argument containing a space must be quoted here.
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const npmArgs = (args) => (IS_WIN ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args);
const npmOpts = (opts) => (IS_WIN ? { ...opts, shell: true } : opts);

test('the INSTALLED bin shim completes a real MCP handshake', { timeout: 300000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbin-'));
  // Windows releases file handles lazily even after the tree is dead, so the
  // first rmdir can still hit EBUSY. maxRetries is Node's documented remedy.
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  // Production path: pack the working tree exactly as `npm publish` would, then install it.
  const tarName = execFileSync(NPM, npmArgs(['pack', '--pack-destination', tmp]), npmOpts({ cwd: REPO, encoding: 'utf8' })).trim().split('\n').pop();
  const tarball = path.join(tmp, tarName);
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'probe-host', private: true, version: '0.0.0' }));
  execFileSync(NPM, npmArgs(['install', '--omit=dev', '--no-audit', '--no-fund', '--cache', path.join(tmp, '.npmcache'), tarball]),
    npmOpts({ cwd: tmp, encoding: 'utf8', stdio: 'pipe' }));

  const installed = path.join(tmp, 'node_modules', '@ferroxlabs', 'tvcontrol');
  // npm writes THREE shims on Windows: an extensionless sh script (for Cygwin),
  // plus tvcontrol.cmd and tvcontrol.ps1. Windows cannot execute the
  // extensionless one -- spawn returns ENOENT -- and .cmd needs a shell. The
  // .cmd IS the real resolution target there, so that is what this must exercise.
  const shimBase = path.join(tmp, 'node_modules', '.bin', 'tvcontrol');
  const shim = IS_WIN ? `${shimBase}.cmd` : shimBase;
  assert.ok(fs.existsSync(shim), `install produced no ${path.basename(shim)} shim`);

  // KNOWN-POSITIVE CONTROL, same install, same moment: the server file itself must handshake.
  // If this is not green the probe is broken and the shim's RED means nothing.
  const control = await probe(process.execPath, [path.join(installed, 'src', 'server.js')], tmp);
  console.log(`[CTL] node src/server.js -> ok=${control.ok} TOOL_COUNT ${control.toolCount} ${control.reason ?? ''}`);
  assert.ok(control.ok, `known-positive control failed: ${control.reason ?? ''} ${control.nonJson} ${control.stderr}`);

  // The real spawn path — what `npx` / `bun x --bun` resolve to.
  const real = await probe(shim, [], tmp, IS_WIN ? { shell: true } : {});
  console.log(`[BIN] ./node_modules/.bin/tvcontrol -> ok=${real.ok} TOOL_COUNT ${real.toolCount} exit=${real.exit} ${real.reason ?? ''}`);
  if (real.nonJson) console.log(`[BIN] NONJSON_STDOUT: ${real.nonJson.split('\n')[0]}`);
  if (real.stderr) console.log(`[BIN] STDERR: ${real.stderr}`);
  assert.ok(real.ok, `installed shim did not handshake: ${real.reason ?? ''} exit=${real.exit} nonJson=${real.nonJson.split('\n')[0] ?? ''} stderr=${real.stderr}`);
  assert.equal(real.toolCount, control.toolCount, 'shim and server file disagree on tool count');
});
