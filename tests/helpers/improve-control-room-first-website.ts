// B5 first website proof: strict real-proof configuration, preflight, the
// disposable proof-site fixture, the independently executed diagnostic and the
// retained-evidence verifier. Imports are inert: nothing here opens a listener,
// database, browser or process until a caller invokes it. This helper never
// selects a role or model; A2 and the qualified lineup do.
import { B5DeviceRefusalV1, assertB5DeviceSignalCleanupV1, loadB5TransportV1, validateB5DeviceOriginV1 } from "../../scripts/workflow-journeys/first-website-device";
import type { B5DeviceMailboxV1 } from "../../scripts/workflow-journeys/first-website-device";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loopCandidateCardSchemaV1, type LoopCandidateCardV1 } from "../../src/improve-control-room/v1/loop-candidate-wire";
const exec = promisify(execFile);
const GIT_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

/** Spec reservations (SPEC-B5-v4); preflight probes them, it never kills an owner. */
export const B5_PORTS = Object.freeze({ product: 60460, preview: 60461, postgresBase: 60470, postgresCount: 10 });
/** Live-install listeners (3210/3211/3310/3311/7864) and the lead's own listener (39473),
 * which the lead brief names as off limits. B5 never connects to or stops them. */
export const B5_PROTECTED_PORTS = Object.freeze([3210, 3211, 3310, 3311, 7864, 39473]);
export const B5_REQUEST_TEXT = "Add a visible Ready status badge to this page, with id=status and role=status. Use amber or teal; ask me which before choosing. Preserve the page title. Change only index.html.";
export const B5_MAX_DURATION_MS = 14_400_000;
export const B5_ASSEMBLY_EXPORT = "createFirstWebsiteHostV1";
export const B5_RECIPES = Object.freeze([
  { id: "site-smoke", argv: ["node", "--test", "tests/site-smoke.test.mjs"], parser: "node-tap", required: true },
  { id: "site-status", argv: ["node", "--test", "tests/site-status.test.mjs"], parser: "node-tap", required: false },
] as const);
export const B5_REQUIRED_RISK = Object.freeze({ categories: ["code", "owner_visible", "ci"], slots: ["attack-review", "ui-review", "ci-review"] } as const);

/** Prerequisite 7: the two scoped stimuli, bound through A2's landed `cr bind-input`
 * after intake and before confirmation/Start. Never a run.json edit or project.skills. */
export const B5_INPUT_BINDINGS = Object.freeze([
  { name: "b5-builder-fault", input: "faultInput", roles: ["build"] },
  { name: "b5-review-instruction", input: "reviewInput", roles: ["code-review"] },
] as const);

export class B5RefusalV1 extends Error {
  constructor(readonly code: string, readonly detail = "") { super(code); }
}
const refuse = (code: string, detail = ""): never => { throw new B5RefusalV1(code, detail); };

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const absolute = z.string().min(2).max(1024).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/u.test(value));
/** Check 8 strict configuration. Unknown keys refuse. Trusted lead config only. */
export const firstWebsiteConfigSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  product: z.object({ root: absolute, baseRevision: revision, candidateRevision: revision, assetsDigest: sha256 }).strict(),
  a2: z.object({ contractFile: absolute, toolingRevision: sha256, schemaDigest: sha256, qualificationEvidence: absolute }).strict(),
  assembly: z.object({ module: absolute, digest: sha256 }).strict(),
  scratchRoot: absolute,
  ports: z.object({ product: z.number().int(), preview: z.number().int(), postgresBase: z.number().int() }).strict(),
  device: z.object({ origin: z.string().url().max(512), transportQualification: absolute, actor: z.literal("owner") }).strict(),
  settingsFile: absolute, availabilityFile: absolute, authorizationEvidence: absolute,
  requestText: z.string().min(1).max(4096), faultInputFile: absolute, reviewInputFile: absolute,
  maxDurationMs: z.number().int().positive().max(B5_MAX_DURATION_MS).default(B5_MAX_DURATION_MS),
}).strict();
export type FirstWebsiteConfigV1 = z.infer<typeof firstWebsiteConfigSchemaV1>;

// Structural proof contract for the real Mac-local composition.
export type FirstWebsiteStartedRuntimeV1 = { isReady(): boolean; close(): Promise<void> };
/** The landed private A2 entry wrapper the assembly's adapter already uses (same
 * interpreter/entrypoint/cwd and confined roots). B5 runs only `bind-input` through it. */
export type FirstWebsiteA2EntryV1 = { interpreter: string; entrypoint: string; cwd: string };
export type FirstWebsiteHostV1 = {
  readonly startup: FirstWebsiteStartedRuntimeV1; // getter follows an owned restart
  origin: string; // exact loopback assembly origin, separate from device.origin
  a2Entry: FirstWebsiteA2EntryV1;
  proof: FirstWebsiteProofV1;
  close(): Promise<void>; // idempotent, drains/reaps every assembly-owned resource
};
export type FirstWebsiteCleanupOwnerV1 = {
  /** Registered before PG acquisition. Closes serving resources without waiting
   * for the caller's own removal receipt or PG shutdown. */
  registerCloseHost(close: () => Promise<void>): void;
  cleanup(): Promise<unknown>;
};
export type CreateFirstWebsiteHostV1 = (config: Readonly<FirstWebsiteConfigV1>, signal: AbortSignal,
  hooks?: { signalOwner?: FirstWebsiteCleanupOwnerV1 }) => Promise<FirstWebsiteHostV1>;
export type FirstWebsiteOwnedV1 = {
  processCount: number; listenerReleased: boolean; postgresStopped: boolean;
  runScratchAbsent: boolean;
};
export type FirstWebsiteProofV1 = {
  readonly device?: B5DeviceMailboxV1;
  /** Owner-only local delivery channel. No HTTP route or persisted code. */
  withOwnerCode<T>(use: (code: string) => Promise<T>): Promise<T>;
  project: Readonly<{ projectId: string; repository: string; baseRevision: string }>;
  readRun(loopRunId: string): Promise<
    Awaited<ReturnType<typeof import("./improve-control-room-first-website-a2").projectB5RunV1>> |
    Awaited<ReturnType<typeof import("./improve-control-room-first-website-a2").joinB5FinalProjectionV1>>>;
  restart(signal: AbortSignal): Promise<void>;
  readSnapshot(): Promise<{ schemaVersion: 1; readAt: string; rows: { table: typeof B5_SNAPSHOT_TABLES[number]; sha256: string; row: Record<string, unknown> }[] }>;
  inspectOwned(): Promise<FirstWebsiteOwnedV1>;
};

/** The outer owner waits for late acquisition rather than abandoning resources.
 * The factory must observe the signal; even a late successful factory is closed
 * before this call settles. A cleanup rejection is retained, including on abort.
 */
export async function withFirstWebsiteHostV1<T>(config: Readonly<FirstWebsiteConfigV1>, signal: AbortSignal,
  body: (host: FirstWebsiteHostV1) => Promise<T>, factory?: CreateFirstWebsiteHostV1): Promise<T> {
  signal.throwIfAborted();
  const create = factory ?? await loadFirstWebsiteAssemblyV1(config);
  signal.throwIfAborted();
  let host: FirstWebsiteHostV1 | undefined, closing: Promise<void> | undefined;
  let value!: T;
  const close = () => closing ??= Promise.resolve().then(() => host?.close());
  const aborted = () => { if (host) void close().catch(() => {}); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    host = await create(config, signal);
    signal.throwIfAborted();
    value = await body(host);
    signal.throwIfAborted();
  } finally {
    try { await close(); } finally { signal.removeEventListener("abort", aborted); }
  }
  signal.throwIfAborted();
  return value;
}


export const b5Bytes = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const credential = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.aws|\.codex|\.hermes|\.ssh|\.gnupg|\.netrc|\.pgpass|auth\.json|credentials?(?:\.[^/\\]*)?|tokens?(?:\.[^/\\]*)?|keychains?|secrets?(?:\.[^/\\]*)?)(?:[/\\]|$)/iu;
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
/** Canonical, non-symlink, noncredential path; every ancestor is checked. */
async function canonical(path: string, kind: "file" | "directory", code: string) {
  if (!isAbsolute(path) || resolve(path) !== path || credential.test(path)) refuse(code, "path");
  for (let part = path; ; part = dirname(part)) {
    const stat = await lstat(part).catch(() => refuse(code, "missing"));
    if (stat.isSymbolicLink()) refuse(code, "symlink");
    if (part === dirname(part)) break;
  }
  if (await realpath(path) !== path) refuse(code, "alias");
  const stat = await lstat(path);
  if (kind === "file" ? !stat.isFile() || stat.size > 1 << 20 : !stat.isDirectory()) refuse(code, kind);
  return stat;
}
async function portFree(port: number) {
  return new Promise<boolean>(done => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => done(true)));
  });
}

export type FirstWebsitePreflightV1 = { config: FirstWebsiteConfigV1; uid: number; evidenceDir: string;
  digests: Record<string, string>; settings: { riskCategories: string[]; riskSlots: string[] }; phoneTransport: "tailscale-serve" | "loopback-only" };
/** Everything is validated before any import, resource creation or A2 call. Read-only
 * except for transient loopback bind probes of the reserved ports. */
export async function preflightFirstWebsiteV1(input: { configFile: string; evidenceDir: string; cliFile: string;
  uid?: number; probe?: (port: number) => Promise<boolean>; signalOwner?: FirstWebsiteCleanupOwnerV1 }): Promise<FirstWebsitePreflightV1> {
  const uid = input.uid ?? process.getuid?.() ?? refuse("B5_EXECUTION_IDENTITY_UNAVAILABLE");
  await canonical(input.configFile, "file", "B5_CONFIG_PATH");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(input.configFile, "utf8")); } catch { refuse("B5_CONFIG_INVALID", "json"); }
  const parsed = firstWebsiteConfigSchemaV1.safeParse(raw);
  if (!parsed.success) refuse("B5_CONFIG_INVALID", parsed.error.issues.map(issue => issue.path.join(".")).join(","));
  const config = parsed.data!;
  if (config.requestText !== B5_REQUEST_TEXT) refuse("B5_REQUEST_TEXT_CHANGED");
  // Scratch root: unique, owned, non-Git, and the only home of every disposable input.
  const root = config.scratchRoot, rootStat = await canonical(root, "directory", "B5_SCRATCH_ROOT");
  if (!/^acr-b5-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(root.slice(dirname(root).length + 1))) refuse("B5_SCRATCH_ROOT", "name");
  if (rootStat.uid !== uid) refuse("B5_EXECUTION_IDENTITY_MISMATCH", "scratch owner");
  if (await lstat(join(root, ".git")).then(() => true, () => false)) refuse("B5_SCRATCH_ROOT", "git");
  const evidenceDir = join(root, "evidence");
  if (input.evidenceDir !== evidenceDir) refuse("B5_EVIDENCE_DIR", "must be <scratchRoot>/evidence");
  if (await lstat(evidenceDir).then(() => true, () => false)) {
    await canonical(evidenceDir, "directory", "B5_EVIDENCE_DIR");
    if ((await readdir(evidenceDir)).length) refuse("B5_EVIDENCE_DIR", "not empty");
  }
  if (config.assembly.module !== join(root, "config", "first-website-host.mjs")) refuse("B5_ASSEMBLY_MODULE", "location");
  const digests: Record<string, string> = {};
  const files = { assembly: config.assembly.module, contract: config.a2.contractFile, qualification: config.a2.qualificationEvidence,
    settings: config.settingsFile, availability: config.availabilityFile, authorization: config.authorizationEvidence,
    transport: config.device.transportQualification, faultInput: config.faultInputFile, reviewInput: config.reviewInputFile } as const;
  for (const [name, file] of Object.entries(files)) {
    if (!inside(root, file)) refuse("B5_CONFINEMENT", name);
    const stat = await canonical(file, "file", "B5_INPUT_FILE");
    if (stat.uid !== uid) refuse("B5_EXECUTION_IDENTITY_MISMATCH", name);
    digests[name] = b5Bytes(await readFile(file));
  }
  const loopback = config.device.origin === "http://127.0.0.1:60460";
  if (!loopback) {
    try {
      validateB5DeviceOriginV1(config.device.origin);
      await loadB5TransportV1(config.device.transportQualification, root, config.device.origin, digests.transport);
      assertB5DeviceSignalCleanupV1({ signalOwner: input.signalOwner ? "caller" : "helper", cleanup: input.signalOwner?.cleanup });
      if (typeof input.signalOwner?.registerCloseHost !== "function") refuse("B5_DEVICE_SIGNAL_CLEANUP_UNQUALIFIED");
    } catch (error) { if (error instanceof B5DeviceRefusalV1) refuse(error.code); throw error; }
  }
  if (digests.assembly !== config.assembly.digest) refuse("B5_ASSEMBLY_DIGEST");
  if (digests.faultInput === digests.reviewInput) refuse("B5_ROLE_INPUTS", "fault and review inputs must differ");
  // Saved risk policy: categories and the configured attack/UI/CI slots, never a model roster.
  let settings: { project?: { risk_categories?: unknown; test_checks?: unknown }; roles?: { risk_reviews?: unknown; code_reviews?: unknown } };
  try { settings = JSON.parse(await readFile(config.settingsFile, "utf8")); } catch { refuse("B5_SETTINGS_INVALID", "json"); }
  const categories = settings!.project?.risk_categories, slots = settings!.roles?.risk_reviews, checks = settings!.project?.test_checks;
  if (!Array.isArray(categories) || !B5_REQUIRED_RISK.categories.every(name => categories.includes(name))) refuse("B5_RISK_CATEGORIES");
  const slotRoles = Array.isArray(slots) ? slots.map(slot => (slot as { role?: unknown })?.role) : [];
  if (!B5_REQUIRED_RISK.slots.every(role => slotRoles.includes(role))) refuse("B5_RISK_SLOTS");
  if (!Array.isArray(settings!.roles?.code_reviews) || settings!.roles!.code_reviews.length !== 2) refuse("B5_CODE_REVIEW_SLOTS");
  for (const recipe of B5_RECIPES) {
    const check = Array.isArray(checks) ? checks.find(item => (item as { id?: unknown })?.id === recipe.id) : undefined;
    if (JSON.stringify(check) !== JSON.stringify(recipe)) refuse("B5_RECIPE_MISMATCH", recipe.id);
  }
  // Product: the reviewed disposable checkout is clean, at the pinned candidate, descended from BASE, and runs this CLI.
  await canonical(config.product.root, "directory", "B5_PRODUCT_ROOT");
  if (!inside(config.product.root, input.cliFile)) refuse("B5_PRODUCT_ROOT", "cli outside product checkout");
  const git = (args: string[]) => exec("/usr/bin/git", ["-C", config.product.root, "-c", "core.fsmonitor=false", ...args],
    { encoding: "utf8", timeout: 30_000, env: GIT_ENV });
  const head = (await git(["rev-parse", "HEAD"]).catch(() => refuse("B5_PRODUCT_REVISION"))).stdout.trim();
  if (head !== config.product.candidateRevision) refuse("B5_PRODUCT_REVISION", "head");
  await git(["merge-base", "--is-ancestor", config.product.baseRevision, head]).catch(() => refuse("B5_PRODUCT_REVISION", "base"));
  if ((await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") refuse("B5_PRODUCT_DIRTY");
  // Ports: exactly the spec reservations, never a protected port, free at preflight.
  const ports = [config.ports.product, config.ports.preview, ...Array.from({ length: B5_PORTS.postgresCount }, (_, i) => config.ports.postgresBase + i)];
  if (config.ports.product !== B5_PORTS.product || config.ports.preview !== B5_PORTS.preview || config.ports.postgresBase !== B5_PORTS.postgresBase
    || ports.some(port => B5_PROTECTED_PORTS.includes(port))) refuse("B5_PORT_RESERVATION");
  for (const port of ports) if (!await (input.probe ?? portFree)(port)) refuse("B5_PORT_BUSY", String(port));
  return { config, uid, evidenceDir, digests, settings: { riskCategories: categories as string[], riskSlots: slotRoles as string[] },
    phoneTransport: loopback ? "loopback-only" : "tailscale-serve" };
}

// ---------- disposable proof site (runtime-generated only in scratch) ----------
export const B5_BASELINE_INDEX = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Proof site</title></head>
<body>
<main><h1>Proof site</h1><p>A small page for the first website proof.</p></main>
</body>
</html>
`;
const SITE_SMOKE = `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
test("page keeps its original title", () => {
  assert.match(html, /<title>Proof site<\\/title>/u);
});
test("page shows a visible Ready element", () => {
  const tag = /<([a-z][a-z0-9]*)\\b([^>]*\\bid="status"[^>]*)>([^<]*)</iu.exec(html);
  assert.ok(tag, "an element with id=status exists");
  assert.match(tag[3], /\\bReady\\b/u, "the status element says Ready");
  assert.doesNotMatch(tag[2], /\\bhidden\\b|display:\\s*none|visibility:\\s*hidden/iu, "the status element is visible");
});
`;
const SITE_STATUS = `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
test("status element announces itself with role=status", () => {
  const tag = /<([a-z][a-z0-9]*)\\b([^>]*\\bid="status"[^>]*)>/iu.exec(html);
  assert.ok(tag, "an element with id=status exists");
  assert.match(tag[2], /\\brole="status"/u, "status element has role=status");
});
`;
export const B5_PROTECTED_TESTS = Object.freeze({ "tests/site-smoke.test.mjs": SITE_SMOKE, "tests/site-status.test.mjs": SITE_STATUS });
export const b5ProtectedTestsDigest = (files: Readonly<Record<string, string | Uint8Array>>) =>
  b5Bytes(JSON.stringify(Object.keys(B5_PROTECTED_TESTS).map(name => [name, b5Bytes(files[name] ?? "")])));
/** One baseline commit, no remote, protected tests seeded and pinned before Start. */
export async function seedProofSiteV1(project: string) {
  await mkdir(join(project, "tests"), { recursive: true });
  await writeFile(join(project, "index.html"), B5_BASELINE_INDEX, { flag: "wx" });
  for (const [name, text] of Object.entries(B5_PROTECTED_TESTS)) await writeFile(join(project, name), text, { flag: "wx" });
  const git = (args: string[]) => exec("/usr/bin/git", ["-C", project, "-c", "user.name=Proof fixture", "-c", "user.email=proof@localhost",
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
  { encoding: "utf8", timeout: 30_000, env: GIT_ENV });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["add", "index.html", ...Object.keys(B5_PROTECTED_TESTS)]);
  await git(["commit", "--quiet", "-m", "Proof site baseline"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if ((await git(["remote"])).stdout.trim() !== "") refuse("B5_PROJECT_REMOTE");
  return { head, protectedTestsDigest: await readProtectedTestsDigest(project) };
}
export async function readProtectedTestsDigest(project: string) {
  const files: Record<string, Uint8Array> = {};
  for (const name of Object.keys(B5_PROTECTED_TESTS)) { await canonical(join(project, name), "file", "B5_PROTECTED_TEST"); files[name] = await readFile(join(project, name)); }
  return b5ProtectedTestsDigest(files);
}

// ---------- independently executed diagnostic (B5 evidence, never an A2 receipt) ----------
export const b5StatusCheckRecordSchemaV1 = z.object({
  label: z.literal("B5 independent diagnostic evidence; not an A2 receipt"), recipe: z.literal("site-status"),
  argv: z.tuple([z.literal("node"), z.literal("--test"), z.literal("tests/site-status.test.mjs")]),
  head: revision, protectedTestsDigest: sha256, startedAt: z.string().datetime(), endedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(), exitCode: z.number().int(),
  completed: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(), outputPath: z.string().min(1).max(256), outputSha256: sha256,
}).strict();
export type B5StatusCheckRecordV1 = z.infer<typeof b5StatusCheckRecordSchemaV1>;
export function parseNodeTestCounts(output: string) {
  const count = (name: string) => { const m = new RegExp(`^# ${name} (\\d+)$`, "mu").exec(output); return m ? Number(m[1]) : -1; };
  return { completed: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
}
export async function runIndependentStatusCheckV1(project: string, outputPath: string, node = process.execPath): Promise<{ record: B5StatusCheckRecordV1; output: string }> {
  const head = (await exec("/usr/bin/git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 30_000,
    env: GIT_ENV })).stdout.trim();
  const protectedTestsDigest = await readProtectedTestsDigest(project);
  const started = Date.now();
  const result = await exec(node, ["--test", "tests/site-status.test.mjs"], { cwd: project, encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 20,
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } })
    .then(value => ({ exitCode: 0, output: value.stdout + value.stderr }),
      (error: { code?: unknown; stdout?: string; stderr?: string }) => {
        if (typeof error.code !== "number") throw new B5RefusalV1("B5_DIAGNOSTIC_NOT_EXECUTED");
        return { exitCode: error.code, output: String(error.stdout ?? "") + String(error.stderr ?? "") };
      });
  const ended = Date.now(), counts = parseNodeTestCounts(result.output);
  if (Object.values(counts).some(value => value < 0)) refuse("B5_DIAGNOSTIC_UNPARSED");
  return { output: result.output, record: b5StatusCheckRecordSchemaV1.parse({ label: "B5 independent diagnostic evidence; not an A2 receipt",
    recipe: "site-status", argv: ["node", "--test", "tests/site-status.test.mjs"], head, protectedTestsDigest,
    startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: ended - started,
    exitCode: result.exitCode, ...counts, outputPath, outputSha256: b5Bytes(result.output) }) };
}

// ---------- role-scoped supplied inputs through A2's landed `cr bind-input` ----------
/** The receipt `cr bind-input --json` returns (tools loop/README.md "Role-scoped supplied inputs"). */
export const b5BindInputReceiptSchemaV1 = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/u), index: z.number().int().nonnegative(), path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative(), roles: z.array(z.string().min(1)).min(1),
  source: z.string().min(1).max(4096), at: z.string().min(1), input_version: z.union([z.string().min(1), z.number().int().positive()]),
  revision: z.number().int().positive(), invalidated: z.array(z.string()), replaces: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).passthrough();
export type B5BindInputReceiptV1 = z.infer<typeof b5BindInputReceiptSchemaV1>;
const B5_A2_OUTPUT_LIMIT = 1 << 20;
/** Runs one A2 entry command with the adapter's positive environment allowlist: no
 * inherited service or sibling credentials, no HOME/PATH, no shell. */
export async function runA2EntryV1(entry: FirstWebsiteA2EntryV1, args: readonly string[], timeoutMs = 60_000) {
  return new Promise<{ code: number | null; stdout: string }>((done, fail) => {
    const child = spawn(entry.interpreter, [entry.entrypoint, ...args], { cwd: entry.cwd, shell: false,
      env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = []; let bytes = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > B5_A2_OUTPUT_LIMIT) { failed = true; child.kill("SIGKILL"); } else output.push(chunk); });
    child.stderr.on("data", () => {});
    child.on("error", () => { failed = true; });
    child.on("close", code => { clearTimeout(timer);
      if (failed) fail(new B5RefusalV1("B5_A2_ENTRY_FAILED")); else done({ code, stdout: Buffer.concat(output).toString("utf8") }); });
  });
}
/** Before intake: the landed writer exists at the qualified entry and takes the documented options. */
export async function probeBindInputCapabilityV1(entry: FirstWebsiteA2EntryV1) {
  const help = await runA2EntryV1(entry, ["bind-input", "--help"]);
  if (help.code !== 0 || !["--file", "--role", "--json"].every(option => help.stdout.includes(option))) refuse("B5_A2_BIND_INPUT_UNAVAILABLE");
}
/** After intake allocated `loopRunId` and before confirmation/Start: stage each scoped input's
 * exact preflight bytes inside the confined A2 work root, bind it through `cr bind-input`, and
 * check the returned receipt and the read-only bound copy. Any mismatch is a refusal; nothing
 * edits engine state directly. Returns the receipts for the manifest. */
export async function bindFirstWebsiteInputsV1(input: { entry: FirstWebsiteA2EntryV1; loopRunId: string; stageDir: string;
  files: Readonly<Record<"faultInput" | "reviewInput", string>>; digests: Readonly<Record<string, string>>; runWorkDir: string }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(input.loopRunId)) refuse("B5_INPUT_BINDING", "run");
  await mkdir(input.stageDir, { recursive: false, mode: 0o700 }).catch(() => refuse("B5_INPUT_BINDING", "stage exists"));
  const receipts: B5BindInputReceiptV1[] = [];
  for (const binding of B5_INPUT_BINDINGS) {
    const bytes = await readFile(input.files[binding.input]);
    if (b5Bytes(bytes) !== input.digests[binding.input]) refuse("B5_INPUT_CHANGED", binding.input);
    const staged = join(input.stageDir, `${binding.name}.md`);
    await writeFile(staged, bytes, { flag: "wx", mode: 0o400 });
    const result = await runA2EntryV1(input.entry, ["bind-input", input.loopRunId, binding.name, "--file", staged,
      ...binding.roles.flatMap(role => ["--role", role]), "--json"]);
    let envelope: { receipt?: unknown; error?: unknown };
    try { envelope = JSON.parse(result.stdout) as typeof envelope; } catch { return refuse("B5_INPUT_BINDING_REFUSED", binding.name); }
    if (result.code !== 0) refuse("B5_INPUT_BINDING_REFUSED", `${binding.name}:${typeof envelope.error === "string" ? envelope.error : "unknown"}`);
    const parsed = b5BindInputReceiptSchemaV1.safeParse(envelope.receipt);
    if (!parsed.success) refuse("B5_INPUT_BINDING_RECEIPT", binding.name);
    const receipt = parsed.data!, sha = input.digests[binding.input]!.slice("sha256:".length);
    if (receipt.name !== binding.name || JSON.stringify(receipt.roles) !== JSON.stringify(binding.roles) || receipt.sha256 !== sha
      || receipt.size !== bytes.length || receipt.source !== staged || receipt.replaces !== null || !inside(input.runWorkDir, receipt.path))
      refuse("B5_INPUT_BINDING_RECEIPT", binding.name);
    // Bound before owner confirmation: the binding may invalidate an --expect, never a confirmation.
    if (receipt.invalidated.includes("confirmation")) refuse("B5_INPUT_BINDING_LATE", binding.name);
    if (receipts.length && receipt.revision <= receipts.at(-1)!.revision) refuse("B5_INPUT_BINDING_RECEIPT", "revision");
    await canonical(receipt.path, "file", "B5_INPUT_BINDING_COPY");
    if (b5Bytes(await readFile(receipt.path)) !== input.digests[binding.input] || ((await lstat(receipt.path)).mode & 0o222) !== 0)
      refuse("B5_INPUT_BINDING_COPY", binding.name);
    receipts.push(receipt);
  }
  return receipts;
}
/** After dispatch: each generated brief carries A2's "Additional supplied input (read in full)"
 * line for a bound copy, with its pinned SHA-256, exactly when its role is in that binding's
 * roles. Build sees only the fault; both code reviews see only the neutral instruction; every
 * other role sees neither. Reports quoted inside a brief are not that line. */
export function assertRoleScopedBriefsV1(briefs: readonly { role: string; text: string }[], receipts: readonly B5BindInputReceiptV1[]) {
  if (briefs.filter(b => b.role === "build").length < 1 || briefs.filter(b => b.role === "code-review").length < 2) refuse("B5_BRIEF_SCOPE", "briefs");
  for (const brief of briefs) for (const receipt of receipts) {
    const line = `Additional supplied input (read in full): ${receipt.path} (SHA256 ${receipt.sha256})`;
    const named = brief.text.split("\n").filter(text => text === line).length;
    if (named !== (receipt.roles.includes(brief.role) ? 1 : 0)) refuse("B5_BRIEF_SCOPE", `${brief.role}:${receipt.name}`);
  }
}

// ---------- retained evidence verifier ----------
const at = z.string().datetime();
const real = z.literal("real");
export const B5_REQUIRED_ARTIFACTS = Object.freeze(["journey.json", "database-snapshot.json", "independent-status-check.json", "teardown.json",
  "screens/01-prepare.png", "screens/02-confirm-start.png", "screens/03-question.png", "screens/04-plan.png", "screens/05-spec.png",
  "screens/06-repair.png", "screens/07-finish-phone.png", "screens/08-finish-desktop.png", "screens/09-retained.png"]);
const bindingRecord = z.object({ name: z.enum(["b5-builder-fault", "b5-review-instruction"]), roles: z.array(z.string().min(1)).min(1),
  sha256, path: z.string().min(1).max(4096), revision: z.number().int().positive(), at, receiptDigest: sha256 }).strict();
export const b5ManifestSchemaV1 = z.object({
  schemaVersion: z.literal(1), kind: z.literal("b5-first-website-proof"),
  product: z.object({ baseRevision: revision, headRevision: revision, environmentDigest: sha256 }).strict(),
  // jobSandboxDigest is recorded for the reviewer; no independent source exists for the verifier to compare it with.
  pins: z.object({ a2ToolingRevision: sha256, schemaDigest: sha256, jobSandboxDigest: sha256, qualificationDigest: sha256, recipeDigest: sha256,
    settingsSha256: sha256, availabilitySha256: sha256, faultInputSha256: sha256, reviewInputSha256: sha256, authorizationSha256: sha256,
    assemblyDigest: sha256, assemblyExport: z.literal(B5_ASSEMBLY_EXPORT), inputBindings: z.array(bindingRecord).length(2) }).strict(),
  risk: z.object({ categories: z.array(z.string()), slots: z.array(z.string()) }).strict(),
  launch: z.object({ uid: z.number().int().nonnegative(), context: z.literal("current-session"), isolationClaim: z.literal("none"),
    consumedRoots: z.array(z.string().min(1)).min(1) }).strict(),
  lineage: z.object({ requestId: z.string().min(1), runLinkId: z.string().min(1), loopRunId: z.string().min(1), localVersion: z.number().int().positive(),
    a2InputVersion: z.union([z.string(), z.number()]) }).strict(),
  heads: z.object({ base: revision, rejected: revision, final: revision }).strict(),
  classification: z.object({ website: real, storage: real, engine: real, sendBack: real, recovery: real, finish: real,
    device: z.enum(["real", "fixture"]), stimuli: z.literal("fixture") }).strict(),
  timestamps: z.object({ startedAt: at, finishedAt: at }).strict(),
  artifacts: z.array(z.object({ path: z.string().min(1).max(256), sha256, bytes: z.number().int().nonnegative() }).strict()).min(1),
}).strict();
type B5ManifestV1 = z.infer<typeof b5ManifestSchemaV1>;
const step = z.object({ n: z.number().int().positive(), role: z.string().min(1), identity: z.string().min(1), family: z.string().min(1),
  verified: z.boolean(), head: revision, startedAt: at, endedAt: at, verdict: z.enum(["DONE", "CLEAN", "NEEDS-FIX"]).nullable(),
  findings: z.array(z.object({ severity: z.enum(["HIGH", "MEDIUM", "LOW"]), state: z.enum(["open", "fixed"]), summary: z.string() }).strict()),
  diagnostic: z.enum(["PASS", "FAIL"]).nullable() }).strict();
export const B5_DOM_SCREENS = Object.freeze(["07-finish-phone", "08-finish-desktop", "09-retained"] as const);
export const b5JourneySchemaV1 = z.object({
  schemaVersion: z.literal(1),
  actions: z.array(z.object({ name: z.string().min(1), device: z.enum(["phone", "desktop"]), at, method: z.enum(["GET", "POST"]),
    path: z.string().min(1), status: z.number().int() }).strict()).min(1),
  closed: z.array(z.object({ label: z.string().min(1), from: at, to: at }).strict()).min(2),
  steps: z.array(step).min(1),
  // Facts read from the rendered finish card's DOM on each device and after the owned restart.
  dom: z.array(z.object({ screen: z.enum(B5_DOM_SCREENS), candidateRevision: revision, baseRevision: revision, requestId: z.string().min(1) }).strict()).min(3),
  devices: z.array(z.object({ kind: z.enum(["phone", "desktop"]), real: z.boolean(), browser: z.string().min(1) }).strict()).min(1),
}).strict();
type B5JourneyV1 = z.infer<typeof b5JourneySchemaV1>;
export const b5TeardownSchemaV1 = z.object({
  schemaVersion: z.literal(1), b3cCleanup: z.enum(["complete", "refused", "uncertain", "missing"]), scratchAbsent: z.boolean(),
  ownedProcesses: z.number().int().nonnegative(), ownedListenersReleased: z.boolean(), protectedListenersUntouched: z.boolean(),
  postgresStopped: z.boolean(), cleanupAt: at,
  retainedRead: z.object({ at, candidateRevision: revision, receiptDigest: sha256 }).strict().nullable(),
}).strict();
type B5TeardownV1 = z.infer<typeof b5TeardownSchemaV1>;
/** Signed companion/candidate rows read through the service login after cleanup. Session,
 * credential and key tables are not listed, so they can never be retained here. */
export const B5_SNAPSHOT_TABLES = Object.freeze(["control_loop_improvement_requests", "control_loop_improvement_inputs", "control_loop_improvement_run_links",
  "control_loop_improvement_authorizations", "control_loop_improvement_commands", "control_loop_update_candidates"] as const);
export const b5DatabaseSnapshotSchemaV1 = z.object({ schemaVersion: z.literal(1), readAt: at,
  rows: z.array(z.object({ table: z.enum(B5_SNAPSHOT_TABLES), sha256, row: z.record(z.string(), z.unknown()) }).strict()).min(3) }).strict();
type B5SnapshotV1 = z.infer<typeof b5DatabaseSnapshotSchemaV1>;
/** The qualified pins preflight validated from the lead's configuration, never read from the manifest. */
export type B5QualifiedPinsV1 = { toolingRevision: string; schemaDigest: string; productBase: string; productHead: string; uid: number;
  digests: Readonly<Record<"settings" | "availability" | "authorization" | "qualification" | "assembly" | "faultInput" | "reviewInput", string>> };
export type B5VerdictV1 = { state: "complete" | "incomplete"; reasons: string[] };

const ms = (value: string) => Date.parse(value);
/** (a) The main chain is real. Provenance is structural: the card the real service returned
 * names the engine that produced it, and that tooling revision must be the qualified pin;
 * the retained signed rows must be that card's own rows; every verified review on the card
 * must be a journey step. A SYNTHETIC engine's card carries its own tooling revision. */
export function assertRealChainV1(manifest: B5ManifestV1, card: LoopCandidateCardV1, snapshot: B5SnapshotV1, journey: B5JourneyV1, pins: B5QualifiedPinsV1) {
  const b = card.evidence.binding;
  if (b.toolingRevision !== pins.toolingRevision) refuse("B5_FIXTURE_NOT_REAL", "card tooling");
  if (manifest.pins.a2ToolingRevision !== pins.toolingRevision || manifest.pins.schemaDigest !== pins.schemaDigest) refuse("B5_FIXTURE_NOT_REAL", "manifest pins");
  const row = (table: string, id: string) => snapshot.rows.find(r => r.table === table && r.row.id === id)?.row;
  const candidate = row("control_loop_update_candidates", card.candidateId);
  if (!candidate || candidate.record_digest !== card.recordDigest || candidate.candidate_revision !== card.candidateRevision
    || candidate.request_id !== card.requestId || candidate.run_link_id !== b.runLinkId) refuse("B5_FIXTURE_NOT_REAL", "snapshot candidate");
  if (!row("control_loop_improvement_requests", card.requestId) || !row("control_loop_improvement_run_links", b.runLinkId)) refuse("B5_FIXTURE_NOT_REAL", "snapshot lineage");
  for (const review of card.evidence.reviews) {
    if (!review.identityVerified || !journey.steps.some(s => s.verified && s.role === review.role && s.head === review.candidateRevision
      && s.family === review.family && s.identity === review.observedModel && s.verdict === review.verdict)) refuse("B5_FIXTURE_NOT_REAL", `review ${review.stepId}`);
  }
}
/** The manifest's recorded pins equal what preflight qualified and what the card binds. */
export function assertManifestPinsV1(manifest: B5ManifestV1, card: LoopCandidateCardV1, journey: B5JourneyV1, pins: B5QualifiedPinsV1) {
  const p = manifest.pins, d = pins.digests, b = card.evidence.binding, bad = (why: string) => refuse("B5_MANIFEST_PINS", why);
  if (manifest.product.baseRevision !== pins.productBase || manifest.product.headRevision !== pins.productHead) bad("product");
  if (p.settingsSha256 !== d.settings || p.availabilitySha256 !== d.availability || p.authorizationSha256 !== d.authorization
    || p.qualificationDigest !== d.qualification || p.assemblyDigest !== d.assembly || p.faultInputSha256 !== d.faultInput || p.reviewInputSha256 !== d.reviewInput) bad("inputs");
  if (p.recipeDigest !== b.recipeDigest || manifest.product.environmentDigest !== b.environmentDigest) bad("card binding");
  if (!B5_REQUIRED_RISK.categories.every(c => manifest.risk.categories.includes(c)) || !B5_REQUIRED_RISK.slots.every(s => manifest.risk.slots.includes(s))) bad("risk");
  if (manifest.launch.uid !== pins.uid) bad("uid");
  if (manifest.lineage.loopRunId !== b.loopRunId || manifest.lineage.localVersion !== card.localVersion || manifest.lineage.a2InputVersion !== card.a2InputVersion) bad("lineage");
  const confirm = journey.actions.filter(a => a.method === "POST" && /\/improvements\/loop\/[^/]+\/confirm$/u.test(a.path)).map(a => ms(a.at));
  if (!confirm.length) bad("confirmation");
  for (const binding of B5_INPUT_BINDINGS) {
    const r = p.inputBindings.find(x => x.name === binding.name);
    if (!r || JSON.stringify(r.roles) !== JSON.stringify(binding.roles) || r.sha256 !== d[binding.input] || ms(r.at) >= Math.min(...confirm)) bad(`binding ${binding.name}`);
  }
}
/** (b) Rejected/final heads, the finish-card DOM, the card's checks and every artifact byte bind to the saved card. */
export function assertHeadsAndBytesV1(manifest: B5ManifestV1, checks: B5StatusCheckRecordV1[], outputs: ReadonlyMap<string, Uint8Array>,
  card: LoopCandidateCardV1, journey: B5JourneyV1) {
  const { base, rejected, final } = manifest.heads, b = card.evidence.binding;
  if (card.candidateRevision !== final) refuse("B5_HEAD_BINDING", "card head");
  if (new Set([base, rejected, final]).size !== 3 || b.baseRevision !== base
    || manifest.lineage.requestId !== card.requestId || manifest.lineage.runLinkId !== b.runLinkId) refuse("B5_HEAD_BINDING", "card");
  const failed = checks.find(check => check.head === rejected), passed = checks.find(check => check.head === final);
  if (!failed || !passed || checks.length !== 2) refuse("B5_HEAD_BINDING", "diagnostic heads");
  if (failed!.exitCode === 0 || failed!.failed < 1 || passed!.exitCode !== 0 || passed!.completed < 1 || passed!.passed !== passed!.completed
    || passed!.failed !== 0 || passed!.skipped !== 0 || failed!.protectedTestsDigest !== passed!.protectedTestsDigest
    || ms(failed!.endedAt) > ms(passed!.startedAt)) refuse("B5_HEAD_BINDING", "diagnostic results");
  for (const screen of B5_DOM_SCREENS) {
    const dom = journey.dom.find(x => x.screen === screen);
    if (!dom || dom.candidateRevision !== card.candidateRevision || dom.baseRevision !== base || dom.requestId !== card.requestId) refuse("B5_HEAD_BINDING", `dom ${screen}`);
  }
  // The card's required recipe really ran at the final head; the diagnostic stays labelled optional.
  const smoke = card.evidence.checks.find(c => c.id === "site-smoke"), status = card.evidence.checks.find(c => c.id === "site-status");
  if (!smoke || !smoke.required || smoke.status !== "PASS" || smoke.candidateRevision !== card.candidateRevision || smoke.completed < 1 || smoke.failed !== 0
    || smoke.skipped !== 0 || status?.required !== false) refuse("B5_HEAD_BINDING", "card checks");
  for (const check of checks) if (b5Bytes(outputs.get(check.outputPath) ?? "") !== check.outputSha256) refuse("B5_ARTIFACT_BYTES", check.outputPath);
}
const statusTag = (html: string) => /<([a-z][a-z0-9]*)\b([^>]*\bid="status"[^>]*)>([^<]*)</iu.exec(html);
/** Facts read independently from the retained candidate repository. */
export async function readCandidateRepositoryV1(repository: string, heads: B5ManifestV1["heads"]) {
  await canonical(repository, "directory", "B5_CANDIDATE_REPOSITORY");
  const git = (args: string[]) => exec("/usr/bin/git", ["-C", repository, "-c", "core.fsmonitor=false", ...args],
    { encoding: "utf8", timeout: 30_000, env: GIT_ENV, maxBuffer: 4 << 20 }).then(r => r.stdout, () => refuse("B5_CANDIDATE_REPOSITORY", args[0]));
  const ancestor = (a: string, b: string) => exec("/usr/bin/git", ["-C", repository, "merge-base", "--is-ancestor", a, b],
    { encoding: "utf8", timeout: 30_000, env: GIT_ENV }).then(() => true, () => false);
  const protectedDigest = async (rev: string) => b5ProtectedTestsDigest(Object.fromEntries(await Promise.all(
    Object.keys(B5_PROTECTED_TESTS).map(async name => [name, await git(["show", `${rev}:${name}`])]))));
  return { head: (await git(["rev-parse", "HEAD"])).trim(), clean: await git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    ancestry: await ancestor(heads.base, heads.rejected) && await ancestor(heads.rejected, heads.final),
    changed: (await git(["diff", "--name-only", heads.base, heads.final])).split("\n").filter(Boolean),
    pages: { rejected: await git(["show", `${heads.rejected}:index.html`]), final: await git(["show", `${heads.final}:index.html`]) },
    protectedTests: [await protectedDigest(heads.base), await protectedDigest(heads.rejected), await protectedDigest(heads.final)] };
}
/** (b) continued: final repository HEAD and clean tracked/untracked state equal the card's
 * candidate; only index.html changed; protected tests untouched at every head; the rejected
 * page really lacked role=status and the final page really carries it. */
export function assertCandidateRepositoryV1(facts: Awaited<ReturnType<typeof readCandidateRepositoryV1>>, manifest: B5ManifestV1,
  checks: B5StatusCheckRecordV1[], card: LoopCandidateCardV1) {
  const bad = (why: string) => refuse("B5_CANDIDATE_REPOSITORY", why);
  if (facts.head !== card.candidateRevision || facts.head !== manifest.heads.final || !facts.clean) bad("head");
  if (!facts.ancestry) bad("ancestry");
  if (JSON.stringify(facts.changed) !== JSON.stringify(["index.html"]) || card.evidence.changedAreas && !card.evidence.changedAreas.includes("index.html")) bad("changed paths");
  if (new Set(facts.protectedTests).size !== 1 || checks.some(check => check.protectedTestsDigest !== facts.protectedTests[0])) bad("protected tests");
  const rejected = statusTag(facts.pages.rejected), final = statusTag(facts.pages.final);
  const title = (html: string) => /<title>Proof site<\/title>/u.test(html);
  if (!title(facts.pages.rejected) || !rejected || !/\bReady\b/u.test(rejected[3]!) || /\brole="status"/u.test(rejected[2]!)) bad("rejected page");
  if (!title(facts.pages.final) || !final || !/\bReady\b/u.test(final[3]!) || !/\brole="status"/u.test(final[2]!)) bad("final page");
}
/** (c) Real reviewer rejection while the browser was closed, original-builder repair, fresh reviews. */
export function assertRejectionRepairV1(manifest: B5ManifestV1, journey: B5JourneyV1) {
  const { rejected, final } = manifest.heads, steps = [...journey.steps].sort((a, b) => a.n - b.n);
  const closed = (s: z.infer<typeof step>) => journey.closed.some(c => ms(c.from) <= ms(s.startedAt) && ms(s.endedAt) <= ms(c.to));
  const broken = (why: string) => refuse("B5_REJECTION_REPAIR", why);
  const defective = steps.find(s => s.role === "build" && s.head === rejected);
  const rejection = steps.find(s => s.role === "code-review" && s.head === rejected && s.verdict === "NEEDS-FIX" && s.diagnostic === "FAIL"
    && s.findings.some(f => f.severity === "MEDIUM"));
  if (!defective || !rejection || rejection.n < defective.n || rejection.family === defective.family || !rejection.verified) broken("rejection");
  const repair = steps.find(s => s.role === "build" && s.n > rejection!.n && s.head === final);
  if (!repair || repair.identity !== defective!.identity || repair.family !== defective!.family) broken("original builder repair");
  const after = steps.filter(s => s.n > repair!.n);
  const fresh = (role: string) => after.filter(s => s.role === role && s.head === final && s.verdict === "CLEAN" && s.verified && s.family !== repair!.family);
  const codes = fresh("code-review");
  if (codes.length < 2 || new Set(codes.map(s => s.family)).size < 2 || codes.some(s => s.diagnostic !== "PASS")) broken("fresh code reviews");
  for (const role of ["attack-review", "ui-review", "ci-review", "final"]) if (!fresh(role).length) broken(`fresh ${role}`);
  const reviewed = [defective!, rejection!, repair!, ...codes];
  if (!reviewed.every(closed)) broken("steps outside a closed-browser interval");
  for (let i = 1; i < steps.length; i++) if (ms(steps[i]!.startedAt) < ms(steps[i - 1]!.endedAt)) broken("chronology");
  if (steps.some(s => s.findings.some(f => (f.severity === "HIGH" || f.severity === "MEDIUM") && f.state === "open") && s.n > repair!.n)) broken("open finding");
}
/** (d) Full B3c-2 cleanup, then the same immutable candidate read back from the retained corpus. */
export function assertCleanupRetainedV1(teardown: B5TeardownV1, card: LoopCandidateCardV1, snapshot: B5SnapshotV1, finishedAt: string) {
  if (teardown.b3cCleanup !== "complete" || !teardown.scratchAbsent || teardown.ownedProcesses !== 0 || !teardown.ownedListenersReleased
    || !teardown.protectedListenersUntouched || !teardown.postgresStopped) refuse("B5_CLEANUP_RETAINED", "cleanup");
  if (!teardown.retainedRead || teardown.retainedRead.candidateRevision !== card.candidateRevision || teardown.retainedRead.receiptDigest !== card.recordDigest
    || ms(teardown.retainedRead.at) < ms(teardown.cleanupAt) || ms(snapshot.readAt) < ms(teardown.cleanupAt) || ms(teardown.cleanupAt) > ms(finishedAt))
    refuse("B5_CLEANUP_RETAINED", "retained read");
}
/** Reopens and hashes the retained bytes, reads the card through the real service (the
 * caller's `readCard` is that HTTP read), re-reads the candidate repository and compares
 * DOM/candidate facts independently. Refuses any changed, missing, stale or fixture-provenance
 * proof. Missing real phone evidence is INCOMPLETE, never a skip. */
export async function verifyFirstWebsiteEvidenceV1(evidenceDir: string, input: { readCard: () => Promise<unknown>; candidateRepository: string;
  pins: B5QualifiedPinsV1 }): Promise<B5VerdictV1> {
  const load = async (path: string) => {
    if (!/^[a-z0-9][a-z0-9./-]{0,255}$/u.test(path) || path.includes("..") || !inside(evidenceDir, join(evidenceDir, path))) refuse("B5_ARTIFACT_BYTES", "path");
    await canonical(join(evidenceDir, path), "file", "B5_ARTIFACT_BYTES");
    return readFile(join(evidenceDir, path));
  };
  const json = <T>(schema: z.ZodType<T>, bytes: Uint8Array, code: string) => {
    try { return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))); } catch { return refuse(code); }
  };
  const manifest = json(b5ManifestSchemaV1, await load("manifest.json"), "B5_MANIFEST_INVALID");
  const artifacts = new Map<string, Uint8Array>();
  for (const entry of manifest.artifacts) {
    const bytes = await load(entry.path);
    if (b5Bytes(bytes) !== entry.sha256 || bytes.length !== entry.bytes || artifacts.has(entry.path)) refuse("B5_ARTIFACT_BYTES", entry.path);
    artifacts.set(entry.path, bytes);
  }
  for (const path of B5_REQUIRED_ARTIFACTS) if (!artifacts.has(path)) refuse("B5_ARTIFACT_MISSING", path);
  const checks = json(z.array(b5StatusCheckRecordSchemaV1), artifacts.get("independent-status-check.json")!, "B5_DIAGNOSTIC_INVALID");
  for (const check of checks) if (!artifacts.has(check.outputPath)) refuse("B5_ARTIFACT_MISSING", check.outputPath);
  const journey = json(b5JourneySchemaV1, artifacts.get("journey.json")!, "B5_JOURNEY_INVALID");
  const teardown = json(b5TeardownSchemaV1, artifacts.get("teardown.json")!, "B5_TEARDOWN_INVALID");
  const snapshot = json(b5DatabaseSnapshotSchemaV1, artifacts.get("database-snapshot.json")!, "B5_SNAPSHOT_INVALID");
  for (const entry of snapshot.rows) if (b5Bytes(JSON.stringify(entry.row)) !== entry.sha256) refuse("B5_SNAPSHOT_INVALID", entry.table);
  const read = loopCandidateCardSchemaV1.safeParse(await input.readCard());
  if (!read.success) refuse("B5_CARD_UNAVAILABLE");
  const card = read.data!;
  assertHeadsAndBytesV1(manifest, checks, artifacts, card, journey);
  assertRealChainV1(manifest, card, snapshot, journey, input.pins);
  assertManifestPinsV1(manifest, card, journey, input.pins);
  assertCandidateRepositoryV1(await readCandidateRepositoryV1(input.candidateRepository, manifest.heads), manifest, checks, card);
  assertRejectionRepairV1(manifest, journey);
  assertCleanupRetainedV1(teardown, card, snapshot, manifest.timestamps.finishedAt);
  const reasons: string[] = [];
  if (manifest.classification.device !== "real" || !journey.devices.some(d => d.kind === "phone" && d.real)) reasons.push("B5_PHONE_EVIDENCE_MISSING");
  if (!journey.devices.some(d => d.kind === "desktop" && d.real)) reasons.push("B5_DESKTOP_EVIDENCE_MISSING");
  return { state: reasons.length ? "incomplete" : "complete", reasons };
}

// ---------- SYNTHETIC companion host (fixture lanes only; never the real chain) ----------
/** Real product desk/bridge/publisher over the caller's database, with a labelled
 * SYNTHETIC engine. The test (or browser spec) calls `tick()` at each gate to stand in for
 * the engine's progress while the browser is closed; there is no scan loop. What this proves
 * is that the real client only reads while saved state moves. Its PASS is not real B5. */
export async function syntheticFirstWebsiteEngineV1(input: { client: import("../../src/persistence/database").DatabaseClient;
  scope: { tenantId: string; workspaceId: string }; projectId: string; clock: () => number; heads?: { base: string; rejected: string; final: string } }) {
  const { ImproveControlRoomDeskServiceV1 } = await import("../../src/improve-control-room/v1/service");
  const { ImproveControlRoomLoopServiceV1 } = await import("../../src/web/v1/improve-control-room-loop-service");
  const { LoopCandidatePublisherV1, LoopCandidateStaleCompletionV1 } = await import("../../src/improve-control-room/v1/loop-candidate-publisher");
  const { loopByteHashV1 } = await import("../../src/web/v1/improve-control-room-loop-adapter");
  const { loopCandidateEvidenceSchemaV1 } = await import("../../src/improve-control-room/v1/loop-candidate-wire");
  const { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1 } = await import("../../src/improve-control-room/v1/schemas");
  const { sha256Digest } = await import("../../src/security");
  type Status = import("../../src/web/v1/improve-control-room-loop-adapter").LoopEngineStatusV1;
  type Adapter = import("../../src/web/v1/improve-control-room-loop-adapter").LoopAdapterV1;
  const { scope, clock } = input, now = clock(), f = { client: input.client, project: { projectId: input.projectId } };
  const KEY = new Uint8Array(32).fill(64);
  const toolingRevision = sha256Digest({ fixture: "SYNTHETIC B5 tooling" }), schemaDigest = sha256Digest({ fixture: "SYNTHETIC B5 schema" });
  const settingsText = JSON.stringify({ fixture: "SYNTHETIC B5", project: { risk_categories: B5_REQUIRED_RISK.categories, test_checks: B5_RECIPES } });
  const contract = { toolingRevision, decodeRunIdentity: (v: unknown) => loopImprovementRunIdentitySchemaV1.parse(v),
    decodeObservation: (v: unknown) => loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput: (_r: unknown, o: { settingsDigest: string; confirmation: { sha256: string } }, i: { description: string; settingsText: string }) =>
      o.settingsDigest === loopByteHashV1(i.settingsText) && o.confirmation.sha256 === loopByteHashV1(i.description) };
  const { base, rejected, final } = input.heads ?? { base: "a".repeat(40), rejected: "c".repeat(40), final: "d".repeat(40) };
  const question = { questionId: "question:b5-colour", inputVersion: "SYNTHETIC:1", reportSha256: "e".repeat(64), owner: true, changesInput: false };
  const questionText = "SYNTHETIC plan question: amber or teal for the Ready badge?";
  const documents = { plan: "SYNTHETIC complete sealed plan.\nUse amber, as answered.\n", spec: "SYNTHETIC complete sealed spec.\nOnly index.html changes.\n" };
  let saved: Status | undefined, phase = "none", sequence = 0, launches = 0, answer: string | null = null;
  const calls: string[] = [], steps: { n: number; role: string; head: string; verdict: string | null }[] = [];
  const snapshot = (): Status => structuredClone({ ...saved!, decisions: { observedAt: new Date(now).toISOString(), gate:
    ["stopped", "finished"].includes(saved!.state) ? null : saved!.question ? { kind: "question" as const, text: questionText }
      : saved!.approval ? { kind: "approve" as const } : !saved!.confirmation ? { kind: "confirm" as const } : null } });
  const command = async (op: string, id: string, b: import("../../src/improve-control-room/v1/schemas").LoopBridgeBindingV1, text?: string) => {
    calls.push(op);
    if (op === "intake") saved = { run: { adapterId: "adapter:synthetic-b5", loopRunId: b.loopRunId, toolingRevision, a2SchemaVersion: 1 },
      revision: 1, inputVersion: "SYNTHETIC:1", state: "draft", description: text!, settingsSha256: loopByteHashV1(settingsText), settingsDigest: loopByteHashV1(settingsText),
      confirmation: null, approval: null, question: null, progress: { step: "1", completed: 0, attention: "none" }, receipts: [] };
    else {
      saved!.revision++;
      if (op === "confirm") { saved!.confirmation = { path: "request.md", sha256: loopByteHashV1(saved!.description), at: new Date(now).toISOString(), who: "owner", input_version: saved!.inputVersion }; saved!.state = "ready"; }
      if (op === "start") { saved!.state = "running"; phase = "started"; }
      if (op === "stop") { saved!.state = "stopped"; phase = "stopped"; }
      if (op === "approve") { phase = `${saved!.approval!.step}-approved`; saved!.approval = null; saved!.state = "running"; }
      if (op === "answer") { answer = text!; saved!.question = null; saved!.state = "running"; phase = "answered"; }
    }
    saved!.receipts.push({ commandId: id, bindingDigest: sha256Digest(b), state: "accepted", error: null, evidenceDigest: sha256Digest({ op, id }) });
    return snapshot();
  };
  const adapter: Adapter = { adapterId: "adapter:synthetic-b5", toolingRevision, schemaDigest, settingsText, contract,
    available: () => true, reserveRun: () => `synthetic-run:b5-${++sequence}`,
    intake: (id, b, text) => command("intake", id, b, text), confirmRequest: (id, b) => command("confirm", id, b), start: (id, b) => command("start", id, b),
    stop: (id, b) => command("stop", id, b), approve: (id, b) => command("approve", id, b), answer: (id, b, text) => command("answer", id, b, text),
    status: async () => snapshot(), readApprovalDocument: async (_run, d) => documents[d.step as "plan" | "spec"], close: async () => {} };
  const lineage = async () => (await f.client.query<{ request_id: string; id: string }>(
    "SELECT request_id,id FROM control_loop_improvement_run_links ORDER BY created_at DESC LIMIT 1")).rows[0]!;
  const d = sha256Digest({ fixture: "SYNTHETIC B5 evidence" }), startedAt = new Date(now - 60_000).toISOString(), endedAt = new Date(now).toISOString();
  const evidence = async () => {
    const link = await lineage();
    const check = (id: string, required: boolean) => ({ id, required, commandLabel: `SYNTHETIC ${id}`, receiptDigest: d, outputDigest: d, candidateRevision: final,
      status: "PASS", exitCode: 0, completed: 1, passed: 1, failed: 0, skipped: 0, durationMs: 60_000, startedAt, endedAt });
    const review = (stepId: string, role: string, family: string, current = true) => ({ current, stepId, role, attempt: current ? 2 : 1,
      requestedModel: `SYNTHETIC ${role}`, observedModel: `SYNTHETIC ${role}`, identityVerified: true, family, verdict: current ? "CLEAN" : "NEEDS-FIX",
      candidateRevision: current ? final : rejected, inputVersion: saved!.inputVersion, reportDigest: d, sidecarDigest: d, startedAt, endedAt });
    return loopCandidateEvidenceSchemaV1.parse({ schemaVersion: 1,
      binding: { projectId: f.project.projectId, requestId: link.request_id, runLinkId: link.id, localVersion: 1, ...saved!.run,
        a2InputVersion: saved!.inputVersion, engineRevision: saved!.revision, requestSha256: loopByteHashV1(saved!.description), settingsSha256: loopByteHashV1(settingsText),
        baseRevision: base, candidateRevision: final, inputsDigest: d, recipeDigest: d, environmentDigest: d },
      summary: "SYNTHETIC Ready status badge", changedAreas: ["index.html"], databaseChanges: { kind: "none" },
      checks: [check("site-smoke", true), check("site-status", false)],
      reviews: [review("review:code-1", "code-review", "synthetic-a"), review("review:code-2", "code-review", "synthetic-b"),
        review("review:attack", "attack-review", "synthetic-a"), review("review:ui", "ui-review", "synthetic-b"),
        review("review:ci", "ci-review", "synthetic-a"), review("review:final", "final", "synthetic-c"),
        review("review:code-1-old", "code-review", "synthetic-a", false)],
      findings: [{ origin: "review:code-1-old", id: "finding:role-status", severity: "MEDIUM", disposition: "FIXED",
        summary: "SYNTHETIC status element lacked role=status; site-status diagnostic FAIL before repair", evidenceDigest: d }],
      rounds: { attempts: 2, reviewRejections: 1, repairs: 1, redesigns: 0 }, timing: { startedAt, finishedAt: endedAt, durationMs: 60_000 },
      assumptions: [{ id: "assumption:colour", text: "SYNTHETIC owner chose amber", status: "validated", evidenceDigest: d }],
      validations: [{ id: "validation:status", text: "SYNTHETIC site-status PASS at final head", status: "PASS", evidenceDigest: d }],
      overrides: { allowSameFamilyReview: false, allowStandardFinal: false, waivedConflicts: [], fallback: null }, completionDigest: d, retentionDigest: d });
  };
  const source = { toolingRevision, schemaDigest, readVerifiedCompletion: async () => {
    if (saved?.state !== "finished") throw new LoopCandidateStaleCompletionV1(); return evidence(); } };
  const repository = { observe: async () => ({ baseRevision: base, candidateRevision: final, changedPaths: ["index.html"], addedPaths: [], commitSubjects: ["SYNTHETIC Ready badge"] }) };
  const config = { integrityKey: KEY, contract, schemaDigest, source, repository };
  const desk = new ImproveControlRoomDeskServiceV1(f.client, scope, KEY, undefined, clock, contract, config);
  const publisher = new LoopCandidatePublisherV1(desk, config);
  const openBridge = () => new ImproveControlRoomLoopServiceV1(f.client, scope, { integrityKey: KEY, adapter, loopCandidates: config }, clock);
  const step = (role: string, head: string, verdict: string | null) => { launches++; steps.push({ n: steps.length + 1, role, head, verdict }); };
  /** One fixture progress step, called by the test. It advances saved engine state only when the run is not waiting on the owner. */
  const tick = async () => {
    if (!saved || saved.state !== "running") return phase;
    if (phase === "started") { step("plan", base, null); saved.state = "waiting"; saved.revision++; saved.question = question; phase = "question"; }
    else if (phase === "answered") { step("plan", base, "DONE"); step("plan-review", base, "CLEAN"); saved.state = "waiting"; saved.revision++;
      saved.approval = { step: "plan", inputVersion: saved.inputVersion, head: base, reportSha256: loopByteHashV1(documents.plan) }; phase = "plan-waiting"; }
    else if (phase === "plan-approved") { step("spec", base, "DONE"); step("spec-review", base, "CLEAN"); saved.state = "waiting"; saved.revision++;
      saved.approval = { step: "spec", inputVersion: saved.inputVersion, head: base, reportSha256: loopByteHashV1(documents.spec) }; phase = "spec-waiting"; }
    else if (phase === "spec-approved") {
      step("build", rejected, "DONE"); step("code-review", rejected, "NEEDS-FIX"); step("build", final, "DONE");
      for (const role of ["code-review", "code-review", "attack-review", "ui-review", "ci-review", "final"]) step(role, final, "CLEAN");
      saved.state = "finished"; saved.revision++; saved.progress = { step: String(steps.length + 1), completed: steps.length, attention: "none" }; phase = "finished";
    }
    return phase;
  };
  return { KEY, scope, adapter, desk, publisher, config, calls, steps, documents, question, questionText, heads: { base, rejected, final }, openBridge,
    tick, phase: () => phase, launches: () => launches, answer: () => answer, status: () => saved && snapshot(), lineage,
    publish: async () => publisher.publishCompletion({ runLinkId: (await lineage()).id, completionDigest: (await evidence()).completionDigest }) };
}
/** Drives the SYNTHETIC engine through the real bridge as the saved owner, with scan
 * ticks standing in for the closed-browser intervals. Returns the saved ids. */
export async function driveSyntheticFirstWebsiteV1(e: Awaited<ReturnType<typeof syntheticFirstWebsiteEngineV1>>,
  bridge: import("../../src/web/v1/improve-control-room-loop-service").ImproveControlRoomLoopServiceV1,
  identity: import("../../src/web/v1/access-verifier").VerifiedWebIdentity, projectId: string, prefix = "b5-drive") {
  await bridge.mutate(identity, projectId, null, "intake", { description: B5_REQUEST_TEXT }, `${prefix}-intake-0001`);
  const desk = await e.desk.viewLoopDesk(identity, projectId), saved = desk.loopRequests.find(r => r.runLink?.loopRunId === e.status()?.run.loopRunId)!;
  const requestId = saved.requestId, runLinkId = saved.runLink!.runLinkId, current = () => bridge.status(identity, projectId, requestId);
  let s = await current();
  await bridge.mutate(identity, projectId, requestId, "confirm", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
    requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 }, `${prefix}-confirm-0001`);
  s = await current();
  await bridge.mutate(identity, projectId, requestId, "start", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId }, `${prefix}-start-0001`);
  await e.tick(); s = await current();
  await bridge.mutate(identity, projectId, requestId, "answer", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
    questionId: e.question.questionId, inputVersion: e.question.inputVersion, questionReportSha256: e.question.reportSha256, text: "Amber." }, `${prefix}-answer-0001`);
  for (const step of ["plan", "spec"] as const) {
    await e.tick(); s = await current(); const a = e.status()!.approval!;
    await bridge.mutate(identity, projectId, requestId, "approve", { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision,
      step, inputVersion: a.inputVersion, head: a.head, reportSha256: a.reportSha256 }, `${prefix}-approve-${step}-0001`);
  }
  await e.tick();
  return { requestId, runLinkId };
}
/** The PGlite web fixture plus a real web process over the SYNTHETIC engine. */
export async function syntheticFirstWebsiteFixtureV1(options: { dataDir?: string; heads?: { base: string; rejected: string; final: string } } = {}) {
  const { taskFixture, taskFixtureOnDisk } = await import("./web-task");
  const { now, origin, trust } = await import("./web-foundation");
  const { createPrivateWebProcess } = await import("../../src/web/v1/private-process");
  const f = options.dataDir ? await taskFixtureOnDisk(options.dataDir) : await taskFixture();
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  const e = await syntheticFirstWebsiteEngineV1({ client: f.client, scope, projectId: f.project.projectId, clock: () => now, heads: options.heads });
  const open = () => ({ bridge: e.openBridge(), app: createPrivateWebProcess({ origin, ...trust, ...scope, loadKeys: async () => trust.keys, clock: () => now,
    database: { client: f.client, close: async () => {} }, loopBridge: { integrityKey: e.KEY, adapter: e.adapter, loopCandidates: e.config } }) });
  let service = open(), restarts = 0;
  return { ...f, ...e, get bridge() { return service.bridge; }, get app() { return service.app; },
    handle: (r: Request) => service.app.handle(r, () => new Response("unused", { status: 404 })), restarts: () => restarts,
    /** Restart only this owned service host; the database and saved engine state remain. */
    restart: async () => { await service.app.close(); await service.bridge.close(); service = open(); restarts++; },
    close: async () => { await service.app.close(); await service.bridge.close(); await f.db.close(); } };
}

/** Re-hashes the private assembly module immediately before import and requires the
 * named export. Import happens only after preflight; no default or fixture fallback. */
export async function loadFirstWebsiteAssemblyV1(config: Readonly<FirstWebsiteConfigV1>): Promise<CreateFirstWebsiteHostV1> {
  if (config.assembly.module !== join(config.scratchRoot, "config", "first-website-host.mjs")) refuse("B5_ASSEMBLY_MODULE", "location");
  await canonical(config.assembly.module, "file", "B5_ASSEMBLY_MODULE");
  if (b5Bytes(await readFile(config.assembly.module)) !== config.assembly.digest) refuse("B5_ASSEMBLY_DIGEST");
  const { pathToFileURL } = await import("node:url");
  const module = await import(pathToFileURL(config.assembly.module).href) as Record<string, unknown>;
  const create = module[B5_ASSEMBLY_EXPORT];
  if (typeof create !== "function") refuse("B5_ASSEMBLY_EXPORT");
  return create as CreateFirstWebsiteHostV1;
}
