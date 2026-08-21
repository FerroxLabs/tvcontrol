/**
 * Resolving a study by reference, because Pine studies have no id.
 *
 * MEASURED 2026-08-21 against TradingView Desktop:
 *
 *   getAllStudies() -> [ { name: 'TC-RTA V6',  id: [] },
 *                        { name: 'sweep probe', id: [] },
 *                        { name: 'Volume',      id: 'T4x6LH' } ]
 *
 * A built-in study gets a real string id. A Pine study gets an empty Array,
 * and every Pine study gets its OWN empty Array:
 *
 *   all[0].id === all[1].id                       -> false
 *   getAllStudies()[0].id === all[0].id           -> true   (stable per study)
 *   getStudyById(all[0].id)                       -> the study, 67 inputs
 *   getStudyById([])                              -> throws "There is no such study"
 *
 * So getStudyById resolves that id by REFERENCE IDENTITY. The id is not data,
 * it is a handle, and a handle cannot cross the CDP boundary: anything that
 * serializes it produces `[]`, which resolves to nothing.
 *
 * chart_get_state was returning that `[]` to callers as `entity_id`, and four
 * tools take an entity_id string and call getStudyById with it. For a Pine
 * study every one of them was unreachable, on a product whose users keep their
 * work in Pine. The dataSource route is no better: for Pine, `src.id()` returns
 * the empty string, so state.js's dsById map never contained a single Pine
 * study and its metaInfo capture silently produced nothing.
 *
 * The only place the reference still exists is the page. So resolve there:
 * find the live entry in getAllStudies() and hand ITS id straight back to
 * getStudyById without it ever being serialized.
 */

/**
 * In-page JS defining `__tvResolveStudy(chart, ref)`.
 *
 * Returns { study, error }. `ref` matches a string id first, then a study name.
 * An ambiguous name is refused rather than guessed: picking one of two studies
 * called the same thing is how the wrong indicator gets its inputs rewritten.
 *
 * Paste into an evaluate() template before the call site. Contains no
 * backticks and no bare newline escapes, so it is safe inside a template
 * literal (a bare \n there becomes a real newline before the page ever sees
 * the string, which has broken this codebase three times).
 */
export function STUDY_RESOLVER_JS() {
  return `
    function __tvResolveStudy(chart, ref) {
      var all;
      try { all = chart.getAllStudies(); } catch (e) {
        return { study: null, error: 'could not enumerate studies: ' + e.message };
      }
      var byId = [];
      var byName = [];
      for (var i = 0; i < all.length; i++) {
        var s = all[i];
        if (typeof s.id === 'string' && s.id.length > 0 && s.id === ref) byId.push(s);
        else if (s.name === ref) byName.push(s);
      }
      var hits = byId.length > 0 ? byId : byName;
      if (hits.length === 0) {
        var names = [];
        for (var j = 0; j < all.length; j++) {
          names.push(all[j].name + (typeof all[j].id === 'string' && all[j].id ? ' [' + all[j].id + ']' : ' [no id: Pine, address it by name]'));
        }
        return { study: null, error: 'no study matched ' + JSON.stringify(ref) + '. On this chart: ' + names.join(', ') };
      }
      if (hits.length > 1) {
        return { study: null, error: hits.length + ' studies are named ' + JSON.stringify(ref) + '. Rename one, or remove the duplicate, so the target is unambiguous.' };
      }
      try {
        // handle is the LIVE id reference. Usable in the page (removeEntity
        // takes it), meaningless the moment it is serialized.
        return { study: chart.getStudyById(hits[0].id), handle: hits[0].id, error: null, resolved_name: hits[0].name };
      } catch (e) {
        return { study: null, error: 'getStudyById failed for ' + JSON.stringify(ref) + ': ' + e.message };
      }
    }
  `;
}

/**
 * True when a value from getAllStudies() is an id a caller can actually use
 * again. Anything else (the empty Array Pine gets) is a handle, not an id.
 */
export function isUsableStudyId(id) {
  return typeof id === 'string' && id.length > 0;
}
