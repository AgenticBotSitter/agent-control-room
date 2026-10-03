import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { countSharedMemorySegmentsV1, createSupervisorMachineProbeV1,
  evaluateSupervisorMachineHealthV1, isSupervisorMachineRecoveryHealthyV1, startSupervisorLoopV1,
  supervisorMachineHealthConfigV1 } from "../src/supervisor/v1";
import { renderSupervisorLaunchDaemonV1 } from "../scripts/mac-local/install-supervisor-launchdaemon.mjs";

test("machine health uses strict shared-memory and load ceilings", () => {
  const config = supervisorMachineHealthConfigV1({ cpuCount: 12 });
  assert.equal(evaluateSupervisorMachineHealthV1({hostAlive:true,sharedMemorySegments:31,loadOneMinute:17.99},true,config).healthy,true);
  assert.deepEqual(evaluateSupervisorMachineHealthV1({hostAlive:true,sharedMemorySegments:32,loadOneMinute:18},true,config).reasonCodes,
    ["shared_memory_limit","load_limit"]);
  assert.deepEqual(evaluateSupervisorMachineHealthV1({hostAlive:false,sharedMemorySegments:null,loadOneMinute:null},false).reasonCodes,
    ["host_not_alive","loop_not_alive","shared_memory_unavailable","load_unavailable"]);
});

test("load limits scale with CPU count and recovery has a lower hysteresis threshold", () => {
  const twelve = supervisorMachineHealthConfigV1({ cpuCount: 12 });
  const eight = supervisorMachineHealthConfigV1({ cpuCount: 8 });
  assert.deepEqual({ pause: twelve.pauseLoadOneMinute, resume: twelve.resumeLoadOneMinute }, { pause: 18, resume: 12 });
  assert.deepEqual({ pause: eight.pauseLoadOneMinute, resume: eight.resumeLoadOneMinute }, { pause: 12, resume: 8 });
  assert.equal(evaluateSupervisorMachineHealthV1({hostAlive:true,sharedMemorySegments:1,loadOneMinute:17.9},true,twelve).healthy,true);
  assert.deepEqual(evaluateSupervisorMachineHealthV1({hostAlive:true,sharedMemorySegments:1,loadOneMinute:12},true,eight).reasonCodes,["load_limit"]);
  assert.equal(isSupervisorMachineRecoveryHealthyV1(
    evaluateSupervisorMachineHealthV1({hostAlive:true,sharedMemorySegments:1,loadOneMinute:11.99},true,twelve),twelve),true);
  assert.equal(isSupervisorMachineRecoveryHealthyV1(
    evaluateSupervisorMachineHealthV1({hostAlive:true,sharedMemorySegments:1,loadOneMinute:12},true,twelve),twelve),false,
  "recovery must be below, not at, the lower boundary");
});

test("the process probe counts macOS and Linux shared-memory output without mutating either", async () => {
  const mac=`T ID KEY MODE OWNER GROUP\nm 12 0x1 --rw------- user staff\nm 13 0x2 --rw------- user staff\n`;
  const linux=`------ Shared Memory Segments --------\nkey shmid owner perms bytes nattch status\n0x1 31 user 600 56 0\n`;
  assert.equal(countSharedMemorySegmentsV1(mac),2);assert.equal(countSharedMemorySegmentsV1(linux),1);
  let reads=0;const probe=createSupervisorMachineProbeV1({parentAlive:()=>true,loadOneMinute:()=>4.5,
    sharedMemory:async()=>{reads++;return mac;}});
  assert.deepEqual(await probe.sample(),{hostAlive:true,sharedMemorySegments:2,loadOneMinute:4.5});assert.equal(reads,1);
});

test("item 14: the default machine probe returns finite-or-null OS metrics without throwing", async () => {
  const sample=await createSupervisorMachineProbeV1().sample();
  assert.equal(typeof sample.hostAlive,"boolean");
  assert.ok(sample.sharedMemorySegments===null||Number.isSafeInteger(sample.sharedMemorySegments)&&sample.sharedMemorySegments>=0);
  assert.ok(sample.loadOneMinute===null||Number.isFinite(sample.loadOneMinute)&&sample.loadOneMinute>=0);
});

test("item 14 hostile: an ipcs failure and invalid load become null health evidence", async () => {
  const probe=createSupervisorMachineProbeV1({parentAlive:()=>true,loadOneMinute:()=>Number.NaN,
    sharedMemory:async()=>{throw new Error("ipcs_unavailable_fixture");}});
  assert.deepEqual(await probe.sample(),{hostAlive:true,sharedMemorySegments:null,loadOneMinute:null});
});

test("the uninstalled LaunchDaemon kit survives logout/reboot and crash without embedding a machine path", async () => {
  const template=await readFile("deploy/macos/xyz.agentcontrolroom.supervisor.plist.in","utf8");
  const body=renderSupervisorLaunchDaemonV1(template,{serviceUser:"controlroom",nodeExecutable:"/opt/runtime/bin/node",
    repositoryRoot:"/srv/control-room",protectedRoot:"/var/lib/control-room"});
  assert.match(body,/<key>RunAtLoad<\/key>\s*<true\/>/u);assert.match(body,/<key>KeepAlive<\/key>/u);
  assert.match(body,/<key>SuccessfulExit<\/key>\s*<false\/>/u);assert.match(body,/<key>UserName<\/key>\s*<string>controlroom<\/string>/u);
  assert.doesNotMatch(body,/__[A-Z_]+__/u);assert.doesNotMatch(template,/\/Users\/|\/home\//u);
});

test("the loop starts immediately, refuses overlap, survives a failed cycle, and closes its own timer", async () => {
  let callback: (()=>void)|undefined,cleared=false,cycles=0,reported=0;
  const timer={unref(){}} as ReturnType<typeof setInterval>;
  let release: (()=>void)|undefined;
  const handle=await startSupervisorLoopV1({intervalMs:1_000,service:{async cycle(){cycles++;
    if(cycles===2)await new Promise<void>(resolve=>{release=resolve;});
    if(cycles===3)throw new Error("fixture");}},runtime:{setInterval(run){callback=run;return timer;},
      clearInterval(value){assert.equal(value,timer);cleared=true;},report(){reported++;}}});
  assert.equal(cycles,1);callback?.();callback?.();assert.equal(cycles,2);
  release?.();await new Promise(resolve=>setImmediate(resolve));callback?.();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cycles,3);assert.equal(reported,1);callback?.();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cycles,4);await handle.close();assert.equal(cleared,true);
});

test("a failed first cycle is reported, not thrown, only when the caller opts in, so host startup cannot be blocked by it", async () => {
  let callback: (()=>void)|undefined,cycles=0,reported=0;
  const timer={unref(){}} as ReturnType<typeof setInterval>;
  const handle=await startSupervisorLoopV1({intervalMs:1_000,toleratesFirstCycleFailure:true,
    service:{async cycle(){cycles++;
    if(cycles===1)throw new Error("machine_unhealthy_fixture");}},runtime:{setInterval(run){callback=run;return timer;},
      clearInterval(){},report(){reported++;}}});
  assert.equal(cycles,1);assert.equal(reported,1);
  callback?.();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cycles,2,"the loop must keep ticking after a failed first cycle");
  await handle.close();
});

test("without that opt-in, a failed first cycle still rejects -- a one-shot caller's cycle IS its unit of work", async () => {
  const timer={unref(){}} as ReturnType<typeof setInterval>;
  await assert.rejects(startSupervisorLoopV1({intervalMs:1_000,
    service:{async cycle(){throw new Error("synthetic_worker_failure_fixture");}},
    runtime:{setInterval(run){return timer;},clearInterval(){},report(){}}}),
  /synthetic_worker_failure_fixture/u);
});
