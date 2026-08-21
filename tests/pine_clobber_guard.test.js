/**
 * pine_new and pine_set_source must not silently destroy an open script.
 *
 * THE CHAIN THAT KILLED A REAL STRATEGY:
 *   pine_new     -> m.editor.setValue(template) over whatever script is open,
 *                   then returned { success: true, action: 'new_script_created' }
 *   pine_compile -> clicks "Save and add to chart" FIRST, persisting that
 *                   overwrite to the cloud
 * Two success responses, and a saved script is gone. The tool description said
 * "Create a new blank Pine Script"; it created nothing.
 *
 * The project memory only ever warned about pine_open. pine_new had the same
 * hole behind a friendlier name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/pine.js', import.meta.url), 'utf-8');
const tools = readFileSync(new URL('../src/tools/pine.js', import.meta.url), 'utf-8');

// Strip line comments. The guard's own doc comment names the old behaviour it
// replaced, and a naive scan matches the documentation instead of the code —
// the same trap that made an earlier regression test pass against a live bug.
const body = (name) => {
  const start = core.indexOf(`export async function ${name}(`);
  assert.ok(start !== -1, `${name} was renamed or removed`);
  const next = core.indexOf('\nexport ', start + 10);
  const raw = core.slice(start, next === -1 ? undefined : next);
  return raw.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
};

describe('pine buffer-clobber guard', () => {
  it('newScript checks the buffer before writing over it', () => {
    assert.match(body('newScript'), /_assertBufferSafeToReplace\(/,
      'pine_new can overwrite an open saved script again');
  });

  it('setSource checks the buffer before writing over it', () => {
    assert.match(body('setSource'), /_assertBufferSafeToReplace\(/,
      'pine_set_source can overwrite an open saved script again');
  });

  it('the guard refuses rather than assuming an unreadable buffer is empty', () => {
    const g = core.slice(core.indexOf('async function _assertBufferSafeToReplace'));
    assert.match(g.slice(0, 2000), /if \(!buf \|\| !buf\.ok\)[\s\S]{0,220}throw/,
      'an unreadable buffer must fail closed, not be treated as empty');
  });

  it('only an explicit confirm_overwrite gets through the guard', () => {
    const g = core.slice(core.indexOf('async function _assertBufferSafeToReplace'));
    assert.match(g.slice(0, 600), /confirm_overwrite === true/,
      'the bypass must require the literal true, not any truthy value');
  });

  it('newScript no longer claims to have created a script', () => {
    const b = body('newScript');
    assert.ok(!/new_script_created/.test(b),
      'it reports creating a script it did not create; that is the lie that made it dangerous');
    assert.match(b, /editor_buffer_replaced_with_template/);
  });

  it('both tools expose confirm_overwrite so the refusal is actionable', () => {
    for (const t of ['pine_new', 'pine_set_source']) {
      const i = tools.indexOf(`server.tool('${t}'`);
      assert.ok(i !== -1, `${t} is gone`);
      const block = tools.slice(i, i + 1200);
      assert.match(block, /confirm_overwrite/, `${t} gives the caller no way to proceed deliberately`);
    }
  });

  it('the tools that SAVE say so in their description', () => {
    // pine_compile clicks "Save and add to chart" before compiling. A caller
    // reading "compile" does not expect a cloud write.
    for (const t of ['pine_compile', 'pine_smart_compile']) {
      const i = tools.indexOf(`server.tool('${t}'`);
      const desc = tools.slice(i, tools.indexOf('\n', i));
      assert.match(desc, /SAVE/i, `${t} does not warn that it persists the buffer`);
    }
    const i = tools.indexOf("server.tool('pine_new'");
    assert.match(tools.slice(i, tools.indexOf('\n', i)), /does NOT create/i,
      'pine_new still advertises itself as creating a script');
  });
});
