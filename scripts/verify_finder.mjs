// Run the NEW FIND_MONACO from src/core/pine.js against the live page and prove
// it resolves the editor the old one missed.
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../src/core/pine.js', import.meta.url).pathname, 'utf-8');
const m = src.match(/const FIND_MONACO = `([\s\S]*?)`;/);
if (!m) { console.log('could not extract FIND_MONACO'); process.exit(1); }
const finder = m[1];

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(x => x.url?.includes('tradingview.com/chart'));
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const expr = `(function(){
  var found = ${finder};
  if (!found) return {resolved:false};
  var v = found.editor.getValue();
  return {resolved:true, lines: v.split("\\n").length,
          hasSweep: v.indexOf("showSweep") >= 0,
          hasSell: v.indexOf("'SELL'") >= 0};
})()`;
const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
console.log('NEW finder ->', JSON.stringify(r.result.value));

// and the OLD logic, for the comparison
const oldExpr = `(function(){
  var container = document.querySelector('.monaco-editor.pine-editor-monaco');
  if (!container) return {resolved:false, why:'querySelector picked a node'};
  var el = container, fiberKey;
  for (var i=0;i<20;i++){ if(!el)break;
    fiberKey = Object.keys(el).find(function(k){return k.startsWith('__reactFiber$')});
    if(fiberKey)break; el = el.parentElement }
  if (!fiberKey) return {resolved:false, why:'no fiber on the node querySelector picked'};
  return {resolved:true};
})()`;
const r2 = await c.Runtime.evaluate({ expression: oldExpr, returnByValue: true });
console.log('OLD finder ->', JSON.stringify(r2.result.value));
await c.close();
