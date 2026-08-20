// Focus the LIVE Pine editor, then send the platform save chord.
// Focusing first matters: the same chord saves the CHART LAYOUT when focus is
// anywhere else, which looks like success and changes nothing about the script.
import CDP from 'chrome-remote-interface';
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(x => x.url?.includes('tradingview.com'));
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const focused = (await c.Runtime.evaluate({
  expression: `(function(){
    var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");
    for (var i=0;i<els.length;i++){
      var r=els[i].getBoundingClientRect();
      if (r.width>0 && r.height>0){
        var ta = els[i].querySelector("textarea");
        if (ta){ ta.focus(); return {ok:true, x:Math.round(r.x+r.width/2), y:Math.round(r.y+40)} }
        els[i].click(); return {ok:true, clicked:true};
      }
    }
    return {ok:false};
  })()`, returnByValue: true })).result.value;
console.log('focus:', JSON.stringify(focused));
if (!focused.ok) { await c.close(); process.exit(1); }

for (const type of ['keyDown', 'keyUp']) {
  await c.Input.dispatchKeyEvent({
    type, modifiers: 4, key: 's', code: 'KeyS',
    windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83,
    commands: type === 'keyDown' ? [] : undefined,
  });
}
await new Promise(r => setTimeout(r, 2500));
console.log('save chord sent');
await c.close();
