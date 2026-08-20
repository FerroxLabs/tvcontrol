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

// Both fields were hardcoded, so an agent could only ever create a one-shot
// alert on the 1-minute series. For a 74-symbol watchlist that is the
// difference between a usable alert set and a pile of alerts that fire once
// and go quiet.
//
// THE VOCABULARY WAS DETERMINED EMPIRICALLY against the live API on
// 2026-08-20, because guessing it produced invalid_request on every attempt.
// Of on_first_fire, on_bar_close, once, every_time, once_per_bar,
// once_per_bar_close, once_per_minute, on_every_tick, all_time, on_new_bar,
// on_bar_open, on_tick, continuous, once_per_day, on_every_bar, only_once and
// recurring, the API accepts exactly TWO. The operator's own 164 live alerts
// all use on_bar_close, which is the value the TradingView UI writes.
//   on_first_fire   fires once, then deactivates
//   on_bar_close    fires each time a bar closes with the condition true
const FREQUENCIES = new Set(['on_first_fire', 'on_bar_close']);
// Resolutions. VERIFIED LIVE: 1, 5, 15, 30, 60, 120, 240, D, W, M, 1D, 1W, 1M.
// The pattern is deliberately WIDER than that list — any 1-to-4-digit minute
// count passes — because TradingView supports resolutions this probe did not
// enumerate (2, 3, 10, 45, 90 and so on) and rejecting a legitimate one is a
// worse failure than forwarding it.
//
// This is a SHAPE check, not a whitelist, and the distinction matters: an
// unsupported value reaches the API, comes back invalid_request, and create()
// throws. It fails closed, so nothing false is ever reported as success. The
// check exists to catch "banana" before it costs a round trip, not to be the
// authority on what TradingView accepts.
const RESOLUTION_RE = /^([1-9][0-9]{0,3}|[DWM]|[1-9][0-9]?[DWM])$/;

export async function create({ condition = 'crossing', price, message, mobile_push = true, expiration_days = 30, frequency = 'on_first_fire', resolution = '1', _deps } = {}) {
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
  const freq = String(frequency).trim().toLowerCase();
  if (!FREQUENCIES.has(freq)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Unsupported alert frequency: ${frequency}`,
      { hint: `One of: ${[...FREQUENCIES].join(', ')}.` },
    );
  }
  const res = String(resolution).trim().toUpperCase();
  if (!RESOLUTION_RE.test(res)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Unsupported alert resolution: ${resolution}`,
      { hint: 'Minutes as a bare number (1, 5, 15, 60, 240) or D, W, M.' },
    );
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
            frequency: ${safeString(freq)},
            series: [{ type: 'barset' }, { type: 'value', value: price }],
            resolution: ${safeString(res)}
          }],
          symbol: '={"symbol":"' + symbol + '"}',
          resolution: ${safeString(res)}, message: message,
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
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView alert API rejected the request: ${result?.error || 'unknown error'}`,
      { hint: result?.error === 'invalid_request' ? 'Check frequency and resolution: the API accepts only on_first_fire and on_bar_close, and resolutions like 15, 240, 1D.' : undefined },
    );
  }

  // The create response is the action reporting on itself. Confirm the alert
  // exists from a separate read, the same rule the delete path follows.
  //
  // DELIBERATE ASYMMETRY WITH deleteById, flagged in review as an
  // inconsistency and kept on purpose. deleteById THROWS when its verification
  // read fails, because the safe response to an unconfirmed delete is to look
  // and try again. Creation is not like that: the POST already returned an
  // alert_id, so the alert probably exists, and throwing would invite a retry
  // that creates a SECOND one. Silently duplicating a trader's alerts is worse
  // than admitting the confirmation could not be read. So this reports
  // verified: null with an explicit note and lets the caller decide.
  let verified = null;
  let verify_note;
  if (result.alert_id) {
    const present = await _presentIds({ _deps });
    if (present === null) {
      verify_note = 'The alert was accepted and given an id, but the alert list could not be re-read, so its existence is unconfirmed. Call alert_list before retrying: retrying blind would create a duplicate.';
    }
    if (present !== null) {
      verified = present.has(String(result.alert_id));
      if (!verified) {
        throw new ClassifiedError(
          CATEGORIES.API_UNEXPECTED,
          `TradingView accepted the alert but ${result.alert_id} does not appear in the alert list`,
          { hint: 'Call alert_list to see the true current state before retrying.' },
        );
      }
    }
  }

  return {
    success: true,
    source: 'pricealerts_api',
    symbol: result.symbol,
    alert_id: result.alert_id || null,
    verified,
    ...(verify_note ? { verify_note } : {}),
    condition: conditionType,
    condition_applied: true,
    price: numericPrice,
    message: result.message,
    mobile_push: mobile_push !== false,
    expiration_days: expiryDays,
    frequency: freq,
    resolution: res,
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
  // The endpoint wants NUMBERS. A string id returns a bare {"s":"error"} with
  // no errmsg, which is a miserable thing to debug. Reject bad ids up front,
  // and normalise once so the request and the verification agree on spelling
  // ("00123" and 123 are the same alert).
  const numericIds = ids.map((value) => {
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || !Number.isSafeInteger(n) || n <= 0) {
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        `alert_id must be a positive integer, got: ${value}`,
        { hint: 'Call alert_list and use the alert_id field verbatim.' },
      );
    }
    return n;
  });
  ids = numericIds;

  // Same rule as deleteById: an id that was never there cannot be deleted, and
  // reporting it as deleted is how a caller concludes their alert is gone.
  const presentBefore = await _presentIds({ _deps });
  if (presentBefore === null) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Could not read the alert list, so the deletion cannot be verified and was not attempted',
      { hint: 'Usually an expired session. Reload TradingView, confirm you are logged in, and retry.' },
    );
  }
  const absent = ids.filter((n) => !presentBefore.has(String(n)));
  if (absent.length === ids.length) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `None of the requested alert ids exist: ${absent.join(', ')}`,
      { hint: 'Call alert_list and use alert_id values from that response verbatim.' },
    );
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

  // deleted_count used to be ids.length — the number we ASKED for, dressed up
  // as the number that happened. A partial success in a batch of 50 reported
  // all 50 gone. Count what a fresh read can no longer find.
  const survivors = await _survivingIds(ids, { _deps });
  if (survivors === null) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'The delete call was accepted but the alert list could not be re-read, so the deletion is unconfirmed',
      { hint: 'Call alert_list to see the true current state before retrying.' },
    );
  }
  const stillThere = ids.filter((id) => survivors.has(String(id)));
  const problems = [];
  if (stillThere.length) problems.push(`${stillThere.length} still exist after the delete was accepted`);
  if (absent.length) problems.push(`${absent.length} did not exist to begin with`);
  return {
    success: stillThere.length === 0 && absent.length === 0,
    source: 'pricealerts_api',
    requested_count: ids.length,
    // Only ids that WERE there and are now gone. An id that never existed is
    // not a deletion, however convenient it would be to count it as one.
    deleted_count: ids.length - stillThere.length - absent.length,
    alert_ids: ids,
    ...(stillThere.length ? { survived: stillThere } : {}),
    ...(absent.length ? { not_found: absent } : {}),
    ...(problems.length ? { error: `of ${ids.length} requested: ${problems.join('; ')}` } : {}),
    verified: stillThere.length === 0 && absent.length === 0,
  };
}

/**
 * Which of these ids does a FRESH read still find? Returns a Set of id strings,
 * or null when the list itself could not be read.
 *
 * Reading the list is not optional bookkeeping, it is the evidence. list()
 * returns {success:false, alerts:[]} rather than throwing when the session has
 * expired, so "the array does not contain it" was previously indistinguishable
 * from "I could not look" — and an expired session read as proof of deletion.
 */
async function _presentIds({ _deps } = {}) {
  let snap;
  try {
    snap = await list({ _deps });
  } catch {
    return null;
  }
  if (!snap || snap.success !== true || !Array.isArray(snap.alerts)) return null;
  return new Set(snap.alerts.map((a) => String(a.alert_id)));
}

async function _survivingIds(ids, { _deps } = {}) {
  let after;
  try {
    after = await list({ _deps });
  } catch {
    return null;
  }
  if (!after || after.success !== true || !Array.isArray(after.alerts)) return null;
  const present = new Set(after.alerts.map((a) => String(a.alert_id)));
  return new Set(ids.map((id) => String(id)).filter((id) => present.has(id)));
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

  // POST /delete_alert (SINGULAR) DOES NOT EXIST. TradingView answers it with
  // HTTP 200 and {"s":"error", code:"no_such_endpoint"}, so the old code saw a
  // 200, fell through to a DOM path that cannot delete a single alert, and
  // reported failure for something the API does fine.
  //
  // Measured against the live API on 2026-08-20:
  //   POST /delete_alert?alert_id=N                  no such endpoint
  //   POST /remove_alert?alert_id=N                  no such endpoint
  //   POST /modify_alert?alert_id=N                  no such endpoint
  //   POST /delete_alerts {payload:{alert_ids:[N]}}  {"s":"ok"}
  //
  // The plural endpoint exists and accepts a single id. Deleting one alert is
  // deleting a list of length one.
  // The id must go over the wire as a NUMBER. Sending it as a string returns
  // {"s":"error"} with no useful message — verified against the live API.
  // Normalise ONCE and compare against the normalised form everywhere.
  // Caught in adversarial review: the request sent Number(id) while the
  // post-delete verification compared String(a.alert_id) against the ORIGINAL
  // string. So "00123" or "123.0" would delete alert 123 correctly and then
  // report verified:false, because "123" !== "00123". A correct deletion
  // reported as unverified is the mirror of the bug this file exists to fix.
  const raw = String(alert_id).trim();
  const numericId = Number(raw);
  if (!Number.isInteger(numericId) || !Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `alert_id must be a positive integer, got: ${raw}`,
      { hint: 'Alert ids come from alert_list and look like 5418097596.' },
    );
  }
  const id = String(numericId);

  // "It is not in the list now" is NOT "I deleted it". Measured live on
  // 2026-08-20: deleting id 999999999999, which never existed, returned
  // success:true verified:true — the endpoint accepts any id, and the
  // after-the-fact absence check passes trivially for something that was never
  // there. Same defect as removeBulk calling a symbol it never touched
  // "removed". Establish presence FIRST, so success means a real deletion.
  const presentBefore = await _presentIds({ _deps });
  if (presentBefore === null) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Could not read the alert list, so the deletion cannot be verified and was not attempted',
      { hint: 'Usually an expired session. Reload TradingView, confirm you are logged in, and retry.' },
    );
  }
  if (!presentBefore.has(id)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `No alert with id ${id} exists, so nothing was deleted`,
      { hint: 'Call alert_list and use an alert_id from that response verbatim.' },
    );
  }

  const result = await evaluateAsync(`
    (async function() {
      try {
        var response = await fetch('https://pricealerts.tradingview.com/delete_alerts', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ payload: { alert_ids: [${numericId}] } })
        });
        var text = await response.text();
        var data = {}; try { data = JSON.parse(text); } catch (e) {}
        return { ok: response.ok && data.s === 'ok', status: response.status, error: data.errmsg || text.slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);

  if (!result?.ok) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Alert deletion failed: ${result?.error || 'unknown error'}`,
      { hint: 'Confirm the alert_id from alert_list and that you are still logged in.' },
    );
  }

  // VERIFY from a separate read. The API's own "ok" is the action reporting on
  // itself, which is the failure mode this codebase keeps finding.
  //
  // TWO ways this was still wrong, both caught by independent audits:
  //   1. `after.alerts || []` treated a FAILED read as an empty list, so an
  //      expired session proved the alert was gone. Absence of evidence was
  //      being recorded as evidence of absence.
  //   2. success was hardcoded true, so verified:false — the fresh read finding
  //      the alert still sitting there — still reported a successful delete.
  //      That is exactly the bug this function was rewritten to fix.
  const survivors = await _survivingIds([numericId], { _deps });
  if (survivors === null) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The delete call for alert ${id} was accepted but the alert list could not be re-read, so the deletion is unconfirmed`,
      { hint: 'Call alert_list to see the true current state before retrying.' },
    );
  }
  const verified = !survivors.has(id);
  if (!verified) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView accepted the delete but alert ${id} is still in the list`,
      { hint: 'Retry once. If it persists, delete it in the TradingView UI and report the alert_id.' },
    );
  }

  return { success: true, source: 'pricealerts_api', alert_id: id, verified: true };
}
