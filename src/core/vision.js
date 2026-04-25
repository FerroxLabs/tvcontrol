/**
 * Core vision logic — screenshot + all chart readings in one call.
 */
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { captureScreenshot } from './capture.js';
import { getState } from './chart.js';
import { getQuote, getStudyValues, getPineLines, getPineLabels, getPineTables, getPineBoxes, getOhlcv } from './data.js';
import { strictResolve } from './_resolve.js';

const _VISION_DEPS = new Set([
  'captureScreenshot', 'getState', 'getQuote', 'getStudyValues',
  'getPineLines', 'getPineLabels', 'getPineTables', 'getPineBoxes', 'getOhlcv',
]);

const ALL_SECTIONS = ['image', 'quote', 'study_values', 'pine_lines', 'pine_labels', 'pine_tables', 'pine_boxes', 'ohlcv_summary', 'state'];
const DEFAULT_MAX_IMAGE_BYTES = 1_500_000;
const VISION_DIR = join(homedir(), '.tv-mcp', 'screenshots');

function _resolve(deps) {
  strictResolve(deps, _VISION_DEPS);
  return {
    captureScreenshot: deps?.captureScreenshot ?? captureScreenshot,
    getState:          deps?.getState          ?? getState,
    getQuote:          deps?.getQuote          ?? getQuote,
    getStudyValues:    deps?.getStudyValues    ?? getStudyValues,
    getPineLines:      deps?.getPineLines      ?? getPineLines,
    getPineLabels:     deps?.getPineLabels     ?? getPineLabels,
    getPineTables:     deps?.getPineTables     ?? getPineTables,
    getPineBoxes:      deps?.getPineBoxes      ?? getPineBoxes,
    getOhlcv:          deps?.getOhlcv          ?? getOhlcv,
  };
}

export async function chartVisionRead({ include, study_filter, max_image_bytes, _deps } = {}) {
  const sections = include || ALL_SECTIONS;
  const maxBytes = max_image_bytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const warnings = [];
  const impls = _resolve(_deps);

  let file_path = null;
  let image_base64 = undefined;
  let image_size_bytes = 0;
  // 'unavailable' = image was requested but capture failed (caller can branch);
  // 'skipped'    = image was not in `include` so we did not even try;
  // 'file_only'  = captured to disk, too large to inline;
  // 'inline'     = captured + inlined under maxBytes.
  let image_mode = sections.includes('image') ? 'file_only' : 'skipped';

  // Skip the screenshot CDP roundtrip + disk write entirely when 'image' is
  // not in include — saves ~150-400ms per call. Was always taken before
  // (lens C MEDIUM finding).
  if (sections.includes('image')) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `vision-${ts}`;
    mkdirSync(VISION_DIR, { recursive: true });

    try {
      const shot = await impls.captureScreenshot({ region: 'chart', method: 'cdp', filename: fname });
      file_path = shot.file_path;
    } catch (err) {
      warnings.push({ section: 'image', error: err.message });
      image_mode = 'unavailable';
    }

    if (file_path) {
      try {
        const bytes = readFileSync(file_path);
        image_size_bytes = bytes.length;
        if (bytes.length <= maxBytes) {
          image_base64 = bytes.toString('base64');
          image_mode = 'inline';
        } else {
          image_mode = 'file_only';
        }
      } catch (err) {
        warnings.push({ section: 'image_read', error: err.message });
        image_mode = 'unavailable';
      }
    }
  }

  // --- Per-section best-effort reads ---
  const result = {
    success: true,
    image_mode,
    image_size_bytes,
    file_path,
    mime_type: 'image/png',
  };

  if (image_mode === 'inline') result.image_base64 = image_base64;

  // Each section is independent — fan out in parallel. Per-section try/catch
  // keeps one failure from cancelling siblings (Promise.all() resolves because
  // each task swallows its own error into `warnings`).
  //
  // On failure we ALSO write a structured stub to result[section]:
  //   { success: false, error: <msg>, category: <category> }
  // so callers can distinguish "section not requested" (key absent) from
  // "section requested but crashed" (key present, success:false). The
  // legacy warnings[] array stays so existing callers continue to work.
  const tasks = [];
  const run = (section, fn) => {
    if (!sections.includes(section)) return;
    tasks.push((async () => {
      try { await fn(); }
      catch (err) {
        warnings.push({ section, error: err.message });
        result[section] = {
          success: false,
          error: err.message,
          ...(err.category && { category: err.category }),
          ...(err.hint && { hint: err.hint }),
        };
      }
    })());
  };

  run('state', async () => {
    const s = await impls.getState();
    result.state = { symbol: s.symbol, resolution: s.resolution, chart_type: s.chartType, studies: s.studies };
  });
  run('quote',         async () => { result.quote         = await impls.getQuote(); });
  run('study_values',  async () => { result.study_values  = await impls.getStudyValues(); });
  run('pine_lines',    async () => { result.pine_lines    = await impls.getPineLines({ study_filter }); });
  run('pine_labels',   async () => { result.pine_labels   = await impls.getPineLabels({ study_filter }); });
  run('pine_tables',   async () => { result.pine_tables   = await impls.getPineTables({ study_filter }); });
  run('pine_boxes',    async () => { result.pine_boxes    = await impls.getPineBoxes({ study_filter }); });
  run('ohlcv_summary', async () => { result.ohlcv_summary = await impls.getOhlcv({ summary: true }); });

  await Promise.all(tasks);

  result.warnings = warnings;
  return result;
}
