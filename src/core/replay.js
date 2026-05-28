/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
  };
}

export async function start({ date, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not available for the current symbol/timeframe', { hint: 'Switch to a symbol/timeframe that supports replay (most stocks/futures, daily and below).' });

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (date) {
    const ts = new Date(date).getTime();
    if (isNaN(ts)) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Invalid date: "${date}". Use YYYY-MM-DD format.`);
    await evaluate(`${rp}.selectDate(${ts}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    // Capture (don't swallow) the cleanup failure so a half-entered replay
    // that also failed to stop carries the reason as the error's cause.
    let cleanupErr;
    try { await evaluate(`${rp}.stopReplay()`); } catch (e) { cleanupErr = e; }
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Replay failed to start. The selected date may not have data for this timeframe.',
      { hint: 'Try a more recent date or a higher timeframe (e.g., Daily).', ...(cleanupErr ? { cause: cleanupErr } : {}) },
    );
  }

  return { success: true, replay_started: true, date: date || '(first available)', current_date: currentDate };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  let advanced = false;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    // Type guard: currentDate can transiently read back null/undefined; only a
    // real, different value counts as advanced — otherwise we'd "advance" to
    // undefined and return it as the new date.
    if (currentDate != null && currentDate !== before) { advanced = true; break; }
  }
  if (!advanced) {
    // Didn't advance within the poll window — likely end-of-data. Best-effort
    // confirm via the replay API so the caller learns stepping is exhausted.
    // Guarded: returns null if the method isn't present on this TV build, in
    // which case we simply omit at_end (only runs on the already-slow path).
    const ended = await evaluate(`
      (function(){
        try {
          var r = ${rp};
          function u(v){ return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
          if (typeof r.isReplayFinished === 'function') return !!u(r.isReplayFinished());
          if (typeof r.isReplayEnded === 'function') return !!u(r.isReplayEnded());
          if (typeof r.isLastBar === 'function') return !!u(r.isLastBar());
          return null;
        } catch(e){ return null; }
      })()
    `);
    return { success: true, action: 'step', current_date: currentDate, advanced: false, ...(ended === true ? { at_end: true } : {}) };
  }
  return { success: true, action: 'step', current_date: currentDate, advanced: true };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Invalid autoplay delay ${speed}ms.`, { hint: `Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}` });

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  return { success: true, action: 'replay_stopped' };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
