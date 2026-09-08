// Research only. Executes pinned upstream source, not look-alike implementations.
// Run with an owned acquisition root containing the source files in the dossier.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const root=process.argv[2];
assert.match(root,/^\/private\/tmp\/control-room-f3\.[A-Za-z0-9]+$/);
const pins={
  'chatRuns.ts':'87bd21df4b23ccbc0494c5e95ae4f0db2cdfa92adfb48a3a39b03d78077993c9',
  'ActiveSessionsBar.tsx':'61eea6c02fbc832136c5b50cd30d785a1ff774989adb29a0af8be4eb30f736c8',
  'sessions.js':'598be491bc0a4309d6cacfc04b7b15a0aec192569e7098f2a8cc68c835bfbcb3',
};
const read=name=>{const source=fs.readFileSync(`${root}/${name}`,'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),pins[name]);return source;};
function moduleFrom(source, overrides={}) {
  // This is NOT a security sandbox: ordinary require is available. Review every
  // upgraded source/dependency before executing. VM timeout bounds initialization
  // only, not exported functions or callbacks invoked below.
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context={exports:{},require:name=>overrides[name]??require(name),crypto:globalThis.crypto};
  vm.runInNewContext(output,context,{timeout:1000}); return context.exports;
}
const checks=[];
const runs=moduleFrom(read('chatRuns.ts'));
const a={runId:'project-a:run-a',connectionId:'machine-a',profile:'hermes',sessionId:'same',loading:true,title:'Project A'};
const b={...a,runId:'project-b:run-b',connectionId:'machine-b',title:'Project B'};
assert.equal(runs.findRunByLocation([a,b],{connectionId:'machine-b',profile:'hermes',sessionId:'same'}).runId,b.runId);
checks.push('Desktop exact machine/profile/session lookup separates identical session IDs');
assert.equal(runs.cycleRunId([a,b],b.runId,1),a.runId);
assert.equal(runs.runIdAtOrdinal([a,b],9),b.runId);
checks.push('Desktop actual keyboard-selection helpers wrap and select last');
const duplicate=runs.openSessionRunTransition([a],a.runId,{...a,runId:'another-view'});
assert.equal(duplicate.runs.length,2);
checks.push('Desktop open transition alone retains duplicate native session views: caller must deduplicate');
assert.equal(runs.loadingSessionIds([a,b]).size,1);
checks.push('Desktop loadingSessionIds collapses same IDs across machines: cannot adopt unqualified');
// Only decorative dependencies/translation replaced; exact ActiveSessionsBar body executes.
const decoration=()=>null;
const bar=moduleFrom(read('ActiveSessionsBar.tsx'),{
  '../../assets/icons':{X:decoration,Plus:decoration},
  '../../components/OrbLoader':{OrbLoader:decoration},
  '../../components/useI18n':{useI18n:()=>({t:key=>key})},
  '../../components/common/ProfileAvatar':{default:decoration},
}).ActiveSessionsBar;
let closed=null;let stoppedPropagation=false;
const props={runs:[a,b],activeRunId:a.runId,onSelect:()=>{},onClose:id=>{closed=id;},onNew:()=>{}};
const html=renderToStaticMarkup(React.createElement(bar,props));
assert.equal((html.match(/role="tab"/g)||[]).length,2);
// Added after independent review; not executed since the source root was cleaned.
assert.match(html,/Project A/);
assert.match(html,/Project B/);
assert.ok(!html.includes('tabindex'));
const tree=bar.type(props);
const firstChip=tree.props.children[0][0];
firstChip.props.children[2].props.onClick({stopPropagation(){stoppedPropagation=true;}});
assert.equal(closed,a.runId);assert.equal(stoppedPropagation,true);assert.equal(a.loading,true);
assert.ok(!renderToStaticMarkup(React.createElement(bar,{...props,runs:[]})).includes('Project A'));
checks.push('Desktop exact component renders project labels; close only invokes supplied callback; empty props remove labels; keyboard focus absent');
// Extract exact top-level function AST nodes. No rewrite of selected WebUI logic.
const selected=['_profileMatchesActiveProfile','_sessionEventProfilesMatch','_isSessionLocallyStreaming','_isSessionEffectivelyStreaming','_hasPendingUserMessageSignal','_isServerIdleSessionRow'];
const file=ts.createSourceFile('sessions.js',read('sessions.js'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const fragments=file.statements.filter(n=>ts.isFunctionDeclaration(n)&&selected.includes(n.name?.text)).map(n=>n.getText(file));
assert.equal(fragments.length,selected.length);
const state={session:{session_id:'same'},busy:false};
const web={S:state,INFLIGHT:{other:{stale:true}}};
vm.createContext(web);vm.runInContext(fragments.join('\n'),web,{timeout:1000});
assert.equal(web._isSessionLocallyStreaming({session_id:'other'}),false);
state.busy=true;assert.equal(web._isSessionLocallyStreaming({session_id:'same'}),true);
assert.equal(web._isSessionEffectivelyStreaming({session_id:'other',is_streaming:true}),true);
assert.equal(web._isServerIdleSessionRow({session_id:'same',pending_user_message:true}),false);
checks.push('WebUI actual stream helpers ignore stale background INFLIGHT and honor server/pending indicators');
// Explicit mismatch: upstream assumes one session namespace, not our multi-host/project catalog.
assert.equal(web._isSessionLocallyStreaming({session_id:'same',machine:'machine-b',project:'project-b'}),true);
checks.push('WebUI stream identity ignores machine/project: adapter needs composite identity');
state.session=null;state.busy=false;
assert.equal(Boolean(web._isSessionLocallyStreaming({session_id:'same'})),false);
checks.push('WebUI selected helpers stop local busy indication after caller clears session; full logout cache not qualified');
console.log(JSON.stringify({checks,checkCount:checks.length,scope:'actual selected source with synthetic inputs; React static rendering, not browser mount; decorative dependencies substituted; no protected API call or live agent',rssKiB:Math.round(process.memoryUsage().rss/1024)},null,2));
