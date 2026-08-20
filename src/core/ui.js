/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

export async function click({ by, value }) {
  // Selector strings used to be assembled in-page via string concat with
  // hand-rolled quote escaping (`value.replace(/"/g, '\\\\"')`), which
  // broke on values containing backslashes or control chars and could
  // throw a DOM SyntaxError that bypassed the intended ClassifiedError.
  // Use attribute-equality filtering on a broad querySelectorAll instead
  // — the value never touches the CSS parser.
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        var nodes = document.querySelectorAll('[aria-label]');
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getAttribute('aria-label') === value) { el = nodes[i]; break; }
        }
      } else if (by === 'data-name') {
        var nodes2 = document.querySelectorAll('[data-name]');
        for (var i2 = 0; i2 < nodes2.length; i2++) {
          if (nodes2[i2].getAttribute('data-name') === value) { el = nodes2[i2]; break; }
        }
      } else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i3 = 0; i3 < candidates.length; i3++) {
          var text = candidates[i3].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i3]; break; }
        }
      } else if (by === 'class-contains') {
        var allClass = document.querySelectorAll('[class]');
        for (var i4 = 0; i4 < allClass.length; i4++) {
          if ((allClass[i4].getAttribute('class') || '').indexOf(value) !== -1) { el = allClass[i4]; break; }
        }
      }
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

// Is the Pine editor ACTUALLY on screen? Existence in the DOM is not enough:
// TradingView keeps a collapsed 0x0 `.monaco-editor.pine-editor-monaco` node
// around permanently, so `!!querySelector(...)` answers true for an editor the
// user cannot see and no tool can write to. Measure it.
const PINE_VISIBLE = `
  (function() {
    var nodes = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    for (var i = 0; i < nodes.length; i++) {
      var b = nodes[i].getBoundingClientRect();
      if (b.width > 0 && b.height > 0) return true;
    }
    return false;
  })()
`;

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var panel = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
        if (panel === 'pine-editor') {
          // Measured, not merely present. See PINE_VISIBLE above.
          var pineVisible = false;
          var pineNodes = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
          for (var pi = 0; pi < pineNodes.length; pi++) {
            var pb = pineNodes[pi].getBoundingClientRect();
            if (pb.width > 0 && pb.height > 0) { pineVisible = true; break; }
          }
          isOpen = pineVisible;
        }
        if (panel === 'strategy-tester') { var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'); isOpen = isOpen && !!(stratPanel && stratPanel.offsetParent); }
        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          // DESKTOP 3.3.0 MOVED THE PINE EDITOR INTO A DIALOG. The bottom
          // widget bar either is not present or opens a zero-height panel, and
          // the old code reported 'opened' either way. Try the widget bar, then
          // the dialog button, and let the caller verify.
          var acted = false;
          if (panel === 'pine-editor') {
            // ORDER MATTERS, AND IT IS THE WHOLE BUG. The previous version
            // called bottomWidgetBar FIRST and clicked the dialog button only
            // as a fallback. Measured on Desktop 3.3.0: with the widget-bar
            // call in front, the dialog never appeared within 3s and open
            // failed every time; clicking the dialog button on its own opened
            // it immediately and repeatably. bottomWidgetBar exists here and
            // its methods do not throw, they just leave the editor shut and
            // apparently leave TradingView believing it is already open, so
            // the later click is ignored.
            //
            // So on any build that HAS the dialog button, that button is the
            // only thing used. bottomWidgetBar is kept solely for older builds
            // that predate the dialog.
            var dlgBtn = document.querySelector('[data-name="pine-dialog-button"]')
              || document.querySelector('[aria-label="Pine"]');
            if (dlgBtn) {
              // The button OPENS and does not toggle: verified by clicking it
              // twice against a live chart, which left the editor open both
              // times. Safe to click without first checking whether it is open.
              dlgBtn.click(); acted = true;
            } else if (bwb && typeof bwb.activateScriptEditorTab === 'function') {
              bwb.activateScriptEditorTab(); acted = true;
            } else if (bwb && typeof bwb.showWidget === 'function') {
              bwb.showWidget(widgetName); acted = true;
            }
          } else if (bwb && typeof bwb.showWidget === 'function') {
            bwb.showWidget(widgetName); acted = true;
          }
          if (!acted) return { error: 'no way to open ' + panel + ' in this build' };
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          // Same dialog problem as opening. hideWidget only knows the bottom
          // panel, so on Desktop 3.3.0 the close silently did nothing while
          // reporting 'closed'. The dialog button toggles, so clicking it while
          // the editor is visible closes it.
          var closed = false;
          if (bwb && typeof bwb.hideWidget === 'function') { bwb.hideWidget(widgetName); closed = true; }
          else if (bwb && typeof bwb.close === 'function') { bwb.close(); closed = true; }
          else if (bwb && typeof bwb.hide === 'function') { bwb.hide(); closed = true; }
          if (panel === 'pine-editor') {
            // Re-measure: hideWidget may have been a no-op for the dialog.
            var stillVisible = false;
            var vNodes = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
            for (var vi = 0; vi < vNodes.length; vi++) {
              var vb = vNodes[vi].getBoundingClientRect();
              if (vb.width > 0 && vb.height > 0) { stillVisible = true; break; }
            }
            if (stillVisible) {
              // NOT the pine-dialog-button: that OPENS the dialog and does not
              // toggle it, so clicking it here left the editor open while the
              // call reported closed. The dialog carries its own Close control.
              var dlg = document.querySelector('[data-name="pine-dialog"]');
              var closeBtn = dlg && (dlg.querySelector('[aria-label="Close"]')
                || dlg.querySelector('[aria-label="Collapse panel"]'));
              if (closeBtn) { closeBtn.click(); closed = true; }
              else closed = false;
            }
          }
          if (!closed) return { error: 'no way to close ' + panel + ' in this build' };
          performed = 'closed';
        }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, result.error);

    // VERIFY. The old version returned success without ever looking, which is
    // how "opened" came back for a panel that stayed shut and sent callers
    // hunting for imaginary bugs downstream. Only pine-editor can be checked
    // cheaply and unambiguously, so that is the one that is checked.
    let verified = null;
    if (panel === 'pine-editor' && (result?.performed === 'opened' || result?.performed === 'closed')) {
      const want = result.performed === 'opened';
      for (let i = 0; i < 12; i++) {
        const vis = await evaluate(PINE_VISIBLE);
        if (vis === want) { verified = true; break; }
        await new Promise(r => setTimeout(r, 250));
      }
      if (verified === null) verified = false;
    }
    if (verified === false) {
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        'Asked to ' + action + ' the ' + panel + ' but it did not ' +
        (result.performed === 'opened' ? 'become visible' : 'close') +
        '. In TradingView Desktop 3.3.0 the Pine editor is a dialog behind ' +
        '[data-name="pine-dialog-button"], not a bottom panel.'
      );
    }
    return { success: true, panel, action, was_open: result?.was_open ?? false,
             performed: result?.performed ?? 'unknown',
             ...(verified === true ? { verified: true } : {}) };
  } else {
    const selectorMap = {
      'watchlist': {
        dataNames: ['base-watchlist-widget-button', 'base'],
        ariaLabels: ['Watchlist', 'Watchlist, details, and news'],
      },
      'alerts': { dataNames: ['alerts-button', 'alerts'], ariaLabels: ['Alerts'] },
      'trading': { dataNames: ['trading-button'], ariaLabels: ['Trading Panel'] },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataNames = ${JSON.stringify(sel.dataNames)};
        var ariaLabels = ${JSON.stringify(sel.ariaLabels)};
        var action = ${JSON.stringify(action)};
        var btn = null;
        for (var d = 0; d < dataNames.length && !btn; d++) btn = document.querySelector('[data-name="' + dataNames[d] + '"]');
        for (var a = 0; a < ariaLabels.length && !btn; a++) btn = document.querySelector('[aria-label="' + ariaLabels[a] + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

export async function layoutList({ limit = 50, offset = 0, include_details = false } = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 5000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  // If the inner evaluateAsync set an error (timeout, no data, thrown),
  // surface it as success:false. Returning success:true with a silent
  // error field misleads callers into thinking the list was empty on
  // purpose — the layout_list timeout bug that hid this from scripted
  // "swap between saved layouts" flows.
  if (layouts?.error) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      layouts.error,
      { hint: 'TradingView\'s getSavedCharts didn\'t respond within 5s. Open and re-save a layout via the TradingView UI, then retry. If it persists, the saved-layouts API path may have moved — file an issue.' },
    );
  }
  const allLayouts = layouts?.layouts || [];
  const page = allLayouts.slice(boundedOffset, boundedOffset + boundedLimit).map((layout) => include_details
    ? layout
    : { id: layout.id, name: layout.name });
  return {
    success: true,
    layout_count: allLayouts.length,
    returned_count: page.length,
    offset: boundedOffset,
    limit: boundedLimit,
    has_more: boundedOffset + page.length < allLayouts.length,
    source: layouts?.source,
    layouts: page,
  };
}

export async function layoutSwitch({ name }) {
  const escaped = JSON.stringify(name);
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var target = ${escaped};
        if (/^\\d+$/.test(target)) { window.TradingViewApi.loadChartFromServer(target); resolve({success: true, method: 'loadChartFromServer', id: target, source: 'internal_api'}); return; }
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({success: false, error: 'getSavedCharts returned no data', source: 'internal_api'}); return; }
          var match = null;
          for (var i = 0; i < charts.length; i++) { var cname = charts[i].name || charts[i].title || ''; if (cname === target || cname.toLowerCase() === target.toLowerCase()) { match = charts[i]; break; } }
          if (!match) { for (var j = 0; j < charts.length; j++) { var cn = (charts[j].name || charts[j].title || '').toLowerCase(); if (cn.indexOf(target.toLowerCase()) !== -1) { match = charts[j]; break; } } }
          if (!match) { resolve({success: false, error: 'Layout "' + target + '" not found.', source: 'internal_api'}); return; }
          var chartId = match.id || match.chartId;
          window.TradingViewApi.loadChartFromServer(chartId);
          resolve({success: true, method: 'loadChartFromServer', id: chartId, name: match.name || match.title, source: 'internal_api'});
        });
        setTimeout(function() { resolve({success: false, error: 'getSavedCharts timed out', source: 'internal_api'}); }, 5000);
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, result?.error || 'Unknown error switching layout');

  // Handle "unsaved changes" confirmation dialog
  await new Promise(r => setTimeout(r, 500));
  const dismissed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/open anyway|don't save|discard/i.test(text)) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (dismissed) await new Promise(r => setTimeout(r, 1000));
  return { success: true, layout: result.name || name, layout_id: result.id, source: result.source, action: 'switched', unsaved_dialog_dismissed: dismissed };
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  // Fallback for single-character keys: digits use `Digit<N>`, letters use
  // `Key<L>`. The old code emitted `Key1`/`Key0` for digits which CDP does
  // not recognise — number keys would silently no-op.
  function _fallbackKey(k) {
    if (typeof k !== 'string' || k.length !== 1) return { code: 'Key' + String(k).toUpperCase(), vk: String(k).toUpperCase().charCodeAt(0) };
    if (/[0-9]/.test(k)) return { code: 'Digit' + k, vk: k.charCodeAt(0) };
    if (/[a-zA-Z]/.test(k)) return { code: 'Key' + k.toUpperCase(), vk: k.toUpperCase().charCodeAt(0) };
    return { code: 'Key' + k.toUpperCase(), vk: k.charCodeAt(0) };
  }
  const mapped = keyMap[key] || _fallbackKey(key);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value }) {
  // Same attribute-equality-then-substring pattern as click() — no
  // in-page CSS string concatenation.
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        var nodes = document.querySelectorAll('[aria-label]');
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getAttribute('aria-label') === value) { el = nodes[i]; break; }
        }
        if (!el) {
          for (var ii = 0; ii < nodes.length; ii++) {
            if ((nodes[ii].getAttribute('aria-label') || '').indexOf(value) !== -1) { el = nodes[ii]; break; }
          }
        }
      } else if (by === 'data-name') {
        var nodes2 = document.querySelectorAll('[data-name]');
        for (var i2 = 0; i2 < nodes2.length; i2++) {
          if (nodes2[i2].getAttribute('data-name') === value) { el = nodes2[i2]; break; }
        }
      } else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i3 = 0; i3 < candidates.length; i3++) {
          var text = candidates[i3].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i3]; break; }
        }
      } else if (by === 'class-contains') {
        var allClass = document.querySelectorAll('[class]');
        for (var i4 = 0; i4 < allClass.length; i4++) {
          if ((allClass[i4].getAttribute('class') || '').indexOf(value) !== -1) { el = allClass[i4]; break; }
        }
      }
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount }) {
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return { success: true, direction, amount: px };
}

export async function mouseClick({ x, y, button, double_click }) {
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  // CDP/W3C `buttons` bitmask: left=1, right=2, middle=4. The old mapping
  // (left=0, middle=1, right=2) is a different namespace and strict event
  // listeners ignore clicks that arrive with the wrong bit set.
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  }
  return { success: true, x, y, button: btn, double_click: !!double_click };
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var nodes = document.querySelectorAll('[aria-label]');
        var els = [];
        for (var ni = 0; ni < nodes.length && els.length < 20; ni++) {
          if ((nodes[ni].getAttribute('aria-label') || '').indexOf(query) !== -1) els.push(nodes[ni]);
        }
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  const result = await evaluate(expression);
  return { success: true, result };
}
