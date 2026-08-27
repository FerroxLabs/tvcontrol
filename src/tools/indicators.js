import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/indicators.js';

export function registerIndicatorTools(server) {
  server.tool('indicator_search', 'Search TradingView built-in, community, strategy, and saved-script studies', {
    query: z.string().describe('Search text entered in the TradingView Indicators dialog'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Maximum results to return (default 25, max 100)'),
  }, async ({ query, limit }) => {
    try { return jsonResult(await core.searchStudies({ query, limit })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('indicator_add_from_search', 'Search the TradingView Indicators dialog and add a matching built-in, strategy, community, or saved study', {
    query: z.string().describe('Search query'),
    match: z.string().optional().describe('Exact or partial result title to add (defaults to query)'),
    section: z.string().optional().describe('Optional result section such as Technicals, My scripts, or Community Scripts'),
  }, async ({ query, match, section }) => {
    try { return jsonResult(await core.addStudyFromSearch({ query, match, section })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('indicator_get_inputs', 'Read a study\'s current input values back. Use this to confirm indicator_set_inputs landed, to detect settings changed by hand, or to record the configuration a result was produced under.', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getInputs({ entity_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys are input IDs, values are the new values.'),
  }, async ({ entity_id, inputs }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('indicator_toggle_visibility', 'Show, hide, or flip an indicator on the chart. Omit visible to toggle. Confirms the result by reading the study back rather than trusting setVisible().', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.boolean().optional().describe('true to show, false to hide. OMIT to flip whatever the current state is.'),
  }, async ({ entity_id, visible }) => {
    try { return jsonResult(await core.toggleVisibility({ entity_id, visible })); }
    catch (err) { return errorResult(err); }
  });
}
