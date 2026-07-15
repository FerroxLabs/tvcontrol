/**
 * Core alert logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

const CONDITION_TYPES = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition = 'crossing', price, message, mobile_push = true, expiration_days = 30, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const numericPrice = requireFinite(price, 'price');
  const conditionType = CONDITION_TYPES[String(condition).trim().toLowerCase()];
  if (!conditionType) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Unsupported alert condition: ${condition}`);
  }
  const expiryDays = Number(expiration_days);
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'expiration_days must be an integer from 1 to 365');
  }

  const result = await evaluateAsync(`
    (async function() {
      try {
        var series = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var symbol = (series.proSymbol && series.proSymbol()) || (series.symbol && series.symbol());
        if (!symbol) return { ok: false, error: 'Could not read the current chart symbol' };
        var price = ${JSON.stringify(numericPrice)};
        var conditionType = ${safeString(conditionType)};
        var message = ${safeString(message || '')};
        if (!message) {
          var verb = conditionType === 'greater' ? 'above' : (conditionType === 'less' ? 'below' : 'crossing');
          message = symbol.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var payload = {
          conditions: [{
            type: conditionType,
            frequency: 'on_first_fire',
            series: [{ type: 'barset' }, { type: 'value', value: price }],
            resolution: '1'
          }],
          symbol: '={"symbol":"' + symbol + '"}',
          resolution: '1', message: message,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false,
          mobile_push: ${mobile_push !== false}, web_hook: null, name: null,
          expiration: new Date(Date.now() + ${expiryDays} * 86400000).toISOString(),
          active: true, ignore_warnings: true
        };
        var response = await fetch('https://pricealerts.tradingview.com/create_alert', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ payload: payload })
        });
        var text = await response.text();
        var data = {}; try { data = JSON.parse(text); } catch (e) {}
        if (response.ok && data.s === 'ok') {
          return { ok: true, symbol: symbol, message: message, alert_id: data.r && data.r.alert_id };
        }
        return { ok: false, status: response.status, error: (data.err && data.err.code) || data.errmsg || text.slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!result?.ok) {
    throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `TradingView alert API rejected the request: ${result?.error || 'unknown error'}`);
  }
  return {
    success: true,
    source: 'pricealerts_api',
    symbol: result.symbol,
    alert_id: result.alert_id || null,
    condition: conditionType,
    condition_applied: true,
    price: numericPrice,
    message: result.message,
    mobile_push: mobile_push !== false,
    expiration_days: expiryDays,
  };
}

export async function list({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
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

export async function deleteAlerts({ delete_all, alert_ids, alert_id, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  let ids = Array.isArray(alert_ids) ? [...alert_ids] : [];
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const current = await list({ _deps });
    if (!current.success) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, current.error || 'Could not list alerts before delete-all');
    ids = current.alerts.map((alert) => alert.alert_id);
  }
  ids = [...new Set(ids.filter((value) => value != null && String(value).trim() !== ''))];
  if (ids.length === 0) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, delete_all ? 'No active alerts to delete' : 'Provide alert_id, alert_ids, or delete_all:true');
  }

  const result = await evaluateAsync(`
    (async function() {
      try {
        var response = await fetch('https://pricealerts.tradingview.com/delete_alerts', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } })
        });
        var text = await response.text();
        var data = {}; try { data = JSON.parse(text); } catch (e) {}
        return { ok: response.ok && data.s === 'ok', status: response.status, error: data.errmsg || text.slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (!result?.ok) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `TradingView alert deletion failed: ${result?.error || 'unknown error'}`);
  return { success: true, source: 'pricealerts_api', deleted_count: ids.length, alert_ids: ids };
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
