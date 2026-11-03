import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Registration is read from the checked-in files. This case imports no B5 module,
// so a missing lane fails here rather than at an import or setup step.
const BROWSER_SCRIPT = "test:improve-control-room-first-website-browser";
const BROWSER_COMMAND = "CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests/browser/improve-control-room-first-website.spec.ts";
function workflowJob(workflow: string, job: string) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `B5 workflow job ${job} exists`);
  const rest = workflow.slice(start + 1), next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function workflowSteps(job: string) {
  return job.split(/\n {6}- /u).slice(1).map(step => ({ name: /^name: (.+)$/mu.exec(step)?.[1] ?? "",
    run: /^\s*run: (.+)$/mu.exec(step)?.[1] ?? "", timeout: /^\s*timeout-minutes: (\d+)$/mu.exec(step)?.[1] ?? "",
    conditional: /^\s*(?:if|continue-on-error):/mu.test(step) }));
}
test("B5 fixture browser has a dedicated proof lane", async () => {
  const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts as Record<string, string>;
  assert.equal(scripts[BROWSER_SCRIPT], BROWSER_COMMAND, "B5 dedicated fixture-browser script is registered exactly");
  const job = workflowJob(await readFile(".github/workflows/ci.yml", "utf8"), "owner-browser-journey");
  assert.match(job, /\n {4}timeout-minutes: 45\n/u, "B5 preserves the 45-minute owner browser job");
  const steps = workflowSteps(job), b5 = steps.findIndex(step => step.run === `pnpm run ${BROWSER_SCRIPT}`);
  assert.ok(b5 >= 0, "B5 owner-browser-journey runs the dedicated fixture-browser step");
  assert.equal(steps[b5]!.timeout, "5"); assert.equal(steps[b5]!.conditional, false, "B5 browser step is unconditional");
  for (const prior of ["test:improve-control-room-loop-candidate-browser", "test:improve-control-room-loop-finalization-browser"])
    assert.ok(steps.findIndex(step => step.run === `pnpm run ${prior}`) < b5, `B5 browser step follows ${prior}`);
  // The fixture lane never reaches the real proof CLI, private configuration or a model launch.
  for (const text of [scripts[BROWSER_SCRIPT]!, await readFile("tests/browser/improve-control-room-first-website.spec.ts", "utf8").catch(() => "")])
    assert.doesNotMatch(text, /first-website-proof|--config|B5_CONFIG|CONTROL_ROOM_I1_|CR_SCRATCH_PARENT|faultInputFile/u, "B5 fixture lane excludes the real proof and private configuration");
});

// ---------- B5 helper, CLI and verifier (fixture/offline; no model, no real run) ----------
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import type * as B5Helper from "./helpers/improve-control-room-first-website";
import type { B5BindInputReceiptV1, B5QualifiedPinsV1, B5StatusCheckRecordV1 } from "./helpers/improve-control-room-first-website";
import { loopCandidateCardSchemaV1, type LoopCandidateCardV1 } from "../src/improve-control-room/v1/loop-candidate-wire";
import { request as webRequest } from "./helpers/web-foundation";
// B5 helper bindings load lazily, so the registration case above imports no B5 module.
let H: typeof B5Helper;
const load = async () => { H ??= await import("./helpers/improve-control-room-first-website"); return H; };
const run = promisify(execFile), GIT_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, args: string[]) => run("/usr/bin/git", ["-C", cwd, "-c", "user.name=Proof fixture", "-c", "user.email=proof@localhost",
  "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: GIT_ENV }).then(r => r.stdout.trim());
async function owned(t: Pick<TestContext, "after">, prefix: string) {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const dir = await mkdtemp(resolve(".test-tmp", prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path);
    out.push(stat.isDirectory() ? `${path}/` : `${path} ${H.b5Bytes(await readFile(path))}`);
    if (stat.isDirectory()) out.push(...await tree(path));
  }
  return out;
}
/** A disposable scratch root with every input the strict configuration names. */
async function scratch(t: Pick<TestContext, "after">) {
  const parent = await owned(t, "b5-cli-"), root = join(parent, `acr-b5-${Date.now()}`);
  await mkdir(join(root, "config"), { recursive: true });
  const settings = { schema_version: 1, project: { risk_categories: ["code", "owner_visible", "ci"], test_checks: H.B5_RECIPES },
    roles: { code_reviews: [{ model: "slot-a", route: "route-a" }, { model: "slot-b", route: "route-b" }],
      risk_reviews: ["attack-review", "ui-review", "ci-review"].map(role => ({ role, model: `slot-${role}`, route: "route-r" })) } };
  const files: Record<string, string> = { "first-website-host.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./imported.flag", import.meta.url), "imported");\nexport async function createFirstWebsiteHostV1() { throw new Error("fixture host never starts"); }\n`,
    "a2-contract.json": "{}", "qualification.json": JSON.stringify({ providers: {
      classification: "fixture", transport: "scripted", toolingRevision: H.b5Bytes("tooling"), availabilitySha256: H.b5Bytes("{}"),
      lineup: [{ role: "build", identity: "fixture", family: "fixture", route: "fixture", grade: "fixture" }] },
      capture:{phoneCapture:"native-screenshot+server",qualificationDigest:H.b5Bytes("{}"),approval:"pending",approvalEvidenceDigest:null} }), "settings.json": JSON.stringify(settings), "availability.json": "{}",
    "authorization.json": "{}", "transport.json": "{}", "fault-input.md": "Builder-only first-attempt instruction.\n", "review-input.md": "Code-review-only neutral instruction.\n" };
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, "config", name), text);
  const c = (name: string) => join(root, "config", name);
  const config = { schemaVersion: 1, product: { root: resolve("."), baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), assetsDigest: H.b5Bytes("assets") },
    a2: { contractFile: c("a2-contract.json"), toolingRevision: H.b5Bytes("tooling"), schemaDigest: H.b5Bytes("schema"), qualificationEvidence: c("qualification.json") },
    assembly: { module: c("first-website-host.mjs"), digest: H.b5Bytes(files["first-website-host.mjs"]!) }, scratchRoot: root,
    ports: { product: 60460, preview: 60461, postgresBase: 60470 },
    device: { origin: "http://127.0.0.1:60460", transportQualification: c("transport.json"), actor: "owner" },
    settingsFile: c("settings.json"), availabilityFile: c("availability.json"), authorizationEvidence: c("authorization.json"),
    requestText: H.B5_REQUEST_TEXT, faultInputFile: c("fault-input.md"), reviewInputFile: c("review-input.md"), maxDurationMs: 14_400_000 };
  const write = async (value: unknown, name = "config.json") => { await writeFile(join(parent, name), JSON.stringify(value)); return join(parent, name); };
  return { parent, root, config, settings, write, evidence: join(root, "evidence") };
}
async function cli(configFile: string, evidenceDir: string, extra: string[] = []) {
  return run(process.execPath, ["--import", "tsx", "scripts/workflow-journeys/first-website-proof.ts", "--config", configFile, "--evidence-dir", evidenceDir, ...extra],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } })
    .then(r => ({ code: 0, out: r.stdout }), (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }));
}

test("B5 proof CLI refuses missing, invalid and unqualified configuration before any effect", async t => {
  await load();
  const s = await scratch(t), before = await tree(s.parent);
  const cases: [string, () => Promise<string>, string][] = [
    ["missing config", async () => join(s.parent, "absent.json"), "B5_CONFIG_PATH"],
    ["unknown key", () => s.write({ ...s.config, fallback: true }), "B5_CONFIG_INVALID"],
    ["changed request", () => s.write({ ...s.config, requestText: "Change something else." }), "B5_REQUEST_TEXT_CHANGED"],
    ["over-long duration", () => s.write({ ...s.config, maxDurationMs: 14_400_001 }), "B5_CONFIG_INVALID"],
    ["assembly digest", () => s.write({ ...s.config, assembly: { ...s.config.assembly, digest: H.b5Bytes("other") } }), "B5_ASSEMBLY_DIGEST"],
    ["input outside scratch", () => s.write({ ...s.config, faultInputFile: resolve("package.json") }), "B5_CONFINEMENT"],
  ];
  for (const [name, configFile, code] of cases) {
    const file = await configFile(), result = await cli(file, s.evidence);
    assert.equal(result.code, 1, `B5 CLI ${name} exits nonzero`);
    assert.equal(result.out, `FAILED: ${code}; proof retained\n`, `B5 CLI ${name} prints only its safe refusal`);
  }
  const usage = await cli(await s.write(s.config), s.evidence, ["--model", "x"]);
  assert.equal(usage.out, "FAILED: B5_USAGE; proof retained\n");
  // A forged finished evidence directory is never accepted as a place to write or as proof.
  await mkdir(s.evidence); await writeFile(join(s.evidence, "manifest.json"), JSON.stringify({ state: "finished", fixture: "SYNTHETIC" }));
  assert.equal((await cli(await s.write(s.config), s.evidence)).out, "FAILED: B5_EVIDENCE_DIR; proof retained\n");
  await rm(s.evidence, { recursive: true });
  const settings = { ...s.settings, project: { ...s.settings.project, risk_categories: ["code", "owner_visible"] } };
  await writeFile(s.config.settingsFile, JSON.stringify(settings));
  assert.equal((await cli(await s.write(s.config), s.evidence)).out, "FAILED: B5_RISK_CATEGORIES; proof retained\n");
  await writeFile(s.config.settingsFile, JSON.stringify(s.settings));
  await rm(join(s.parent, "config.json"));
  assert.deepEqual(await tree(s.parent), before, "B5 refusals leave zero file effects outside test-owned config");
  assert.equal(await lstat(join(s.root, "config", "imported.flag")).then(() => true, () => false), false, "B5 assembly is never imported on refusal");
});

test("B5 preflight accepts only sealed staged recipe runtime and exact recipes", async t => {
  await load();
  const s = await scratch(t), node = join(s.root, "runtime/bin/node");
  await mkdir(join(s.root, "runtime/bin"), { recursive: true });
  await writeFile(node, "fixture executable bytes", { mode: 0o700 });
  const handoff = join(s.root, "config/b5-handoff.json");
  const seal = { nodeSha256: H.b5Bytes(await readFile(node)).slice(7) };
  const bound = H.B5_RECIPES.map(r => ({ ...r, argv: [node, ...r.argv.slice(1)] }));
  const check = async (recipes: unknown) => {
    await writeFile(s.config.settingsFile, JSON.stringify({ ...s.settings, project: { ...s.settings.project, test_checks: recipes } }));
    return H.preflightFirstWebsiteV1({ configFile: await s.write(s.config), evidenceDir: s.evidence,
      cliFile: resolve("scripts/workflow-journeys/first-website-proof.ts"), probe: async () => true })
      .then(() => "PASSED", (e: unknown) => e instanceof H.B5RefusalV1 ? e.code : String(e));
  };
  // Product revision validation follows the recipe boundary in this fixture.
  const afterRecipes = await check(H.B5_RECIPES);
  assert.notEqual(afterRecipes, "B5_RECIPE_MISMATCH");
  assert.equal(await check(bound), "B5_RECIPE_MISMATCH", "path alone grants no approval");
  await writeFile(handoff, JSON.stringify(seal), { mode: 0o600 });
  assert.equal(await check(bound), afterRecipes, "sealed runtime reaches the same later validation as bare node");
  const altered = (index: number, patch: object) => bound.map((r, i) => i === index ? { ...r, ...patch } : r);
  for (const recipes of [
    altered(0, { argv: ["/unapproved/node", ...bound[0]!.argv.slice(1)] }),
    altered(1, { argv: [node, "--test", "tests/other.test.mjs"] }),
    altered(0, { id: "other" }), altered(0, { required: false }), altered(0, { required: 1 }), altered(0, { parser: "other" }),
    altered(0, { extra: true }), altered(0, { argv: [] }), altered(0, { argv: null }),
    bound.slice(1), [...bound, bound[0]], [bound[0], bound[0]],
  ]) assert.equal(await check(recipes), "B5_RECIPE_MISMATCH");
  await writeFile(handoff, JSON.stringify({ nodeSha256: "0".repeat(64) }));
  assert.equal(await check(bound), "B5_RECIPE_MISMATCH", "changed digest refuses");
  await writeFile(handoff, JSON.stringify(seal));
  await writeFile(node, "changed executable bytes");
  assert.equal(await check(bound), "B5_RECIPE_MISMATCH", "changed executable refuses");
  const alternate = join(s.root, "runtime/bin/alternate-node");
  await writeFile(alternate, "fixture executable bytes", { mode: 0o700 });
  await rm(node); await symlink(alternate, node);
  assert.equal(await check(bound), "B5_RECIPE_MISMATCH", "symlink cannot grant runtime identity");
});

for (const bareIndex of [0, 1]) test(`B5 recipes refuse mixed runtime bindings with bare recipe ${bareIndex}`, async t => {
  await load();
  const s = await scratch(t), node = join(s.root, "runtime/bin/node");
  await mkdir(join(s.root, "runtime/bin"), { recursive: true });
  await writeFile(node, "fixture executable bytes", { mode: 0o700 });
  await writeFile(join(s.root, "config/b5-handoff.json"),
    JSON.stringify({ nodeSha256: H.b5Bytes(await readFile(node)).slice(7) }), { mode: 0o600 });
  const bound = H.B5_RECIPES.map(r => ({ ...r, argv: [node, ...r.argv.slice(1)] }));
  await H.requireB5RecipesV1(bound, s.root);
  await H.requireB5RecipesV1(H.B5_RECIPES, s.root);
  const mixed = bound.map((r, i) => i === bareIndex ? H.B5_RECIPES[i] : r);
  await assert.rejects(H.requireB5RecipesV1(mixed, s.root),
    (error: unknown) => error instanceof H.B5RefusalV1 && error.code === "B5_RECIPE_MISMATCH");
});

test("B5 preflight checks product, ports and identity before any effect", async t => {
  await load();
  const s = await scratch(t), product = join(s.parent, "product");
  await mkdir(join(product, "scripts"), { recursive: true }); await writeFile(join(product, "scripts", "cli.ts"), "// fixture\n");
  await git(product, ["init", "--quiet"]); await git(product, ["add", "."]); await git(product, ["commit", "--quiet", "-m", "base"]);
  const baseRevision = await git(product, ["rev-parse", "HEAD"]);
  await writeFile(join(product, "scripts", "cli.ts"), "// fixture 2\n"); await git(product, ["commit", "--quiet", "-am", "head"]);
  const candidateRevision = await git(product, ["rev-parse", "HEAD"]);
  const config = { ...s.config, product: { ...s.config.product, root: product, baseRevision, candidateRevision } };
  const input = async (value: unknown, extra: Partial<Parameters<typeof B5Helper.preflightFirstWebsiteV1>[0]> = {}) =>
    H.preflightFirstWebsiteV1({ configFile: await s.write(value), evidenceDir: s.evidence, cliFile: join(product, "scripts", "cli.ts"), probe: async () => true, ...extra });
  const code = async (value: unknown, extra: Partial<Parameters<typeof B5Helper.preflightFirstWebsiteV1>[0]> = {}) =>
    input(value, extra).then(() => "PASSED", (e: unknown) => e instanceof H.B5RefusalV1 ? e.code : String(e));
  assert.equal(await code(config), "PASSED", "B5 complete preflight passes with the landed A2 input writer");
  const stagedNode = join(s.root, "runtime/bin/node");
  await mkdir(join(s.root, "runtime/bin"), { recursive: true });
  await writeFile(stagedNode, "fixture runtime", { mode: 0o700 });
  await writeFile(join(s.root, "config/b5-handoff.json"), JSON.stringify({ nodeSha256: H.b5Bytes("fixture runtime").slice(7) }), { mode: 0o600 });
  await writeFile(config.settingsFile, JSON.stringify({ ...s.settings, project: { ...s.settings.project,
    test_checks: H.B5_RECIPES.map(r => ({ ...r, argv: [stagedNode, ...r.argv.slice(1)] })) } }));
  assert.equal(await code(config), "PASSED", "B5 complete preflight accepts approved runtime bindings");
  await writeFile(config.settingsFile, JSON.stringify(s.settings));
  const ready = await input(config);
  assert.deepEqual([ready.digests.faultInput, ready.digests.reviewInput], [H.b5Bytes("Builder-only first-attempt instruction.\n"), H.b5Bytes("Code-review-only neutral instruction.\n")]);
  assert.equal(await code(config, { uid: 424242 }), "B5_EXECUTION_IDENTITY_MISMATCH");
  assert.equal(await code(config, { cliFile: resolve("scripts/workflow-journeys/first-website-proof.ts") }), "B5_PRODUCT_ROOT");
  assert.equal(await code({ ...config, product: { ...config.product, candidateRevision: baseRevision } }), "B5_PRODUCT_REVISION");
  assert.equal(await code({ ...config, ports: { ...config.ports, product: 3210 } }), "B5_PORT_RESERVATION");
  assert.equal(await code(config, { probe: async port => port !== 60475 }), "B5_PORT_BUSY");
  assert.equal(await code({ ...config, scratchRoot: s.parent }), "B5_SCRATCH_ROOT");
  const linked = join(s.root, "config", "linked.md"); await symlink(config.faultInputFile, linked);
  assert.equal(await code({ ...config, faultInputFile: linked }), "B5_INPUT_FILE");
  assert.equal(await code({ ...config, reviewInputFile: config.faultInputFile }), "B5_ROLE_INPUTS");
  await writeFile(join(product, "untracked.txt"), "x");
  assert.equal(await code(config), "B5_PRODUCT_DIRTY");
  // A busy reserved port is found by a real bind probe; nothing is stopped.
  const busy = createServer(); await new Promise<void>(done => busy.listen({ port: 0, host: "127.0.0.1" }, done));
  const port = (busy.address() as { port: number }).port;
  const probed = await new Promise<boolean>(done => { const s2 = createServer(); s2.once("error", () => done(false)); s2.listen({ port, host: "127.0.0.1", exclusive: true }, () => s2.close(() => done(true))); });
  await new Promise(done => busy.close(done)); assert.equal(probed, false);
  assert.equal(await lstat(s.evidence).then(() => true, () => false), false, "B5 preflight creates no evidence directory");
  assert.equal(await lstat(join(s.root, "config", "imported.flag")).then(() => true, () => false), false);
  // The assembly loader re-hashes before import and requires the named export.
  await assert.rejects(H.loadFirstWebsiteAssemblyV1({ ...config, assembly: { ...config.assembly, digest: H.b5Bytes("changed") } } as never), /B5_ASSEMBLY_DIGEST/u);
  assert.equal(typeof await H.loadFirstWebsiteAssemblyV1(config as never), "function");
});

/** Seeds the proof site, commits a defective then a repaired page, and runs the
 * diagnostic independently at both heads. The page content is generic test data. */
async function proofSite(t: Pick<TestContext, "after">) {
  const dir = await owned(t, "b5-site-"), project = join(dir, "project");
  const seeded = await H.seedProofSiteV1(project);
  const page = (badge: string) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Proof site</title></head>\n<body>\n<main><h1>Proof site</h1>${badge}<p>A small page for the first website proof.</p></main>\n</body>\n</html>\n`;
  await writeFile(join(project, "index.html"), page(`<span id="status" style="background:#f59e0b">Ready</span>`));
  await git(project, ["commit", "--quiet", "-am", "Add Ready badge"]); const rejected = await git(project, ["rev-parse", "HEAD"]);
  const smoke = await run(process.execPath, ["--test", "tests/site-smoke.test.mjs"], { cwd: project, encoding: "utf8", env: GIT_ENV });
  const failed = await H.runIndependentStatusCheckV1(project, "status-check/rejected.txt");
  await writeFile(join(project, "index.html"), page(`<span id="status" role="status" style="background:#f59e0b">Ready</span>`));
  await git(project, ["commit", "--quiet", "-am", "Announce the Ready badge"]); const final = await git(project, ["rev-parse", "HEAD"]);
  const passed = await H.runIndependentStatusCheckV1(project, "status-check/final.txt");
  return { dir, project, seeded, rejected, final, smoke, failed, passed };
}
test("B5 proof site planted omission passes smoke and fails the named diagnostic", async t => {
  await load();
  const p = await proofSite(t);
  assert.equal((await git(p.project, ["rev-list", "--count", p.seeded.head])), "1"); assert.equal(await git(p.project, ["remote"]), "");
  assert.match(p.smoke.stdout, /# pass 2\n/u); assert.match(p.smoke.stdout, /# fail 0\n/u);
  assert.equal(p.failed.record.exitCode, 1); assert.equal(p.failed.record.failed, 1); assert.equal(p.failed.record.completed, 1);
  assert.match(p.failed.output, /status element has role=status/u, "B5 defective head fails the named semantic assertion");
  assert.doesNotMatch(p.failed.output, /ENOENT|ERR_MODULE_NOT_FOUND|SyntaxError/u, "B5 diagnostic failure is not setup or import");
  assert.deepEqual([p.passed.record.exitCode, p.passed.record.completed, p.passed.record.passed, p.passed.record.failed, p.passed.record.skipped], [0, 1, 1, 0, 0]);
  assert.equal(p.failed.record.head, p.rejected); assert.equal(p.passed.record.head, p.final); assert.notEqual(p.rejected, p.final);
  assert.equal(p.failed.record.protectedTestsDigest, p.seeded.protectedTestsDigest); assert.equal(p.passed.record.protectedTestsDigest, p.seeded.protectedTestsDigest);
  assert.equal(await H.readProtectedTestsDigest(p.project), p.seeded.protectedTestsDigest);
  await rm(join(p.project, "index.html"));
  const missing = await H.runIndependentStatusCheckV1(p.project, "status-check/missing.txt");
  assert.match(missing.output, /ENOENT/u, "B5 missing page is a setup failure, not the planted semantic failure");
});

/** Retained evidence around a card the real product publisher recorded and the real HTTP
 * handler returned, over a proof-site repository whose diagnostics actually ran. The
 * engine is SYNTHETIC, so `fixturePins` qualify its tooling only to exercise the guards;
 * `qualifiedPins` stand for a real configuration that the fixture's card cannot meet. */
async function evidenceSet(t: Pick<TestContext, "after">) {
  const p = await proofSite(t), dir = join(p.dir, "evidence"), base = p.seeded.head;
  const f = await H.syntheticFirstWebsiteFixtureV1({ heads: { base, rejected: p.rejected, final: p.final } }); t.after(() => f.close());
  const project = f.project.projectId;
  const { requestId } = await H.driveSyntheticFirstWebsiteV1(f, f.bridge, f.identity, project, "b5-verify");
  assert.equal((await f.publish()).state, "recorded");
  const readCard = async () => f.handle(webRequest(`/api/v1/projects/${encodeURIComponent(project)}/improvements/loop/${encodeURIComponent(requestId)}/candidate`));
  const card = (await (await readCard()).json()).candidate as LoopCandidateCardV1;
  const responseDigest = H.b5Bytes(new Uint8Array(await (await readCard()).arrayBuffer()));
  const rows: { table: string; sha256: string; row: Record<string, unknown> }[] = [];
  for (const table of H.B5_SNAPSHOT_TABLES) for (const value of (await f.client.query<Record<string, unknown>>(`SELECT ${H.B5_SNAPSHOT_COLUMNS[table].join(",")} FROM ${table}`)).rows) {
    const row = JSON.parse(JSON.stringify(value, (_k, v: unknown) => typeof v === "bigint" ? Number(v) : v)) as Record<string, unknown>;
    rows.push({ table, sha256: H.b5Bytes(JSON.stringify(row)), row });
  }
  const digests = { settings: H.b5Bytes("settings"), availability: H.b5Bytes("availability"), authorization: H.b5Bytes("authorization"),
    qualification: H.b5Bytes("qualification"), assembly: H.b5Bytes("assembly"), faultInput: H.b5Bytes("fault"), reviewInput: H.b5Bytes("review") };
  const fixturePins: B5QualifiedPinsV1 = { capture: { phoneCapture: "native-screenshot+server", qualificationDigest: H.b5Bytes("capture qualification"), approval:"approved",approvalEvidenceDigest:H.b5Bytes("synthetic approval qualification") }, toolingRevision: f.adapter.toolingRevision, schemaDigest: f.adapter.schemaDigest,
    productBase: "1".repeat(40), productHead: "2".repeat(40), uid: 501, digests,
    providers: { classification: "fixture", transport: "scripted", toolingRevision: f.adapter.toolingRevision,
      availabilitySha256: digests.availability, lineup: [] } };
  const qualifiedPins: B5QualifiedPinsV1 = { ...fixturePins, toolingRevision: H.b5Bytes("qualified A2 tooling") };
  const time = (minute: number) => new Date(Date.UTC(2026, 9, 30, 12) + minute * 60_000).toISOString();
  const step = (n: number, role: string, identity: string, family: string, head: string, verdict: string | null, extra: Record<string, unknown> = {}) =>
    ({ n, role, identity, family, provider: { transport: "scripted", admittedIdentity: identity, route: "fixture", grade: "fixture" }, verified: true, head, startedAt: time(10 + n * 2), endedAt: time(11 + n * 2), verdict, findings: [], diagnostic: null, ...extra });
  const reviews = card.evidence.reviews, old = reviews.find(r => !r.current)!, current = reviews.filter(r => r.current);
  const steps = [step(1, "plan", "writer-p", "family-p", base, "DONE", {startedAt:time(3.5),endedAt:time(4.5)}), step(2, "build", "writer-b", "family-b", p.rejected, "DONE"),
    step(3, old.role, old.observedModel!, old.family!, old.candidateRevision, old.verdict, { diagnostic: "FAIL", findings: [{ severity: "MEDIUM", state: "open", summary: "status element lacks role=status" }] }),
    step(4, "build", "writer-b", "family-b", p.final, "DONE"),
    ...current.map((r, i) => step(5 + i, r.role, r.observedModel!, r.family!, r.candidateRevision, r.verdict, r.role === "code-review" ? { diagnostic: "PASS" } : {}))];
  fixturePins.providers.lineup = steps.map(s => ({ role: s.role, identity: s.identity, family: s.family, route: "fixture", grade: "fixture" }));
  const dom = ["07-finish-phone", "08-finish-desktop", "09-retained"].map(screen => ({ screen, candidateRevision: card.candidateRevision, baseRevision: base, requestId }));
  const files: Record<string, unknown> = {
    "journey.json": { schemaVersion: 1, phoneCapture: "native-screenshot+server", captureQualificationDigest: fixturePins.capture.qualificationDigest,
    restarts: [{ phase: "waiting", at: time(3.5) }, { phase: "final", at: time(40.5) }], serviceFacts: [],
    actions: ["intake", "confirm", "start", "answer", "approve-plan", "approve-spec", "finish-phone", "finish-desktop", "retained"].map((name, i) => {
      const read = i >= 6, minute = [0,2,3,4,5,6,39,40,42][i]!;
      const suffix = name === "intake" ? "intake" : read ? "candidate" : name.startsWith("approve-") ? "approve" : name;
      return { name, sequence: [1,2,3,6,7,8,11,12,13][i]!, requestId, localVersion:card.localVersion, runLinkId: card.evidence.binding.runLinkId, inputVersion: card.a2InputVersion,
        receiptPath: `receipts/${[1,2,3,6,7,8,11,12,13][i]}.json`, device: name === "finish-desktop" ? "desktop" : "phone", at: time(minute),
        method: read ? "GET" : "POST", path: `/api/v1/projects/p/improvements/loop/${name === "intake" ? "" : `${encodeURIComponent(requestId)}/`}${suffix}`, status: name === "intake" ? 201 : 200 };
    }),
    closed: [{ label: "after Start", from: time(3.1), to: time(3.4), receipts:[{device:"phone",sequence:4,path:"receipts/4.json"},{device:"desktop",sequence:5,path:"receipts/5.json"}] },
      { label: "after spec approval", from: time(6.5), to: time(38),receipts:[{device:"phone",sequence:9,path:"receipts/9.json"},{device:"desktop",sequence:10,path:"receipts/10.json"}] }], steps, dom,
    devices: [{ kind: "phone", real: false, browser: "phone browser" }, { kind: "desktop", real: false, browser: "desktop browser" }] },
    "database-snapshot.json": { schemaVersion: 1, readAt: time(43), rows },
    "independent-status-check.json": [p.failed.record, p.passed.record],
    "teardown.json": { transportCleanup:noMappingCleanup(), schemaVersion: 1, b3cCleanup: "complete", scratchAbsent: true, ownedProcesses: 0, ownedListenersReleased: true, protectedListenersUntouched: true,
      postgresStopped: true, cleanupAt: time(41), retainedRead: { at: time(42), candidateRevision: card.candidateRevision, receiptDigest: card.recordDigest } },
  };
  const raw: Record<string, string | Uint8Array> = { "status-check/rejected.txt": p.failed.output, "status-check/final.txt": p.passed.output };
  for (const n of ["01-prepare", "02-confirm-start", "03-question", "04-plan", "05-spec", "06-repair", "07-finish-phone", "08-finish-desktop", "09-retained"]) raw[`screens/${n}.png`] = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXf8AAAAASUVORK5CYII=","base64");
  const journey = files["journey.json"] as { actions: {name: string; sequence: number; device: string; at: string; receiptPath: string}[]; serviceFacts: unknown[] };
  const words: Record<string,string> = { intake:"prepared", confirm:"confirmed", start:"started", answer:"answered", "approve-plan":"plan-approved", "approve-spec":"spec-approved", "finish-phone":"finished", "finish-desktop":"finished", retained:"retained-read" };
  const phases: Record<string,string> = { intake:"prepare", confirm:"confirm-start", start:"confirm-start", answer:"question", "approve-plan":"plan", "approve-spec":"spec", "finish-phone":"finish", "finish-desktop":"finish", retained:"retained" };
  for (const a of journey.actions) {
    const sessionNonce = a.sequence.toString(16).padStart(32,"0"), screen = a.name === "finish-phone" ? "07-finish-phone" : a.name === "finish-desktop" ? "08-finish-desktop" : a.name === "retained" ? "09-retained" : "01-prepare";
    const capturePath = `screens/${screen}.png`, captureSourcePath=`captures/${screen}.png`, captureDigest = H.b5Bytes(raw[capturePath]!);
    files[a.receiptPath] = { schemaVersion:1, sessionNonce, sequence:a.sequence, phase:phases[a.name], origin:"http://127.0.0.1:60460", device:a.device,
      expiresAt:time(50), binding:{requestId,runLinkId:card.evidence.binding.runLinkId,inputVersion:card.localVersion}, observedAt:a.at,
      real:false, browser:"synthetic receipt fixture", actions:[words[a.name]],
      captures:[{path:captureSourcePath,sha256:captureDigest,device:a.device,sessionNonce,sequence:a.sequence,capturedAt:a.at}],
      observation:{sessionDigest:H.b5Bytes(sessionNonce),routeClass:"project-document",method:"GET",status:200,observedAt:a.at,sessionNonce,sequence:a.sequence,device:a.device} };
    if (a.sequence >= 11) journey.serviceFacts.push({ screen, device:a.device, requestId, localVersion:card.localVersion, runLinkId:card.evidence.binding.runLinkId, inputVersion:card.a2InputVersion,
      baseRevision:base,candidateRevision:card.candidateRevision,at:a.at,sequence:a.sequence,responseDigest,captureSourcePath,capturePath,captureDigest,receiptPath:a.receiptPath });
  }
  delete (files['receipts/1.json'] as Record<string,unknown>).binding;
  for (const [sequence,device,minute] of [[4,"phone",3.1],[5,"desktop",3.1],[9,"phone",6.5],[10,"desktop",6.5]] as const) {
    const r = structuredClone(files['receipts/1.json']) as Record<string,unknown>, sessionNonce=sequence.toString(16).padStart(32,'0');
    Object.assign(r,{binding:{requestId,runLinkId:card.evidence.binding.runLinkId,inputVersion:card.localVersion},phase:'close',sequence,sessionNonce,device,observedAt:time(minute),actions:['closed'],closeAttestation:{actor:'owner',closedAt:time(minute),allProofTabsClosed:true}});
    Object.assign(r.observation as object,{sequence,sessionNonce,device,observedAt:time(minute)});
    Object.assign((r.captures as object[])[0]!,{sequence,sessionNonce,device,capturedAt:time(minute)});
    files[`receipts/${sequence}.json`]=r;
  }
  for (const [path,bytes] of Object.entries(raw)) if(path.startsWith('screens/')) raw[`mailbox/captures/${path.slice('screens/'.length)}`]=bytes;
  type Files = { files: Record<string, unknown>; manifest: Record<string, unknown> };
  const write = async (change: (v: Files) => void = () => {}) => {
    await rm(dir, { recursive: true, force: true }); await mkdir(join(dir, "screens"), { recursive: true, mode:0o700 }); await chmod(dir,0o700); await mkdir(join(dir, "status-check"),{mode:0o700}); await mkdir(join(dir, "receipts"),{mode:0o700}); await mkdir(join(dir,"mailbox"),{mode:0o700}); await mkdir(join(dir,"mailbox/captures"),{mode:0o700});
    const b = card.evidence.binding, binding = (name: string, roles: string[], sha256: string, revision: number) =>
      ({ name, roles, sha256, path: `/scratch/work/run/inputs/${name}.md`, revision, at: time(1), receiptDigest: H.b5Bytes(name) });
    const manifest: Record<string, unknown> = { schemaVersion: 1, kind: "b5-first-website-proof",
      product: { baseRevision: fixturePins.productBase, headRevision: fixturePins.productHead, environmentDigest: b.environmentDigest },
      pins: { a2ToolingRevision: fixturePins.toolingRevision, schemaDigest: fixturePins.schemaDigest, jobSandboxDigest: H.b5Bytes("sandbox"), qualificationDigest: digests.qualification,
        recipeDigest: b.recipeDigest, settingsSha256: digests.settings, availabilitySha256: digests.availability, faultInputSha256: digests.faultInput,
        reviewInputSha256: digests.reviewInput, authorizationSha256: digests.authorization, assemblyDigest: digests.assembly, assemblyExport: "createFirstWebsiteHostV1",
        inputBindings: [binding("b5-builder-fault", ["build"], digests.faultInput, 2), binding("b5-review-instruction", ["code-review"], digests.reviewInput, 3)] },
      risk: { categories: ["code", "owner_visible", "ci"], slots: ["attack-review", "ui-review", "ci-review"] },
      launch: { uid: 501, context: "current-session", isolationClaim: "none", consumedRoots: ["runs", "work", "config"] },
      lineage: { requestId, runLinkId: b.runLinkId, loopRunId: b.loopRunId, localVersion: card.localVersion, a2InputVersion: card.a2InputVersion },
      heads: { base, rejected: p.rejected, final: p.final },
      classification: { website: "real", storage: "real", engine: "real", sendBack: "real", recovery: "real", finish: "real", device: "fixture", providers: "fixture", stimuli: "fixture" },
      timestamps: { startedAt: time(0), finishedAt: time(45) } };
    const v = { files: structuredClone(files), manifest }; change(v);
    const bytes = new Map<string, string | Uint8Array>(Object.entries(raw));
    for (const [name, value] of Object.entries(v.files)) bytes.set(name, JSON.stringify(value));
    for (const [name, value] of bytes) await writeFile(join(dir, name), value, {mode:0o600});
    v.manifest.artifacts ??= [...bytes].map(([path, value]) => ({ path, sha256: H.b5Bytes(value), bytes: Buffer.byteLength(value) }));
    await writeFile(join(dir, "manifest.json"), JSON.stringify(v.manifest), {mode:0o600});
  };
  type Journey = { steps: Record<string, unknown>[]; devices: Record<string, unknown>[]; dom: Record<string, unknown>[] };
  const verify = (o: { readCard?: () => Promise<unknown>; pins?: B5QualifiedPinsV1 } = {}) =>
    H.verifyFirstWebsiteEvidenceV1(dir, { readCard: o.readCard ?? readCard, candidateRepository: p.project, pins: o.pins ?? fixturePins });
  const refusal = (o: Parameters<typeof verify>[0] = {}) => verify(o).then(v => v.state, (e: unknown) => e instanceof H.B5RefusalV1 ? e.code : String(e));
  return { p, f, dir, card, readCard, fixturePins, qualifiedPins, write, verify, refusal, journey: (v: Files) => v.files["journey.json"] as Journey,
    teardown: (v: Files) => v.files["teardown.json"] as Record<string, unknown>,
    snapshot: (v: Files) => v.files["database-snapshot.json"] as { rows: { table: string; sha256: string; row: Record<string, unknown> }[] } };
}
test("B5 verifier accepts fixture evidence only as incomplete", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(); assert.deepEqual(await e.verify(), { state: "incomplete", reasons: ["B5_PROVIDER_FIXTURE", "B5_PHONE_EVIDENCE_MISSING", "B5_DESKTOP_EVIDENCE_MISSING"], transportCleanup:noMappingCleanup() });
  await e.write(v => { e.journey(v).devices = [{ kind: "phone", real: false, browser: "360px emulation" }, { kind: "desktop", real: false, browser: "desktop browser" }]; });
  assert.deepEqual(await e.verify(), { state: "incomplete", reasons: ["B5_PROVIDER_FIXTURE", "B5_PHONE_EVIDENCE_MISSING", "B5_DESKTOP_EVIDENCE_MISSING"], transportCleanup:noMappingCleanup() });
  await e.write(); await writeFile(join(e.dir, "screens/03-question.png"), "changed");
  assert.equal(await e.refusal(), "B5_ARTIFACT_BYTES", "B5 changed retained bytes are refused");
  await e.write(v => { v.manifest.artifacts = []; }); assert.equal(await e.refusal(), "B5_MANIFEST_INVALID");
  await e.write(v => { v.manifest.classification = { ...(v.manifest.classification as object), engine: "fixture" }; });
  assert.equal(await e.refusal(), "B5_MANIFEST_INVALID", "B5 a fixture engine classification never satisfies the real schema");
  await e.write(); assert.equal(await e.refusal({ readCard: async () => null }), "B5_CARD_UNAVAILABLE", "B5 no service card is never complete");
});
test("B5 real bundle claims require real evidence pins independently of caller pins", async t => {
  await load(); const e=await evidenceSet(t);
  for (const claim of ['manifest','receipt','unreferenced receipt'] as const) {
    await e.write(v=>{
      if (claim === 'manifest') (v.manifest.classification as Record<string,unknown>).device='real';
      else {
        const receipt=structuredClone(v.files['receipts/1.json']) as Record<string,unknown>;
        receipt.real=true;
        v.files[claim === 'receipt' ? 'receipts/1.json' : 'receipts/unreferenced.json']=receipt;
      }
    });
    await assert.rejects(e.verify(),{code:'B5_REAL_EVIDENCE_QUALIFICATION_REQUIRED'},claim);
  }
  console.log('RESULT: PASS manifest and referenced/unreferenced receipt real claims refuse missing realEvidence pins');
});
test("B5 verifier refuses a fixture chain presented as real", async t => {
  await load();
  const e = await evidenceSet(t);
  // The manifest claims the qualified pins; the card the service returned was produced by the SYNTHETIC engine.
  await e.write(v => { (v.manifest.pins as Record<string, unknown>).a2ToolingRevision = e.qualifiedPins.toolingRevision; });
  assert.equal(await e.refusal({ pins: e.qualifiedPins }), "B5_FIXTURE_NOT_REAL", "B5 forged fixture chain is refused by its own guard");
  await e.write(); assert.equal(await e.refusal({ pins: e.qualifiedPins }), "B5_FIXTURE_NOT_REAL", "B5 fixture manifest pins are refused");
  // Retained rows that are not the card's own rows, and a journey that omits a verified card review.
  await e.write(v => { const row = e.snapshot(v).rows.find(r => r.table === "control_loop_update_candidates")!; row.row.record_digest = H.b5Bytes("other"); row.sha256 = H.b5Bytes(JSON.stringify(row.row)); });
  assert.equal(await e.refusal(), "B5_FIXTURE_NOT_REAL");
  await e.write(v => { e.journey(v).steps = e.journey(v).steps.filter(s => s.role !== "ui-review"); }); assert.equal(await e.refusal(), "B5_FIXTURE_NOT_REAL");
  await e.write(v => { e.snapshot(v).rows[0]!.row.id = "changed"; }); assert.equal(await e.refusal(), "B5_SNAPSHOT_INVALID");
});
test("B5 verifier binds rejected and final heads to the saved card", async t => {
  await load();
  const e = await evidenceSet(t);
  // A stale service card, rendered as such on every device.
  const stale = JSON.parse(JSON.stringify(e.card).replaceAll(e.p.final, e.p.rejected)) as LoopCandidateCardV1;
  await e.write(v => { for (const d of e.journey(v).dom) d.candidateRevision = e.p.rejected; });
  assert.equal(await e.refusal({ readCard: async () => stale }), "B5_HEAD_BINDING", "B5 stale card head is refused by the head guard");
  await e.write(v => { e.journey(v).dom[1]!.candidateRevision = e.p.rejected; }); assert.equal(await e.refusal(), "B5_HEAD_BINDING", "B5 finish DOM must show the card head");
});
/** The saved card with its check rows changed, served as a real HTTP response. The retained
 * capture facts bind the response digest, so `patch` re-binds them to the changed bytes. */
function cardVariant(e: Awaited<ReturnType<typeof evidenceSet>>, change: (checks: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const card = structuredClone(e.card) as unknown as { evidence: { checks: Record<string, unknown>[] } };
  card.evidence.checks = change(card.evidence.checks);
  const body = JSON.stringify({ candidate: card }), responseDigest = H.b5Bytes(body);
  return { readCard: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    patch: (v: { files: Record<string, unknown> }) => { for (const f of (v.files["journey.json"] as { serviceFacts: { responseDigest: string }[] }).serviceFacts) f.responseDigest = responseDigest; } };
}
const INCOMPLETE = "incomplete";
/** The refusal code with its detail, so a test can tell which guard refused. */
const refusalAt = (e: Awaited<ReturnType<typeof evidenceSet>>, o: Parameters<typeof e.verify>[0] = {}) =>
  e.verify(o).then(v => v.state, (err: unknown) => err instanceof H.B5RefusalV1 ? `${err.code}:${err.detail}` : String(err));
const withoutStatus = (checks: Record<string, unknown>[]) => checks.filter(c => c.id !== "site-status");
/** A wire-valid site-status row (the passing site-smoke row under another id). */
const withStatus = (required: boolean) => (checks: Record<string, unknown>[]) =>
  [...withoutStatus(checks), { ...checks.find(c => c.id === "site-smoke")!, id: "site-status", commandLabel: "SYNTHETIC site-status", required }];
test("B5 verifier accepts the card a real run produces: a site-smoke row and no site-status row", async t => {
  await load();
  const e = await evidenceSet(t);
  const realRun = cardVariant(e, withoutStatus);
  await e.write(realRun.patch);
  // Fixture evidence is never complete, so the accepted outcome is the same incomplete verdict.
  assert.equal(await refusalAt(e, { readCard: realRun.readCard }), INCOMPLETE, "B5 a card without the optional site-status row is not refused as card checks");
});
test("B5 verifier keeps the site-status card row optional", async t => {
  await load();
  const e = await evidenceSet(t);
  // site-status is the controller's independent diagnostic (independent records + review sidecar). A card row, if A2
  // carries one, is accepted only as optional; refusing a required row is a policy proxy.
  const optional = cardVariant(e, withStatus(false)), required = cardVariant(e, withStatus(true));
  await e.write(optional.patch);
  assert.equal(await refusalAt(e, { readCard: optional.readCard }), INCOMPLETE, "B5 a valid optional site-status row is still accepted");
  await e.write(required.patch);
  assert.equal(await refusalAt(e, { readCard: required.readCard }), "B5_HEAD_BINDING:card checks", "B5 a wire-valid REQUIRED site-status row is refused");
});
test("B5 an optional site-status PASS cannot mask a failing required site-smoke", async t => {
  await load();
  const e = await evidenceSet(t);
  const masked = cardVariant(e, checks => withStatus(false)(checks).map(c => c.id === "site-smoke"
    ? { ...c, status: "FAIL", exitCode: 1, passed: 0, failed: 1 } : c));
  await e.write(masked.patch);
  // The wire parse refuses a required check that is not a clean PASS before the head guard is reached.
  assert.equal(await refusalAt(e, { readCard: masked.readCard }), "B5_CARD_UNAVAILABLE:");
});
test("B5 an optional site-status PASS cannot rescue a failing independent diagnostic record", async t => {
  await load();
  const e = await evidenceSet(t);
  const optional = cardVariant(e, withStatus(false));
  await e.write(v => { optional.patch(v); });
  assert.equal(await refusalAt(e, { readCard: optional.readCard }), INCOMPLETE, "B5 control: unchanged records are accepted with this card");
  await e.write(v => { optional.patch(v); (v.files["independent-status-check.json"] as B5StatusCheckRecordV1[])[1]!.exitCode = 1; });
  assert.equal(await refusalAt(e, { readCard: optional.readCard }), "B5_HEAD_BINDING:diagnostic results", "B5 a failing final independent record is refused");
  await e.write(v => { optional.patch(v); v.files["independent-status-check.json"] = (v.files["independent-status-check.json"] as B5StatusCheckRecordV1[]).slice(0, 1); });
  assert.equal(await refusalAt(e, { readCard: optional.readCard }), "B5_HEAD_BINDING:diagnostic heads", "B5 a missing final independent record is refused");
});
test("B5 verifier re-reads the candidate repository and its page facts", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(); await writeFile(join(e.p.project, "notes.txt"), "untracked");
  assert.equal(await e.refusal(), "B5_CANDIDATE_REPOSITORY", "B5 dirty candidate repository is refused");
  await rm(join(e.p.project, "notes.txt")); assert.equal(await e.refusal(), "incomplete");
  await writeFile(join(e.p.project, "index.html"), (await readFile(join(e.p.project, "index.html"), "utf8")).replace(' role="status"', ""));
  await git(e.p.project, ["commit", "--quiet", "-am", "Later change"]);
  assert.equal(await e.refusal(), "B5_CANDIDATE_REPOSITORY", "B5 a moved candidate HEAD is refused");
  await git(e.p.project, ["reset", "--quiet", "--hard", e.p.final]); assert.equal(await e.refusal(), "incomplete");
  await e.write(v => { (v.manifest.pins as Record<string, unknown>).settingsSha256 = H.b5Bytes("other settings"); });
  assert.equal(await e.refusal(), "B5_MANIFEST_PINS", "B5 manifest pins must equal the preflight digests");
  await e.write(v => { for (const b of (v.manifest.pins as { inputBindings: { at: string }[] }).inputBindings) b.at = "2026-10-30T12:05:00.000Z"; });
  assert.equal(await e.refusal(), "B5_MANIFEST_PINS", "B5 scoped inputs bound after confirmation are refused");
});
test("B5 verifier requires closed-browser rejection and original-builder repair", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(v => { e.journey(v).steps[3]!.identity = "writer-other"; });
  assert.equal(await e.refusal(), "B5_REJECTION_REPAIR", "B5 repair by a different writer is refused by the repair guard");
});
test("B5 verifier requires full cleanup before the retained read-back", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(v => { e.teardown(v).b3cCleanup = "refused"; });
  assert.equal(await e.refusal(), "B5_CLEANUP_RETAINED", "B5 refused cleanup is refused by the cleanup guard");
});
test("B5 verifier refuses chronologically impossible and refusal-only proofs", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(v => { e.journey(v).steps[2]!.findings = []; }); assert.equal(await e.refusal(), "B5_REJECTION_REPAIR");
  await e.write(v => { e.journey(v).steps[4]!.startedAt = "2026-10-30T12:01:00.000Z"; }); assert.equal(await e.refusal(), "B5_REJECTION_REPAIR");
  await e.write(v => { e.journey(v).steps[2]!.verdict = "CLEAN"; }); assert.equal(await e.refusal(), "B5_FIXTURE_NOT_REAL", "B5 a journey contradicting the card's rejection is refused");
  await e.write(v => { (v.files["independent-status-check.json"] as B5StatusCheckRecordV1[]).reverse().forEach(r => { r.head = e.p.final; }); });
  assert.equal(await e.refusal(), "B5_HEAD_BINDING");
  await e.write(v => { e.teardown(v).retainedRead = null; }); assert.equal(await e.refusal(), "B5_CLEANUP_RETAINED");
});

/** A stand-in for the landed A2 entry: it implements only the documented `bind-input`
 * contract (tools loop/README.md) over files in its own cwd. The real writer is A2's. */
const FAKE_A2 = `import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const args = process.argv.slice(2), mode = existsSync("mode.json") ? JSON.parse(readFileSync("mode.json", "utf8")) : {};
if (args[0] !== "bind-input") process.exit(2);
if (args[1] === "--help") { console.log(mode.noRole ? "usage: cr bind-input RUN NAME --file FILE --json" : "usage: cr bind-input RUN NAME --file FILE --role ROLE [--role ROLE ...] [--json]"); process.exit(0); }
const [run, name] = args.slice(1, 3), file = args[args.indexOf("--file") + 1], roles = args.flatMap((a, i) => a === "--role" ? [args[i + 1]] : []).sort();
if (mode.refuse) { console.log(JSON.stringify({ error: mode.refuse })); process.exit(2); }
const state = existsSync("state.json") ? JSON.parse(readFileSync("state.json", "utf8")) : { revision: 1, bindings: [] };
const data = readFileSync(file), sha256 = createHash("sha256").update(data).digest("hex"), dir = resolve("runs", run, "inputs");
mkdirSync(dir, { recursive: true }); const path = join(dir, name + "-" + sha256.slice(0, 16) + ".md"); if (!existsSync(path)) { copyFileSync(file, path); chmodSync(path, 0o444); }
state.revision += 1;
const receipt = { name, index: state.bindings.length, path, sha256, size: data.length, roles: mode.widen ? ["build", "code-review"] : roles, source: file,
  at: new Date().toISOString(), input_version: 1, revision: state.revision, invalidated: mode.confirmed ? ["expect", "confirmation"] : ["expect"], replaces: null };
state.bindings.push(receipt); writeFileSync("state.json", JSON.stringify(state));
console.log(JSON.stringify({ run, receipt }));
`;
test("B5 binds the builder fault and the review instruction through A2 bind-input before confirmation", async t => {
  await load();
  const s = await scratch(t), a2 = join(s.root, "a2"); await mkdir(a2);
  await writeFile(join(a2, "cr.mjs"), FAKE_A2);
  const entry = { interpreter: process.execPath, entrypoint: join(a2, "cr.mjs"), cwd: a2 };
  const files = { faultInput: s.config.faultInputFile, reviewInput: s.config.reviewInputFile };
  const digests = { faultInput: H.b5Bytes(await readFile(files.faultInput)), reviewInput: H.b5Bytes(await readFile(files.reviewInput)) };
  let stage = 0;
  const bind = () => H.bindFirstWebsiteInputsV1({ entry, loopRunId: "run-b5", stageDir: join(s.root, "work", `b5-supplied-${++stage}`), files, digests, runWorkDir: join(a2, "runs", "run-b5") });
  const code = (p: Promise<unknown>) => p.then(() => "PASSED", (e: unknown) => e instanceof H.B5RefusalV1 ? e.code : String(e));
  await mkdir(join(s.root, "work"));
  await H.probeBindInputCapabilityV1(entry);
  const receipts = await bind();
  assert.deepEqual(receipts.map(r => [r.name, r.roles]), [["b5-builder-fault", ["build"]], ["b5-review-instruction", ["code-review"]]], "B5 fault binds to build only and the instruction to code-review only");
  assert.deepEqual(receipts.map(r => `sha256:${r.sha256}`), [digests.faultInput, digests.reviewInput]);
  for (const r of receipts) assert.equal((await lstat(r.path)).mode & 0o222, 0, "B5 bound copies are read-only");
  // Generated briefs: only the named roles carry A2's supplied-input line.
  const line = (r: B5BindInputReceiptV1) => `Additional supplied input (read in full): ${r.path} (SHA256 ${r.sha256})`;
  const briefs = [{ role: "plan", text: "Plan." }, { role: "build", text: `Build.\n${line(receipts[0]!)}\n` },
    { role: "code-review", text: `Review. The builder report mentions ${receipts[0]!.path}.\n${line(receipts[1]!)}\n` }, { role: "code-review", text: `Review.\n${line(receipts[1]!)}\n` }];
  H.assertRoleScopedBriefsV1(briefs, receipts);
  assert.throws(() => H.assertRoleScopedBriefsV1([...briefs, { role: "final", text: line(receipts[0]!) }], receipts), /B5_BRIEF_SCOPE/u, "B5 a fault line in another role's brief is refused");
  assert.throws(() => H.assertRoleScopedBriefsV1(briefs.slice(0, 3), receipts), /B5_BRIEF_SCOPE/u, "B5 both code reviews must receive the instruction");
  // Refusals: late binding, widened roles, A2 refusal, changed input and a missing writer.
  const modes: [Record<string, unknown>, string][] = [[{ confirmed: true }, "B5_INPUT_BINDING_LATE"], [{ widen: true }, "B5_INPUT_BINDING_RECEIPT"],
    [{ refuse: "SUPPLIED_ROLE_UNUSED" }, "B5_INPUT_BINDING_REFUSED"]];
  for (const [mode, expected] of modes) { await writeFile(join(a2, "mode.json"), JSON.stringify(mode)); assert.equal(await code(bind()), expected); }
  await writeFile(join(a2, "mode.json"), JSON.stringify({ noRole: true }));
  assert.equal(await code(H.probeBindInputCapabilityV1(entry)), "B5_A2_BIND_INPUT_UNAVAILABLE");
  await writeFile(join(a2, "mode.json"), "{}"); await writeFile(files.faultInput, "changed after preflight");
  assert.equal(await code(bind()), "B5_INPUT_CHANGED");
});

test("B5 consumed owner actions require the original replay key after a challenge restart", async t => {
  await load();
  const f = await H.syntheticFirstWebsiteFixtureV1(); t.after(() => f.close());
  const project = f.project.projectId;
  const intakeBody = { description: H.B5_REQUEST_TEXT }, intakeKey = "restart-intake-original";
  await f.bridge.mutate(f.identity, project, null, "intake", intakeBody, intakeKey);
  const intakeCalls = f.calls.length;
  await assert.rejects(f.bridge.mutate(f.identity, project, null, "intake",
    { description: H.B5_REQUEST_TEXT + " Changed request." }, intakeKey), { code: "conflict" });
  assert.equal((await f.bridge.mutate(f.identity, project, null, "intake", intakeBody, intakeKey)).replayed, true);
  assert.equal(f.calls.length, intakeCalls, "changed-body intake refused and exact replay does not create another run");
  const requestId = (await f.desk.viewLoopDesk(f.identity, project)).loopRequests[0]!.requestId;
  const current = () => f.bridge.status(f.identity, project, requestId);
  const check = async (operation: "confirm" | "start" | "answer" | "approve", body: Record<string, unknown>, label: string = operation) => {
    const originalKey = `restart-${label}-original`;
    const first = await f.bridge.mutate(f.identity, project, requestId, operation, body, originalKey);
    assert.equal(first.state, "accepted");
    const calls = f.calls.length;
    // Refresh revision/version so this exercises consumed gates rather than
    // merely refusing a stale pre-action snapshot after a fresh sign-in.
    const after = await current(), freshBody = { ...body, expectedVersion: after.request.currentVersion, expectedRevision: after.engine.revision };
    await assert.rejects(f.bridge.mutate(f.identity, project, requestId, operation, freshBody, `restart-${label}-fresh`),
      { code: "conflict" });
    const changedBody = operation === "confirm" ? { ...body, requestSha256: "f".repeat(64) }
      : operation === "start" ? { ...body, runLinkId: "run-link:other" }
        : operation === "answer" ? { ...body, text: "A different answer." }
          : { ...body, reportSha256: "f".repeat(64) };
    await assert.rejects(f.bridge.mutate(f.identity, project, requestId, operation, changedBody, originalKey),
      { code: "conflict" }, "original key cannot authorize a changed command body");
    if (operation === "approve") {
      await assert.rejects(f.bridge.readApprovalDocument(f.identity, project, requestId), { code: "conflict" });
      const document = await f.handle(webRequest(`/api/v1/projects/${encodeURIComponent(project)}/improvements/loop/${encodeURIComponent(requestId)}/approval-document`));
      assert.equal(document.status, 409, "normal owner HTTP document route cannot re-read the consumed approval");
    }
    const replay = await f.bridge.mutate(f.identity, project, requestId, operation, body, originalKey);
    assert.equal(replay.state, "accepted"); assert.equal(replay.replayed, true);
    assert.equal(f.calls.length, calls, "exact replay never repeats the engine action");
  };
  let s = await current();
  await check("confirm", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
    requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 });
  s = await current();
  assert.equal(s.display.confirmationCurrent, true);
  await check("start", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId });
  s = await current(); assert.equal(s.display.canStart, false); assert.equal(s.display.startState, "started");
  assert.equal(await f.tick(), "question"); s = await current();
  await check("answer", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
    questionId: f.question.questionId, inputVersion: f.question.inputVersion, questionReportSha256: f.question.reportSha256, text: "Amber." });
  const answered = await current();
  assert.equal(answered.engine.question, null);
  assert.equal(answered.decisions?.gate, null, "fresh current status cannot supply the consumed question for owner re-reading");
  for (const step of ["plan", "spec"] as const) {
    assert.equal(await f.tick(), `${step}-waiting`); s = await current();
    await check("approve", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, ...s.engine.approval! }, `approve-${step}`);
    assert.equal((await current()).engine.approval, null);
  }
  console.log("RESULT: PASS intake/Confirm/Start/Answer/plan/spec changed-body-original-key=conflict consumed-new-key=conflict exact-original=accepted-replay consumed-document-HTTP=409 consumed-question-absent engine-actions-not-repeated");
});

test("B5 SYNTHETIC journey keeps one run through closed sessions and a quiescent restart, and records the finish card", async t => {
  await load();
  const f = await H.syntheticFirstWebsiteFixtureV1(); t.after(() => f.close());
  const project = f.project.projectId, base = `/api/v1/projects/${encodeURIComponent(project)}/improvements/loop`;
  await f.bridge.mutate(f.identity, project, null, "intake", { description: H.B5_REQUEST_TEXT }, "b5-intake-000000001");
  const desk = await f.desk.viewLoopDesk(f.identity, project), requestId = desk.loopRequests[0]!.requestId;
  assert.equal(desk.loopRequests.length, 1); assert.deepEqual(f.calls, ["intake"], "B5 Prepare creates no clone, plan or Start");
  const current = () => f.bridge.status(f.identity, project, requestId);
  let s = await current();
  await f.bridge.mutate(f.identity, project, requestId, "confirm", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
    requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 }, "b5-confirm-00000001");
  assert.deepEqual(f.calls, ["intake", "confirm"], "B5 confirmation alone causes zero Start");
  s = await current(); const runLinkId = desk.loopRequests[0]!.runLink!.runLinkId;
  const start = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId };
  await f.bridge.mutate(f.identity, project, requestId, "start", start, "b5-start-0000000001");
  await f.bridge.mutate(f.identity, project, requestId, "start", start, "b5-start-0000000001");
  assert.equal(f.calls.filter(c => c === "start").length, 1, "B5 exact Start retry consumes once");
  // Browser closed: the owned host advances saved state without any request.
  assert.equal(await f.tick(), "question");
  const launches = f.launches(), attention = async () => { const a = await f.bridge.readAttention(f.identity); assert.equal(a.state, "available"); return a; };
  const first = await attention(); assert.equal(first.state === "available" && first.items.length, 1);
  await f.tick(); await f.tick(); assert.equal(f.launches(), launches, "B5 unanswered question launches no new worker over two ticks");
  await f.restart(); assert.equal(f.restarts(), 1);
  assert.deepEqual(await attention(), first, "B5 quiescent restart keeps the same question and count");
  s = await current(); const q = f.question;
  const answer = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, questionId: q.questionId, inputVersion: q.inputVersion,
    questionReportSha256: q.reportSha256, text: "Amber." };
  await assert.rejects(f.bridge.mutate(f.identity, project, requestId, "answer", { ...answer, questionId: "question:other" }, "b5-answer-wrong-01"));
  await assert.rejects(f.bridge.mutate(f.identity, project, requestId, "answer", { ...answer, expectedRevision: s.engine.revision - 1 }, "b5-answer-stale-01"));
  await f.bridge.mutate(f.identity, project, requestId, "answer", answer, "b5-answer-00000001");
  assert.equal(f.calls.filter(c => c === "answer").length, 1); assert.equal(f.answer(), "Amber.");
  for (const step of ["plan", "spec"] as const) {
    assert.equal(await f.tick(), `${step}-waiting`); s = await current();
    const status = f.status()!, approval = status.approval!;
    await f.bridge.mutate(f.identity, project, requestId, "approve", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
      step, inputVersion: approval.inputVersion, head: approval.head, reportSha256: approval.reportSha256 }, `b5-approve-${step}-0001`);
  }
  // Browser closed again: build, reviewer rejection, original-builder repair and fresh reviews.
  assert.equal(await f.tick(), "finished");
  const roles = f.steps.map(x => `${x.role}:${x.head === f.heads.rejected ? "rejected" : x.head === f.heads.final ? "final" : "base"}:${x.verdict}`);
  assert.deepEqual(roles.slice(5, 8), ["build:rejected:DONE", "code-review:rejected:NEEDS-FIX", "build:final:DONE"]);
  // The website Confirm records the Start authorization under its own key; B4 lineage binds
  // it through the signed Start claim's authorization id, so the website-started run publishes.
  const authorization = (await f.client.query<{ id: string; start_key: string }>("SELECT id,start_key FROM control_loop_improvement_authorizations")).rows;
  const claim = (await f.client.query<{ idempotency_key: string; binding: { authorizationId?: string } }>(
    "SELECT idempotency_key,binding FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows;
  assert.equal(authorization.length, 1); assert.equal(claim.length, 1); assert.equal(claim[0]!.idempotency_key, "b5-start-0000000001");
  assert.match(authorization[0]!.start_key, /^start:/u); assert.notEqual(authorization[0]!.start_key, claim[0]!.idempotency_key);
  assert.equal(claim[0]!.binding.authorizationId, authorization[0]!.id, "B5 the website Start claim names the Confirm-recorded authorization");
  assert.equal((await f.publish()).state, "recorded", "B5 website-started run records its B4 finish card");
  assert.equal((await f.publish()).state, "replayed", "B5 finish-card publication replays exactly");
  assert.equal((await f.client.query("SELECT 1 FROM control_loop_update_candidates")).rows.length, 1);
  const card = await f.handle(webRequest(`${base}/${encodeURIComponent(requestId)}/candidate`)); assert.equal(card.status, 200);
  const published = (await card.json()).candidate;
  assert.equal(published?.evidence?.binding?.candidateRevision, f.heads.final, "B5 the finish card names the repaired head");
  assert.equal(published?.evidence?.binding?.requestId, requestId); assert.equal(published?.evidence?.binding?.runLinkId, runLinkId);
  assert.equal(f.calls.filter(c => c === "start").length, 1); assert.equal((await f.desk.viewLoopDesk(f.identity, project)).loopRequests.length, 1);
  // The finish card is labelled fixture evidence and cannot satisfy the real verifier.
  const dir = join(await owned(t, "b5-forged-"), "evidence"); await mkdir(dir,{mode:0o700});
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, kind: "b5-first-website-proof", state: "finished", source: "SYNTHETIC" }), {mode:0o600});
  await assert.rejects(H.verifyFirstWebsiteEvidenceV1(dir, { readCard: async () => published, candidateRepository: resolve("."),
    pins: { capture: { phoneCapture:"native-screenshot+server", qualificationDigest:H.b5Bytes("capture qualification"),approval:"approved",approvalEvidenceDigest:H.b5Bytes("synthetic approval qualification") }, providers: { classification: "fixture", transport: "scripted", toolingRevision: H.b5Bytes("qualified A2 tooling"),
      availabilitySha256: H.b5Bytes("availability"), lineup: [{ role: "build", identity: "fixture", family: "fixture", route: "fixture", grade: "fixture" }] }, toolingRevision: H.b5Bytes("qualified A2 tooling"), schemaDigest: H.b5Bytes("schema"), productBase: "1".repeat(40), productHead: "2".repeat(40), uid: 501,
      digests: { settings: "", availability: "", authorization: "", qualification: "", assembly: "", faultInput: "", reviewInput: "" } } }),
  (e: unknown) => e instanceof H.B5RefusalV1 && e.code === "B5_PROVIDER_PROVENANCE_MISSING");
});

// Check 2's product-observable refusals through the real bridge over the SYNTHETIC engine.
// Engine-internal send-back routing, the fourth-question cap and final-rejection invalidation
// are A2 policy and stay on A2's own reviewed tools suites.
test("B5 SYNTHETIC companion refuses stale admission, a second Start and answers after Stop", async t => {
  await load();
  const f = await H.syntheticFirstWebsiteFixtureV1(); t.after(() => f.close());
  const project = f.project.projectId, mutate = f.bridge.mutate.bind(f.bridge, f.identity, project);
  await mutate(null, "intake", { description: H.B5_REQUEST_TEXT }, "b5-c-intake-000001");
  const saved = (await f.desk.viewLoopDesk(f.identity, project)).loopRequests[0]!, requestId = saved.requestId, runLinkId = saved.runLink!.runLinkId;
  const current = () => f.bridge.status(f.identity, project, requestId);
  let s = await current();
  const confirm = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 };
  await assert.rejects(mutate(requestId, "confirm", { ...confirm, requestSha256: "0".repeat(64) }, "b5-c-confirm-stale1"), /conflict/u, "B5 a changed request is stale at confirmation");
  await assert.rejects(mutate(requestId, "confirm", { ...confirm, settingsSha256: "0".repeat(64) }, "b5-c-confirm-stale2"), /conflict/u, "B5 changed settings are stale at confirmation");
  await assert.rejects(mutate(requestId, "start", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId }, "b5-c-start-early01"), /conflict/u,
    "B5 Start before the exact confirmation is refused");
  assert.equal(f.calls.filter(c => c === "start" || c === "confirm").length, 0, "B5 refused admissions reach no engine command");
  await mutate(requestId, "confirm", confirm, "b5-c-confirm-00001"); s = await current();
  const start = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId };
  await mutate(requestId, "start", start, "b5-c-start-000001");
  await assert.rejects(mutate(requestId, "start", start, "b5-c-start-000002"), /conflict/u, "B5 a second Start under another key is refused");
  await mutate(requestId, "start", start, "b5-c-start-000001"); // the reply was lost; the exact retry replays
  assert.equal(f.calls.filter(c => c === "start").length, 1, "B5 duplicate Start and lost-reply retry consume once");
  assert.equal(await f.tick(), "question"); s = await current();
  const q = f.question, answer = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, questionId: q.questionId,
    inputVersion: q.inputVersion, questionReportSha256: q.reportSha256, text: "Amber." };
  await assert.rejects(mutate(requestId, "answer", { ...answer, inputVersion: "SYNTHETIC:0" }, "b5-c-answer-input01"), /conflict/u, "B5 an answer for another input version is refused");
  await assert.rejects(mutate(requestId, "answer", { ...answer, questionReportSha256: "f".repeat(64) }, "b5-c-answer-report1"), /conflict/u, "B5 an answer for another question report is refused");
  // Reads and two owned restarts while waiting are read-only.
  const calls = f.calls.length, launches = f.launches();
  await f.restart(); await current(); await f.bridge.readAttention(f.identity); await f.restart(); s = await current();
  assert.equal(f.calls.length, calls); assert.equal(f.launches(), launches); assert.equal(f.restarts(), 2);
  // Stop while waiting, then the saved question can no longer be answered.
  await mutate(requestId, "stop", { runLinkId }, "b5-c-stop-0000001");
  assert.equal(f.status()!.state, "stopped"); assert.equal(await f.tick(), "stopped", "B5 a stopped run does not advance");
  s = await current();
  await assert.rejects(mutate(requestId, "answer", { ...answer, expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision }, "b5-c-answer-stop01"), /conflict/u,
    "B5 an answer after Stop is refused");
  assert.equal(f.calls.filter(c => c === "answer").length, 0); assert.equal(f.launches(), launches, "B5 Stop launches no worker");
  assert.equal((await f.desk.viewLoopDesk(f.identity, project)).loopRequests.length, 1, "B5 one saved request throughout");
});

test("F03a outer assembly lifecycle is available after helper import", async () => {
  const helper = await load();
  assert.equal(typeof (helper as Record<string, unknown>).withFirstWebsiteHostV1, "function",
    "the imported helper must own late acquisition and all-exit close");
  const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts as Record<string, string>;
  for (const name of ["test", "test:improve-control-room-first-website"])
    assert.ok(scripts[name]!.includes("tests/improve-control-room-first-website-host-postgres.test.ts"),
      `F03a guarded host tests are registered in ${name}`);
});

test("F03a outer lifecycle closes a late acquisition before returning an abort", async () => {
  await load();
  const abort = new AbortController();
  let release!: () => void, entered!: () => void, closed = 0, body = 0;
  const opening = new Promise<void>(yes => { entered = yes; });
  const barrier = new Promise<void>(yes => { release = yes; });
  const result = H.withFirstWebsiteHostV1({} as never, abort.signal, async () => { body++; }, async () => {
    entered(); await barrier;
    return { close: async () => { closed++; } } as never;
  });
  await opening; abort.abort();
  let settled = false; void result.catch(() => {}).finally(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false, "abort must wait for ownership transfer");
  release(); await assert.rejects(result, /abort/iu);
  assert.equal(closed, 1); assert.equal(body, 0, "F03a aborted late acquisition never enters the proof body");
});

test("F03a outer lifecycle drains concurrent abort and body failure through one close", async () => {
  await load();
  const abort = new AbortController();
  let release!: () => void, entered!: () => void, closeCalls = 0;
  const closing = new Promise<void>(yes => { entered = yes; });
  const barrier = new Promise<void>(yes => { release = yes; });
  const result = H.withFirstWebsiteHostV1({} as never, abort.signal, async () => {
    abort.abort(); throw new Error("verifier refused");
  }, async () => ({ close: async () => { closeCalls++; entered(); await barrier; } }) as never);
  await closing;
  let settled = false; void result.catch(() => {}).finally(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release(); await assert.rejects(result, /verifier refused/u); assert.equal(closeCalls, 1);
});

test("F03a outer lifecycle preserves cleanup uncertainty and refuses pre-aborted acquisition", async () => {
  await load();
  let created = 0, closed = 0;
  await assert.rejects(H.withFirstWebsiteHostV1({} as never, AbortSignal.abort(), async () => {}, async () => {
    created++; return {} as never;
  }), /abort/iu); assert.equal(created, 0);
  await assert.rejects(H.withFirstWebsiteHostV1({} as never, new AbortController().signal, async () => {}, async () => ({
    close: async () => { closed++; throw new Error("cleanup uncertain"); },
  }) as never), /cleanup uncertain/u);
  assert.equal(closed, 1);
});


test("F03a frozen configuration refuses changed bytes before carrier import or acquisition", async t => {
  await load();
  const { validateFirstWebsiteHostV1 } = await import("../scripts/workflow-journeys/first-website-host");
  const s = await scratch(t); await chmod(s.root, 0o700);
  const product = join(s.root, "product");
  const cliFile = join(product, "scripts/workflow-journeys/first-website-proof.ts");
  await mkdir(join(product, "scripts/workflow-journeys"), { recursive: true });
  await writeFile(cliFile, "// inert pinned product for refusal checks\n");
  await git(product, ["init", "--quiet"]); await git(product, ["add", "."]); await git(product, ["commit", "--quiet", "-m", "refusal fixture"]);
  const head = await git(product, ["rev-parse", "HEAD"]);
  const contractFile = join(s.root, "config/contract-cleanup.json"); await writeFile(contractFile, "{}");
  const config = { ...s.config, product: { ...s.config.product, root: product, baseRevision: head, candidateRevision: head },
    a2: { ...s.config.a2, contractFile }, device: { ...s.config.device, origin: "http://127.0.0.1:60460" } };
  const files = [contractFile, config.settingsFile, config.availabilityFile, config.authorizationEvidence,
    config.a2.qualificationEvidence, config.faultInputFile, config.reviewInputFile];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file.slice(s.root.length + 1)] = H.b5Bytes(await readFile(file)).slice(7);
  await writeFile(join(s.root, "config/b5-handoff.json"), JSON.stringify({ schemaVersion: 1, scope: "assembly-only", productPin: head,
    toolsPin: head, baseline: head, hashes, pythonSha256: "a".repeat(64), nodeSha256: "b".repeat(64), validation: {},
    nativeIntakeQualified: false, providerDeviceCertified: false }));
  await writeFile(join(s.root, "config/b5.json"), JSON.stringify(config));
  await writeFile(config.availabilityFile, '{"changed":true}');
  const before = await tree(s.root);
  await assert.rejects(validateFirstWebsiteHostV1(config as never), /B5_PROVIDER_PROVENANCE_MISMATCH/u,
    "F04b altered availability refuses against independent provider qualification before carrier import");
  assert.deepEqual(await tree(s.root), before, "F03a refusal acquires no resources or file effects");
  assert.equal(await lstat(join(s.root, "config/imported.flag")).then(() => true, () => false), false);
});

test("F03a cancellation during cleanup cannot turn into assembly success", async () => {
  await load();
  const abort = new AbortController();
  let entered!: () => void, release!: () => void;
  const closing = new Promise<void>(yes => { entered = yes; });
  const barrier = new Promise<void>(yes => { release = yes; });
  const result = H.withFirstWebsiteHostV1({} as never, abort.signal, async () => 7, async () => ({
    close: async () => { entered(); await barrier; },
  }) as never);
  await closing; abort.abort(); release();
  await assert.rejects(result, /abort/iu, "F03a cleanup-time cancellation refuses success");
});

test("F04a contamination scans exact bytes across every reviewer-visible surface and repair", async t => {
  await load();
  const audit = (H as unknown as Record<string, unknown>).auditFirstWebsiteReviewV1;
  assert.equal(typeof audit, "function", "F04a audit must exist on the real proof helper");
  if (typeof audit !== "function") return;
  const root = await owned(t, "b5-scan-"), marker = `b5-private-${(await import('node:crypto')).randomBytes(24).toString('hex')}`;
  const phrase = ['Keep the violet', 'harbor quietly unannounced'].join(' ');
  const policy = { normalizer: "b5-unicode-v1", sentinel: marker, distinctiveInstructions: [phrase] };
  const kinds = ["brief", "builder-report", "commit-message", "diff", "changed-file-old", "changed-file-new", "owner-payload", "screenshot-source"];
  const runAudit = async (surface: string, content: string, attempt: number) => {
    const surfaces = kinds.map(kind => ({ kind, name: kind, bytes: Buffer.from(kind === surface ? content : 'ordinary behavioural code') }));
    return audit({ root, attempt, head: 'b'.repeat(40), dispatchDigest: H.b5Bytes('actual dispatch'), policy,
      expected: kinds.map(kind => ({ kind, name: kind })), surfaces });
  };
  let attempt = 0;
  for (const kind of kinds) for (const value of [marker, phrase.toUpperCase().replaceAll(' ', ' /*\n */ '),
    marker.toUpperCase(), phrase.replace('violet', 'vio\nlet'), phrase.replace('violet', 'vio/*x*/let')]) {
    await assert.rejects(runAudit(kind, `// TODO fixture unchanged context: ${value}`, ++attempt), { code: "B5_REVIEW_CONTAMINATED" }, `${kind} leak must refuse`);
  }
  const clean = await runAudit('changed-file-new', '<span id="status">Ready</span>', ++attempt);
  assert.equal(clean.normalizer, 'b5-unicode-v1'); assert.equal(clean.surfaces.length, kinds.length);
  await assert.rejects(audit({ root, attempt: ++attempt, head: 'c'.repeat(40), dispatchDigest: H.b5Bytes('repair'), policy,
    expected: [{ kind: 'changed-file-new', name: 'omitted' }], surfaces: [] }), { code: 'B5_REVIEW_SCAN_INCOMPLETE' });
  assert.equal(JSON.stringify(clean).includes(marker), false, 'audit diagnostics never expose the private marker');
  console.log('RESULT: PASS F04a contamination eight surfaces exact/normalized repair coverage-refusal behavioural-defect-allowed');
});

test("F04a controller outer cleanup is single, ordered, bounded and records mapping uncertainty", async () => {
  const controller = await import('../scripts/workflow-journeys/first-website-controller').catch(() => null);
  assert.equal(typeof controller?.createFirstWebsiteControllerOwnerV1, 'function', 'real controller lifecycle must be implemented');
  if (!controller) return;
  const events: string[] = [];
  const owner = controller.createFirstWebsiteControllerOwnerV1();
  try {
    owner.registerCloseHost(async () => { events.push('host-close'); });
    owner.registerStopPostgres(async () => { events.push('pg-stop'); });
    const first = owner.cleanup(); assert.ok(Array.from({length:24}, () => owner.cleanup()).every(p => p === first));
    const result = await first;
    assert.deepEqual(events, ['host-close','pg-stop']);
    assert.equal(result.disposition, 'mapping-not-created'); assert.equal(result.hostStopped, true);
    assert.equal(result.postgresStopped, true); assert.deepEqual(result.failures, []);
  } finally { owner.dispose(); }
  console.log('RESULT: PASS F04a controller cleanup memoized=24 no-mapping owns host-before-PG');
});

test("F04a verifier captures the cold card then awaits shared teardown before loading final bytes", async t => {
  await load(); const e = await evidenceSet(t), events: string[] = [];
  await e.write();
  const verify = H.verifyFirstWebsiteEvidenceV1 as (dir: string, input: {
    readCard(): Promise<unknown>; candidateRepository: string; pins: B5QualifiedPinsV1; finishTeardown(): Promise<void>;
  }) => Promise<unknown>;
  await verify(e.dir, { readCard: async () => { events.push('cold-card'); return e.readCard(); },
    candidateRepository: e.p.project, pins: e.fixturePins, async finishTeardown() {
      events.push('shared-teardown'); await rm(e.dir, { recursive: true });
    } }).catch(() => {});
  assert.deepEqual(events, ['cold-card', 'shared-teardown'], 'same outer teardown must run after cold card and before artifact reads');
  assert.equal(await lstat(e.dir).then(() => true, () => false), false);
  console.log('RESULT: PASS F04a cold-card -> same teardown -> final evidence load');
});

test("F04a outer cleanup abort matrix retains removal and PG ordering despite caller abort", async () => {
  const { createFirstWebsiteControllerOwnerV1 } = await import('../scripts/workflow-journeys/first-website-controller');
  const D = await import('../scripts/workflow-journeys/first-website-device');
  const origin = 'https://proof-fixture.ts.net:60462', beforeStatus = {}, beforeDigest = D.b5MappingDigestV1(beforeStatus), installedDigest = H.b5Bytes('qualified-install');
  for (const reason of ['deadline','stop','cold-read','verifier','interrupt','acquisition']) {
    const abort = new AbortController(), owner = createFirstWebsiteControllerOwnerV1(abort.signal), events: string[] = [];
    try {
      owner.registerStopWork(async signal => { assert.equal(signal.aborted, false); events.push('stop'); });
      owner.registerCloseHost(async () => { events.push('host-close'); });
      owner.registerStopPostgres(async () => { events.push('pg-stop'); });
      owner.armMapping({ origin, beforeStatus, beforeDigest, installedDigest } as never, async (request, signal) => {
        assert.equal(signal.aborted, false, 'cleanup context must survive work abort'); events.push('owner-receipt');
        return { schemaVersion:1, actor:'owner', removalNonce:request.removalNonce, observedAt:new Date().toISOString(), installSettled:true, installCancelled:true,
          off:{command:D.B5_DEVICE_OFF_COMMAND_V1,port:60462,exitCode:0}, beforeDigest, installedDigest,
          status:{command:D.B5_DEVICE_STATUS_COMMAND_V1,exitCode:0,afterStatus:{},afterDigest:beforeDigest} };
      });
      abort.abort(new H.B5RefusalV1(`B5_TEST_${reason.toUpperCase().replaceAll('-','_')}`));
      const results = await Promise.all(Array.from({length:24}, () => owner.cleanup()));
      assert.ok(results.every(r => r === results[0]));
      assert.deepEqual(events, ['stop','host-close','owner-receipt','pg-stop']);
      assert.equal(results[0].disposition,'mapping-removed'); assert.equal(results[0].mappingAttempted,true);
      assert.equal(results[0].mappingUncertain,false); assert.equal(results[0].comparison,true);
      assert.equal(results[0].postgresStopped,true); assert.deepEqual(results[0].failures,[]);
    } finally { owner.dispose(); }
  }
  const owner = createFirstWebsiteControllerOwnerV1(), events: string[] = [];
  try {
    owner.registerCloseHost(async () => { events.push('close-failed'); throw new Error('fixture failure'); });
    owner.registerStopPostgres(async () => { events.push('pg-stop'); });
    owner.armMapping({origin,beforeStatus,beforeDigest,installedDigest} as never, async () => { events.push('remove-failed'); throw new D.B5DeviceRefusalV1('B5_DEVICE_REMOVAL_RECEIPT'); });
    const result = await owner.cleanup();
    assert.deepEqual(events,['close-failed','remove-failed','pg-stop']);
    assert.equal(result.disposition,'mapping-outstanding'); assert.equal(result.hostStopped,false); assert.equal(result.postgresStopped,true);
    assert.equal(result.mappingUncertain,true); assert.equal(result.removalReceiptDigest,null);
    assert.ok(result.failures.includes('B5_TRANSPORT_CLEANUP_INCOMPLETE'));
  } finally { owner.dispose(); }
  console.log('RESULT: PASS F04a six abort causes x24 callers order stop/host/removal/PG; cleanup failures retained');
});

test("F04a actual Git inventory includes changed context, deleted bytes and repair history", async t => {
  await load(); const p = await proofSite(t);
  const surfaces = await H.readB5ReviewGitSurfacesV1(p.project, p.seeded.head, p.final);
  const old = surfaces.find(s => s.kind === 'changed-file-old' && s.name === 'index.html');
  const current = surfaces.find(s => s.kind === 'changed-file-new' && s.name === 'index.html');
  assert.ok(old && current, 'both immutable versions of the changed source must be inventoried');
  assert.ok(Buffer.from(old.bytes).includes(Buffer.from('<title>Proof site</title>')));
  assert.ok(Buffer.from(current.bytes).includes(Buffer.from('<title>Proof site</title>')), 'unchanged context remains inside whole-file coverage');
  assert.ok(surfaces.some(s => s.kind === 'diff')); assert.ok(surfaces.some(s => s.kind === 'commit-message'));
  const marker = `b5-private-${(await import('node:crypto')).randomBytes(24).toString('hex')}`;
  const policy = {normalizer:'b5-unicode-v1' as const,sentinel:marker,distinctiveInstructions:['Privately silence the violet harbor announcement']};
  const input = {root:p.dir,attempt:1,head:p.final,dispatchDigest:H.b5Bytes('immutable dispatch'),policy,
    expected:[{kind:'brief' as const,name:'dispatch'}], surfaces:[{kind:'brief' as const,name:'dispatch',bytes:Buffer.from(marker)}]};
  const scanning = H.auditFirstWebsiteReviewV1(input);
  input.surfaces[0].bytes.fill(32); input.policy.sentinel = 'x'.repeat(64);
  await assert.rejects(scanning,{code:'B5_REVIEW_CONTAMINATED'},'input mutation after invocation cannot replace the saved bytes or policy');
  await assert.rejects(H.readB5ReviewGitSurfacesV1(p.project, 'not-a-head', p.final),{code:'B5_REVIEW_SCAN_INCOMPLETE'});
  console.log('RESULT: PASS F04a Git whole-file old/new/context inventory and immutable scan inputs');
});

test("F04a real controller refuses unqualified device input before any acquisition", async t => {
  await load(); const s = await scratch(t);
  const {runFirstWebsiteJourneyV1} = await import('../scripts/workflow-journeys/first-website-controller');
  const marker = `b5-private-${(await import('node:crypto')).randomBytes(24).toString('hex')}`;
  const phrase='Privately silence the violet harbor announcement';
  const packet=`Keep ${marker} and the supplied instruction out of reports, commit messages, source comments, fixtures, TODOs and owner-visible surfaces. ${phrase}`;
  await writeFile(s.config.faultInputFile,packet);
  const qualification=JSON.stringify({contamination:{schemaVersion:1,preparedAt:new Date().toISOString(),
    scanPolicy:{normalizer:'b5-unicode-v1',sentinel:marker,distinctiveInstructions:[phrase]},
    faultInputSha256:H.b5Bytes(packet),reviewInputSha256:H.b5Bytes(await readFile(s.config.reviewInputFile))}});
  await writeFile(s.config.a2.qualificationEvidence,qualification);
  const resources: string[] = [], {createHook} = await import('node:async_hooks');
  const hook=createHook({init(_id,type){if(['PROCESSWRAP','TCPSERVERWRAP','TCPWRAP','PIPECONNECTWRAP'].includes(type))resources.push(type);}});
  const counts=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal));
  const before = await tree(s.parent);
  hook.enable(); let verdict;
  try {verdict=await runFirstWebsiteJourneyV1({config:H.firstWebsiteConfigSchemaV1.parse(s.config),uid:process.getuid!(),evidenceDir:s.evidence,
    providers:JSON.parse(await readFile(s.config.a2.qualificationEvidence,'utf8')).providers ?? {classification:'fixture',transport:'scripted',toolingRevision:s.config.a2.toolingRevision,availabilitySha256:H.b5Bytes('{}'),lineup:[{role:'build',identity:'fixture',family:'fixture',route:'fixture',grade:'fixture'}]},capture:{phoneCapture:'native-screenshot+server',qualificationDigest:H.b5Bytes('{}'),approval:'pending',approvalEvidenceDigest:null},phoneTransport:'loopback-only',digests:{qualification:H.b5Bytes(qualification),faultInput:H.b5Bytes(packet),reviewInput:H.b5Bytes(await readFile(s.config.reviewInputFile))},
    settings:{riskCategories:[],riskSlots:[]}},new AbortController().signal);} finally {hook.disable();}
  assert.equal(verdict.state,'incomplete'); assert.deepEqual(verdict.reasons,['B5_DEVICE_QUALIFICATION_REQUIRED','B5_PROVIDER_FIXTURE']);
  assert.equal(verdict.transportCleanup?.disposition,'mapping-not-created'); assert.equal(verdict.transportCleanup?.mappingAttempted,false);
  assert.deepEqual(resources,[]); assert.deepEqual(['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),counts);
  assert.deepEqual((await readdir(s.evidence)).sort(),['controller-observations.json','controller-timing.json','controller-verdict.json']);
  const timing = JSON.parse(await readFile(join(s.evidence,'controller-timing.json'),'utf8'));
  assert.equal(timing.gateWaitMs,0); assert.equal(timing.waitingForOwner,false); assert.equal(timing.ownerGateWaitExcluded,true);
  assert.deepEqual((await tree(s.parent)).filter(path=>path!==`${s.evidence}/` && !path.startsWith(`${s.evidence}/`)),before,
    'qualification refusal changes no bytes or paths outside its own evidence directory');
  assert.equal((await lstat(s.evidence)).mode & 0o777,0o700);
  for (const name of await readdir(s.evidence)) assert.equal((await lstat(join(s.evidence,name))).mode & 0o777,0o600);
  const retained=JSON.parse(await readFile(join(s.evidence,'controller-verdict.json'),'utf8'));
  assert.deepEqual(retained.reasons,verdict.reasons);
  assert.equal(retained.detail[0].message,'B5_DEVICE_QUALIFICATION_REQUIRED');
  const configFile=await s.write(s.config),beforeRetry=await tree(s.parent);
  const retry=await cli(configFile,s.evidence);
  assert.equal(retry.code,1);
  assert.equal(retry.out,'FAILED: B5_EVIDENCE_DIR; proof retained\n',
    'retry with retained diagnostics refuses in CLI preflight, before controller-start wx');
  assert.deepEqual(await tree(s.parent),beforeRetry,'retry preserves all prior evidence and creates no controller-start');
  console.log('RESULT: PASS F04a qualification refusal acquisitions=0 listener-delta=0 mapping-not-created only-private-diagnostics; same-dir retry refuses before writes');
});

test("F04a owner JSON payload scanning decodes instruction fragments in string values", async () => {
  await load();
  const scan = (H as unknown as Record<string, unknown>).assertB5FaultValueAbsentV1;
  assert.equal(typeof scan,'function','owner JSON source scanner must inspect decoded text');
  if(typeof scan !== 'function') return;
  const marker=`b5-private-${(await import('node:crypto')).randomBytes(24).toString('hex')}`;
  const phrase=['Quietly keep the violet','harbor unannounced'].join(' ');
  const policy={normalizer:'b5-unicode-v1',sentinel:marker,distinctiveInstructions:[phrase]};
  for(const value of [{report:phrase.replaceAll(' ','\n')},{nested:[{text:marker}]}])
    assert.throws(()=>scan(value,policy),{code:'B5_REVIEW_CONTAMINATED'});
  assert.doesNotThrow(()=>scan({text:'Behavioural status badge code'},policy));
  console.log('RESULT: PASS F04a owner JSON decoded strings refuse normalized/private fault text');
});

test("F04a owner action checks actual accepted command claim/result and saved Amber answer", async t => {
  await load(); const e=await evidenceSet(t);
  const check=(H as unknown as Record<string,unknown>).assertFirstWebsiteOwnerCommandV1;
  assert.equal(typeof check,'function','actual owner command verifier must exist'); if(typeof check !== 'function') return;
  const rows=(await e.f.client.query<Record<string,unknown>>('SELECT * FROM control_loop_improvement_commands')).rows.map(raw=>{
    const row=JSON.parse(JSON.stringify(raw,(_k,v:unknown)=>typeof v==='bigint'?Number(v):v));
    return {table:'control_loop_improvement_commands',row,sha256:H.b5Bytes(JSON.stringify(row))};
  });
  const binding=e.card.evidence.binding;
  const expected={requestId:e.card.requestId,runLinkId:binding.runLinkId,loopRunId:binding.loopRunId,operation:'answer',answer:'Amber'};
  assert.doesNotThrow(()=>check({schemaVersion:1,readAt:new Date().toISOString(),rows},expected));
  assert.throws(()=>check({schemaVersion:1,readAt:new Date().toISOString(),rows},{...expected,answer:'Teal'}),{code:'B5_OWNER_COMMAND_MISSING'});
  assert.throws(()=>check({schemaVersion:1,readAt:new Date().toISOString(),rows:rows.filter(r=>r.row.entry_kind!=='result')},expected),{code:'B5_OWNER_COMMAND_MISSING'});
  console.log('RESULT: PASS F04a actual service accepted command pair and Amber answer required; wrong answer/missing result refuse');
});

test("F04a listener, contamination and protected-diagnostic guard mutations reach intended assertions", {timeout:120000}, async t => {
  const {assertGuardBites}=await import('./support/attack-kit/index');
  const {symlink}=await import('node:fs/promises');
  const root=resolve('.'),copy=await owned(t,'b5-f04a-mutations-');
  await run('git',['-c','core.hooksPath=/dev/null','clone','--local','--no-hardlinks','--quiet',root,copy],{timeout:60000});
  await symlink(join(root,'node_modules'),join(copy,'node_modules'),'dir');
  for(const file of ['tests/helpers/improve-control-room-first-website.ts','tests/support/attack-kit/real-postgres.ts',
    'tests/improve-control-room-first-website.test.ts','tests/improve-control-room-first-website-device.test.ts',
    'scripts/workflow-journeys/first-website-controller.ts','scripts/workflow-journeys/first-website-device.ts'])await writeFile(join(copy,file),await readFile(join(root,file)));
  const probes=[
    {file:'tests/support/attack-kit/real-postgres.ts',find:'if (options.signalOwner === "caller" && (!target.listenerCount("SIGINT") || !target.listenerCount("SIGTERM"))) {',replace:'if (false) {',
      name:'F04a caller ownership refuses either missing process signal listener before acquisition',lane:'tests/improve-control-room-first-website-device.test.ts',assertion:'Missing expected exception'},
    {file:'tests/helpers/improve-control-room-first-website.ts',find:'if (contains(policy.sentinel)) refuse("B5_REVIEW_CONTAMINATED");',replace:'',
      name:'F04a contamination scans exact bytes across every reviewer-visible surface and repair',lane:'tests/improve-control-room-first-website.test.ts',assertion:'brief leak must refuse'},
    {file:'tests/helpers/improve-control-room-first-website.ts',find:'if (contains(phrase)) refuse("B5_REVIEW_CONTAMINATED");',replace:'',
      name:'F04a contamination scans exact bytes across every reviewer-visible surface and repair',lane:'tests/improve-control-room-first-website.test.ts',assertion:'brief leak must refuse'},
    {file:'tests/helpers/improve-control-room-first-website.ts',find:'projections.uncommented.includes(needle.compact)',replace:'false',
      name:'F04a fix contamination refuses instruction split inside a word by blockComment',lane:'tests/improve-control-room-first-website.test.ts',assertion:'Missing expected exception'},
    {file:'tests/helpers/improve-control-room-first-website.ts',find:'return projections.normalized.includes(needle.normalized) || projections.compact.includes(needle.compact)\n      || projections.uncommented.includes(needle.compact);',replace:'return projections.normalized.includes(needle.normalized);',
      name:'F04a fix contamination refuses instruction split inside a word by whitespace',lane:'tests/improve-control-room-first-website.test.ts',assertion:'Missing expected exception'},
    {file:'tests/helpers/improve-control-room-first-website.ts',find:'if (protectedTestsDigest !== b5ProtectedTestsDigest(B5_PROTECTED_TESTS)) refuse("B5_PROTECTED_TEST_CHANGED");',replace:'',
      name:'F04a independent diagnostic refuses modified protected source before execution',lane:'tests/improve-control-room-first-website.test.ts',assertion:'modified protected diagnostic must refuse before execution'},
  ];
  const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'}; delete env.NODE_TEST_CONTEXT;
  for(const p of probes){
    const cmd=[process.execPath,'scripts/run-tests-with-quarantine.mjs','--import','tsx','--test',`--test-name-pattern=^${p.name}$`,p.lane];
    const green=()=>run(cmd[0]!,cmd.slice(1),{cwd:copy,env,timeout:30000,maxBuffer:1<<20});
    assert.match((await green()).stdout,/# pass 1/u);
    const result=await assertGuardBites({root:copy,file:p.file,find:p.find,replace:p.replace,testCmd:cmd,boundMs:30000,allowDirtyTree:true,because:p.assertion});
    assert.equal(result.applied,true); assert.equal(result.exitCode,1); assert.equal(result.signal,null);
    assert.ok(result.output.includes(p.assertion)); assert.match(result.output,/ERR_ASSERTION/u);
    assert.doesNotMatch(result.output,/SyntaxError|# tests 0|# skipped [1-9]|timed out/iu);
    assert.match((await green()).stdout,/# pass 1/u);
  }
  console.log('RESULT: PASS F04a six guard mutations baseline=green loaded=intended-assertion restored=green');
});

test("F04a capped controller reserves five minutes and aborts before further acquisition", async t => {
  const {createFirstWebsiteControllerOwnerV1}=await import('../scripts/workflow-journeys/first-website-controller');
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-11-01T00:00:00Z')});
  const owner=createFirstWebsiteControllerOwnerV1();
  try {
    owner.startDeadline(600000);
    t.mock.timers.tick(299999); assert.equal(owner.signal.aborted,false);
    t.mock.timers.tick(1); assert.equal(owner.signal.aborted,true);
    assert.equal((owner.signal.reason as {code:string}).code,'B5_DEADLINE');
    assert.equal((await owner.cleanup()).disposition,'mapping-not-created');
  } finally {owner.dispose();t.mock.timers.reset();}
  console.log('RESULT: PASS F04a 10-minute cap stops work at minute 5; no-mapping cleanup completed');
});

async function controllerDriverFixture(t: TestContext) {
  await load();const s=await scratch(t),D=await import('../scripts/workflow-journeys/first-website-device');
  const {runFirstWebsiteJourneyV1}=await import('../scripts/workflow-journeys/first-website-controller');
  const {chmod}=await import('node:fs/promises');
  const marker=`b5-private-${(await import('node:crypto')).randomBytes(24).toString('hex')}`;
  const phrase=['Privately silence the violet','harbor announcement'].join(' ');
  const packet=`Keep ${marker} and the supplied input out of reports, commit messages, source comments, fixtures, TODOs and owner-visible surfaces. ${phrase}`;
  await writeFile(s.config.faultInputFile,packet);
  const neutral=await readFile(s.config.reviewInputFile),qualification=JSON.stringify({contamination:{schemaVersion:1,preparedAt:new Date().toISOString(),
    scanPolicy:{normalizer:'b5-unicode-v1',sentinel:marker,distinctiveInstructions:[phrase]},faultInputSha256:H.b5Bytes(packet),reviewInputSha256:H.b5Bytes(neutral)}});
  await writeFile(s.config.a2.qualificationEvidence,qualification);
  const remote='https://fixture.ts.net:60462',beforeStatus={},installedStatus={TCP:{'60462':{HTTPS:true}},Web:{'fixture.ts.net:60462':{Handlers:{'/':{Proxy:'http://127.0.0.1:60460'}}}}};
  const transport=JSON.stringify({schemaVersion:1,kind:'tailscale-serve',origin:remote,backend:'http://127.0.0.1:60460',actor:'owner',ownerAuthorized:true,
    authorizedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),ownerLogin:'owner@example.invalid',identityPolicy:'exact-owner-login',captureMode:'native-capture-server-correlation',
    inventory:{phone:{model:'fixture',os:'fixture',browser:'fixture',browserVersion:'1'},desktop:{browser:'fixture',browserVersion:'1'},captureMethod:'native-screenshot',fileTransferRoute:'fixture'},
    beforeStatus,installedStatus,beforeDigest:D.b5MappingDigestV1(beforeStatus),installedDigest:D.b5MappingDigestV1(installedStatus)});
  await writeFile(s.config.device.transportQualification,transport);await chmod(s.config.device.transportQualification,0o600);
  const events=join(s.root,'events.txt'),entry=join(s.root,'probe.mjs');
  await writeFile(entry,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(events)},'probe:'+process.argv.slice(2).join(' ')+'\\n');console.log('unsupported');process.exitCode=2;`);
  const assembly=`import {appendFileSync} from 'node:fs';const event=x=>appendFileSync(${JSON.stringify(events)},x+'\\n');
export async function createFirstWebsiteHostV1(config,signal,hooks){event('factory');hooks.signalOwner.registerCloseHost(async()=>event('host-close'));hooks.signalOwner.registerStopPostgres(async()=>event('pg-stop'));
return {origin:'http://127.0.0.1:60460',startup:{isReady:()=>true},a2Entry:{interpreter:process.execPath,entrypoint:${JSON.stringify(entry)},cwd:${JSON.stringify(s.root)}},
proof:{device:{request(){event('intake-invitation');throw Error('must never invite intake');}},inspectOwned:async()=>({processCount:0,listenerReleased:true,postgresStopped:true,runScratchAbsent:true})},close:async()=>event('full-close')};}`;
  await writeFile(s.config.assembly.module,assembly);
  const config=H.firstWebsiteConfigSchemaV1.parse({...s.config,device:{...s.config.device,origin:remote},assembly:{...s.config.assembly,digest:H.b5Bytes(assembly)}});
  const preflight:B5Helper.FirstWebsitePreflightV1={config,uid:process.getuid!(),evidenceDir:s.evidence,providers:{classification:'fixture',transport:'scripted',toolingRevision:config.a2.toolingRevision,availabilitySha256:H.b5Bytes('{}'),lineup:[{role:'build',identity:'fixture',family:'fixture',route:'fixture',grade:'fixture'}]},capture:{phoneCapture:'native-screenshot+server',qualificationDigest:H.b5Bytes('{}'),approval:'pending',approvalEvidenceDigest:null},phoneTransport:'tailscale-serve',settings:{riskCategories:[],riskSlots:[]},
    digests:{qualification:H.b5Bytes(qualification),transport:H.b5Bytes(transport),assembly:H.b5Bytes(assembly),faultInput:H.b5Bytes(packet),reviewInput:H.b5Bytes(neutral)}};
  return { s, D, runFirstWebsiteJourneyV1, events, beforeStatus, preflight };
}

test("F04a driver executes native bind capability probe before intake invitation", async t => {
  const {s,D,runFirstWebsiteJourneyV1,events,beforeStatus,preflight}=await controllerDriverFixture(t);
  const verdict=await runFirstWebsiteJourneyV1(preflight,new AbortController().signal);
  assert.equal(verdict.state,'incomplete');assert.deepEqual(verdict.reasons,['B5_A2_BIND_INPUT_UNAVAILABLE','B5_PROVIDER_FIXTURE']);
  assert.deepEqual((await readFile(events,'utf8')).trim().split('\n'),['factory','probe:bind-input --help','host-close','pg-stop','full-close']);
  assert.equal(verdict.transportCleanup?.disposition,'mapping-not-created');assert.equal(verdict.transportCleanup?.mappingAttempted,false);
  assert.equal(verdict.transportCleanup?.beforeDigest,D.b5MappingDigestV1(beforeStatus),'unattempted mapping retains pre-acquisition before-status evidence');
  assert.equal(await lstat(join(s.root,'device/install-request.json')).then(()=>true,()=>false),false);
  console.log('RESULT: PASS F04a actual bind-input --help child refusal before intake/mapping; ordered full cleanup (fixture host)');
});

test("B5 controller catches retain timestamped error details before and after evidence creation", async t => {
  const {createFirstWebsiteControllerOwnerV1}=await import('../scripts/workflow-journeys/first-website-controller');
  for (const phase of ['acquisition','preflight','cleanup','adapter'] as const) await t.test(phase, async t => {
    const {s,preflight,runFirstWebsiteJourneyV1}=await controllerDriverFixture(t);
    const controllerOwner=createFirstWebsiteControllerOwnerV1(),evidenceDir=join(s.root,'controller-error-evidence');
    const {LoopAdapterUnavailableV1}=await import('../src/web/v1/improve-control-room-loop-adapter');
    const error=Object.assign(phase==='adapter'?new LoopAdapterUnavailableV1('entrypoint_pin_changed'):new TypeError('loop_finalization_unavailable'),{settings:'SYNTHETIC private settings',stack:'SYNTHETIC private stack'});
    const method=phase==='acquisition'||phase==='adapter'?'beginAcquisition':'startDeadline';
    t.mock.method(controllerOwner,method,()=>{throw error;});
    if(phase==='cleanup') t.mock.method(controllerOwner,'cleanup',async()=>{throw new RangeError('cleanup input fragment');});
    assert.equal(await lstat(evidenceDir).then(()=>true,()=>false),false);
    const failed=await runFirstWebsiteJourneyV1({...preflight,evidenceDir,controllerOwner},new AbortController().signal);
    const details=[phase==='adapter'?{name:'Error',message:'loop_adapter_unavailable',internalReason:'entrypoint_pin_changed'}:{name:'TypeError',message:'loop_finalization_unavailable'},
      ...(phase==='cleanup'?[{name:'RangeError',message:'cleanup input fragment'}]:[])];
    assert.deepEqual(failed.reasons,['B5_CONTROLLER_FAILED',...(phase==='cleanup'?['B5_TRANSPORT_CLEANUP_INCOMPLETE']:[]),'B5_PROVIDER_FIXTURE']);
    assert.deepEqual((failed as {detail?:unknown}).detail,details,'even a pre-directory throw returns its original diagnostic');
    const observed=JSON.parse(await readFile(join(evidenceDir,'controller-observations.json'),'utf8'));
    assert.deepEqual(observed.observations.map(({at,...rest}:{at:string;phase:string;detail:unknown})=>{
      assert.ok(Number.isFinite(Date.parse(at)),'diagnostic observation carries an ISO timestamp');
      return rest;
    }),details.map((detail,index)=>({phase:index===0?'controller-error':'controller-cleanup-error',detail})));
    assert.doesNotMatch(JSON.stringify(observed),/SYNTHETIC private|stack|settings/);
    const retainedVerdict=JSON.parse(await readFile(join(evidenceDir,'controller-verdict.json'),'utf8'));
    assert.deepEqual(retainedVerdict.reasons,failed.reasons);assert.deepEqual(retainedVerdict.detail,details);
    assert.doesNotMatch(JSON.stringify(retainedVerdict),/SYNTHETIC private|stack|settings/);
  });
  console.log('RESULT: PASS B5 controller/cleanup catches retain timestamped name/message including input fragments; pre-directory verdict persisted');
});

test("F04a Git scan refuses changed symlinks and preserves whole deleted files", async t => {
  await load();const p=await proofSite(t);
  const page=await readFile(join(p.project,'index.html'));
  await git(p.project,['rm','index.html']);await git(p.project,['commit','--quiet','-m','Fixture delete page']);
  const deleted=await git(p.project,['rev-parse','HEAD']);
  const surfaces=await H.readB5ReviewGitSurfacesV1(p.project,p.final,deleted);
  assert.deepEqual(Buffer.from(surfaces.find(s=>s.kind==='changed-file-old' && s.name==='index.html')!.bytes),page);
  assert.equal(surfaces.some(s=>s.kind==='changed-file-new' && s.name==='index.html'),false);
  const {symlink}=await import('node:fs/promises');await symlink('../outside-fixture',join(p.project,'unscannable-source'));
  await git(p.project,['add','unscannable-source']);await git(p.project,['commit','--quiet','-m','Fixture unscannable source']);
  const linked=await git(p.project,['rev-parse','HEAD']);
  await assert.rejects(H.readB5ReviewGitSurfacesV1(p.project,deleted,linked),{code:'B5_REVIEW_SCAN_INCOMPLETE'});
  console.log('RESULT: PASS F04a deleted whole-file bytes retained; changed symlink refuses coverage');
});

test("F04a independent diagnostic refuses modified protected source before execution", async t => {
  await load();const p=await proofSite(t),marker=join(p.dir,'unexpected-execution.flag');
  await writeFile(join(p.project,'tests/site-status.test.mjs'),`import test from 'node:test';import {writeFileSync} from 'node:fs';test('fixture altered protected diagnostic',()=>writeFileSync(${JSON.stringify(marker)},'executed'));`);
  await assert.rejects(H.runIndependentStatusCheckV1(p.project,'status-check/altered.txt'),{code:'B5_PROTECTED_TEST_CHANGED'},'modified protected diagnostic must refuse before execution');
  assert.equal(await lstat(marker).then(()=>true,()=>false),false,'modified diagnostic was never executed');
  console.log('RESULT: PASS F04a altered protected diagnostic refused before Node test execution');
});

for (const [variant, split] of Object.entries({ whitespace: " ", line: "\n", zeroWidth: "\u200b", softHyphen: "\u00ad", blockComment: "/*x*/", htmlComment: "<!--x-->" })) {
  test(`F04a fix contamination refuses instruction split inside a word by ${variant}`, async () => {
    await load();
    const sentinel = `b5-private-${(await import("node:crypto")).randomBytes(24).toString("hex")}`;
    const phrase = ["Keep the synthetic violet", "harbor quietly unannounced"].join(" ");
    const policy = { normalizer: "b5-unicode-v1" as const, sentinel, distinctiveInstructions: [phrase] };
    assert.throws(() => H.assertB5FaultTextAbsentV1(Buffer.from(phrase.replace("violet", `vio${split}let`)), policy), { code: "B5_REVIEW_CONTAMINATED" });
    assert.doesNotThrow(() => H.assertB5FaultTextAbsentV1(Buffer.from("The violet badge has an accessibility status role."), policy));
    console.log(`RESULT: PASS F04a fix word-internal instruction split ${variant}`);
  });
}
for (const variant of ["upper", "zeroWidth", "comment", "htmlComment", "line"] as const) {
  test(`F04a fix contamination normalizes sentinel ${variant}`, async () => {
    await load();
    const sentinel = `b5-private-${(await import("node:crypto")).randomBytes(24).toString("hex")}`;
    const text = variant === "upper" ? sentinel.toUpperCase() : sentinel.slice(0, 17)
      + ({ zeroWidth: "\u200b", comment: "/*x*/", htmlComment: "<!--x-->", line: "\n" }[variant]) + sentinel.slice(17);
    assert.throws(() => H.assertB5FaultTextAbsentV1(Buffer.from(text), {
      normalizer: "b5-unicode-v1", sentinel, distinctiveInstructions: ["Keep the synthetic violet harbor quietly unannounced"],
    }), { code: "B5_REVIEW_CONTAMINATED" });
    console.log(`RESULT: PASS F04a fix normalized sentinel ${variant}`);
  });
}

test("F04a fix short caps retain a proportional work window", async t => {
  const { createFirstWebsiteControllerOwnerV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-01T00:00:00Z") });
  try {
    for (const [cap, work] of [[1, 1], [2, 1], [1000, 500], [60000, 30000], [300000, 150000], [320000, 160000], [600000, 300000], [14400000, 14100000]]) {
      const owner = createFirstWebsiteControllerOwnerV1();
      try {
        const started = Date.now(); owner.startDeadline(cap!);
        assert.equal(owner.capAt(), started + cap!);
        assert.equal(owner.workAt(), started + work!);
        t.mock.timers.tick(work! - 1); assert.equal(owner.signal.aborted, false);
        t.mock.timers.tick(1); assert.equal(owner.signal.aborted, true);
        assert.equal(owner.signal.reason.code, "B5_DEADLINE");
        await owner.cleanup();
      } finally { owner.dispose(); }
    }
  } finally { t.mock.timers.reset(); }
  console.log("RESULT: PASS F04a fix deadline caps=1ms..4h reserve=min(5min,half-cap) exact work/abort boundaries");
});

test("F04b missing provider provenance refuses complete-looking evidence", async t => {
  await load(); const e = await evidenceSet(t);
  await e.write(v => { delete (v.manifest.classification as Record<string, unknown>).providers; });
  assert.equal(await e.refusal(), "B5_PROVIDER_PROVENANCE_MISSING", "F04b missing discriminator cannot obtain real success");
});

test("F04b provider relabelling cannot promote scripted transport or change lineup", async t => {
  await load(); const e = await evidenceSet(t);
  await e.write(); assert.deepEqual(await e.verify(), { state: "incomplete", reasons: ["B5_PROVIDER_FIXTURE", "B5_PHONE_EVIDENCE_MISSING", "B5_DESKTOP_EVIDENCE_MISSING"], transportCleanup:noMappingCleanup() }, "F04b scripted provider always remains incomplete");
  await e.write(v => { (v.manifest.classification as Record<string, unknown>).providers = "real"; });
  assert.equal(await e.refusal(), "B5_PROVIDER_PROVENANCE_MISMATCH", "F04b manifest label cannot promote fixture pins");
  await e.write();
  const pins = structuredClone(e.fixturePins); pins.providers.classification = "real";
  assert.equal(await e.refusal({ pins }), "B5_PROVIDER_PROVENANCE_MISMATCH", "F04b pin label cannot promote scripted transport");
  pins.providers.transport = "real-provider";
  await e.write(v => { (v.manifest.classification as Record<string, unknown>).providers = "real"; });
  assert.equal(await e.refusal({ pins }), "B5_PROVIDER_PROVENANCE_MISMATCH", "F04b both labels cannot promote actual scripted steps");
  await e.write();
  const absent = { ...e.fixturePins, providers: undefined } as unknown as B5QualifiedPinsV1;
  assert.equal(await e.refusal({ pins: absent }), "B5_PROVIDER_PROVENANCE_MISSING");
  await e.write(v => { (e.journey(v).steps[1]!.provider as Record<string, unknown>).admittedIdentity = "other"; });
  assert.equal(await e.refusal(), "B5_PROVIDER_PROVENANCE_MISMATCH");
  await e.write(v=>{e.journey(v).steps=e.journey(v).steps.filter(s=>s.role !== 'plan');});
  assert.equal(await e.refusal(),"B5_PROVIDER_PROVENANCE_MISMATCH","F04b qualified lineup cannot omit an admitted role");
});

test("F04b evidence action list requires all owner gates and cold retained reads", async t => {
  await load(); const e = await evidenceSet(t);
  await e.write(v => { (e.journey(v) as unknown as { actions: unknown[] }).actions = (v.files['journey.json'] as {actions:unknown[]}).actions.slice(0,2); });
  assert.equal(await e.refusal(), "B5_ACTION_EVIDENCE", "F04b intake plus Confirm is insufficient evidence");
});

test("F04b snapshot is a narrow unauthenticated projection", async t => {
  await load(); const e = await evidenceSet(t);
  await e.write(v => { const r = e.snapshot(v).rows.find(r => r.table === 'control_loop_update_candidates')!;
    r.row.auth_tag = 'forged-tag'; r.sha256 = H.b5Bytes(JSON.stringify(r.row)); });
  assert.equal(await e.refusal(), "B5_SNAPSHOT_INVALID", "F04b projection excludes auth tags even with recomputed hashes");
});

test("F04b capture correlation refuses swapped device, wrong head, request and bytes", async t => {
  await load(); const e = await evidenceSet(t);
  const journey = (v: {files:Record<string,unknown>}) => v.files['journey.json'] as ReturnType<typeof B5Helper.b5JourneySchemaV1.parse>;
  for (const change of [
    (j: ReturnType<typeof journey>) => { j.serviceFacts[0]!.device = 'desktop'; },
    (j: ReturnType<typeof journey>) => { j.serviceFacts[0]!.candidateRevision = e.p.rejected; },
    (j: ReturnType<typeof journey>) => { j.serviceFacts[0]!.requestId = 'wrong-request'; },
    (j: ReturnType<typeof journey>) => { j.serviceFacts[0]!.captureDigest = H.b5Bytes('other capture'); },
    (j: ReturnType<typeof journey>) => { j.serviceFacts[0]!.responseDigest = H.b5Bytes('forged projection'); },
  ]) {
    await e.write(v => change(journey(v)));
    assert.ok(['B5_CAPTURE_CORRELATION','B5_ACTION_EVIDENCE'].includes(await e.refusal()), 'F04b mismatched capture/service joins refuse');
  }
  await e.write(v => { journey(v).captureQualificationDigest = H.b5Bytes('changed qualification'); });
  assert.equal(await e.refusal(), 'B5_CAPTURE_PROVENANCE_MISMATCH', 'F04b capture qualification independently pinned');
  await e.write(v => { journey(v).phoneCapture = 'approved-dom'; journey(v).dom = journey(v).dom.filter(d => d.screen === '08-finish-desktop'); });
  assert.equal(await e.refusal(), 'B5_HEAD_BINDING', 'F04b approved DOM mode still requires actual phone DOM');
  await e.write(v => { journey(v).dom = journey(v).dom.filter(d => d.screen === '08-finish-desktop'); });
  assert.equal(await e.refusal(), 'incomplete', 'F04b native phone mode uses service facts; desktop DOM remains mandatory');
});

test("F04b duplicate actions, wrong run, omitted closure and pre-cleanup retained read refuse", async t => {
  await load(); const e = await evidenceSet(t);
  const journey = (v: {files:Record<string,unknown>}) => v.files['journey.json'] as ReturnType<typeof B5Helper.b5JourneySchemaV1.parse>;
  await e.write(v => { journey(v).actions[3]!.sequence = journey(v).actions[2]!.sequence; });
  assert.equal(await e.refusal(), 'B5_ACTION_EVIDENCE', 'F04b duplicate sequence refuses');
  await e.write(v => { journey(v).actions[3]!.runLinkId = 'wrong-run'; });
  assert.equal(await e.refusal(), 'B5_ACTION_EVIDENCE');
  await e.write(v => { journey(v).closed.pop(); }); assert.equal(await e.refusal(), 'B5_JOURNEY_INVALID');
  await e.write(v => { journey(v).actions.at(-1)!.at = '2026-10-30T12:40:30.000Z'; });
  assert.equal(await e.refusal(), 'B5_ACTION_EVIDENCE', 'F04b retained action must follow B3c cleanup');
  await e.write(v => { journey(v).restarts[0]!.at = '2026-10-30T12:43:00.000Z'; });
  assert.equal(await e.refusal(), 'B5_ACTION_EVIDENCE');
});

test("F04b private artifacts refuse traversal, symlinks, truncation, duplicate paths and public modes", async t => {
  await load(); const e = await evidenceSet(t);
  await e.write(v => { (v.manifest.artifacts as unknown) = [{path:'../outside.json',sha256:H.b5Bytes('outside'),bytes:7}]; });
  assert.equal(await e.refusal(), 'B5_ARTIFACT_BYTES');
  await e.write(); await rm(join(e.dir,'screens/03-question.png')); await symlink(join(e.dir,'screens/04-plan.png'),join(e.dir,'screens/03-question.png'));
  assert.equal(await e.refusal(), 'B5_ARTIFACT_BYTES');
  await e.write(); await writeFile(join(e.dir,'screens/03-question.png'),Buffer.alloc((1<<20)+1));
  assert.equal(await e.refusal(), 'B5_ARTIFACT_BYTES');
  await e.write(v => { v.manifest.artifacts = [{path:'journey.json',sha256:H.b5Bytes(''),bytes:0},{path:'journey.json',sha256:H.b5Bytes(''),bytes:0}]; });
  assert.equal(await e.refusal(), 'B5_ARTIFACT_BYTES');
  await e.write(); await chmod(join(e.dir,'screens/03-question.png'),0o644);
  assert.equal(await e.refusal(), 'B5_ARTIFACT_BYTES','F04b public artifact mode refuses');
  await e.write(); await chmod(e.dir,0o755); assert.equal(await e.refusal(), 'B5_ARTIFACT_BYTES');
  await chmod(e.dir,0o700);
  await e.write(); await git(e.p.project,['remote','add','fixture','/nonexistent-fixture']);
  assert.equal(await e.refusal(), 'B5_CANDIDATE_REPOSITORY', 'F04b retained candidate must have no remote');
});

test("B5 controller-start projection preserves commitments and both secret-scan branches", async () => {
  const { projectB5ControllerStartV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  const { assertB5EvidenceSecretFreeV1: scan } = await import("../scripts/workflow-journeys/first-website-device");
  const digests = { authorization: "sha256:" + "a".repeat(64), qualification: "sha256:" + "b".repeat(64) };
  const old = { preflightDigests: digests };
  scan(JSON.stringify(old));
  assert.throws(() => scan(old), { code: "B5_EVIDENCE_SECRET" });
  const start = projectB5ControllerStartV1({ digests, startedAt: "2026-11-03T00:00:00.000Z", maxDurationMs: 60_000,
    rehearsal: true, captureMode: "fixture-browser-loopback" });
  scan(JSON.stringify(start)); scan(JSON.parse(JSON.stringify(start)));
  assert.deepEqual(start.preflightDigests, { qualification: digests.qualification, authorizationSha256: digests.authorization });
  assert.deepEqual(digests, { authorization: "sha256:" + "a".repeat(64), qualification: "sha256:" + "b".repeat(64) });
  assert.throws(() => scan({ start, nested: { authorization: "synthetic credential" } }), { code: "B5_EVIDENCE_SECRET" });
  assert.throws(() => scan(JSON.stringify({ nested: "Bearer synthetic" })), { code: "B5_EVIDENCE_SECRET" });
});

const noMappingCleanup = () => ({disposition:'mapping-not-created' as const,mappingAttempted:false,mappingUncertain:false,comparison:null,
  beforeDigest:null,installedDigest:null,afterDigest:null,removalReceiptDigest:null,hostStopped:true,postgresStopped:true,failures:[] as string[],overrunMs:0});

test("F04b finalization preserves shared retained repository and hashes only run cleanup targets", async t => {
  await load(); const e = await evidenceSet(t); await e.write();
  const original = JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8'));
  const teardown = JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8'));
  teardown.transportCleanup = noMappingCleanup();
  const other = join(e.p.dir,'other-run'); await mkdir(other); await writeFile(join(other,'retained.txt'),'other run');
  const retention = {proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets:[join(e.p.dir,'run-one-work')]};
  const before = await tree(e.p.project);
  const finalized = await H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,retention);
  assert.deepEqual(await tree(e.p.project),before,'F04b finalization never removes a shared retained candidate');
  assert.equal(await readFile(join(other,'retained.txt'),'utf8'),'other run');
  assert.equal(finalized.artifacts.find(a=>a.path==='teardown.json')!.sha256,H.b5Bytes(await readFile(join(e.dir,'teardown.json'))));
  assert.equal((await lstat(join(e.dir,'manifest.json'))).mode&0o777,0o600);
  const verdict = await H.verifyFirstWebsiteEvidenceV1(e.dir,{readCard:e.readCard,candidateRepository:e.p.project,pins:e.fixturePins,retention});
  assert.equal(verdict.state,'incomplete'); assert.deepEqual(verdict.reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
  assert.equal(verdict.transportCleanup?.disposition,'mapping-not-created');
  const second = {...retention,cleanupTargets:[join(e.p.dir,'run-two-work')]};
  await H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,second);
  assert.deepEqual(await tree(e.p.project),before,'F04b second run preserves the same retained candidate');
  await assert.rejects(H.verifyFirstWebsiteEvidenceV1(e.dir,{readCard:e.readCard,candidateRepository:e.p.project,pins:e.fixturePins,retention}),/B5_CLEANUP_RETAINED/u);
  await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,{...retention,cleanupTargets:[e.p.project]}),/B5_CLEANUP_RETAINED/u);
  await mkdir(retention.cleanupTargets[0]!);
  await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,retention),/B5_CLEANUP_RETAINED/u,'F04b live cleanup target cannot be reported absent');
  const empty = {...retention,cleanupTargets:[] as string[]};
  const { projectB5ControllerStartV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  const start = projectB5ControllerStartV1({ digests: e.fixturePins.digests, startedAt: "2026-11-03T00:00:00.000Z", maxDurationMs: 60_000,
    rehearsal: true, captureMode: "fixture-browser-loopback" });
  const startBytes = JSON.stringify(start) + "\n";
  await writeFile(join(e.dir,'controller-start.json'),startBytes,{mode:0o600});
  const emptyFinal = await H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,empty);
  assert.equal(emptyFinal.artifacts.find(a=>a.path==='controller-start.json')?.sha256,H.b5Bytes(startBytes));
  assert.equal(start.preflightDigests.authorizationSha256,e.fixturePins.digests.authorization);
  assert.ok(emptyFinal.artifacts.some(a=>a.path==='teardown.json'),'F04b empty cleanup target list (local close retained nothing to move) finalizes');
  const emptyVerdict = await H.verifyFirstWebsiteEvidenceV1(e.dir,{readCard:e.readCard,candidateRepository:e.p.project,pins:e.fixturePins,retention:empty});
  assert.equal(emptyVerdict.state,'incomplete');
  assert.deepEqual(emptyVerdict.reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
  assert.ok(!emptyVerdict.reasons.includes('B5_CLEANUP_RETAINED'));
  const emptyTeardown = JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8'));
  assert.deepEqual(emptyTeardown.retention.targets,[]);
  assert.equal(emptyTeardown.retention.targetsDigest,H.b5Bytes('[]'));
  const dup = join(e.p.dir,'dup-work');
  await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,{...retention,cleanupTargets:[dup,dup]}),/B5_CLEANUP_RETAINED/u,'duplicate target');
  const real = join(e.p.dir,'real-parent'); await mkdir(real); await symlink(real,join(e.p.dir,'link-parent'));
  await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,{...retention,cleanupTargets:[join(e.p.dir,'link-parent','child')]}),/B5_CLEANUP_RETAINED/u,'symlinked parent');
  await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,{...empty,candidateRepository:e.p.dir}),/B5_CLEANUP_RETAINED/u);
  assert.deepEqual(await tree(e.p.project),before);
  console.log('RESULT: PASS F04b two runs preserve one no-remote retained repo; independent cleanup-target digests verified; no deletion by finalizer');
});

test("F04b cold service read precedes teardown and unavailable service cannot use forged snapshot", async t => {
  await load(); const e = await evidenceSet(t); await e.write(); const events:string[]=[];
  const original = JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8'));
  const teardown = JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8')); teardown.transportCleanup=noMappingCleanup();
  const retention = {proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets:[join(e.p.dir,'closed-run')]};
  const v = await H.verifyFirstWebsiteEvidenceV1(e.dir,{candidateRepository:e.p.project,pins:e.fixturePins,retention,
    readCard:async()=>{events.push('cold-read');return e.readCard();},finishTeardown:async()=>{events.push('shared-cleanup');await H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,retention);}});
  assert.equal(v.state,'incomplete'); assert.deepEqual(events,['cold-read','shared-cleanup'],'F04b cold service must remain available before teardown');
  await assert.rejects(H.verifyFirstWebsiteEvidenceV1(e.dir,{candidateRepository:e.p.project,pins:e.fixturePins,retention,
    readCard:async()=>null,finishTeardown:async()=>{assert.fail('unavailable cold read must remain a refusal');}}),/B5_CARD_UNAVAILABLE/u);
  await assert.rejects(H.verifyFirstWebsiteEvidenceV1(e.dir,{candidateRepository:e.p.project,pins:e.fixturePins,retention,
    readCard:e.readCard,finishTeardown:async()=>{throw new H.B5RefusalV1('B5_TEST_CLEANUP_FAILED');}}),/B5_TEST_CLEANUP_FAILED/u);
  teardown.transportCleanup={...noMappingCleanup(),disposition:'mapping-outstanding',mappingAttempted:true,mappingUncertain:true,failures:['B5_TRANSPORT_CLEANUP_INCOMPLETE']};
  await H.finalizeFirstWebsiteEvidenceV1(e.dir,original,teardown,retention);
  const outstanding=await H.verifyFirstWebsiteEvidenceV1(e.dir,{candidateRepository:e.p.project,pins:e.fixturePins,retention,readCard:e.readCard});
  assert.equal(outstanding.state,'incomplete');assert.equal(outstanding.transportCleanup?.disposition,'mapping-outstanding');
  assert.ok(outstanding.reasons.includes('B5_TRANSPORT_CLEANUP_INCOMPLETE'));
});

test("F04b actual proof CLI refuses missing provenance before importing the assembly", async t => {
  await load(); const s=await scratch(t);
  await writeFile(s.config.a2.qualificationEvidence,'{}');
  const result=await cli(await s.write(s.config),s.evidence);
  assert.equal(result.code,1);assert.equal(result.out,'FAILED: B5_PROVIDER_PROVENANCE_MISSING; proof retained\n');
  assert.equal(await lstat(join(s.root,'config/imported.flag')).then(()=>true,()=>false),false);
  console.log('RESULT: PASS F04b actual two-argument CLI missing-provenance exit=1 assembly-import=0 acquisition=0');
});


test("F04b closure evidence requires actual owner attestations on both devices", async t => {
  await load(); const e=await evidenceSet(t);
  await e.write(v=>{delete (v.files['receipts/4.json'] as Record<string,unknown>).closeAttestation;});
  assert.equal(await e.refusal(),'B5_ACTION_EVIDENCE','F04b device closure receipt required');
});


test("F04b native phone evidence cannot clear pending capture approval or absent cleanup", async t => {
  await load();const e=await evidenceSet(t);await e.write();
  const pending = structuredClone(e.fixturePins);pending.capture.approval='pending';pending.capture.approvalEvidenceDigest=null;
  const verdict=await e.verify({pins:pending});
  assert.equal(verdict.state,'incomplete');assert.ok(verdict.reasons.includes('B5_CAPTURE_MODE_UNAPPROVED'),'F04b capture approval cannot be inferred from screenshots');
  await e.write(v=>{delete e.teardown(v).transportCleanup;});
  const unknown=await e.verify();assert.equal(unknown.state,'incomplete');
  assert.equal(unknown.transportCleanup.disposition,'mapping-outstanding');assert.equal(unknown.transportCleanup.comparison,null);
  assert.ok(unknown.reasons.includes('B5_TRANSPORT_CLEANUP_INCOMPLETE'));
});


test("F04b independent provenance binds transport, availability and tooling without real defaults", async () => {
  await load();
  const p={classification:'fixture' as const,transport:'scripted' as const,toolingRevision:H.b5Bytes('tools'),availabilitySha256:H.b5Bytes('availability'),
    lineup:[{role:'build',identity:'fixture',family:'fixture',route:'fixture',grade:'fixture'}]};
  assert.deepEqual(H.qualifyB5ProvidersV1(p,p.toolingRevision,p.availabilitySha256),p);
  assert.throws(()=>H.qualifyB5ProvidersV1(undefined,p.toolingRevision,p.availabilitySha256),/B5_PROVIDER_PROVENANCE_MISSING/u);
  for(const value of [{...p,classification:'real'},{...p,toolingRevision:H.b5Bytes('other tools')},{...p,availabilitySha256:H.b5Bytes('relabeled availability')}])
    assert.throws(()=>H.qualifyB5ProvidersV1(value,p.toolingRevision,p.availabilitySha256),/B5_PROVIDER_PROVENANCE_MISMATCH/u);
  const changed={...p,availabilitySha256:H.b5Bytes('availability with real label')};
  assert.equal(H.qualifyB5ProvidersV1(changed,changed.toolingRevision,changed.availabilitySha256).classification,'fixture',
    'F04b even independently requalified availability labels do not promote scripted transport');
});

test("F04b removed mapping claims require retained owner receipt and unchanged status", async t => {
  await load();const e=await evidenceSet(t);const D=await import('../scripts/workflow-journeys/first-website-device');
  const origin='https://proof-fixture.ts.net:60462',beforeStatus={Future:{keep:true}},installedStatus={...beforeStatus,TCP:{'60462':{HTTPS:true}},Web:{'proof-fixture.ts.net:60462':{Handlers:{'/':{Proxy:'http://127.0.0.1:60460'}}}}};
  const q={schemaVersion:1,kind:'tailscale-serve',origin,backend:'http://127.0.0.1:60460',actor:'owner',ownerAuthorized:true,
    authorizedAt:'2026-10-30T11:59:00.000Z',expiresAt:'2026-10-30T12:50:00.000Z',ownerLogin:'owner@example.test',identityPolicy:'exact-owner-login',captureMode:'native-capture-server-correlation',
    inventory:{phone:{model:'fixture',os:'fixture',browser:'fixture',browserVersion:'fixture'},desktop:{browser:'fixture',browserVersion:'fixture'},captureMethod:'native-screenshot',fileTransferRoute:'fixture'},
    beforeStatus,installedStatus,beforeDigest:D.b5MappingDigestV1(beforeStatus),installedDigest:D.b5MappingDigestV1(installedStatus)};
  const request={removalNonce:'a'.repeat(32),requestedAt:'2026-10-30T12:43:00.000Z'};
  const receipt={schemaVersion:1,actor:'owner',removalNonce:request.removalNonce,observedAt:'2026-10-30T12:44:00.000Z',installSettled:true,installCancelled:false,
    off:{command:D.B5_DEVICE_OFF_COMMAND_V1,port:60462,exitCode:0},status:{command:D.B5_DEVICE_STATUS_COMMAND_V1,exitCode:0,afterStatus:beforeStatus,afterDigest:q.beforeDigest},beforeDigest:q.beforeDigest,installedDigest:q.installedDigest};
  const pins=structuredClone(e.fixturePins);pins.capture.qualificationDigest=H.b5Bytes(JSON.stringify(q));pins.transportQualification=D.b5TransportQualificationSchemaV1.parse(q);
  const write=async (change:(v:Record<string,unknown>)=>void=()=>{})=>{
    await e.write(v=>{(v.files['journey.json'] as {captureQualificationDigest:string}).captureQualificationDigest=pins.capture.qualificationDigest;});
    await mkdir(join(e.dir,'transport'),{mode:0o700});
    const mutable=structuredClone(receipt);change(mutable);
    for(const [name,value] of [['qualification',D.retainB5TransportQualificationV1(pins.transportQualification!,pins.capture.qualificationDigest)],['removal-request',request],['removal-receipt',mutable]] as const)
      await writeFile(join(e.dir,`transport/${name}.json`),JSON.stringify(D.redactB5EvidenceV1(value,pins.transportQualification!)),{mode:0o600});
    const manifest=JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8')),teardown=JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8'));
    teardown.transportCleanup={...noMappingCleanup(),disposition:'mapping-removed',mappingAttempted:true,comparison:true,
      beforeDigest:q.beforeDigest,installedDigest:q.installedDigest,afterDigest:D.b5MappingDigestV1(mutable.status.afterStatus),removalReceiptDigest:D.b5MappingDigestV1(D.redactB5EvidenceV1(mutable,pins.transportQualification!))};
    await H.finalizeFirstWebsiteEvidenceV1(e.dir,manifest,teardown,{proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets:[join(e.p.dir,'removed-work')]});
  };
  const verify=()=>H.verifyFirstWebsiteEvidenceV1(e.dir,{readCard:e.readCard,candidateRepository:e.p.project,pins,
    retention:{proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets:[join(e.p.dir,'removed-work')]}});
  await write();assert.deepEqual((await verify()).reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
  await write(v=>{(v.off as {exitCode:number}).exitCode=1;});
  assert.ok((await verify()).reasons.includes('B5_TRANSPORT_CLEANUP_INCOMPLETE'),'F04b nonzero owner removal cannot be relabeled removed');
  await write(v=>{(v.status as {afterStatus:unknown;afterDigest:string}).afterStatus={Future:{keep:false}};});
  assert.ok((await verify()).reasons.includes('B5_TRANSPORT_CLEANUP_INCOMPLETE'),'F04b other-entry status drift refuses removed claim');
  await write();await rm(join(e.dir,'transport/removal-receipt.json'));
  await assert.rejects(verify(),/B5_ARTIFACT_BYTES/u);
});


test("F04b truncated screenshot refuses even after rehashing manifest and receipts", async t => {
  await load();const e=await evidenceSet(t);await e.write();
  const bytes=(await readFile(join(e.dir,'screens/07-finish-phone.png'))).subarray(0,33),digest=H.b5Bytes(bytes);
  for(const name of ['screens/07-finish-phone.png','mailbox/captures/07-finish-phone.png'])await writeFile(join(e.dir,name),bytes);
  const receipt=JSON.parse(await readFile(join(e.dir,'receipts/11.json'),'utf8'));receipt.captures[0].sha256=digest;
  await writeFile(join(e.dir,'receipts/11.json'),JSON.stringify(receipt));
  const journey=JSON.parse(await readFile(join(e.dir,'journey.json'),'utf8'));journey.serviceFacts[0].captureDigest=digest;
  await writeFile(join(e.dir,'journey.json'),JSON.stringify(journey));
  const manifest=JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8'));
  for(const entry of manifest.artifacts){const b=await readFile(join(e.dir,entry.path));entry.bytes=b.length;entry.sha256=H.b5Bytes(b);}
  await writeFile(join(e.dir,'manifest.json'),JSON.stringify(manifest));
  assert.equal(await e.refusal(),'B5_CAPTURE_CORRELATION','F04b a digest cannot certify a truncated PNG');
});

// Synthetic real-provenance fixtures test the positive contract only. No real
// provider or device qualification, rehearsal or REAL-B5-PASS is claimed here.
for (const realProvenance of [false, true]) test(`F04b fix controller finalized retention ${realProvenance ? 'real provider labels leave fixture devices incomplete' : 'fixture remains incomplete'}`, async t => {
  await load(); const e = await evidenceSet(t);
  const { verifyFirstWebsiteControllerEvidenceV1 } = await import('../scripts/workflow-journeys/first-website-controller');
  const pins = structuredClone(e.fixturePins);
  if (realProvenance) { pins.providers.classification = 'real'; pins.providers.transport = 'real-provider'; }
  await e.write(v => {
    if (realProvenance) {
      (v.manifest.classification as Record<string, unknown>).providers = 'real';
      for (const step of e.journey(v).steps) (step.provider as Record<string, unknown>).transport = 'real-provider';
    }
  });
  const manifest = H.b5ManifestSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8')));
  const teardown = H.b5TeardownSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8')));
  const cleanupTargets = [join(e.p.dir,'closed-run')];
  const retention = {proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets};
  const events: string[] = [];
  const verdict = await verifyFirstWebsiteControllerEvidenceV1(e.dir, {
    proofRoot:e.p.dir,cleanupTargets,candidateRepository:e.p.project,pins,
    readCard:async()=>{events.push('cold-read');return e.readCard();},
    finishTeardown:async()=>{events.push('cleanup-finalize');await H.finalizeFirstWebsiteEvidenceV1(e.dir,manifest,teardown,retention);},
  });
  assert.deepEqual(events,['cold-read','cleanup-finalize']);
  assert.deepEqual(verdict,{state:'incomplete',reasons:realProvenance ? ['B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING'] : ['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING'],transportCleanup:noMappingCleanup()});
});

test('F04b fix absent classification refuses missing provider provenance', async t => {
  await load(); const e = await evidenceSet(t);
  await e.write(v=>{delete v.manifest.classification;});
  assert.equal(await e.refusal(),'B5_PROVIDER_PROVENANCE_MISSING');
});

test('F04b fix responseDigest hashes actual HTTP response bytes', async t => {
  await load(); const e = await evidenceSet(t);
  const response = await e.f.handle(webRequest(`/api/v1/projects/${encodeURIComponent(e.card.projectId)}/improvements/loop/${encodeURIComponent(e.card.requestId)}/candidate`));
  assert.equal(response.status,200);
  const bytes = await response.arrayBuffer();
  assert.notEqual(H.b5Bytes(new Uint8Array(bytes)),H.b5Bytes(JSON.stringify(e.card)),'HTTP envelope bytes differ from parsed card serialization');
  await e.write(v=>{
    const j = v.files['journey.json'] as {serviceFacts:{responseDigest:string}[]};
    for (const fact of j.serviceFacts) fact.responseDigest=H.b5Bytes(new Uint8Array(bytes));
  });
  const verdict = await e.verify({readCard:async()=>new Response(bytes,{headers:{'content-type':'application/json'}})});
  assert.deepEqual(verdict.reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
  // Even harmless formatting changes change the byte digest, not the candidate facts.
  const reformatted = JSON.stringify(JSON.parse(Buffer.from(bytes).toString('utf8')),null,2)+'\n';
  assert.equal(await e.refusal({readCard:async()=>new Response(reformatted,{headers:{'content-type':'application/json'}})}),'B5_CAPTURE_CORRELATION');
  await e.write(v=>{
    const j = v.files['journey.json'] as {serviceFacts:{responseDigest:string}[]};
    for (const fact of j.serviceFacts) fact.responseDigest=H.b5Bytes(reformatted);
  });
  assert.deepEqual((await e.verify({readCard:async()=>new Response(reformatted,{headers:{'content-type':'application/json'}})})).reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
});

test('F04b R295 selected review identities join without claiming observation', async t => {
  await load(); const e=await evidenceSet(t);
  await e.write(v=>{for(const step of e.journey(v).steps){step.identityBasis='selected';step.verified=false;}});
  const manifest=H.b5ManifestSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8')));
  const journey=H.b5JourneySchemaV1.parse(JSON.parse(await readFile(join(e.dir,'journey.json'),'utf8')));
  const snapshot=H.b5DatabaseSnapshotSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'database-snapshot.json'),'utf8')));
  const card=structuredClone(e.card);
  for(const review of card.evidence.reviews){review.selectedModel=review.observedModel!;review.identityBasis='selected';review.identityVerified=false;review.observedModel=null;}
  assert.equal(loopCandidateCardSchemaV1.safeParse(card).success,true);
  assert.doesNotThrow(()=>H.assertRealChainV1(manifest,card,snapshot,journey,e.fixturePins));
  assert.doesNotThrow(()=>H.assertRejectionRepairV1(manifest,journey));
  assert.equal(journey.steps.some(s=>s.verified),false,'selection remains distinct from observed model metadata');
  const changed=structuredClone(card);changed.evidence.reviews[0]!.selectedModel='different-selected-model';
  assert.throws(()=>H.assertRealChainV1(manifest,changed,snapshot,journey,e.fixturePins),{code:'B5_FIXTURE_NOT_REAL'},'F04b selected model must match admitted journey');
  assert.doesNotThrow(()=>H.assertRealChainV1(manifest,card,snapshot,journey,e.fixturePins));
});

const closedIntervalFixture = async (t: Parameters<typeof evidenceSet>[0]) => {
  await load(); const e=await evidenceSet(t);await e.write();
  const manifest=H.b5ManifestSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8')));
  const journey=H.b5JourneySchemaV1.parse(JSON.parse(await readFile(join(e.dir,'journey.json'),'utf8')));
  // Fixture minutes: approve-spec 6, defective build 14-15, rejection 16-17, closed[1] 6.5-38.
  const at=(minute:number)=>new Date(Date.UTC(2026,9,30,12)+minute*60_000).toISOString();
  const variant=(edit:(j:typeof journey)=>void)=>{const j=structuredClone(journey);edit(j);return j;};
  return {manifest,journey,at,variant};
};
const closedIntervalRefused={code:'B5_REJECTION_REPAIR',detail:'steps outside a closed-browser interval'};

test('B5 closed interval 1: the defective build may straddle the interval start (the spec approval starts it)', async t => {
  const {manifest,journey,variant,at}=await closedIntervalFixture(t);
  assert.doesNotThrow(()=>H.assertRejectionRepairV1(manifest,journey),'baseline fixture');
  assert.doesNotThrow(()=>H.assertRejectionRepairV1(manifest,variant(j=>{j.closed[1]!.from=at(14.5);})));
});

test('B5 closed interval 2: the defective build may end before the interval start, as in run 28', async t => {
  const {manifest,variant,at}=await closedIntervalFixture(t);
  assert.doesNotThrow(()=>H.assertRejectionRepairV1(manifest,variant(j=>{j.closed[1]!.from=at(15.5);})));
});

test('B5 closed interval 3-6: refusals stay, each next to its green sibling', async t => {
  const {manifest,journey,variant,at}=await closedIntervalFixture(t);
  const ok=(edit:(j:ReturnType<typeof variant> extends infer J ? J : never)=>void,why:string)=>assert.doesNotThrow(()=>H.assertRejectionRepairV1(manifest,variant(edit)),why);
  const no=(edit:(j:ReturnType<typeof variant> extends infer J ? J : never)=>void,why:string)=>assert.throws(()=>H.assertRejectionRepairV1(manifest,variant(edit)),closedIntervalRefused,why);
  const early=(j:ReturnType<typeof variant>)=>{j.closed[1]!.from=at(15.5);};
  // 3: the owner acts while the build runs, so the build is not the approval's own start. Sibling: case 2.
  ok(early,'case 2 sibling');
  no(j=>{early(j);j.actions.find(a=>a.name==='approve-spec')!.at=at(14.5);},'owner acts during the build');
  // 4: a non-build step (the rejection starts at 16) keeps the strict test. Sibling: from 15.5 passes.
  no(j=>{j.closed[1]!.from=at(16.5);},'rejection starts before from');
  // 5: a fresh review ending after the interval is an open-browser step. Sibling: case 2 with the original `to`.
  const codeEnds=journey.steps.filter(x=>x.role==='code-review'&&x.verdict==='CLEAN').map(x=>Date.parse(x.endedAt));
  assert.ok(codeEnds.length>=2);
  no(j=>{early(j);j.closed[1]!.to=new Date(Math.max(...codeEnds)-1000).toISOString();},'fresh review ends after to');
  // 5b: the build itself must still end at or before `to`.
  no(j=>{early(j);j.closed[1]!.to=at(14.8);},'build ends after to');
  // 6: no closed interval at all. Sibling: the unedited fixture passes.
  ok(()=>{},'unedited sibling');
  no(j=>{j.closed=[];},'no interval');
});

test('F04b per-screen HTTP receipts bind distinct envelopes to the authoritative cold card', async t => {
  await load(); const e=await evidenceSet(t);
  const apply=(bad=false)=>(v:Parameters<NonNullable<Parameters<typeof e.write>[0]>>[0])=>{
    const j=v.files['journey.json'] as {serviceFacts:{responseDigest:string;responseReceiptPath?:string;at:string;requestId:string;candidateRevision:string}[]};
    j.serviceFacts.forEach((f,i)=>{
      f.responseDigest=H.b5Bytes(`independent-live-http-envelope-${i}`);f.responseReceiptPath=`response-${i}.json`;
      v.files[f.responseReceiptPath]={responseDigest:f.responseDigest,recordDigest:bad && i===1 ? H.b5Bytes('wrong signed record') : e.card.recordDigest,
        requestId:f.requestId,candidateRevision:f.candidateRevision,at:f.at};
    });
  };
  await e.write(apply());assert.equal((await e.verify()).state,'incomplete');
  await e.write(apply(true));assert.equal(await e.refusal(),'B5_CAPTURE_CORRELATION','a different signed card cannot be hidden by fresh response hashes');
  await e.write(apply());assert.deepEqual((await e.verify()).reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
});

for (const realSession of [false, true]) test(realSession ? 'B5 controller writes complete simulated real session evidence after the cold read' : 'F04b controller writes complete fixture evidence from accepted receipts after the cold read', async t => {
  await load(); const e=await evidenceSet(t);await e.write();const setup=await scratch(t);
  const C=await import('../scripts/workflow-journeys/first-website-controller');
  const D=await import('../scripts/workflow-journeys/first-website-device');
  const root=e.p.dir,dir=e.dir;
  const manifest=H.b5ManifestSchemaV1.parse(JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')));
  const journey=H.b5JourneySchemaV1.parse(JSON.parse(await readFile(join(dir,'journey.json'),'utf8')));
  const snapshot=H.b5DatabaseSnapshotSchemaV1.parse(JSON.parse(await readFile(join(dir,'database-snapshot.json'),'utf8')));
  const teardown=H.b5TeardownSchemaV1.parse(JSON.parse(await readFile(join(dir,'teardown.json'),'utf8')));
  const png=await readFile(join(dir,'screens/01-prepare.png'));
  const items:Parameters<typeof C.writeFirstWebsiteControllerEvidenceV1>[0]['actions']=[];
  await mkdir(join(root,'device/receipts'),{recursive:true,mode:0o700});await mkdir(join(root,'device/captures'),{mode:0o700});
  const original=new Map<number,import('../scripts/workflow-journeys/first-website-device').B5DeviceReceiptV1>();
  for(const sequence of [...journey.actions.map(a=>a.sequence),...journey.closed.flatMap(c=>c.receipts.map(r=>r.sequence))])
    original.set(sequence,D.b5DeviceReceiptSchemaV1.parse(JSON.parse(await readFile(join(dir,`receipts/${sequence}.json`),'utf8'))));
  // Unit-only source data is explicitly SYNTHETIC. The independent repository
  // checks/real product fixture card below remain the existing test oracle.
  for(const [sequence,r] of [...original].sort(([a],[b])=>a-b)) {
    r.real=realSession;r.sequence=sequence*2;r.observation.sequence=r.sequence;
    r.captures=r.captures.map(c=>({...c,path:`captures/${r.sequence}.png`,sequence:r.sequence}));
    const path=join(root,`device/receipts/${r.sequence}.json`);await writeFile(path,JSON.stringify(r),{mode:0o600});
    await writeFile(join(root,r.captures[0]!.path.replace('captures/','device/captures/')),png,{mode:0o600});
    const events=journey.actions.filter(a=>a.sequence===sequence).map(a=>{
      const facts=journey.serviceFacts.find(f=>f.sequence===sequence);
      return {name:a.name,method:a.method,path:a.path,status:a.status,at:a.at,...(facts ? {responseDigest:facts.responseDigest,recordDigest:e.card.recordDigest,
        candidateRevision:e.card.candidateRevision,baseRevision:manifest.heads.base}: {})};
    });
    const screen=journey.dom.find(d=>d.screen==='08-finish-desktop');
    items.push({receipt:r,browser:{sequence:r.sequence,events,...(r.device==='desktop' && screen ? {dom:{candidateRevision:screen.candidateRevision,baseRevision:screen.baseRevision,requestId:screen.requestId}}: {})}});
  }
  const repair=structuredClone(items.find(i=>i.receipt.phase==='finish')!);repair.receipt.phase='repair';repair.receipt.sequence=21;repair.receipt.observation.sequence=21;
  repair.receipt.observedAt=repair.receipt.observation.observedAt=new Date(Date.parse(journey.closed[1]!.to)).toISOString();
  repair.receipt.actions=['repair-observed'];repair.receipt.captures=[{...repair.receipt.captures[0]!,path:'captures/21.png',sequence:21,capturedAt:repair.receipt.observedAt}];
  repair.browser={sequence:21,events:[]};await writeFile(join(root,'device/receipts/21.json'),JSON.stringify(repair.receipt),{mode:0o600});await writeFile(join(root,'device/captures/21.png'),png,{mode:0o600});items.push(repair);items.sort((a,b)=>a.receipt.sequence-b.receipt.sequence);
  // The question/plan/spec source fixture reuses a generic preparation capture;
  // each accepted receipt is copied to its own immutable mailbox path above.
  for(const [phase,sequence] of [['question',12],['plan',14],['spec',16]] as const) assert.ok(items.some(i=>i.receipt.phase===phase && i.receipt.sequence===sequence));
  const runId=e.card.evidence.binding.loopRunId,work=join(root,'reports');await mkdir(work,{mode:0o700});await mkdir(join(root,'runs',runId),{recursive:true,mode:0o700});
  const card=structuredClone(e.card);
  for(const step of journey.steps) step.identity+=`/${step.family}`;
  for(const slot of e.fixturePins.providers.lineup) slot.identity+=`/${slot.family}`;
  for(const review of card.evidence.reviews) review.observedModel+=`/${review.family}`;
  for(const review of card.evidence.reviews) {
    const step=journey.steps.find(s=>s.role===review.role && s.head===review.candidateRevision && s.family===review.family)!;
    review.stepId=`step-${step.n}`;
  }
  const rawSteps=[];
  const providerReceipts=new Map<number,{path:string;sha256:string}>();
  await mkdir(join(root,'tools/loop'),{recursive:true,mode:0o700});
  await writeFile(join(root,'tools/loop/models.tsv'),'name\tfamily\n'+journey.steps.map(s=>`${s.identity}\t${s.family}`).filter((v,i,a)=>a.indexOf(v)===i).join('\n')+'\n',{mode:0o600});
  for(const step of journey.steps) {
    const report=join(work,`${step.n}.md`),body='SYNTHETIC unit writer source\n';await writeFile(report,body,{mode:0o600});
    const sidecar=join(work,`${step.n}.json`),sidecarBody=JSON.stringify({checks:[{id:'site-status',status:step.diagnostic ?? 'PASS'}]});await writeFile(sidecar,sidecarBody,{mode:0o600});
    const modelPath=join(work,`model-${step.n}.json`),modelBody=JSON.stringify({attempt:1,launcher:'fixture',requested_model:step.identity,resolved_model:step.identity,state:'COMPLETE',log:join(work,`${step.n}.log`)});
    await writeFile(modelPath,modelBody,{mode:0o600});providerReceipts.set(step.n,{path:modelPath,sha256:H.b5Bytes(modelBody).slice(7)});
    rawSteps.push({n:step.n,role:step.role,grade:'fixture',log:join(work,`${step.n}.log`),report_snapshot:{path:report,sha256:H.b5Bytes(body).slice(7)},sidecar_seals:[{path:sidecar,sha256:H.b5Bytes(sidecarBody).slice(7)}]});
  }
  await writeFile(join(root,'runs',runId,'run.json'),JSON.stringify({steps:rawSteps,chain:{consumed_results:journey.steps.map(s=>({step:s.n,verdict:s.verdict}))}}),{mode:0o600});
  const projection={evidence:'read-only-completion-joins' as const,requestId:card.requestId,runLinkId:card.evidence.binding.runLinkId,localVersion:card.localVersion,inputVersion:card.a2InputVersion,
    engineRevision:card.evidence.binding.engineRevision,workDir:work,repository:e.p.project,base:manifest.heads.base,
    finalHead:manifest.heads.final,rejectedHeads:[manifest.heads.rejected],candidateHeadUnverified:manifest.heads.final,requiresLaterPhaseEvidence:false as const,
    cleanup:{state:'complete' as const,removedDigest:H.b5Bytes('fixture cleanup'),targets:[{source:join(root,'closed-run'),destination:join(root,'trash','closed-run'),state:'done' as const,sha256:null}],retained:join(root,'retained')},
    steps:journey.steps.map((s,i)=>({n:s.n,role:s.role,inputVersion:card.a2InputVersion,headAtStart:s.role==='build' ? (i===1 ? manifest.heads.base:manifest.heads.rejected) : s.head,
      requestedModel:s.identity,modelIdentity:{served_model:s.identity,receipts:[providerReceipts.get(s.n)!]},providerIdentityVerified:false as const,brief:'SYNTHETIC',stale:false,state:'done',verdict:s.verdict,
      findings:s.findings.map(f=>({id:'F1',severity:f.severity,disposition:f.state==='open'?'OPEN':'FIXED'})),sidecarHashes:[],startedAt:s.startedAt,endedAt:s.endedAt}))};
  const config=H.firstWebsiteConfigSchemaV1.parse({...setup.config,scratchRoot:root,product:{...setup.config.product,baseRevision:e.fixturePins.productBase,candidateRevision:e.fixturePins.productHead},
    a2:{...setup.config.a2,toolingRevision:e.fixturePins.toolingRevision,schemaDigest:e.fixturePins.schemaDigest}});
  const receipts=manifest.pins.inputBindings.map(r=>({name:r.name,index:0,path:r.path,sha256:r.sha256.slice(7),size:1,roles:r.roles,source:r.path,at:r.at,input_version:card.a2InputVersion,revision:r.revision,invalidated:[],replaces:null}));
  await rm(dir,{recursive:true,force:true});await mkdir(join(dir,'status-check'),{recursive:true,mode:0o700});await chmod(dir,0o700);
  await writeFile(join(dir,e.p.failed.record.outputPath),e.p.failed.output,{mode:0o600});await writeFile(join(dir,e.p.passed.record.outputPath),e.p.passed.output,{mode:0o600});
  const preflight={config,uid:e.fixturePins.uid,evidenceDir:dir,digests:{...e.fixturePins.digests},providers:e.fixturePins.providers,capture:e.fixturePins.capture,
    settings:{riskCategories:manifest.risk.categories,riskSlots:manifest.risk.slots},phoneTransport:'loopback-only' as const,
    rehearsal:{schemaVersion:1 as const,kind:'b5-fixture-provider-rehearsal' as const,root,productRevision:config.product.candidateRevision,toolsRevision:'a'.repeat(40),toolingRevision:config.a2.toolingRevision,
      providerConfigSha256:H.b5Bytes('provider'),corpusSha256:H.b5Bytes('corpus'),fenceSha256:H.b5Bytes('fence'),jobSandboxDigest:H.b5Bytes('sandbox'),browser:{executablePath:null,sha256:null}}};
  const writerInput={preflight,projection,actions:items,restarts:journey.restarts,receipts,statusChecks:[e.p.failed,e.p.passed],card,cleanup:noMappingCleanup(),
    owned:{processCount:0,listenerReleased:true,postgresStopped:true,runScratchAbsent:true},snapshot,startedAt:manifest.timestamps.startedAt,cleanupAt:teardown.cleanupAt};
  if (realSession) {
    delete (preflight as {rehearsal?:unknown}).rehearsal;
    Object.assign(preflight,{phoneTransport:'tailscale-serve'});
    config.device.origin='https://unit-proof.ts.net:60462';
    preflight.providers.classification='real';preflight.providers.transport='real-provider';
    const independent={jobSandboxDigest:H.b5Bytes('independently qualified unit sandbox'),toolingRevision:config.a2.toolingRevision,
      schemaDigest:config.a2.schemaDigest,productRevision:config.product.candidateRevision,assetsDigest:config.product.assetsDigest,availabilitySha256:preflight.digests.availability,recipeDigest:card.evidence.binding.recipeDigest,environmentDigest:card.evidence.binding.environmentDigest};
    await mkdir(join(root,'config'),{recursive:true,mode:0o700});
    config.a2.qualificationEvidence=join(root,'config/qualification.json');
    const qualification=JSON.stringify({providers:preflight.providers,capture:preflight.capture,realEvidence:independent});
    await writeFile(config.a2.qualificationEvidence,qualification,{mode:0o600});
    preflight.digests.qualification=H.b5Bytes(qualification);
    Object.assign(preflight,{realEvidence:independent});
    for(const item of items) {
      item.receipt.origin=config.device.origin;
      item.receipt.browser='unit-browser/1';
      item.receipt.captures.forEach(c=>{c.sha256=H.b5Bytes(png);});
      item.browser!.events.forEach(event=>{event.responseDigest ??= H.b5Bytes('unit successful HTTP response');});
      await writeFile(join(root,`device/receipts/${item.receipt.sequence}.json`),JSON.stringify(item.receipt),{mode:0o600});
      await mkdir(join(root,'device/observations'),{recursive:true,mode:0o700});
      await mkdir(join(root,'device/service'),{recursive:true,mode:0o700});
      await writeFile(join(root,`device/service/${item.receipt.sequence}.json`),JSON.stringify({sequence:item.receipt.sequence,events:item.browser!.events}),{mode:0o600});
      await writeFile(join(root,`device/observations/${item.receipt.sequence}.json`),JSON.stringify(item.receipt.observation),{mode:0o600});
    }
    const beforeStatus={Future:{keep:true}},installedStatus={...beforeStatus,TCP:{'60462':{HTTPS:true}},Web:{'unit-proof.ts.net:60462':{Handlers:{'/':{Proxy:'http://127.0.0.1:60460'}}}}};
    const q={schemaVersion:1,kind:'tailscale-serve',origin:config.device.origin,backend:'http://127.0.0.1:60460',actor:'owner',ownerAuthorized:true,
      authorizedAt:manifest.timestamps.startedAt,expiresAt:new Date(Date.now()+86400000).toISOString(),ownerLogin:'owner@example.invalid',identityPolicy:'exact-owner-login',captureMode:'native-capture-server-correlation',
      inventory:{phone:{model:'unit',os:'unit',browser:'unit-browser',browserVersion:'1'},desktop:{browser:'unit-browser',browserVersion:'1'},captureMethod:'native-screenshot',fileTransferRoute:'unit'},
      beforeStatus,installedStatus,beforeDigest:D.b5MappingDigestV1(beforeStatus),installedDigest:D.b5MappingDigestV1(installedStatus)};
    config.device.transportQualification=join(root,'config/transport.json');const qBytes=JSON.stringify(q);
    await writeFile(config.device.transportQualification,qBytes,{mode:0o600});
    preflight.capture.qualificationDigest=H.b5Bytes(qBytes);Object.assign(preflight.digests,{transport:H.b5Bytes(qBytes)});
    // Re-pin the independent qualification after its capture qualification changed.
    const bytes=JSON.stringify({providers:preflight.providers,capture:preflight.capture,realEvidence:independent});
    await writeFile(config.a2.qualificationEvidence,bytes,{mode:0o600});preflight.digests.qualification=H.b5Bytes(bytes);
    const request={removalNonce:'b'.repeat(32),requestedAt:teardown.cleanupAt};
    const removal={schemaVersion:1,actor:'owner',removalNonce:request.removalNonce,observedAt:new Date(Date.parse(teardown.cleanupAt)+1000).toISOString(),installSettled:true,installCancelled:false,
      off:{command:D.B5_DEVICE_OFF_COMMAND_V1,port:60462,exitCode:0},status:{command:D.B5_DEVICE_STATUS_COMMAND_V1,exitCode:0,afterStatus:beforeStatus,afterDigest:q.beforeDigest},beforeDigest:q.beforeDigest,installedDigest:q.installedDigest};
    await writeFile(join(root,'device/removal-request.json'),JSON.stringify(request),{mode:0o600});
    await writeFile(join(root,'device/removal-receipt.json'),JSON.stringify(removal),{mode:0o600});
    Object.assign(writerInput.cleanup,{disposition:'mapping-removed',mappingAttempted:true,comparison:true,beforeDigest:q.beforeDigest,installedDigest:q.installedDigest,afterDigest:q.beforeDigest,removalReceiptDigest:D.b5MappingDigestV1(removal)});
    // This is entirely in-process unit data, not a native device/provider claim.
  }
  await C.writeFirstWebsiteControllerEvidenceV1(writerInput);
  const verdict=await H.verifyFirstWebsiteEvidenceV1(dir,{candidateRepository:e.p.project,pins:{...e.fixturePins,digests:preflight.digests,...(realSession ? {realEvidence:(preflight as unknown as {realEvidence:B5Helper.B5RealEvidenceQualificationV1}).realEvidence,transportQualification:D.b5TransportQualificationSchemaV1.parse(JSON.parse(await readFile(config.device.transportQualification,'utf8')))} : {})},readCard:async()=>({card,responseDigest:H.b5Bytes('unit cold response')}),
    retention:{proofRoot:root,candidateRepository:e.p.project,cleanupTargets:[join(root,'closed-run')]}});
  assert.equal(verdict.state,realSession ? 'complete' : 'incomplete');
  assert.deepEqual(verdict.reasons,realSession ? [] : ['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
  if(realSession) {
    const finalized=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    assert.equal(finalized.classification.device,'real');
    for (const entry of finalized.artifacts as {path:string}[]) {
      if (!entry.path.endsWith('.json')) continue;
      const retained=await readFile(join(dir,entry.path),'utf8');
      assert.doesNotMatch(retained,/unit-proof\.ts\.net|owner@example\.invalid/iu,entry.path);
    }
    const retainedQ=JSON.parse(await readFile(join(dir,'transport/qualification.json'),'utf8'));
    assert.equal(retainedQ.ownerLogin,undefined);
    assert.match(retainedQ.origin,/^https:\/\/private-tailnet-1\.invalid:60462$/u);
    const originalQ=JSON.parse(await readFile(config.device.transportQualification,'utf8'));
    assert.equal(originalQ.origin,config.device.origin,'exact origin stays in private run data');
    assert.equal(originalQ.ownerLogin,'owner@example.invalid');
    console.log('RESULT: PASS retained qualification and receipts exclude private host/login; private qualified packet preserves exact admission values');
    assert.equal(finalized.pins.jobSandboxDigest,(preflight as unknown as {realEvidence:{jobSandboxDigest:string}}).realEvidence.jobSandboxDigest);
    let negative=0;
    const refuse=async(code:string,change:(value:typeof writerInput)=>void)=>{
      const bad=structuredClone(writerInput);bad.preflight.evidenceDir=join(root,'refusal-'+code.toLowerCase().replaceAll('_','-')+'-'+negative++);
      await mkdir(bad.preflight.evidenceDir,{mode:0o700});change(bad);
      await assert.rejects(C.writeFirstWebsiteControllerEvidenceV1(bad),{code});
    };
    await refuse('B5_PHONE_EVIDENCE_MISSING',v=>{v.actions=v.actions.filter(a=>a.receipt.device!=='phone');});
    await refuse('B5_CAPTURE_CORRELATION',v=>{v.actions[0]!.receipt.captures[0]!.sha256=H.b5Bytes('wrong digest');});
    await refuse('B5_EVIDENCE_SECRET',v=>{Object.assign(v.actions[0]!.browser!.events[0]!,{cookie:'synthetic forbidden secret'});});
    await refuse('B5_DEVICE_REAL',v=>{v.actions[0]!.receipt.real=false;});
    await refuse('B5_REHEARSAL_PACKET_INVALID',v=>{Object.assign(v.preflight,{rehearsal:{jobSandboxDigest:H.b5Bytes('fixture')}});});
    const phoneReceipt=join(root,`device/receipts/${items.find(a=>a.receipt.device==='phone')!.receipt.sequence}.json`),original=await readFile(phoneReceipt);
    await rm(phoneReceipt);
    try {await refuse('B5_PHONE_EVIDENCE_MISSING',()=>{});} finally {await writeFile(phoneReceipt,original,{mode:0o600});}
    await refuse('B5_REAL_EVIDENCE_PINS',v=>{Object.assign(v.preflight,{realEvidence:{...(v.preflight as unknown as {realEvidence:Record<string,unknown>}).realEvidence,jobSandboxDigest:H.b5Bytes('relabeled sandbox')}});});
    const savedQualification=await readFile(config.a2.qualificationEvidence);
    try {
      const bytes=JSON.stringify({...JSON.parse(savedQualification.toString('utf8')),rehearsal:{packetFile:'unit-only',packetSha256:H.b5Bytes('fixture')}});
      await writeFile(config.a2.qualificationEvidence,bytes);
      await refuse('B5_REHEARSAL_PACKET_INVALID',v=>{v.preflight.digests.qualification=H.b5Bytes(bytes);});
    } finally {await writeFile(config.a2.qualificationEvidence,savedQualification);}
    console.log('RESULT: PASS simulated real controller finalizes and verifier accepts; missing phone, digest mismatch, retained secret, fixture real and real rehearsal packet refuse typed B5 codes');
  }
  const model=providerReceipts.get(journey.steps[0]!.n)!;
  const changed=JSON.parse(await readFile(model.path,'utf8'));changed.launcher='different-native-route';
  const changedBody=JSON.stringify(changed);await writeFile(model.path,changedBody);model.sha256=H.b5Bytes(changedBody).slice(7);
  const badDir=join(root,'bad-evidence');await mkdir(join(badDir,'status-check'),{recursive:true,mode:0o700});
  await writeFile(join(badDir,e.p.failed.record.outputPath),e.p.failed.output,{mode:0o600});await writeFile(join(badDir,e.p.passed.record.outputPath),e.p.passed.output,{mode:0o600});
  await assert.rejects(C.writeFirstWebsiteControllerEvidenceV1({...writerInput,preflight:{...preflight,evidenceDir:badDir}}),{code:'B5_PROVIDER_PROVENANCE_MISMATCH'},
    'F04b writer must compare actual native receipt route with qualified provenance');
  console.log('RESULT: PASS controller evidence writer admitted by independent verifier; fixture engine unit only; no native rehearsal claim');
});

test('F04b full website report cannot qualify with absent final sections', async t => {
  await load();const e=await evidenceSet(t);await e.write();
  const responseDigest=H.b5Bytes(new Uint8Array(await (await e.readCard()).arrayBuffer()));
  for(const section of ['summary','changedAreas','databaseChanges','assumptions','validations'] as const) {
    const card=structuredClone(e.card);card.evidence[section]=null;
    assert.equal(await e.refusal({readCard:async()=>({card,responseDigest})}),'B5_FULL_REPORT_INCOMPLETE','F04b each required final report section must be present');
  }
  assert.deepEqual((await e.verify()).reasons,['B5_PROVIDER_FIXTURE','B5_PHONE_EVIDENCE_MISSING','B5_DESKTOP_EVIDENCE_MISSING']);
});

test('F04b staged fixture marker refuses real qualification even without a rehearsal label', async t => {
  await load();const s=await scratch(t);
  await writeFile(join(s.root,'config/b5-provider.json'),JSON.stringify({version:1,providers:'fixture',reason:'B5_PROVIDER_FIXTURE'}),{mode:0o600});
  const q=JSON.parse(await readFile(s.config.a2.qualificationEvidence,'utf8'));q.providers.classification='real';q.providers.transport='real-provider';
  await writeFile(s.config.a2.qualificationEvidence,JSON.stringify(q));
  const file=await s.write(s.config);
  const result=await H.preflightFirstWebsiteV1({configFile:file,evidenceDir:s.evidence,cliFile:resolve('scripts/workflow-journeys/first-website-proof.ts'),probe:async()=>true})
    .then(()=> 'PASSED',(e:unknown)=>e instanceof H.B5RefusalV1 ? e.code : String(e));
  assert.equal(result,'B5_PROVIDER_PROVENANCE_MISMATCH','F04b actual staged fixture cannot be promoted by relabeling qualified data');
});

// The barrier accepts only a committed link; service errors are never retried.
test("B5 intake link barrier waits before reading status and verifies acceptance", async () => {
  const { waitB5IntakeLinkV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  let reads = 0, clock = 1000;
  const events: string[] = [];
  const link = { runLinkId: "link:synthetic", loopRunId: "run:synthetic" };
  const result = await waitB5IntakeLinkV1({
    read: async () => { events.push("desk"); return ++reads === 3 ? link : null; },
    accepted: async value => { assert.equal(value, link); events.push("accepted"); },
    signal: new AbortController().signal, deadline: 4000, clock: () => clock,
    pause: async () => { clock += 1000; },
  });
  events.push("status");
  assert.equal(result, link); assert.deepEqual(events, ["desk", "desk", "desk", "accepted", "status"]);
});

test("B5 intake link barrier has a fixed deadline and stops on cancellation", async () => {
  const { waitB5IntakeLinkV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  let reads = 0, clock = 0;
  await assert.rejects(waitB5IntakeLinkV1({ read: async () => { reads++; return null; }, accepted: async () => assert.fail(),
    signal: new AbortController().signal, deadline: 2000, clock: () => clock, pause: async () => { clock += 1000; },
  }), { code: "B5_INTAKE_LINK_TIMEOUT" });
  assert.equal(reads, 2);
  const abort = new AbortController();
  await assert.rejects(waitB5IntakeLinkV1({ read: async () => null, accepted: async () => assert.fail(), signal: abort.signal,
    deadline: 10000, clock: () => 0, pause: async () => { abort.abort(new Error("synthetic abort")); },
  }), /synthetic abort/);
});

test("B5 intake link barrier preserves arbitrary conflicts and refused acceptance", async () => {
  const { waitB5IntakeLinkV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  let reads = 0;
  const conflict = new Error("HTTP 409");
  await assert.rejects(waitB5IntakeLinkV1({ read: async () => { reads++; throw conflict; }, accepted: async () => assert.fail(),
    signal: new AbortController().signal, deadline: Date.now() + 10000,
  }), error => error === conflict);
  assert.equal(reads, 1);
  await assert.rejects(waitB5IntakeLinkV1({ read: async () => ({ runLinkId: "link:synthetic" }),
    accepted: async () => { throw new Error("intake not accepted"); }, signal: new AbortController().signal,
    deadline: Date.now() + 10000,
  }), /intake not accepted/);
});

test("B5 intake deadline bounds a stalled desk read", { timeout: 2000 }, async () => {
  const { waitB5IntakeLinkV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  let signal: AbortSignal | undefined;
  await assert.rejects(waitB5IntakeLinkV1({
    read: async activeSignal => { signal = activeSignal; return new Promise<never>(() => {}); },
    accepted: async () => assert.fail(), signal: new AbortController().signal, deadline: Date.now() + 30,
  }), { code: "B5_INTAKE_LINK_TIMEOUT" });
  assert.equal(signal?.aborted, true);
});


test('B5 desktop facts require actual rendered candidate and base at the qualified document', async t => {
  await load();const e=await evidenceSet(t),C=await import('../scripts/workflow-journeys/first-website-controller');
  const request={schemaVersion:1 as const,sequence:1,sessionNonce:'a'.repeat(32),phase:'finish' as const,device:'desktop' as const,
    origin:'https://unit-proof.ts.net:60462',expiresAt:new Date(Date.now()+1000).toISOString(),
    binding:{requestId:e.card.requestId,runLinkId:e.card.evidence.binding.runLinkId,inputVersion:e.card.localVersion}};
  const input={request,card:e.card,candidateRevision:e.card.candidateRevision,baseRevision:e.card.evidence.binding.baseRevision,
    url:request.origin+'/projects/unit/improvements#request='+encodeURIComponent(e.card.requestId)};
  assert.deepEqual(C.readB5DesktopFactsV1(input),{candidateRevision:e.card.candidateRevision,baseRevision:e.card.evidence.binding.baseRevision,requestId:e.card.requestId});
  for(const change of [{candidateRevision:null},{baseRevision:null},{candidateRevision:e.card.evidence.binding.baseRevision,baseRevision:e.card.candidateRevision},
    {candidateRevision:e.card.candidateRevision+' '+e.card.evidence.binding.baseRevision},{baseRevision:'Base revision: '+e.card.evidence.binding.baseRevision},
    {url:input.url.replace('unit-proof.ts.net','other.ts.net')},{url:input.url.replace(encodeURIComponent(e.card.requestId),'different-request')}])
    assert.throws(()=>C.readB5DesktopFactsV1({...input,...change}),{code:'B5_HEAD_BINDING'});
  console.log('RESULT: PASS desktop facts require rendered final/base revisions, qualified HTTPS origin and exact request document; labelled revision values bind exactly; seven mismatches refuse B5_HEAD_BINDING');
});


test('B5 real evidence pins require independent readiness input without rehearsal defaults', async t => {
  await load();const s=await scratch(t),config=H.firstWebsiteConfigSchemaV1.parse(s.config),digests={availability:H.b5Bytes('availability')};
  const qualified={jobSandboxDigest:H.b5Bytes('sandbox'),toolingRevision:config.a2.toolingRevision,schemaDigest:config.a2.schemaDigest,
    productRevision:config.product.candidateRevision,assetsDigest:config.product.assetsDigest,availabilitySha256:digests.availability,
    recipeDigest:H.b5Bytes('recipe'),environmentDigest:H.b5Bytes('environment')};
  assert.deepEqual(H.qualifyB5RealEvidenceV1(qualified,config,digests),qualified);
  for(const value of [undefined,{jobSandboxDigest:qualified.jobSandboxDigest}])
    assert.throws(()=>H.qualifyB5RealEvidenceV1(value,config,digests),{code:'B5_REAL_EVIDENCE_QUALIFICATION_REQUIRED'});
  for(const key of ['toolingRevision','schemaDigest','productRevision','assetsDigest','availabilitySha256'] as const)
    assert.throws(()=>H.qualifyB5RealEvidenceV1({...qualified,[key]:key==='productRevision'?'c'.repeat(40):H.b5Bytes('changed')},config,digests),{code:'B5_REAL_EVIDENCE_PINS'});
  console.log('RESULT: PASS real readiness pins have no rehearsal default; missing packet and five independent pin mismatches refuse typed B5 codes');
});

test('B5 evidence finalizer refuses retained codes, cookies and tokens in JSON artifacts', async t => {
  await load();const e=await evidenceSet(t);await e.write();
  const manifest=H.b5ManifestSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8')));
  const teardown=H.b5TeardownSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8')));
  for(const secret of [{ownerCode:'synthetic disposable code'},{cookie:'synthetic cookie'},{access_token:'synthetic token'},
    {nested:{headers:{authorization:'synthetic'}}},{value:'Bearer synthetic-forbidden-token'}]) {
    await writeFile(join(e.dir,'unsafe.json'),JSON.stringify(secret),{mode:0o600});
    await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,manifest,teardown,{proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets:[join(e.p.dir,'removed-work')]}),{code:'B5_EVIDENCE_SECRET'});
  }
  console.log('RESULT: PASS retained owner-code, cookie, access-token, auth-header and bearer-token artifacts refuse B5_EVIDENCE_SECRET');
});

test('B5 retained evidence refuses private hosts and owner logins in JSON, text and manifest', async t=>{
  await load(); const e=await evidenceSet(t);
  for (const sensitive of ['https://unit-private.ts.net:60462','unit-owner@example.invalid']) {
    for (const path of ['extra.json','extra.txt']) {
      await e.write();
      await writeFile(join(e.dir,path),path.endsWith('.json') ? JSON.stringify({nested:sensitive}) : sensitive,{mode:0o600});
      const manifest=H.b5ManifestSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8')));
      const teardown=H.b5TeardownSchemaV1.parse(JSON.parse(await readFile(join(e.dir,'teardown.json'),'utf8')));
      await assert.rejects(H.finalizeFirstWebsiteEvidenceV1(e.dir,manifest,teardown,{proofRoot:e.p.dir,candidateRepository:e.p.project,cleanupTargets:[join(e.p.dir,'closed-run')]}),{code:'B5_EVIDENCE_SECRET'});
      const bytes=await readFile(join(e.dir,path));manifest.artifacts.push({path,bytes:bytes.length,sha256:H.b5Bytes(bytes)});
      // Rehash teardown from the failed finalization to reach the secret guard.
      for (const entry of manifest.artifacts) {const b=await readFile(join(e.dir,entry.path));entry.sha256=H.b5Bytes(b);entry.bytes=b.length;}
      await writeFile(join(e.dir,'manifest.json'),JSON.stringify(manifest));
      await assert.rejects(e.verify(),{code:'B5_EVIDENCE_SECRET'});
    }
    await e.write();
    const manifest=JSON.parse(await readFile(join(e.dir,'manifest.json'),'utf8'));
    manifest.pins.inputBindings[0].path='/scratch/'+sensitive;
    await writeFile(join(e.dir,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(e.verify(),{code:'B5_EVIDENCE_SECRET'});
  }
  console.log('RESULT: PASS finalizer and verifier refuse private host and owner login in retained JSON/text; manifest guard refuses both');
});

test("B5 real owner gates exclude days of waiting and finish within the original active allowance", async t => {
  const { createFirstWebsiteControllerOwnerV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-02T00:00:00Z") });
  const owner = createFirstWebsiteControllerOwnerV1(), events: string[] = [];
  try {
    const started = Date.now(), budget = 600_000, longWait = 3 * 24 * 3600_000;
    owner.registerStopWork(async () => { events.push("stop"); });
    owner.registerCloseHost(async () => { events.push("host"); });
    owner.registerStopPostgres(async () => { events.push("postgres"); });
    owner.startDeadline(budget, { ownerGates: true });
    t.mock.timers.tick(20_000);
    for (const gate of ["connect", "prepare", "confirm-start", "question", "plan", "spec", "finish", "close", "re-sign-in"]) {
      let answer!: () => void;
      const waiting = owner.waitForOwner(() => new Promise<void>(yes => { answer = yes; }));
      await Promise.resolve();
      assert.equal(owner.timing().waitingForOwner, true);
      t.mock.timers.tick(longWait);
      assert.equal(owner.signal.aborted, false, gate);
      assert.equal(owner.workAt(), started + 300_000 + owner.timing().gateWaitMs);
      assert.throws(() => owner.startDeadline(budget), { code: "B5_DEADLINE_INVALID" }, "start anchors cannot reset while waiting");
      answer(); await waiting;
      assert.equal(owner.timing().waitingForOwner, false);
      t.mock.timers.tick(10_000); // Actual work after each gate still consumes budget.
    }
    assert.equal(owner.timing().gateWaitMs, 9 * longWait);
    assert.equal(owner.capAt(), started + budget + 9 * longWait);
    assert.equal(owner.signal.aborted, false);
    const result = await owner.cleanup();
    assert.deepEqual(events, ["stop", "host", "postgres"]);
    assert.equal(result.hostStopped && result.postgresStopped, true);
    assert.deepEqual(result.failures, []); assert.equal(result.overrunMs, 0);
  } finally { owner.dispose(); t.mock.timers.reset(); }
  console.log("RESULT: PASS B5 real gate waits=27days active=110s budget=300s finished cleanup=complete");
});

test("B5 real gates retain cumulative active work and reject overrun between gates", async t => {
  const { createFirstWebsiteControllerOwnerV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const owner = createFirstWebsiteControllerOwnerV1();
  try {
    owner.startDeadline(1000, { ownerGates: true });
    t.mock.timers.tick(200);
    await owner.waitForOwner(async () => { t.mock.timers.tick(10_000_000); });
    t.mock.timers.tick(299); assert.equal(owner.signal.aborted, false);
    t.mock.timers.tick(1); assert.equal(owner.signal.reason.code, "B5_DEADLINE");
    let ran = false;
    await assert.rejects(owner.waitForOwner(async () => { ran = true; }), { code: "B5_DEADLINE" });
    assert.equal(ran, false); await owner.cleanup();
  } finally { owner.dispose(); t.mock.timers.reset(); }
  console.log("RESULT: PASS B5 real active work overrun fails at cumulative 500ms after long gate");
});

test("B5 real Stop and abort during an owner gate cancel promptly and run full mapping cleanup", async t => {
  await load();
  const { createFirstWebsiteControllerOwnerV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  const D = await import("../scripts/workflow-journeys/first-website-device");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-02T00:00:00Z") });
  try {
    for (const code of ["B5_OWNER_STOP", "B5_INTERRUPTED"]) {
      const external = new AbortController(), owner = createFirstWebsiteControllerOwnerV1(external.signal), events: string[] = [];
      const origin = "https://fixture.ts.net:60462", beforeStatus = {}, beforeDigest = D.b5MappingDigestV1(beforeStatus), installedDigest = D.b5DeviceHashV1("fixture mapping");
      try {
        owner.startDeadline(600_000, { ownerGates: true });
        owner.registerStopWork(async signal => { assert.equal(signal.aborted, false); events.push("stop"); });
        owner.registerCloseHost(async () => { events.push("host"); });
        owner.registerStopPostgres(async () => { events.push("postgres"); });
        owner.armMapping({ origin, beforeStatus, beforeDigest, installedDigest } as never, async (request, signal) => {
          assert.equal(signal.aborted, false); events.push("remove");
          return { schemaVersion: 1, actor: "owner", removalNonce: request.removalNonce, observedAt: new Date().toISOString(), installSettled: true, installCancelled: true,
            off: { command: D.B5_DEVICE_OFF_COMMAND_V1, port: 60462, exitCode: 0 }, beforeDigest, installedDigest,
            status: { command: D.B5_DEVICE_STATUS_COMMAND_V1, exitCode: 0, afterStatus: {}, afterDigest: beforeDigest } };
        });
        const waiting = owner.waitForOwner(() => new Promise<never>(() => {}));
        const rejected = assert.rejects(waiting, { code });
        t.mock.timers.tick(48 * 3600_000);
        if (code === "B5_OWNER_STOP") owner.abort(new H.B5RefusalV1(code));
        else external.abort(new H.B5RefusalV1(code));
        await rejected;
        const result = await owner.cleanup(), waited = owner.timing().gateWaitMs;
        assert.equal(result.disposition, "mapping-removed"); assert.deepEqual(result.failures, []);
        assert.deepEqual(events, ["stop", "host", "remove", "postgres"]);
        t.mock.timers.tick(1000); assert.equal(owner.timing().gateWaitMs, waited, "cleanup must freeze gate accounting");
      } finally { owner.dispose(); }
    }
  } finally { t.mock.timers.reset(); }
  console.log("RESULT: PASS B5 Stop/abort during long gate cancel wait and clean stop/host/mapping/postgres");
});

test("B5 rehearsal owner gates keep the original short deadline", async t => {
  const { createFirstWebsiteControllerOwnerV1 } = await import("../scripts/workflow-journeys/first-website-controller");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const owner = createFirstWebsiteControllerOwnerV1();
  try {
    owner.startDeadline(60_000, { ownerGates: false });
    const waiting = owner.waitForOwner(async () => {
      t.mock.timers.tick(29_999); assert.equal(owner.signal.aborted, false);
      t.mock.timers.tick(1); owner.signal.throwIfAborted();
    });
    await assert.rejects(waiting, { code: "B5_DEADLINE" });
    assert.deepEqual(owner.timing(), { gateWaitMs: 0, waitingForOwner: false });
    assert.equal(owner.workAt(), 31_000); assert.equal(owner.capAt(), 61_000);
    await owner.cleanup();
  } finally { owner.dispose(); t.mock.timers.reset(); }
  console.log("RESULT: PASS B5 rehearsal gate deadline unchanged work=30s total=60s");
});

// Exercise the exported journey, not a list of gate names against its clock.
// Native host/browser/model and evidence qualification are offline boundaries;
// receipt polling, owner accounting, HTTP sessions, observer and restarts are real.
test('B5 real journey continues through every long owner gate and both restarts', { timeout: 30_000 }, async t => {
  const { s, D, preflight } = await controllerDriverFixture(t);
  const C = await import('../scripts/workflow-journeys/first-website-controller');
  const e = await evidenceSet(t), started = Date.now(), hours = 2 * 3600_000;
  const transport = JSON.parse(await readFile(s.config.device.transportQualification, 'utf8'));
  transport.expiresAt = new Date(started + 7 * 24 * 3600_000).toISOString();
  await writeFile(s.config.device.transportQualification, JSON.stringify(transport), { mode: 0o600 });
  const deviceRoot = join(s.root, 'device'), workRoot = join(s.root, 'work');
  await mkdir(join(deviceRoot, 'inbox'), { recursive: true, mode: 0o700 });
  await chmod(deviceRoot, 0o700); await mkdir(workRoot);
  const carrier = JSON.stringify({ configuration: { workRoot } });
  await writeFile(s.config.a2.contractFile, carrier);
  await mkdir(join(s.root, 'runs', 'run:long'), { recursive: true });
  await writeFile(join(s.root, 'runs', 'run:long', 'run.json'), JSON.stringify({ steps: [] }));
  const requestId = e.card.requestId, projectId = e.card.projectId, runLinkId = e.card.evidence.binding.runLinkId;
  const hash = H.b5Bytes('long gate fixture').slice(7), toolingRevision = preflight.config.a2.toolingRevision;
  let saved = false, linked = false, state = 'draft', stage = 'draft', sequence = 0, restarts = 0, sessionPosts = 0, sessionDeletes = 0;
  let confirmationAt: string | null = null, pending: Record<string, unknown> | undefined;
  const gates: string[] = [], commands: Record<string, unknown>[] = [], accepted: string[] = [];
  const iso = () => new Date().toISOString();
  const question = { questionId: 'question:long', inputVersion: 1, reportSha256: hash, owner: true, changesInput: false };
  const approval = (step: string) => ({ step, inputVersion: 1, head: e.p.final, reportSha256: hash });
  const request = () => ({ requestId, projectId, currentVersion: 1, description: H.B5_REQUEST_TEXT,
    requestSha256: H.b5Bytes(H.B5_REQUEST_TEXT).slice(7), settingsSha256: hash,
    runLink: linked ? { runLinkId, loopRunId: 'run:long', adapterId: 'adapter:long', toolingRevision,
      a2SchemaVersion: 1, initialInputVersion: 1 } : null,
    savedAuthorization: true, createdAt: new Date(started).toISOString(), startsWork: false, grantsDeployAuthority: false });
  const status = () => ({ schemaVersion: 1, request: request(), display: {
    schemaVersion: 1, projectId, requestId, localVersion: 1, description: H.B5_REQUEST_TEXT,
    requestSha256: H.b5Bytes(H.B5_REQUEST_TEXT).slice(7), settingsSha256: hash, runLinkId,
    engineRevision: 1, state: null, startState: confirmationAt ? 'started' : 'not_started',
    confirmationCurrent: !!confirmationAt, canStart: false, canStop: !!confirmationAt,
    progress: null, attention: null, observedAt: iso(),
  }, engine: { revision: 1, state, draft: H.B5_REQUEST_TEXT, requestSha256: hash, settingsSha256: hash, inputVersion: 1,
    confirmation: confirmationAt ? { sha256: hash, at: confirmationAt, who: 'owner', inputVersion: 1 } : null,
    progress: { step: null, completed: 0, attention: 'none' }, identity: 'unverified',
    question: stage === 'question' ? question : null, approval: ['plan', 'spec'].includes(stage) ? approval(stage) : null,
  }, decisions: { gate: stage === 'question' ? { kind: 'question', text: 'Which color?' }
    : ['plan', 'spec'].includes(stage) ? { kind: 'approve' } : null, observedAt: iso() } });
  function command(operation: string, body: Record<string, unknown>) {
    const binding = { schemaVersion: 1, body, localVersion: 1, adapterId: 'adapter:long', loopRunId: 'run:long',
      toolingRevision, a2SchemaVersion: 1, schemaDigest: preflight.config.a2.schemaDigest,
      requestSha256: hash, settingsSha256: hash, runLinkId, authorizationId: null, inputVersion: 1, expectedRevision: 1, evidence: null };
    const commandId = `command:${commands.length}`;
    for (const entry_kind of ['claim', 'result']) commands.push({ command_id: commandId, request_id: requestId, operation,
      entry_kind, binding, created_at: iso(), ...(entry_kind === 'result' ? { result: { state: 'accepted', revision: 1,
        adapterId: 'adapter:long', loopRunId: 'run:long', toolingRevision, evidenceDigest: H.b5Bytes('accepted'), error: null } } : {}) });
  }
  const receipts = H.B5_INPUT_BINDINGS.map((b, i) => ({ name: b.name, roles: [...b.roles], path: join(workRoot, b.name),
    sha256: preflight.digests[b.input]!.slice(7), input_version: 1, revision: i + 1 } as B5BindInputReceiptV1));
  for (const [i, b] of H.B5_INPUT_BINDINGS.entries()) await writeFile(receipts[i]!.path, await readFile(preflight.config[b.input === 'faultInput' ? 'faultInputFile' : 'reviewInputFile']));
  const projection = () => ({ repository: e.p.project, workDir: workRoot, rejectedHeads: [], finalHead: e.p.final,
    cleanup: { state: 'complete', targets: [] }, steps: ['build', 'code-review', 'code-review'].map((role, i) => ({ n: i + 1, role,
      headAtStart: e.p.final, inputVersion: 1, startedAt: iso(), brief: `Additional supplied input (read in full): ${receipts[role === 'build' ? 0 : 1]!.path} (SHA256 ${receipts[role === 'build' ? 0 : 1]!.sha256})` })) });
  const mailbox = { root: deviceRoot, request: async (phase: string, device: string, expiresAt: string, binding: unknown) => {
    pending = { schemaVersion: 1, sequence: ++sequence, sessionNonce: 'a'.repeat(32), phase, device, origin: transport.origin, expiresAt, ...(binding ? { binding } : {}) };
    if (phase === 'prepare') saved = true; // Saved intake can precede its committed link and owner receipt.
    return pending;
  }, accept: async (receipt: { phase: string; device: string }) => {
    accepted.push(`${receipt.phase}:${receipt.device}`);
    if (receipt.phase === 'prepare') { linked = true; command('intake', { description: H.B5_REQUEST_TEXT }); }
    if (receipt.phase === 'confirm-start') { confirmationAt = iso(); state = 'waiting'; stage = 'question'; command('confirm', {}); command('start', {}); }
    if (receipt.phase === 'question') { stage = 'plan'; command('answer', { questionId: question.questionId, questionReportSha256: hash, text: 'Amber' }); }
    if (receipt.phase === 'plan') { stage = 'spec'; command('approve', approval('plan')); }
    if (receipt.phase === 'spec') { stage = 'finished'; state = 'finished'; command('approve', approval('spec')); }
    return receipt;
  }, currentRequest: () => pending, readServiceEvidence: async () => ({ events: [] }) };
  const owned = { processCount: 0, listenerReleased: true, postgresStopped: true, runScratchAbsent: true };
  const owner = C.createFirstWebsiteControllerOwnerV1(), realWait = owner.waitForOwner.bind(owner);
  const host = { startup: { isReady: () => true }, origin: 'http://127.0.0.1:60460', a2Entry: {}, close: async () => {}, proof: {
    device: mailbox, project: { projectId, repository: e.p.project, baseRevision: e.p.seeded.head },
    withOwnerCode: async (use: (value: string) => unknown) => use('synthetic-offline-code'),
    readRun: async () => projection(), readSnapshot: async () => ({ schemaVersion: 1, readAt: iso(), rows: commands.map(row => ({ table: 'control_loop_improvement_commands', row, sha256: H.b5Bytes(JSON.stringify(row)) })) }),
    restart: async () => { restarts++; }, inspectOwned: async () => owned,
  } } as unknown as B5Helper.FirstWebsiteHostV1;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/local-owner-session') {
      if (init.method === 'DELETE') { sessionDeletes++; return new Response(null, { status: 204 }); }
      return Response.json({ expiresAt: new Date(Date.now() + 300_000).toISOString() }, { status: 201, headers: { 'set-cookie': `local-owner=offline-${++sessionPosts}` } });
    }
    if (path.endsWith('/desk')) return Response.json({ legacy: { projectId, templates: [], requests: [], startsWork: false, grantsDeployAuthority: false }, loopRequests: saved ? [request()] : [] });
    if (path.endsWith('/status')) return Response.json(status());
    if (path.endsWith('/candidate')) return e.readCard();
    if (path.endsWith('/approval-document')) return Response.json({});
    throw new Error(`unexpected offline route: ${path}`);
  });
  const drain = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(yes => setImmediate(yes)); };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: started });
  let inGate = false;
  t.mock.method(owner, 'waitForOwner', <T>(receive: () => Promise<T>) => realWait(async () => {
    inGate = true;
    const label = pending ? `${pending.phase}:${pending.device}` : 'install'; gates.push(label);
    try {
      await drain(); t.mock.timers.tick(1000); await drain();
      t.mock.timers.tick(hours); await drain();
      assert.equal(owner.signal.aborted, false, `still alive during ${label}`);
      if (!pending) {
        const install = JSON.parse(await readFile(join(deviceRoot, 'install-request.json'), 'utf8'));
        await writeFile(join(deviceRoot, 'install-receipt.json'), JSON.stringify({ schemaVersion: 1, actor: 'owner',
          installNonce: install.installNonce, command: D.B5_DEVICE_INSTALL_COMMAND_V1, statusCommand: D.B5_DEVICE_STATUS_COMMAND_V1,
          exitCode: 0, statusExitCode: 0, observedAt: iso(), statusDigest: transport.installedDigest, status: transport.installedStatus }), { mode: 0o600 });
      } else await writeFile(join(deviceRoot, 'inbox', `${pending.sequence}.json`), JSON.stringify(pending), { mode: 0o600 });
      return await receive();
    } finally { inGate = false; }
  }));
  // Removal is machine cleanup, not another owner wait to exclude.
  const realArm = owner.armMapping.bind(owner);
  t.mock.method(owner, 'armMapping', (q: typeof transport) => realArm(q, async r => ({ schemaVersion: 1, actor: 'owner',
    removalNonce: r.removalNonce, observedAt: iso(), installSettled: true, installCancelled: true,
    off: { command: D.B5_DEVICE_OFF_COMMAND_V1, port: 60462, exitCode: 0 }, beforeDigest: q.beforeDigest, installedDigest: q.installedDigest,
    status: { command: D.B5_DEVICE_STATUS_COMMAND_V1, exitCode: 0, afterStatus: q.beforeStatus, afterDigest: q.beforeDigest } })));
  let verified = false, settled = false;
  try {
    const journey = C.runFirstWebsiteJourneyV1({ ...preflight, controllerOwner: owner,
      config: { ...preflight.config, maxDurationMs: 600_000 }, digests: { ...preflight.digests, contract: H.b5Bytes(carrier),
        settings: `sha256:${hash}`, transport: H.b5Bytes(JSON.stringify(transport)) } }, new AbortController().signal, {
      loadAssembly: async () => async () => { owner.registerCloseHost(async () => {}); owner.registerStopPostgres(async () => {}); return host; },
      probeBind: async () => {}, bindInputs: async () => receipts, ownerChannel: async () => {}, captureDesktop: async () => undefined,
      diagnosticSnapshot: async () => e.p.passed,
      verifyEvidence: async (_dir, input) => { await input.readCard(); verified = true; return { state: 'incomplete', reasons: ['B5_PROVIDER_FIXTURE'], transportCleanup: H.missingB5TransportCleanupV1() }; },
    }).finally(() => { settled = true; });
    // Allow filesystem and HTTP promise turns to settle; tick machine pauses only
    // outside the explicit hours-long owner waits. No real sleeps or services.
    for (let i = 0; !settled && i < 5000; i++) { await drain(); if (!inGate) t.mock.timers.tick(1000); }
    if (!settled) owner.abort(new H.B5RefusalV1('B5_TEST_STALLED'));
    const verdict = await journey;
    assert.equal(verified, true, JSON.stringify(verdict));
    assert.deepEqual(verdict.reasons, ['B5_PROVIDER_FIXTURE']);
    assert.deepEqual(gates, ['install', 'connect:phone', 'connect:desktop', 'prepare:phone', 'bindings-ready:phone', 'confirm-start:phone',
      'close:phone', 'close:desktop', 'question:phone', 'plan:phone', 'spec:phone', 'close:phone', 'close:desktop',
      'repair:phone', 'finish:phone', 'finish:desktop', 'retained:phone']);
    assert.deepEqual(accepted, gates.slice(1)); assert.equal(restarts, 2);
    const timing = JSON.parse(await readFile(join(s.evidence, 'controller-timing.json'), 'utf8'));
    assert.equal(timing.gateWaitMs, gates.length * (hours + 1000));
    assert.equal(timing.workDeadline, started + 300_000 + timing.gateWaitMs);
    assert.equal(timing.cleanupDeadline, started + 600_000 + timing.gateWaitMs);
    assert.equal(timing.waitingForOwner, false); assert.equal(timing.ownerGateWaitExcluded, true);
    assert.equal(verdict.transportCleanup.disposition, 'mapping-removed'); assert.deepEqual(verdict.transportCleanup.failures, []);
    assert.ok(sessionPosts >= gates.length, 'session renewed after hours-long waits'); assert.equal(sessionDeletes, sessionPosts);
  } finally { owner.dispose(); t.mock.timers.reset(); }
  console.log('RESULT: PASS B5 exported real journey 17 gates x2h; intake/approval bounds, observer, two restarts, session renewal, timing artifact and cleanup; offline fixture only');
});

test("B5 controller persists a bounded finalization reason in timeout verdict detail",async t=>{
  const {createFirstWebsiteControllerOwnerV1}=await import('../scripts/workflow-journeys/first-website-controller');
  for(const [detail,expected] of [["PUBLICATION_UNAVAILABLE","PUBLICATION_UNAVAILABLE"],
    ...["PUBLICATION_PREPARE_FAILED","PUBLICATION_VERIFY_FAILED","PUBLICATION_RECORD_FAILED","PUBLICATION_VERIFY_PUBLICATION_FAILED",
      "PUBLICATION_PUBLISHED_APPEND_FAILED","PUBLICATION_ANNOUNCED_APPEND_FAILED"].map(code=>[code,code]),
    ["PRIVATE /scratch/unknown","UNAVAILABLE"]]){
    const {s,preflight,runFirstWebsiteJourneyV1}=await controllerDriverFixture(t);
    const owner=createFirstWebsiteControllerOwnerV1(),evidenceDir=join(s.root,'finalization-timeout-evidence');
    t.mock.method(owner,'beginAcquisition',()=>{throw new H.B5RefusalV1("B5_A2_FINALIZATION_TIMEOUT",detail);});
    const verdict=await runFirstWebsiteJourneyV1({...preflight,evidenceDir,controllerOwner:owner},new AbortController().signal);
    const saved=JSON.parse(await readFile(join(evidenceDir,'controller-verdict.json'),'utf8'));
    assert.ok(verdict.reasons.includes("B5_A2_FINALIZATION_TIMEOUT"));
    assert.deepEqual(saved.detail,[{name:"Error",message:"B5_A2_FINALIZATION_TIMEOUT",finalizationReasonCode:expected}]);
    assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|scratch\/unknown/);
  }
});
