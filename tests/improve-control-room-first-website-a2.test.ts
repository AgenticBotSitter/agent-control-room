import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const producer = resolve(process.env.CONTROL_ROOM_B5_PREP_TEST_PRODUCER ?? "scripts/workflow-journeys/first-website-stage.py");
test("B5 producer refuses a non-disposable root before reading sources", () => {
  const result = spawnSync("python3", ["-I", "-B", producer, "--root", "/not-a-b5-root"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /B5_ROOT_NAME/);
});

import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { b5LineageV1, b5RawHash, loadB5A2V1, projectB5RunV1, requireB5FinalProjectionV1, joinB5FinalProjectionV1 } from "./helpers/improve-control-room-first-website-a2";
import { B5RefusalV1 } from "./helpers/improve-control-room-first-website";
import type { LoopEngineStatusV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { readB5RunWithRetryV1 } from "../scripts/workflow-journeys/first-website-controller";

async function scratch(t: test.TestContext) {
  await mkdir(".test-tmp", { recursive: true });
  const root = await realpath(await mkdtemp(resolve(".test-tmp/f03-")));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function python(code: string, args: string[] = [], executable = "python3") {
  const prelude = `import importlib.util, sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('b5_producer', sys.argv[1])\nb5=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(b5)\n`;
  return spawnSync(executable, ["-I", "-B", "-c", prelude + code, producer, ...args], { encoding: "utf8", timeout: 120_000 });
}
function passed(result: ReturnType<typeof python>) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RESULT: PASS/);
}

test("B5 exclusive root refuses existing directory, file and dangling link without changing sentinels", async t => {
  const parent = await scratch(t);
  passed(python(`
import os
parent=Path(sys.argv[2])
for kind in ('dir','file','link'):
 root=parent/('acr-b5-'+kind)
 if kind=='dir':
  root.mkdir(); (root/'sentinel').write_bytes(b'keep')
 elif kind=='file': root.write_bytes(b'keep')
 else: root.symlink_to(parent/'missing')
 try: b5.exclusive_root(root)
 except ValueError as e: assert str(e)=='B5_ROOT_EXISTS', str(e)
 else: raise AssertionError('existing root accepted')
 if kind=='dir': assert (root/'sentinel').read_bytes()==b'keep'
 elif kind=='file': assert root.read_bytes()==b'keep'
 else: assert root.is_symlink() and os.readlink(root)==str(parent/'missing')
print('RESULT: PASS existing roots and sentinel bytes')
`, [parent]));
});

test("B5 exclusive create has one winner under 24 concurrent callers", async t => {
  const parent = await scratch(t);
  passed(python(`
import multiprocessing as mp, os
root=Path(sys.argv[2])/'acr-b5-collision'
barrier=mp.get_context('fork').Barrier(24)
queue=mp.get_context('fork').Queue()
def attempt():
 original_mkdir=os.mkdir
 def contended_mkdir(path,mode):
  barrier.wait(timeout=20) # all 24 passed lexists before any actual mkdir
  return original_mkdir(path,mode)
 b5.os.mkdir=contended_mkdir
 try: b5.exclusive_root(root); queue.put('winner')
 except ValueError as e: queue.put(str(e))
children=[mp.get_context('fork').Process(target=attempt) for _ in range(24)]
try:
 for p in children: p.start()
 results=[queue.get(timeout=30) for _ in children]
 for p in children: p.join(timeout=10); assert p.exitcode==0
 assert results.count('winner')==1, results
 assert results.count('B5_ROOT_EXISTS')==23, results
 assert root.stat().st_mode & 0o777 == 0o700
 print('RESULT: PASS 24 contended exclusive creates, 1 winner, 23 refusals')
finally:
 for p in children:
  if p.is_alive(): p.terminate()
  p.join(timeout=10)
 queue.close(); queue.join_thread()
`, [parent]));
});

test("B5 custody detects root and parent replacement, aliases, unsafe modes and Git parents", async t => {
  const parent = await scratch(t);
  passed(python(`
import os
parent=Path(sys.argv[2]); root=parent/'acr-b5-custody'
b5.exclusive_root(root)
c=b5.Custody.__new__(b5.Custody)
c.parent=parent; c.root=root
c.parent_identity=c.identity(parent); c.root_identity=c.identity(root)
c.check()
root.rename(parent/'old-root'); root.mkdir(mode=0o700)
try: c.check()
except ValueError as e: assert str(e)=='B5_CUSTODY_CHANGED'
else: raise AssertionError('root replacement accepted')
c.root_identity=c.identity(root)
parent.rename(parent.with_name(parent.name+'-moved')); parent.mkdir(mode=0o700)
try:
 try: c.check()
 except ValueError as e: assert str(e)=='B5_CUSTODY_CHANGED'
 else: raise AssertionError('parent replacement accepted')
finally:
 parent.rmdir(); parent.with_name(parent.name+'-moved').rename(parent)
parent.chmod(0o777)
try:
 try: b5.Custody(parent, parent/'acr-b5-mode')
 except ValueError as e: assert str(e)=='B5_PARENT_CUSTODY'
 else: raise AssertionError('writable parent accepted')
finally: parent.chmod(0o700)
try: b5.Custody(parent, parent/'acr-b5-git')
except ValueError as e: assert str(e)=='B5_PARENT_GIT'
else: raise AssertionError('Git parent accepted')
assert not (parent/'acr-b5-git').exists()
alias=parent/'alias'; alias.symlink_to(root)
try: b5.path_check(alias, directory=True)
except ValueError as e: assert str(e)=='B5_SYMLINK'
else: raise AssertionError('alias accepted')
print('RESULT: PASS custody replacement and path/mode/Git refusals')
`, [parent]));
});

test("B5 imports are inert and missing preparation inputs refuse before acquisition", () => {
  passed(python("print('RESULT: PASS import inert')"));
  const result = spawnSync("python3", ["-I", "-B", producer, "--root", "/acr-b5-no-inputs"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), "B5_INPUTS_REQUIRED");
});

test("B5 lineage binds revision, exact confirmation path and both independent input hashes", () => {
  const toolingRevision = `sha256:${"a".repeat(64)}`;
  const lineage = b5LineageV1(toolingRevision);
  const run = { adapterId: "adapter:a2-local", loopRunId: "b5-fixture", toolingRevision, a2SchemaVersion: 1 as const };
  const input = { description: "fixture request", settingsText: "{}", requestSha256: b5RawHash("fixture request"), settingsSha256: b5RawHash("{}") };
  const observation = { inputVersion: 1, revision: 0, settingsDigest: input.settingsSha256,
    confirmation: { path: "docs/request-source.md", sha256: input.requestSha256, at: "2026-10-31T00:00:00.000Z", who: "owner" as const, input_version: 1 } };
  assert.equal(lineage.matchesSavedInput(run, observation, input), true);
  assert.equal(lineage.matchesSavedInput({ ...run, toolingRevision: `sha256:${"b".repeat(64)}` }, observation, input), false);
  for (const key of ["requestSha256", "settingsSha256"] as const) assert.equal(lineage.matchesSavedInput(run, observation, { ...input, [key]: "0".repeat(64) }), false);
  assert.equal(lineage.matchesSavedInput(run, { ...observation, settingsDigest: "0".repeat(64) }, input), false);
  assert.equal(lineage.matchesSavedInput(run, { ...observation, confirmation: { ...observation.confirmation, path: "request.md" } }, input), false);
  assert.equal(lineage.matchesSavedInput(run, { ...observation, confirmation: { ...observation.confirmation, sha256: "0".repeat(64) } }, input), false);
  assert.throws(() => lineage.decodeRunIdentity({ ...run, a2SchemaVersion: 2 }));
  assert.throws(() => lineage.decodeObservation({ ...observation, revision: -1 }));
});

async function projectionFixture(t: test.TestContext) {
  const parent = await scratch(t), root = join(parent, "acr-b5-projection"), runId = "b5-fixture";
  const work = join(root, "lead/reports/loop", runId), runFolder = join(root, "runs", runId);
  for (const p of [join(work, "docs"), runFolder, join(root, "work/repo"), join(root, "lead/state")]) await mkdir(p, { recursive: true, mode: 0o700 });
  const toolingRevision = `sha256:${"a".repeat(64)}`, baseline = "b".repeat(40);
  const saved = { requestId: "request:fixture", runLinkId: "link:fixture", localVersion: 1, inputVersion: 1,
    description: "fixture request", settingsText: "{}", requestSha256: b5RawHash("fixture request"), settingsSha256: b5RawHash("{}") };
  await writeFile(join(work, "docs/request-source.md"), saved.description, { mode: 0o600 });
  const raw: any = { run: runId, work, clone: work, base_sha: "", input_version: 1, steps: [],
    chain: { revision: 0, settings_source_sha256: saved.settingsSha256, consumed_results: [], rejections: [] } };
  const status: LoopEngineStatusV1 = { run: { adapterId: "adapter:a2-local", loopRunId: runId, toolingRevision, a2SchemaVersion: 1 },
    revision: 0, inputVersion: 1, description: saved.description, settingsSha256: saved.settingsSha256, settingsDigest: saved.settingsSha256,
    state: "draft", confirmation: null, approval: null, question: null, progress: { step: "orchestrator", completed: 0, attention: "none" }, receipts: [] };
  const emitted: any = { run: runId, revision: 0, steps: [] };
  const file = join(runFolder, "run.json");
  const save = () => writeFile(file, JSON.stringify(raw), { mode: 0o600 });
  await save();
  const input = { root, runId, toolingRevision, baseline, saved,
    runLink: { projectId: "project:fixture", requestId: saved.requestId, initialInputVersion: 1, run: status.run },
    adapter: { contract: b5LineageV1(toolingRevision), status: async () => structuredClone(status) }, readChainStatus: async () => emitted };
  return { input, raw, status, emitted, file, save, work, root };
}

test("B5 draft and adopted projections use real saved work/clone names and keep missing evidence absent (fixtures)", async t => {
  const f = await projectionFixture(t);
  const draft = await projectB5RunV1(f.input);
  await assert.rejects(joinB5FinalProjectionV1(f.input), /B5_A2_LATER_PHASE_EVIDENCE_REQUIRED/);
  assert.equal(draft.workDir, f.work); assert.equal(draft.repository, f.work);
  assert.throws(() => requireB5FinalProjectionV1(draft), /B5_A2_LATER_PHASE_EVIDENCE_REQUIRED/);
  assert.equal(draft.finalHead, null); assert.equal(draft.cleanup, null); assert.equal(draft.base, null);
  f.raw.clone = join(f.root, "work/repo"); f.raw.base_sha = f.input.baseline;
  f.raw.chain.inputs = { entries: { candidate: { head: "c".repeat(40) } } };
  await f.save();
  const adopted = await projectB5RunV1(f.input);
  assert.equal(adopted.repository, join(f.root, "work/repo")); assert.equal(adopted.base, f.input.baseline);
  assert.equal(adopted.candidateHeadUnverified, "c".repeat(40)); assert.equal(adopted.finalHead, null);
});

test("B5 projection refuses escaped run/brief paths, duplicate JSON, stale revisions and mismatched saved links", async t => {
  const f = await projectionFixture(t);
  await assert.rejects(projectB5RunV1({ ...f.input, runId: "../escape" }), /B5_A2_RUN_ID/);
  await assert.rejects(projectB5RunV1({ ...f.input, saved: { ...f.input.saved, inputVersion: 2 } }), /B5_A2_INPUT_VERSION/);
  await assert.rejects(projectB5RunV1({ ...f.input, saved: { ...f.input.saved, description: "changed" } }), /B5_A2_INPUT_VERSION/);
  await assert.rejects(projectB5RunV1({ ...f.input, runLink: { ...f.input.runLink, requestId: "request:wrong" } }), /B5_A2_SAVED_LINK/);
  f.raw.chain.revision = 1; await f.save();
  await assert.rejects(projectB5RunV1(f.input), /B5_A2_REVISION/);
  f.raw.chain.revision = 0;
  f.raw.steps = [{ n: 1, role: "build", model: "fixture", brief: join(f.root, "outside.md"), log: "fixture.log", input_version: 1,
    head_at_start: f.input.baseline, started_epoch: 1 }];
  await writeFile(join(f.root, "lead/state/jobs.tsv"), "id\tlog\tstate\tended\n", { mode: 0o600 });
  await f.save();
  await assert.rejects(projectB5RunV1(f.input), /B5_A2_BRIEF_PATH/);
  await writeFile(f.file, '{"run":"first","run":"second"}', { mode: 0o600 });
  await assert.rejects(projectB5RunV1(f.input), /json_duplicate_key/);
});

test("B5 projection detects a changing run and does not use display-only times (fixtures)", async t => {
  const f = await projectionFixture(t);
  const input = { ...f.input, readChainStatus: async () => { f.raw.changed = true; await f.save(); return f.emitted; } };
  await assert.rejects(projectB5RunV1(input), /B5_A2_CHANGED/);
});

test("B5 projection prioritizes a newer chain revision over an appended-step mismatch", async t => {
  const f = await projectionFixture(t);
  const input = { ...f.input, readChainStatus: async () => ({ ...f.emitted, revision: 1,
    steps: [{ n: 1, role: "build", stale: false, state: "running" }] }) };
  await assert.rejects(projectB5RunV1(input), /^Error: B5_A2_REVISION$/);
});

async function appendProjectionStep(f: Awaited<ReturnType<typeof projectionFixture>>) {
  const brief = join(f.work, "step-1.md");
  await writeFile(brief, "Fixture build brief", { mode: 0o600 });
  await writeFile(join(f.root, "lead/state/jobs.tsv"), "id\tlog\tstate\tended\nfixture-job\tfixture.log\tRUNNING\t\n", { mode: 0o600 });
  f.raw.steps.push({ n: 1, role: "build", model: "fixture", brief, log: "fixture.log", input_version: 1,
    head_at_start: f.input.baseline, started_epoch: 1 });
  f.emitted.steps.push({ n: 1, role: "build", stale: false, state: "running" });
  await f.save();
}

for (const advanceRevision of [true, false]) {
  test(`B5 controller retries an appended step and succeeds (revision advances: ${advanceRevision})`, async t => {
    const f = await projectionFixture(t);
    let reads = 0, pauses = 0;
    const failures: string[] = [];
    const input = { ...f.input, readChainStatus: async () => {
      if (++reads === 1) {
        await appendProjectionStep(f);
        if (advanceRevision) {
          f.status.revision = f.raw.chain.revision = f.emitted.revision = 1;
          await f.save();
        }
      }
      return f.emitted;
    } };
    const projection = await readB5RunWithRetryV1({ signal: new AbortController().signal,
      read: async () => {
        try { return await projectB5RunV1(input); }
        catch (error) { failures.push((error as Error).message); throw error; }
      }, pause: async () => { pauses++; } });
    assert.deepEqual(failures, ["B5_A2_CHANGED"]);
    assert.equal(reads, 2); assert.equal(pauses, 1);
    assert.equal(projection.steps.length, 1); assert.equal(projection.steps[0].role, "build");
    assert.equal(projection.engineRevision, advanceRevision ? 1 : 0);
  });
}

for (const mismatch of ["count", "number", "role"] as const) {
  test(`B5 unchanged step ${mismatch} mismatch refuses without retry`, async t => {
    const f = await projectionFixture(t);
    await appendProjectionStep(f);
    if (mismatch === "count") f.emitted.steps = [];
    if (mismatch === "number") f.emitted.steps[0].n = 2;
    if (mismatch === "role") f.emitted.steps[0].role = "code-review";
    const before = await readFile(f.file);
    let reads = 0, pauses = 0;
    await assert.rejects(readB5RunWithRetryV1({ signal: new AbortController().signal,
      read: () => { reads++; return projectB5RunV1(f.input); },
      pause: async () => { pauses++; } }), /^Error: B5_A2_STEP_JOIN$/);
    assert.equal(reads, 1); assert.equal(pauses, 0);
    assert.deepEqual(await readFile(f.file), before);
  });
}

for (const failure of ["B5_A2_CHANGED", "B5_A2_REVISION"] as const) {
  test(`B5 controller persistent ${failure} stops after three projection attempts`, async t => {
    const f = await projectionFixture(t);
    let reads = 0, pauses = 0;
    const input = { ...f.input, readChainStatus: async () => {
      reads++;
      if (failure === "B5_A2_CHANGED") {
        f.raw.chain.revision++;
        f.status.revision = f.raw.chain.revision;
        await f.save();
      }
      return { ...f.emitted, revision: f.raw.chain.revision + 1,
        steps: [{ n: 1, role: "build", stale: false, state: "running" }] };
    } };
    await assert.rejects(readB5RunWithRetryV1({ signal: new AbortController().signal,
      read: () => projectB5RunV1(input), pause: async () => { pauses++; } }),
    { message: failure });
    assert.equal(reads, 3); assert.equal(pauses, 2);
  });
}

test("B5 controller projection retry respects cancellation before and between attempts", async () => {
  for (const preAborted of [true, false]) {
    const abort = new AbortController(), reason = new Error("fixture cancelled");
    let reads = 0, pauses = 0;
    if (preAborted) abort.abort(reason);
    await assert.rejects(readB5RunWithRetryV1({ signal: abort.signal,
      read: async () => { reads++; throw new Error("B5_A2_CHANGED"); },
      pause: async () => { pauses++; abort.abort(reason); } }), error => error === reason);
    assert.equal(reads, preAborted ? 0 : 1); assert.equal(pauses, preAborted ? 0 : 1);
  }
});

test("B5 loader refuses module bytes before import and refuses missing cleanup (no private tools)", async t => {
  const parent = await scratch(t), root = join(parent, "acr-b5-loader");
  await mkdir(join(root, "config"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "tools/loop/bridge"), { recursive: true, mode: 0o700 });
  const module = join(root, "tools/loop/bridge/a2-contract.mjs");
  await writeFile(module, 'throw new Error("IMPORT_MUST_NOT_RUN");', { mode: 0o600 });
  const carrier: any = { modulePath: module, moduleSha256: "0".repeat(64), configuration: {
    toolingRevision: `sha256:${"a".repeat(64)}`, interpreter: "/not-read", interpreterSha256: "0".repeat(64),
    toolingManifest: "/not-read", settingsFile: "/not-read", settingsSha256: "0".repeat(64), availabilityFile: "/not-read", availabilitySha256: "0".repeat(64) },
    finalization: "cleanup", recovery: true, monitoring: true, intakeDriver: true, qualifiedOperations: [] };
  const file = join(root, "config/contract-cleanup.json");
  await writeFile(file, JSON.stringify(carrier), { mode: 0o600 });
  await assert.rejects(loadB5A2V1(root, "0".repeat(64)), /B5_A2_MODULE_PIN/);
  for (const flag of [undefined, false]) {
    const missing = { ...carrier, intakeDriver: flag };
    await writeFile(file, JSON.stringify(missing), { mode: 0o600 });
    await assert.rejects(loadB5A2V1(root, "0".repeat(64)), /intakeDriver/);
  }
  carrier.finalization = "retain";
  await writeFile(file, JSON.stringify(carrier), { mode: 0o600 });
  await assert.rejects(loadB5A2V1(root, "0".repeat(64)), /cleanup/);
});

test("B5 producer accepts only approved staged recipe bindings", async t => {
  const parent = await scratch(t);
  passed(python(`
import copy, hashlib, json
root=Path(sys.argv[2])/'acr-b5-recipes'
(root/'config').mkdir(parents=True)
node=root/'runtime/bin/node'; node.parent.mkdir(parents=True)
node.write_bytes(b'fixture executable bytes'); node.chmod(0o700)
recipes=json.loads(sys.argv[3])
bound=copy.deepcopy(recipes)
for recipe in bound: recipe['argv'][0]=str(node)
b5.recipe_check(recipes,root,recipes)
try: b5.recipe_check(bound,root,recipes)
except ValueError as e: assert str(e)=='B5_RECIPE_MISMATCH'
else: raise AssertionError('unsealed runtime accepted')
seal=dict(nodeSha256=hashlib.sha256(node.read_bytes()).hexdigest())
handoff=root/'config/b5-handoff.json'; handoff.write_text(json.dumps(seal))
b5.recipe_check(bound,root,recipes)
# Preparation validates before the handoff writer, using its approved input pin.
handoff.unlink()
b5.recipe_check(bound,root,recipes,node_sha256=seal['nodeSha256'])
handoff.write_text(json.dumps(seal))
mutations=[]
for patch in (dict(argv=['/unapproved/node',*bound[0]['argv'][1:]]),dict(argv=[str(node),'--test','tests/other.test.mjs']),dict(id='other'),dict(required=False),dict(required=1),dict(parser='other'),dict(extra=True),dict(argv=[]),dict(argv=None)):
 changed=copy.deepcopy(bound); changed[0].update(patch); mutations.append(changed)
mutations.extend([bound[1:],bound+[bound[0]],[bound[0],bound[0]]])
for changed in mutations:
 try: b5.recipe_check(changed,root,recipes)
 except ValueError as e: assert str(e)=='B5_RECIPE_MISMATCH'
 else: raise AssertionError('changed recipe accepted')
node.write_bytes(b'changed bytes')
try: b5.recipe_check(bound,root,recipes)
except ValueError as e: assert str(e)=='B5_RECIPE_MISMATCH'
else: raise AssertionError('changed runtime accepted')
alternate=node.with_name('alternate-node')
alternate.write_bytes(b'fixture executable bytes'); alternate.chmod(0o700)
node.unlink(); node.symlink_to(alternate)
assert hashlib.sha256(node.read_bytes()).hexdigest()==seal['nodeSha256']
try: b5.recipe_check(bound,root,recipes)
except ValueError as e: assert str(e)=='B5_RECIPE_MISMATCH'
else: raise AssertionError('same-byte symlink accepted')
print('RESULT: PASS sealed runtime, bare node and recipe mutation refusals')
`, [parent, JSON.stringify(B5_RECIPES)]));
});

const nativeTools = process.env.CONTROL_ROOM_B5_PREP_TOOLS;
const nativePython = process.env.CONTROL_ROOM_B5_PREP_PYTHON;
test("B5 native validators require explicit pinned tools and configured interpreter", () => {
  if (process.env.CONTROL_ROOM_B5_PREP_REQUIRE_REAL === "1") assert.ok(nativeTools && nativePython && process.env.CONTROL_ROOM_B5_PREP_TOOLS_PIN, "B5_PREPARATION_QUALIFICATION_REQUIRED");
  else assert.equal(process.env.CONTROL_ROOM_B5_PREP_REQUIRE_REAL, undefined);
});

import { B5_RECIPES, B5_REQUIRED_RISK } from "./helpers/improve-control-room-first-website";

test("B5 real settings/lineup honours reviewed overrides; pinned roster and interpreter refusals (fixture assembly)", {
  skip: process.env.CONTROL_ROOM_B5_PREP_REQUIRE_REAL !== "1" ? "NOT RUN: lead-gated pinned tools unavailable in ordinary CI" : false,
}, async t => {
  const parent = await scratch(t), root = join(parent, "acr-b5-native-fixture");
  await mkdir(root, { mode: 0o700 });
  const constants = JSON.stringify({ recipes: B5_RECIPES, risk: B5_REQUIRED_RISK });
  passed(python(`
import copy, json, os, shutil, hashlib
root=Path(sys.argv[2]); tools=Path(sys.argv[3]); pin=sys.argv[4]; python=Path(sys.argv[5]).resolve()
constants=json.loads(sys.argv[6])
b5.source_check(tools,pin)
for folder in ('tools/loop/bridge/i1','lead/bin','lead/skills-src','lead/state','lead/reports','work/repo','runs','logs','home-work','tmp','product','runtime/bin','config/i1'):
 (root/folder).mkdir(parents=True,exist_ok=True,mode=0o700)
stage,safety=b5.stage_tools(tools,pin,root)
shutil.copytree(root/'tools/bin',root/'lead/bin',dirs_exist_ok=True)
shutil.copytree(root/'tools/skills-src',root/'lead/skills-src',dirs_exist_ok=True)
shutil.copyfile(root/'tools/loop/bridge/i1/launch-router.py',root/'lead/bin/launch-router.py')
# Actual local git baseline, invoking configured identity, no overrides/remotes.
repo=root/'work/repo'
b5.git(repo,'init','--quiet','--initial-branch=cook/b5-fixture')
(repo/'index.html').write_text('fixture baseline')
b5.git(repo,'add','index.html'); b5.git(repo,'commit','--quiet','-m','B5 fixture baseline')
baseline=b5.git(repo,'rev-parse','HEAD').decode().strip()
roots={key:str(root/value) for key,value in b5.ROOTS.items()}
b5.json_new(root/'tools/loop/bridge/cr-entry.json',roots)
b5.json_new(root/'lead/job-env.json',dict(PATH='/usr/bin:/bin',HOME=str(root/'home-work'),TMPDIR=str(root/'tmp'),TZ='UTC'))
os.environ.update(roots)
sys.path.insert(0,str(root/'tools/loop'))
dry=b5.load_module('b5_dry',root/'tools/loop/i1-dry-run.py')
cr=b5.load_module('b5_cr',root/'tools/loop/cr.py')
rs=b5.load_module('run_settings',root/'tools/loop/run_settings.py')
rows=cr.models()
def slot(name):
 row=next(r for r in rows if r['name']==name)
 return dict(model=name,route=row['launcher'],effort=row['default_effort'])
writer=slot('gpt-6.1-sol'); reviewer=slot('deepseek-v4.1-flash'); final=slot('claude-fable-5-1')
settings=dict(schema_version=1,project=dict(repository=str(repo),base=baseline,host_adapter='local-loop',test_checks=constants['recipes'],risk_categories=constants['risk']['categories']),
 roles=dict(plan=writer,spec=writer,build=writer,orchestrator=writer,final=final,code_reviews=[reviewer,reviewer],
 risk_reviews=[dict(reviewer,role='attack-review'),dict(final,role='ui-review'),dict(reviewer,role='ci-review')]),
 code_review_count=2,overrides=dict(allow_same_family_review=True,allow_standard_final=True))
health=dict(schema_version=1,checked_at=cr.now().isoformat(),entries=[dict(model=r['name'],route=r['launcher'],available=True) for r in rows])
validated=b5.reviewed_settings(settings,health,root,baseline,python,dry,cr,rs,constants)
assert validated['lineup']['eligible'] is True
assert any(r['waived'] and r['code']=='FAMILY_REVIEWER' for r in validated['lineup']['reasons'])
# Independently prove the uncorrected spec expression refuses this reviewed fixture.
effective=validated['effective']
uncorrected=cr.saved_lineup(rs.engine_settings(effective),effective,rows,health)
assert uncorrected['eligible'] is False
assert any(not r['waived'] and r['code']=='FAMILY_REVIEWER' for r in uncorrected['reasons'])
invalid=copy.deepcopy(settings); invalid['project']['test_checks'][0]['parser']='invented'
try: b5.reviewed_settings(invalid,health,root,baseline,python,dry,cr,rs,constants)
except rs.SettingsError as e: assert e.code=='INVALID_CHECK'
else: raise AssertionError('invalid settings reached production')
assert not (root/'config/settings.json').exists() # no carrier writer reached
inputs=root/'inputs'; inputs.mkdir(mode=0o700)
pinned=(root/'tools/loop/models.tsv').read_bytes()
(inputs/'models.tsv').write_bytes(pinned)
b5.roster_check(safety,root,pinned,inputs)
trimmed=b'\\n'.join(pinned.splitlines()[:4])+b'\\n'
(inputs/'models.tsv').write_bytes(trimmed)
assert not cr.models_problems(inputs/'models.tsv',allow_standard_final=True)
try: b5.roster_check(safety,root,pinned,inputs)
except ValueError as e: assert str(e)=='B5_ROSTER_BYTES'
else: raise AssertionError('trimmed roster reached production')
(inputs/'models.tsv').write_bytes(pinned)
approved=safety.sha(python)
b5.interpreter_check(stage,safety,root,str(python),approved)
alt=root/'runtime/bin/alternate-python'
alt.write_bytes(python.read_bytes()); alt.chmod(0o700)
assert safety.sha(alt)==approved # matching self-hash cannot grant identity
assert b5.command([alt,'--version']).startswith(b'Python')
try: b5.interpreter_check(stage,safety,root,str(alt),approved)
except ValueError as e: assert str(e)=='B5_INTERPRETER_IDENTITY'
else: raise AssertionError('alternate interpreter reached production')
try: b5.interpreter_check(stage,safety,root,str(python),'0'*64)
except ValueError as e: assert str(e)=='B5_INTERPRETER_BYTES'
else: raise AssertionError('changed approved digest reached production')
b5.interpreter_bytes_check(safety,alt,approved)
alt.write_bytes(alt.read_bytes()+b'changed fixture bytes')
try: b5.interpreter_bytes_check(safety,alt,approved)
except ValueError as e: assert str(e)=='B5_INTERPRETER_BYTES'
else: raise AssertionError('changed interpreter bytes reached production')
assert not (root/'config/settings.json').exists()
# Real writers, then repeat validation on their actual rewritten bytes.
(inputs/'availability.json').write_text(json.dumps(health))
stage.stage_configuration(root,inputs,settings)
b5.write_new(root/'config/source-revision.txt',pin+'\\n')
stage.repin(root,python)
loaded=safety.read_json(root/'config/settings.json',root)
assert loaded['roles']['build']==writer and 'effective_effort' not in loaded['roles']['build']
b5.reviewed_settings(loaded,safety.read_json(root/'config/availability.json',root),root,baseline,python,dry,cr,rs,constants)
b5.roster_check(safety,root,pinned)
# Tampered post-repin settings must fail before handoff freeze.
loaded['project']['test_checks'][0]['parser']='invented'
(root/'config/settings.json').write_text(json.dumps(loaded))
try: b5.reviewed_settings(safety.read_json(root/'config/settings.json',root),health,root,baseline,python,dry,cr,rs,constants)
except rs.SettingsError as e: assert e.code=='INVALID_CHECK'
else: raise AssertionError('post-repin rewrite accepted')
(root/'config/settings.json').write_text(json.dumps(settings,sort_keys=True,separators=(',',':'),ensure_ascii=False))
b5.private_tree(root)
assert not (root/'config/b5.json').exists()
assert not (root/'evidence').exists()
assert not (root/'config/i1/real-jobs-enabled').exists()
print('RESULT: PASS real validators, override regression, roster/interpreter refusals and post-repin validation (fixture assembly)')
`, [root, nativeTools!, process.env.CONTROL_ROOM_B5_PREP_TOOLS_PIN!, nativePython!, constants], nativePython!));

  // Real pinned tools carrier and product schemas/adapter, no provider work.
  const approved = b5RawHash(await readFile(await realpath(nativePython!)));
  const loaded = await loadB5A2V1(root, approved);
  assert.equal(loaded.configuration.contract.lineage, loaded.lineage);
  assert.equal(loaded.adapter.contract.toolingRevision, loaded.lineage.toolingRevision);
  assert.equal(typeof loaded.adapter.finalization?.cleanup, "function");
  await loaded.adapter.close();
  const help = spawnSync(process.execPath, ["--import", "tsx", resolve("tests/helpers/improve-control-room-first-website-a2.ts"), "--qualify", root, approved], {
    encoding: "utf8", timeout: 120_000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /RESULT: PASS B5 real carrier loader/);
  const carrierPath = join(root, "config/contract-cleanup.json");
  const original = await readFile(carrierPath, "utf8");
  for (const [field, code] of [["settingsSha256", "B5_A2_CONFIGURATION_PIN"], ["toolingRevision", "B5_A2_CONFIGURATION_PIN"]]) {
    const mutated = JSON.parse(original);
    mutated.configuration[field] = (field === "toolingRevision" ? "sha256:" : "") + "0".repeat(64);
    await writeFile(carrierPath, JSON.stringify(mutated));
    await assert.rejects(loadB5A2V1(root, approved), new RegExp(code));
  }
  await writeFile(carrierPath, original);
});

test("B5 later-state fixture joins consumed review, brief, ledger and rejected head using offset instants", async t => {
  const f = await projectionFixture(t);
  f.raw.clone = join(f.root, "work/repo"); f.raw.base_sha = f.input.baseline;
  const startedAt = "2026-11-01T01:59:59-06:00", endedAt = "2026-11-01T01:00:01-07:00";
  const ended = endedAt;
  for (const [n, role, head] of [[1, "build", f.input.baseline], [2, "code-review", "c".repeat(40)]] as const) {
    const brief = join(f.work, `${n}-brief.md`), report = join(f.work, `${n}-report.md`), sidecar = join(f.work, `${n}-result.json`);
    await writeFile(brief, `fixture ${role} instructions`, { mode: 0o600 });
    await writeFile(report, "fixture sealed report", { mode: 0o600 });
    await writeFile(sidecar, '{"fixture":"sealed"}', { mode: 0o600 });
    const reportHash = b5RawHash("fixture sealed report");
    f.raw.steps.push({ n, role, model: "fixture-model", model_identity: { requested: "fixture-model", status: "unverified", observed: null },
      brief, log: `fixture-${n}.log`, input_version: 1, head_at_start: head,
      started_epoch: Date.parse(startedAt) / 1000, started: "display-only ambiguous minute",
      report_snapshot: { path: report, sha256: reportHash, job_id: `fixture-job-${n}`, ended },
      sidecar_seals: [{ path: sidecar, sha256: b5RawHash('{"fixture":"sealed"}') }],
      findings: role === "code-review" ? [{ id: "fixture-finding", severity: "LOW", disposition: "FIXED" }] : [] });
    f.raw.chain.consumed_results.push({ step: n, job_id: `fixture-job-${n}`, sha256: reportHash, verdict: role === "build" ? "DONE" : "NEEDS-FIX" });
    f.emitted.steps.push({ n, role, stale: false, state: "done" });
  }
  f.raw.chain.rejections = [2];
  const ledgerFile = join(f.root, "lead/state/jobs.tsv");
  const header = "id\tlog\tmodel\tcwd\tstarted\tpid\tstate\tended\texit_code\n";
  const events = [1, 2].flatMap(n => [
    `fixture-job-${n}\tfixture-${n}.log\tfixture-model\t${f.work}\t${startedAt}\t${100 + n}\tRUNNING\t\t`,
    `fixture-job-${n}\tfixture-${n}.log\tfixture-model\t${f.work}\t${startedAt}\t${100 + n}\tENDED\t${ended}\t0`,
  ]);
  const saveLedger = (rows: string[]) => writeFile(ledgerFile, header + rows.join("\n") + "\n", { mode: 0o600 });
  await saveLedger(events);
  await f.save();
  const projected = await projectB5RunV1(f.input);
  assert.equal(projected.steps[1].startedAt, "2026-11-01T07:59:59.000Z");
  assert.equal(projected.steps[1].endedAt, "2026-11-01T08:00:01.000Z");
  assert.equal(projected.steps[1].verdict, "NEEDS-FIX");
  assert.deepEqual(projected.rejectedHeads, ["c".repeat(40)]);
  assert.equal(projected.steps[0].headAtStart, f.input.baseline); // never inferred as build output
  assert.equal(projected.steps[1].providerIdentityVerified, false);
  assert.match(projected.steps[1].brief, /fixture code-review instructions/);
  // Even a consumed job ID must not hide another job using the same log.
  for (const [field, replacement] of [[0, "different-job"], [2, "other-model"], [3, `${f.work}/other`],
    [4, "2026-11-01T00:00:00Z"], [5, "999"]] as const) {
    const changed = events[3].split("\t"); changed[field] = replacement;
    await saveLedger([...events.slice(0, 3), changed.join("\t")]);
    await assert.rejects(projectB5RunV1(f.input), (error: unknown) =>
      error instanceof B5RefusalV1 && error.code === "B5_A2_LEDGER_JOIN");
  }
  await saveLedger(events);
  f.raw.steps[0].input_version = 2; await f.save();
  await assert.rejects(projectB5RunV1(f.input), /B5_A2_REJECTION_JOIN/);
  f.raw.steps[0].input_version = 1;
  f.raw.steps[1].sidecar_seals[0].sha256 = "0".repeat(64); await f.save();
  await assert.rejects(projectB5RunV1(f.input), /B5_A2_SIDECAR_PIN/);
});

import { sha256Digest } from "../src/security";
import type { LoopFinalizationTargetV1, LoopFinalizationCapabilityV1 } from "../src/web/v1/improve-control-room-loop-finalization";

test("B5 completion/cleanup mapping joins typed receipts, cold card and repository observations (fixture ports only)", async t => {
  const f = await projectionFixture(t), d = `sha256:${"d".repeat(64)}`, head = "c".repeat(40), at = "2026-10-31T00:00:00.000Z";
  f.raw.clone = join(f.root, "work/repo"); f.raw.base_sha = f.input.baseline;
  f.raw.chain.inputs = { entries: { candidate: { head } } };
  const source = join(f.root, "logs/job.log"), destination = join(f.root, ".cr-trash/2026-10-31/job.log");
  await mkdir(join(f.root, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(f.root, ".cr-trash/2026-10-31"), { recursive: true, mode: 0o700 });
  await writeFile(destination, "fixture moved log", { mode: 0o600 });
  const moves = [{ source, destination, sha256: b5RawHash("fixture moved log"), state: "done" }];
  f.raw.close = { state: "closed", local: true, clone_kept: f.raw.clone, head, moves };
  await f.save();
  const retained = join(f.root, "runs", f.input.runId, "finalization/retained", d.slice(7));
  await mkdir(retained, { recursive: true, mode: 0o700 });
  await writeFile(join(retained, "SEALED.json"), '{"fixture":"retained"}', { mode: 0o600 });
  const retentionDigest = `sha256:${b5RawHash('{"fixture":"retained"}')}`;
  const target: LoopFinalizationTargetV1 = { schemaVersion: 1, tenantId: "tenant:fixture", workspaceId: "workspace:fixture",
    projectId: f.input.runLink.projectId, ownerIdentityId: "owner:fixture", requestId: f.input.saved.requestId, runLinkId: f.input.saved.runLinkId,
    localVersion: 1, authorizationId: "authorization:fixture", startCommandId: `loop-command:${"a".repeat(32)}`, startBindingDigest: d,
    run: f.status.run, inputVersion: 1, requestSha256: f.input.saved.requestSha256, settingsSha256: f.input.saved.settingsSha256,
    settingsDigest: f.input.saved.settingsSha256, expectedRevision: 0, schemaDigest: d };
  const binding = { ...target, eventDigest: d };
  const evidence: any = { schemaVersion: 1, binding: { projectId: target.projectId, requestId: target.requestId, runLinkId: target.runLinkId,
    localVersion: 1, ...target.run, a2InputVersion: 1, engineRevision: 0, requestSha256: target.requestSha256, settingsSha256: target.settingsSha256,
    baseRevision: f.input.baseline, candidateRevision: head, inputsDigest: d, recipeDigest: d, environmentDigest: d },
    summary: "fixture completion", changedAreas: ["index.html"], databaseChanges: { kind: "none" },
    checks: [{ id: "fixture-check", required: true, commandLabel: "fixture check", receiptDigest: d, outputDigest: d,
      candidateRevision: head, status: "PASS", exitCode: 0, completed: 1, passed: 1, failed: 0, skipped: 0, durationMs: 0, startedAt: at, endedAt: at }],
    reviews: [{ current: true, stepId: "step:fixture", role: "final", attempt: 1, requestedModel: "fixture", observedModel: "fixture",
      identityVerified: true, family: "fixture", verdict: "CLEAN", candidateRevision: head, inputVersion: 1, reportDigest: d, sidecarDigest: d, startedAt: at, endedAt: at }],
    findings: [], rounds: { attempts: 1, reviewRejections: 0, repairs: 0, redesigns: 0 }, timing: { startedAt: at, finishedAt: at, durationMs: 0 },
    assumptions: null, validations: null, overrides: { allowSameFamilyReview: false, allowStandardFinal: false, waivedConflicts: [], fallback: null },
    completionDigest: d, retentionDigest };
  const card: any = { candidateId: "candidate:fixture", projectId: target.projectId, requestId: target.requestId, localVersion: 1, a2InputVersion: 1,
    candidateRevision: head, recordDigest: d, version: 1, state: "ready", evidence, freshness: "current", createdAt: at, decidedAt: null, canDecide: true };
  const record: any = { schemaVersion: 1, binding, sequence: 1, previousDigest: null, phase: "cleanup",
    observation: { schemaVersion: 1, binding, outcome: "candidate_ready", reasonCode: "FINISHED", evidenceDigest: d,
      completionDigest: d, inventoryDigest: d, observedAt: at },
    custody: { schemaVersion: 1, binding, inventoryDigest: d, retentionDigest, verifiedAt: at },
    termination: { schemaVersion: 1, binding, inventoryDigest: d, state: "already-ended", ownershipDigest: d, observedAt: at },
    publication: { schemaVersion: 1, state: "recorded", projectId: target.projectId, requestId: target.requestId, runLinkId: target.runLinkId,
      localVersion: 1, a2InputVersion: 1, engineRevision: 0, completionDigest: d, retentionDigest,
      candidate: { candidateId: card.candidateId, candidateRevision: head, recordDigest: d }, finishedAt: at,
      href: `/projects/${encodeURIComponent(target.projectId)}/improvements#request=${encodeURIComponent(target.requestId)}` },
    cleanup: { schemaVersion: 1, binding, inventoryDigest: d, retentionDigest, state: "complete", removedDigest: sha256Digest(moves),
      reasonCode: "CLEANUP_COMPLETE", finishedAt: at }, recordedAt: at };
  const sealRecord = () => { const { recordDigest: _, ...material } = record; record.recordDigest = sha256Digest(material); };
  sealRecord();
  let observedHead = head;
  // These are explicitly fixture ports. The native carrier test uses the actual
  // loaded capability; this mapping test grants no native qualification.
  const finalization: Pick<LoopFinalizationCapabilityV1, "readRecord" | "source" | "repository"> = {
    readRecord: async () => structuredClone(record), source: { toolingRevision: f.input.toolingRevision, schemaDigest: d,
      readVerifiedCompletion: async () => structuredClone(evidence) },
    repository: { observe: async () => ({ baseRevision: f.input.baseline, candidateRevision: observedHead, changedPaths: [], addedPaths: [], commitSubjects: [] }) },
  };
  const input = { ...f.input, finalization, target, readColdCard: async () => structuredClone(card) };
  const complete = await joinB5FinalProjectionV1(input);
  assert.equal(complete.finalHead, head); assert.equal(complete.cleanup.state, "complete");
  assert.deepEqual(complete.cleanup.targets, moves);
  assert.equal(requireB5FinalProjectionV1(complete), complete);
  assert.equal(complete.repository, f.raw.clone); // retained adopted repo, not an absence target
  observedHead = "e".repeat(40);
  await assert.rejects(joinB5FinalProjectionV1(input), /B5_A2_GIT_HEAD_JOIN/);
  observedHead = head;
  card.recordDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(joinB5FinalProjectionV1(input), /B5_A2_COLD_CARD_JOIN/);
  card.recordDigest = d;
  record.cleanup.removedDigest = `sha256:${"0".repeat(64)}`; sealRecord();
  await assert.rejects(joinB5FinalProjectionV1(input), /B5_A2_CLEANUP_DIGEST/);
  record.cleanup.removedDigest = sha256Digest(moves); sealRecord();
  await writeFile(source, "unexpected remaining source", { mode: 0o600 });
  await assert.rejects(joinB5FinalProjectionV1(input), /B5_A2_CLEANUP_SOURCE_PRESENT/);
});

test("B5 loader requires an enabled callable intake driver before constructing the adapter", async () => {
  // Exercise the loader's runtime validation block without importing private tools.
  const { transpileModule } = await import("typescript");
  const { z } = await import("zod");
  const source = await readFile("tests/helpers/improve-control-room-first-website-a2.ts", "utf8");
  const block = source.slice(source.indexOf("  const configuration = loaded.configuration"), source.indexOf("  const adapter = createImproveControlRoomLoopAdapterV1"));
  const javascript = transpileModule(block, { compilerOptions: { target: 99 } }).outputText;
  const validate = new Function("context", `with(context) { ${javascript} }`);
  const callable = () => true, lineage = b5LineageV1(`sha256:${"a".repeat(64)}`), schemaDigest = `sha256:${"b".repeat(64)}`;
  const contract = { lineage, schemaDigest, generateRunId: callable, decodeStatus: callable, admissionExpectation: callable,
    locateApprovalDocument: callable, decodeApprovalSidecar: callable, decisionProjection: { decodeGate: callable },
    recovery: { enabled: callable, inspect: callable, claimDriver: callable }, monitoring: { enabled: callable, decodeStatus: callable },
    finalization: { enabled: callable, inspect: callable, retain: callable, cleanup: callable,
      source: { readVerifiedCompletion: callable }, repository: { observe: callable } } };
  const run = (intakeDriver: unknown) => validate({ loaded: { configuration: { contract: { ...contract, intakeDriver } } },
    lineage, c: { toolingRevision: lineage.toolingRevision }, module: { A2_SCHEMA_DIGEST: schemaDigest },
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    carrier: { qualifiedOperations: ["intake", "confirm", "start", "stop", "approve", "answer"] },
    need: (value: unknown, code: string) => { if (!value) throw new Error(code); } });
  const valid = { enabled: callable, inspect: callable, advance: callable };
  for (const invalid of [undefined, {}, { ...valid, inspect: undefined }, { ...valid, advance: undefined },
    { ...valid, enabled: undefined }, { ...valid, enabled: () => false }]) assert.throws(() => run(invalid), /B5_A2_(CALLABLE|INTAKE_DRIVER)/);
  assert.doesNotThrow(() => run(valid));
});

test("B5 completed intake before confirmation joins latest lifecycle event without inventing confirmation", async t => {
  const f = await projectionFixture(t);
  const brief = join(f.work, "intake.md"), ended = "2026-11-01T00:00:02Z";
  await writeFile(brief, "fixture intake", { mode: 0o600 });
  f.raw.steps.push({ n: 1, role: "intake", model: "fixture-model", brief, log: "intake.log", input_version: 1,
    head_at_start: f.input.baseline, started_epoch: Date.parse("2026-11-01T00:00:00Z") / 1000 });
  f.emitted.steps.push({ n: 1, role: "intake", stale: false, state: "done" });
  await f.save();
  const ledgerFile = join(f.root, "lead/state/jobs.tsv");
  const ledger = `id\tlog\tmodel\tstate\tended\nintake-job\tintake.log\tfixture-model\tRUNNING\t\nintake-job\tintake.log\tfixture-model\tENDED\t${ended}\n`;
  await writeFile(ledgerFile, ledger, { mode: 0o600 });
  const projected = await projectB5RunV1(f.input);
  assert.equal(projected.steps[0].endedAt, "2026-11-01T00:00:02.000Z");
  assert.equal(projected.steps[0].verdict, null);
  assert.equal(f.status.confirmation, null);
  assert.equal(await readFile(ledgerFile, "utf8"), ledger, "projection leaves the append-only ledger unchanged");
  await writeFile(ledgerFile, ledger + `another-job\tintake.log\tfixture-model\tENDED\t${ended}\n`);
  await assert.rejects(projectB5RunV1(f.input), (error: unknown) =>
    error instanceof B5RefusalV1 && error.code === "B5_A2_LEDGER_JOIN");
});
