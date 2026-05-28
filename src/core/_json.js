/**
 * JSON.parse with a prototype-pollution guard.
 *
 * The disk files we read (state snapshots, sweep cache/partials, watchlist
 * exports) are normally ours, but a tampered or hand-edited file could carry
 * "__proto__" / "constructor" / "prototype" keys. Node's bare JSON.parse does
 * not pollute Object.prototype today, but the moment a parsed object is spread
 * ({ ...parsed }) or its keys are copied onto another object, those keys can
 * walk the prototype chain. The reviver strips them so the risk can never
 * materialize regardless of how the parsed value is later used.
 */
export function parseJsonSafe(text) {
  return JSON.parse(text, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return value;
  });
}
