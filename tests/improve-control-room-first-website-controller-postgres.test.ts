import assert from "node:assert/strict";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { B5RefusalV1, requireFirstWebsiteRehearsalPart2V1, firstWebsiteConfigSchemaV1, readFirstWebsitePrivateBytesV1, B5_REQUEST_TEXT, b5Bytes, b5ManifestSchemaV1, b5JourneySchemaV1 } from "./helpers/improve-control-room-first-website";
import { assertB5AcceptedIntakeV1, b5ControllerBrowserEventsSchemaV1, projectB5ControllerStartV1 } from "../scripts/workflow-journeys/first-website-controller";
import { b5DeviceRequestSchemaV1, b5DeviceReceiptSchemaV1, writeB5DeviceReceiptV1 } from "../scripts/workflow-journeys/first-website-device";
import { loopBridgeReceiptSchemaV1 } from "../src/improve-control-room/v1/schemas";
import { loopCandidateCardSchemaV1 } from "../src/improve-control-room/v1/loop-candidate-wire";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { z } from "zod";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

test("B5 controller-postgres missing qualification refuses before acquisition", async () => {
  let acquisitions = 0;
  const resources: string[] = [];
  const hook = createHook({ init(_id, type) {
    if (["PROCESSWRAP", "TCPSERVERWRAP", "TCPWRAP"].includes(type)) resources.push(type);
  } });
  hook.enable();
  try {
    await assert.rejects(requireFirstWebsiteRehearsalPart2V1().then(() => { acquisitions++; }),
      { code: "B5_A2_QUALIFICATION_REQUIRED" }, "B5 controller-postgres missing qualification guard");
  } finally { hook.disable(); }
  assert.equal(acquisitions, 0); assert.deepEqual(resources, []);
  console.log("RESULT: PASS B5 controller-postgres missing qualification acquisitions=0 child=0 PG=0 listener=0");
});

test("B5 controller-postgres malformed rehearsal packet refuses before acquisition", async () => {
  await assert.rejects(requireFirstWebsiteRehearsalPart2V1({ supplied: true }), { code: "B5_REHEARSAL_PACKET_INVALID" });
  console.log("RESULT: PASS B5 malformed rehearsal packet refused before acquisition");
});

test("B5 rehearsal pins reject corpus, provenance and symlink changes without acquisition", async t => {
  await mkdir(resolve(".test-tmp"),{recursive:true});
  const parent=await mkdtemp(resolve(".test-tmp/f04b-rehearsal-packet-")),root=join(parent,"acr-b5-fixture");
  t.after(()=>rm(parent,{recursive:true,force:true}));await mkdir(join(root,"config/i1"),{recursive:true,mode:0o700});
  const corpus=JSON.stringify({entries:[]}),fence="SYNTHETIC unit fence",manifest="SYNTHETIC unit tooling manifest";
  const provider=JSON.stringify({version:1,providers:"fixture",reason:"B5_PROVIDER_FIXTURE",pins:{"config/b5-corpus.json":b5Bytes(corpus).slice(7),"config/b5-fence.sb":b5Bytes(fence).slice(7)}});
  const packet={schemaVersion:1,kind:"b5-fixture-provider-rehearsal",root,productRevision:"a".repeat(40),toolsRevision:"b".repeat(40),toolingRevision:b5Bytes(manifest),
    providerConfigSha256:b5Bytes(provider),corpusSha256:b5Bytes(corpus),fenceSha256:b5Bytes(fence),jobSandboxDigest:b5Bytes("unit sandbox"),browser:{executablePath:null,sha256:null}};
  const bodies={"b5-rehearsal.json":JSON.stringify(packet),"b5-provider.json":provider,"b5-corpus.json":corpus,"b5-fence.sb":fence,"manifest.sha256":manifest,
    "b5-handoff.json":JSON.stringify({toolsPin:packet.toolsRevision,productPin:packet.productRevision})};
  for(const [name,body] of Object.entries(bodies))await writeFile(join(root,"config",name),body,{mode:0o600});
  const file=join(root,"config/b5-rehearsal.json");
  const resources:string[]=[];const hook=createHook({init(_id,type){if(["PROCESSWRAP","TCPSERVERWRAP","TCPWRAP"].includes(type))resources.push(type);}});hook.enable();
  try {
    assert.deepEqual(await requireFirstWebsiteRehearsalPart2V1(file),packet);
    for(const name of ["b5-provider.json","b5-corpus.json","b5-fence.sb","manifest.sha256","b5-handoff.json"] as const) {
      await writeFile(join(root,"config",name),bodies[name]+" ");
      if(name === "b5-handoff.json")await writeFile(join(root,"config",name),JSON.stringify({toolsPin:"c".repeat(40),productPin:packet.productRevision}));
      await assert.rejects(requireFirstWebsiteRehearsalPart2V1(file),{code:"B5_REHEARSAL_PACKET_CHANGED"});
      await writeFile(join(root,"config",name),bodies[name]);assert.deepEqual(await requireFirstWebsiteRehearsalPart2V1(file),packet);
    }
    await writeFile(join(root,"config/i1/real-jobs-enabled"),"",{mode:0o600});
    await assert.rejects(requireFirstWebsiteRehearsalPart2V1(file),{code:"B5_REHEARSAL_REAL_ENABLE"});await rm(join(root,"config/i1/real-jobs-enabled"));
    await rm(join(root,"config/b5-corpus.json"));await symlink(join(root,"config/b5-provider.json"),join(root,"config/b5-corpus.json"));
    await assert.rejects(requireFirstWebsiteRehearsalPart2V1(file),{code:"B5_REVIEW_SCAN_PATH"});
  } finally {hook.disable();}
  assert.deepEqual(resources,[]);
  console.log("RESULT: PASS rehearsal packet changes refuse before child/PG/listener; synthetic parser fixture only");
});

test("B5 controller native gate missing qualification is a hard failure", {timeout:60_000}, async () => {
  const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_B5_REHEARSAL_REQUIRE_A2:"1"};delete env.NODE_TEST_CONTEXT;delete env.CONTROL_ROOM_B5_REHEARSAL_PACKET;
  for(const scenario of ["INTERRUPT","DEADLINE","STOP"])delete env[`CONTROL_ROOM_B5_REHEARSAL_${scenario}_PACKET`];
  for(const name of ["B5 real engine fixture-provider complete rehearsal",...['interrupt','deadline','stop'].map(s=>`B5 native fixture rehearsal forced-abort ${s}`)]) {
    const result=await promisify(execFile)(process.execPath,["scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=^${name}$`,"tests/improve-control-room-first-website-controller-postgres.test.ts"],{env,timeout:20_000,maxBuffer:1<<20})
      .then(()=>assert.fail("native gate cannot skip to green"),(e:{code:number;stdout:string})=>e);
    assert.equal(result.code,1);assert.match(result.stdout,/B5_A2_QUALIFICATION_REQUIRED/u);assert.match(result.stdout,/# fail 1/u);assert.match(result.stdout,/# skipped 0/u);
    assert.doesNotMatch(result.stdout,/B5-REHEARSAL-GREEN/u);
  }
});

if (process.env.CONTROL_ROOM_B5_REHEARSAL_REQUIRE_A2 === "1") {
  test("B5 real engine fixture-provider complete rehearsal", {timeout:900_000}, async () => {
    await rehearseNative(process.env.CONTROL_ROOM_B5_REHEARSAL_PACKET);
  });
  for(const scenario of ["interrupt","deadline","stop"] as const) test(`B5 native fixture rehearsal forced-abort ${scenario}`,{timeout:900_000},async()=>{
    await rehearseNative(process.env[`CONTROL_ROOM_B5_REHEARSAL_${scenario.toUpperCase()}_PACKET`],scenario);
  });
}
const pauseRehearsal = (signal: AbortSignal) => delay(50, undefined, { signal });

// Only the mutable request pathname retries a stable-reader publication race.
// Dispatches, observations and retained evidence keep their immutable-read policy.
async function pollRehearsalRequest(input: {
  file: string; root: string; origin: string; lastSequence: number; signal: AbortSignal; deadline: number;
  finished: () => boolean; pause: () => Promise<void>;
}) {
  while (!input.finished() && Date.now() < input.deadline) {
    input.signal.throwIfAborted();
    let bytes: Buffer;
    try { bytes = await readFirstWebsitePrivateBytesV1(input.file, input.root); }
    catch (error) {
      if (!(error instanceof B5RefusalV1) || error.code !== "B5_REVIEW_SCAN_CHANGED") throw error;
      await input.pause();
      continue;
    }
    input.signal.throwIfAborted();
    if (Date.now() >= input.deadline) break;
    const request = b5DeviceRequestSchemaV1.parse(JSON.parse(bytes.toString("utf8")));
    assert.equal(request.origin, input.origin);
    if (request.sequence !== input.lastSequence) assert.equal(request.sequence, input.lastSequence + 1);
    return request;
  }
  input.signal.throwIfAborted();
  if (Date.now() >= input.deadline) throw new Error("B5_REHEARSAL_DEADLINE");
  return undefined;
}

// This body uses the built product and its native engine carrier. Neither API
// responses nor engine state are routed, mocked, replayed or written by this test.
async function rehearseNative(file: string | undefined, scenario:"complete"|"interrupt"|"deadline"|"stop"="complete") {
  const packet=await requireFirstWebsiteRehearsalPart2V1(file);
  const root=packet.root, configFile=join(root,"config/b5.json");
  if(scenario === "complete") assert.equal(process.env.CONTROL_ROOM_B5_CONFIG,configFile,"rehearsal uses the supplied fresh config");
  const config=firstWebsiteConfigSchemaV1.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(configFile,root)).toString("utf8")));
  assert.equal(config.product.root,join(root,"product")); assert.ok(config.maxDurationMs<=600_000);
  if(scenario === "deadline") assert.ok(config.maxDurationMs<=120_000,"deadline trial uses its own short capped config");
  const qualification=JSON.parse((await readFirstWebsitePrivateBytesV1(config.a2.qualificationEvidence,root)).toString("utf8"));
  assert.equal(qualification.rehearsal.packetFile,file);
  assert.equal(qualification.rehearsal.packetSha256,b5Bytes(await readFirstWebsitePrivateBytesV1(file!,root)));
  assert.equal(qualification.providers.classification,"fixture"); assert.equal(qualification.providers.transport,"scripted");
  const browserPath=packet.browser.executablePath;
  if(browserPath) {
    const executable=await lstat(browserPath);
    assert.ok(executable.isFile() && !executable.isSymbolicLink() && executable.mode & 0o111 && !(executable.mode & 0o022) && executable.size<=512<<20);
    assert.equal(b5Bytes(await readFile(browserPath)),packet.browser.sha256,"qualified browser executable");
  }
  const {chromium,expect}=await import("@playwright/test");
  // A missing package/revision is a hard native failure, never a green skip.
  const browser=await chromium.launch({...(browserPath ? {executablePath:browserPath} : {}),timeout:20_000});
  let child:ReturnType<typeof spawn>|undefined, childDone:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined;
  let output="", stderr="", finished=false;
  let lastCard:z.infer<typeof loopCandidateCardSchemaV1>|undefined;
  let resultLabel:string|undefined;
  const contexts=new Map<string,import("@playwright/test").BrowserContext>();
  const deadline=Date.now()+config.maxDurationMs;
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(new Error("B5_REHEARSAL_DEADLINE")),config.maxDurationMs);
  const stop=()=>abort.abort(new Error("B5_REHEARSAL_INTERRUPTED"));
  process.on("SIGINT",stop);process.on("SIGTERM",stop);
  const sleep=async()=>{abort.signal.throwIfAborted();await new Promise<void>(yes=>setTimeout(yes,50));};
  try {
    for(const folder of ["pg-runs","pg-sockets"]) await mkdir(join(root,"tmp",folder),{mode:0o700});
    child=spawn(join(root,"runtime/bin/node"),["--import","tsx",join(root,"product/scripts/workflow-journeys/first-website-proof.ts"),"--config",configFile,"--evidence-dir",join(root,"evidence")],{
      cwd:join(root,"product"),env:{NODE_ENV:"test",PATH:join(root,"runtime/bin")+":/usr/bin:/bin",HOME:join(root,"home-work"),TMPDIR:join(root,"tmp"),TZ:"UTC",
        CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1",CONTROL_ROOM_PG_TEST_PORT_BASE:"60470",PG_BIN:process.env.PG_BIN,
        ATTACK_KIT_RUN_ROOT:join(root,"tmp/pg-runs"),ATTACK_KIT_SOCKET_ROOT:join(root,"tmp/pg-sockets")},stdio:["ignore","pipe","pipe"]});
    child.stdout!.on("data",b=>{output+=b.toString();if(Buffer.byteLength(output)>1<<20)abort.abort(new Error("B5_REHEARSAL_OUTPUT_CAP"));});
    child.stderr!.on("data",b=>{stderr+=b.toString();if(Buffer.byteLength(stderr)>1<<20)abort.abort(new Error("B5_REHEARSAL_OUTPUT_CAP"));});
    childDone=new Promise((yes,no)=>{child!.once("error",no);child!.once("close",(code,signal)=>{finished=true;yes({code,signal});});});
    void childDone.catch(()=>{});
    const origin="http://127.0.0.1:60460",projectId="project:b5-website",projectPath=`/projects/${encodeURIComponent(projectId)}`;
    const api=`/api/v1/projects/${encodeURIComponent(projectId)}/improvements/loop`;
    const events:z.infer<typeof b5ControllerBrowserEventsSchemaV1>["events"]=[];
    let lastSequence=0,triggered=false;
    while(!finished && Date.now()<deadline) {
      abort.signal.throwIfAborted();
      const requestFile=join(root,"device/request.json");
      const exists=await lstat(requestFile).then(()=>true,e=>{if(e.code === "ENOENT")return false;throw e;});
      if(!exists){await sleep();continue;}
      const r=await pollRehearsalRequest({file:requestFile,root,origin,lastSequence,signal:abort.signal,deadline,finished:()=>finished,pause:()=>pauseRehearsal(abort.signal)});
      if(!r)break;
      if(r.sequence === lastSequence){await sleep();continue;}
      lastSequence=r.sequence;events.length=0;
      if((scenario === "interrupt" || scenario === "deadline") && r.phase === "prepare") {
        triggered=true;
        if(scenario === "interrupt")child.kill("SIGINT");
        while(!finished)await sleep();
        break;
      }
      // Fresh session on each phase also covers both service restarts. Codes and
      // cookies remain in memory; Playwright traces/storage-state are disabled.
      let context=contexts.get(r.device);
      await context?.close();contexts.delete(r.device);
      context=await browser.newContext({viewport:{width:r.device === "phone" ? 390 : 1280,height:850},isMobile:r.device === "phone",hasTouch:r.device === "phone"});
      contexts.set(r.device,context);
      await context.route("**/*",route=>new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page=await context.newPage();page.setDefaultTimeout(20_000);
      await page.goto(origin+"/session");
      const ownerCode=await readOwnerCode(join(root,"device/owner-code.sock"));
      try {await page.getByLabel("Owner code").fill(ownerCode);await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.waitForURL(origin+"/projects");}
      catch {throw new Error("B5_BROWSER_SIGN_IN");}
      // The actual project document's two-read cookie challenge creates the
      // server observation. Screens and all later service actions follow it.
      await page.goto(origin+projectPath);await page.goto(origin+projectPath);
      const observation=JSON.parse((await readFirstWebsitePrivateBytesV1(join(root,`device/observations/${r.sequence}.json`),root)).toString("utf8"));
      const saved=origin+projectPath+"/improvements"+(r.binding ? `#request=${encodeURIComponent(r.binding.requestId)}` : "");
      await page.goto(saved);
      const post=async(name:typeof events[number]["name"],suffix:string,click:()=>Promise<void>)=>{
        const response=page.waitForResponse(res=>res.request().method() === "POST" && new URL(res.url()).pathname.endsWith(suffix));
        await click();const res=await response;assert.ok(res.ok());await res.finished();
        if (name === "intake") assertB5AcceptedIntakeV1(await res.json());
        if (name === "approve-plan" || name === "approve-spec") {
          const receipt = loopBridgeReceiptSchemaV1.parse(await res.json());
          assert.equal(receipt.state, "accepted", "B5 approval decision requires an accepted receipt");
        }
        events.push({name,method:"POST",path:new URL(res.url()).pathname,status:res.status(),at:new Date().toISOString()});
      };
      if(r.phase === "prepare") {
        await page.getByLabel("What would you like improved?").fill(B5_REQUEST_TEXT);
        await post("intake","/intake",()=>page.getByRole("button",{name:"Prepare request",exact:true}).click());
        await page.getByRole("button",{name:"Confirm this exact request",exact:true}).waitFor({timeout:60_000});
      } else if(r.phase === "confirm-start") {
        await post("confirm","/confirm",()=>page.getByRole("button",{name:"Confirm this exact request",exact:true}).click());
        await post("start","/start",()=>page.getByRole("button",{name:"Start confirmed work",exact:true}).click());
      } else if(r.phase === "question") {
        if(scenario === "stop") {
          const stopped=page.waitForResponse(res=>res.request().method() === "POST" && new URL(res.url()).pathname.endsWith("/stop"));
          await page.getByRole("button",{name:"Stop this run",exact:true}).click();assert.ok((await stopped).ok());
          triggered=true;await context.close();contexts.delete(r.device);
          while(!finished)await sleep();
          break;
        }
        await page.getByLabel("Your answer").fill("Amber");
        await post("answer","/answer",()=>page.getByRole("button",{name:"Send answer",exact:true}).click());
      } else if(r.phase === "plan" || r.phase === "spec") {
        await page.locator('[aria-label="Saved owner decision"] pre').waitFor();
        assert.ok((await page.locator('[aria-label="Saved owner decision"] pre').textContent())!.trim());
        await post(r.phase === "plan" ? "approve-plan" : "approve-spec","/approve",()=>page.getByRole("button",{name:`Approve this ${r.phase}`,exact:true}).click());
      }
      let dom:z.infer<typeof b5ControllerBrowserEventsSchemaV1>["dom"];
      if(["repair","finish","retained"].includes(r.phase)) {
        const card=page.getByRole("article",{name:"Finished candidate",exact:true});await card.waitFor();
        const response=await context.request.get(origin+api+`/${encodeURIComponent(r.binding!.requestId)}/candidate`);
        assert.equal(response.status(),200);const bytes=await response.body();assert.ok(bytes.length<=1<<20);
        const candidate=loopCandidateCardSchemaV1.parse(JSON.parse(bytes.toString("utf8")).candidate);lastCard=candidate;
        await expect(card).toContainText(candidate.candidateRevision);
        if(r.phase !== "repair") events.push({name:r.phase === "retained" ? "retained" : r.device === "phone" ? "finish-phone" : "finish-desktop",
          method:"GET",status:response.status(),path:api+`/${encodeURIComponent(r.binding!.requestId)}/candidate`,at:new Date().toISOString(),
          responseDigest:b5Bytes(bytes),recordDigest:candidate.recordDigest,candidateRevision:candidate.candidateRevision,baseRevision:candidate.evidence.binding.baseRevision});
        if(r.device === "desktop") {
          const text=await card.textContent();assert.ok(text?.includes(candidate.candidateRevision));
          assert.equal(new URL(page.url()).hash,`#request=${encodeURIComponent(r.binding!.requestId)}`);
          // DOM facts must be visible in the rendered card, not copied from a
          // server projection without checking what the browser displayed.
          assert.ok(text?.includes(candidate.evidence.binding.baseRevision));
          dom={candidateRevision:candidate.candidateRevision,baseRevision:candidate.evidence.binding.baseRevision,requestId:r.binding!.requestId};
        }
      }
      const capturePath=`captures/${r.sequence}-${r.device}.png`,png=await page.screenshot();assert.ok(png.length<=1<<20);
      await writeFile(join(root,"device",capturePath),png,{flag:"wx",mode:0o600});const capturedAt=new Date().toISOString();
      let closeAttestation: {actor:"owner";closedAt:string;allProofTabsClosed:true}|undefined;
      if(r.phase === "close") {
        await context.close();contexts.delete(r.device);
        closeAttestation={actor:"owner",closedAt:new Date().toISOString(),allProofTabsClosed:true};
      }
      const words={connect:["connected"],prepare:["prepared"],"bindings-ready":["bindings-ready-observed"],"confirm-start":["confirmed","started"],question:["answered"],plan:["plan-read","plan-approved"],spec:["spec-read","spec-approved"],close:["closed"],repair:["repair-observed"],finish:["finished"],retained:["retained-read"]};
      const receipt=b5DeviceReceiptSchemaV1.parse({...r,observation,observedAt:new Date().toISOString(),real:false,browser:`Chromium/${browser.version()}`,actions:words[r.phase],
        captures:[{path:capturePath,sha256:b5Bytes(png),device:r.device,sequence:r.sequence,sessionNonce:r.sessionNonce,capturedAt}],...(closeAttestation ? {closeAttestation} : {})});
      await mkdir(join(root,"device/service"),{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});
      await writeFile(join(root,`device/service/${r.sequence}.json`),JSON.stringify({sequence:r.sequence,events,...(dom ? {dom} : {})})+"\n",{flag:"wx",mode:0o600});
      await writeB5DeviceReceiptV1(join(root,`device/inbox/${r.sequence}.json`),receipt);
    }
    const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((yes,no)=>{
      const cancel=()=>no(new Error("B5_REHEARSAL_DEADLINE"));abort.signal.addEventListener("abort",cancel,{once:true});
      if(abort.signal.aborted)cancel();
      void childDone!.then(yes,no).finally(()=>abort.signal.removeEventListener("abort",cancel));
    });
    assert.deepEqual(result,{code:1,signal:null});assert.doesNotMatch(output,/OK: disposable website proof complete/u);
    const evidence=join(root,"evidence"),verdict=JSON.parse((await readFirstWebsitePrivateBytesV1(join(evidence,"controller-verdict.json"),root)).toString("utf8"));
    assert.equal(verdict.state,"incomplete");
    if(scenario !== "complete") {
      assert.equal(triggered,true,"real acquired-host abort barrier was reached");
      const reason={interrupt:"B5_INTERRUPTED",deadline:"B5_DEADLINE",stop:"B5_OWNER_STOP"}[scenario];
      assert.ok(verdict.reasons.includes(reason));assert.match(output,new RegExp(`FAILED: ${reason}; proof retained`));
      assert.equal(verdict.transportCleanup.disposition,"mapping-not-created");assert.equal(verdict.transportCleanup.hostStopped,true);assert.equal(verdict.transportCleanup.postgresStopped,true);assert.deepEqual(verdict.transportCleanup.failures,[]);
      resultLabel=`RESULT: PASS native rehearsal ${scenario} actual CLI verdict=${reason}; owned host, browser and PostgreSQL closed`;
      return;
    }
    assert.match(output,/FAILED: B5_PROVIDER_FIXTURE; proof retained/u);
    assert.deepEqual(new Set(verdict.reasons),new Set(["B5_PROVIDER_FIXTURE","B5_PHONE_EVIDENCE_MISSING","B5_DESKTOP_EVIDENCE_MISSING",...(qualification.capture.approval === "approved" ? [] : ["B5_CAPTURE_MODE_UNAPPROVED"])]));
    assert.equal(verdict.transportCleanup.disposition,"mapping-not-created");assert.equal(verdict.transportCleanup.hostStopped,true);assert.equal(verdict.transportCleanup.postgresStopped,true);assert.deepEqual(verdict.transportCleanup.failures,[]);
    const manifest=b5ManifestSchemaV1.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(join(evidence,"manifest.json"),root)).toString("utf8")));
    for(const artifact of manifest.artifacts) {const bytes=await readFirstWebsitePrivateBytesV1(join(evidence,artifact.path),root);assert.equal(bytes.length,artifact.bytes);assert.equal(b5Bytes(bytes),artifact.sha256);}
    for(const route of ["codex-job","claude-job","marvin-job"]) assert.ok(manifest.artifacts.some(a=>a.path === `b5-real-exec-denial-${route}.json`));
    const journey=b5JourneySchemaV1.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(join(evidence,"journey.json"),root)).toString("utf8")));
    assert.deepEqual(journey.restarts.map(r=>r.phase),["waiting","final"]);assert.equal(journey.closed.length,2);
    assert.ok(journey.steps.some(s=>s.verdict === "NEEDS-FIX"));assert.ok(journey.steps.some(s=>s.role === "final" && s.verdict === "CLEAN"));
    assert.ok(lastCard);await nativeEvidenceNegatives(root,config,qualification,lastCard);
    resultLabel="RESULT: B5-REHEARSAL-GREEN real engine/PG/browser/CLI/cold-card joins; providers and devices fixture; child exit=1 B5_PROVIDER_FIXTURE";
  } finally {
    clearTimeout(timer);process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);
    for(const context of contexts.values())await context.close().catch(()=>{});
    const browserClosed=await browser.close().then(()=>true,()=>false);
    if(child && !finished) {
      child.kill("SIGINT");let grace:ReturnType<typeof setTimeout>|undefined;
      try {await Promise.race([childDone,new Promise<never>((_,no)=>{grace=setTimeout(()=>{child!.kill("SIGKILL");no(new Error("B5_NATIVE_CLEANUP_UNCONFIRMED"));},180_000);})]);}
      finally {clearTimeout(grace);await childDone;}
    }
    assert.equal(browserClosed,true,"B5_BROWSER_CLEANUP_INCOMPLETE");
    if(resultLabel)console.log(resultLabel);
  }
}
async function readOwnerCode(path:string) {
  const info=await lstat(path);assert.ok(info.isSocket());assert.equal(info.uid,process.getuid?.());assert.equal(info.mode & 0o777,0o600);
  return new Promise<string>((yes,no)=>{const socket=createConnection(path);let text="";
    socket.setTimeout(5000,()=>socket.destroy(new Error("B5_OWNER_CHANNEL_TIMEOUT")));
    socket.on("data",bytes=>{text+=bytes.toString();if(text.length>256)socket.destroy(new Error("B5_OWNER_CHANNEL_CAP"));});
    socket.once("error",()=>no(new Error("B5_OWNER_CHANNEL_UNAVAILABLE")));socket.once("end",()=>{socket.destroy();if(/^[A-Za-z0-9_-]{43}\n$/u.test(text))yes(text.trim());else no(new Error("B5_OWNER_CHANNEL_INVALID"));});});
}

/** These refusals use the actual retained bytes and the card read above. They
 * do not claim a second live-card qualification after the host has stopped.
 * Proof files and the retained repository remain immutable throughout. */
async function nativeEvidenceNegatives(root:string, config:z.infer<typeof firstWebsiteConfigSchemaV1>,
  qualification:{providers:unknown;capture:unknown;contamination:unknown},card:z.infer<typeof loopCandidateCardSchemaV1>) {
  const H=await import("./helpers/improve-control-room-first-website");
  const dir=join(root,"evidence");
  const json=async(path:string)=>JSON.parse((await readFirstWebsitePrivateBytesV1(join(dir,path),root)).toString("utf8"));
  const manifest=H.b5ManifestSchemaV1.parse(await json("manifest.json")),journey=H.b5JourneySchemaV1.parse(await json("journey.json"));
  const teardown=H.b5TeardownSchemaV1.parse(await json("teardown.json"));
  const snapshot=H.b5DatabaseSnapshotSchemaV1.parse(await json("database-snapshot.json"));
  const digests=readControllerStartDigests((await json("controller-start.json")).preflightDigests);
  const pins:import("./helpers/improve-control-room-first-website").B5QualifiedPinsV1={productBase:config.product.baseRevision,productHead:config.product.candidateRevision,
    toolingRevision:config.a2.toolingRevision,schemaDigest:config.a2.schemaDigest,uid:process.getuid!(),digests,
    providers:H.qualifyB5ProvidersV1(qualification.providers,config.a2.toolingRevision,digests.availability),capture:H.b5CaptureQualificationSchemaV1.parse(qualification.capture)};
  const artifacts=new Map<string,Uint8Array>();
  for(const entry of manifest.artifacts)artifacts.set(entry.path,await readFirstWebsitePrivateBytesV1(join(dir,entry.path),root));
  const action=(j:typeof journey)=>H.assertB5ActionEvidenceV1(j,card,teardown,artifacts,pins);
  action(journey);H.assertRealChainV1(manifest,card,snapshot,journey,pins);H.assertRejectionRepairV1(manifest,journey);
  assert.deepEqual(H.assertB5ProviderProvenanceV1(manifest,journey,pins),["B5_PROVIDER_FIXTURE"]);
  const label=structuredClone(manifest);label.classification.providers="real";
  assert.throws(()=>H.assertB5ProviderProvenanceV1(label,journey,pins),{code:"B5_PROVIDER_PROVENANCE_MISMATCH"});
  const realPins=structuredClone(pins);realPins.providers.classification="real";realPins.providers.transport="real-provider";
  assert.throws(()=>H.assertB5ProviderProvenanceV1(manifest,journey,realPins),{code:"B5_PROVIDER_PROVENANCE_MISMATCH"});
  const missing={...manifest,classification:{...manifest.classification,providers:undefined}};
  assert.equal(H.b5ManifestSchemaV1.safeParse(missing).success,false);
  const devices=structuredClone(journey);for(const d of devices.devices)d.real=true;
  assert.deepEqual(H.assertB5ProviderProvenanceV1(manifest,devices,pins),["B5_PROVIDER_FIXTURE"]);
  const partial=structuredClone(journey);partial.actions=partial.actions.slice(0,2);
  assert.throws(()=>action(partial),{code:"B5_ACTION_EVIDENCE"});
  const swapped=structuredClone(journey);swapped.serviceFacts[0]!.device="desktop";
  assert.throws(()=>action(swapped),{code:"B5_ACTION_EVIDENCE"});
  const wrong=structuredClone(journey);wrong.serviceFacts[0]!.candidateRevision=manifest.heads.rejected;
  assert.throws(()=>action(wrong),{code:"B5_CAPTURE_CORRELATION"});
  const request=structuredClone(journey);request.actions[0]!.requestId="wrong-request";
  assert.throws(()=>action(request),{code:"B5_ACTION_EVIDENCE"});
  const duplicate=structuredClone(journey);duplicate.actions[2]!.sequence=duplicate.actions[0]!.sequence;
  assert.throws(()=>action(duplicate),{code:"B5_ACTION_EVIDENCE"});
  const closure=structuredClone(journey);closure.closed.pop();assert.equal(H.b5JourneySchemaV1.safeParse(closure).success,false);
  const early=structuredClone(teardown);early.retainedRead!.at=new Date(Date.parse(early.cleanupAt)-1).toISOString();
  assert.throws(()=>H.assertCleanupRetainedV1(early,card,snapshot,manifest.timestamps.finishedAt),{code:"B5_CLEANUP_RETAINED"});
  await assert.rejects(H.verifyFirstWebsiteEvidenceV1(dir,{candidateRepository:join(root,"work/repo"),pins,
    readCard:async()=>{try{return await fetch(config.device.origin+"/api/v1/loop-update-candidates",{signal:AbortSignal.timeout(1000)});}catch{return null;}}}),{code:"B5_CARD_UNAVAILABLE"});
  const policy=H.b5FaultScanPolicySchemaV1.parse((qualification.contamination as {scanPolicy:unknown}).scanPolicy);
  const surfaces=await H.readB5ReviewGitSurfacesV1(join(root,"work/repo"),manifest.heads.base,manifest.heads.final);
  const run=JSON.parse((await readFirstWebsitePrivateBytesV1(join(root,"runs",card.evidence.binding.loopRunId,"run.json"),root)).toString("utf8"));
  const build=run.steps.find((s:{role:string})=>s.role === "build");assert.ok(build?.report_snapshot);
  const builderReport=await readFirstWebsitePrivateBytesV1(build.report_snapshot.path,root);
  assert.equal(b5Bytes(builderReport),`sha256:${build.report_snapshot.sha256}`);
  for(const kind of ["builder-report","diff","changed-file-new"]) {
    const source=kind === "builder-report" ? builderReport : surfaces.find(s=>s.kind === kind)?.bytes;
    assert.ok(source);H.assertB5FaultTextAbsentV1(source,policy);
    assert.throws(()=>H.assertB5FaultTextAbsentV1(Buffer.concat([Buffer.from(source),Buffer.from("\n/* TODO: "+policy.sentinel+" */")]),policy),{code:"B5_REVIEW_CONTAMINATED"});
    H.assertB5FaultTextAbsentV1(source,policy);
  }
  action(journey);assert.deepEqual(H.assertB5ProviderProvenanceV1(manifest,journey,pins),["B5_PROVIDER_FIXTURE"]);
  console.log("RESULT: PASS retained native evidence refuses provider relabelling, missing discriminator, device promotion, action/capture/order and contamination negatives; proof bytes unchanged");
}


test("B5 browser intake requires accepted state even for HTTP 202", () => {
  const receipt = { schemaVersion: 1, requestId: "request:synthetic", localVersion: 1,
    commandId: "loop-command:" + "a".repeat(32), state: "accepted", replayed: false, engineRevision: 1, error: null };
  assert.equal(assertB5AcceptedIntakeV1(receipt).state, "accepted");
  for (const state of ["uncertain", "refused", "waiting"]) {
    assert.throws(() => assertB5AcceptedIntakeV1({ ...receipt, state,
      error: state === "uncertain" ? "LAUNCH_UNCERTAIN" : state === "refused" ? "REFUSED" : null }),
      new RegExp(state === "refused" ? "B5_ENGINE_REFUSED" : "B5_INTAKE_UNCERTAIN"));
  }
  console.log("RESULT: PASS B5 browser intake rejects HTTP-success uncertain/refused/waiting states");
});

// Evidence projection maps back to the internal pin names only after parsing.
function readControllerStartDigests(value: unknown): Record<string, string> {
  const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
  const { authorizationSha256, ...otherDigests } = z.object({ authorizationSha256: digest }).catchall(digest).parse(value);
  return { ...otherDigests, authorization: authorizationSha256 };
}

test("B5 controller-start consumer restores every internal preflight pin", () => {
  const digests = Object.fromEntries(["authorization", "settings", "availability", "qualification", "assembly", "faultInput", "reviewInput", "transport"]
    .map(name => [name, b5Bytes(`synthetic ${name}`)]));
  const start = projectB5ControllerStartV1({ digests, startedAt: "2026-11-03T00:00:00.000Z", maxDurationMs: 60_000,
    rehearsal: true, captureMode: "fixture-browser-loopback" });
  assert.deepEqual(readControllerStartDigests(JSON.parse(JSON.stringify(start)).preflightDigests), digests);
  assert.throws(() => readControllerStartDigests(digests), z.ZodError);
});

async function requestPollFixture(t: test.TestContext) {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await realpath(await mkdtemp(resolve(".test-tmp/b5-request-poll-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "request.json"), pending = join(root, "pending.json"), abort = new AbortController();
  const generation = (sequence: number) => ({ schemaVersion: 1, sessionNonce: "a".repeat(32), sequence, phase: "close",
    origin: "http://127.0.0.1:60460", device: "desktop", expiresAt: "2026-11-03T01:00:00.000Z" });
  await writeFile(file, JSON.stringify(generation(1)), { mode: 0o600 });
  const handle = await open(file, "r"), prototype = Object.getPrototypeOf(handle), read = handle.read;
  await handle.close();
  let replacements = 0, armed = false;
  // Real descriptor read, then a real atomic replacement before the final pathname check.
  t.mock.method(prototype, "read", async function (this: typeof handle, ...args: unknown[]) {
    const result = await Reflect.apply(read, this, args);
    if (armed) { armed = false; await rename(pending, file); replacements++; }
    return result;
  });
  const replaceDuringRead = async (next: unknown = generation(2)) => {
    await writeFile(file, JSON.stringify(generation(1)), { mode: 0o600 });
    await writeFile(pending, typeof next === "string" ? next : JSON.stringify(next), { mode: 0o600 });
    armed = true;
  };
  const input = { file, root, origin: generation(1).origin, lastSequence: 1, signal: abort.signal,
    deadline: Date.now() + 60_000, finished: () => false, pause: async () => {} };
  return { file, root, abort, generation, replaceDuringRead, input, replacements: () => replacements };
}

test("B5 request poll retries an atomic publication and revalidates the next generation", async t => {
  const f = await requestPollFixture(t);
  await f.replaceDuringRead();
  await assert.rejects(readFirstWebsitePrivateBytesV1(f.file, f.root), { code: "B5_REVIEW_SCAN_CHANGED" });
  await f.replaceDuringRead();
  let pauses = 0;
  const request = await pollRehearsalRequest({ ...f.input, pause: async () => { pauses++; } });
  assert.deepEqual(request, f.generation(2)); assert.equal(pauses, 1); assert.equal(f.replacements(), 2);
  for (const next of [{ ...f.generation(2), origin: "http://127.0.0.1:60461" }, { ...f.generation(2), sequence: 3 }]) {
    await f.replaceDuringRead(next);
    await assert.rejects(pollRehearsalRequest(f.input), { code: "ERR_ASSERTION" });
  }
});

test("B5 request poll obeys cancellation and the existing deadline during publication retry", async t => {
  const f = await requestPollFixture(t);
  const stopped = new Error("synthetic cancellation");
  await f.replaceDuringRead();
  await assert.rejects(pollRehearsalRequest({ ...f.input, pause: async () => {
    const paused = pauseRehearsal(f.abort.signal); f.abort.abort(stopped); await paused;
  } }), { name: "AbortError" });
  await assert.rejects(pollRehearsalRequest(f.input), stopped);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await f.replaceDuringRead();
  const input = { ...f.input, signal: new AbortController().signal, deadline: Date.now() + 10,
    pause: async () => { t.mock.timers.tick(11); } };
  const before = f.replacements();
  await assert.rejects(pollRehearsalRequest(input), /B5_REHEARSAL_DEADLINE/u);
  assert.equal(f.replacements(), before + 1, "expired retry never reopens the next generation");
});

test("B5 request poll propagates pathname, symlink, custody, parse and schema errors", async t => {
  const f = await requestPollFixture(t);
  let pauses = 0;
  const input = { ...f.input, pause: async () => { pauses++; } };
  await assert.rejects(pollRehearsalRequest({ ...input, file: resolve(f.root, "../outside.json") }), { code: "B5_REVIEW_SCAN_PATH" });
  const link = join(f.root, "link.json"); await symlink(f.file, link);
  await assert.rejects(pollRehearsalRequest({ ...input, file: link }), { code: "B5_REVIEW_SCAN_PATH" });
  const { chmod } = await import("node:fs/promises"); await chmod(f.file, 0o666);
  await assert.rejects(pollRehearsalRequest(input), { code: "B5_REVIEW_SCAN_PATH" }); await chmod(f.file, 0o600);
  // Also reject malformed and schema-invalid *replacement* generations after a retry.
  await f.replaceDuringRead("{");
  await assert.rejects(pollRehearsalRequest(input), SyntaxError);
  await f.replaceDuringRead({ ...f.generation(2), phase: "invalid" });
  await assert.rejects(pollRehearsalRequest(input), z.ZodError);
  assert.equal(pauses, 2, "only the two actual publication races paused");
  await rm(f.file);
  await assert.rejects(pollRehearsalRequest(input), { code: "B5_REVIEW_SCAN_PATH" });
});
