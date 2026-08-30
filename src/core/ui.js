/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
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
            // ORDER MATTERS. The previous version called bottomWidgetBar
            // FIRST and clicked the dialog button only as a fallback.
            //
            // MEASURED, and the platform split is the surprising part. The
            // same 9-transition open/open-when-open/close cycle was run
            // against live charts on three environments:
            //
            //   macOS   + Desktop 3.3.0   old order FAILS   new order 9/9
            //   Windows + Desktop 3.3.0   old order works   new order 9/9
            //   Windows + Chrome web      old order works   new order 9/9
            //
            // So this is a macOS-specific failure, NOT a Desktop-versus-web
            // one. On macOS the widget-bar call leaves the editor shut and
            // apparently leaves TradingView believing it is already open, so
            // the click that follows is ignored and open never happens.
            // bottomWidgetBar exists on every one of those builds and its
            // methods never throw, which is why the old code believed it had
            // worked.
            //
            // IF YOU ARE ON WINDOWS AND THE OLD ORDER LOOKS FINE: it is fine,
            // there. It is broken on macOS. Do not revert this on the strength
            // of a Windows test.
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
  // "I clicked a button" was the entire evidence here, and the return said
  // 'fullscreen_toggled' whether or not anything toggled. Read the state before
  // and after so the answer describes the screen rather than the click. Callers
  // also had no way to know which way it went, which makes restoring it after a
  // test guesswork.
  // MEASURED 2026-08-21: TradingView's chart fullscreen does NOT set
  // document.fullscreenElement and does NOT change window.innerWidth — inside
  // the Electron shell the window never resizes. What it actually does is hide
  // the left drawing toolbar and the right widget bar. That is the signal.
  const PANELS = `
    (function(){
      var right = document.querySelector('[class*="widgetbar"]') || document.querySelector('[data-name="right-toolbar"]');
      var left  = document.querySelector('[class*="drawingToolbar"]') || document.querySelector('[data-name="drawing-toolbar"]');
      var vis = function(el){
        if (!el) return null;
        var cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
      };
      return { fs: !!document.fullscreenElement, right: vis(right), left: vis(left) };
    })()
  `;
  const before = await evaluate(PANELS);

  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Fullscreen button not found');

  await new Promise((r) => setTimeout(r, 700));
  const after = await evaluate(PANELS);

  const changed = !!after && (after.left !== before?.left || after.right !== before?.right || after.fs !== before?.fs);
  if (!changed) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      'The fullscreen button was clicked but the toolbars did not change state',
      { hint: 'The button may be disabled in this window state. Check the chart manually.' },
    );
  }
  // Panels hidden IS fullscreen, whatever the browser fullscreen API says.
  // BOTH TOOLBARS HIDDEN IS NOT THE SAME AS FULLSCREEN.
  //
  // Someone who has collapsed both toolbars by hand looks identical to
  // fullscreen by this test, so `wasFs` is wrong for them and the toggle then
  // reports the opposite of what it did. An external audit flagged it.
  //
  // There is no fullscreenElement to consult: TradingView sets none and does
  // not resize the Electron window, which is why the toolbars were used in the
  // first place. So report the inference AS an inference rather than as a fact.
  const wasFs = before?.left === false && before?.right === false;
  const isFs = after.left === false && after.right === false;
  return {
    // Inferred from toolbar visibility, not observed directly. Manually
    // collapsed toolbars are indistinguishable from fullscreen by this signal.
    was_fullscreen_inferred_from: 'toolbar visibility',
    success: true,
    action: 'fullscreen_toggled',
    was_fullscreen: wasFs,
    is_fullscreen: isFs,
    toolbars: { before: { left: before?.left, right: before?.right }, after: { left: after.left, right: after.right } },
    verified: true,
  };
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

/**
 * Which saved layout the attached chart is currently showing.
 *
 * You could list layouts and switch to one, but never ask which one you were on, so
 * "did that switch land", "has the user moved since we saved this setup", and "what am I
 * looking at" were all unanswerable. Callers reconstructed it by hand from the chart URL,
 * which is exactly the kind of private join that goes stale without anyone noticing.
 *
 * The join is exact: the chart URL carries the layout slug, and each saved chart record
 * carries the same slug in its `url` field.
 */
export async function layoutGetActive() {
  const href = String(await evaluate('location.href'));
  const parts = href.split('/chart/');
  const slug = parts.length > 1 ? parts[1].split(/[/?#]/)[0] : null;
  if (!slug) {
    return { success: true, layout: null, chart_id: null, note: 'The attached tab is not a chart URL.' };
  }
  const raw = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(c) {
          resolve(JSON.stringify((c || []).map(function(x) { return { id: x.id, name: x.name, url: x.url, resolution: x.resolution }; })));
        });
        setTimeout(function() { resolve('[]'); }, 6000);
      } catch (e) { resolve('[]'); }
    })
  `);
  let saved = [];
  try { saved = JSON.parse(typeof raw === 'string' ? raw : '[]'); } catch { saved = []; }
  const match = saved.find((x) => x.url === slug) || null;
  return {
    success: true,
    chart_id: slug,
    layout: match ? { id: match.id, name: match.name, resolution: match.resolution } : null,
    // An unsaved chart has a slug with no saved record behind it. Say which case this is
    // rather than returning a bare null the caller has to interpret.
    ...(match ? {} : { note: 'This chart does not correspond to a saved layout. It may be an unsaved chart, or the layout list did not load.' }),
  };
}

export async function layoutSwitch({ name, discard_unsaved = false }) {
  const escaped = JSON.stringify(name);
  // WHAT THE CHART LOOKED LIKE BEFORE, READ BEFORE ANYTHING IS FIRED.
  //
  // loadChartFromServer() is fire-and-forget: the in-page promise resolves the
  // instant it is called, long before any chart has loaded. MEASURED
  // 2026-08-21: switching a 2-pane BTCUSDT layout to "MarketOverview" (ES1! 1D)
  // returned success:true TWICE while the chart never moved. So the switch has
  // to be proved by comparing before and after.
  //
  // THIS READ USED TO HAPPEN AFTER THE SWITCH WAS FIRED, which inverted the
  // whole check. Two independent audits found it. A fast cached switch
  // completes in the gap and before === after, and a read taken during the
  // teardown the switch just triggered returns null, and in both cases a
  // SUCCESSFUL switch burns the full poll and throws "chart never changed".
  // The caller then retries and fires a second switch, possibly into the
  // unsaved-changes dialog, caused entirely by the verification.
  const beforeState = await evaluate(`
    (function() {
      try {
        var api = window.TradingViewApi._activeChartWidgetWV.value();
        return { symbol: api._chartWidget.model().mainSeries().symbol(), res: api._chartWidget.model().mainSeries().interval() };
      } catch (e) { return null; }
    })()
  `);

  // WHY THE ENTRY OBJECT AND NOT THE ID.
  //
  // `loadChartFromServer(id)` is a one-line shim over the real service, and on
  // TradingView Desktop 3.3.0 it reads (verified by reading the live function):
  //
  //     async loadChartFromServer(e){ await (this._loadChartService?.loadChart(e,!1)) }
  //
  // `loadChart(entry, openInNewTab, skipUnsavedCheck)` wants the SAVED-CHART
  // ENTRY, not an id: it builds the route from `entry.url` and hands the whole
  // object to `backend.loadLayout(entry)`. Passing a bare number makes
  // `entry.url` undefined, so it navigates to `/chart/undefined/` and NOTHING
  // HAPPENS - no throw, no rejected promise, just a chart that never moves.
  // That is exactly the failure this tool reported for three releases: called,
  // claimed, never switched. So always resolve the entry first, for the id path
  // as well as the name path, and call the service directly.
  //
  // The third argument is the unsaved-changes bypass. Passing `discard_unsaved`
  // straight through lets TradingView skip its own dialog when the caller has
  // deliberately asked to discard, instead of us firing the switch and then
  // hunting the DOM for a button to click. The button-clicking path below stays
  // as the fallback for builds that still raise the dialog.
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var target = String(${escaped});
        var api = window.TradingViewApi;
        var svc = api._loadChartService;
        api.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({success: false, error: 'getSavedCharts returned no data', source: 'internal_api'}); return; }
          var lower = target.toLowerCase();
          var match = null;
          // An id is unambiguous, so it wins outright.
          if (/^\\d+$/.test(target)) {
            for (var i = 0; i < charts.length; i++) { if (String(charts[i].id) === target) { match = charts[i]; break; } }
            if (!match) { resolve({success: false, error: 'No saved layout has id ' + target + '. Re-run layout_list.', source: 'internal_api'}); return; }
          }
          if (!match) {
            for (var j = 0; j < charts.length; j++) { var cname = (charts[j].name || charts[j].title || ''); if (cname.toLowerCase() === lower) { match = charts[j]; break; } }
          }
          // NEVER GUESS BETWEEN SIMILAR NAMES. A substring match used to take
          // the first hit, so "TCTide" could silently resolve to "TCTide
          // Crypto" and hand a stocks scan the crypto book with no error
          // anywhere. A partial name is only allowed to resolve when exactly
          // one layout matches it.
          if (!match) {
            var near = [];
            for (var k = 0; k < charts.length; k++) { var cn = (charts[k].name || charts[k].title || ''); if (cn.toLowerCase().indexOf(lower) !== -1) near.push(charts[k]); }
            if (near.length === 1) { match = near[0]; }
            else if (near.length > 1) {
              var names = near.map(function(c) { return (c.name || c.title) + ' (id ' + c.id + ')'; });
              resolve({success: false, ambiguous: names, error: 'Layout "' + target + '" is ambiguous - it matches ' + near.length + ': ' + names.join(', ') + '. Pass the exact name or the id.', source: 'internal_api'});
              return;
            }
          }
          if (!match) { resolve({success: false, error: 'Layout "' + target + '" not found.', source: 'internal_api'}); return; }
          if (!svc || typeof svc.loadChart !== 'function') {
            // Older builds: the shim is all there is.
            api.loadChartFromServer(match.id);
            resolve({success: true, method: 'loadChartFromServer', id: match.id, name: match.name || match.title, source: 'internal_api'});
            return;
          }
          try {
            svc.loadChart(match, false, ${discard_unsaved ? 'true' : 'false'});
          } catch (inner) {
            resolve({success: false, error: 'loadChart threw: ' + inner.message, source: 'internal_api'});
            return;
          }
          resolve({success: true, method: 'loadChartService.loadChart', id: match.id, url: match.url, name: match.name || match.title, source: 'internal_api'});
        });
        setTimeout(function() { resolve({success: false, error: 'getSavedCharts timed out', source: 'internal_api'}); }, 5000);
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) {
    // An ambiguous or unknown NAME is the caller's argument being wrong, not
    // TradingView's DOM having moved. Classifying it as TV_UI_CHANGED attached
    // a hint telling the user to file an issue about a UI change, which sends
    // them chasing a bug that does not exist instead of typing an exact name.
    const badArg = Array.isArray(result?.ambiguous) || /not found|has id|ambiguous/i.test(result?.error || '');
    throw new ClassifiedError(
      badArg ? CATEGORIES.INVALID_ARGUMENT : CATEGORIES.TV_UI_CHANGED,
      result?.error || 'Unknown error switching layout',
      badArg ? { hint: 'Run layout_list and pass an exact layout name, or its numeric id.' } : undefined,
    );
  }

  // THE UNSAVED-CHANGES DIALOG IS A DECISION, NOT A NUISANCE.
  //
  // This used to hunt every button on the page for /open anyway|don't save|
  // discard/i and click it, then report unsaved_dialog_dismissed:true after the
  // fact. Reporting it afterwards is better than silence, but throwing away
  // somebody's unsaved chart work is not a default a tool gets to pick. The
  // caller has to ask for it.
  await new Promise(r => setTimeout(r, 500));
  const dialog = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var discard = null, cancel = null;
      for (var i = 0; i < btns.length; i++) {
        var text = (btns[i].textContent || '').trim();
        if (!discard && /open anyway|don't save|discard/i.test(text)) discard = text;
        if (!cancel && /^(cancel|back)$/i.test(text)) cancel = text;
      }
      return { present: !!discard, discard_label: discard, cancel_label: cancel };
    })()
  `);

  let dismissed = false;
  if (dialog?.present) {
    if (!discard_unsaved) {
      // Back out of the dialog so the UI is not left blocked, then say plainly
      // what stopped the switch.
      await evaluate(`
        (function() {
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            if (/^(cancel|back)$/i.test((btns[i].textContent || '').trim())) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        `The current chart has unsaved changes, so the switch to "${result.name || name}" was stopped rather than discarding them`,
        { hint: 'Save the layout first, or pass discard_unsaved:true to throw the changes away deliberately.' },
      );
    }
    await evaluate(`
      (function() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (/open anyway|don't save|discard/i.test((btns[i].textContent || '').trim())) { btns[i].click(); return true; }
        }
        return false;
      })()
    `);
    dismissed = true;
    await new Promise(r => setTimeout(r, 1000));
  }

  // POLL FOR THE CHART TO ACTUALLY CHANGE. A layout whose symbol matches the
  // one already loaded is indistinguishable from no switch at all, so that case
  // is reported as unconfirmed rather than claimed.
  let afterState = beforeState;
  let moved = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    afterState = await evaluate(`
      (function() {
        try {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          return { symbol: api._chartWidget.model().mainSeries().symbol(), res: api._chartWidget.model().mainSeries().interval() };
        } catch (e) { return null; }
      })()
    `);
    if (afterState && beforeState && (afterState.symbol !== beforeState.symbol || afterState.res !== beforeState.res)) {
      moved = true;
      break;
    }
  }

  if (!moved) {
    // NO BASELINE MEANS UNPROVEN, NOT FAILED.
    //
    // If the pre-switch read came back null we never had anything to compare
    // against, so `moved` can never become true and a perfectly good switch
    // would be reported as a failure. The caller then retries and fires a
    // SECOND switch. Say it is unconfirmed instead, and let the caller look.
    if (!beforeState) {
      return {
        success: true,
        layout: result.name || name,
        method: result.method,
        id: result.id,
        verified: null,
        verify_note: 'The chart state could not be read before the switch, so there was no baseline to '
          + 'compare against and the switch could not be confirmed either way. It was NOT retried, '
          + 'because retrying an unconfirmed switch can fire a second one. Run chart_get_state to see '
          + 'where the chart actually is.',
        ...(afterState ? { current: afterState } : {}),
      };
    }
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `loadChartFromServer was called for "${result.name || name}" but the chart never changed (still ${beforeState.symbol || 'unknown'} ${beforeState.res || ''})`,
      {
        hint: 'If that layout genuinely uses the symbol and timeframe already on screen, the switch cannot be distinguished from a no-op. Otherwise the layout id may be stale: re-run layout_list.',
        details: { before: beforeState, after: afterState },
      },
    );
  }

  return {
    success: true,
    layout: result.name || name,
    layout_id: result.id,
    source: result.source,
    action: 'switched',
    unsaved_changes_discarded: dismissed,
    symbol: afterState?.symbol ?? null,
    resolution: afterState?.res ?? null,
    verified: true,
  };
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

export async function typeText({ text, expect_focus }) {
  const c = await getClient();

  // THIS TYPES INTO WHATEVER HAPPENS TO HAVE FOCUS.
  // It was Input.insertText() and an immediate { success: true }: no idea where
  // the characters went, no check that anything was focused at all, and no
  // read-back. In an application that also contains order tickets and a Pine
  // editor holding 276 saved scripts, "I typed something somewhere" is not an
  // acceptable answer. Name the target before and after.
  const before = await evaluate(`
    (function() {
      var el = document.activeElement;
      if (!el || el === document.body) return { focused: false };
      return {
        focused: true,
        tag: el.tagName,
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || el.getAttribute('data-name') || el.getAttribute('aria-label') || null,
        editable: el.isContentEditable === true || /^(INPUT|TEXTAREA)$/.test(el.tagName),
        value_len: typeof el.value === 'string' ? el.value.length : null
      };
    })()
  `);

  if (!before || !before.focused) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      'Nothing has keyboard focus, so the text was not sent rather than being typed into an unknown target',
      { hint: 'Click the field first with ui_click, then call ui_type_text.' },
    );
  }
  if (!before.editable) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `The focused element is a <${before.tag}>${before.name ? ` (${before.name})` : ''}, which does not accept text, so nothing was typed`,
      { hint: 'Focus an input, textarea or contenteditable field first with ui_click.' },
    );
  }
  // Caller can pin the target so a mis-focused field is caught before typing.
  if (expect_focus) {
    const want = String(expect_focus).toLowerCase();
    const got = `${before.tag} ${before.name || ''}`.toLowerCase();
    if (!got.includes(want)) {
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        `Focus is on "${(before.name || before.tag)}" but expect_focus was "${expect_focus}", so nothing was typed`,
        { hint: 'Focus the intended field first, or drop expect_focus if any focused field is acceptable.' },
      );
    }
  }

  // PIN THE TARGET ACROSS THE WRITE.
  //
  // Focus was checked before insertText and then never again: the read-back
  // took document.activeElement a SECOND time and compared its length to the
  // first element's. An autocomplete or a dialog that steals focus mid-write
  // therefore made `verified` a coin flip between two different fields, while
  // `target` in the response still named the original. Both external auditors
  // flagged it.
  //
  // Tag it, so identity is exact rather than inferred from tag+name.
  const MARK = 'data-tvcontrol-typing';
  await evaluate(`
    (function() {
      var el = document.activeElement;
      if (el && el.setAttribute) el.setAttribute(${JSON.stringify(MARK)}, '1');
      return true;
    })()
  `);

  let after = null;
  try {
    await c.Input.insertText({ text });
    after = await evaluate(`
      (function() {
        var el = document.activeElement;
        if (!el) return { value_len: null, same_element: false };
        return {
          value_len: typeof el.value === 'string' ? el.value.length : null,
          tag: el.tagName,
          name: el.getAttribute('name') || el.getAttribute('data-name') || el.getAttribute('aria-label') || null,
          same_element: el.getAttribute(${JSON.stringify(MARK)}) === '1'
        };
      })()
    `);
  } finally {
    // Never leave our marker on the operator's DOM, whatever happened.
    await evaluate(`
      (function() {
        var marked = document.querySelectorAll('[' + ${JSON.stringify(MARK)} + ']');
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(${JSON.stringify(MARK)});
        return marked.length;
      })()
    `).catch(() => {});
  }

  const sameElement = after ? after.same_element === true : null;
  const grew = sameElement === true
    && typeof before.value_len === 'number' && typeof after?.value_len === 'number'
    ? after.value_len - before.value_len
    : null;

  if (sameElement === false) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `Focus moved while typing. The text was aimed at ${JSON.stringify(before.name || before.tag)} `
      + `but ${JSON.stringify((after && (after.name || after.tag)) || 'something else')} is focused now, `
      + 'so where the characters landed cannot be established.',
      { hint: 'Click the target with ui_click immediately before ui_type_text, and pass expect_focus so the target is checked first.' },
    );
  }

  return {
    success: true,
    typed: text.substring(0, 100),
    length: text.length,
    // Say WHERE it went. A caller that wanted the symbol box and hit the Pine
    // editor should be able to see that from the response.
    target: { tag: before.tag, name: before.name, type: before.type },
    focus_held: sameElement,
    ...(grew === null
      ? {
        verified: null,
        note: sameElement === null
          ? 'The page could not be read back, so the text could not be confirmed.'
          : 'The focused element exposes no value to read back, so the text could not be confirmed.',
      }
      : { verified: grew === text.length, chars_added: grew }),
  };
}

const HOVER_STRATEGIES = ['aria-label', 'data-name', 'text', 'class-contains'];

export async function hover({ by, value }) {
  // An unsupported strategy used to fall through every branch and come back as
  // "Element not found", which sends the caller hunting for a missing element
  // when the real problem is that this function never looked. ui_find_element
  // takes css; this does not.
  if (!HOVER_STRATEGIES.includes(by)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `hover does not support the "${by}" strategy, so no element was searched for`,
      { hint: `Use one of: ${HOVER_STRATEGIES.join(', ')}. For a CSS selector use ui_find_element instead.` },
    );
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'value is required and must be a non-empty string');
  }
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
  // Without this, a missing query became the literal `undefined` inside the
  // evaluated page source and blew up as "Cannot read properties of undefined
  // (reading 'toLowerCase')" — a raw in-page TypeError for what is simply a
  // missing argument.
  if (typeof query !== 'string' || !query.trim()) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'query is required and must be a non-empty string',
      { hint: "Pass the text, aria-label or CSS selector to look for, e.g. { query: 'Watchlist', strategy: 'text' }." },
    );
  }
  const strat = strategy || 'text';
  if (!['text', 'aria-label', 'css'].includes(strat)) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `strategy must be text, aria-label or css, got: ${strategy}`);
  }
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


/**
 * Create a NEW chart layout and save it under a name.
 *
 * Why this exists: there was no way to MAKE a layout - `layout_list`,
 * `layout_switch` and `layout_get_active` can only reach layouts the user
 * already had. A first-run setup could therefore only borrow the tester's own
 * chart, which is exactly how a "fresh install" run ends up proving nothing.
 *
 * 🔴 THE BUG THIS SHAPE EXISTS TO PREVENT - it happened, on a live account.
 *
 * `createNewLayout(name)` returns a new chart id and moves the URL via
 * history.replaceState, but it does NOT load that chart into the running
 * widget and it does NOT name anything. The widget keeps reporting the OLD
 * layout. A first version created the chart, then called the save with
 * `chartName`, and the save wrote to "the current chart" - which was still the
 * user's own layout. It RENAMED THEIR CHART and reported
 * `confirmed_in_account: true`, truthfully, about the wrong chart.
 *
 * So the widget must actually be ON the new chart before anything is saved.
 * The only evidence that it is, is the widget's own layout id changing -
 * not the URL, which moves without it. An earlier version compared URLs
 * "because the id lagged". The id was not lagging; it was correct, and the URL
 * was the misleading signal.
 *
 * Refuses outright when the current chart has unsaved work, because getting to
 * the new chart means navigating away from it.
 */
export async function layoutCreate({ name, discard_unsaved = false, _deps } = {}) {
  const title = String(name ?? '').trim();
  if (!title) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'A layout name is required.');
  }

  const before = await evaluate(`
    (function(){
      try {
        var api = window.TradingViewApi;
        if (!api) return { ok: false, error: 'TradingViewApi unavailable' };
        var svc = api.getSaveChartService && api.getSaveChartService();
        var dirty = null;
        try { dirty = svc && svc.hasChanges ? !!svc.hasChanges() : null; } catch (e) {}
        return { ok: true, layout_id: svc && svc.layoutId ? String(svc.layoutId()) : null, name: api.layoutName ? String(api.layoutName()) : null, dirty: dirty };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!before || !before.ok || !before.layout_id) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Could not read the current chart before creating (${(before && before.error) || 'no layout id'})`,
      { hint: 'Confirm TradingView is attached and a chart is open.' },
    );
  }
  if (before.dirty && !discard_unsaved) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `"${before.name || before.layout_id}" has unsaved changes, and creating a new layout navigates away from it.`,
      { hint: 'Save that chart first, or pass discard_unsaved: true to throw those changes away.' },
    );
  }

  const created = await evaluateAsync(`
    (async function(){
      try {
        var api = window.TradingViewApi;
        if (typeof api.createNewLayout !== 'function') return { ok: false, error: 'createNewLayout is not available on this TradingView build' };
        var id = await api.createNewLayout(${JSON.stringify(title)});
        if (id == null) return { ok: false, error: 'createNewLayout returned no id' };
        // The chart it made is not loaded. Go to it for real.
        location.href = '/chart/' + String(id) + '/';
        return { ok: true, id: String(id) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!created || !created.ok) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Could not create a new chart (${(created && created.error) || 'unknown'})`,
      { hint: 'This TradingView build may not expose createNewLayout. Report the Desktop version with tv_compatibility_check.' },
    );
  }

  // WAIT FOR THE WIDGET, NOT THE URL. Navigation tears down the page, so each
  // poll is its own evaluate and early ones are expected to fail.
  let moved = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const now = await evaluate(`
        (function(){
          try {
            var api = window.TradingViewApi;
            if (!api) return { ok: false };
            var svc = api.getSaveChartService && api.getSaveChartService();
            var id = svc && svc.layoutId ? String(svc.layoutId()) : null;
            return { ok: !!id, layout_id: id, ready: !!(api.activeChart && api.activeChart()) };
          } catch (e) { return { ok: false }; }
        })()
      `);
      if (now && now.ok && now.ready && now.layout_id !== before.layout_id) { moved = now.layout_id; break; }
    } catch (_) { /* page is still reloading */ }
  }
  if (!moved) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `A new chart (${created.id}) was created but the window is still showing layout ${before.layout_id}. Nothing has been saved.`,
      { hint: 'Refusing to save: saving now would write the new name onto the chart that is still loaded. Reload TradingView and retry.' },
    );
  }

  // THE WIDGET HAVING AN ID IS NOT THE CHART BEING USABLE.
  //
  // Measured on a live buyer run: layout_create returned, and the very next
  // calls failed - indicator_add_from_search said "TradingView accepted TC-TIDE
  // but no new study appeared", and chart_set_timeframe reported "Chart did not
  // finish loading" twice. A brand-new chart has a widget long before it has a
  // series, so the caller was handed a chart that could not yet take a study or
  // a timeframe, and had to sleep and retry to recover. Wait for real bars here
  // instead of making every caller rediscover it.
  const readyFn = _deps?.waitForChartReady || _waitForChartReady;
  const chartReady = await readyFn(null, null, 30000, _deps ? { evaluate: _deps.evaluate } : {});

  const saved = await layoutSave({ name: title, _deps });
  return {
    success: true,
    layout_id: created.id,
    widget_layout_id: moved,
    name: title,
    previous_layout_id: before.layout_id,
    previous_layout_name: before.name,
    confirmed_in_account: saved.confirmed_in_account,
    // Reported, not thrown: the layout exists and is named, so a caller that
    // retried on an exception would create a duplicate. false means add the
    // study and set the timeframe only after chart_get_state shows bars.
    chart_ready: chartReady === true,
    source: 'internal_api',
  };
}

/**
 * Save the current chart silently, optionally under a new name.
 *
 * `saveChartToServer` -> `_saveChartService.saveChartSilently` is the only save
 * path on the API that does not go through a `controller.show()` modal. The
 * third argument is an options object and `chartName` is what actually names
 * the layout - `createNewLayout`'s argument does not.
 *
 * Proven by re-reading `getSavedCharts()`, because a save that reports itself
 * is the call describing its own intentions.
 */
export async function layoutSave({ name, _deps } = {}) {
  const title = name === undefined || name === null ? null : String(name).trim();
  const r = await evaluateAsync(`
    (async function(){
      try {
        var api = window.TradingViewApi;
        if (!api || typeof api.saveChartToServer !== 'function') return { ok: false, error: 'saveChartToServer is not available on this TradingView build' };
        var opts = ${title ? `{ chartName: ${JSON.stringify(title)} }` : 'undefined'};
        api.saveChartToServer(undefined, undefined, opts);
        await new Promise(function(r){ setTimeout(r, 3000); });
        var charts = [];
        try { charts = (await api.getSavedCharts()) || []; } catch (e) {}
        var wanted = ${title ? JSON.stringify(title) : 'null'};
        var match = wanted ? charts.filter(function(c){ return (c.name || c.title) === wanted; }) : [];
        var svc = api.getSaveChartService && api.getSaveChartService();
        var pending = null;
        try { pending = svc && svc.hasChanges ? !!svc.hasChanges() : null; } catch (e) {}
        return { ok: true, saved_count: charts.length, matches: match.map(function(c){ return { id: c.id, name: c.name || c.title }; }), unsaved_changes_remaining: pending };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!r || !r.ok) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Could not save the chart (${(r && r.error) || 'unknown'})`,
    );
  }
  // A named save that the account does not list is not a save. Reporting
  // success here is exactly how layout_switch lied for three releases.
  if (title && !(r.matches || []).length) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The chart was saved but no layout called "${title}" is listed on the account (${r.saved_count} saved charts read).`,
      { hint: 'The save may still be in flight. Re-read with layout_list before retrying, so a second save does not create a duplicate.' },
    );
  }
  return {
    success: true,
    saved_as: title,
    confirmed_in_account: title ? true : null,
    matches: r.matches,
    unsaved_changes_remaining: r.unsaved_changes_remaining,
    source: 'internal_api',
  };
}
