/**
 * Shared dependency-injection helpers for src/core/* modules.
 *
 * Background: every core module had its own `_resolve(deps)` helper doing
 * `deps?.x || _x` lookups. Cosmetic duplication, but more importantly a
 * debugging trap: a typo'd key like `_deps:{ stSymbol: ... }` was
 * silently swapped for the production CDP function, sending real CDP calls
 * from inside what the test author thought was a unit test.
 *
 * This module exposes one helper:
 *   strictResolve(deps, knownKeys)
 *
 * Call it at the top of your file's `_resolve()` to fail loud on unknown keys.
 * The known list is the SINGLE SOURCE OF TRUTH for what the file accepts —
 * keep it in sync with the per-key fallbacks below it.
 */

/**
 * Universal CDP-infrastructure keys that the shared test helpers
 * (tests/_helpers.js scriptedDeps + emptyDeps) always inject. These pass
 * through every _resolve without warning even if a particular module does
 * not actually use them — they're "ambient" injections.
 */
export const CDP_INFRA_KEYS = new Set([
  'evaluate', 'evaluateAsync', 'waitForChartReady',
  'getChartApi', 'getReplayApi', 'getChartCollection', 'getClient',
]);

/**
 * @param {object|null|undefined} deps - injected deps from caller (often _deps)
 * @param {Set<string>} knownKeys - the per-file surface this _resolve accepts.
 *   Universal CDP infrastructure keys are accepted automatically.
 * @throws {TypeError} when deps contains a key not in knownKeys ∪ CDP_INFRA_KEYS
 */
export function strictResolve(deps, knownKeys) {
  if (deps == null) return;
  const unknown = Object.keys(deps).filter(k => !knownKeys.has(k) && !CDP_INFRA_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new TypeError(
    `Unknown _deps key(s): ${unknown.join(', ')}. ` +
    `Known: ${[...knownKeys].sort().join(', ')}. ` +
    `(If this is a typo, the test was unintentionally hitting the real CDP.)`
  );
}
