// pine_list_scripts returned the operator's ENTIRE script library on every
// call. Measured on a real account: 53,933 bytes, roughly 13,500 tokens, for
// 276 scripts — on a tool an agent calls just to find one script by name.
//
// A tool that blows the context budget is worse than a missing one, because the
// agent calls it anyway and pays the cost before discovering it cannot use the
// result. After: 10,140 bytes for the default page, less with a filter.
//
// The truncation must be LOUD. A silently short list reads as "that is all of
// them", which is how an agent concludes a script has been deleted.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/core/pine.js', import.meta.url), 'utf-8');
const tool = readFileSync(new URL('../src/tools/pine.js', import.meta.url), 'utf-8');
const fn = core.slice(core.indexOf('export async function listScripts'), core.indexOf('\n}\n', core.indexOf('export async function listScripts')));

test('listScripts accepts a filter and paging arguments', () => {
  assert.ok(/name_filter/.test(fn), 'name_filter is gone; finding one script means fetching all 276 again');
  assert.ok(/limit/.test(fn) && /offset/.test(fn), 'paging arguments are gone');
});

test('the tool exposes those arguments to callers', () => {
  const decl = tool.slice(tool.indexOf("'pine_list_scripts'"), tool.indexOf("'pine_analyze'"));
  for (const arg of ['name_filter', 'limit', 'offset']) {
    assert.ok(new RegExp(arg).test(decl), `${arg} is not in the tool schema, so no caller can use it`);
  }
});

test('a truncated result says so, and says how to get the rest', () => {
  assert.ok(/truncated/.test(fn), 'the truncated flag is gone; a short list will read as a complete one');
  assert.ok(/next_offset/.test(fn), 'next_offset is gone; the caller cannot page without guessing');
  assert.ok(/total/.test(fn) && /matched/.test(fn),
    'total/matched are gone; the caller cannot tell how much was withheld');
});

test('the page size is bounded', () => {
  assert.ok(/Math\.min\(Math\.max\(1, Number\(limit\)/.test(fn),
    'limit is no longer clamped, so a caller can ask for the whole library again');
});
