import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ClassifiedError, CATEGORIES } from '../errors.js';

function _canonicalPotentialPath(path) {
  let cursor = path;
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const canonicalBase = existsSync(cursor) ? realpathSync(cursor) : resolve(cursor);
  return resolve(canonicalBase, ...missing);
}

export function resolveReceiptPath({ kind, filename, outputDir, home = homedir() }) {
  const root = resolve(home, '.tv-mcp');
  const directory = resolve(outputDir || join(root, kind));
  const canonicalRoot = _canonicalPotentialPath(root);
  const canonicalDirectory = _canonicalPotentialPath(directory);
  const fromRoot = relative(canonicalRoot, canonicalDirectory);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `output_dir must stay within ${root}`,
    );
  }
  return join(canonicalDirectory, filename);
}

export function atomicWrite(path, data, { _deps } = {}) {
  const deps = {
    mkdirSync: _deps?.mkdirSync || mkdirSync,
    renameSync: _deps?.renameSync || renameSync,
    writeFileSync: _deps?.writeFileSync || writeFileSync,
    random: _deps?.random || Math.random,
  };
  deps.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${deps.random().toString(36).slice(2, 8)}.tmp`;
  deps.writeFileSync(tmp, data, { mode: 0o600 });
  deps.renameSync(tmp, path);
  return path;
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}
