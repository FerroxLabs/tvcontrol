/**
 * Shared MCP response formatting helpers.
 * All tool files use these instead of manually constructing MCP responses.
 */
import { toErrorPayload } from '../errors.js';
import { record } from '../core/telemetry.js';

/**
 * Wrap a plain result object as an MCP text-content response.
 * Pass `isError: true` for error states (sets the MCP isError flag).
 */
export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Surface a thrown error as an MCP isError response with category + hint.
 * Preferred over `jsonResult({ success: false, error: err.message }, true)`
 * because ClassifiedError instances keep their category and hint.
 *
 *   try { return jsonResult(await core.fn(...)); }
 *   catch (err) { return errorResult(err); }
 */
export function errorResult(err) {
  return jsonResult(toErrorPayload(err), true);
}

/**
 * Wrap a tool handler function with optional telemetry recording.
 * Opt-in — existing callers are unaffected. Usage:
 *
 *   export const myTool = instrument('my_tool', async (args) => { ... });
 */
export function instrument(toolName, fn) {
  return async (...args) => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      record({ tool: toolName, success: !result?.isError, duration_ms: Date.now() - start });
      return result;
    } catch (err) {
      record({
        tool: toolName, success: false, duration_ms: Date.now() - start,
        error: err.message, category: err.category,
      });
      throw err;
    }
  };
}
