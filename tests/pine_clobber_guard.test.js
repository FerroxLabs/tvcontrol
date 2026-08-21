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

import { isExpendableBuffer } from '../src/core/pine.js';

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

describe('the guard actually runs', () => {
  // IT REFUSED FOR THE WRONG REASON. The first version of the in-page probe
  // contained a bare backslash-n inside a JS TEMPLATE LITERAL. At runtime the
  // template literal turns that into a REAL newline before the string reaches
  // evaluate(), producing an unterminated JS string. Every call died with
  // "SyntaxError: Invalid or unexpected token".
  //
  // The operator's script survived, so a live smoke test looked green: the tool
  // was "safe" only because it was broken, and it was equally broken on an
  // EMPTY editor where it should have proceeded. A guard that cannot run is not
  // a guard.
  //
  // THE FIRST VERSION OF THIS TEST COULD NOT FAIL. Reading the file as text
  // yields the two characters backslash and n, which parse fine. The corruption
  // only exists AFTER template-literal processing. So the escapes have to be
  // resolved the way the runtime resolves them before anything is parsed.
  const probeSource = () => {
    const start = core.indexOf('async function _assertBufferSafeToReplace');
    assert.ok(start !== -1, 'the guard was renamed or removed');
    const body = core.slice(start, core.indexOf('\n}', start));
    const m = body.match(/const buf = await evaluate\(`([\s\S]*?)`\);/);
    assert.ok(m, 'the buffer probe expression could not be located');
    return m[1];
  };

  // Apply the escape processing a template literal performs at runtime.
  const asRuntimeString = (raw) => raw
    .replace(/\$\{FIND_MONACO\}/g, 'null')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`');

  it('the evaluated source still parses AFTER template-literal escaping', () => {
    const expr = asRuntimeString(probeSource());
    assert.doesNotThrow(() => new Function(`return ${expr}`),
      'the string that actually reaches evaluate() does not parse, so every call dies with a SyntaxError instead of guarding');
  });

  it('no string literal in the probe spans a line break once escaped', () => {
    // The specific shape of the original bug: '\n' inside a single-quoted
    // string became a real newline and broke the literal open.
    const expr = asRuntimeString(probeSource());
    for (const line of expr.split('\n')) {
      const singles = (line.match(/'/g) || []).length;
      assert.equal(singles % 2, 0,
        `unbalanced quote after escaping, so a string literal spans a line break: ${line.trim().slice(0, 70)}`);
    }
  });
});

/**
 * THE DECISION ITSELF, not the shape of the source around it.
 *
 * Everything above reads src/core/pine.js as text, because the guard's read
 * goes over CDP and could not be reached from a unit test. That is how the
 * threshold below survived: it was documented and never exercised.
 */
describe('what counts as an expendable buffer', () => {
  const buf = (text) => ({
    chars: text.length,
    head: text.slice(0, 160),
    meaningful: text.split('\n').filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//');
    }).length,
  });

  it('an empty buffer is expendable', () => {
    const v = isExpendableBuffer(buf(''));
    assert.equal(v.expendable, true);
    assert.equal(v.reason, 'empty');
  });

  it('a buffer of nothing but comments and blank lines is expendable', () => {
    const v = isExpendableBuffer(buf('// scratch\n\n   \n// notes\n'));
    assert.equal(v.expendable, true);
  });

  it('our own untouched indicator template is expendable', () => {
    const v = isExpendableBuffer(buf('//@version=6\nindicator("My script")\nplot(close)'));
    assert.equal(v.expendable, true);
    assert.match(v.reason, /untouched indicator template/);
  });

  it('our own untouched strategy template is expendable', () => {
    const v = isExpendableBuffer(buf('//@version=6\nstrategy("My strategy", overlay=true)\n'));
    assert.equal(v.expendable, true);
    assert.match(v.reason, /untouched strategy template/);
  });

  it('A REAL THREE-LINE SCRIPT IS NOT EXPENDABLE', () => {
    // Both external auditors produced this counterexample independently. It is
    // a working script: three meaningful lines, 41 characters, and the old
    // `meaningful <= 3 && chars < 200` rule silently overwrote it.
    const script = '//@version=6\nindicator("X")\nplot(close)';
    assert.ok(script.length < 200, 'the example really is under the old size threshold');
    // 2, not 3: the //@version line is a comment. Either way it is under the
    // old `meaningful <= 3` threshold, which is the point.
    assert.equal(buf(script).meaningful, 2, 'and under the old line threshold');
    const v = isExpendableBuffer(buf(script));
    assert.equal(v.expendable, false, 'someone\'s script is not expendable because it is short');
  });

  it('a template someone has started editing is not expendable', () => {
    const v = isExpendableBuffer(buf('//@version=6\nindicator("My script")\nplot(close)\nplot(ta.sma(close, 20))'));
    assert.equal(v.expendable, false);
  });

  it('an unreadable buffer is not expendable', () => {
    assert.equal(isExpendableBuffer(null).expendable, false);
    assert.equal(isExpendableBuffer({}).expendable, false);
    assert.equal(isExpendableBuffer(undefined).expendable, false);
  });
});
