/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  let overrides;
  try {
    overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  } catch (err) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `overrides is not valid JSON: ${err.message}`,
      { hint: 'Pass overrides as a JSON object or a JSON-encoded object string.' },
    );
  }
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  if (point2) {
    const p2time = requireFinite(point2.time, 'point2.time');
    const p2price = requireFinite(point2.price, 'point2.price');
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [{ time: ${p1time}, price: ${p1price} }, { time: ${p2time}, price: ${p2price} }],
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${p1time}, price: ${p1price} },
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id)) || null;
  const result = { entity_id: newId };
  return { success: true, shape, entity_id: result?.entity_id };
}

export async function listDrawings({ _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id, _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id, _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new ClassifiedError(CATEGORIES.TV_UI_CHANGED, result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll({ _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();

  // THE MOST DESTRUCTIVE TOOL IN THE SET RETURNED A HARDCODED SUCCESS.
  // It called removeAllShapes() and returned { success: true } without ever
  // looking. If the call threw inside the page, or the API path resolved to a
  // detached widget, or nothing was there to begin with, the answer was
  // identical: "all_shapes_removed". For an irreversible operation on a
  // trader's annotations that is the worst possible place to guess.
  //
  // Count before, count after, and report what actually happened.
  const before = await evaluate(`
    (function() {
      try { return ${apiPath}.getAllShapes().length; } catch (e) { return -1; }
    })()
  `);
  if (before === -1) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      'Could not count the drawings on the chart, so nothing was removed rather than deleting blind',
      { hint: 'Run tv_health_check and confirm the chart has finished loading.' },
    );
  }
  if (before === 0) {
    return { success: true, action: 'nothing_to_remove', removed_count: 0, remaining: 0 };
  }

  await evaluate(`${apiPath}.removeAllShapes()`);

  const after = await evaluate(`
    (function() {
      try { return ${apiPath}.getAllShapes().length; } catch (e) { return -1; }
    })()
  `);
  if (after === -1) {
    throw new ClassifiedError(
      CATEGORIES.TV_UI_CHANGED,
      `removeAllShapes() was called on ${before} drawing(s) but the result could not be read back, so the outcome is unconfirmed`,
      { hint: 'Call draw_list to see the true current state.' },
    );
  }
  if (after > 0) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `removeAllShapes() was accepted but ${after} of ${before} drawing(s) are still on the chart`,
      { hint: 'Retry once, or remove the remainder individually with draw_remove_one.' },
    );
  }
  return { success: true, action: 'all_shapes_removed', removed_count: before, remaining: 0, verified: true };
}
