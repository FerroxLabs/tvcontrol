/**
 * Unit tests for pine_analyze static analysis logic.
 * No TradingView connection needed.
 *
 * Run: node --test tests/pine_analyze.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers (mirror of src/core/pine.js) ──

function stripCommentsAndStrings(line) {
  let result = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '/' && line[i + 1] === '/') break;
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') { if (line[i] === '\\') i++; i++; }
      i++;
      result += ' ';
      continue;
    }
    if (line[i] === "'") {
      i++;
      while (i < line.length && line[i] !== "'") { if (line[i] === '\\') i++; i++; }
      i++;
      result += ' ';
      continue;
    }
    result += line[i];
    i++;
  }
  return result;
}

function extractBalancedCall(lines, startLine, startCol) {
  let text = '';
  let depth = 0;
  let started = false;
  for (let li = startLine; li < lines.length; li++) {
    const seg = li === startLine ? lines[li].slice(startCol) : lines[li];
    for (const ch of seg) {
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') { depth--; }
      text += ch;
      if (started && depth === 0) return { text, endLine: li };
    }
    text += '\n';
  }
  return { text, endLine: lines.length - 1 };
}

function nameUsedElsewhere(lines, name, declLineNum) {
  const re = new RegExp('\\b' + name + '\\b');
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 === declLineNum) continue;
    if (re.test(stripCommentsAndStrings(lines[i]))) return true;
  }
  return false;
}

// Extracted analyze function matching the tool's logic
function analyze(source) {
  const lines = source.split('\n');
  const diagnostics = [];
  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  // Array OOB
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  // Unguarded first/last on empty arrays
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array`,
          severity: 'warning',
        });
      }
    }
  }

  // strategy.entry without strategy()
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1,
          message: 'strategy.entry/close used but no strategy() declaration found',
          severity: 'error',
        });
        break;
      }
    }
  }

  // Check 5: Version hint (v4 or v5 detected — suggest v6)
  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 6) {
      const vNum = parseInt(vMatch[1]);
      let vLine = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('//@version=')) { vLine = i + 1; break; }
      }
      diagnostics.push({
        line: vLine,
        message: `Pine v${vNum} detected — v6 is current. Consider migration with the porting-pine-versions skill.`,
        severity: 'info',
      });
    }
  }

  // Check 1: security() / request.security() without explicit lookahead
  {
    const secPattern = /\b(request\.security|security)\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripCommentsAndStrings(lines[i]);
      let m;
      secPattern.lastIndex = 0;
      while ((m = secPattern.exec(stripped)) !== null) {
        const { text } = extractBalancedCall(lines, i, m.index);
        const cleanCall = text.split('\n').map(stripCommentsAndStrings).join('\n');
        if (!cleanCall.includes('lookahead')) {
          diagnostics.push({
            line: i + 1,
            message: 'request.security() without explicit lookahead (default may repaint — pass lookahead=barmerge.lookahead_off for confirmed data)',
            severity: 'warning',
          });
        }
      }
    }
  }

  // Check 2: Unused input declarations
  {
    const inputDecls = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripCommentsAndStrings(lines[i]);
      const m = stripped.match(/^(\w+)\s*=\s*input\b/);
      if (m) inputDecls.push({ name: m[1], lineNum: i + 1 });
    }
    for (const decl of inputDecls) {
      if (!nameUsedElsewhere(lines, decl.name, decl.lineNum)) {
        diagnostics.push({
          line: decl.lineNum,
          message: `Input "${decl.name}" declared on line ${decl.lineNum} but never used`,
          severity: 'info',
        });
      }
    }
  }

  // Check 3: plot(close) in a strategy script
  {
    const hasStrategy = lines.some(l => /\bstrategy\s*\(/.test(stripCommentsAndStrings(l)));
    if (hasStrategy) {
      for (let i = 0; i < lines.length; i++) {
        const stripped = stripCommentsAndStrings(lines[i]);
        if (/\bplot\s*\(\s*close\s*[,)]/.test(stripped)) {
          diagnostics.push({
            line: i + 1,
            message: 'plot(close) in strategy — consider strategy.entry/exit visuals or plotshape() for signal markers',
            severity: 'info',
          });
          break;
        }
      }
    }
  }

  // Check 4: Explicit lookahead=barmerge.lookahead_on
  {
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripCommentsAndStrings(lines[i]);
      if (/lookahead\s*=\s*barmerge\.lookahead_on/.test(stripped)) {
        diagnostics.push({
          line: i + 1,
          message: 'lookahead=barmerge.lookahead_on causes future data to be used — only valid for specific use cases, otherwise repaints',
          severity: 'warning',
        });
      }
    }
  }

  return diagnostics;
}

// ════════════════════════════════════════════════════════
// Existing tests
// ════════════════════════════════════════════════════════

describe('pine_analyze — static analysis', () => {
  it('clean v6 script — no issues', () => {
    const diags = analyze(`//@version=6
indicator("Test", overlay=true)
a = array.from(1, 2, 3)
val = array.get(a, 1)
plot(close)`);
    assert.equal(diags.length, 0);
  });

  it('array.get out of bounds', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2, 3)
val = array.get(a, 5)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('out of bounds'));
    assert.ok(diags[0].message.includes('index 5'));
    assert.ok(diags[0].message.includes('size is 3'));
  });

  it('array.get negative index', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2)
val = array.get(a, -1)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
  });

  it('array.set out of bounds', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(3)
array.set(a, 10, 99.0)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('array.set'));
  });

  it('array.get valid index — no issue', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(10, 20, 30, 40, 50)
val = array.get(a, 4)`);
    assert.equal(diags.length, 0);
  });

  it('.first() on empty array', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.first()`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'warning');
    assert.ok(diags[0].message.includes('empty array'));
  });

  it('.last() on empty array', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.last()`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'warning');
  });

  it('.first() on non-empty array — no issue', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2, 3)
x = a.first()`);
    assert.equal(diags.length, 0);
  });

  it('strategy.entry without strategy() declaration', () => {
    const diags = analyze(`//@version=6
indicator("Test")
strategy.entry("Long", strategy.long)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('no strategy() declaration'));
  });

  it('strategy.entry WITH strategy() — no issue', () => {
    const diags = analyze(`//@version=6
strategy("Test", overlay=true)
if close > open
    strategy.entry("Long", strategy.long)`);
    assert.equal(diags.length, 0);
  });

  it('old version v3 warning', () => {
    const diags = analyze(`//@version=3
study("Test")
plot(close)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'info');
    assert.ok(diags[0].message.includes('v3'));
    // Updated message format from new check 5
    assert.ok(diags[0].message.includes('v6 is current'));
  });

  it('v5 — version warning (now flagged as pre-v6)', () => {
    const diags = analyze(`//@version=5
indicator("Test")
plot(close)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'info');
    assert.ok(diags[0].message.includes('Pine v5'));
  });

  it('multiple issues at once', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2)
b = array.new_float(0)
x = array.get(a, 5)
y = b.first()
strategy.entry("Long", strategy.long)`);
    assert.ok(diags.length >= 3, `Expected >= 3 issues, got ${diags.length}`);
    const errors = diags.filter(d => d.severity === 'error');
    const warnings = diags.filter(d => d.severity === 'warning');
    assert.ok(errors.length >= 2, 'Should have OOB error + strategy error');
    assert.ok(warnings.length >= 1, 'Should have empty array warning');
  });
});

describe('pine_check — server compile', () => {
  it('should compile valid Pine Script via TradingView API', async () => {
    const source = `//@version=6
indicator("API Test", overlay=true)
plot(close, "Close", color=color.blue)`;

    const formData = new URLSearchParams();
    formData.append('source', source);

    const response = await fetch(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
      }
    );

    assert.ok(response.ok, `API returned ${response.status}`);
    const result = await response.json();
    assert.ok(result.result || result.error === undefined, 'Should compile successfully');
  });

  it('should return errors for invalid Pine Script', async () => {
    const source = `//@version=6
indicator("Bad")
this_function_does_not_exist()`;

    const formData = new URLSearchParams();
    formData.append('source', source);

    const response = await fetch(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
      }
    );

    assert.ok(response.ok, `API returned ${response.status}`);
    const result = await response.json();
    // API returns { success: true, result: { errors2: [...] } } for compile errors
    const errors = result?.result?.errors2 || [];
    assert.ok(errors.length > 0, `Should have compilation errors, got: ${JSON.stringify(result).slice(0, 200)}`);
    // Error message may be interpolated or templated (e.g., "Could not find {kind} '{fullName}'")
    const msg = errors[0].message || '';
    const ctx = errors[0].ctx || {};
    const mentionsBadFn = msg.includes('this_function_does_not_exist') || ctx.fullName === 'this_function_does_not_exist';
    assert.ok(mentionsBadFn, 'Error should mention the bad function via message or ctx.fullName');
  });

  it('should handle empty source gracefully', async () => {
    const formData = new URLSearchParams();
    formData.append('source', '');

    const response = await fetch(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
      }
    );

    // Empty source returns 400 — that's correct behavior
    assert.ok(response.status === 400 || response.status === 200, `Unexpected status: ${response.status}`);
  });
});

// ════════════════════════════════════════════════════════
// New checks
// ════════════════════════════════════════════════════════

describe('Check 1: security lookahead repaint', () => {
  it('flags request.security without lookahead arg (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.ok(d, 'should flag missing lookahead');
    assert.equal(d.severity, 'warning');
    assert.equal(d.line, 3);
  });

  it('flags security() short form without lookahead (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = security("AAPL", "D", close)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.ok(d, 'should flag short-form security()');
    assert.equal(d.severity, 'warning');
  });

  it('flags request.security with partial args but no lookahead (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close, gaps=barmerge.gaps_off)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.ok(d, 'should flag missing lookahead even with other named args');
    assert.equal(d.severity, 'warning');
  });

  it('flags multi-line request.security call (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security(
    "AAPL",
    "D",
    close)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.ok(d, 'should flag multi-line security call');
    assert.equal(d.severity, 'warning');
  });

  it('does NOT flag request.security with lookahead=barmerge.lookahead_off (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_off)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.equal(d, undefined, 'should not flag when lookahead_off is explicit');
  });

  it('does NOT flag request.security with lookahead=barmerge.lookahead_on (negative — flagged by check 4 instead)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_on)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.equal(d, undefined, 'lookahead_on is explicit — check 1 should not fire');
  });

  it('does NOT flag a line where security appears only in a comment (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
// request.security("AAPL", "D", close)
plot(close)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.equal(d, undefined, 'comment-only line must not be flagged');
  });

  it('does NOT flag request.security inside a string literal (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
label.new(bar_index, close, "request.security(sym, tf, src)")`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.equal(d, undefined, 'string literal must not be flagged');
  });

  it('edge: request.security with lookahead kwarg anywhere in multi-line call', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D",
    close,
    lookahead=barmerge.lookahead_off)`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.equal(d, undefined, 'lookahead in continuation line must clear the warning');
  });

  it('edge: request.security on very long line with many args', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("EXCHANGE:TICKER", "240", ta.ema(close, 20), gaps=barmerge.gaps_off, ignore_invalid_symbol=true, currency="USD")`);
    const d = diags.find(x => x.message.includes('without explicit lookahead'));
    assert.ok(d, 'long line without lookahead should still be flagged');
    assert.equal(d.severity, 'warning');
  });
});

describe('Check 2: Unused input declarations', () => {
  it('flags unused input declaration (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
myLen = input.int(14, "Length")
plot(close)`);
    const d = diags.find(x => x.message.includes('never used'));
    assert.ok(d, 'should flag unused input');
    assert.equal(d.severity, 'info');
    assert.ok(d.message.includes('"myLen"'));
  });

  it('flags unused input.bool declaration (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
showLabels = input.bool(true, "Show labels")
plot(close)`);
    const d = diags.find(x => x.message.includes('never used'));
    assert.ok(d, 'should flag unused bool input');
    assert.equal(d.severity, 'info');
  });

  it('reports correct line number for unused input (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
src = input.source(close, "Source")
plot(close)`);
    const d = diags.find(x => x.message.includes('"src"'));
    assert.ok(d);
    assert.equal(d.line, 3);
  });

  it('flags multiple unused inputs independently (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
lenA = input.int(14)
lenB = input.int(21)
plot(close)`);
    const unused = diags.filter(x => x.message.includes('never used'));
    assert.equal(unused.length, 2);
  });

  it('does NOT flag input used later (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
myLen = input.int(14, "Length")
plot(ta.sma(close, myLen))`);
    const d = diags.find(x => x.message.includes('never used'));
    assert.equal(d, undefined, 'used input should not be flagged');
  });

  it('does NOT flag input used in condition (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
thresh = input.float(50.0, "Threshold")
if close > thresh
    label.new(bar_index, close, "above")`);
    const d = diags.find(x => x.message.includes('never used'));
    assert.equal(d, undefined);
  });

  it('does NOT flag input whose name appears in a comment on another line (negative)', () => {
    // The name appears in the source on the declaration line only;
    // the comment reference should NOT count as usage.
    const diags = analyze(`//@version=6
indicator("Test")
unusedVar = input.int(10)
// unusedVar is documented here
plot(close)`);
    const d = diags.find(x => x.message.includes('"unusedVar"'));
    assert.ok(d, 'comment reference must not count as usage');
  });

  it('does NOT flag input used in a function argument (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
period = input.int(20, "Period")
ema = ta.ema(close, period)
plot(ema)`);
    const d = diags.find(x => x.message.includes('never used'));
    assert.equal(d, undefined);
  });

  it('edge: input name that is a prefix of another identifier (no false flag)', () => {
    // "len" should not match "lenMA"
    const diags = analyze(`//@version=6
indicator("Test")
len = input.int(14)
lenMA = ta.sma(close, 14)
plot(lenMA)`);
    const d = diags.find(x => x.message.includes('"len"'));
    assert.ok(d, 'len used only as prefix of lenMA — should still be flagged as unused');
  });

  it('edge: no inputs at all — no unused-input diagnostics', () => {
    const diags = analyze(`//@version=6
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('never used'));
    assert.equal(d, undefined);
  });
});

describe('Check 3: plot(close) in strategy script', () => {
  it('flags plot(close) when strategy() is present (positive)', () => {
    const diags = analyze(`//@version=6
strategy("My strat", overlay=true)
plot(close)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.ok(d, 'should flag plot(close) in strategy');
    assert.equal(d.severity, 'info');
  });

  it('flags plot(close) anywhere in the script (positive)', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
if bar_index > 10
    strategy.entry("L", strategy.long)
plot(close, color=color.red)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.ok(d);
  });

  it('flags with correct line number (positive)', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
plot(close)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.ok(d);
    assert.equal(d.line, 3);
  });

  it('emits at most one diagnostic even with multiple plot(close) (positive)', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
plot(close)
plot(close, color=color.blue)`);
    const matches = diags.filter(x => x.message.includes('plot(close) in strategy'));
    assert.equal(matches.length, 1);
  });

  it('does NOT flag plot(close) in an indicator script (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.equal(d, undefined);
  });

  it('does NOT flag strategy script with no plot(close) (negative)', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
if bar_index > 10
    strategy.entry("L", strategy.long)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.equal(d, undefined);
  });

  it('does NOT flag plot(open) — only plot(close) is targeted (negative)', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
plot(open)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.equal(d, undefined);
  });

  it('does NOT flag plot(close) in a comment inside a strategy (negative)', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
// plot(close)
strategy.entry("L", strategy.long)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.equal(d, undefined);
  });

  it('edge: strategy declaration with extra args still triggers check', () => {
    const diags = analyze(`//@version=6
strategy("My Strategy", overlay=true, initial_capital=10000, commission_type=strategy.commission.percent)
plot(close)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.ok(d);
  });

  it('edge: plot(close * 1.01) does not match plot(close) pattern', () => {
    const diags = analyze(`//@version=6
strategy("S", overlay=true)
plot(close * 1.01)`);
    const d = diags.find(x => x.message.includes('plot(close) in strategy'));
    assert.equal(d, undefined, 'expression argument is not bare close');
  });
});

describe('Check 4: Explicit lookahead=barmerge.lookahead_on', () => {
  it('flags lookahead_on in request.security call (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_on)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.ok(d, 'should flag lookahead_on');
    assert.equal(d.severity, 'warning');
  });

  it('flags lookahead_on with spaces around = (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close, lookahead = barmerge.lookahead_on)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.ok(d);
  });

  it('flags lookahead_on on its own line (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D",
    close,
    lookahead=barmerge.lookahead_on)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.ok(d);
    assert.equal(d.line, 5);
  });

  it('reports correct line number (positive)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
x = request.security("SYM", "W", close, lookahead=barmerge.lookahead_on)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.ok(d);
    assert.equal(d.line, 3);
  });

  it('does NOT flag lookahead=barmerge.lookahead_off (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
d = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_off)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.equal(d, undefined);
  });

  it('does NOT flag a line with only lookahead_off (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
// lookahead=barmerge.lookahead_on is documented here but not used
d = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_off)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.equal(d, undefined, 'comment should not be flagged');
  });

  it('does NOT flag lookahead_on inside a string literal (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
label.new(bar_index, close, "lookahead=barmerge.lookahead_on")`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.equal(d, undefined);
  });

  it('does NOT flag script with no lookahead at all (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.equal(d, undefined);
  });

  it('edge: multiple lookahead_on calls each get their own diagnostic', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_on)
b = request.security("GOOG", "W", close, lookahead=barmerge.lookahead_on)`);
    const matches = diags.filter(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.equal(matches.length, 2);
  });

  it('edge: lookahead_on mixed with lookahead_off — only on-line flagged', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_off)
b = request.security("GOOG", "W", close, lookahead=barmerge.lookahead_on)`);
    const matches = diags.filter(x => x.message.includes('lookahead=barmerge.lookahead_on causes future data'));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].line, 4);
  });
});

describe('Check 5: Version hint (v4/v5 detected)', () => {
  it('flags //@version=5 with v6 migration hint (positive)', () => {
    const diags = analyze(`//@version=5
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('Pine v5 detected'));
    assert.ok(d, 'should flag v5');
    assert.equal(d.severity, 'info');
  });

  it('flags //@version=4 with v6 migration hint (positive)', () => {
    const diags = analyze(`//@version=4
study("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('Pine v4 detected'));
    assert.ok(d, 'should flag v4');
    assert.equal(d.severity, 'info');
  });

  it('flags //@version=3 with v6 migration hint (positive)', () => {
    const diags = analyze(`//@version=3
study("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('Pine v3 detected'));
    assert.ok(d, 'should flag v3');
  });

  it('message contains porting-pine-versions skill reference (positive)', () => {
    const diags = analyze(`//@version=5
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('porting-pine-versions'));
    assert.ok(d, 'message should reference migration skill');
  });

  it('does NOT flag //@version=6 (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('detected — v6 is current'));
    assert.equal(d, undefined, 'v6 must not be flagged');
  });

  it('does NOT flag a script with no version annotation (negative)', () => {
    const diags = analyze(`indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('detected — v6 is current'));
    assert.equal(d, undefined);
  });

  it('does NOT flag //@version=6 even if other issues present (negative)', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.first()`);
    const d = diags.find(x => x.message.includes('detected — v6 is current'));
    assert.equal(d, undefined);
  });

  it('does NOT double-flag if both //@version=5 and //@version=6 somehow appear (negative)', () => {
    // First match wins; isV6 will be false, version=5 fires once
    const diags = analyze(`//@version=5
//@version=6
indicator("Test")
plot(close)`);
    const matches = diags.filter(x => x.message.includes('detected — v6 is current'));
    assert.ok(matches.length <= 1, 'at most one version diagnostic');
  });

  it('edge: version annotation on line 1 has correct line number', () => {
    const diags = analyze(`//@version=5
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('Pine v5 detected'));
    assert.ok(d);
    assert.equal(d.line, 1);
  });

  it('edge: version annotation preceded by blank lines still detected', () => {
    const diags = analyze(`
//@version=5
indicator("Test")
plot(close)`);
    const d = diags.find(x => x.message.includes('Pine v5 detected'));
    assert.ok(d, 'should detect v5 even when preceded by blank line');
    assert.equal(d.line, 2);
  });
});
