import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the current chart using TradingView\'s authenticated alert API', {
    condition: z.string().describe('Condition: crossing, greater_than, or less_than'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
    mobile_push: z.coerce.boolean().optional().default(true).describe('Enable TradingView mobile push notification'),
    expiration_days: z.coerce.number().int().min(1).max(365).optional().default(30).describe('Days until expiration'),
    frequency: z.enum(['on_first_fire', 'on_bar_close']).optional().default('on_first_fire')
      .describe('on_first_fire fires once then deactivates. on_bar_close fires on every bar close where the condition holds, which is what you want for a level you keep watching. These are the only two values the API accepts (verified live).'),
    resolution: z.string().optional().default('1')
      .describe('Series the condition is evaluated on: minutes as a bare number (1, 5, 15, 60, 240) or D, W, M. Must match the timeframe you actually trade.'),
  }, async ({ condition, price, message, mobile_push, expiration_days, frequency, resolution }) => {
    try { return jsonResult(await core.create({ condition, price, message, mobile_push, expiration_days, frequency, resolution })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
    alert_id: z.union([z.string(), z.number()]).optional().describe('One alert ID to delete'),
    alert_ids: z.array(z.union([z.string(), z.number()])).max(100).optional().describe('Several alert IDs to delete'),
  }, async ({ delete_all, alert_id, alert_ids }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all, alert_id, alert_ids })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('alert_delete_by_id', 'Delete a single alert by ID', {
    alert_id: z.string().describe('Alert ID from alert_list'),
  }, async ({ alert_id }) => {
    try { return jsonResult(await core.deleteById({ alert_id })); }
    catch (err) { return errorResult(err); }
  });
}
