// Regression tests for the watchlist module, which was rebuilt on TradingView's
// REST API after the DOM implementation was found broken in shipped 2.2.3.
//
// WHAT WAS WRONG. Every watchlist operation was DOM automation: click the add
// button, right-click a row and hunt for "Remove" in a context menu. Measured
// against a live account on 2026-08-20:
//
//   watchlist_remove       reported a click; the symbol stayed in the list
//   watchlist_remove_bulk  removed_count 0, error_count 1
//   watchlist_get          reported TSLA/NVDA/AMD absent while the account
//                          held all three, because the DOM only contains
//                          RENDERED rows
//
// That last one is the dangerous one: a read that silently under-reports
// membership is worse than one that fails, because callers act on it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/core/watchlist.js', import.meta.url), 'utf-8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('membership comes from the API, not from rendered DOM rows', () => {
  assert.ok(/symbols_list\//.test(code), 'the symbols_list API endpoint is gone');
  assert.ok(/_apiActive/.test(code), '_apiActive is gone; get() is back to reading the DOM for membership');
  const getFn = code.slice(code.indexOf('export async function get('), code.indexOf('export async function add('));
  assert.ok(/_apiActive/.test(getFn),
    'get() no longer sources membership from the API, so it will under-report symbols on a scrolled list');
});

test('mutations post a JSON array, which is what the API requires', () => {
  // A query string or an object returns 422:
  // {"non_field_errors":["Expected a list of items but got type \"dict\"."]}
  assert.ok(/append/.test(code) && /remove/.test(code), 'the append/remove endpoints are gone');
  assert.ok(/JSON\.stringify\(\$\{JSON\.stringify\(symbols\)\}\)/.test(code) || /body: JSON\.stringify/.test(code),
    'mutation body is no longer JSON-serialised');
});

test('every mutation is verified from a fresh read', () => {
  for (const fn of ['addBulk', 'removeBulk']) {
    const start = code.indexOf(`export async function ${fn}(`);
    assert.ok(start !== -1, `${fn} is missing`);
    const body = code.slice(start, code.indexOf('\n}\n', start));
    assert.ok(/_apiActive\(evaluateAsync\)[\s\S]*_apiMutate[\s\S]*_apiActive\(evaluateAsync\)/.test(body),
      `${fn} no longer re-reads state after mutating; the API's own response is the action reporting on itself`);
    assert.ok(/verified/.test(body), `${fn} no longer returns a verified flag`);
  }
});

test('section headers are excluded from symbol counts', () => {
  // "###CORE BASKET" and friends are real entries in the stored list but are
  // not tradable symbols. Counting them inflates every count the tool reports.
  assert.ok(/_isHeader/.test(code), '_isHeader is gone; section headers will be counted as symbols');
  assert.ok(/filter\(\(x\) => !_isHeader\(x\)\)/.test(code), 'counts no longer exclude section headers');
});

test('no DOM context-menu removal remains', () => {
  const rm = code.slice(code.indexOf('export async function removeBulk('));
  assert.ok(!/contextmenu/.test(rm),
    'removeBulk is back on the right-click context menu, which is the path that silently failed');
});
