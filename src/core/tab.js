/**
 * TradingView Desktop tab management.
 *
 * The visible tab strip lives in a separate Electron shell target. CDP's
 * /json/activate endpoint can activate a renderer without clicking the real
 * shell tab, so all visible tab mutations are driven through the shell DOM.
 */
import CDP from 'chrome-remote-interface';
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getTargetInfo } from '../connection.js';
import { _assertCdpAllowed, CDP_HOST, CDP_PORT, reconnectToTarget, _fetchCdpJson, _withConnectionTimeout } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function _targets() {
  try {
    return await _fetchCdpJson('/json/list');
  } catch (error) {
    throw new ClassifiedError(CATEGORIES.CDP_DISCONNECTED, `Could not list CDP targets: ${error.message}`);
  }
}

async function _withTarget(targetId, fn) {
  let client;
  try {
    client = await _withConnectionTimeout(
      (_assertCdpAllowed('tab._withTarget'), CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId })),
      10000,
      `CDP shell connection ${targetId}`,
    );
    return await fn(async (expression) => {
      const { result, exceptionDetails } = await _withConnectionTimeout(
        client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }),
        10000,
        `CDP shell evaluation ${targetId}`,
      );
      if (exceptionDetails) {
        throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, exceptionDetails.exception?.description || exceptionDetails.text || 'Shell evaluation failed');
      }
      return result?.value;
    });
  } finally {
    try { await client?.close(); } catch (_) { /* already closed */ }
  }
}

async function _withShell(fn) {
  const candidates = (await _targets()).filter((target) =>
    target.type === 'page' && /\/window\/index\.html/i.test(target.url || '')
  );
  for (const candidate of candidates) {
    let matched = false;
    try {
      matched = await _withTarget(candidate.id, (evaluateShell) =>
        evaluateShell(`!!document.querySelector('.tabs-container .tab')`));
    } catch (_) { /* probe the next shell candidate */ }
    if (matched) return _withTarget(candidate.id, fn);
  }
  throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'TradingView shell tab bar was not found', {
    hint: 'This feature requires TradingView Desktop with its native tab bar. Run tv discover and include the Desktop version when reporting a selector change.',
  });
}

async function _isTargetVisible(targetId) {
  try {
    return await _withTarget(targetId, (evaluateTarget) => evaluateTarget('document.visibilityState')) === 'visible';
  } catch (_) {
    return false;
  }
}

export function _findFreshLandingTarget(targets, existingIds) {
  return targets.find((target) => target.type === 'page'
    && target.title === 'New tab'
    && !existingIds.has(target.id)) || null;
}

function _safeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'file:' ? `file://${parsed.pathname}` : `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return '';
  }
}

async function _list({ includeTargetIds = false } = {}) {
  const tabs = (await _targets())
    .filter((target) => target.type === 'page'
      && (/tradingview\.com\/chart/i.test(target.url || '') || target.title === 'New tab'))
    .map((target, index) => ({
      index,
      ...(includeTargetIds ? { target_id: target.id } : {}),
      title: String(target.title || '').replace(/^Live stock.*charts on /, ''),
      url: _safeUrl(target.url),
      chart_id: target.url?.match(/\/chart\/([^/?]+)/)?.[1] || null,
      is_chart: /tradingview\.com\/chart/i.test(target.url || ''),
    }));
  return { success: true, count: tabs.length, tab_count: tabs.length, tabs };
}

/**
 * WHICH TAB ARE WE ACTUALLY DRIVING, AND WHAT LAYOUT IS ON EACH.
 *
 * With two chart tabs open, every read in this connector describes ONE of them and says
 * nothing about which. Measured 2026-08-27: `chart_get_state` and `tv_chart_health` both
 * reported NASDAQ:QBTS @ 1D with full confidence while the person was watching a crypto
 * chart in the other tab. Both were telling the truth. Four separate root causes were
 * chased and none of them existed — the readings simply belonged to a screen nobody was
 * looking at.
 *
 * So `list()` now marks the attached tab and names the saved layout each tab holds. The
 * join is exact: a tab's URL carries the layout slug, and each saved chart record carries
 * the same slug in its `url` field.
 */
export async function list({ resolve_layouts = false } = {}) {
  // Identity comes from the CDP TARGET, not from the layout the tab happens to show. Two
  // tabs can display the same saved layout, and a slug comparison then marks BOTH attached
  // and picks the first arbitrarily - re-labelling the very incident this was added to
  // prevent. The target id is unique per tab and is what the connection is actually bound to.
  const base = await _list({ includeTargetIds: true });
  let attachedTargetId = null;
  try {
    const info = await getTargetInfo();
    attachedTargetId = info?.id ?? null;
  } catch { /* identity is best-effort; never fail a listing over it */ }

  let byslug = new Map();
  if (resolve_layouts) {
    try {
      const raw = await _evaluateAsync(`new Promise(function(resolve){
        window.TradingViewApi.getSavedCharts(function(c){ resolve(JSON.stringify((c||[]).map(function(x){return {id:x.id,name:x.name,url:x.url,resolution:x.resolution};}))); });
        setTimeout(function(){resolve('[]')},6000);
      })`);
      const saved = JSON.parse(typeof raw === 'string' ? raw : '[]');
      byslug = new Map(saved.map((x) => [x.url, x]));
    } catch { /* layout names are a convenience, not a contract */ }
  }

  const tabs = base.tabs.map((t) => {
    const lay = byslug.get(t.chart_id) || null;
    const { target_id, ...rest } = t;
    return {
      ...rest,
      attached: attachedTargetId !== null && target_id === attachedTargetId,
      layout_id: lay?.id ?? null,
      layout_name: lay?.name ?? null,
      layout_timeframe: lay?.resolution ?? null,
    };
  });
  const me = tabs.find((t) => t.attached) || null;
  return {
    ...base,
    tabs,
    attached_chart_id: me?.chart_id ?? null,
    attached_index: me?.index ?? null,
    // Named by what the user can SEE, not by a /json/list position. This module already
    // documents that CDP-target order and the visible tab strip diverge, so calling an
    // index "tab N" in a warning invites the reader to look at the wrong one.
    ...(tabs.length > 1
      ? {
        multiple_tabs_warning: `${tabs.length} chart tabs are open. Every reading from this connector describes only the attached one`
          + (me ? ` (${me.layout_name ? `layout "${me.layout_name}"` : `chart ${me.chart_id}`}${me.layout_timeframe ? ` @ ${me.layout_timeframe}` : ''})` : ' (which could not be identified)')
          + '. Confirm that is the one the user means before reporting chart state.',
      }
      : {}),
  };
}

export async function newTab({ layout, name } = {}) {
  // tab_new must always create a new shell tab. Reusing any pre-existing
  // "New tab" target can overwrite a user's layout-picker tab while falsely
  // reporting that the tab count increased.
  const beforeTargets = await _targets();
  const existingIds = new Set(beforeTargets.map((target) => target.id));
  const counts = await _withShell(async (evaluateShell) => {
    const before = await evaluateShell(`document.querySelectorAll('.tabs-container .tab').length`);
    const clicked = await evaluateShell(`
      (function() {
        var button = document.querySelector('[class*="create-new-tab"]');
        if (!button) return false;
        button.click();
        return true;
      })()
    `);
    if (!clicked) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'New-tab button not found in TradingView shell');
    await wait(1500);
    const after = await evaluateShell(`document.querySelectorAll('.tabs-container .tab').length`);
    return { before, after };
  });
  let landing = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    landing = _findFreshLandingTarget(await _targets(), existingIds);
    if (landing) break;
    await wait(250);
  }

  if (!layout) {
    const state = await list();
    return {
      success: counts.after > counts.before && !!landing,
      action: 'new_tab_opened',
      note: 'The new tab is on the layout picker. Pass layout="new" or a saved layout name to open a chart.',
      ...state,
    };
  }
  if (!landing) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, 'New tab opened but its layout picker target was not found');

  const existingChartIds = new Set((await _targets())
    .filter((target) => target.type === 'page' && /tradingview\.com\/chart/i.test(target.url || ''))
    .map((target) => target.id));
  const createNew = String(layout).trim().toLowerCase() === 'new';

  const picked = await _withTarget(landing.id, async (evaluateLanding) => {
    if (createNew) {
      await evaluateLanding(`(function(){var b=document.querySelector('.create-new-layout-button');if(b)b.click();})()`);
      await wait(700);
      const filled = await evaluateLanding(`
        (function() {
          var input = document.querySelector('input[placeholder="My layout"]');
          if (!input) {
            var dialog = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dialog) input = dialog.querySelector('input');
          }
          if (!input) return false;
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(name || 'New layout')});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      if (!filled) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Create-layout name input not found');
      await wait(400);
      const created = await evaluateLanding(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var buttons = scope.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            if ((buttons[i].textContent || '').trim().toLowerCase() === 'create' && !buttons[i].disabled) {
              buttons[i].click(); return true;
            }
          }
          return false;
        })()
      `);
      if (!created) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Create-layout button not found or disabled');
      return name || 'New layout';
    }

    const findAndClick = `
      (function() {
        var query = ${JSON.stringify(String(layout).toLowerCase())};
        var items = document.querySelectorAll('.layout-list-item');
        for (var i = 0; i < items.length; i++) {
          var title = items[i].querySelector('.layout-list-item-title');
          if (title && title.textContent.trim().toLowerCase().indexOf(query) !== -1) {
            items[i].click(); return title.textContent.trim();
          }
        }
        return null;
      })()
    `;
    let selected = await evaluateLanding(findAndClick);
    if (!selected) {
      await evaluateLanding(`(function(){var b=document.querySelector('.layout-list-expand-button');if(b)b.click();})()`);
      await wait(800);
      selected = await evaluateLanding(findAndClick);
    }
    return selected;
  });
  if (!picked) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Layout matching "${layout}" was not found`);

  let chartTarget = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(500);
    const targets = await _targets();
    chartTarget = targets.find((target) => target.type === 'page'
      && /tradingview\.com\/chart/i.test(target.url || '')
      && !existingChartIds.has(target.id)) || null;
    if (chartTarget) break;
  }
  if (!chartTarget) throw new ClassifiedError(CATEGORIES.CHART_LOADING, `Layout "${picked}" did not produce a chart target`);
  await wait(2000);
  await reconnectToTarget(chartTarget.id);
  return {
    success: true,
    action: createNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    chart_id: chartTarget.url?.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

export async function closeTab({ expect_title, _deps } = {}) {
  // THIS CLOSED A CHART TAB THAT HELD LIVE WORK, ON 2026-08-21, DURING ITS OWN TEST.
  //
  // The cause is that closeTab and switchTab do not share an index space.
  // switchTab reasons about CHART TARGETS via _list({includeTargetIds:true});
  // closeTab acts on DOM '.tabs-container .tab' elements. A "New tab" page sits
  // in the tab strip but owns no chart target, so the two disagree about both
  // which tab is Nth and which one is active. A switch that looked like it
  // landed had not, and this function then closed whatever was really active.
  //
  // It also reported success purely from the tab COUNT dropping, which is true
  // whichever tab died. So: name the tab first, and prove THAT tab is the one
  // that went.
  const snapshot = await _withShell((evaluateShell) => evaluateShell(`
    (function() {
      var tabs = document.querySelectorAll('.tabs-container .tab');
      var out = { count: tabs.length, active_index: -1, labels: [] };
      for (var i = 0; i < tabs.length; i++) {
        out.labels.push((tabs[i].textContent || '').trim().slice(0, 60));
        if (tabs[i].classList.contains('active')) out.active_index = i;
      }
      return out;
    })()
  `));

  if (!snapshot || !snapshot.count) {
    throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Could not read the tab strip, so no tab was closed');
  }
  if (snapshot.count <= 1) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'Cannot close the last tab');
  }
  if (snapshot.active_index === -1) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `No tab is marked active among ${snapshot.count} tabs, so tab_close could not tell which one you are on and refused to guess`,
      { hint: `Tabs are: ${snapshot.labels.join(' | ')}. Use tab_switch, or click the tab you want to close.` },
    );
  }

  const victim = snapshot.labels[snapshot.active_index];

  // Pin the target when the caller cares which tab dies. Closing a chart tab is
  // not recoverable through this API, so an unexpected target must stop here
  // rather than be discovered afterwards.
  if (expect_title) {
    const want = String(expect_title).toLowerCase();
    if (!String(victim).toLowerCase().includes(want)) {
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        `The active tab is "${victim}" but expect_title was "${expect_title}", so nothing was closed`,
        { hint: `Tabs are: ${snapshot.labels.join(' | ')}. Switch to the intended tab first and confirm with tab_list.` },
      );
    }
  }

  const after = await _withShell(async (evaluateShell) => {
    const clicked = await evaluateShell(`
      (function() {
        var active = document.querySelector('.tabs-container .tab.active');
        if (!active) return false;
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click(); return true;
      })()
    `);
    if (!clicked) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, 'Close button not found on the active tab');
    await wait(1000);
    return evaluateShell(`
      (function() {
        var tabs = document.querySelectorAll('.tabs-container .tab');
        var out = { count: tabs.length, labels: [] };
        for (var i = 0; i < tabs.length; i++) out.labels.push((tabs[i].textContent || '').trim().slice(0, 60));
        return out;
      })()
    `);
  });

  if (!after || after.count >= snapshot.count) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `The close was clicked but the tab count did not drop (${snapshot.count} -> ${after ? after.count : 'unreadable'})`,
      { hint: 'Call tab_list to see the true current state.' },
    );
  }

  // A COUNT THAT DROPPED DOES NOT SAY WHICH TAB WENT.
  //
  // The snapshot and the click happen in SEPARATE CDP sessions, tens to
  // hundreds of milliseconds apart, and the click re-queries `.tab.active`
  // fresh. So it closes whatever is active AT CLICK TIME, which need not be
  // the tab named in the snapshot. This then reported `closed: victim` from
  // the stale snapshot with verified: true, on the strength of a count. That
  // is a narrower version of the incident that closed the operator's chart
  // tab, in the function whose header comment claims to have fixed it. Found
  // by an external audit.
  //
  // Compare the label multisets and say what ACTUALLY left.
  const tally = (labels) => {
    const m = new Map();
    for (const l of labels || []) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const beforeTally = tally(snapshot.labels);
  const afterTally = tally(after.labels);
  const departed = [];
  for (const [label, n] of beforeTally) {
    const left = n - (afterTally.get(label) || 0);
    for (let i = 0; i < left; i += 1) departed.push(label);
  }

  const victimLabel = typeof victim === 'string' ? victim : (victim && victim.label) || null;
  const victimWent = victimLabel === null
    ? null
    : departed.some((l) => l === victimLabel);

  if (victimWent === false) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `tab_close aimed at ${JSON.stringify(victimLabel)} but that tab is still open. `
      + `What actually closed: ${departed.length ? departed.map((l) => JSON.stringify(l)).join(', ') : 'could not be determined'}. `
      + 'The active tab changed between reading the strip and clicking close.',
      { hint: 'Call tab_list to see the true current state. Pass expect_title to make tab_close refuse rather than guess.' },
    );
  }

  return {
    success: true,
    action: 'tab_closed',
    closed: victimLabel,
    // What left according to the labels, not according to the count.
    closed_observed: departed.length === 1 ? departed[0] : departed,
    tabs_before: snapshot.count,
    tabs_after: after.count,
    remaining: after.labels,
    verified: victimWent === true,
    ...(victimWent === null ? {
      verify_note: 'The victim had no readable label, so which tab closed could only be inferred from '
        + 'the label diff above. Labels are truncated to 60 characters, so identically-prefixed titles '
        + 'are indistinguishable.',
    } : {}),
  };
}

export async function switchTab({ index }) {
  const state = await _list({ includeTargetIds: true });
  const targetIndex = Number(index);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= state.tab_count) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Tab index ${index} out of range (have ${state.tab_count} tabs)`);
  }
  const target = state.tabs[targetIndex];
  if (!await _isTargetVisible(target.target_id)) {
    const clicked = await _withShell(async (evaluateShell) => {
      const count = await evaluateShell(`document.querySelectorAll('.tabs-container .tab').length`);
      const order = [...new Set([Math.min(targetIndex, count - 1), ...Array.from({ length: count }, (_, i) => i)])];
      for (const candidate of order) {
        await evaluateShell(`document.querySelectorAll('.tabs-container .tab')[${candidate}].click()`);
        await wait(400);
        if (await _isTargetVisible(target.target_id)) return candidate;
      }
      return null;
    });
    if (clicked === null) throw new ClassifiedError(CATEGORIES.API_UNEXPECTED, `Chart target ${target.chart_id || target.index} never became visible`);
  }
  await reconnectToTarget(target.target_id);

  // PROVE THE SWITCH LANDED IN THE TAB STRIP, not just in the CDP session.
  // switchTab indexes CHART TARGETS; tab_close acts on DOM tab-strip elements.
  // A "New tab" page occupies a strip slot and owns no chart target, so the two
  // disagree about which tab is Nth and which is active. Returning success here
  // on the strength of reconnectToTarget alone is what let a later tab_close
  // destroy the wrong tab on 2026-08-21.
  const strip = await _withShell((evaluateShell) => evaluateShell(`
    (function() {
      var tabs = document.querySelectorAll('.tabs-container .tab');
      var out = { count: tabs.length, active_index: -1, active_label: null };
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].classList.contains('active')) {
          out.active_index = i;
          out.active_label = (tabs[i].textContent || '').trim().slice(0, 60);
        }
      }
      return out;
    })()
  `)).catch(() => null);

  return {
    success: true,
    action: 'switched',
    index: targetIndex,
    // The strip's own view of what is active. When this disagrees with index,
    // the chart-target order and the visible tab order are not the same list,
    // and any tab_close that follows must NOT assume it knows the target.
    active_tab_index: strip ? strip.active_index : null,
    active_tab_label: strip ? strip.active_label : null,
    tab_strip_count: strip ? strip.count : null,
    ...(strip && strip.active_index !== targetIndex
      ? { index_space_warning: `Chart target ${targetIndex} is now connected, but the visible tab strip shows tab ${strip.active_index} ("${strip.active_label}") as active. These are different index spaces, usually because a non-chart tab occupies a strip slot. Do not call tab_close assuming it will target this tab.` }
      : {}),
    chart_id: target.chart_id,
    // NOT HARDCODED ANY MORE. This said `true` unconditionally, including
    // when the strip read two lines above reported a DIFFERENT tab active.
    // Reading its own contradiction and then asserting success over the top is
    // the exact failure this tool already had once, when it reported a switch
    // it never performed and left tab_close to close whatever was active.
    visually_switched: strip
      ? (strip.active_index === targetIndex)
      : null,
    ...(strip && strip.active_index !== targetIndex ? {
      visual_mismatch: `tab_switch targeted index ${targetIndex} but the tab strip reports index `
        + `${strip.active_index} (${JSON.stringify(strip.active_label)}) as active. Do NOT run `
        + 'tab_close after this without passing expect_title.',
    } : {}),
    ...(strip ? {} : {
      visual_note: 'The tab strip could not be read, so which tab is visually active is unknown. '
        + 'It is reported as null rather than assumed.',
    }),
  };
}
