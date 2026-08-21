/**
 * Resolving a study when its id is missing.
 *
 * ================= A CORRECTION =================
 *
 * An earlier version of this file stated, as measured fact, that TradingView
 * gives every Pine study its own distinct empty Array as an id. That was
 * WRONG, and the mistake was generalising from a single broken pane without
 * checking a working one. The control, run later the same day on two panes of
 * the same layout:
 *
 *     pane 1 (healthy)   TC-RTA V6  Pine  id "Uqd28X"
 *                        TCPI       Pine  id "rExi1w"
 *     pane 0 (broken)    TC-RTA V6  Pine  id []
 *
 * A healthy Pine study has an ordinary string id, exactly like a built-in.
 * The empty Array is not how Pine is represented. It is DAMAGE: the id is
 * assigned by the server when create_study completes, so a study whose
 * registration never finished has none.
 *
 * That matters because it changes what the right response is. A study with no
 * id is not an addressing inconvenience to work around politely; it is a
 * landmine that destroys its pane's chart session on the next reconnect. See
 * core/session_health.js for the mechanism, the detection and the repair.
 *
 * ================= WHY THIS RESOLVER STILL EXISTS =================
 *
 * getStudyById resolves an id by REFERENCE IDENTITY, so even a damaged handle
 * only works from inside the page: getStudyById([]) with a fresh literal
 * throws "There is no such study", while getStudyById(all[0].id) with the live
 * value works. So when a study HAS lost its id, the only way to reach it at
 * all, including to remove it, is to find its live entry in getAllStudies()
 * here in the page. That is what this resolver does, and it is what lets a
 * damaged study be addressed by name long enough to get rid of it.
 */

/**
 * In-page JS defining `__tvResolveStudy(chart, ref)`.
 *
 * Returns { study, error }. `ref` matches a string id first, then a study name,
 * which is the only handle left for a study whose id was never assigned.
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
