/**
 * Core alert logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient, safeString } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

export async function create({ condition, price, message }) {
  const opened = await _evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await _evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await _evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await _evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  // Explain the failure instead of returning {success:false, error:null}.
  // Each step ('opened', 'priceSet', 'created') can fail independently — the
  // response has to carry which step faltered so the user can recover.
  if (!created) {
    const reasons = [];
    if (!opened) reasons.push('alert dialog did not open (Create Alert button not found and keyboard shortcut Alt+A may have been intercepted)');
    if (!priceSet) reasons.push('price input field not found in the alert dialog');
    reasons.push('Create submit button not found');
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      'Alert dialog could not be completed',
      {
        hint: reasons.join(' → ') + '. Open the Alerts panel manually via ui_open_panel({panel: "alerts", action: "open"}) and retry.',
      },
    );
  }

  // `condition` is NOT applied by this DOM fallback — the alert uses whatever
  // condition TradingView's dialog defaults to (typically "Crossing").
  // Implementing the condition dropdown needs live-verified selectors we don't
  // have; until then, surface this explicitly so the alert's actual trigger is
  // never SILENTLY wrong — a silent default would produce false signals.
  return {
    success: true,
    price,
    requested_condition: condition,
    condition_applied: false,
    warning: `condition "${condition}" was NOT set programmatically — the alert uses TradingView's default condition. Verify/adjust it in the dialog if the trigger direction matters.`,
    message: message || '(none)',
    price_set: !!priceSet,
    source: 'dom_fallback',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await _evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  // Honest success: only true when the upstream fetch returned ok and the
  // alerts array is well-formed. Previously we returned success:true even
  // when the inner CDP catch swallowed an error string — callers seeing
  // count:0 couldn't distinguish "no alerts" from "TV session expired".
  const hasError = !!result?.error;
  return {
    success: !hasError,
    count: result?.alerts?.length || 0,
    source: 'internal_api',
    alerts: result?.alerts || [],
    ...(hasError && { error: result.error, category: 'tv_ui_changed' }),
  };
}

export async function deleteAlerts({ delete_all, alert_id } = {}) {
  if (delete_all) {
    const result = await _evaluateAsync(`
      (async function() {
        var settle = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        // Wait a layout tick for the panel to render. The old code re-queried
        // [data-name="alerts"] SYNCHRONOUSLY and matched the SIDEBAR BUTTON
        // again — right-clicking the button instead of the panel header, a
        // silent no-op. Use a distinct panel-header selector here.
        await settle(400);
        var header = document.querySelector('.widgetbar-widgetheader')
          || document.querySelector('[class*="widgetbar"] [class*="header"]')
          || document.querySelector('[data-name="alerts-settings-button"]');
        if (header) {
          var rect = header.getBoundingClientRect();
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.x + 10, clientY: rect.y + 10 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    if (!result?.context_menu_opened) {
      // The DOM selector didn't match — TV UI changed or panel not present.
      // Caller should not see success:true for a no-op. Throw classified.
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        'Could not open alerts context menu — DOM selector did not match.',
        { hint: 'TradingView UI may have changed. Try ui_open_panel({panel: "alerts"}) first, then retry, or use alert_delete_by_id with a specific alert_id.' },
      );
    }
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: true, source: 'dom_fallback' };
  }
  if (alert_id) {
    return { success: true, note: 'DOM fallback for single alert deletion: open the Alerts panel and remove manually.', source: 'dom_fallback' };
  }
  throw new ClassifiedError(
    CATEGORIES.INVALID_ARGUMENT,
    'Individual alert deletion not yet supported.',
    { hint: 'Use alert_delete_by_id with a specific alert_id, or alert_delete with delete_all: true.' },
  );
}

export async function deleteById({ alert_id, _deps } = {}) {
  if (!alert_id || typeof alert_id !== 'string' || alert_id.trim() === '') {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'alert_id required',
      { hint: 'Call alert_list to find alert IDs' },
    );
  }

  const { evaluateAsync } = _resolve(_deps);
  const safeId = safeString(alert_id);

  // Try POST variant first, then GET variant
  const result = await evaluateAsync(`
    (function() {
      var url = 'https://pricealerts.tradingview.com/delete_alert?alert_id=' + encodeURIComponent(${safeId});
      var headers = { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' };
      return fetch(url, { method: 'POST', credentials: 'include', headers: headers })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.s === 'ok') return { s: 'ok', method: 'post' };
          return fetch(url, { method: 'GET', credentials: 'include', headers: headers })
            .then(function(r2) { return r2.json(); })
            .then(function(data2) {
              if (data2.s === 'ok') return { s: 'ok', method: 'get' };
              return { s: 'error', errmsg: data2.errmsg || data.errmsg || 'API returned non-ok' };
            });
        })
        .catch(function(e) { return { s: 'error', errmsg: e.message }; });
    })()
  `);

  if (result?.s === 'ok') {
    return { success: true, alert_id, method: 'rest_api', variant: result.method };
  }

  // REST failed — DOM fallback cannot delete individual alerts
  return {
    success: false,
    method: 'dom_fallback_unsupported',
    category: CATEGORIES.API_UNEXPECTED,
    error: 'Individual alert deletion via DOM not supported; use delete_all:true or ensure REST endpoint is reachable',
    hint: 'Ensure you are logged in and the pricealerts REST endpoint is reachable, or use alert_delete with delete_all:true.',
  };
}
