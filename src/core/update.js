/**
 * Safe self-update for git checkouts. Only a clean branch with an explicit
 * upstream may fast-forward; npm/package installs and development branches
 * are reported without being mutated.
 */
import { execFileSync as _execFileSync } from 'node:child_process';
import { existsSync as _existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function _resolve(deps) {
  return {
    execFileSync: deps?.execFileSync || _execFileSync,
    existsSync: deps?.existsSync || _existsSync,
    repoRoot: deps?.repoRoot || REPO_ROOT,
    platform: deps?.platform || process.platform,
  };
}

export async function update({ _deps } = {}) {
  const { execFileSync, existsSync, repoRoot, platform } = _resolve(_deps);
  const run = (file, args, timeout = 15000) => execFileSync(file, args, {
    cwd: repoRoot,
    timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const git = (args, timeout) => run('git', args, timeout);

  if (!existsSync(join(repoRoot, '.git'))) {
    return {
      success: false,
      error: 'This installation is not a git checkout. Update it with the same package manager or installer you originally used.',
    };
  }

  let branch;
  let upstream;
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  } catch (error) {
    return {
      success: false,
      branch,
      error: `The current branch has no readable upstream, so automatic update was skipped: ${error.message}`,
    };
  }

  const [remote, ...remoteBranchParts] = upstream.split('/');
  const remoteBranch = remoteBranchParts.join('/');
  if (!remote || !remoteBranch) {
    return { success: false, branch, error: `Could not parse upstream branch "${upstream}".` };
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    return {
      success: false,
      branch,
      upstream,
      error: 'Working tree has local changes; automatic update was skipped.',
      changed_files: dirty.split('\n').slice(0, 20),
    };
  }

  const before = git(['rev-parse', 'HEAD']);
  try {
    git(['fetch', '--no-tags', remote, remoteBranch], 30000);
  } catch (error) {
    return { success: false, branch, upstream, error: `git fetch failed: ${error.message}` };
  }

  const remoteRef = `${remote}/${remoteBranch}`;
  const remoteSha = git(['rev-parse', remoteRef]);
  if (before === remoteSha) {
    return { success: true, updated: false, status: 'up_to_date', branch, upstream, commit: before.slice(0, 8) };
  }

  const ahead = Number(git(['rev-list', '--count', `${remoteRef}..HEAD`]));
  const behind = Number(git(['rev-list', '--count', `HEAD..${remoteRef}`]));
  if (ahead > 0 || behind < 1) {
    return {
      success: false,
      branch,
      upstream,
      ahead,
      behind,
      error: 'Local and upstream history cannot be safely fast-forwarded; inspect the branch manually.',
    };
  }

  const lockChanged = git(['diff', '--name-only', 'HEAD', remoteRef, '--', 'package-lock.json']) !== '';
  git(['merge', '--ff-only', remoteRef], 30000);
  const after = git(['rev-parse', 'HEAD']);

  let depsInstalled = false;
  let warning;
  if (lockChanged) {
    try {
      run(platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], 300000);
      depsInstalled = true;
    } catch (error) {
      warning = `Code updated, but npm ci failed. Run it manually in ${repoRoot}: ${error.message}`;
    }
  }

  return {
    success: true,
    updated: true,
    branch,
    upstream,
    from_commit: before.slice(0, 8),
    to_commit: after.slice(0, 8),
    commits_pulled: behind,
    deps_installed: depsInstalled,
    ...(warning ? { warning } : {}),
    restart_required: true,
  };
}
