// Negative pre-import fixtures only; restore exact downloaded bytes after each.
import {readFileSync,writeFileSync,unlinkSync,renameSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [root,python]=process.argv.slice(2);
assert.match(root,/^\/private\/tmp\/control-room-f2router\.[A-Za-z0-9]+$/);
const tree=`${root}/openai_codex`,model=`${tree}/models.py`,original=readFileSync(model);
const results=[];
function run(name,expected){const r=spawnSync(python,['-O','research/reuse-comparisons/f2-router-fit.py',root,'--verify-only'],{encoding:'utf8',timeout:5000});assert.equal(r.signal,null);assert.equal(r.error,undefined);if(expected){assert.notEqual(r.status,0);assert.match(r.stderr,new RegExp(expected));assert.equal(r.stdout,'');}else{assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).candidateImports,0);}results.push({name,exitCode:r.status,expectedRejection:expected??null});}
run('valid exact tree optimized Python',null);
const init=`${tree}/__init__.py`;
try{writeFileSync(init,'raise RuntimeError("initializer must never execute")\n');run('extra initializer rejected before import','exact source set invalid');}finally{unlinkSync(init);}
try{writeFileSync(model,Buffer.concat([original,Buffer.from('\n# synthetic hash mutation\n')]));run('changed hash rejected before import','source hash invalid');}finally{writeFileSync(model,original);}
try{renameSync(model,`${root}/saved-model.py`);run('missing source rejected before import','exact source set invalid');}finally{renameSync(`${root}/saved-model.py`,model);}
try{renameSync(model,`${root}/saved-model.py`);symlinkSync(`${root}/saved-model.py`,model);run('source symlink rejected before import','source symlink invalid');}finally{unlinkSync(model);renameSync(`${root}/saved-model.py`,model);}
run('restored exact tree optimized Python',null);
console.log(JSON.stringify({scope:'pre-import guards with Python -O, no candidate imports in these cases',count:results.length,results},null,2));
