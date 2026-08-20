// Read the LIVE Pine editor's buffer.
//
// THE SELECTOR BUG THIS FIXES. TradingView keeps more than one
// `.monaco-editor.pine-editor-monaco` node in the DOM: a collapsed 0x0 one that
// is never mounted, and the real one. `document.querySelector` returns the
// collapsed one first, which has no React fiber, so every traversal reported
// "no fiber" and callers concluded the editor was closed. Pick by geometry.
import CDP from 'chrome-remote-interface';
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(x => x.url?.includes('tradingview.com'));
if (!t) { console.log(JSON.stringify({ err: 'no tradingview target' })); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();
const expr = `(function(){
  var els = document.querySelectorAll(".monaco-editor.pine-editor-monaco");
  var cont = null;
  for (var i=0;i<els.length;i++){
    var r = els[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0){ cont = els[i]; break }
  }
  if (!cont) return {err:"no visible pine editor", candidates: els.length};
  var el = cont, fk;
  for (var i=0;i<30;i++){
    if(!el) break;
    fk = Object.getOwnPropertyNames(el).find(function(k){return k.indexOf("__reactFiber")===0});
    if(fk) break;
    el = el.parentElement;
  }
  if (!fk) return {err:"no fiber on the visible editor"};
  var cur = el[fk];
  for (var d=0; d<25; d++){
    if(!cur) break;
    var p = cur.memoizedProps;
    if (p && p.value && p.value.monacoEnv){
      var env = p.value.monacoEnv;
      if (env.editor && typeof env.editor.getEditors === "function"){
        var eds = env.editor.getEditors();
        if (eds.length){
          var ed = eds[0], v = ed.getValue();
          return {lines: v.split("\\n").length,
                  readOnly: !!(ed.getRawOptions && ed.getRawOptions().readOnly),
                  hasSweep: v.indexOf("showSweep") >= 0,
                  hasSell: v.indexOf("'SELL'") >= 0,
                  alertCalls: (v.match(/alertcondition\\(/g)||[]).length,
                  head: v.split("\\n").slice(0,3)};
        }
      }
    }
    cur = cur.return;
  }
  return {err:"no editor env"};
})()`;
const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 1));
await c.close();
