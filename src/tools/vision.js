import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import { chartVisionRead } from '../core/vision.js';

export function registerVisionTools(server) {
  // Naming note: chart_vision_read uses noun_noun_<verb> instead of the
  // typical chart_get_X. "vision" disambiguates this multi-section read from
  // single-purpose chart_get_state / data_get_*. Kept noun-first for grouping
  // with other chart_* tools in MCP client UIs. Not renaming — breaking
  // change to MCP client configs.
  server.tool(
    'chart_vision_read',
    'Take a screenshot and read all chart data in one call (quote, indicators, Pine graphics, OHLCV). Returns mixed content: inline image when <= max_image_bytes, else file_path only.',
    {
      include: z.array(z.string()).optional().describe(
        'Sections to include: image, quote, study_values, pine_lines, pine_labels, pine_tables, pine_boxes, ohlcv_summary, state. Default: all.'
      ),
      study_filter: z.string().optional().describe('Filter Pine graphics by indicator name substring.'),
      max_image_bytes: z.coerce.number().optional().describe('Max bytes for inline image. Default 1500000 (1.5MB). Exceeded → file_only mode.'),
    },
    async ({ include, study_filter, max_image_bytes }) => {
      try {
        const data = await chartVisionRead({ include, study_filter, max_image_bytes });

        const { image_base64, mime_type, ...rest } = data;

        if (data.image_mode === 'inline' && image_base64) {
          return {
            content: [
              { type: 'image', data: image_base64, mimeType: mime_type },
              { type: 'text', text: JSON.stringify({ ...rest, mime_type }, null, 2) },
            ],
          };
        }

        return jsonResult({ ...rest, mime_type });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
