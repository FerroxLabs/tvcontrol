import test from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../src/core/update.js';

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function depsFor({ dirty = '', upstream = 'origin/main', ahead = 0, behind = 2, remoteSha = NEW, lockChanged = false, platform = 'darwin' } = {}) {
  const state = { merged: false, npmCi: 0, commands: [] };
  return {
    state,
    deps: {
      repoRoot: '/fake/repo',
      platform,
      existsSync: () => true,
      execFileSync: (file, args) => {
        state.commands.push([file, ...args]);
        const command = args.join(' ');
        if (command === 'rev-parse --abbrev-ref HEAD') return 'main';
        if (command.includes('--symbolic-full-name')) {
          if (!upstream) throw new Error('no upstream');
          return upstream;
        }
        if (command === 'status --porcelain') return dirty;
        if (command === 'rev-parse HEAD') return state.merged ? remoteSha : OLD;
        if (command.startsWith('fetch --no-tags')) return '';
        if (command === `rev-parse ${upstream}`) return remoteSha;
        if (command.includes('..HEAD')) return String(ahead);
        if (command.startsWith('rev-list --count HEAD..')) return String(behind);
        if (command.startsWith('diff --name-only')) return lockChanged ? 'package-lock.json' : '';
        if (command.startsWith('merge --ff-only')) { state.merged = true; return ''; }
        if (file === 'npm' || file === 'npm.cmd') { state.npmCi += 1; return ''; }
        throw new Error(`Unexpected command: ${file} ${command}`);
      },
    },
  };
}

test('update refuses a branch without an explicit upstream', async () => {
  const { deps, state } = depsFor({ upstream: null });
  const result = await update({ _deps: deps });
  assert.equal(result.success, false);
  assert.match(result.error, /no readable upstream/i);
  assert.equal(state.commands.some((parts) => parts.includes('merge')), false);
});

test('update refuses a dirty tree before fetching or merging', async () => {
  const { deps, state } = depsFor({ dirty: ' M src/core/data.js\n?? notes.txt' });
  const result = await update({ _deps: deps });
  assert.equal(result.success, false);
  assert.deepEqual(result.changed_files, ['M src/core/data.js', '?? notes.txt']);
  assert.equal(state.commands.some((parts) => parts.includes('fetch')), false);
});

test('update refuses diverged history', async () => {
  const { deps, state } = depsFor({ ahead: 1 });
  const result = await update({ _deps: deps });
  assert.equal(result.success, false);
  assert.equal(result.ahead, 1);
  assert.equal(state.commands.some((parts) => parts.includes('merge')), false);
});

test('update fast-forwards and installs changed dependencies', async () => {
  const { deps, state } = depsFor({ lockChanged: true });
  const result = await update({ _deps: deps });
  assert.equal(result.success, true);
  assert.equal(result.updated, true);
  assert.equal(result.commits_pulled, 2);
  assert.equal(result.deps_installed, true);
  assert.equal(state.npmCi, 1);
});

test('update uses npm.cmd for dependency installation on Windows', async () => {
  const { deps, state } = depsFor({ lockChanged: true, platform: 'win32' });
  const result = await update({ _deps: deps });
  assert.equal(result.success, true);
  assert.equal(state.commands.some(([file]) => file === 'npm.cmd'), true);
});
