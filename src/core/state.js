/**
 * Core state snapshot / restore / list / delete logic.
 * Saves and reloads full chart state as named JSON files in ~/.tv-mcp/snapshots/.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import * as chart from './chart.js';
import * as pane from './pane.js';
import * as drawing from './drawing.js';
import { strictResolve } from './_resolve.js';
import { parseJsonSafe } from './_json.js';

const _STATE_DEPS = new Set([
  'evaluate', 'evaluateAsync', 'waitForChartReady',
  'paneList', 'drawingList', 'drawingProps', 'drawingClearAll',
]);

export const SNAPSHOTS_DIR = join(homedir(), '.tv-mcp', 'snapshots');

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  strictResolve(deps, _STATE_DEPS);
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    // Optional overrides for pane.list() and drawing calls (used in tests)
    paneList: deps?.paneList || null,
    drawingList: deps?.drawingList || null,
    drawingProps: deps?.drawingProps || null,
    drawingClearAll: deps?.drawingClearAll || null,
  };
}

function _validateName(name) {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'name must be a non-empty string');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'name must not contain "/" or "\\"');
  }
  if (name.includes('\0')) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'name must not contain null bytes');
  }
  // Reject any name that STARTS with `..` (catches `..`, `..evil`, `...foo`
  // — defense-in-depth even though separators are already blocked). Names
  // with `..` in the middle (`my..backup`) are fine — they can't form a
  // traversal once `/` and `\` are rejected above. The old
  // `includes('..')` was too broad and rejected legitimate snapshot names.
  if (name.startsWith('..')) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'name must not start with ".."');
  }
  if (name === '.') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'name must not be "."');
  }
}

function _snapshotPath(name, snapshotsDir) {
  return join(snapshotsDir, name + '.json');
}

/**
 * Capture full chart state to a named snapshot file.
 */
export async function snapshot({ name, overwrite = false, _deps, _snapshots_dir } = {}) {
  _validateName(name);
  const dir = _snapshots_dir || SNAPSHOTS_DIR;
  mkdirSync(dir, { recursive: true });
  const filePath = _snapshotPath(name, dir);

  if (!overwrite && existsSync(filePath)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `snapshot "${name}" already exists`,
      { hint: 'Pass overwrite: true, or use state_delete first' },
    );
  }

  const { evaluate, paneList: _paneListFn, drawingList: _drawingListFn, drawingProps: _drawingPropsFn } = _resolve(_deps);

  // Collected across every capture stage. Hoisted so the pane/drawing/visible
  // -range catches can record their failures here instead of silently
  // defaulting to empty (the old behavior produced "successful" snapshots
  // missing chunks of state).
  const skipped_at_snapshot = [];

  // Fetch chart state
  const chartState = await chart.getState({ _deps });

  // Fetch pane list (use injected fn if provided, else real pane.list())
  // Errors must surface — silent default-to-empty meant a broken pane API
  // produced a "successful" snapshot missing the entire multi-pane layout.
  let paneList = [];
  try {
    const paneResult = _paneListFn ? await _paneListFn() : await pane.list();
    paneList = paneResult.panes || [];
  } catch (err) {
    skipped_at_snapshot.push({ field: 'panes', reason: err.message });
  }

  // Fetch drawings with properties (use injected fns if provided)
  let drawingsData = [];
  try {
    const listFn = _drawingListFn || (() => drawing.listDrawings());
    const propsFn = _drawingPropsFn || (({ entity_id }) => drawing.getProperties({ entity_id }));
    const { shapes } = await listFn();
    for (const shape of (shapes || [])) {
      try {
        const props = await propsFn({ entity_id: shape.id });
        drawingsData.push({
          shape: shape.name || 'unknown',
          points: props.points || [],
          overrides: props.properties || {},
          text: '',
        });
      } catch (err) {
        skipped_at_snapshot.push({ field: 'drawing', id: shape.id, name: shape.name, reason: err.message });
      }
    }
  } catch (err) {
    skipped_at_snapshot.push({ field: 'drawings_enumerate', reason: err.message });
  }

  // Fetch visible range
  let visibleRange = null;
  try {
    const vr = await evaluate(`
      (function() {
        try {
          var chart = ${CHART_API};
          var r = chart.getVisibleRange();
          return r ? { from: r.from, to: r.to } : null;
        } catch(e) { return null; }
      })()
    `);
    if (vr && vr.from != null && vr.to != null) visibleRange = vr;
  } catch (err) {
    skipped_at_snapshot.push({ field: 'visible_range', reason: err.message });
  }

  // Fetch all study inputs in a single evaluate (avoids N+1 CDP roundtrips)
  const studies = [];

  let allStudiesData = [];
  let _studiesCaptureFailed = false;
  try {
    allStudiesData = await evaluate(`
      (function() {
        var chart = ${CHART_API};
        var all = chart.getAllStudies();
        // Pre-index dataSources by their study _id so we can read the real
        // metaInfo() (including scriptIdPart for published/private scripts).
        // getStudyById returns a handle whose metaInfo() doesn't carry
        // scriptIdPart — that field lives on the underlying dataSource.
        // dataSource._id is a Watch object (not a string) — calling toString
        // on it gives "[object Object]". The actual id is exposed via id().
        // getStudyById's id format ("8XM9C8") matches what id() returns.
        var dsById = {};
        try {
          var sources = chart._chartWidget.model().model().dataSources();
          for (var k = 0; k < sources.length; k++) {
            var src = sources[k];
            if (!src || !src.metaInfo) continue;
            var srcId = null;
            try {
              if (typeof src.id === 'function') srcId = src.id();
              else if (typeof src._id === 'string') srcId = src._id;
              else if (src._id && typeof src._id.value === 'function') srcId = src._id.value();
            } catch(e) {}
            if (srcId && typeof srcId === 'string') dsById[srcId] = src;
          }
        } catch(e) {}
        // Recursively serialize a metaInfo object to a JSON-safe plain copy.
        // metaInfo carries data fields (id, description, plots, inputs schema,
        // styles, palettes, scriptIdPart, etc.) plus methods. We strip the
        // methods, drop circular references, and cap depth — what survives is
        // exactly what TradingView's insertStudy needs to reconstruct the
        // study at restore time.
        function _safeCopy(value, depth, seen) {
          if (depth > 12 || value === null || value === undefined) return value;
          if (typeof value === 'function') return undefined;
          if (typeof value !== 'object') return value;
          if (seen.has(value)) return undefined;
          seen.add(value);
          if (Array.isArray(value)) {
            return value.map(function(v) { return _safeCopy(v, depth + 1, seen); });
          }
          var out = {};
          for (var key in value) {
            try {
              var v = value[key];
              var copy = _safeCopy(v, depth + 1, seen);
              if (copy !== undefined) out[key] = copy;
            } catch(e) {}
          }
          return out;
        }

        return all.map(function(s) {
          var study = chart.getStudyById(s.id);
          var raw = [];
          try { raw = study.getInputValues() || []; } catch(e) {}
          // Resolve the underlying dataSource so we can read the real metaInfo.
          var ds = dsById[s.id];
          if (!ds) {
            for (var n in dsById) {
              try { var m = dsById[n].metaInfo(); if (m && m.description === s.name) { ds = dsById[n]; break; } } catch(_){}
            }
          }
          var metaRaw = null;
          var scriptIdPart = null;
          try {
            if (ds && ds.metaInfo) {
              metaRaw = ds.metaInfo();
              if (metaRaw && metaRaw.scriptIdPart) scriptIdPart = metaRaw.scriptIdPart;
            }
          } catch(e) {}
          // For published/private Pine, KEEP the oversized inputs (the
          // encoded source blob is what makes the study reconstruct on
          // restore). For built-in studies, strip them as before — they
          // shouldn't have any oversized inputs anyway.
          var isPublishedPine = scriptIdPart && /^(PUB|USER);/.test(scriptIdPart);
          var inputs = [];
          var strippedInputs = [];
          for (var i = 0; i < raw.length; i++) {
            var inp = raw[i];
            if (!isPublishedPine && typeof inp.value === 'string' && inp.value.length > 500) {
              strippedInputs.push({ id: inp.id, value_length: inp.value.length });
            } else {
              inputs.push(inp);
            }
          }
          // For published Pine, also serialize the full metaInfo so restore
          // can reconstruct the study via insertStudy(metaInfo, inputsArray)
          // without needing to fetch from pine-facade.
          var metaInfoFull = null;
          if (isPublishedPine && metaRaw) {
            try { metaInfoFull = _safeCopy(metaRaw, 0, new Set()); } catch(e) {}
          }
          return {
            id: s.id,
            name: s.name,
            scriptIdPart: scriptIdPart,
            inputs: inputs,
            strippedInputs: strippedInputs,
            full_meta_info: metaInfoFull,
          };
        });
      })()
    `);
  } catch (err) {
    // Distinguish "chart genuinely has zero studies" from "study evaluate
    // threw" — the old silent default-to-[] produced snapshots that looked
    // valid but restored to an empty chart. Track the failure so the caller
    // sees data was lost.
    _studiesCaptureFailed = true;
    skipped_at_snapshot.push({ field: 'studies_enumerate', reason: err.message });
  }

  for (const s of (allStudiesData || [])) {
    const entry = {
      name: s.name,
      inputs: Array.isArray(s.inputs) ? s.inputs : [],
    };
    if (s.scriptIdPart) entry.scriptIdPart = s.scriptIdPart;
    // For published Pine: capture the full metaInfo so restore can inject
    // the study via insertStudy without needing pine-facade access. Without
    // this, scriptIdPart alone isn't enough — TradingView needs the full
    // schema (plots, inputs, styles).
    if (s.full_meta_info && typeof s.full_meta_info === 'object') {
      entry.full_meta_info = s.full_meta_info;
    }
    if (Array.isArray(s.strippedInputs) && s.strippedInputs.length > 0) {
      entry.stripped_inputs = s.strippedInputs;
      skipped_at_snapshot.push({
        field: 'studies',
        name: s.name,
        reason: 'encoded_source_stripped',
        count: s.strippedInputs.length,
        note: 'Built-in study with encoded inputs >500 chars (rare). Inputs retained at top level; the oversized ones tracked here.',
      });
    }
    studies.push(entry);
  }

  // Build pane info for snapshot
  const panesSnap = paneList.map((p, idx) => ({
    index: p.index ?? idx,
    symbol: p.symbol || chartState.symbol,
    resolution: p.resolution || chartState.resolution,
    chart_type: chartState.chartType ?? 1,
  }));

  // If no pane info from pane.list(), fall back to chart state
  if (panesSnap.length === 0) {
    panesSnap.push({
      index: 0,
      symbol: chartState.symbol,
      resolution: chartState.resolution,
      chart_type: chartState.chartType ?? 1,
    });
  }

  const payload = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    name,
    layout: {
      code: 's',
      pane_count: panesSnap.length,
    },
    panes: panesSnap,
    visible_range: visibleRange || undefined,
    studies,
    drawings: drawingsData,
    skipped_at_snapshot,
  };

  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.${process.pid}.${rand}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, filePath);

  return {
    // success=false when the studies capture threw outright — the snapshot
    // is still written (with whatever was salvaged) but the caller needs to
    // know it's degraded. Without this, a study-API regression in TV would
    // produce snapshots that look fine and restore to nothing.
    success: !_studiesCaptureFailed,
    ...(_studiesCaptureFailed && {
      degraded: true,
      hint: 'Study capture failed — snapshot was written but contains 0 studies. Inspect skipped_at_snapshot for the underlying error.',
    }),
    name,
    file_path: filePath,
    schema_version: 1,
    studies_count: studies.length,
    drawings_count: drawingsData.length,
    skipped_count: skipped_at_snapshot.length,
  };
}

/**
 * Restore a chart state from a named snapshot.
 */
export async function restore({ name, _deps, _snapshots_dir } = {}) {
  _validateName(name);
  const dir = _snapshots_dir || SNAPSHOTS_DIR;
  const filePath = _snapshotPath(name, dir);

  if (!existsSync(filePath)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Snapshot not found: ${name}. Run state_list to see available snapshots.`,
    );
  }

  let snap;
  try {
    snap = parseJsonSafe(readFileSync(filePath, 'utf8'));
  } catch {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Failed to parse snapshot file: ${filePath}`);
  }

  if (snap.schema_version !== 1) {
    throw new ClassifiedError(
      CATEGORIES.SNAPSHOT_INCOMPLETE,
      `Unsupported schema_version: ${snap.schema_version}. Only schema_version 1 is supported.`,
    );
  }

  const applied = [];
  const skipped = [];

  // 0. Clear existing studies and drawings before re-applying.
  //    All removals are batched into ONE evaluate call — was N+1 CDP
  //    roundtrips, now 1. Each per-study failure still propagates into
  //    skipped[] so the caller sees any state contamination.
  try {
    const currentState = await chart.getState({ _deps });
    const studiesToClear = currentState.studies || [];
    if (studiesToClear.length > 0) {
      const { evaluate } = _resolve(_deps);
      // Build the per-study calls at Node-side so each entity_id flows
      // through safeString — defends against any future ID format that
      // contains characters needing escaping.
      const removalCalls = studiesToClear
        .map(s => `try { chart.removeEntity(${safeString(s.id)}); removed.push(${safeString(s.id)}); } catch(e) { failed.push({ id: ${safeString(s.id)}, error: e.message }); }`)
        .join('\n        ');
      const batchResult = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var removed = [];
          var failed = [];
          ${removalCalls}
          return { removed: removed, failed: failed };
        })()
      `);
      const failedById = new Map((batchResult?.failed || []).map(f => [f.id, f.error]));
      for (const s of studiesToClear) {
        if (failedById.has(s.id)) {
          skipped.push({ field: 'pre_clear_study', name: s.name, id: s.id, reason: failedById.get(s.id) });
        }
      }
    }
  } catch (err) {
    // getState itself or the batch evaluate failed — restore may proceed but
    // the user has no view into pre-existing state. Surface as a single
    // skipped entry rather than dropping the entire restore.
    skipped.push({ field: 'pre_clear_enumerate', reason: err.message });
  }
  try {
    const { drawingClearAll: _clearAllFn } = _resolve(_deps);
    if (_clearAllFn) await _clearAllFn();
    else await drawing.clearAll();
  } catch (err) {
    skipped.push({ field: 'pre_clear_drawings', reason: err.message });
  }

  // 1. Layout
  if (snap.layout && snap.layout.pane_count > 1) {
    try {
      await pane.setLayout({ layout: snap.layout.code });
      applied.push('layout');
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      skipped.push({ field: 'layout', reason: err.message });
    }
  }

  // 2. Per-pane symbol + resolution + chart_type (pane 0 only)
  const pane0 = snap.panes && snap.panes[0];
  if (pane0) {
    if (pane0.symbol) {
      try {
        await chart.setSymbol({ symbol: pane0.symbol, _deps });
        applied.push(`symbol:${pane0.symbol}`);
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        skipped.push({ field: 'symbol', reason: err.message });
      }
    }
    if (pane0.resolution) {
      try {
        await chart.setTimeframe({ timeframe: pane0.resolution, _deps });
        applied.push(`resolution:${pane0.resolution}`);
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        skipped.push({ field: 'resolution', reason: err.message });
      }
    }
    if (pane0.chart_type != null) {
      try {
        await chart.setType({ chart_type: pane0.chart_type, _deps });
        applied.push(`chart_type:${pane0.chart_type}`);
      } catch (err) {
        skipped.push({ field: 'chart_type', reason: err.message });
      }
    }
    if (snap.panes.length > 1) {
      skipped.push({ field: 'multi_pane', reason: 'multi-pane restore is partial: only pane 0 restored' });
    }
  }

  // 3. Visible range
  if (snap.visible_range && snap.visible_range.from != null && snap.visible_range.to != null) {
    try {
      await chart.setVisibleRange({ from: snap.visible_range.from, to: snap.visible_range.to, _deps });
      applied.push('visible_range');
    } catch (err) {
      skipped.push({ field: 'visible_range', reason: err.message });
    }
  }

  // 4. Indicators
  // Pre-fetch the current study names so we can skip anything already loaded
  // (common after a manual layout reload; also the layout may pre-place the
  // strategy the user wants and we just want to update its inputs).
  let loadedStudyNames = new Set();
  try {
    const cs = await chart.getState({ _deps });
    for (const s of (cs.studies || [])) loadedStudyNames.add(s.name);
  } catch (_) { /* non-fatal; treat all as missing and try to add */ }

  for (const study of (snap.studies || [])) {
    if (loadedStudyNames.has(study.name)) {
      applied.push(`study:${study.name} (already on chart)`);
      continue;
    }
    // Published/private Pine scripts: re-inject directly via the internal
    // insertStudy API using the full metaInfo we captured at snapshot time.
    // chart.manageIndicator can't help here — it resolves names against the
    // built-in Java studies registry only. The metaInfo object contains the
    // full schema (plots, inputs, styles, scriptIdPart) that TradingView
    // needs to reconstitute the study with no pine-facade round-trip.
    if (study.scriptIdPart && /^(PUB|USER);/.test(study.scriptIdPart)) {
      if (!study.full_meta_info) {
        // Snapshot was taken before commit 913cb6b — no metaInfo captured.
        // Fall back to skip-with-hint so the user knows what's missing.
        skipped.push({
          field: 'study',
          name: study.name,
          reason: 'published_pine_no_meta_info',
          scriptIdPart: study.scriptIdPart,
          hint: 'Snapshot lacks full_meta_info (taken with an older snapshot version). Re-snapshot to capture the metaInfo, or load the layout containing this script manually.',
        });
        continue;
      }
      try {
        const inputsObj = Array.isArray(study.inputs)
          ? Object.fromEntries(study.inputs.map((inp) => [inp.id, inp.value]))
          : {};
        const injectResult = await injectPublishedStudy({
          metaInfo: study.full_meta_info,
          inputs: inputsObj,
          _deps,
        });
        if (injectResult.success) {
          applied.push(`study:${study.name} (published_pine)`);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        skipped.push({
          field: 'study',
          name: study.name,
          reason: injectResult.reason || 'published_pine_injection_failed',
          scriptIdPart: study.scriptIdPart,
          hint: injectResult.hint
            || 'insertStudy returned null. Try reloading the layout from the TradingView cloud-layouts dropdown.',
        });
        continue;
      } catch (err) {
        skipped.push({
          field: 'study',
          name: study.name,
          reason: 'published_pine_injection_threw',
          scriptIdPart: study.scriptIdPart,
          error: err.message,
        });
        continue;
      }
    }
    try {
      const inputs = Array.isArray(study.inputs)
        ? Object.fromEntries(study.inputs.map((inp) => [inp.id, inp.value]))
        : {};
      const addResult = await chart.manageIndicator({ action: 'add', indicator: study.name, inputs, _deps });
      if (addResult && addResult.success === false) {
        skipped.push({
          field: 'study',
          name: study.name,
          reason: 'manage_indicator_failed',
          hint: `TradingView did not resolve "${study.name}" as a built-in study. If this was a saved private Pine script, reload the layout that contains it.`,
        });
        continue;
      }
      applied.push(`study:${study.name}`);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      skipped.push({ field: 'study', name: study.name, reason: err.message });
    }
  }

  // 5. Drawings
  for (const d of (snap.drawings || [])) {
    try {
      const point = d.points && d.points[0];
      const point2 = d.points && d.points[1];
      if (!point) {
        skipped.push({ field: 'drawing', shape: d.shape, reason: 'no points in snapshot' });
        continue;
      }
      await drawing.drawShape({ shape: d.shape, point, point2, overrides: d.overrides, text: d.text, _deps });
      applied.push(`drawing:${d.shape}`);
    } catch (err) {
      skipped.push({ field: 'drawing', shape: d.shape, reason: err.message });
    }
  }

  // All-fail guard
  if (applied.length === 0 && (snap.panes?.length || snap.studies?.length || snap.drawings?.length)) {
    throw new ClassifiedError(
      CATEGORIES.SNAPSHOT_INCOMPLETE,
      'All restore steps failed. Check the skipped report.',
      { hint: `Skipped: ${JSON.stringify(skipped)}` },
    );
  }

  // Partial-restore signal: if more was skipped than applied, surface a flag
  // and a degraded success so callers branching on success see something
  // happened that needs review. Threshold: skipped > applied means the user
  // is looking at a broken layout (e.g. 1 EMA applied, 29 studies missing).
  const partial_restore = skipped.length > applied.length;

  return {
    success: !partial_restore,
    name,
    restored: { applied, skipped, applied_count: applied.length, skipped_count: skipped.length },
    ...(partial_restore && {
      partial_restore: true,
      hint: `Restore was partial — ${skipped.length} field(s) skipped vs ${applied.length} applied. Inspect restored.skipped[] for reasons.`,
    }),
  };
}

/**
 * List all snapshots sorted by captured_at descending.
 */
export function list({ _snapshots_dir } = {}) {
  const dir = _snapshots_dir || SNAPSHOTS_DIR;
  mkdirSync(dir, { recursive: true });

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const snapshots = [];
  const corrupt = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      const data = parseJsonSafe(raw);
      const pane0 = data.panes && data.panes[0];
      snapshots.push({
        name: data.name || file.replace(/\.json$/, ''),
        captured_at: data.captured_at || null,
        symbol: pane0 ? pane0.symbol : null,
        resolution: pane0 ? pane0.resolution : null,
        studies_count: Array.isArray(data.studies) ? data.studies.length : 0,
      });
    } catch (err) {
      // Surface unparseable files instead of silently hiding them — the user
      // needs a way to see and remove corrupt snapshots that fell off the
      // listing (e.g., an interrupted tmp->rename leaving a partial file).
      corrupt.push({ file, error: err.message });
    }
  }

  snapshots.sort((a, b) => {
    if (!a.captured_at) return 1;
    if (!b.captured_at) return -1;
    return b.captured_at.localeCompare(a.captured_at);
  });

  return {
    success: true,
    count: snapshots.length,
    snapshots,
    ...(corrupt.length > 0 && { corrupt }),
  };
}

/**
 * Delete a named snapshot.
 */
export function deleteSnapshot({ name, _snapshots_dir } = {}) {
  _validateName(name);
  const dir = _snapshots_dir || SNAPSHOTS_DIR;
  const filePath = _snapshotPath(name, dir);

  if (!existsSync(filePath)) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Snapshot not found: ${name}. Run state_list to see available snapshots.`,
    );
  }

  unlinkSync(filePath);
  return { success: true, name, deleted: true };
}

/**
 * Inject a published Pine script onto the active chart using its full
 * captured metaInfo + inputs. Tries the documented API entry points in
 * order and validates by counting dataSources before/after, since
 * insertStudy silently returns null on bad input rather than throwing.
 *
 * Returns { success: true, method } on success, or
 * { success: false, reason, hint, tried } on failure. Caller (restore)
 * decides whether to push to skipped[] or applied[].
 */
export async function injectPublishedStudy({ metaInfo, inputs = {}, _deps } = {}) {
  if (!metaInfo || typeof metaInfo !== 'object') {
    return { success: false, reason: 'no_meta_info', hint: 'metaInfo object required' };
  }
  const { evaluate, evaluateAsync } = _resolve(_deps);

  // TRIPWIRE: metaInfo is interpolated into the in-page script below as a JSON
  // literal. JSON.stringify is the injection boundary — it produces a valid JS
  // object literal with all strings safely quoted/escaped. Do NOT "simplify"
  // this to template-string concatenation or any non-JSON serialization: a
  // study name / field containing quotes or `);` would then break out into
  // arbitrary in-page JS. Keep the boundary as JSON — do not "simplify."
  const metaJson = JSON.stringify(metaInfo);
  const inputsJson = JSON.stringify(inputs);

  // Use evaluateAsync because the script is `async` and waits on
  // settle delays + createStudy resolution. evaluate(awaitPromise=false)
  // would return immediately with the Promise object.
  const result = await evaluateAsync(`
    (async function() {
      try {
        var cw = window.TradingViewApi._activeChartWidgetWV.value();
        var meta = ${metaJson};
        var inputs = ${inputsJson};
        // setInputValues wants an array form: [{id, value}, ...]
        var inputsArr = Object.keys(inputs).map(function(id){ return { id: id, value: inputs[id] }; });
        var sources = function() { try { return cw._chartWidget.model().model().dataSources().length; } catch(e) { return 0; } };
        var beforeCount = sources();
        var tried = [];
        var settle = function(ms) { return new Promise(function(r){ setTimeout(r, ms); }); };

        // Find the most recently inserted strategy-bearing source and apply
        // the snapshot inputs to it. Without this the study is on chart but
        // never re-runs because its encoded source input is empty.
        async function applyInputs() {
          if (!inputsArr.length) return;
          try {
            var srcs = cw._chartWidget.model().model().dataSources();
            for (var i = srcs.length - 1; i >= 0; i--) {
              var s = srcs[i];
              if (typeof s.reportData !== 'function') continue;
              var sid = null;
              try { sid = typeof s.id === 'function' ? s.id() : s.id; } catch(e){}
              if (!sid) continue;
              var study = cw.getStudyById(sid);
              if (!study || typeof study.setInputValues !== 'function') continue;
              study.setInputValues(inputsArr);
              await settle(1500);
              return;
            }
          } catch(e) {}
        }

        // Path A: cw.createStudy(meta, ...) — non-string arg goes to _createStudy
        // which calls insertStudy(meta, []). Documented entry point.
        try {
          tried.push('createStudy');
          await cw.createStudy(meta);
          await settle(800);
          if (sources() > beforeCount) {
            await applyInputs();
            return { success: true, method: 'createStudy', delta: sources() - beforeCount };
          }
        } catch(e) { tried.push('createStudy:' + (e.message || String(e)).slice(0, 80)); }

        // Path B: cw._chartWidget.insertStudy(meta, inputsArray) directly.
        // Pass inputs in the array form expected by setInputValues — without
        // them the study is on chart but never computes (encoded Pine source
        // input is a Pine-protected blob and must be present for the script
        // to run its strategy() calls and emit reportData).
        try {
          tried.push('insertStudy');
          var ret = cw._chartWidget.insertStudy(meta, inputsArr);
          if (ret && typeof ret.then === 'function') await ret;
          await settle(800);
          if (sources() > beforeCount) {
            await applyInputs();
            return { success: true, method: 'insertStudy', delta: sources() - beforeCount };
          }
        } catch(e) { tried.push('insertStudy:' + (e.message || String(e)).slice(0, 80)); }

        try {
          tried.push('insertStudyWithoutCheck');
          cw.insertStudyWithoutCheck(meta, inputs, false, [], null);
          await settle(800);
          if (sources() > beforeCount) {
            await applyInputs();
            return { success: true, method: 'insertStudyWithoutCheck', delta: sources() - beforeCount };
          }
        } catch(e) { tried.push('insertStudyWithoutCheck:' + (e.message || String(e)).slice(0, 80)); }

        return { success: false, reason: 'no_path_added_source', tried: tried, sources_before: beforeCount, sources_after: sources() };
      } catch(e) { return { success: false, reason: 'eval_error', error: e.message }; }
    })()
  `);

  if (!result || result.success !== true) {
    return {
      success: false,
      reason: result?.reason || 'unknown',
      hint: 'TradingView did not register a new study after the inject attempts. The captured metaInfo may be from a different TradingView version. Try reloading the layout manually as a fallback.',
      tried: result?.tried,
      error: result?.error,
    };
  }

  // Apply the inputs after creation. The createStudy/insertStudy paths above
  // pass an empty inputs array so the study uses defaults; we set the snapshot's
  // inputs in a follow-up step using the same setInputs we use elsewhere.
  // The caller (restore) handles the inputs separately via chart.manageIndicator
  // pattern; here we just confirm the study is present.
  return { success: true, method: result.method };
}
