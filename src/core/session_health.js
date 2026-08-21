/**
 * CHART SESSION HEALTH, AND REPAIRING A PANE THAT CANNOT REPAIR ITSELF.
 *
 * ================= WHAT GOES WRONG =================
 *
 * A pane stops loading data and sits in a reconnect loop forever. The other
 * panes in the same layout are fine. Nothing the operator can do from the UI
 * fixes it, so the layout gets rebuilt by hand.
 *
 * Diagnosed live on 2026-08-21 with the session instrumented:
 *
 *     14ms   connect
 *     14ms   _sendCreateSession   sid=cs_xm4Yn7i7Qkxa   state=1
 *     108ms  _onCriticalError     "Invalid parameters"
 *            method: create_study
 *            args: [[], st4, sds_18, Script@tv-scripting-101!, <pine blob>]
 *
 * The chart session connects, replays its studies onto the new session, and
 * sends create_study with an EMPTY ARRAY where a string id belongs. The server
 * rejects it, and it rejects it as a CRITICAL error, which destroys the whole
 * session. The chart reconnects and does it again. The loop is permanent.
 *
 * ================= WHY IT CANNOT SELF-HEAL =================
 *
 * TradingView's own setSymbol short-circuits:
 *
 *     if (e === this.symbol() || ... n.symbolSameAsResolved(e)) return i?.(), !0;
 *
 * On a poisoned pane symbolSameAsResolved() returns TRUE while symbolInfo() is
 * still null, so re-setting the same symbol is a silent no-op. Every obvious
 * manual remedy does nothing, which is why rebuilding the layout looks like the
 * only option. It is not.
 *
 * ================= WHERE THE EMPTY ARRAY COMES FROM =================
 *
 * It is OUR race, not a TradingView quirk. Measured in the live build:
 *
 *     createStudy             async: true   (returns Promise<EntityId>)
 *     createMultipointShape   async: true
 *     setSymbol               async: true
 *     setResolution           async: true
 *
 * TradingView changed createStudy to return a Promise instead of an entityId.
 * Calling it fire-and-forget and reading getAllStudies() after a fixed sleep
 * reads the study BEFORE the promise that assigns its id has resolved, so the
 * id is []. Win the race and everything looks fine; lose it and the pane
 * carries a landmine that kills its session on the next reconnect. That is
 * exactly why this strikes at random.
 *
 * A healthy pane never has one. Measured side by side on the same layout:
 *
 *     pane 1 (healthy)   TC-RTA V6  Pine  id "Uqd28X"
 *     pane 0 (broken)    TC-RTA V6  Pine  id []
 *
 * ================= THE REPAIR =================
 *
 * Remove the studies whose id is not a usable string, then reconnect. Verified
 * on a live broken pane: session came back as cs_VmBPx3nc31XM, state 2, symbol
 * resolved, and the removed indicator was added back through the normal
 * indicator dialog with a real id. Seconds, and nothing was rebuilt.
 */

import { evaluate as _evaluate, evaluateAsync as _evaluateAsync } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { strictResolve } from './_resolve.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';

const _HEALTH_DEPS = new Set(['evaluate', 'evaluateAsync', 'wait']);

function _resolve(deps) {
  strictResolve(deps, _HEALTH_DEPS);
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    wait: deps?.wait || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

/**
 * A study id is only useful if it is a non-empty string. TradingView hands out
 * an empty Array for a study whose server registration never completed, and
 * that value is what poisons create_study on the next reconnect.
 */
export function isPoisonedId(id) {
  return !(typeof id === 'string' && id.length > 0);
}

/**
 * Read every pane's session and study state. Pure observation, no writes.
 *
 * Returns { success, panes[], healthy, problems[] }. Each pane carries
 * session_id, session_state, symbol_resolved, and a studies[] list flagging any
 * whose id will not survive a reconnect.
 */
export async function inspect({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(`
    (function() {
      var out = { panes: [], socket: {} };
      try {
        var api = window.ChartApiInstance;
        out.socket.connected = !!(api && api._isConnected);
        out.socket.disconnect_count = api ? api._disconnectCount : null;
        out.socket.connections_limit_reached = (api && api._connectionsLimitReached && typeof api._connectionsLimitReached.value === 'function')
          ? api._connectionsLimitReached.value() : null;
      } catch (e) { out.socket.error = e.message; }
      var all;
      try { all = ${CWC}.getAll(); } catch (e) { out.error = 'getAll() threw: ' + e.message; return out; }
      for (var i = 0; i < all.length; i++) {
        var p = { index: i };
        try {
          var w = all[i];
          var cs = w._chartSession || null;
          p.session_id = cs ? String(cs._sessionId || '') : null;
          p.session_state = cs ? cs._state : null;
          p.session_connected = (cs && cs._isConnected && typeof cs._isConnected.value === 'function')
            ? cs._isConnected.value() : null;
          var mm = w.model().model();
          var ms = mm.mainSeries();
          p.symbol = String(ms.symbol());
          p.resolution = ms.interval ? String(ms.interval()) : null;
          try { p.symbol_resolved = ms.symbolInfo() !== null; } catch (e) { p.symbol_resolved = false; }
          try { p.series_status = ms.status(); } catch (e) { p.series_status = null; }
          p.studies = [];
          var srcs = mm.dataSources();
          for (var k = 0; k < srcs.length; k++) {
            try {
              var src = srcs[k];
              if (!src.metaInfo) continue;
              var mi = src.metaInfo();
              if (!mi || !mi.description) continue;
              // NEVER OFFER TRADINGVIEW'S OWN SOURCES FOR REMOVAL.
              // Dividends, splits, earnings and the continuous-contract roll
              // date calculator are attached to every chart and are not user
              // studies. The first version of this filter tested mi.id for an
              // "ESD$" prefix, but ESD$ is the SOURCE id, not the metaInfo id,
              // so all four sailed straight through into a destructive tool's
              // candidate list. They were never actually at risk here because
              // they all have valid ids, but a repair tool must not depend on
              // that to leave them alone.
              var miId = String(mi.id || '');
              var srcId = '';
              try { srcId = String((typeof src.id === 'function') ? src.id() : ''); } catch (e) {}
              if (srcId.indexOf('ESD$') === 0) continue;
              if (miId.indexOf('@tv-corestudies') !== -1) continue;
              if (/^(Dividends|Splits|Earnings|BarSetContinuousRollDates)@/.test(miId)) continue;
              var idv = null;
              try { idv = (typeof src.id === 'function') ? src.id() : null; } catch (e) {}
              p.studies.push({
                name: String(mi.description),
                id: (typeof idv === 'string' && idv.length > 0) ? idv : null,
                pine: miId.indexOf('tv-scripting') !== -1,
                script_id: miId || null
              });
            } catch (e) {}
          }
        } catch (e) { p.error = e.message; }
        out.panes.push(p);
      }
      return out;
    })()
  `);

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.panes)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Could not read chart session health: the page returned nothing usable.',
    );
  }

  const panes = raw.panes.map((p) => {
    const studies = p.studies || [];
    const poisoned = studies.filter((s) => isPoisonedId(s.id));
    const sessionDead = !p.session_id || p.session_state === 0 || p.session_connected === false;
    const problems = [];
    if (poisoned.length > 0) {
      problems.push(
        `${poisoned.length} stud${poisoned.length === 1 ? 'y has' : 'ies have'} no usable id ` +
        `(${poisoned.map((s) => JSON.stringify(s.name)).join(', ')}). Each one kills this pane's ` +
        'chart session every time it reconnects.',
      );
    }
    if (sessionDead) problems.push('this pane has no live chart session, so it cannot load data');
    if (p.symbol_resolved === false) problems.push(`symbol ${p.symbol} never resolved`);
    return {
      ...p,
      poisoned_studies: poisoned.map((s) => s.name),
      healthy: problems.length === 0,
      problems,
    };
  });

  const problems = panes.flatMap((p) => p.problems.map((t) => `pane ${p.index}: ${t}`));
  const repairable = panes.some((p) => p.poisoned_studies.length > 0);

  return {
    success: true,
    healthy: problems.length === 0,
    socket: raw.socket || {},
    panes,
    problems,
    ...(problems.length > 0 ? {
      advice: repairable
        ? 'Run tv_repair_chart to remove the studies with no usable id and reconnect the pane. ' +
          'It names every study it removes so you can add them back from the indicator dialog. ' +
          'Rebuilding the layout is not necessary.'
        : 'No study is poisoned, so tv_repair_chart has nothing to remove. If a pane still has no ' +
          'session, the connection itself is the problem: check tv_health_check.',
    } : {}),
  };
}

/**
 * Remove the studies that cannot survive a reconnect, then bring the session
 * back. Reports every study it removed BY NAME, because the operator has to
 * decide whether to add them back.
 *
 * Refuses to touch a healthy pane. `dry_run` reports the plan and changes
 * nothing.
 */
export async function repair({ pane = null, dry_run = false, _deps } = {}) {
  const { evaluate, wait } = _resolve(_deps);
  const before = await inspect({ _deps });

  const targets = before.panes.filter((p) => (pane === null || p.index === pane)
    && p.poisoned_studies.length > 0);

  if (pane !== null && !before.panes.some((p) => p.index === pane)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Pane ${pane} does not exist (this layout has ${before.panes.length}).`,
    );
  }

  if (targets.length === 0) {
    return {
      success: true,
      action: 'nothing_to_repair',
      healthy: before.healthy,
      problems: before.problems,
      note: before.healthy
        ? 'Every pane has a live session and no study with a missing id.'
        : 'No study is poisoned, so there is nothing here to remove. The remaining problems are ' +
          'listed above and need a different fix.',
    };
  }

  const plan = targets.map((p) => ({ pane: p.index, remove: p.poisoned_studies }));
  if (dry_run) {
    return { success: true, action: 'dry_run', plan, problems: before.problems };
  }

  const removed = [];
  const reconnected = [];
  const skippedReconnects = [];
  for (const target of targets) {
    for (const name of target.poisoned_studies) {
      // Remove by REFERENCE from inside the page. A poisoned study has no id,
      // so it cannot be addressed from out here at all.
      const r = await evaluate(`
        (function() {
          var w = ${CWC}.getAll()[${target.index}];
          var mm = w.model().model();
          var srcs = mm.dataSources();
          var found = null;
          for (var i = 0; i < srcs.length; i++) {
            try {
              var mi = srcs[i].metaInfo && srcs[i].metaInfo();
              if (!mi || String(mi.description) !== ${JSON.stringify(name)}) continue;
              // Repeat the exclusions here rather than trusting the caller.
              // This is the line that actually deletes something.
              var miId2 = String(mi.id || '');
              var srcId2 = '';
              try { srcId2 = String((typeof srcs[i].id === 'function') ? srcs[i].id() : ''); } catch (e) {}
              if (srcId2.indexOf('ESD$') === 0) continue;
              if (miId2.indexOf('@tv-corestudies') !== -1) continue;
              if (/^(Dividends|Splits|Earnings|BarSetContinuousRollDates)@/.test(miId2)) continue;
              var idv = null;
              try { idv = (typeof srcs[i].id === 'function') ? srcs[i].id() : null; } catch (e) {}
              if (typeof idv === 'string' && idv.length > 0) continue;
              found = srcs[i];
              break;
            } catch (e) {}
          }
          if (!found) return { removed: false, reason: 'no poisoned study by that name is on this pane any more' };
          var countBefore = mm.dataSources().length;
          try { mm.removeSource(found); }
          catch (e) {
            try { w.model().removeSource(found); }
            catch (e2) { return { removed: false, reason: 'removeSource threw: ' + e.message + ' / ' + e2.message }; }
          }
          var countAfter = mm.dataSources().length;
          return { removed: countAfter < countBefore, before: countBefore, after: countAfter };
        })()
      `);
      removed.push({
        pane: target.index,
        study: name,
        removed: !!(r && r.removed),
        ...(r && r.reason ? { reason: r.reason } : {}),
      });
    }

    // ONLY RECONNECT IF THE POISON IS ACTUALLY GONE.
    //
    // This used to reconnect unconditionally, under a comment claiming
    // "nothing poisons create_study" that was false whenever a removal had
    // failed. Reconnecting with the poisoned study still attached restarts the
    // exact critical-error loop this tool exists to end, so a failed repair
    // actively re-broke the pane it was called to fix.
    //
    // Setup-verified cleanup: the reconnect runs only when its setup
    // verifiably succeeded.
    const removedHere = removed.filter((r) => r.pane === target.index);
    const allGone = removedHere.length > 0 && removedHere.every((r) => r.removed);
    if (!allGone) {
      skippedReconnects.push({
        pane: target.index,
        reason: 'a poisoned study is still attached, so reconnecting would restart the critical-error loop',
        not_removed: removedHere.filter((r) => !r.removed).map((r) => r.study),
      });
      continue;
    }
    reconnected.push(target.index);
    await evaluate(`
      (function() {
        try {
          var cs = ${CWC}.getAll()[${target.index}]._chartSession;
          if (cs && typeof cs.connect === 'function') cs.connect();
          return true;
        } catch (e) { return false; }
      })()
    `);
  }

  // Give the session time to establish before judging the result.
  let after = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await wait(700);
    after = await inspect({ _deps });
    if (targets.every((t) => after.panes[t.index] && after.panes[t.index].healthy)) break;
  }

  const stillBroken = targets
    .map((t) => after.panes[t.index])
    .filter((p) => p && !p.healthy);

  // SUCCESS IS NOT UNCONDITIONAL.
  //
  // This returned `success: true, action: 'repaired'` no matter what happened,
  // including when every removal failed and nothing was repaired at all. That
  // is the silent-success class, inside the tool written to end it. The caller
  // reads `success` first and a false `healthy` further down does not undo a
  // true `success`.
  const anythingRemoved = removed.some((r) => r.removed);
  const fullyHealthy = stillBroken.length === 0;
  return {
    success: fullyHealthy,
    action: fullyHealthy ? 'repaired'
      : (anythingRemoved ? 'partially_repaired' : 'repair_failed'),
    removed,
    ...(skippedReconnects.length > 0 ? { reconnect_skipped: skippedReconnects } : {}),
    ...(reconnected.length > 0 ? { reconnected_panes: reconnected } : {}),
    // Say plainly what the operator lost, because they have to put it back.
    removed_studies: removed.filter((r) => r.removed).map((r) => r.study),
    re_add_hint: removed.some((r) => r.removed)
      ? 'Add these back with indicator_add_from_search, which goes through the indicator dialog and ' +
        'registers the study with the server properly. Do NOT use state_restore for this: the ' +
        'insertStudyWithoutCheck path is what created the broken study in the first place.'
      : null,
    healthy: stillBroken.length === 0,
    ...(stillBroken.length > 0 ? {
      still_broken: stillBroken.map((p) => ({ pane: p.index, problems: p.problems })),
      note: anythingRemoved && skippedReconnects.length === 0
        ? 'The poisoned studies are gone but the session has not come back. The connection itself ' +
          'may be down: check tv_health_check.'
        : 'Nothing could be removed, so the pane was deliberately NOT reconnected: doing so with the ' +
          'poisoned study still attached would restart the loop. The pane is no worse than before ' +
          'this call. Reload the layout to clear it.',
    } : {}),
    panes: after.panes.map((p) => ({
      index: p.index, symbol: p.symbol, session_id: p.session_id,
      symbol_resolved: p.symbol_resolved, healthy: p.healthy,
    })),
  };
}
