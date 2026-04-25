/**
 * Classified error taxonomy for tradingview-mcp.
 *
 * Every known failure mode gets a category + default remediation hint. Tools
 * that catch a ClassifiedError surface the category and hint back to Claude /
 * the CLI, so agents can self-heal without re-parsing free-form error strings.
 *
 * 10 categories. Do not add new ones without updating this file AND the brief.
 */

export const CATEGORIES = Object.freeze({
  TV_NOT_RUNNING: 'tv_not_running',
  CDP_DISCONNECTED: 'cdp_disconnected',
  CHART_LOADING: 'chart_loading',
  PINE_EDITOR_CLOSED: 'pine_editor_closed',
  STUDY_NOT_FOUND: 'study_not_found',
  SYMBOL_UNKNOWN: 'symbol_unknown',
  REPLAY_NOT_STARTED: 'replay_not_started',
  TV_UI_CHANGED: 'tv_ui_changed',
  SNAPSHOT_INCOMPLETE: 'snapshot_incomplete',
  INVALID_ARGUMENT: 'invalid_argument',
  API_UNEXPECTED: 'api_unexpected',
});

/**
 * Default hints per category. Callers can override via options.hint.
 */
export const DEFAULT_HINTS = Object.freeze({
  [CATEGORIES.TV_NOT_RUNNING]:
    'Launch TradingView Desktop with --remote-debugging-port=9222 (or run scripts/launch_tv_debug_*.sh).',
  [CATEGORIES.CDP_DISCONNECTED]:
    'The CDP connection dropped mid-session. Retry, or restart TradingView.',
  [CATEGORIES.CHART_LOADING]:
    'The chart was still loading. Wait ~2 seconds and retry.',
  [CATEGORIES.PINE_EDITOR_CLOSED]:
    'Open the Pine Editor first: ui_open_panel({ panel: "pine-editor", action: "open" }).',
  [CATEGORIES.STUDY_NOT_FOUND]:
    'The entity_id is stale or invalid. Call chart_get_state to refresh study IDs.',
  [CATEGORIES.SYMBOL_UNKNOWN]:
    'TradingView did not resolve that symbol. Try symbol_search to find the full ticker.',
  [CATEGORIES.REPLAY_NOT_STARTED]:
    'Call replay_start with a date before using replay operations.',
  [CATEGORIES.TV_UI_CHANGED]:
    'A DOM selector failed after multiple fallbacks. TradingView may have updated; file an issue.',
  [CATEGORIES.SNAPSHOT_INCOMPLETE]:
    'Some fields could not be restored. Check the `skipped` array in the response for details.',
  [CATEGORIES.INVALID_ARGUMENT]:
    'The tool received an argument it could not use (bad shape, out of range, or unsafe value). Check the error message.',
  [CATEGORIES.API_UNEXPECTED]:
    'A TradingView internal API returned an unexpected shape. Include the raw output when filing an issue.',
});

const VALID_CATEGORIES = new Set(Object.values(CATEGORIES));

/**
 * Classified error with a category, remediation hint, and optional cause.
 *
 *   throw new ClassifiedError(CATEGORIES.TV_NOT_RUNNING, 'ECONNREFUSED on :9222');
 *   throw new ClassifiedError(CATEGORIES.STUDY_NOT_FOUND, msg, { cause: err, hint: 'custom hint' });
 */
export class ClassifiedError extends Error {
  constructor(category, message, options = {}) {
    if (!VALID_CATEGORIES.has(category)) {
      throw new Error(`Unknown error category: ${category}. Valid: ${[...VALID_CATEGORIES].join(', ')}`);
    }
    super(message);
    this.name = 'ClassifiedError';
    this.category = category;
    this.hint = options.hint || DEFAULT_HINTS[category];
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /**
   * Serialize to the response shape tools surface.
   */
  toJSON() {
    return {
      success: false,
      error: this.message,
      category: this.category,
      hint: this.hint,
    };
  }
}

/**
 * Type guard — true if the error is a ClassifiedError.
 */
export function isClassified(err) {
  return err instanceof ClassifiedError;
}

/**
 * Normalize any thrown value into the classified-response shape.
 * Non-classified errors get `category: 'api_unexpected'` by default,
 * preserving their original message as-is.
 */
export function toErrorPayload(err) {
  if (err instanceof ClassifiedError) return err.toJSON();
  const message = err?.message ?? String(err);
  return {
    success: false,
    error: message,
    category: CATEGORIES.API_UNEXPECTED,
    hint: DEFAULT_HINTS[CATEGORIES.API_UNEXPECTED],
  };
}
