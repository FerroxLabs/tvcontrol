// chart_get_state used to return `chartType` while symbol_info returned the
// same value as `chart_type`, and chart_set_type takes `chart_type` as its
// argument. One value, three places, two spellings.
//
// This is not cosmetic. An agent reads chart_get_state, learns `chartType`,
// and then reads undefined everywhere else — which is precisely what happened
// twice while sweeping the tool surface on 2026-08-20, each time producing a
// false "this tool is broken" conclusion about a tool that worked fine.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const chart = readFileSync(new URL('../src/core/chart.js', import.meta.url), 'utf-8');
const tools = readFileSync(new URL('../src/tools/chart.js', import.meta.url), 'utf-8');

test('chart_get_state returns the canonical snake_case chart_type', () => {
  const state = chart.slice(chart.indexOf('export async function getState'), chart.indexOf('export async function setSymbol'));
  assert.ok(/chart_type: chart\.chartType\(\)/.test(state),
    'chart_get_state no longer returns chart_type, so it disagrees with symbol_info and chart_set_type');
});

test('the legacy chartType spelling is still emitted', () => {
  const state = chart.slice(chart.indexOf('export async function getState'), chart.indexOf('export async function setSymbol'));
  assert.ok(/chartType: chart\.chartType\(\)/.test(state),
    'dropping chartType silently breaks every existing caller; keep both');
});

test('chart_set_type still takes chart_type as its argument name', () => {
  assert.ok(/chart_type:/.test(tools),
    'the setter argument was renamed; it must match what the getter returns');
});
