import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const producer = resolve(process.env.CONTROL_ROOM_B11_TEST_PRODUCER ?? "scripts/workflow-journeys/first-website-stage.py");
async function scratch(t: test.TestContext) {
  await mkdir(".test-tmp", { recursive: true });
  const root = await realpath(await mkdtemp(resolve(".test-tmp/b11-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function python(code: string, args: string[] = []) {
  return spawnSync("python3", ["-I", "-B", "-c", `import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('b11_stage',sys.argv[1])\nb5=importlib.util.module_from_spec(spec);spec.loader.exec_module(b5)\n${code}`, producer, ...args],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 4 << 20,
      // Only disposable test repositories use this synthetic author. No Git configuration is changed.
      env: { ...process.env, GIT_AUTHOR_NAME: "B11 fixture", GIT_AUTHOR_EMAIL: "b11-fixture@localhost",
        GIT_COMMITTER_NAME: "B11 fixture", GIT_COMMITTER_EMAIL: "b11-fixture@localhost" } });
}
function passed(result: ReturnType<typeof python>) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /RESULT: PASS/);
}

const reviewedFixture = `
import copy,hashlib,json,shutil
from types import SimpleNamespace
root=Path(sys.argv[2]); (root/'runtime/bin').mkdir(parents=True); (root/'config').mkdir()
node=root/'runtime/bin/node'; shutil.copyfile(${JSON.stringify(process.execPath)},node);node.chmod(0o700)
node_pin=hashlib.sha256(node.read_bytes()).hexdigest()
py=Path(sys.executable).resolve(); py_pin=hashlib.sha256(py.read_bytes()).hexdigest()
recipes=[dict(id=name,argv=[str(py),'-m','unittest','discover','-s',folder,'-p',pattern],parser='unittest',required=required)
 for name,folder,pattern,required in [('kit-bin','bin','test_*.py',True),('kit-scoring','scoring/bin','test_*.py',True),('lean-isolation','bin/diagnostic','lean_isolation_check.py',False)]]
constants=dict(profile='model-eval',recipes=recipes,risk=dict(categories=['code','ci'],slots=['attack-review','ci-review']),python=dict(path=str(py),sha256=py_pin))
rows=[dict(name='hosted-builder',launcher='codex'),dict(name='hosted-reviewer',launcher='hermes'),dict(name='local-reviewer',launcher='ollama')]
slot=lambda name: dict(model=name,route=next(r['launcher'] for r in rows if r['name']==name),effort='high')
settings=dict(project=dict(repository=str(root/'work/repo'),base='a'*40,test_checks=recipes,risk_categories=['code','ci']),
 roles=dict(plan=slot('hosted-builder'),spec=slot('hosted-builder'),build=slot('hosted-builder'),orchestrator=slot('hosted-builder'),final=slot('hosted-reviewer'),
 code_reviews=[slot('local-reviewer'),slot('hosted-reviewer')],risk_reviews=[dict(slot('hosted-reviewer'),role=role) for role in ['attack-review','ci-review']]),code_review_count=2,overrides={})
health=dict(entries=[dict(model=r['name'],route=r['launcher'],available=r['launcher']!='ollama') for r in rows])
(root/'config/under-evaluation.json').write_text(json.dumps(dict(schemaVersion=1,models=[])))
calls=dict(setup=0,lineup=0)
def setup(*args): calls['setup']+=1
def lineup(*args): calls['lineup']+=1; return dict(eligible=True,reasons=[])
dry=SimpleNamespace(settings_paths=lambda *a:None)
cr=SimpleNamespace(models_problems=lambda *a,**k:[],models=lambda:rows,chain_settings_setup=setup,saved_lineup=lineup)
rs=SimpleNamespace(prepare=lambda *a,**k:(copy.deepcopy(settings),{}),engine_settings=lambda s:{})
def invoke():
 try:
  b5.reviewed_settings(settings,health,root,'a'*40,py,dry,cr,rs,constants,node_pin)
  return 'eligible'
 except ValueError as error: return str(error)
`;

test("B11 local code reviewer is refused immediately after prepare before setup or lineup", async t => {
  const result = python(reviewedFixture + `\nprint(json.dumps(dict(code=invoke(),calls=calls)))`, [await scratch(t)]);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.code, "B11_LOCAL_MODEL_REFUSED");
  assert.deepEqual(actual.calls, { setup: 0, lineup: 0 });
});

for (const variant of ["hosted", "evaluated", "local-fallback", "evaluated-fallback", "missing", "malformed", "unknown", "orchestrator", "absolute-output", "parent-output"]) {
  test(`B11 reviewed settings ${variant} admission and exact Python recipe validation`, async t => {
    const result = python(reviewedFixture + `
settings['roles']['code_reviews'][0]=slot('hosted-reviewer')
variant=sys.argv[3]
if variant=='evaluated':
 (root/'config/under-evaluation.json').write_text(json.dumps(dict(schemaVersion=1,models=['hosted-reviewer'])))
elif variant=='local-fallback': health['entries'][2]['available']=True
elif variant=='evaluated-fallback':
 rows.append(dict(name='evaluated-spare',launcher='hermes')); health['entries'].append(dict(model='evaluated-spare',route='hermes',available=True))
 (root/'config/under-evaluation.json').write_text(json.dumps(dict(schemaVersion=1,models=['evaluated-spare'])))
elif variant=='missing': (root/'config/under-evaluation.json').unlink()
elif variant=='malformed': (root/'config/under-evaluation.json').write_text('{}')
elif variant=='unknown': (root/'config/under-evaluation.json').write_text(json.dumps(dict(schemaVersion=1,models=['unknown-model'])))
elif variant=='orchestrator': settings['roles']['orchestrator']=slot('local-reviewer')
elif variant=='absolute-output': settings['project']['outputs']=['/outside']
elif variant=='parent-output': settings['project']['outputs']=['../outside']
print(json.dumps(dict(code=invoke(),calls=calls)))
`, [await scratch(t), variant]);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    const expected = variant.endsWith("-output") ? "INVALID_PATH" : variant === "hosted" ? "eligible" : ["local-fallback", "orchestrator"].includes(variant)
      ? "B11_LOCAL_MODEL_REFUSED" : variant.startsWith("evaluated") ? "B11_MODEL_UNDER_EVALUATION" : "B11_UNDER_EVALUATION_INPUT";
    assert.equal(actual.code, expected);
    assert.deepEqual(actual.calls, variant === "hosted" ? { setup: 1, lineup: 1 } : { setup: 0, lineup: 0 });
  });
}

test("B11 Python recipe rejects wrong canonical path, digest, parser and required flags", async t => {
  passed(python(reviewedFixture + `
b5.recipe_check(recipes,root,recipes,python_pin=constants['python'])
for change in ('path','digest','parser','required'):
 checks=copy.deepcopy(recipes); pin=copy.deepcopy(constants['python'])
 if change=='path': checks[0]['argv'][0]=str(node)
 elif change=='digest': pin['sha256']='0'*64
 elif change=='parser': checks[0]['parser']='node-tap'
 else: checks[0]['required']=False
 try: b5.recipe_check(checks,root,recipes,python_pin=pin)
 except ValueError as e: assert str(e)=='B5_RECIPE_MISMATCH',str(e)
 else: raise AssertionError('wrong '+change+' accepted')
print('RESULT: PASS exact canonical Python recipes')
`, [await scratch(t)]));
});

test("B11 baseline allows only the two exact archive skip IDs and reasons", () => {
  passed(python(String.raw`
import copy
output='ssFF\nRan 18 tests in 0.2s\nFAILED (failures=2, skipped=2)\n'
audit=dict(counts=dict(completed=18,passed=14,failed=2,skipped=2),errors=[],
 failures=['test_build_prompts_lean.LeanPromptTests.test_full_suite_lean_variant','test_build_prompts_lean.LeanPromptTests.test_unsupported_attack_role'],skips=list(b5.ARCHIVE_SKIPS.items()))
b5.model_check_gate('kit-bin',output,1,audit)
for case in ('third','renamed','reason','error','failure','zero','second-summary'):
 changed=copy.deepcopy(audit); text=output
 if case=='third':
  changed['skips'].append(('test_other.Case.test_third','unavailable')); changed['counts'].update(completed=19,skipped=3)
  text='Ran 19 tests in 0.2s\nFAILED (failures=2, skipped=3)\n'
 elif case=='renamed': changed['skips'][0]=('test_run004_fixes.RetryTests.test_renamed',changed['skips'][0][1])
 elif case=='reason': changed['skips'][0]=(changed['skips'][0][0],'some other missing input')
 elif case=='error': changed['errors']=['bad.import']
 elif case=='failure': changed['failures'][0]='other.module.failure'
 elif case=='zero': text='Ran 0 tests in 0.2s\nOK\n'
 else: text=output+output
 try: b5.model_check_gate('kit-bin',text,1,changed)
 except ValueError as error: assert str(error)=='B11_BASELINE_GATE'
 else: raise AssertionError(case+' accepted')
final=dict(counts=dict(completed=18,passed=16,failed=0,skipped=2),errors=[],failures=[],skips=list(b5.ARCHIVE_SKIPS.items()))
b5.model_check_gate('kit-bin','Ran 18 tests in 0.2s\nOK (skipped=2)\n',0,final,baseline=False)
print('RESULT: PASS archive skips, third/renamed/reason failures and final gate')
`));
});

import { B5_RECIPES, B5_REQUIRED_RISK, B5_REQUEST_TEXT, B5_PROTECTED_TESTS, preflightFirstWebsiteV1,
  requireFirstWebsiteRehearsalPart2V1, firstWebsiteConfigSchemaV1 } from "./helpers/improve-control-room-first-website";
import { FIRST_WEBSITE_PROFILE, MODEL_EVAL_ROOT, MODEL_EVAL_REQUEST, MODEL_EVAL_RISK,
  modelEvalProfileV1, modelEvalRecipesV1, requireModelEvalRecipesV1, requireModelEvalAdmissionV1,
  resolveJourneyProfileV1, verifyModelEvalSourcesUnchangedV1, parseModelEvalUnittestV1, modelEvalTreeDigestV1 } from "./helpers/improve-control-room-model-eval";
import { loadB5A2V1, qualify } from "./helpers/improve-control-room-first-website-a2";
import { prepareFirstWebsiteAssemblyV1 } from "../scripts/workflow-journeys/first-website-host";
import { readFile, writeFile, chmod, cp, symlink } from "node:fs/promises";
import { b5Bytes } from "./helpers/improve-control-room-first-website";
import type { FirstWebsitePreflightV1 } from "./helpers/improve-control-room-first-website";
import { runFirstWebsiteJourneyV1 } from "../scripts/workflow-journeys/first-website-controller";

test("B11 omitted profile retains exact website request, recipe, risk and protected object references", () => {
  assert.equal(FIRST_WEBSITE_PROFILE.requestText, B5_REQUEST_TEXT);
  assert.equal(FIRST_WEBSITE_PROFILE.recipes, B5_RECIPES);
  assert.equal(FIRST_WEBSITE_PROFILE.requiredRisk, B5_REQUIRED_RISK);
  assert.equal(FIRST_WEBSITE_PROFILE.protectedTests, B5_PROTECTED_TESTS);
});

for (const id of ["first-website", "model-eval"] as const) {
  test(`B11 cross-profile ${id} roots are refused directly at all preparation boundaries`, async t => {
    const parent = await scratch(t), wrong = join(parent, id === "model-eval" ? "acr-b5-cross" : "acr-b11-cross");
    await mkdir(join(wrong, "config"), { recursive: true, mode: 0o700 }); await chmod(wrong, 0o700);
    const profile = id === "model-eval" ? modelEvalProfileV1({ path: "/unused/python", sha256: "a".repeat(64) }) : FIRST_WEBSITE_PROFILE;
    const result = spawnSync("python3", ["-I", "-B", producer, "--profile", id, "--root", wrong], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 2); assert.equal(result.stderr.trim(), "B5_ROOT_NAME");
    await assert.rejects(prepareFirstWebsiteAssemblyV1(wrong, id), { code: "B5_SCRATCH_ROOT" });
    await assert.rejects(loadB5A2V1(wrong, "a".repeat(64), profile.rootName), { code: "B5_A2_ROOT" });
    await assert.rejects(qualify(wrong, "a".repeat(64), profile.rootName), { code: "B5_A2_ROOT" });
    await assert.rejects(requireFirstWebsiteRehearsalPart2V1(join(wrong, "config/b5-rehearsal.json"), profile.rootName), { code: "B5_REHEARSAL_PACKET_INVALID" });
    const config = firstWebsiteConfigSchemaV1.parse({ schemaVersion: 1,
      product: { root: join(wrong, "product"), baseRevision: "a".repeat(40), candidateRevision: "a".repeat(40), assetsDigest: `sha256:${"a".repeat(64)}` },
      a2: { contractFile: join(wrong, "config/contract.json"), toolingRevision: `sha256:${"a".repeat(64)}`, schemaDigest: `sha256:${"a".repeat(64)}`, qualificationEvidence: join(wrong, "config/qualification.json") },
      assembly: { module: join(wrong, "config/first-website-host.mjs"), digest: `sha256:${"a".repeat(64)}` }, scratchRoot: wrong,
      ports: { product: 60460, preview: 60461, postgresBase: 60470 }, device: { origin: "http://127.0.0.1:60460", transportQualification: join(wrong, "config/transport.json"), actor: "owner" },
      settingsFile: join(wrong, "config/settings.json"), availabilityFile: join(wrong, "config/availability.json"), authorizationEvidence: join(wrong, "config/authorization.json"),
      requestText: profile.requestText, faultInputFile: join(wrong, "config/fault-input.txt"), reviewInputFile: join(wrong, "config/review-input.txt") });
    const file = join(wrong, "config/b5.json"); await writeFile(file, JSON.stringify(config));
    const helper = process.env.CONTROL_ROOM_B11_TEST_HELPER ? await import(process.env.CONTROL_ROOM_B11_TEST_HELPER) : { preflightFirstWebsiteV1 };
    await assert.rejects(helper.preflightFirstWebsiteV1({ configFile: file, evidenceDir: join(wrong, "evidence"), cliFile: join(wrong, "product/cli.ts"), profile, probe: async () => { throw Error("probe reached"); } }), { code: "B5_SCRATCH_ROOT" });
  });
}

test("B11 frozen marker is authenticated, selection is closed and website needs no new input", async t => {
  const parent = await scratch(t), root = join(parent, "acr-b11-profile");
  await mkdir(join(root, "config"), { recursive: true });
  const packet = { schemaVersion: 1, id: "model-eval", kitPin: "a".repeat(40), python: { path: "/unused/python", sha256: "a".repeat(64) }, protectedTestsDigest: "a".repeat(64), skillsTreeDigest: "b".repeat(64) };
  const resolver: typeof resolveJourneyProfileV1 = process.env.CONTROL_ROOM_B11_TEST_PROFILE_MODULE
    ? (await import(process.env.CONTROL_ROOM_B11_TEST_PROFILE_MODULE)).resolveJourneyProfileV1 : resolveJourneyProfileV1;
  const files: Record<string, string> = { "config/model-eval-profile.json": JSON.stringify(packet), "config/under-evaluation.json": '{"schemaVersion":1,"models":[]}', "config/b11-source-state-before.json": "{}" };
  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) { await writeFile(join(root, name), bytes, { mode: 0o600 }); hashes[name] = b5Bytes(bytes).slice(7); }
  await writeFile(join(root, "config/b5-handoff.json"), JSON.stringify({ hashes }), { mode: 0o600 });
  assert.equal((await resolver(root)).id, "model-eval");
  await assert.rejects(resolver(root, "first-website"), { code: "B11_PROFILE_MISMATCH" });
  await assert.rejects(resolver(root, "unknown"), { code: "B11_PROFILE_MISMATCH" });
  await writeFile(join(root, "config/model-eval-profile.json"), JSON.stringify({ ...packet, kitPin: "c".repeat(40) }));
  await assert.rejects(resolver(root), { code: "B11_PROFILE_MISMATCH" });
  await rm(join(root, "config/model-eval-profile.json"));
  await assert.rejects(resolver(root), { code: "B11_PROFILE_MISMATCH" });
  const website = join(parent, "acr-b5-default"); await mkdir(join(website, "config"), { recursive: true });
  assert.equal((await resolver(website)).id, "first-website");
});

test("B11 TypeScript admission checks all roles, fallback and admitted identities", () => {
  const rows = [{ name: "host", launcher: "codex" }, { name: "local", launcher: "ollama" }, { name: "evaluated", launcher: "hermes" }];
  const packet = { schemaVersion: 1, models: ["evaluated"] };
  const health = { entries: rows.map(row => ({ model: row.name, route: row.launcher, available: row.name === "host" })) };
  requireModelEvalAdmissionV1({ roles: { build: { model: "host", route: "codex" } } }, health, rows, packet);
  for (const role of ["build", "orchestrator", "final", "code_reviews", "risk_reviews"]) {
    for (const name of ["local", "evaluated"]) {
      const slot = { model: name, route: rows.find(row => row.name === name)!.launcher };
      assert.throws(() => requireModelEvalAdmissionV1({ roles: { [role]: role.endsWith("reviews") ? [slot] : slot } }, health, rows, packet),
        { code: name === "local" ? "B11_LOCAL_MODEL_REFUSED" : "B11_MODEL_UNDER_EVALUATION" });
    }
  }
  for (const name of ["local", "evaluated"]) {
    assert.throws(() => requireModelEvalAdmissionV1({}, health, rows, packet, [{ identity: name, route: rows.find(row => row.name === name)!.launcher }]), { code: name === "local" ? "B11_LOCAL_MODEL_REFUSED" : "B11_MODEL_UNDER_EVALUATION" });
    const available = structuredClone(health); available.entries.find(row => row.model === name)!.available = true;
    assert.throws(() => requireModelEvalAdmissionV1({}, available, rows, packet), { code: name === "local" ? "B11_LOCAL_MODEL_REFUSED" : "B11_MODEL_UNDER_EVALUATION" });
  }
  for (const input of [undefined, {}, { schemaVersion: 1, models: ["unknown"] }]) assert.throws(() => requireModelEvalAdmissionV1({}, health, rows, input), { code: "B11_UNDER_EVALUATION_INPUT" });
});

test("B11 Python and TypeScript recipes and unittest parsers agree independently", async t => {
  const result = python(`import hashlib,json\np=Path(sys.executable).resolve();print(json.dumps(dict(path=str(p),sha256=hashlib.sha256(p.read_bytes()).hexdigest())))`);
  assert.equal(result.status, 0, result.stderr); const pin = JSON.parse(result.stdout);
  const root = await scratch(t), recipes = modelEvalRecipesV1(pin.path);
  await requireModelEvalRecipesV1(recipes, root, pin);
  await assert.rejects(requireModelEvalRecipesV1(recipes, root, { ...pin, sha256: "0".repeat(64) }), { code: "B5_RECIPE_MISMATCH" });
  const changed = structuredClone(recipes); changed[0].argv[0] = "/other/python";
  await assert.rejects(requireModelEvalRecipesV1(changed, root, pin), { code: "B5_RECIPE_MISMATCH" });
  assert.deepEqual(parseModelEvalUnittestV1("Ran 18 tests in 0.1s\nFAILED (failures=2, skipped=2)\n"), { completed: 18, passed: 14, failed: 2, skipped: 2 });
  assert.deepEqual(parseModelEvalUnittestV1("Ran 2 tests in 0.1s\nOK\nRESULT: PASS (2 checks)"), { completed: 2, passed: 2, failed: 0, skipped: 0 });
  for (const text of ["Ran 0 tests in 0.1s\nOK", "Ran 3 tests in 0.1s\nOK (failures=1)", "Ran 1 test in 0.1s\nOK\nRan 1 test in 0.1s\nOK"]) assert.throws(() => parseModelEvalUnittestV1(text), { code: "B11_BASELINE_GATE" });
});

test("B11 source state checker detects writes after success, refusal and abort without restoring sources", async t => {
  const parent = await scratch(t), root = join(parent, "acr-b11-source");
  await mkdir(join(root, "config"), { recursive: true }); await mkdir(join(root, "evidence"));
  passed(python(`
import json
root=Path(sys.argv[2]); sources={}
for label in ('kit','product','tools'):
 source=root/label;source.mkdir();b5.git(source,'init','--quiet')
 (source/'tracked').write_text('baseline')
 b5.git(source,'add','tracked');b5.git(source,'commit','--quiet','-m','B11 source fixture')
 sources[label]=source
(root/'config/b11-source-state-before.json').write_text(json.dumps(b5.source_state(sources)))
print('RESULT: PASS source fixtures')
`, [root]));
  await verifyModelEvalSourcesUnchangedV1(root);
  for (const outcome of ["success", "refusal", "abort"]) {
    const changed = join(root, "kit", `extra-${outcome}`); await writeFile(changed, outcome);
    await assert.rejects(verifyModelEvalSourcesUnchangedV1(root, join(root, "evidence", `${outcome}.json`)), { code: "B11_FOREIGN_WRITE" });
    assert.equal(await readFile(changed, "utf8"), outcome);
    const comparison = await readFile(join(root, "evidence", `${outcome}.json`), "utf8");
    assert.doesNotMatch(comparison, /"path"|tracked|extra-/u);
    await rm(changed); await verifyModelEvalSourcesUnchangedV1(root);
  }
  for (const scenario of ["refusal", "abort"]) {
    const attempt = join(parent, `acr-b11-${scenario}`); await mkdir(join(attempt, "config"), { recursive: true });
    await cp(join(root, "config/b11-source-state-before.json"), join(attempt, "config/b11-source-state-before.json"));
    const changed = join(root, "kit", `controller-${scenario}`); await writeFile(changed, "foreign write");
    const abort = new AbortController(); if (scenario === "abort") abort.abort(new Error("synthetic abort"));
    let compared = 0;
    const preflight = { config: { scratchRoot: attempt, maxDurationMs: 10_000, faultInputFile: join(attempt, "missing-fault") },
      evidenceDir: join(attempt, "evidence"), digests: {}, sourceCheck: async (file?: string) => {
        compared++; await verifyModelEvalSourcesUnchangedV1(attempt, file);
      } } as unknown as FirstWebsitePreflightV1;
    const verdict = await runFirstWebsiteJourneyV1(preflight, abort.signal);
    assert.equal(compared, 1, "actual outer controller cleanup calls the source checker");
    assert.equal(verdict.state, "incomplete"); assert.ok(verdict.reasons.includes("B11_FOREIGN_WRITE"));
    assert.equal(await readFile(changed, "utf8"), "foreign write"); await rm(changed);
    assert.match(await readFile(join(attempt, "evidence/controller-verdict.json"), "utf8"), /B11_FOREIGN_WRITE/u);
  }
});

test("B11 A5 guard switched off reaches eligible stub and fails the original named assertion", async t => {
  const parent = await scratch(t), copy = join(parent, "stage.py"), source = await readFile(producer, "utf8");
  const anchor = "        model_admission(effective, availability, rows, root)";
  assert.ok(source.includes(anchor)); await writeFile(copy, source.replace(anchor, "        pass # mutation: admission disabled"));
  const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_B11_TEST_PRODUCER: copy }; delete env.NODE_TEST_CONTEXT;
  const args = ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=600000", "--test-name-pattern=^B11 local code reviewer is refused immediately", "tests/improve-control-room-second-project.test.ts"];
  const disabled = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(disabled.status, 1, disabled.stderr); assert.match(disabled.stdout, /actual: 'eligible'/u);
  assert.match(disabled.stdout, /expected: 'B11_LOCAL_MODEL_REFUSED'/u); assert.match(disabled.stdout, /# fail 1/u); assert.match(disabled.stdout, /# skipped 0/u);
  await writeFile(copy, source);
  const restored = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr); assert.match(restored.stdout, /# pass 1/u);
});

test("B11 preflight root guard switched off fails the named cross-profile assertion then restores", async t => {
  const parent = await scratch(t), copyRoot = join(parent, "copy");
  await mkdir(join(copyRoot, "tests/helpers"), { recursive: true });
  // Keep module resolution identical while loading only the mutated helper copy.
  await symlink(resolve("scripts"), join(copyRoot, "scripts"), "dir");
  await symlink(resolve("src"), join(copyRoot, "src"), "dir");
  await symlink(resolve("node_modules"), join(copyRoot, "node_modules"), "dir");
  const helper = resolve("tests/helpers/improve-control-room-first-website.ts"), file = join(copyRoot, "tests/helpers/improve-control-room-first-website.ts");
  const source = await readFile(helper, "utf8"), anchor = 'if (!(input.profile?.rootName ?? /^acr-b5-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u).test(root.slice(dirname(root).length + 1)))';
  assert.ok(source.includes(anchor)); await writeFile(file, source.replace(anchor, "if (false)"));
  const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_B11_TEST_HELPER: file }; delete env.NODE_TEST_CONTEXT;
  const args = ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=600000", "--test-name-pattern=^B11 cross-profile model-eval roots", "tests/improve-control-room-second-project.test.ts"];
  const disabled = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(disabled.status, 1, disabled.stdout + disabled.stderr); assert.match(disabled.stdout, /B5_SCRATCH_ROOT/u);
  assert.match(disabled.stdout, /B5_INPUT_FILE/u); assert.match(disabled.stdout, /# fail 1/u); assert.match(disabled.stdout, /# skipped 0/u);
  await writeFile(file, source);
  const restored = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr); assert.match(restored.stdout, /# pass 1/u);
});

if (process.env.CONTROL_ROOM_B11_REQUIRE_STAGE === "1") test("B11 native frozen stage and host prepare (lead-gated)", () => {
  assert.ok(process.env.CONTROL_ROOM_B11_STAGE_ARGS, "B11_STAGE_INPUTS_REQUIRED");
  const args: string[] = JSON.parse(process.env.CONTROL_ROOM_B11_STAGE_ARGS!);
  assert.ok(args.includes("--kit") && args.includes("--kit-pin") && args.includes("--root") && args.includes("--python"), "B11_STAGE_INPUTS_REQUIRED");
  const executable = args[args.indexOf("--python") + 1], root = args[args.indexOf("--root") + 1];
  const staged = spawnSync(executable, ["-I", "-B", producer, "--profile", "model-eval", ...args], { encoding: "utf8", timeout: 480_000 });
  assert.equal(staged.status, 0, staged.stdout + staged.stderr); assert.match(staged.stdout, /RESULT: PASS/u);
  assert.match(staged.stdout, /B11_BASELINE kit-bin/u);
  const repeated = spawnSync(executable, ["-I", "-B", producer, "--profile", "model-eval", ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(repeated.status, 2); assert.match(repeated.stderr, /B5_ROOT_EXISTS/u);
  const prepared = spawnSync(process.execPath, ["--import", "tsx", "scripts/workflow-journeys/first-website-host.ts", "--prepare", root, "--profile", "model-eval"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr); assert.match(prepared.stdout, /RESULT: PASS/u);
});

test("B11 clone has only pinned commits plus protected fixtures and catches extra ignored content", async t => {
  passed(python(`
import json,os
parent=Path(sys.argv[2]);kit=parent/'kit';kit.mkdir();(kit/'tracked').write_text('kit baseline')
b5.git(kit,'init','--quiet');b5.git(kit,'add','.');b5.git(kit,'commit','--quiet','-m','B11 kit fixture')
pin=b5.git(kit,'rev-parse','HEAD').decode().strip();b5.source_check(kit,pin)
try:b5.source_check(kit,'0'*40)
except ValueError as e:assert str(e)=='B5_SOURCE_PIN'
else:raise AssertionError('moved pin accepted')
(kit/'extra').write_text('dirty')
try:b5.source_check(kit,pin)
except ValueError as e:assert str(e)=='B5_SOURCE_DIRTY'
else:raise AssertionError('dirty kit accepted')
(kit/'extra').unlink();root=parent/'acr-b11-clone';(root/'work').mkdir(parents=True)
base=b5.stage_model_repo(kit,pin,root,Path.cwd(),dict(os.environ));repo=root/'work/repo'
assert b5.git(repo,'rev-parse','HEAD^').decode().strip()==pin
assert not b5.git(repo,'remote').strip()
assert set(b5.git(repo,'diff','--name-only',pin,base).decode().splitlines())==set(b5.MODEL_PROTECTED)
(repo/'foreign').write_text('extra')
try:b5.model_clone_check(repo,pin)
except ValueError as e:assert str(e)=='B11_CLONE_CONTENT'
else:raise AssertionError('extra clone file accepted')
(repo/'foreign').unlink();b5.model_clone_check(repo,pin)
print('RESULT: PASS commits-only ancestry, paths, empty remote, source-pin/dirty/extra refusals')
`, [await scratch(t)]));
});

import { runModelEvalDiagnosticV1, modelEvalProtectedDigestV1, validateModelEvalFrozenInputsV1 } from "./helpers/improve-control-room-model-eval";

test("B11 diagnostic catches tasks overwrite and rejects changed protected bytes and escaped output", async t => {
  const parent = await scratch(t), root = join(parent, "acr-b11-diagnostic"), repo = join(root, "work/repo");
  await mkdir(join(repo, "tasks/example"), { recursive: true }); await mkdir(join(root, "config")); await mkdir(join(root, "evidence"));
  await cp(resolve("tests/fixtures/model-eval-protected/bin"), join(repo, "bin"), { recursive: true });
  await writeFile(join(repo, "tasks/example/PROMPT.md"), "preserve");
  await writeFile(join(repo, "bin/runner_guard.py"), "def require_runner():\n import os\n from pathlib import Path\n if os.environ.get('MODEL_EVAL_MODEL_SIDE') == '1': raise SystemExit('refused')\n if any((p/'.model-eval-stage').exists() for p in (Path.cwd(),*Path.cwd().parents)): raise SystemExit('refused')\n");
  await writeFile(join(repo, "bin/build_prompts.py"), "from pathlib import Path\nimport sys\nif '--out' not in sys.argv: sys.exit(2)\n(Path(__file__).resolve().parents[1]/'tasks/example/PROMPT.md').write_text('overwritten')\n");
  passed(python(`
import hashlib,json
repo=Path(sys.argv[2]);b5.git(repo,'init','--quiet');b5.git(repo,'add','.');b5.git(repo,'commit','--quiet','-m','B11 diagnostic fixture')
p=Path(sys.executable).resolve();print(json.dumps(dict(path=str(p),sha256=hashlib.sha256(p.read_bytes()).hexdigest())))
print('RESULT: PASS diagnostic fixture')
`, [repo]));
  const pyResult = python("import hashlib,json\np=Path(sys.executable).resolve();print(json.dumps(dict(path=str(p),sha256=hashlib.sha256(p.read_bytes()).hexdigest())))");
  const pin = JSON.parse(pyResult.stdout);
  const packet = { schemaVersion: 1, id: "model-eval", kitPin: "a".repeat(40), python: pin, protectedTestsDigest: await modelEvalProtectedDigestV1(repo), skillsTreeDigest: "a".repeat(64) };
  await writeFile(join(root, "config/model-eval-profile.json"), JSON.stringify(packet), { mode: 0o600 });
  for (const output of ["/outside", "../outside", "evidence/../outside"]) await assert.rejects(runModelEvalDiagnosticV1(root, repo, output, pin), { code: "INVALID_PATH" });
  const result = await runModelEvalDiagnosticV1(root, repo, "evidence/lean-output.txt", pin);
  assert.equal(result.record.completed, 2); assert.equal(result.record.failed, 1); assert.equal(result.record.exitCode, 1);
  assert.match(result.output, /lean output changed tasks/u);
  await writeFile(join(root, ".model-eval-stage"), "tripwire");
  await assert.rejects(runModelEvalDiagnosticV1(root, repo, "evidence/guarded.txt", pin), { code: "B11_RUNNER_GUARD" });
  await rm(join(root, ".model-eval-stage"));
  const previousSide = process.env.MODEL_EVAL_MODEL_SIDE;
  try {
    process.env.MODEL_EVAL_MODEL_SIDE = "1";
    await assert.rejects(runModelEvalDiagnosticV1(root, repo, "evidence/model-side.txt", pin), { code: "B11_RUNNER_GUARD" });
    passed(python(`
import os
os.environ['MODEL_EVAL_MODEL_SIDE']='1'
try:b5.model_runner_check(Path(sys.argv[2]),Path(sys.executable).resolve(),dict(PATH='/usr/bin:/bin',TZ='UTC',LC_ALL='C',LANG='C',PYTHONDONTWRITEBYTECODE='1'))
except ValueError as error:assert str(error)=='B11_RUNNER_GUARD'
else:raise AssertionError('model-side tripwire bypassed')
print('RESULT: PASS actual Python runner guard respects model-side flag')
`, [repo]));
  } finally { if (previousSide === undefined) delete process.env.MODEL_EVAL_MODEL_SIDE; else process.env.MODEL_EVAL_MODEL_SIDE = previousSide; }
  await writeFile(join(repo, "bin/test_build_prompts_lean.py"), "changed");
  await assert.rejects(runModelEvalDiagnosticV1(root, repo, "evidence/changed.txt", pin), { code: "B5_PROTECTED_TEST_CHANGED" });
});

// This fixture exercises the real pinned tools modules, never a provider launch.
if (process.env.CONTROL_ROOM_B11_TOOLS) test("B11 real prepare and saved lineup integration with hosted Python recipes", async t => {
  assert.ok(process.env.CONTROL_ROOM_B11_TOOLS_PIN, "B11_TOOLS_PIN_REQUIRED");
  passed(python(String.raw`
import hashlib,json,os,shutil,tempfile
tools=Path(sys.argv[2]);pin=sys.argv[3]; before=b5.source_state(dict(tools=tools))
with tempfile.TemporaryDirectory(prefix='b11-lineup-',dir=sys.argv[4]) as temporary:
 root=Path(temporary).resolve();python=Path(sys.executable).resolve()
 frozen=root/'frozen-tools';b5.command(['/usr/bin/git','clone','--quiet','--no-hardlinks','--no-local',tools,frozen]);b5.git(frozen,'checkout','--quiet','--detach',pin)
 for folder in ('tools/loop/bridge/i1','lead/bin','lead/skills-src','lead/state','lead/reports','work/repo','runs','logs','home-work','tmp','product','runtime/bin','config/i1'):
  (root/folder).mkdir(parents=True,exist_ok=True,mode=0o700)
 stage,safety=b5.stage_tools(frozen,pin,root)
 shutil.copytree(root/'tools/bin',root/'lead/bin',dirs_exist_ok=True);shutil.copytree(root/'tools/skills-src',root/'lead/skills-src',dirs_exist_ok=True)
 shutil.copyfile(root/'tools/loop/bridge/i1/launch-router.py',root/'lead/bin/launch-router.py')
 repo=root/'work/repo'; b5.git(repo,'init','--quiet','--initial-branch=cook/b11-fixture');(repo/'DESIGN.md').write_text('fixture baseline');b5.git(repo,'add','.');b5.git(repo,'commit','--quiet','-m','B11 lineup fixture');baseline=b5.git(repo,'rev-parse','HEAD').decode().strip()
 roots={key:str(root/value) for key,value in b5.ROOTS.items()};b5.json_new(root/'tools/loop/bridge/cr-entry.json',roots)
 b5.json_new(root/'lead/job-env.json',dict(PATH='/usr/bin:/bin',HOME=str(root/'home-work'),TMPDIR=str(root/'tmp'),TZ='UTC'));os.environ.update(roots)
 b5.json_new(root/'config/under-evaluation.json',dict(schemaVersion=1,models=[]))
 sys.path.insert(0,str(root/'tools/loop'));dry=b5.load_module('dry',root/'tools/loop/i1-dry-run.py');cr=b5.load_module('cr',root/'tools/loop/cr.py');rs=b5.load_module('run_settings',root/'tools/loop/run_settings.py');rows=cr.models()
 def slot(name):
  row=next(r for r in rows if r['name']==name);return dict(model=name,route=row['launcher'],effort=row['default_effort'])
 writer=slot('gpt-6.1-sol');reviewer=slot('deepseek-v4.1-flash');final=slot('claude-fable-5-1')
 constants=dict(profile='model-eval',recipes=b5.model_recipes(python),risk=dict(categories=['code','ci'],slots=['attack-review','ci-review']),python=dict(path=str(python),sha256=hashlib.sha256(python.read_bytes()).hexdigest()))
 settings=dict(schema_version=1,project=dict(repository=str(repo),base=baseline,host_adapter='local-loop',test_checks=constants['recipes'],risk_categories=['code','ci'],outputs=['bin/build_prompts.py','DESIGN.md'],skills=[]),roles=dict(plan=writer,spec=writer,build=writer,orchestrator=writer,final=final,code_reviews=[reviewer,reviewer],risk_reviews=[dict(reviewer,role='attack-review'),dict(reviewer,role='ci-review')]),code_review_count=2,overrides=dict(allow_same_family_review=True,allow_standard_final=True))
 health=dict(schema_version=1,checked_at=cr.now().isoformat(),entries=[dict(model=r['name'],route=r['launcher'],available=r['launcher']!='ollama') for r in rows])
 validated=b5.reviewed_settings(settings,health,root,baseline,python,dry,cr,rs,constants)
 assert validated['lineup']['eligible'] is True
 import copy
 for output in ('/outside','../outside'):
  invalid=copy.deepcopy(settings);invalid['project']['outputs']=[output]
  try:b5.reviewed_settings(invalid,health,root,baseline,python,dry,cr,rs,constants)
  except (rs.SettingsError,ValueError) as error:assert getattr(error,'code',str(error))=='INVALID_PATH',str(error)
  else:raise AssertionError('escaped project output accepted')
 import re
 template=(root/'tools/loop/templates/build.md').read_text()
 values={name:'fixture' for name in re.findall(r'\{\{([a-z_]+)\}\}',template)}
 values.update(skills=str(root/'lead/skills-src'),clone=str(repo),head=baseline,branch='cook/b11-fixture')
 rendered=cr.fill(template,values)
 skill=root/'lead/skills-src/cr-build/SKILL.md'
 assert str(skill) in rendered and 'parts/skills' not in rendered
 assert skill.read_bytes()==b5.git(frozen,'show',pin+':skills-src/cr-build/SKILL.md')
 print('RESULT: PASS rendered build brief names full staged cr-build skill and pinned bytes')
 print('RESULT: PASS real run_settings.prepare and saved_lineup, Python recipes, hosted non-evaluated lineup; fixture assembly only')
 b5.sources_unchanged(before)
print('RESULT: PASS unchanged tools source and cleanup')
`, [process.env.CONTROL_ROOM_B11_TOOLS!, process.env.CONTROL_ROOM_B11_TOOLS_PIN!, await scratch(t)]));
});

test("B11 tree digests agree across runtimes including directory-prefix ordering", async t => {
  const root = await scratch(t); await mkdir(join(root, "a"));
  await writeFile(join(root, "a/file"), "nested"); await writeFile(join(root, "a.md"), "sibling");
  const result = python("print(b5.tree_digest(Path(sys.argv[2])))", [root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await modelEvalTreeDigestV1(root), result.stdout.trim());
});


test("B11 profile marker hash guard switched off fails its intended assertion then restores", async t => {
  const parent = await scratch(t), copyRoot = join(parent, "copy");
  await mkdir(join(copyRoot, "tests/helpers"), { recursive: true });
  await symlink(resolve("node_modules"), join(copyRoot, "node_modules"), "dir");
  await symlink(resolve("tests/helpers/improve-control-room-first-website.ts"), join(copyRoot, "tests/helpers/improve-control-room-first-website.ts"));
  const source = await readFile("tests/helpers/improve-control-room-model-eval.ts", "utf8"), file = join(copyRoot, "tests/helpers/improve-control-room-model-eval.ts");
  const anchor = '    if (handoff.hashes?.["config/model-eval-profile.json"] !== b5Bytes(bytes).slice(7)) refuse("B11_PROFILE_MISMATCH");';
  assert.ok(source.includes(anchor)); await writeFile(file, source.replace(anchor, "    // mutation: marker hash disabled"));
  const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_B11_TEST_PROFILE_MODULE: file }; delete env.NODE_TEST_CONTEXT;
  const args = ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=600000", "--test-name-pattern=^B11 frozen marker is authenticated", "tests/improve-control-room-second-project.test.ts"];
  const disabled = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(disabled.status, 1, disabled.stdout + disabled.stderr); assert.match(disabled.stdout, /Missing expected rejection/u);
  assert.match(disabled.stdout, /# fail 1/u); assert.match(disabled.stdout, /# skipped 0/u);
  await writeFile(file, source);
  const restored = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr); assert.match(restored.stdout, /# pass 1/u);
});


test("B11 required native gate refuses absent frozen inputs with one failure and zero skips", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_B11_REQUIRE_STAGE: "1" };
  delete env.NODE_TEST_CONTEXT; delete env.CONTROL_ROOM_B11_STAGE_ARGS;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=600000",
    "--test-name-pattern=^B11 native frozen stage and host prepare", "tests/improve-control-room-second-project.test.ts"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout, /B11_STAGE_INPUTS_REQUIRED/u);
  assert.match(result.stdout, /# tests 1/u); assert.match(result.stdout, /# fail 1/u); assert.match(result.stdout, /# skipped 0/u);
});
