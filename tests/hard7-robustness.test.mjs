import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireNightlyBackupLockV1, runNightlyBackupV1 } from "../src/installer/v1/nightly-backup.ts";
import { createNightlyBackupConfigurationV1 } from "../src/installer/v1/nightly-backup-configuration.ts";
import { acquirePrivateProcessLockV1, acquireRecoverablePrivateProcessLockV1 } from "../src/installer/shared/private-process-lock.mjs";
import { composeServiceBundleV1, SERVICE_POLICY_LABELS_V1 } from "../src/updater/v1/services/bundle.mjs";
import { renderSupervisorLaunchDaemonV1 } from "../scripts/mac-local/install-supervisor-launchdaemon.mjs";
import { readHostState, superviseTaskHost, RotatingHostLog } from "../scripts/mac-local/task-host-supervisor.mjs";
import { runtimePaths, supervisorLockPaths } from "../scripts/mac-local/stack.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const digest = `sha256:${"a".repeat(64)}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hard7-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = createNightlyBackupConfigurationV1(root);
  await mkdir(join(root, "Protected/config/database-passwords"), { recursive: true });
  await mkdir(join(root, "Protected/runtime-state/nightly-backup"), { recursive: true });
  await mkdir(configuration.outputRoot, { recursive: true });
  await mkdir(runtimePaths(root).runtime, { recursive: true });
  await writeFile(configuration.database.passwordFile, "fixture-password\n", { mode: 0o600 });
  const path = join(root, "Protected/config/backup.json");
  await writeFile(path, JSON.stringify(configuration));
  return { root, configuration, path };
}
const date = day => new Date(Date.UTC(2026, 8, day, 2, 30)).toISOString();
// A COMPLETE generation, which since R4B-01 means a BOUND one: the run's own
// generation is verified before it counts as the night's backup, so a fixture
// that wrote only a dump and a metadata field is correctly refused. Everything
// these tests are about — partials, failed reservations, daily retention, lock
// recovery, SIGTERM halfway — is unaffected by the manifest being present.
async function good({ out }) {
  await mkdir(out, { recursive: true });
  const dump = Buffer.from("fixture-dump");
  const metadata = JSON.stringify({ version: 1, identity: { identityDigest: digest } });
  await writeFile(join(out, "database.dump"), dump, { mode: 0o600 });
  await writeFile(join(out, "metadata.json"), metadata, { mode: 0o600 });
  await writeFile(join(out, "manifest.json"), JSON.stringify({
    schema: "control-room.verified-database-backup/v1",
    dumpDigest: `sha256:${createHash("sha256").update(dump).digest("hex")}`,
    metadataDigest: `sha256:${createHash("sha256").update(metadata).digest("hex")}`,
    restoreIdentityDigest: digest }), { mode: 0o600 });
  return { planned: false, identityDigest: digest };
}
const run = (f, at, backup = good) => runNightlyBackupV1(f.path, { now: () => at, backup });

async function child(t, source, args = []) {
  const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, ...args],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
  const closed = new Promise(resolve => p.once("close", (code, signal) => resolve({ code, signal })));
  t.after(async () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} await closed; });
  const ready = new Promise((resolve, reject) => {
    p.stdout.once("data", resolve); p.once("exit", () => reject(new Error("fixture exited before ready")));
  });
  await ready;
  return { p, closed };
}

test("F3-03: empty and recycled-pid locks recover without stealing a live backup", async t => {
  const f = await fixture(t), path = f.configuration.lockFile;
  for (const stamp of ["", JSON.stringify({ version: 1, pid: 1 }), JSON.stringify({ version: 1, pid: process.pid })]) {
    await writeFile(path, stamp, { mode: 0o600 });
    const release = await acquireNightlyBackupLockV1(path);
    try { await assert.rejects(acquireNightlyBackupLockV1(path), /concurrent_refused/); }
    finally { await release(); }
  }
});

test("F3-03: SIGTERM and SIGKILL halfway release exclusion and allow a retry", async t => {
  const f = await fixture(t);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const module = new URL("../src/installer/v1/nightly-backup.ts", import.meta.url).href;
    const worker = await child(t, `import { runNightlyBackupV1 } from ${JSON.stringify(module)};
      import { mkdir } from "node:fs/promises";
      await runNightlyBackupV1(process.argv[1], { now: () => ${JSON.stringify(date(signal === "SIGTERM" ? 1 : 2))},
        backup: async ({out}) => { await mkdir(out,{recursive:true}); console.log("ready"); setInterval(()=>{},1000); await new Promise(()=>{}); } });`, [f.path]);
    worker.p.kill(signal); await worker.closed;
    await run(f, date(signal === "SIGTERM" ? 3 : 4));
    await assert.rejects(lstat(f.configuration.lockFile), { code: "ENOENT" });
  }
});

test("F3-04: failed, empty and incomplete generations never evict fourteen completed days", async t => {
  const f = await fixture(t);
  for (let d = 1; d <= 14; d++) await run(f, date(d));
  for (let d = 15; d <= 28; d++) await assert.rejects(run(f, date(d), async ({out}) => {
    await mkdir(out, { recursive: true }); throw new Error("dropped connection");
  }), /execution_failed/);
  assert.equal((await readdir(f.configuration.outputRoot)).length, 14, "failed attempts are removed");
  for (let d = 15; d <= 28; d++) await mkdir(join(f.configuration.outputRoot, date(d).replace(/[:.]/g, "-")));
  const {symlink}=await import("node:fs/promises");
  const metadata=JSON.stringify({version:1,identity:{identityDigest:digest}});
  for(const [day,dump,body] of [[15,"",metadata],[16,"dump","{}"],[17,"dump",JSON.stringify({version:1,identity:{identityDigest:"bad"}})],
    [18,"dump",JSON.stringify({version:2,identity:{identityDigest:digest}})]]){
    const folder=join(f.configuration.outputRoot,date(day).replace(/[:.]/g,"-"));
    await writeFile(join(folder,"database.dump"),dump);await writeFile(join(folder,"metadata.json"),body);
  }
  const folder19=join(f.configuration.outputRoot,date(19).replace(/[:.]/g,"-"));
  await writeFile(join(folder19,"database.dump"),"dump");
  await symlink(join(f.configuration.outputRoot,date(14).replace(/[:.]/g,"-"),"metadata.json"),join(folder19,"metadata.json"));
  const folder20=join(f.configuration.outputRoot,date(20).replace(/[:.]/g,"-"));
  await writeFile(join(folder20,"metadata.json"),metadata);
  await symlink(join(f.configuration.outputRoot,date(14).replace(/[:.]/g,"-"),"database.dump"),join(folder20,"database.dump"));
  await assert.rejects(run(f, date(29), async ({out}) => { await mkdir(out,{recursive:true}); return {planned:true}; }), /incomplete/);
  await run(f, date(30));
  for(const day of [...Array.from({length:13},(_,i)=>i+2),30])
    assert.ok(await lstat(join(f.configuration.outputRoot,date(day).replace(/[:.]/g,"-"),"database.dump")),
      `completed day ${day} survives; invalid generations spend no retention`);
  await assert.rejects(lstat(join(f.configuration.outputRoot,date(1).replace(/[:.]/g,"-"))),{code:"ENOENT"});
});

test("F3-04: same-day bursts preserve daily history and a backward clock never retires history", async t => {
  const f = await fixture(t);
  for (let d = 1; d <= 14; d++) await run(f, date(d));
  for (let minute = 0; minute < 20; minute++) await run(f, new Date(Date.UTC(2026,8,15,9,minute)).toISOString());
  assert.equal(new Set((await readdir(f.configuration.outputRoot)).map(n=>n.slice(0,10))).size, 14);
  // Earlier clock corrections can leave more than fourteen completed generations.
  // A new rollback must preserve all of them, rather than pruning by the wrong time.
  const { cp } = await import("node:fs/promises");
  const latest = (await readdir(f.configuration.outputRoot)).sort().at(-1);
  await cp(join(f.configuration.outputRoot, latest), join(f.configuration.outputRoot, date(16).replace(/[:.]/g,"-")), {recursive:true});
  const names = await readdir(f.configuration.outputRoot);
  await run(f, "2001-01-01T00:05:00.000Z");
  const after = await readdir(f.configuration.outputRoot);
  assert.ok(after.includes("2001-01-01T00-05-00-000Z"));
  assert.ok(names.every(n=>after.includes(n)), "clock rollback cannot delete known history");
});

const account = (name, uid) => ({ name, uid, gid: uid, created: true });
const bundleInput = () => ({ root: "/fixture/install", roles: ["nightly-backup", "updater", "updater-guard"],
  accounts: { builder: account("_crbuild", 401), database: account("_crdb",402), service: account("_crsvc",403) },
  protectedConfig: [], pgRuntime: "/fixture/install/runtime/pg-current/bin/postgres", updaterVersion: "1.0.0" });

test("F3-04: scheduled nightly service does not run at load", () => {
  const b = composeServiceBundleV1(bundleInput());
  assert.match(b.resources.find(r=>r.kind==="launchd_plist" && r.role==="nightly-backup").contents,
    /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test("F3-20: foreign labels, duplicate UIDs and directory-shaped database executables refuse", () => {
  for (const label of ["com.apple.something", "com.docker.vmnetd", "a..b", "xyz.agentcontrolroom.", `xyz.agentcontrolroom.${"a".repeat(129)}`]) {
    const input = bundleInput(); input.servicePolicy = SERVICE_POLICY_LABELS_V1.map(s=>s.role==="updater"
      ? {...s,label,plistPath:`/Library/LaunchDaemons/${label}.plist`} : s);
    assert.throws(()=>composeServiceBundleV1(input), /services_batch_uncertain/);
  }
  for (const field of ["uid", "gid"]) {
    const input = bundleInput(); input.accounts.database[field] = input.accounts.service[field];
    assert.throws(()=>composeServiceBundleV1(input), /services_batch_uncertain/);
  }
  for (const path of ["/fixture/install/runtime", "/fixture/install/runtime/pg-current", "/fixture/install/runtime/pg-current/bin"]) {
    assert.throws(()=>composeServiceBundleV1({...bundleInput(),pgRuntime:path}), /services_batch_uncertain/);
  }
  const input = bundleInput(); input.servicePolicy = SERVICE_POLICY_LABELS_V1.map(s=>({...s,
    label:`xyz.agentcontrolroom.rehearsal.hard7.${s.role}`, plistPath:`/Library/LaunchDaemons/xyz.agentcontrolroom.rehearsal.hard7.${s.role}.plist`}));
  assert.ok(composeServiceBundleV1(input));
});

test("F3-21: template values retain dollar signs and placeholder-shaped path components", async () => {
  const template = await readFile(new URL("../deploy/macos/xyz.agentcontrolroom.supervisor.plist.in", import.meta.url),"utf8");
  for (const protectedRoot of ["/fixture/a$$b", "/fixture/a$&b", "/fixture/__SERVICE_USER__", "/fixture/__UNKNOWN__"]) {
    const body = renderSupervisorLaunchDaemonV1(template, {nodeExecutable:"/fixture/node", repositoryRoot:"/fixture/repo",
      protectedRoot, serviceUser:"_crsvc"});
    assert.ok(body.includes(`<string>${protectedRoot.replace(/&/g,"&amp;")}</string>`));
  }
  assert.throws(()=>renderSupervisorLaunchDaemonV1(`${template}__UNKNOWN__`, {nodeExecutable:"/fixture/node", repositoryRoot:"/fixture/repo",
    protectedRoot:"/fixture/root",serviceUser:"_crsvc"}), /template_invalid/);
});

function fakeChild() {
  const p = new EventEmitter(); p.pid = 424242; p.stdout = new PassThrough(); p.stderr = new PassThrough();
  p.kill = signal => { if (signal === "SIGKILL") queueMicrotask(()=>p.emit("close",null,signal)); return true; };
  return p;
}

test("F3-08: loose old log is discarded during streaming rotation while output continues", async t => {
  const f = await fixture(t), path = runtimePaths(f.root).hostLog;
  await writeFile(`${path}.1`, "unsafe-old", {mode:0o644}); await chmod(`${path}.1`,0o644);
  const log = await RotatingHostLog.open(path,64,3);
  try { await log.write("x".repeat(200)); } finally { await log.close(); }
  for (const n of await readdir(runtimePaths(f.root).runtime)) if (n.startsWith("task-host.log"))
    assert.equal((await lstat(join(runtimePaths(f.root).runtime,n))).mode & 0o777,0o600);
});

test("F3-10: fifty concurrent supervisors admit one before log, state or spawn effects", async t => {
  const f = await fixture(t), signals = new EventEmitter(), p = fakeChild(); let started;
  const ready = new Promise(r=>{started=r;}); let spawns = 0;
  const first = superviseTaskHost(f.root,{signals,spawn:()=>{spawns++;return p;},onStarted:started});
  await ready;
  try {
    const before = await readFile(runtimePaths(f.root).hostState,"utf8");
    const burst = await Promise.allSettled(Array.from({length:50},()=>superviseTaskHost(f.root,{signals:new EventEmitter(),
      spawn:()=>{spawns++;const c=fakeChild();queueMicrotask(()=>c.emit("close",0));return c;}})));
    assert.equal(burst.filter(r=>r.status==="rejected" && /supervisor_busy/.test(r.reason.message)).length,50);
    assert.equal(spawns,1); assert.equal(await readFile(runtimePaths(f.root).hostState,"utf8"),before);
  } finally { p.emit("close",0); await first; }
});

test("F3-17: repeated stop signals retain handlers through bounded shutdown", async t => {
  const f = await fixture(t), signals = new EventEmitter(), p = fakeChild();
  const pending = superviseTaskHost(f.root,{signals,spawn:()=>p,shutdownMs:30,unrefShutdown:false,
    onStarted:()=>{for(const signal of ["SIGTERM","SIGINT","SIGHUP"]){
      signals.emit(signal);assert.equal(signals.listenerCount(signal),1);signals.emit(signal);
    }}});
  assert.equal(await pending,0);
  assert.equal((await readHostState(runtimePaths(f.root).hostState)).reason,"requested SIGTERM");
  await assert.rejects(lstat(runtimePaths(f.root).hostPid),{code:"ENOENT"});
  assert.equal(signals.listenerCount("SIGTERM"),0);
});

const alivePid = pid => { try { process.kill(pid,0); return true; } catch { return false; } };
const waitFor = async check => {
  for (let n=0;n<120;n++) { if (await check()) return; await new Promise(r=>setTimeout(r,25)); }
  assert.fail("condition did not settle within three seconds");
};

async function realSupervisor(t, root, mode = "idle") {
  const module = new URL("../scripts/mac-local/task-host-supervisor.mjs",import.meta.url).href;
  const childSource = mode === "slow" ? 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),200));setInterval(()=>{},1000);'
    : 'setInterval(()=>{},1000);';
  const source = `import { superviseTaskHost } from ${JSON.stringify(module)};
    import { readFileSync } from "node:fs";
    import { runtimePaths, supervisorLockPaths } from ${JSON.stringify(new URL("../scripts/mac-local/stack.mjs",import.meta.url).href)};
    const code = await superviseTaskHost(process.argv[1],{command:process.execPath,args:["-e",${JSON.stringify(childSource)}],
      onStarted:()=>console.log(readFileSync(runtimePaths(process.argv[1]).hostState,"utf8"))}); process.exitCode=code;`;
  const worker = await child(t,source,[root]);
  const state = await readHostState(runtimePaths(root).hostState);
  t.after(async()=>{try {process.kill(-state.childPid,"SIGKILL");}catch{} await waitFor(()=>!alivePid(state.childPid));});
  return {...worker,state};
}

test("F3-09: real replacement kills only its descriptor-identified orphan with ps unavailable", async t => {
  if (process.platform !== "darwin") { t.skip("macOS descriptor inheritance proof"); return; }
  const f=await fixture(t), first=await realSupervisor(t,f.root);
  first.p.kill("SIGKILL"); await first.closed;
  assert.ok(alivePid(first.state.childPid),"the fixture is a real orphan before replacement");
  const second=await realSupervisor(t,f.root);
  await waitFor(()=>!alivePid(first.state.childPid));
  assert.ok(alivePid(second.state.childPid));
  second.p.kill("SIGTERM");
  assert.deepEqual(await second.closed,{code:0,signal:null});
  assert.equal((await readHostState(runtimePaths(f.root).hostState)).reason,"requested SIGTERM");
});

test("F3-09: a missing or damaged diagnostic state cannot hide a descriptor-identified orphan", async t => {
  if (process.platform !== "darwin") { t.skip("macOS descriptor inheritance proof"); return; }
  for (const damaged of [false, true]) {
    const f=await fixture(t), first=await realSupervisor(t,f.root);
    first.p.kill("SIGKILL"); await first.closed;
    const statePath=runtimePaths(f.root).hostState;
    if (damaged) await writeFile(statePath,"damaged\n",{mode:0o600});
    else await rm(statePath);
    assert.ok(alivePid(first.state.childPid));
    const second=await realSupervisor(t,f.root);
    await waitFor(()=>!alivePid(first.state.childPid));
    second.p.kill("SIGTERM");
    assert.deepEqual(await second.closed,{code:0,signal:null});
  }
});

test("F3-17: a real supervisor survives repeated SIGTERM while its child drains", async t => {
  const f=await fixture(t), worker=await realSupervisor(t,f.root,"slow");
  // Child startup is asynchronous; let its signal handler install before the stop.
  await new Promise(r=>setTimeout(r,150));
  worker.p.kill("SIGTERM"); await new Promise(r=>setTimeout(r,30)); worker.p.kill("SIGTERM");
  assert.deepEqual(await worker.closed,{code:0,signal:null});
  assert.equal((await readHostState(runtimePaths(f.root).hostState)).reason,"requested SIGTERM");
  await assert.rejects(lstat(runtimePaths(f.root).hostPid),{code:"ENOENT"});
});

// The REFUSAL is what these tests are about, not the code it carries: a symlink, a hardlink, a
// wrong mode, another owner and a directory must all be refused, and nothing may be followed or
// deleted. R4S-07 split the one code into two — contention (a live holder) and damage (an entry
// we must not own) — so these assert the refusal itself, and R4S-07's own tests below assert
// WHICH of the two each shape gets.
test("F3-03/F3-22: private descriptor locks refuse unsafe entries and never delete a replacement", async t => {
  const { acquirePrivateProcessLockV1 } = await import("../src/installer/shared/private-process-lock.mjs");
  const { link, rename, symlink } = await import("node:fs/promises");
  const f=await fixture(t), path=join(f.root,"lock"), target=join(f.root,"precious");
  await writeFile(target,"precious",{mode:0o600});
  const acquire=()=>acquirePrivateProcessLockV1(path,{busyCode:"busy"});
  const refused=()=>assert.throws(acquire,error=>/busy|unusable/u.test(error.message));
  await symlink(target,path); refused(); await rm(path);
  await link(target,path); refused(); await rm(path);
  await writeFile(path,"loose",{mode:0o644}); await chmod(path,0o644); refused(); await rm(path);
  assert.throws(()=>acquirePrivateProcessLockV1(path,{busyCode:"busy",expectedUid:process.getuid()+1}),/busy|unusable/u); await rm(path);
  await mkdir(path); refused(); await rm(path,{recursive:true});
  const lock=acquire();
  await rename(path,join(f.root,"old-lock")); await writeFile(path,"replacement",{mode:0o600});
  lock.release(); lock.close();
  assert.equal(await readFile(path,"utf8"),"replacement");
  assert.equal(await readFile(target,"utf8"),"precious");
});

test("F3-09: descriptor liveness rejects wrong PID, inode, nonce, command and released owner", async t => {
  if (process.platform!=="darwin") {t.skip("macOS kernel lease");return;}
  const { acquirePrivateProcessLockV1 }=await import("../src/installer/shared/private-process-lock.mjs");
  const { alive }=await import("../scripts/mac-local/stack.mjs");
  const f=await fixture(t), path=join(f.root,"lease"), command=[process.execPath,"fixture-lease"];
  const lock=acquirePrivateProcessLockV1(path,{busyCode:"busy"}); lock.writeOwner(process.pid,command);
  const probe=(pid=process.pid,expected=command,identity=lock.identity)=>alive(pid,expected,{path,identity});
  try {
    assert.equal(probe(),true);
    assert.equal(probe(process.ppid),false);
    assert.equal(probe(0),false);
    assert.equal(probe(process.pid,[...command,"wrong"]),false);
    assert.equal(probe(process.pid,command,{...lock.identity,ino:-1}),false);
    assert.equal(probe(process.pid,command,{...lock.identity,nonce:"wrong"}),false);
    assert.equal(probe(process.pid,command,{}),false);
    await chmod(path,0o644);assert.equal(probe(),false);await chmod(path,0o600);
  } finally { lock.close(); }
  assert.equal(probe(),false,"a live PID cannot stand in for a released descriptor");
  await rm(path);
});

test("F3-04: same timestamp and failed reservation never overwrite an existing good dump", async t => {
  const f=await fixture(t), at=date(1);await run(f,at);
  let backups=0;
  await assert.rejects(run(f,at,async()=>{backups++;throw new Error("failed");}),/output_refused/);
  assert.equal(backups,0);
  const path=join(f.configuration.outputRoot,at.replace(/[:.]/g,"-"),"database.dump");
  assert.equal(await readFile(path,"utf8"),"fixture-dump");
});

test("F3-03/F3-22: O_NOFOLLOW refuses a symlink even if it is swapped into its target after open", async t => {
  const fs = await import("node:fs"), { syncBuiltinESMExports } = await import("node:module");
  const { acquirePrivateProcessLockV1 }=await import("../src/installer/shared/private-process-lock.mjs");
  const f=await fixture(t), path=join(f.root,"swap-lock"), target=join(f.root,"precious-target");
  await writeFile(target,"precious",{mode:0o600}); await fs.promises.symlink(target,path);
  const original=fs.default.openSync;
  fs.default.openSync=(name,...args)=>{
    const fd=original(name,...args);
    if(name===path){fs.unlinkSync(path);fs.renameSync(target,path);}
    return fd;
  }; syncBuiltinESMExports();
  let acquired;
  // A symlink swapped in after open is a refusal, whichever code carries it (R4S-07).
  try { assert.throws(()=>{acquired=acquirePrivateProcessLockV1(path,{busyCode:"busy"});},/busy|unusable/u); }
  finally { acquired?.release();fs.default.openSync=original;syncBuiltinESMExports(); }
  assert.equal(await readFile(target,"utf8"),"precious");
});

test("private lock portability fallback preserves a live incarnation and delays fresh empty recovery", async t => {
  const fs=await import("node:fs"), {syncBuiltinESMExports}=await import("node:module");
  const originalPlatform=Object.getOwnPropertyDescriptor(process,"platform");
  let module;
  try {
    Object.defineProperty(process,"platform",{...originalPlatform,value:"linux"});
    module=await import(`../src/installer/shared/private-process-lock.mjs?fallback=${Date.now()}`);
  } finally {Object.defineProperty(process,"platform",originalPlatform);}
  const f=await fixture(t), path=join(f.root,"portable-lock"), originalRead=fs.default.readFileSync;
  fs.default.readFileSync=(name,...args)=> typeof name === "string" && name.startsWith("/proc/")
    ? (name===`/proc/${process.pid}/stat` ? `${process.pid} (fixture) ${Array(19).fill("0").join(" ")} 42\n` : (()=>{throw new Error("gone");})())
    : originalRead(name,...args);
  syncBuiltinESMExports();
  const acquire=()=>module.acquirePrivateProcessLockV1(path,{busyCode:"busy"});
  try {
    await writeFile(path,"",{mode:0o600});assert.throws(acquire,/busy/);
    await fs.promises.utimes(path,1,1);acquire().release();
    for(const start of ["42",undefined]){
      await writeFile(path,JSON.stringify({pid:process.pid,start}),{mode:0o600});assert.throws(acquire,/busy/);await rm(path);
    }
    await writeFile(path,JSON.stringify({pid:process.pid,start:"old"}),{mode:0o600});acquire().release();
    await writeFile(path,JSON.stringify({pid:2147483647,start:"42"}),{mode:0o600});acquire().release();
  } finally {fs.default.readFileSync=originalRead;syncBuiltinESMExports();}
});

test("F3-04: real production-login dump drives retention on a lead-owned disposable PostgreSQL fixture", async t => {
  const path=process.env.CONTROL_ROOM_HARD7_DB_PROOF_CONFIGURATION;
  if (!path) {t.skip("lead must supply a disposable migrated PostgreSQL backup configuration");return;}
  const { dirname,resolve }=await import("node:path"), {cp}=await import("node:fs/promises");
  const root=dirname(dirname(dirname(path)));
  assert.equal(resolve(path),path);
  assert.equal(await readFile(join(root,".hard7-disposable-backup-proof"),"utf8"),"disposable\n",
    "this opt-in proof requires the lead's explicit disposable-root marker");
  const configuration=createNightlyBackupConfigurationV1(root);
  assert.deepEqual(JSON.parse(await readFile(path,"utf8")),configuration);
  assert.equal(configuration.database.login,"control_room_migrator");
  assert.deepEqual(await readdir(configuration.outputRoot),[],"use an empty disposable backup root");
  await runNightlyBackupV1(path,{now:()=>date(1)});
  const first=join(configuration.outputRoot,date(1).replace(/[:.]/g,"-"));
  assert.match(JSON.parse(await readFile(join(first,"metadata.json"),"utf8")).identity.identityDigest,/^sha256:[a-f0-9]{64}$/);
  for(let d=2;d<=14;d++)await cp(first,join(configuration.outputRoot,date(d).replace(/[:.]/g,"-")),{recursive:true});
  await runNightlyBackupV1(path,{now:()=>date(15)});
  assert.equal((await readdir(configuration.outputRoot)).length,14);
  assert.ok((await readdir(configuration.outputRoot)).includes(date(15).replace(/[:.]/g,"-")));
});

test("F3-10: real CLI refusal preserves the first supervisor's state and log", async t => {
  const { acquirePrivateProcessLockV1 }=await import("../src/installer/shared/private-process-lock.mjs");
  const f=await fixture(t), paths={...runtimePaths(f.root),...supervisorLockPaths(f.root)}, lock=acquirePrivateProcessLockV1(paths.hostLock,{busyCode:"busy"});
  await writeFile(paths.hostState,"first-supervisor-state\n",{mode:0o600});
  await writeFile(paths.hostLog,"first-supervisor-log\n",{mode:0o600});
  try {
    assert.throws(()=>execFileSync(process.execPath,[new URL("../scripts/mac-local/task-host-supervisor.mjs",import.meta.url).pathname,
      "--protected-root",f.root],{stdio:"pipe",timeout:5000}),error=>error.status===1 && error.stderr.toString().trim()==="mac_local_supervisor_busy");
    assert.equal(await readFile(paths.hostState,"utf8"),"first-supervisor-state\n");
    assert.equal(await readFile(paths.hostLog,"utf8"),"first-supervisor-log\n");
  } finally {lock.release();}
});

test("private descriptor acquisition refuses a name swapped after open", async t => {
  const fs=await import("node:fs"), {syncBuiltinESMExports}=await import("node:module");
  const {acquirePrivateProcessLockV1}=await import("../src/installer/shared/private-process-lock.mjs");
  const f=await fixture(t), path=join(f.root,"lock-race"), original=fs.default.openSync;
  fs.default.openSync=(name,...args)=>{
    const fd=original(name,...args);
    if(name===path){fs.renameSync(path,`${path}.held`);const replacement=original(path,fs.constants.O_CREAT|fs.constants.O_WRONLY,0o600);fs.writeSync(replacement,"replacement");fs.closeSync(replacement);}
    return fd;
  };syncBuiltinESMExports();let acquired;
  try {assert.throws(()=>{acquired=acquirePrivateProcessLockV1(path,{busyCode:"busy"});},/busy/);}
  finally {acquired?.release();fs.default.openSync=original;syncBuiltinESMExports();}
  assert.equal(await readFile(path,"utf8"),"replacement");
});

test("F3-09: lease reads stay bounded and refuse an inode replaced during the kernel probe", async t => {
  if(process.platform!=="darwin"){t.skip("macOS kernel lease");return;}
  const fs=await import("node:fs"), {syncBuiltinESMExports}=await import("node:module");
  const {acquirePrivateProcessLockV1,privateProcessLeaseAliveV1}=await import("../src/installer/shared/private-process-lock.mjs");
  const f=await fixture(t), path=join(f.root,"reader-race"), command=["fixture-command"];
  const lock=acquirePrivateProcessLockV1(path,{busyCode:"busy"});lock.writeOwner(process.pid,command);
  const originalStat=fs.default.lstatSync, originalOpen=fs.default.openSync, stamp=await readFile(path);
  const probe=()=>privateProcessLeaseAliveV1(path,process.pid,command,lock.identity);
  try {
    fs.default.lstatSync=name=>{
      const info=originalStat(name);
      if(name===path)fs.appendFileSync(path," ".repeat(10000));
      return info;
    };syncBuiltinESMExports();
    assert.equal(probe(),false,"growth after stat cannot bypass the bounded reader");
    fs.default.lstatSync=originalStat;syncBuiltinESMExports();fs.writeFileSync(path,stamp);
    fs.default.openSync=(name,...args)=>{
      try{return originalOpen(name,...args);}catch(error){
        if(name===path && error.code==="EAGAIN"){
          fs.renameSync(path,`${path}.held`);fs.writeFileSync(path,stamp,{mode:0o600});
        }
        throw error;
      }
    };syncBuiltinESMExports();
    assert.equal(probe(),false,"a busy old inode is not the replacement name");
  } finally {
    fs.default.lstatSync=originalStat;fs.default.openSync=originalOpen;syncBuiltinESMExports();lock.close();
  }
});

test("F3-09: private child identity and kill(0) work in the installed service Seatbelt profile", async t => {
  if(process.platform!=="darwin"){t.skip("requires macOS Seatbelt");return;}
  try{execFileSync("/usr/bin/sandbox-exec",["-p","(version 1)(allow default)","/usr/bin/true"],{stdio:"pipe",timeout:5000});}
  catch(error){
    if(error.status===71 && /sandbox_apply: Operation not permitted/.test(error.stderr?.toString()??"")){
      t.skip("outer sandbox refuses sandbox_apply; lead must run the installed-profile proof");return;
    }
    throw error;
  }
  const f=await fixture(t), {cp}=await import("node:fs/promises"), {build}=await import("esbuild");
  const node=join(f.root,"node"), script=join(f.root,"lease-probe.mjs");
  await cp(process.execPath,node);await chmod(node,0o700);
  const source=`import assert from "node:assert/strict";import {spawn} from "node:child_process";
    import {acquirePrivateProcessLockV1,privateProcessLeaseAliveV1} from "./src/installer/shared/private-process-lock.mjs";
    const path=process.argv[2],lock=acquirePrivateProcessLockV1(path,{busyCode:"busy"});
    const command=[process.execPath,"-e","setInterval(()=>{},1000)"];
    let child,closed;
    try{child=spawn(command[0],command.slice(1),{detached:true,stdio:["ignore","ignore","ignore",lock.fd]});
      closed=new Promise(resolve=>child.once("close",resolve));lock.writeOwner(child.pid,command);lock.close();
      assert.equal(privateProcessLeaseAliveV1(path,child.pid,command,lock.identity),true);
      process.kill(-child.pid,"SIGTERM");await closed;
      assert.equal(privateProcessLeaseAliveV1(path,child.pid,command,lock.identity),false);console.log("sandbox lease verified");
    }finally{if(child){try{process.kill(-child.pid,"SIGKILL");}catch{}await closed;}lock.release();}`;
  await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:"hard7-seatbelt.mjs"},bundle:true,format:"esm",platform:"node",outfile:script,logLevel:"silent"});
  const profile=new URL("../src/updater/v1/policy/service-supervisor.sb",import.meta.url).pathname;
  const args=["-f",profile,...Object.entries({RUNTIME_STATE:f.root,RUNTIME_ROOT:f.root,RELEASE_ROOT:f.root,UPDATER_ROOT:f.root,
    WORKING_DIRECTORY:f.root,OUT_LOG:join(f.root,"out.log"),ERR_LOG:join(f.root,"err.log")}).flatMap(([k,v])=>["-D",`${k}=${v}`]),
    "--",node,script,join(f.root,"sandbox.lock")];
  const worker=spawn("/usr/bin/sandbox-exec",args,{cwd:f.root,detached:true,stdio:["ignore","pipe","pipe"]});
  let output="",errorOutput="";worker.stdout.on("data",b=>output+=b);worker.stderr.on("data",b=>errorOutput+=b);
  const closed=new Promise(resolve=>worker.once("close",code=>resolve(code)));
  try{assert.equal(await closed,0,errorOutput);assert.match(output,/sandbox lease verified/);}
  finally{try{process.kill(-worker.pid,"SIGKILL");}catch{}await closed;}
});

// R4S-07: every lock problem used to surface as the busy code, so a wrong-mode file, a
// directory, a dangling symlink or a FIFO at a lock path told the owner "another one is
// running" forever. Only EAGAIN from the kernel can mean a live holder.
const DAMAGED_LOCK_SHAPES_V1 = Object.freeze({
  // A file restored from a backup with the wrong mode: opens fine, is not a lock we may own.
  mode644: async (path) => { await writeFile(path, "stale\n"); await chmod(path, 0o644); },
  directory: (path) => mkdir(path),
  danglingSymlink: async (path) => { const { symlink } = await import("node:fs/promises");
    await symlink(join(path, "..", "nowhere"), path); },
  fifo: async (path) => execFileSync("/usr/bin/mkfifo", [path]),
  // A hardlinked name: one inode reachable twice, so bytes could be read through the other name.
  hardlinked: async (path) => { const { link } = await import("node:fs/promises");
    await writeFile(path, "stale\n", { mode: 0o600 }); await link(path, `${path}.other`); },
});

test("R4S-07: a damaged lock entry says so, and never says another one is running", async t => {
  const root = await mkdtemp(join(tmpdir(), "r4s07-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, make] of Object.entries(DAMAGED_LOCK_SHAPES_V1)) {
    const path = join(root, `${name}.lock`);
    await make(path);
    // A direct acquire must NOT report contention, on any attempt, ever.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.throws(() => acquirePrivateProcessLockV1(path, { busyCode: "LOCK_BUSY" }),
        error => error.message === "private_process_lock_unusable" && error.unusable === true
          && error.path === path, `${name} attempt ${attempt} must refuse as unusable, not busy`);
    }
    // The recoverable acquire quarantines ONE such entry beside itself and succeeds, so the
    // owner never has to hand-edit the private directory.
    const lock = acquireRecoverablePrivateProcessLockV1(path, { busyCode: "LOCK_BUSY" });
    lock.release();
    const quarantined = (await readdir(root)).filter(entry => entry.startsWith(`${name}.lock.quarantine-`));
    assert.equal(quarantined.length, 1, `${name}: the damaged entry must be moved aside, not removed`);
    await assert.rejects(lstat(path), { code: "ENOENT" }, `${name}: release clears the lock`);
  }
});

test("R4S-07: a real holder is still refused, and a quarantined directory keeps its contents", async t => {
  const root = await mkdtemp(join(tmpdir(), "r4s07-holder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Control for the test above: EAGAIN is the ONE case that keeps the busy code. Without it
  // every refusal above would pass for the wrong reason.
  const held = join(root, "held.lock");
  const owner = acquirePrivateProcessLockV1(held, { busyCode: "LOCK_BUSY" });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.throws(() => acquirePrivateProcessLockV1(held, { busyCode: "LOCK_BUSY" }),
        error => error.message === "LOCK_BUSY" && error.unusable !== true, "a live holder is busy");
      assert.throws(() => acquireRecoverablePrivateProcessLockV1(held, { busyCode: "LOCK_BUSY" }),
        error => error.message === "LOCK_BUSY", "recovery must never take a live holder's lock");
    }
  } finally { owner.release(); }
  // A directory at the lock path is MOVED, never opened or emptied: whatever was in it is
  // still there afterwards, which is what "do not follow or descend" has to mean.
  const path = join(root, "directory.lock"), marker = join(path, "owner-data");
  await mkdir(path); await writeFile(marker, "keep me");
  acquireRecoverablePrivateProcessLockV1(path, { busyCode: "LOCK_BUSY" }).release();
  const moved = (await readdir(root)).find(entry => entry.startsWith("directory.lock.quarantine-"));
  assert.ok(moved, "the directory was moved aside");
  assert.equal(await readFile(join(root, moved, "owner-data"), "utf8"), "keep me");
  // And a stale lock from a crash is still taken over, with nothing quarantined: this is the
  // normal recovery path and it must stay silent.
  const stale = join(root, "stale.lock");
  await writeFile(stale, `${JSON.stringify({ version: 2, pid: 999999, command: [], nonce: "x" })}\n`, { mode: 0o600 });
  acquireRecoverablePrivateProcessLockV1(stale, { busyCode: "LOCK_BUSY" }).release();
  assert.deepEqual((await readdir(root)).filter(entry => entry.startsWith("stale.lock")), []);
});

test("R4S-07: the nightly backup lock distinguishes damage from concurrency", async t => {
  const f = await fixture(t), path = f.configuration.lockFile;
  // Damage at the lock path: the backup runs. It used to fail as nightly_backup_concurrent_refused
  // on every attempt, so one wrong-mode file stopped every later night.
  await writeFile(path, "stale\n"); await chmod(path, 0o644);
  await run(f, date(1));
  const quarantined = (await readdir(join(f.root, "Protected/runtime-state/nightly-backup")))
    .filter(entry => entry.includes(".quarantine-"));
  assert.equal(quarantined.length, 1, "the damaged lock is moved aside and the night is taken");
  assert.equal((await readdir(f.configuration.outputRoot)).length, 1);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  // Concurrency is unchanged: a second caller while the first holds the lock is still refused
  // with the concurrent code, because that is the one refusal that means "wait".
  const release = await acquireNightlyBackupLockV1(path);
  try {
    await assert.rejects(acquireNightlyBackupLockV1(path), /nightly_backup_concurrent_refused/);
    await assert.rejects(run(f, date(2)), /nightly_backup_concurrent_refused/);
  } finally { await release(); }
  // And it recovers: the next night runs normally.
  await run(f, date(3));
  assert.equal((await readdir(f.configuration.outputRoot)).length, 2);
});

test("R4S-07: the task-host supervisor starts past a damaged lock or state entry", async t => {
  const f = await fixture(t), paths = { ...runtimePaths(f.root), ...supervisorLockPaths(f.root) };
  const childPath = join(f.root, "diagnostic-child.mjs");
  await writeFile(childPath, "setInterval(() => {}, 1000);\n");
  // A stale lock left at the wrong mode used to refuse every start with mac_local_supervisor_busy,
  // so launchd could never bring the site back. Control first: an undamaged root starts.
  for (const damage of ["control", "lockMode644", "lockDirectory", "childLockDirectory"]) {
    const root = damage === "control" ? f.root : await mkdtemp(join(tmpdir(), `r4s07-${damage}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const at = damage === "control" ? paths
      : { ...runtimePaths(root), ...supervisorLockPaths(root) };
    if (damage !== "control") await mkdir(at.runtime, { recursive: true, mode: 0o700 });
    if (damage === "lockMode644") { await writeFile(at.hostLock, "stale\n"); await chmod(at.hostLock, 0o644); }
    if (damage === "lockDirectory") await mkdir(at.hostLock);
    if (damage === "childLockDirectory") await mkdir(at.childLock);
    let started = false;
    const code = await superviseTaskHost(root, { command: process.execPath, args: [childPath],
      onStarted() { started = true; setTimeout(() => process.emit("SIGTERM"), 150); } })
      .catch(error => `THROW:${error.code ?? error.message}`);
    assert.equal(started, true, `${damage}: the host must start`);
    assert.equal(code, 0, `${damage}: a requested stop is a clean exit, got ${code}`);
    assert.equal(JSON.parse(await readFile(at.hostState, "utf8")).state, "stopped", damage);
    const quarantined = (await readdir(at.runtime)).filter(entry => entry.includes(".quarantine-"));
    assert.equal(quarantined.length, damage === "control" ? 0 : 1, `${damage}: damaged entry moved aside once`);
  }
});
