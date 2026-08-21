/**
 * pine_save read the editor's Save/Saved button honestly and then returned
 * success:true regardless of what it read. `saved: false` sat right beside it.
 *
 * That is the same split fixed in alert_delete_by_id: an honest field next to a
 * dishonest headline, on a codebase where every caller branches on success.
 * Telling someone their Pine script is saved when it is not is the one
 * direction that costs work.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/pine.js', import.meta.url), 'utf-8');
const tools = readFileSync(new URL('../src/tools/pine.js', import.meta.url), 'utf-8');

const saveBody = (() => {
  const start = core.indexOf('export async function save()');
  assert.ok(start !== -1, 'save() was renamed or removed');
  const next = core.indexOf('\nexport ', start + 10);
  const raw = core.slice(start, next === -1 ? undefined : next);
  return raw.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*');
  }).join('\n');
})();

describe('pine_save honesty', () => {
  it('does not hardcode success', () => {
    assert.ok(!/success:\s*true\s*,\s*\n\s*action:/.test(saveBody),
      'success is hardcoded again, so an unsaved script reports as saved');
    assert.match(saveBody, /success: saved === true/,
      'success must be the read-back, not an assumption');
  });

  it('THROWS when the editor still reports unsaved changes', () => {
    // Retrying a save is harmless, unlike retrying a create, so a definite
    // "still unsaved" is an error rather than a qualified success.
    assert.match(saveBody, /if \(saved === false\)[\s\S]{0,300}throw/,
      'a confirmed-unsaved script must not return at all');
  });

  it('reports an unlocatable save button as unverified, never as success', () => {
    assert.match(saveBody, /verified: saved === true \? true : null/,
      'null means "could not look", which is not the same as saved');
    assert.match(saveBody, /UNVERIFIED/);
  });

  it('the tool description says it persists to the cloud', () => {
    const i = tools.indexOf("server.tool('pine_save'");
    const desc = tools.slice(i, tools.indexOf('\n', i));
    assert.match(desc, /overwrites|persists/i,
      'a caller reading "Save the current Pine Script" does not expect a cloud write to a named saved script');
  });
});
