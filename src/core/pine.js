/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

// CDP keyboard modifier bitmask: 2=Ctrl, 8=Meta(Cmd). TradingView's Pine editor
// uses the platform-primary modifier for Save (Cmd/Ctrl+S) and Add-to-chart /
// Compile (Cmd/Ctrl+Enter). Hardcoding Ctrl was a silent no-op on macOS
// whenever the DOM-click fallback also missed.
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 8 : 2;

// Escape a string for safe use inside `new RegExp(...)`.
// Pine identifiers today are \w+ (no metachars), but defense-in-depth keeps
// this safe if the declaration pattern ever broadens (Unicode, dotted names).
function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Monaco finder (injected into TV page) ──
//
// TWO BUGS LIVED HERE AND BOTH WERE SILENT. Found 2026-08-20 after four rounds
// of Pine edits vanished while every signal reported success.
//
// 1. THE PAGE HOLDS MORE THAN ONE `.monaco-editor.pine-editor-monaco` NODE.
//    One is a collapsed 0x0 element that is never mounted and carries no React
//    fiber. `querySelector` returns THAT one first, so the fiber walk failed and
//    every caller concluded "Pine editor closed" while the editor was plainly
//    open on screen. Pick by geometry, not by document order.
//
// 2. `getEditors()` RETURNS SEVERAL EDITORS AND INDEX 0 IS DETACHED. Writing to
//    it compiled clean, reported "Saved", never bumped the script version, and
//    left the chart running the previous code. Nothing in the UI contradicted
//    it. Match the editor to the visible container by DOM node instead.
//
// Both fallbacks are deliberate: prefer the geometrically visible container and
// the DOM-matched editor, but rather than returning null when the page shape
// changes again, fall back to the LAST editor, which has never been the
// detached one in any build observed.
const FIND_MONACO = `
  (function findMonacoEditor() {
    var nodes = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    var container = null;
    for (var n = 0; n < nodes.length; n++) {
      var box = nodes[n].getBoundingClientRect();
      if (box.width > 0 && box.height > 0) { container = nodes[n]; break; }
    }
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 25; i++) {
      if (!el) break;
      fiberKey = Object.getOwnPropertyNames(el).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (!editors || editors.length === 0) return null;
          var pick = null;
          for (var z = 0; z < editors.length; z++) {
            var dom = editors[z].getDomNode && editors[z].getDomNode();
            if (dom && (dom === container || container.contains(dom) || dom.contains(container))) {
              pick = editors[z];
              break;
            }
          }
          if (!pick) pick = editors[editors.length - 1];
          return { editor: pick, env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pure / offline functions ──

/**
 * Strip single-line comments and string literals from a line of Pine Script.
 * Used to avoid false positives in regex-based static analysis.
 */
function stripCommentsAndStrings(line) {
  let result = '';
  let i = 0;
  while (i < line.length) {
    // Single-line comment — drop rest of line
    if (line[i] === '/' && line[i + 1] === '/') break;
    // Double-quoted string — replace with EQUAL-LENGTH whitespace, not a single
    // space. Callers feed the stripped line back into regexes and use m.index
    // against the ORIGINAL line (and extractBalancedCall offsets); collapsing a
    // literal to one space shifts every later column left, corrupting those
    // offsets and producing false/missed diagnostics.
    if (line[i] === '"') {
      const start = i;
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++; // skip escape
        i++;
      }
      i++; // closing quote (may run one past EOL if unterminated)
      result += ' '.repeat(Math.min(i, line.length) - start);
      continue;
    }
    // Single-quoted string — same length-preserving treatment.
    if (line[i] === "'") {
      const start = i;
      i++;
      while (i < line.length && line[i] !== "'") {
        if (line[i] === '\\') i++;
        i++;
      }
      i++;
      result += ' '.repeat(Math.min(i, line.length) - start);
      continue;
    }
    result += line[i];
    i++;
  }
  return result;
}

/**
 * Extract the full text of a function call starting at `startLine`/`startCol`
 * by reading until balanced parentheses close. Returns { text, endLine }.
 */
function extractBalancedCall(lines, startLine, startCol) {
  let text = '';
  let depth = 0;
  let started = false;
  let inStr = null;   // active string delimiter (" or ') or null
  let esc = false;    // previous char was a backslash inside a string
  for (let li = startLine; li < lines.length; li++) {
    const seg = li === startLine ? lines[li].slice(startCol) : lines[li];
    for (const ch of seg) {
      text += ch;
      if (inStr) {
        // Inside a string literal: parens here are data, not call structure.
        // Without this, security("AAPL", title="(temp)") decremented depth
        // early and returned a truncated call, breaking downstream analysis.
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') { depth--; }
      if (started && depth === 0) return { text, endLine: li };
    }
    text += '\n';
  }
  return { text, endLine: lines.length - 1 };
}

export function analyze({ source }) {
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
    // Strip comments/strings first so a commented-out or in-string declaration
    // (e.g. `// arr = array.new(5)`) doesn't register a phantom array.
    const line = stripCommentsAndStrings(lines[i]);
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      // `[^)]*` greedily eats until the first `)`, so `array.from(foo(m, r))`
      // captures `foo(m, r` and a naive split on `,` would count nested
      // call args as elements (yielding wrong size, hence spurious bounds
      // diagnostics on valid Pine). When the captured slice contains a
      // `(`, the call has a nested expression; we can't statically count
      // its elements, so leave size as `null` (unknown) and stop bounds-
      // checking against this array.
      let size = null;
      if (args === '') size = 0;
      else if (!args.includes('(')) size = args.split(',').length;
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

  for (let i = 0; i < lines.length; i++) {
    // Strip first: a commented-out `// array.get(arr, -1)` or an in-string
    // `"array.get(x, 10)"` must not emit a false out-of-bounds diagnostic.
    const line = stripCommentsAndStrings(lines[i]);
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
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = stripCommentsAndStrings(lines[i]);
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  // ── Check 5: Version hint (v4 or v5 detected — suggest v6) ──
  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 6) {
      const vNum = parseInt(vMatch[1]);
      let vLine = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('//@version=')) { vLine = i + 1; break; }
      }
      diagnostics.push({
        line: vLine, column: 1,
        message: `Pine v${vNum} detected — v6 is current. Consider migration with the porting-pine-versions skill.`,
        severity: 'info',
      });
    }
  }

  // ── Check 1: security() / request.security() without explicit lookahead ──
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
            line: i + 1, column: m.index + 1,
            message: 'request.security() without explicit lookahead (default may repaint — pass lookahead=barmerge.lookahead_off for confirmed data)',
            severity: 'warning',
          });
        }
      }
    }
  }

  // ── Check 2: Unused input declarations ──
  {
    const inputDecls = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripCommentsAndStrings(lines[i]);
      const m = stripped.match(/^(\w+)\s*=\s*input\b/);
      if (m) inputDecls.push({ name: m[1], lineNum: i + 1 });
    }
    for (const decl of inputDecls) {
      let used = false;
      for (let i = 0; i < lines.length; i++) {
        if (i + 1 === decl.lineNum) continue;
        const stripped = stripCommentsAndStrings(lines[i]);
        if (new RegExp(`\\b${_escapeRegex(decl.name)}\\b`).test(stripped)) { used = true; break; }
      }
      if (!used) {
        diagnostics.push({
          line: decl.lineNum, column: 1,
          message: `Input "${decl.name}" declared on line ${decl.lineNum} but never used`,
          severity: 'info',
        });
      }
    }
  }

  // ── Check 3: plot(close) in a strategy script ──
  {
    const hasStrategy = lines.some(l => /\bstrategy\s*\(/.test(stripCommentsAndStrings(l)));
    if (hasStrategy) {
      for (let i = 0; i < lines.length; i++) {
        const stripped = stripCommentsAndStrings(lines[i]);
        if (/\bplot\s*\(\s*close\s*[,)]/.test(stripped)) {
          diagnostics.push({
            line: i + 1, column: 1,
            message: 'plot(close) in strategy — consider strategy.entry/exit visuals or plotshape() for signal markers',
            severity: 'info',
          });
          break;
        }
      }
    }
  }

  // ── Check 4: Explicit lookahead=barmerge.lookahead_on ──
  {
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripCommentsAndStrings(lines[i]);
      if (/lookahead\s*=\s*barmerge\.lookahead_on/.test(stripped)) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'lookahead=barmerge.lookahead_on causes future data to be used — only valid for specific use cases, otherwise repaints',
          severity: 'warning',
        });
      }
    }
  }

  return {
    success: true,
    count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source, _deps } = {}) {
  const formData = new URLSearchParams();
  formData.append('source', source);
  const fetchImpl = _deps?.fetch || globalThis.fetch;

  // NOTE: this is a host-side Guest fetch, not an authenticated
  // in-page call. Deliberate tradeoff: it keeps `pine_check` working with
  // TradingView CLOSED (no CDP session needed) for the common case of public
  // scripts. Limitation: premium/private indicators won't resolve under Guest,
  // and the request originates from the host IP (Guest compile checks are
  // rate-limited per IP). Routing through evaluateAsync with credentials would
  // fix both but requires TV running and a live-verified response shape — not
  // changed blind. If you add an authenticated path, keep this Guest fetch as a
  // fallback so offline checks still work.
  let response;
  try {
    response = await fetchImpl(
      'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.tradingview.com/',
        },
        body: formData,
        signal: globalThis.AbortSignal.timeout(15_000),
      }
    );
  } catch (err) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView Pine compile request failed: ${err?.name === 'TimeoutError' ? 'timed out after 15000ms' : err.message}`,
      { cause: err, hint: 'Check network access to pine-facade.tradingview.com and retry.' },
    );
  }

  if (!response.ok) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView API returned ${response.status}: ${response.statusText}`,
    );
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  // READ BACK WHAT WE WROTE. setValue() returning without throwing proves
  // nothing: when the finder resolved a DETACHED editor, every write "worked",
  // compiled clean, reported Saved, and never reached the chart. The only
  // honest confirmation is to read the buffer again and compare.
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return { ok: false, why: 'no editor' };
      m.editor.setValue(${escaped});
      var back = m.editor.getValue();
      return { ok: true, lines: back.split('\\n').length, len: back.length };
    })()
  `);

  if (!set || !set.ok) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED,
      'Monaco found but setValue() failed' + (set && set.why ? ': ' + set.why : '.'));
  }
  const wantLines = source.split('\n').length;
  if (set.len !== source.length || set.lines !== wantLines) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED,
      'Wrote ' + source.length + ' chars / ' + wantLines + ' lines but the editor ' +
      'reads back ' + set.len + ' chars / ' + set.lines + ' lines. The write did ' +
      'not land in the editor bound to the saved script.');
  }
  return { success: true, lines_set: wantLines, verified: true };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: PRIMARY_MODIFIER, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: PRIMARY_MODIFIER, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  // DID IT ACTUALLY SAVE? Dispatching a keystroke and returning success:true
  // told callers the script was saved when the chord had gone to a control that
  // saves the CHART LAYOUT, or to an editor nothing was bound to. TradingView's
  // Pine save button flips its label to "Saved" and disables itself once there
  // is nothing outstanding, so that is the signal to read.
  let saved = null;
  for (let i = 0; i < 10; i++) {
    saved = await evaluate(`
      (function() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          if (b.offsetParent === null) continue;
          var t = (b.textContent || '').trim();
          if (/^Saved/i.test(t)) return true;
          if (/^Save$/i.test(t) && !b.closest('[role="dialog"]')) return false;
        }
        return null;
      })()
    `);
    if (saved !== null) break;
    await new Promise(r => setTimeout(r, 200));
  }

  return {
    success: true,
    action: dialogHandled ? 'saved_with_dialog' : 'save_chord_dispatched',
    // null means the button could not be located, which is NOT the same as
    // saved. Callers that care must treat null as unknown, not as success.
    saved: saved,
    ...(saved === false ? { warning: 'The editor still reports unsaved changes.' } : {}),
    ...(saved === null ? { warning: 'Could not find the Pine save button, so the save is UNVERIFIED.' } : {}),
  };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: PRIMARY_MODIFIER, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Simply set the source to a new template — this is the most reliable approach
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Monaco editor not found. Ensure Pine Editor is open.');

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new ClassifiedError(CATEGORIES.PINE_EDITOR_CLOSED, 'Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts({ name_filter, limit = 50, offset = 0 } = {}) {
  // MEASURED: this returned 53,933 bytes on a real account, roughly 13,500
  // tokens, on EVERY call. A tool that blows the context budget is worse than a
  // missing one, because the agent tries anyway and pays for it. Filtering and
  // pagination are the whole fix; the underlying fetch is fine.
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  const all = scripts?.scripts || [];
  const needle = typeof name_filter === 'string' ? name_filter.trim().toLowerCase() : '';
  const matched = needle
    ? all.filter((x) => `${x.name || ''} ${x.title || ''}`.toLowerCase().includes(needle))
    : all;

  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(Math.max(1, Number(limit) || 50), 200);
  const page = matched.slice(start, start + size);

  return {
    success: true,
    scripts: page,
    count: page.length,
    total: all.length,
    matched: matched.length,
    offset: start,
    limit: size,
    // Say plainly when the answer is incomplete. Silent truncation reads as
    // "that is all of them", which is how an agent concludes a script is gone.
    truncated: start + page.length < matched.length,
    ...(start + page.length < matched.length
      ? { next_offset: start + page.length, hint: `${matched.length - (start + page.length)} more. Re-call with offset=${start + page.length}, or pass name_filter to narrow.` }
      : {}),
    ...(scripts?.error ? { error: scripts.error } : {}),
    source: 'internal_api',
  };
}
