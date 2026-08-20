#!/usr/bin/env node
// Push scripts/current.pine → TradingView editor, then compile
//
// TWO SELECTOR BUGS, both found on 2026-08-20, both silent.
//
// SECOND AND WORSE: monacoEnv.editor.getEditors() returns THREE editors, and
// index 0 is a DETACHED instance nothing is bound to. Writing there compiles
// clean, reports "Saved", never bumps the script version, and leaves the chart
// running the old code. Four rounds of edits went into that void. The editor is
// now matched to the visible container by DOM node.
//
// FIRST, and the one that made the second hard to see: TradingView keeps more
// than one `.monaco-editor.pine-editor-monaco` node in the DOM: a collapsed 0x0
// one that was never mounted, and the live one. `querySelector` returns the
// collapsed node first, it carries no React fiber, and every caller then
// concluded "Pine editor closed" while the editor was plainly open on screen.
// Both traversals below now pick the first node with a non-zero bounding box.
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const srcPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

// Inject source
const escaped = JSON.stringify(src);
const set = (await c.Runtime.evaluate({
  expression: `(function(){var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");var c=null;for(var q=0;q<els.length;q++){var rr=els[q].getBoundingClientRect();if(rr.width>0&&rr.height>0){c=els[q];break}}if(!c)return false;var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return false;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();var pick=null;for(var z=0;z<eds.length;z++){var dn=eds[z].getDomNode&&eds[z].getDomNode();if(dn&&(dn===c||c.contains(dn)||dn.contains(c))){pick=eds[z];break}}if(!pick&&eds.length>0)pick=eds[eds.length-1];if(pick){pick.setValue(${escaped});return true}}}cur=cur.return}return false})()`,
  returnByValue: true,
})).result?.value;

if (!set) { console.error('Could not inject into Pine editor'); await c.close(); process.exit(1); }
console.log(`Pushed ${src.split('\n').length} lines → Pine editor`);

// Click compile button
const clicked = (await c.Runtime.evaluate({
  expression: '(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim();if(/save and add to chart/i.test(t)){btns[i].click();return t}if(/^(Add to chart|Update on chart)/i.test(t)){btns[i].click();return t}}for(var i=0;i<btns.length;i++){if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}}return null})()',
  returnByValue: true,
})).result?.value;

console.log('Compile:', clicked || 'keyboard fallback');
if (!clicked) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
}

// Wait then check errors
await new Promise(r => setTimeout(r, 3000));
const errors = (await c.Runtime.evaluate({
  expression: '(function(){var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");var c=null;for(var q=0;q<els.length;q++){var rr=els[q].getBoundingClientRect();if(rr.width>0&&rr.height>0){c=els[q];break}}if(!c)return[];var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return[];var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();var pick=null;for(var z=0;z<eds.length;z++){var dn=eds[z].getDomNode&&eds[z].getDomNode();if(dn&&(dn===c||c.contains(dn)||dn.contains(c))){pick=eds[z];break}}if(!pick&&eds.length>0)pick=eds[eds.length-1];if(pick){var model=pick.getModel();var markers=env.editor.getModelMarkers({resource:model.uri});return markers.map(function(m){return{line:m.startLineNumber,msg:m.message}})}}}cur=cur.return}return[]})()',
  returnByValue: true,
})).result?.value || [];

if (errors.length === 0) {
  console.log('✅ Compiled clean — 0 errors');
} else {
  console.log(`❌ ${errors.length} errors:`);
  errors.forEach(e => console.log(`  Line ${e.line}: ${e.msg}`));
}

await c.close();
