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
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import type * as B5Helper from "./helpers/improve-control-room-first-website";
import type { B5BindInputReceiptV1, B5QualifiedPinsV1, B5StatusCheckRecordV1 } from "./helpers/improve-control-room-first-website";
import type { LoopCandidateCardV1 } from "../src/improve-control-room/v1/loop-candidate-wire";
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
    "a2-contract.json": "{}", "qualification.json": "{}", "settings.json": JSON.stringify(settings), "availability.json": "{}",
    "authorization.json": "{}", "transport.json": "{}", "fault-input.md": "Builder-only first-attempt instruction.\n", "review-input.md": "Code-review-only neutral instruction.\n" };
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, "config", name), text);
  const c = (name: string) => join(root, "config", name);
  const config = { schemaVersion: 1, product: { root: resolve("."), baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), assetsDigest: H.b5Bytes("assets") },
    a2: { contractFile: c("a2-contract.json"), toolingRevision: H.b5Bytes("tooling"), schemaDigest: H.b5Bytes("schema"), qualificationEvidence: c("qualification.json") },
    assembly: { module: c("first-website-host.mjs"), digest: H.b5Bytes(files["first-website-host.mjs"]!) }, scratchRoot: root,
    ports: { product: 60460, preview: 60461, postgresBase: 60470 },
    device: { origin: "https://device.invalid", transportQualification: c("transport.json"), actor: "reviewer" },
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
  const readCard = async () => (await (await f.handle(webRequest(`/api/v1/projects/${encodeURIComponent(project)}/improvements/loop/${encodeURIComponent(requestId)}/candidate`))).json()).candidate;
  const card = (await readCard()) as LoopCandidateCardV1;
  const rows: { table: string; sha256: string; row: Record<string, unknown> }[] = [];
  for (const table of H.B5_SNAPSHOT_TABLES) for (const value of (await f.client.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows) {
    const row = JSON.parse(JSON.stringify(value, (_k, v: unknown) => typeof v === "bigint" ? Number(v) : v)) as Record<string, unknown>;
    rows.push({ table, sha256: H.b5Bytes(JSON.stringify(row)), row });
  }
  const digests = { settings: H.b5Bytes("settings"), availability: H.b5Bytes("availability"), authorization: H.b5Bytes("authorization"),
    qualification: H.b5Bytes("qualification"), assembly: H.b5Bytes("assembly"), faultInput: H.b5Bytes("fault"), reviewInput: H.b5Bytes("review") };
  const fixturePins: B5QualifiedPinsV1 = { toolingRevision: f.adapter.toolingRevision, schemaDigest: f.adapter.schemaDigest,
    productBase: "1".repeat(40), productHead: "2".repeat(40), uid: 501, digests };
  const qualifiedPins: B5QualifiedPinsV1 = { ...fixturePins, toolingRevision: H.b5Bytes("qualified A2 tooling") };
  const time = (minute: number) => new Date(Date.UTC(2026, 9, 30, 12, minute)).toISOString();
  const step = (n: number, role: string, identity: string, family: string, head: string, verdict: string | null, extra: Record<string, unknown> = {}) =>
    ({ n, role, identity, family, verified: true, head, startedAt: time(10 + n * 2), endedAt: time(11 + n * 2), verdict, findings: [], diagnostic: null, ...extra });
  const reviews = card.evidence.reviews, old = reviews.find(r => !r.current)!, current = reviews.filter(r => r.current);
  const steps = [step(1, "plan", "writer-p", "family-p", base, "DONE"), step(2, "build", "writer-b", "family-b", p.rejected, "DONE"),
    step(3, old.role, old.observedModel!, old.family!, old.candidateRevision, old.verdict, { diagnostic: "FAIL", findings: [{ severity: "MEDIUM", state: "open", summary: "status element lacks role=status" }] }),
    step(4, "build", "writer-b", "family-b", p.final, "DONE"),
    ...current.map((r, i) => step(5 + i, r.role, r.observedModel!, r.family!, r.candidateRevision, r.verdict, r.role === "code-review" ? { diagnostic: "PASS" } : {}))];
  const dom = H.B5_DOM_SCREENS.map(screen => ({ screen, candidateRevision: card.candidateRevision, baseRevision: base, requestId }));
  const files: Record<string, unknown> = {
    "journey.json": { schemaVersion: 1, actions: [
      { name: "Prepare request", device: "phone", at: time(0), method: "POST", path: `/api/v1/projects/p/improvements/loop/intake`, status: 201 },
      { name: "Confirm this exact request", device: "phone", at: time(2), method: "POST", path: `/api/v1/projects/p/improvements/loop/${requestId}/confirm`, status: 200 }],
    closed: [{ label: "after Start", from: time(3), to: time(11) }, { label: "after spec approval", from: time(12), to: time(40) }], steps, dom,
    devices: [{ kind: "phone", real: true, browser: "phone browser" }, { kind: "desktop", real: true, browser: "desktop browser" }] },
    "database-snapshot.json": { schemaVersion: 1, readAt: time(43), rows },
    "independent-status-check.json": [p.failed.record, p.passed.record],
    "teardown.json": { schemaVersion: 1, b3cCleanup: "complete", scratchAbsent: true, ownedProcesses: 0, ownedListenersReleased: true, protectedListenersUntouched: true,
      postgresStopped: true, cleanupAt: time(41), retainedRead: { at: time(42), candidateRevision: card.candidateRevision, receiptDigest: card.recordDigest } },
  };
  const raw: Record<string, string | Uint8Array> = { "status-check/rejected.txt": p.failed.output, "status-check/final.txt": p.passed.output };
  for (const n of ["01-prepare", "02-confirm-start", "03-question", "04-plan", "05-spec", "06-repair", "07-finish-phone", "08-finish-desktop", "09-retained"]) raw[`screens/${n}.png`] = new Uint8Array([137, 80, 78, 71, n.length]);
  type Files = { files: Record<string, unknown>; manifest: Record<string, unknown> };
  const write = async (change: (v: Files) => void = () => {}) => {
    await rm(dir, { recursive: true, force: true }); await mkdir(join(dir, "screens"), { recursive: true }); await mkdir(join(dir, "status-check"));
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
      classification: { website: "real", storage: "real", engine: "real", sendBack: "real", recovery: "real", finish: "real", device: "real", stimuli: "fixture" },
      timestamps: { startedAt: time(0), finishedAt: time(45) } };
    const v = { files: structuredClone(files), manifest }; change(v);
    const bytes = new Map<string, string | Uint8Array>(Object.entries(raw));
    for (const [name, value] of Object.entries(v.files)) bytes.set(name, JSON.stringify(value));
    for (const [name, value] of bytes) await writeFile(join(dir, name), value);
    v.manifest.artifacts ??= [...bytes].map(([path, value]) => ({ path, sha256: H.b5Bytes(value), bytes: Buffer.byteLength(value) }));
    await writeFile(join(dir, "manifest.json"), JSON.stringify(v.manifest));
  };
  type Journey = { steps: Record<string, unknown>[]; devices: Record<string, unknown>[]; dom: Record<string, unknown>[] };
  const verify = (o: { readCard?: () => Promise<unknown>; pins?: B5QualifiedPinsV1 } = {}) =>
    H.verifyFirstWebsiteEvidenceV1(dir, { readCard: o.readCard ?? readCard, candidateRepository: p.project, pins: o.pins ?? fixturePins });
  const refusal = (o: Parameters<typeof verify>[0] = {}) => verify(o).then(v => v.state, (e: unknown) => e instanceof H.B5RefusalV1 ? e.code : String(e));
  return { p, f, dir, card, readCard, fixturePins, qualifiedPins, write, verify, refusal, journey: (v: Files) => v.files["journey.json"] as Journey,
    teardown: (v: Files) => v.files["teardown.json"] as Record<string, unknown>,
    snapshot: (v: Files) => v.files["database-snapshot.json"] as { rows: { table: string; sha256: string; row: Record<string, unknown> }[] } };
}
test("B5 verifier accepts complete real-shaped evidence and reports missing phone evidence as incomplete", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(); assert.deepEqual(await e.verify(), { state: "complete", reasons: [] });
  await e.write(v => { e.journey(v).devices = [{ kind: "phone", real: false, browser: "360px emulation" }, { kind: "desktop", real: true, browser: "desktop browser" }]; });
  assert.deepEqual(await e.verify(), { state: "incomplete", reasons: ["B5_PHONE_EVIDENCE_MISSING"] });
  await e.write(); await writeFile(join(e.dir, "screens/03-question.png"), "changed");
  assert.equal(await e.refusal(), "B5_ARTIFACT_BYTES", "B5 changed retained bytes are refused");
  await e.write(v => { v.manifest.artifacts = []; }); assert.equal(await e.refusal(), "B5_MANIFEST_INVALID");
  await e.write(v => { v.manifest.classification = { ...(v.manifest.classification as object), engine: "fixture" }; });
  assert.equal(await e.refusal(), "B5_MANIFEST_INVALID", "B5 a fixture engine classification never satisfies the real schema");
  await e.write(); assert.equal(await e.refusal({ readCard: async () => null }), "B5_CARD_UNAVAILABLE", "B5 no service card is never complete");
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
test("B5 verifier re-reads the candidate repository and its page facts", async t => {
  await load();
  const e = await evidenceSet(t);
  await e.write(); await writeFile(join(e.p.project, "notes.txt"), "untracked");
  assert.equal(await e.refusal(), "B5_CANDIDATE_REPOSITORY", "B5 dirty candidate repository is refused");
  await rm(join(e.p.project, "notes.txt")); assert.equal(await e.refusal(), "complete");
  await writeFile(join(e.p.project, "index.html"), (await readFile(join(e.p.project, "index.html"), "utf8")).replace(' role="status"', ""));
  await git(e.p.project, ["commit", "--quiet", "-am", "Later change"]);
  assert.equal(await e.refusal(), "B5_CANDIDATE_REPOSITORY", "B5 a moved candidate HEAD is refused");
  await git(e.p.project, ["reset", "--quiet", "--hard", e.p.final]); assert.equal(await e.refusal(), "complete");
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
  const dir = join(await owned(t, "b5-forged-"), "evidence"); await mkdir(dir);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, kind: "b5-first-website-proof", state: "finished", source: "SYNTHETIC" }));
  await assert.rejects(H.verifyFirstWebsiteEvidenceV1(dir, { readCard: async () => published, candidateRepository: resolve("."),
    pins: { toolingRevision: H.b5Bytes("qualified A2 tooling"), schemaDigest: H.b5Bytes("schema"), productBase: "1".repeat(40), productHead: "2".repeat(40), uid: 501,
      digests: { settings: "", availability: "", authorization: "", qualification: "", assembly: "", faultInput: "", reviewInput: "" } } }),
  (e: unknown) => e instanceof H.B5RefusalV1 && e.code === "B5_MANIFEST_INVALID");
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
  await assert.rejects(mutate(requestId, "confirm", { ...confirm, requestSha256: "0".repeat(64) }, "b5-c-confirm-stale1"), "B5 a changed request is stale at confirmation");
  await assert.rejects(mutate(requestId, "confirm", { ...confirm, settingsSha256: "0".repeat(64) }, "b5-c-confirm-stale2"), "B5 changed settings are stale at confirmation");
  await assert.rejects(mutate(requestId, "start", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId }, "b5-c-start-early01"),
    "B5 Start before the exact confirmation is refused");
  assert.equal(f.calls.filter(c => c === "start" || c === "confirm").length, 0, "B5 refused admissions reach no engine command");
  await mutate(requestId, "confirm", confirm, "b5-c-confirm-00001"); s = await current();
  const start = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId };
  await mutate(requestId, "start", start, "b5-c-start-000001");
  await assert.rejects(mutate(requestId, "start", start, "b5-c-start-000002"), "B5 a second Start under another key is refused");
  await mutate(requestId, "start", start, "b5-c-start-000001"); // the reply was lost; the exact retry replays
  assert.equal(f.calls.filter(c => c === "start").length, 1, "B5 duplicate Start and lost-reply retry consume once");
  assert.equal(await f.tick(), "question"); s = await current();
  const q = f.question, answer = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, questionId: q.questionId,
    inputVersion: q.inputVersion, questionReportSha256: q.reportSha256, text: "Amber." };
  await assert.rejects(mutate(requestId, "answer", { ...answer, inputVersion: "SYNTHETIC:0" }, "b5-c-answer-input01"), "B5 an answer for another input version is refused");
  await assert.rejects(mutate(requestId, "answer", { ...answer, questionReportSha256: "f".repeat(64) }, "b5-c-answer-report1"), "B5 an answer for another question report is refused");
  // Reads and two owned restarts while waiting are read-only.
  const calls = f.calls.length, launches = f.launches();
  await f.restart(); await current(); await f.bridge.readAttention(f.identity); await f.restart(); s = await current();
  assert.equal(f.calls.length, calls); assert.equal(f.launches(), launches); assert.equal(f.restarts(), 2);
  // Stop while waiting, then the saved question can no longer be answered.
  await mutate(requestId, "stop", { runLinkId }, "b5-c-stop-0000001");
  assert.equal(f.status()!.state, "stopped"); assert.equal(await f.tick(), "stopped", "B5 a stopped run does not advance");
  s = await current();
  await assert.rejects(mutate(requestId, "answer", { ...answer, expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision }, "b5-c-answer-stop01"),
    "B5 an answer after Stop is refused");
  assert.equal(f.calls.filter(c => c === "answer").length, 0); assert.equal(f.launches(), launches, "B5 Stop launches no worker");
  assert.equal((await f.desk.viewLoopDesk(f.identity, project)).loopRequests.length, 1, "B5 one saved request throughout");
});
