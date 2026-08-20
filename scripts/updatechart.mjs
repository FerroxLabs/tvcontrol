import CDP from 'chrome-remote-interface';
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(x => x.url?.includes('tradingview.com/chart'));
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();
const expr = `(function(){
  var all=document.querySelectorAll("button,[role=button]");
  for (var i=0;i<all.length;i++){
    var b=all[i], r=b.getBoundingClientRect();
    if (r.width===0||r.height===0) continue;
    var ti=(b.getAttribute("title")||"");
    if (/update on chart|add to chart/i.test(ti)){
      b.click();
      return {clicked:true, title:ti, x:Math.round(r.x), y:Math.round(r.y)};
    }
  }
  return {clicked:false};
})()`;
const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value));
await c.close();
