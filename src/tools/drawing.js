import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/drawing.js';

export function registerDrawingTools(server) {
  server.tool('draw_shape', 'Draw a shape/line on the chart', {
    shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, text'),
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('{ time: unix_timestamp, price: number }'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for text shapes'),
  }, async ({ shape, point, point2, overrides, text }) => {
    try { return jsonResult(await core.drawShape({ shape, point, point2, overrides, text })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('draw_list', 'List shapes/drawings on the ACTIVE PANE ONLY. On a multi-pane layout the other panes are not included and a count of 0 does NOT mean the chart is empty: use pane_list to see every pane and pane_focus to switch.', {}, async () => {
    try { return jsonResult(await core.listDrawings()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('draw_clear', 'Remove ALL drawings from the ACTIVE PANE. On a multi-pane layout this is NOT the whole chart: use pane_list to see the panes and pane_focus to pick one first. DESTRUCTIVE and there is no undo through this API: every trendline, level and annotation on the active chart is deleted, not just ones you added. Use draw_remove_one with an entity_id to remove a single drawing.', {}, async () => {
    try { return jsonResult(await core.clearAll()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('draw_remove_one', 'Remove a specific drawing by entity ID', {
    entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.removeOne({ entity_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('draw_get_properties', 'Get properties and points of a specific drawing', {
    entity_id: z.string().describe('Entity ID of the drawing (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getProperties({ entity_id })); }
    catch (err) { return errorResult(err); }
  });
}
