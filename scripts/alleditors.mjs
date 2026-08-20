import CDP from 'chrome-remote-interface';
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(x => x.url?.includes('tradingview.com/chart'));
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();
const expr = `(function(){
  var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");
  var out=[];
  for (var i=0;i<els.length;i++){
    var e=els[i], r=e.getBoundingClientRect();
    var rec={i:i, w:Math.round(r.width), h:Math.round(r.height)};
    var el=e, fk;
    for (var d=0;d<30;d++){ if(!el)break;
      fk=Object.getOwnPropertyNames(el).find(function(k){return k.indexOf("__reactFiber")===0});
      if(fk)break; el=el.parentElement }
    if(!fk){ rec.err="no fiber"; out.push(rec); continue }
    var cur=el[fk];
    for (var d=0;d<25;d++){
      if(!cur)break;
      var p=cur.memoizedProps;
      if(p&&p.value&&p.value.monacoEnv){
        var env=p.value.monacoEnv;
        if(env.editor&&typeof env.editor.getEditors==="function"){
          var eds=env.editor.getEditors();
          rec.editorCount=eds.length;
          rec.buffers=eds.map(function(ed){var v=ed.getValue();
            return {lines:v.split("\\n").length, sweep:v.indexOf("showSweep")>=0}});
          break;
        }
      }
      cur=cur.return;
    }
    out.push(rec);
  }
  return out;
})()`;
const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 1));
await c.close();
