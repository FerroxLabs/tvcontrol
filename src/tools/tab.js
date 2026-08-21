import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tab_new', 'Open a new TradingView tab, optionally loading a saved layout', {
    layout: z.string().optional().describe('Saved layout name or "new" for a blank chart'),
    name: z.string().optional().describe('Symbol name to enter when layout is "new"'),
  }, async ({ layout, name }) => {
    try { return jsonResult(await core.newTab({ layout, name })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tab_close', 'Close the currently active chart tab. Names the tab it is about to close and refuses when no tab is marked active. Closing a chart tab cannot be undone through this API, so pass expect_title when it matters which one goes.', {
    expect_title: z.string().optional().describe('The active tab title must contain this, otherwise nothing is closed. Use tab_list first to see the titles.'),
  }, async ({ expect_title }) => {
    try { return jsonResult(await core.closeTab({ expect_title })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return errorResult(err); }
  });
}
