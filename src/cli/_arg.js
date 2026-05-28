/**
 * Tiny CLI argument-validation helper. Throws ClassifiedError(INVALID_ARGUMENT)
 * so the router can route to a structured error payload + non-zero exit code.
 *
 * Usage:
 *   import { _arg } from '../_arg.js';
 *   _arg(positionals[0], 'Symbol required. Usage: tv watchlist add AAPL');
 */
import { ClassifiedError, CATEGORIES } from '../errors.js';

export function _arg(condition, message) {
  if (!condition) {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, message);
  }
}
