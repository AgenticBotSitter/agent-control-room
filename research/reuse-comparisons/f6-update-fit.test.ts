import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import test from "node:test";
import { SqliteNativeRunJournal } from "../../src/harness/hermes-native-v1/run-journal.ts";
import { binding, instant } from "../../tests/hermes-native-fixture.ts";

const hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const file=resolve("research/reuse-comparisons/f6-update-fit.test.ts");
if(process.argv[2]==="journal-child") {
 const journal=new SqliteNativeRunJournal(process.argv[3]);
 try {
  const reservation=journal.reserve(binding,instant);
  if(process.argv[4]==="prepare") {
   assert.equal(reservation.created,true);
   journal.update(binding.runId,1,{state:"dispatching"});
  }else {
   assert.equal(reservation.created,false);
   assert.equal(reservation.snapshot.state,"dispatching");
   assert.equal(reservation.snapshot.binding.attemptId,binding.attemptId);
  }
  console.log(JSON.stringify({created:reservation.created,state:journal.load(binding.runId)?.state,providerCalls:0}));
 } finally {journal.close();}
}else {
 test("same actual journal survives inert process/working-directory change without renewed reservation",t=>{
  const root=mkdtempSync(join(tmpdir(),"cr-f6-update-"));
  t.after(()=>{rmSync(root,{recursive:true});assert.equal(existsSync(root),false);});
  const a=join(root,"release-a"),b=join(root,"release-b"),state=join(root,"state");
  for(const p of [a,b,state])mkdirSync(p,{mode:0o700});
  const db=join(state,"runs.sqlite");
  const child=(cwd:string,mode:string)=>{
   const r=spawnSync(process.execPath,["--import",resolve("node_modules/tsx/dist/loader.mjs"),file,"journal-child",db,mode],
    {cwd,timeout:15000,maxBuffer:256*1024,encoding:"utf8"});
   assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);return JSON.parse(r.stdout.trim());
  };
  assert.deepEqual(child(a,"prepare"),{created:true,state:"dispatching",providerCalls:0});
  const before=hash(readFileSync(db));
  assert.deepEqual(child(b,"reopen"),{created:false,state:"dispatching",providerCalls:0});
  assert.equal(hash(readFileSync(db)),before);
  assert.deepEqual(child(a,"reopen"),{created:false,state:"dispatching",providerCalls:0});
  assert.equal(hash(readFileSync(db)),before);
 });
 test("current journal refuses a synthetic future schema without resetting persisted attempt",t=>{
  const root=mkdtempSync(join(tmpdir(),"cr-f6-update-schema-"));
  t.after(()=>{rmSync(root,{recursive:true});assert.equal(existsSync(root),false);});
  const db=join(root,"runs.sqlite");
  const journal=new SqliteNativeRunJournal(db);
  journal.reserve(binding,instant);journal.update(binding.runId,1,{state:"dispatching"});journal.close();
  const raw=new DatabaseSync(db);raw.exec("PRAGMA user_version=2");raw.close();
  const before=hash(readFileSync(db));
  assert.throws(()=>new SqliteNativeRunJournal(db),/native_journal_unavailable/);
  assert.equal(hash(readFileSync(db)),before);
 });
}
