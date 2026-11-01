// Proof-only, inert Mac-local assembly with qualified device origin gates.
// No installation discovery, transport command, intake or provider launch.
import { assertB5DeviceSignalCleanupV1, B5DeviceRefusalV1, createB5DeviceMailboxV1, loadB5TransportV1, b5DeviceRemoteOriginsV1 } from "./first-website-device";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { z } from "zod";
import { macLocalBuildSourceV1, captureMacLocalBuildSourceV1 } from "../mac-local/build-source.mjs";
import { parseProductConfigurationV1 } from "../../src/config/v1/product-configuration";
import { buildProjectPresentationV1 } from "../../src/config/v1/project-presentation";
import { sha256Digest } from "../../src/security";
import { parseStrictJsonV1 } from "../../src/installer/shared/strict-json.mjs";
import { databaseSqlStateV1 } from "../../src/persistence/database";
import { loopBridgeBindingSchemaV1, loopImprovementStatusSchemaV1 } from "../../src/improve-control-room/v1/schemas";
import { loopFinalizationTargetSchemaV1 } from "../../src/web/v1/improve-control-room-loop-finalization";
import { ImproveControlRoomDeskServiceV1 } from "../../src/improve-control-room/v1/service";
import { createMacLocalWebProcessV1 } from "../../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../../src/web/v1/local-owner-session";
import { bindPrivatePgPool } from "../../src/web/v1/private-pg-database";
import { privatePgOptions } from "../../src/web/v1/private-pg-options";
import { createMacLocalNodeService } from "../../src/web/v1/private-serving";
import { loadPrivateClientAssets } from "../../src/web/v1/private-assets";
import { ImproveControlRoomLoopServiceV1, type LoopBridgeConfigurationV1 } from "../../src/web/v1/improve-control-room-loop-service";
import type { LoopAdapterConfigurationV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomLoopRecoveryV1 } from "../../src/web/v1/improve-control-room-loop-recovery";
import { createPipelineAdvanceCycleV1 } from "../../src/web/v1/private-task-startup";
import { withRealPostgres, type RealPostgres } from "../../tests/support/attack-kit/real-postgres";
import { loadB5A2V1, projectB5RunV1, joinB5FinalProjectionV1, b5RawHash } from "../../tests/helpers/improve-control-room-first-website-a2";
import { B5RefusalV1, B5_PORTS, B5_REQUEST_TEXT, B5_SNAPSHOT_TABLES, b5Bytes, firstWebsiteConfigSchemaV1,
  preflightFirstWebsiteV1, probeBindInputCapabilityV1, withFirstWebsiteHostV1,
  type FirstWebsiteConfigV1, type FirstWebsiteHostV1 } from "../../tests/helpers/improve-control-room-first-website";

const exec = promisify(execFile);
const origin = "http://127.0.0.1:60460";
const assemblyWrapper = 'export { createFirstWebsiteHostV1 } from "../product/scripts/workflow-journeys/first-website-host.ts";\n';
const scope = Object.freeze({ tenantId: "tenant:b5", workspaceId: "workspace:b5" });
const manualAdapterId = `adapter:manual:${sha256Digest(scope).slice(7, 39)}`;
const projectId = "project:b5-website", ownerId = "identity:b5-owner", provider = "b5-local";
function need(value: unknown, code: string): asserts value { if (!value) throw new B5RefusalV1(code); }
const inside = (root: string, file: string) => { const r = relative(root, file); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const credential = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.codex|\.hermes|\.aws|\.ssh|\.gnupg|\.netrc|\.pgpass|auth\.json|tokens?(?:\.[^/\\]*)?|credentials?(?:\.[^/\\]*)?|passwords?|keychains?|secrets?(?:\.[^/\\]*)?)(?:[/\\]|$)/iu;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const handoffSchema = z.object({ schemaVersion: z.literal(1), scope: z.enum(["assembly-only", "provider-device"]),
  productPin: revision, toolsPin: revision, baseline: revision, hashes: z.record(z.string(), digest),
  pythonSha256: digest, nodeSha256: digest, validation: z.unknown(),
  nativeIntakeQualified: z.literal(false), providerDeviceCertified: z.literal(false) }).strict();

async function regular(file: string, root: string, directory = false, cap = 4 << 20) {
  need(isAbsolute(file) && resolve(file) === file && !credential.test(file) && (file === root || inside(root, file)), "B5_HOST_PATH");
  for (let p = file;; p = dirname(p)) {
    const s = await lstat(p);
    need(!s.isSymbolicLink(), "B5_HOST_PATH");
    if (p === dirname(p)) break;
  }
  need(await realpath(file) === file, "B5_HOST_PATH");
  const s = await lstat(file);
  need(s.uid === process.getuid?.() && !(s.mode & 0o022) && (directory ? s.isDirectory() : s.isFile() && s.size <= cap), "B5_HOST_CUSTODY");
  return s;
}
async function json(file: string, root: string) {
  await regular(file, root);
  return parseStrictJsonV1(await readFile(file, "utf8"), { maxBytes: 1 << 20 });
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// The owner code remains in memory and is available only to a trusted local Node
// caller, never a route, argument, receipt or diagnostic. This callback is also
// the native browser's ordinary sign-in channel; it issues no session itself.
export async function withFirstWebsiteOwnerCodeV1<T>(host: FirstWebsiteHostV1, use: (code: string) => Promise<T>) {
  return host.proof.withOwnerCode(use);
}

/** Read-only packet checks finish before PG, listeners or recovery acquisition. */
export async function validateFirstWebsiteHostV1(input: Readonly<FirstWebsiteConfigV1> | undefined,
  signalOwner?: import("../../tests/helpers/improve-control-room-first-website").FirstWebsiteCleanupOwnerV1) {
  need(input, "B5_A2_QUALIFICATION_REQUIRED");
  const config = firstWebsiteConfigSchemaV1.parse(input), root = config.scratchRoot;
  const st = await regular(root, root, true);
  need((st.mode & 0o077) === 0, "B5_HOST_CUSTODY");
  need(config.product.root === join(root, "product") && config.a2.contractFile === join(root, "config/contract-cleanup.json"), "B5_HOST_LAYOUT");
  need(config.ports.product === B5_PORTS.product && config.ports.preview === B5_PORTS.preview
    && config.ports.postgresBase === B5_PORTS.postgresBase, "B5_PORT_RESERVATION");

  const preflight = await preflightFirstWebsiteV1({ configFile: join(root, "config/b5.json"),
    evidenceDir: join(root, "evidence"), cliFile: join(config.product.root, "scripts/workflow-journeys/first-website-proof.ts"), signalOwner });
  need(JSON.stringify(preflight.config) === JSON.stringify(config), "B5_HOST_CONFIG_CHANGED");
  const transport = config.device.origin === origin ? undefined : await loadB5TransportV1(
    config.device.transportQualification, root, config.device.origin, preflight.digests.transport);
  const handoff = handoffSchema.parse(await json(join(root, "config/b5-handoff.json"), root));
  for (const [name, hash] of Object.entries(handoff.hashes)) {
    const file = join(root, name); await regular(file, root);
    need(b5RawHash(await readFile(file)) === hash, "B5_HOST_FROZEN_INPUT");
  }
  await validateNode(root, handoff.nodeSha256);
  for (const file of [config.a2.contractFile, config.settingsFile, config.availabilityFile,
    config.authorizationEvidence, config.a2.qualificationEvidence, config.faultInputFile, config.reviewInputFile])
    need(handoff.hashes[relative(root, file)], "B5_HOST_FROZEN_INPUT");
  need(!(await lstat(join(root, "config/i1/real-jobs-enabled")).then(() => true, () => false)), "B5_HOST_LAUNCHER_ENABLED");
  need(config.product.candidateRevision === handoff.productPin, "B5_HOST_PRODUCT_PIN");
  need(await readFile(config.assembly.module, "utf8") === assemblyWrapper, "B5_HOST_WRAPPER");
  await checkBuildSource(config.product.root, root);
  const loaded = await loadB5A2V1(root, handoff.pythonSha256);
  try {
    const c = loaded.configuration;
    need(c.toolingRevision === config.a2.toolingRevision && loaded.adapter.schemaDigest === config.a2.schemaDigest
      && c.settingsFile === config.settingsFile && c.availabilityFile === config.availabilityFile
      && c.executionIdentity.uid === process.getuid?.(), "B5_HOST_A2_PINS");
    need(c.runRoot === join(root, "runs") && c.workRoot === join(root, "work") && (c.cwd === root || inside(root, c.cwd)) && (c.configRoot === root || inside(root, c.configRoot)), "B5_HOST_A2_ROOTS");
    await regular(c.entrypoint, root);
    need(b5RawHash(await readFile(c.entrypoint)) === c.entrypointSha256, "B5_HOST_A2_PINS");
    need(loaded.adapter.finalization?.enabled() === true && c.contract.recovery?.enabled() === true, "B5_HOST_CAPABILITY");
    const descriptor = z.record(z.string(), z.string()).parse(await json(join(root, "tools/loop/bridge/cr-entry.json"), root));
    need(descriptor.CR_WORK_ROOT === c.workRoot && descriptor.CR_RUNS === c.runRoot, "B5_HOST_A2_ROOTS");
    const descriptorLayout = { CR_LEAD_ROOT: "lead", CR_RUNS: "runs", CR_WORK_ROOT: "work", CR_LOG_ROOT: "logs",
      CR_HOME_WORK: "home-work", CR_SCRATCH_PARENT: "tmp", CR_MODELS: "tools/loop/models.tsv", CR_SKILLS: "lead/skills-src",
      CR_TEMPLATES: "tools/loop/templates", CR_JOB_ENV: "lead/job-env.json", CR_CONFIG_ROOT: "config" };
    need(Object.keys(descriptor).length === Object.keys(descriptorLayout).length, "B5_HOST_A2_ROOTS");
    for (const [name, suffix] of Object.entries(descriptorLayout)) {
      need(descriptor[name] === join(root, suffix), "B5_HOST_A2_ROOTS");
      await regular(descriptor[name], root, name !== "CR_MODELS" && name !== "CR_JOB_ENV");
    }
    await validateEntryIdentity(c, root, handoff.pythonSha256);
    const entry = Object.freeze({ interpreter: c.interpreter, entrypoint: c.entrypoint, cwd: c.cwd });
    await probeBindInputCapabilityV1(entry);
    const assets = await loadPrivateClientAssets(join(config.product.root, "dist-vps/client"));
    need(assets.digest === config.product.assetsDigest, "B5_HOST_ASSETS");
    for (const file of ["runtime.js", "index.js"]) await regular(join(config.product.root, "dist-vps/server", file), root);
    return { config, handoff, assets, entry, transport, digests: preflight.digests,
      configDigest: b5Bytes(await readFile(join(root, "config/b5.json"))),
      handoffDigest: b5Bytes(await readFile(join(root, "config/b5-handoff.json"))) };
  } finally { await loaded.adapter.close(); }
}

async function validateNode(root: string, approved: string) {
  const executable = join(root, "runtime/bin/node"); await regular(executable, root, false, 256 << 20);
  need(b5RawHash(await readFile(executable)) === approved
    && b5RawHash(await readFile(await realpath(process.execPath))) === approved, "B5_HOST_NODE_PIN");
}

async function validateEntryIdentity(configuration: LoopAdapterConfigurationV1, root: string, approvedPython: string) {
  // Same resolver guard as the F03-0 qualification helper, before every explicit
  // entry use. The parent environment never supplies a live installation root.
  const resolver = await exec("/bin/sh", ["-c", '. "$1" || exit; "$CR_PYTHON" -I -B -c \'import os,sys; print(os.path.realpath(sys.executable))\'',
    "b5-python", join(root, "tools/bin/lib/python.sh")], { env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" }, timeout: 30_000, maxBuffer: 65536 });
  need(resolver.stdout.trim() === configuration.interpreter
    && b5RawHash(await readFile(configuration.interpreter)) === approvedPython, "B5_HOST_INTERPRETER_PIN");
  await regular(configuration.entrypoint, root);
  need(b5RawHash(await readFile(configuration.entrypoint)) === configuration.entrypointSha256
    && b5Bytes(await readFile(configuration.toolingManifest)) === configuration.toolingRevision, "B5_HOST_A2_PINS");
}

async function checkBuildSource(product: string, root: string) {
  const file = join(product, "dist-vps/server/mac-local-build-source.json");
  const recorded = captureMacLocalBuildSourceV1(await json(file, root));
  const actual = await macLocalBuildSourceV1(product);
  need(recorded.commit === actual.commit && recorded.sourceDigest === actual.sourceDigest, "B5_HOST_BUILD_SOURCE");
}

/** Explicit F03a completion of a frozen packet. The product must already be
 * built from its reviewed clean candidate; this writes only new assembly inputs.
 */
export async function prepareFirstWebsiteAssemblyV1(root: string) {
  const rootStat = await regular(root, root, true);
  need(/^acr-b5-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(root.slice(dirname(root).length + 1)), "B5_SCRATCH_ROOT");
  need((rootStat.mode & 0o077) === 0, "B5_HOST_CUSTODY");
  const handoff = handoffSchema.parse(await json(join(root, "config/b5-handoff.json"), root));
  for (const [name, hash] of Object.entries(handoff.hashes)) {
    const file = join(root, name); await regular(file, root);
    need(b5RawHash(await readFile(file)) === hash, "B5_HOST_FROZEN_INPUT");
  }
  await validateNode(root, handoff.nodeSha256);
  const product = join(root, "product");
  const options = { cwd: product, encoding: "utf8" as const, timeout: 30_000,
    env: { NODE_ENV: "test" as const, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  need((await exec("/usr/bin/git", ["rev-parse", "HEAD"], options)).stdout.trim() === handoff.productPin
    && (await exec("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], options)).stdout === "", "B5_PRODUCT_REVISION");
  await regular(join(product, "scripts/workflow-journeys/first-website-host.ts"), root);
  await checkBuildSource(product, root);
  const assets = await loadPrivateClientAssets(join(product, "dist-vps/client"));
  const loaded = await loadB5A2V1(root, handoff.pythonSha256);
  try {
    const assembly = join(root, "config/first-website-host.mjs"), transport = join(root, "config/b5-loopback-transport.json");
    const wrapper = assemblyWrapper;
    const c = loaded.configuration;
    const config = firstWebsiteConfigSchemaV1.parse({ schemaVersion: 1,
      product: { root: product, baseRevision: handoff.productPin, candidateRevision: handoff.productPin, assetsDigest: assets.digest },
      a2: { contractFile: join(root, "config/contract-cleanup.json"), toolingRevision: c.toolingRevision,
        schemaDigest: loaded.adapter.schemaDigest, qualificationEvidence: join(root, "config/b5-qualification.json") },
      assembly: { module: assembly, digest: b5Bytes(wrapper) }, scratchRoot: root,
      ports: { product: B5_PORTS.product, preview: B5_PORTS.preview, postgresBase: B5_PORTS.postgresBase },
      device: { origin, transportQualification: transport, actor: "owner" },
      settingsFile: c.settingsFile, availabilityFile: c.availabilityFile, authorizationEvidence: join(root, "config/authorization.json"),
      requestText: B5_REQUEST_TEXT, faultInputFile: join(root, "config/fault-input.txt"), reviewInputFile: join(root, "config/review-input.txt") });
    for (const file of [assembly, transport, join(root, "config/b5.json")])
      need(!await lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), "B5_HOST_OUTPUT_EXISTS");
    await writeFile(assembly, wrapper, { flag: "wx", mode: 0o600 });
    await writeFile(transport, JSON.stringify({ schemaVersion: 1, kind: "loopback-only", origin, backend: origin, scope: "assembly-only" }) + "\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "config/b5.json"), JSON.stringify(config) + "\n", { flag: "wx", mode: 0o600 });
    return config;
  } finally { await loaded.adapter.close(); }
}

async function descendantPids() {
  // Numeric process inventory only. Never read another process's argv or env.
  const pending = exec("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 10_000, maxBuffer: 1 << 20 });
  const observer = pending.child.pid;
  const rows = (await pending).stdout.trim().split("\n").map(line => line.trim().split(/\s+/u).map(Number));
  need(rows.every(row => row.length === 2 && row.every(Number.isSafeInteger)), "B5_HOST_INVENTORY_UNAVAILABLE");
  const owned = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) if (pid !== observer && owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
  }
  owned.delete(process.pid); return owned;
}
async function listenerReleased() {
  return new Promise<boolean>(done => {
    const socket = createServer(); socket.once("error", () => done(false));
    socket.listen({ host: "127.0.0.1", port: B5_PORTS.product, exclusive: true }, () => socket.close(() => done(true)));
  });
}

export function firstWebsiteProjectPayloadV1() {
  // The Mac-local primitive's actual fixed portable configuration. Build its
  // saved presentation with the production constructor, including its digest.
  const configuration = parseProductConfigurationV1({ schema: "control-room.product-configuration/v1",
    displayName: "Control Room", defaultTimezone: "UTC", modules: { ideaLab: false, news: false, sessionObservations: false },
    limits: { maxProjects: 24, maxTasksPerProject: 200, maxResultsPerTask: 20, maxArticleSources: 0, maxIdeaParticipants: 0 },
    projectTemplates: [{ id: "control-room", displayName: "Control Room", enabledModules: [] }] });
  return { projectKind: "general", origin: "manual", presentation: buildProjectPresentationV1({ templateId: "control-room",
    displayName: "Control Room", enabledModules: [] }, sha256Digest(configuration)) };
}

/** Admin has no runtime role. Seed just the disposable catalog and live owner grant. */
export async function seedFirstWebsiteDatabaseV1(pg: RealPostgres) {
  const admin = new Client({ ...pg.admin(), connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 2000 });
  try {
    await admin.connect();
    await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Disposable B5')", [scope.tenantId]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Disposable B5')", [scope.workspaceId, scope.tenantId]);
    await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [manualAdapterId, scope.tenantId]);
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,$5,$1,'1','Disposable B5 website','planned','manual_project_active','healthy','control_room_native',now(),$4,now())`,
      [projectId, scope.tenantId, scope.workspaceId, JSON.stringify(firstWebsiteProjectPayloadV1()), manualAdapterId]);
    await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())`, [scope.tenantId, projectId]);
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human','Disposable owner',$3,$4,'active',now(),now())`, [ownerId, scope.tenantId, provider, sha256Digest({ provider, subject: ownerId })]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES('grant:b5-owner',$1,$2,'owner','["*"]','["*"]','critical',false,false,now(),now())`, [scope.tenantId, ownerId]);
  } finally { await admin.end(); }
}

function pool(pg: RealPostgres, role: "web" | "coordinator") {
  const login = pg.connection(role);
  return bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: pg.port,
    database: pg.database, username: login.user, password: login.password, majorVersion: 17 }), host: login.host }));
}

/** One factory call owns one PG lifetime. Every restart replaces only the
 * application/adapter/recovery/listener, preserving PG, corpus and integrity key.
 */
export type FirstWebsiteAssemblyHooksV1 = {
  signalOwner?: import("../../tests/helpers/improve-control-room-first-website").FirstWebsiteCleanupOwnerV1;
  at?(stage: "pool-open" | "listener-bind" | "ready" | "closing" | "proof-read"): Promise<void> };
const registries = new Map<string, { application?: ReturnType<typeof createMacLocalWebProcessV1>; claimed: boolean }>();

export async function createFirstWebsiteHostV1(input: Readonly<FirstWebsiteConfigV1>, signal: AbortSignal,
  hooks: FirstWebsiteAssemblyHooksV1 = {}): Promise<FirstWebsiteHostV1> {
  signal.throwIfAborted();
  const config = firstWebsiteConfigSchemaV1.parse(input), deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const cleanupBudgetMs = Math.min(300_000, Math.floor(config.maxDurationMs / 4));
  const timer = setTimeout(() => deadline.abort(new B5RefusalV1("B5_HOST_DEADLINE")), config.maxDurationMs - cleanupBudgetMs);
  const stopTimer = () => clearTimeout(timer);
  combined.addEventListener("abort", stopTimer, { once: true });
  try {
    const host = await acquireFirstWebsiteHostV1(config, combined, hooks);
    const rawClose = host.close; let closed: Promise<void> | undefined;
    host.close = () => closed ??= rawClose().finally(() => {
      stopTimer(); combined.removeEventListener("abort", stopTimer);
    });
    if (combined.aborted) { await host.close(); combined.throwIfAborted(); }
    Object.freeze(host.proof); return Object.freeze(host);
  } catch (error) { stopTimer(); combined.removeEventListener("abort", stopTimer); throw error; }
}

async function acquireFirstWebsiteHostV1(input: Readonly<FirstWebsiteConfigV1>, signal: AbortSignal,
  hooks: FirstWebsiteAssemblyHooksV1): Promise<FirstWebsiteHostV1> {
  signal.throwIfAborted();
  const prepared = await validateFirstWebsiteHostV1(input, hooks.signalOwner);
  signal.throwIfAborted();
  const { config, handoff, assets, entry } = prepared, root = config.scratchRoot;
  const pgOwnership = hooks.signalOwner ? { signalOwner: "caller" as const, cleanup: () => hooks.signalOwner!.cleanup() } : {};
  if (prepared.transport) {
    assertB5DeviceSignalCleanupV1({ signalOwner: pgOwnership.signalOwner, cleanup: hooks.signalOwner?.cleanup });
    need(typeof hooks.signalOwner?.registerCloseHost === "function", "B5_DEVICE_SIGNAL_CLEANUP_UNQUALIFIED");
  }
  for (const name of ["ATTACK_KIT_RUN_ROOT", "ATTACK_KIT_SOCKET_ROOT"] as const) {
    const directory = process.env[name];
    need(directory && (directory === root || inside(root, directory)), "B5_HOST_PG_SCRATCH");
    await regular(directory, root, true);
  }
  const baselinePids = await descendantPids();
  const integrityKey = randomBytes(32), ready = deferred<FirstWebsiteHostV1>(), finish = deferred<void>();
  let closing: Promise<void> | undefined, current: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let pgRef: RealPostgres | undefined, pgClean = false, cleanupFailed = false, ownerCode = "";
  let restarting: Promise<void> | undefined, starting: Promise<void> | undefined, servingClosed: Promise<void> | undefined, bodyDone = false;
  const privateReads = new Set<Promise<unknown>>();
  function ownedRead<T>(read: () => Promise<T>): Promise<T> {
    if (closing || restarting) return Promise.reject(new B5RefusalV1("B5_HOST_CLOSED"));
    const work = Promise.resolve().then(read); privateReads.add(work);
    void work.finally(() => privateReads.delete(work)).catch(() => {}); return work;
  }
  // Install one real registry delegate. Each request reaches the current real
  // Mac-local object; no source registry or replacement renderer is involved.
  const deviceMailbox = prepared.transport ? await createB5DeviceMailboxV1(root, config.device.origin, { real: true, projectId, inventory: prepared.transport.inventory }) : undefined;
  const registryKey = join(config.product.root, "dist-vps/server/runtime.js");
  const existing = registries.get(registryKey);
  need(!existing?.claimed, "B5_HOST_ALREADY_RUNNING");
  const registry = existing ?? { claimed: false, application: undefined as ReturnType<typeof createMacLocalWebProcessV1> | undefined };
  registry.claimed = true;
  let renderer: { default: (request: Request) => Promise<Response> };
  try {
    const runtime = await import(pathToFileURL(registryKey).href);
    renderer = await import(pathToFileURL(join(config.product.root, "dist-vps/server/index.js")).href);
    need(typeof runtime.installPrivateApplication === "function" && typeof renderer.default === "function", "B5_HOST_BUILT_ENTRY");
    if (!existing) {
      runtime.installPrivateApplication({ handle: (request: Request, render: () => Promise<Response>) =>
        registry.application ? registry.application.handle(request, render) : new Response("Unavailable", { status: 503 }),
        close: async () => { await registry.application?.close(); } });
      registries.set(registryKey, registry);
    }
  } catch (error) { registry.claimed = false; throw error; }

  async function startRuntime(pg: RealPostgres, activeSignal: AbortSignal) {
    activeSignal.throwIfAborted();
    // A restart consumes the original frozen inputs, even if evidence now
    // exists or PG is already running. It never re-pins a changed packet.
    for (const [name, hash] of Object.entries(handoff.hashes)) {
      const file = join(root, name); await regular(file, root);
      need(b5RawHash(await readFile(file)) === hash, "B5_HOST_FROZEN_INPUT");
    }
    for (const [name, file] of Object.entries({ assembly: config.assembly.module, transport: config.device.transportQualification })) {
      await regular(file, root); need(b5Bytes(await readFile(file)) === prepared.digests[name], "B5_HOST_FROZEN_INPUT");
    }
    need(b5Bytes(await readFile(join(root, "config/b5.json"))) === prepared.configDigest
      && b5Bytes(await readFile(join(root, "config/b5-handoff.json"))) === prepared.handoffDigest, "B5_HOST_FROZEN_INPUT");
    need(!await lstat(join(root, "config/i1/real-jobs-enabled")).then(() => true, () => false), "B5_HOST_LAUNCHER_ENABLED");
    await validateNode(root, handoff.nodeSha256);
    const source = await macLocalBuildSourceV1(config.product.root);
    need(source.commit === config.product.candidateRevision, "B5_HOST_PRODUCT_PIN");
    const dirty = await exec("/usr/bin/git", ["-C", config.product.root, "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"],
      { env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 30_000 });
    need(dirty.stdout === "", "B5_PRODUCT_DIRTY");
    await checkBuildSource(config.product.root, root);
    activeSignal.throwIfAborted();
    const loaded = await loadB5A2V1(root, handoff.pythonSha256);
    const adapter = loaded.adapter;
    let web: ReturnType<typeof pool> | undefined, coordinator: ReturnType<typeof pool> | undefined;
    let application: ReturnType<typeof createMacLocalWebProcessV1> | undefined;
    let service: ReturnType<typeof createMacLocalNodeService> | undefined;
    let recovery: ReturnType<typeof createImproveControlRoomLoopRecoveryV1> | undefined;
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async () => {
      // Listener stops acceptance and drains HTTP before its application close.
      // Its application port below drains recovery before the real app/pool.
      const results = await Promise.allSettled([service ? service.close() : Promise.resolve()]);
      for (const operation of [() => recovery?.close(), () => application?.close(), () => adapter.close(), () => web?.close(), () => coordinator?.close()])
        results.push(...await Promise.allSettled([Promise.resolve().then(operation)]));
      if (results.some(result => result.status === "rejected")) { cleanupFailed = true; throw new B5RefusalV1("B5_HOST_CLEANUP_UNCERTAIN"); }
    })();
    try {
      activeSignal.throwIfAborted();
      need(adapter.toolingRevision === config.a2.toolingRevision && adapter.schemaDigest === config.a2.schemaDigest
        && loaded.configuration.settingsFile === config.settingsFile && loaded.configuration.availabilityFile === config.availabilityFile
        && adapter.finalization?.enabled() === true && loaded.configuration.contract.recovery?.enabled() === true, "B5_HOST_A2_PINS");
      await validateEntryIdentity(loaded.configuration, root, handoff.pythonSha256);
      activeSignal.throwIfAborted();
      web = pool(pg, "web"); coordinator = pool(pg, "coordinator");
      const opening = web.client.query<{ role: string }>("SELECT current_user AS role");
      void opening.catch(() => {});
      await hooks.at?.("pool-open");
      const webRole = await opening;
      activeSignal.throwIfAborted();
      const coordinatorRole = await coordinator.client.query<{ role: string }>("SELECT current_user AS role");
      need(webRole.rows[0]?.role === pg.connection("web").user && coordinatorRole.rows[0]?.role === pg.connection("coordinator").user
        && webRole.rows[0].role !== coordinatorRole.rows[0].role, "B5_HOST_ROLE");
      let denied = false;
      try { await web.client.query("INSERT INTO tenants(id,display_name) VALUES('tenant:b5-denied','Denied')"); }
      catch (error) { denied = databaseSqlStateV1(error) === "42501"; }
      need(denied, "B5_HOST_WEB_WRITE");
      activeSignal.throwIfAborted();
      const capability = adapter.finalization;
      need(capability?.enabled() === true, "B5_HOST_CAPABILITY");
      const loopBridge: LoopBridgeConfigurationV1 = { integrityKey, adapter, loopCandidates: { integrityKey,
        contract: adapter.contract, schemaDigest: adapter.schemaDigest, source: capability.source, repository: capability.repository } };
      ownerCode = randomBytes(32).toString("base64url");
      application = createMacLocalWebProcessV1({ origin, workspaceId: scope.workspaceId, database: web,
        localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: scope.tenantId,
          provider, subject: ownerId, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: prepared.transport ? 300 : 900,
          ...(prepared.transport ? { remoteOrigins: [prepared.transport.origin] } : {}) }, loopBridge });
      const recoveryService = new ImproveControlRoomLoopServiceV1(web.client, scope, loopBridge);
      recovery = createImproveControlRoomLoopRecoveryV1({ port: recoveryService.recoveryPort(),
        enabled: () => loaded.configuration.contract.recovery!.enabled() === true || capability.enabled() === true,
        observe: recoveryService.finalizationPort().observe, onTick: adapter.monitoringTick, createCycle: createPipelineAdvanceCycleV1 });
      service = createMacLocalNodeService({ origin, port: B5_PORTS.product, assets,
        ...(prepared.transport ? { remoteOrigins: b5DeviceRemoteOriginsV1(prepared.transport) } : {}),
        handler: request => deviceMailbox ? deviceMailbox.handle(request, () => renderer.default(request)) : renderer.default(request),
        application: { isReady: application.isReady, close: async () => { await recovery!.close(); await application!.close(); } } });
      const desk = new ImproveControlRoomDeskServiceV1(web.client, scope, integrityKey, undefined, Date.now,
        adapter.contract, loopBridge.loopCandidates);
      const runtime = Object.freeze({ isReady: service.isReady, close });
      const value = Object.freeze({ application, isReady: service.isReady, close, adapter, web, desk,
        runtime, configuration: loaded.configuration });
      // The delegate must see this actual app while the listener starts.
      current = value; registry.application = application;
      const binding = service.start(); void binding.catch(() => {});
      await hooks.at?.("listener-bind");
      await binding;
      activeSignal.throwIfAborted();
      recovery.start();
      need(service.isReady(), "B5_HOST_NOT_READY");
      await hooks.at?.("ready"); activeSignal.throwIfAborted();
      return value;
    } catch (error) { await close(); throw error; }
  }

  hooks.signalOwner?.registerCloseHost(() => {
    void close().catch(() => {});
    return stopServing();
  });
  const done = withRealPostgres(async pg => {
    pgRef = pg;
    try {
      starting = (async () => {
        need(pg.postmasterPidCaptured, "B5_HOST_PG_OWNERSHIP");
        signal.throwIfAborted(); need(!closing, "B5_HOST_CLOSED");
        await seedFirstWebsiteDatabaseV1(pg); signal.throwIfAborted(); need(!closing, "B5_HOST_CLOSED");
        current = await startRuntime(pg, signal);
      })();
      await starting;
      const host: FirstWebsiteHostV1 = {
        origin, a2Entry: entry, get startup() { need(current, "B5_HOST_NOT_READY"); return current.runtime; }, close,
        proof: {
          ...(deviceMailbox ? { device: deviceMailbox } : {}),
          async withOwnerCode(use) { need(!closing && ownerCode, "B5_HOST_CLOSED"); return use(ownerCode); },
          project: Object.freeze({ projectId, repository: join(root, "work/repo"), baseRevision: handoff.baseline }),
          async restart(restartSignal) {
            restartSignal.throwIfAborted();
            need(!closing && !restarting, "B5_HOST_RESTART_BUSY");
            restarting = (async () => {
              await Promise.allSettled([...privateReads]);
              await current!.close(); current = undefined; registry.application = undefined; ownerCode = "";
              const combined = AbortSignal.any([signal, restartSignal]); combined.throwIfAborted();
              current = await startRuntime(pg, combined);
              if (closing || combined.aborted) { await current.close(); combined.throwIfAborted(); }
            })();
            try { await restarting; } finally { restarting = undefined; }
          },
          readSnapshot() { return ownedRead(async () => {
            await hooks.at?.("proof-read");
            const active = current; need(active && !closing, "B5_HOST_CLOSED");
            const snapshot = await active.web.client.transaction(async tx => {
              await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
              const rows: { table: typeof B5_SNAPSHOT_TABLES[number]; sha256: string; row: Record<string, unknown> }[] = [];
              for (const table of B5_SNAPSHOT_TABLES) {
                const columns = table === "control_loop_update_candidates" ? "id,request_id,run_link_id,candidate_revision,record_digest"
                  : table === "control_loop_improvement_inputs" ? "request_id,version"
                  : table === "control_loop_improvement_commands" ? "command_id,entry_kind" : "id";
                const values = await tx.query<Record<string, unknown>>(`SELECT ${columns} FROM ${table} WHERE tenant_id=$1`, [scope.tenantId]);
                for (const raw of values.rows) {
                  const row = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
                  rows.push({ table, sha256: b5Bytes(JSON.stringify(row)), row });
                }
              }
              return { schemaVersion: 1 as const, readAt: new Date().toISOString(), rows };
            });
            need(current === active && !closing, "B5_HOST_GENERATION_CHANGED"); return snapshot;
          }); },
          readRun(runId) { return ownedRead(async () => {
            await hooks.at?.("proof-read");
            const active = current;
            need(active && !closing && /^[a-z0-9][a-z0-9-]{0,40}$/u.test(runId), "B5_HOST_RUN");
            const request = (await active.web.client.query<{ request_id: string }>(`SELECT request_id
              FROM control_loop_improvement_run_links WHERE tenant_id=$1 AND loop_run_id=$2`, [scope.tenantId, runId])).rows[0];
            need(request, "B5_HOST_RUN");
            // This real service method verifies the signed request, current input,
            // saved run link and authorization before the filesystem projection.
            const lineage = await active.web.client.transaction(tx => active.desk.loopBridgeLineage(tx, projectId, request.request_id, ownerId));
            const { input, link, authorization } = lineage; need(link && link.loop_run_id === runId, "B5_HOST_RUN");
            const status = await active.adapter.status(runId);
            const projectionInput = { root, runId, baseline: handoff.baseline, toolingRevision: config.a2.toolingRevision,
              adapter: active.adapter, runLink: { requestId: link.request_id, projectId: link.project_id,
                initialInputVersion: Number(link.initial_input_version), run: { adapterId: link.adapter_id, loopRunId: link.loop_run_id,
                  toolingRevision: link.tooling_revision, a2SchemaVersion: z.literal(1).parse(Number(link.a2_schema_version)) } },
              saved: { requestId: input.request_id, runLinkId: link.id, localVersion: Number(input.version),
                inputVersion: z.union([z.string().min(1), z.number().int().positive()]).parse(authorization?.a2_input_version ?? status.inputVersion), description: input.description,
                settingsText: input.settings_text, requestSha256: input.request_sha256, settingsSha256: input.settings_sha256 },
              readChainStatus: async () => {
                need(current === active && !closing, "B5_HOST_GENERATION_CHANGED");
                await validateEntryIdentity(active.configuration, root, handoff.pythonSha256);
                const result = await exec(entry.interpreter, [entry.entrypoint, "status", runId, "--json"], { cwd: entry.cwd,
                  env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
                return parseStrictJsonV1(result.stdout, { maxBytes: 1 << 20 });
              } };
            const projection = await projectB5RunV1(projectionInput);
            need(current === active && !closing, "B5_HOST_GENERATION_CHANGED");
            if (status.state !== "finished") return projection;
            need(authorization && active.adapter.finalization, "B5_A2_LATER_PHASE_EVIDENCE_REQUIRED");
            // Read through ordinary current-time Mac-local issuance and catalog
            // authorization. No fabricated principal or saved browser session.
            const requestPath = `/api/v1/projects/${encodeURIComponent(projectId)}/improvements/loop/${encodeURIComponent(input.request_id)}`;
            const issued = await fetch(origin + "/api/v1/local-owner-session", { method: "POST",
              headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }), signal: AbortSignal.timeout(10_000) });
            need(issued.status === 201, "B5_HOST_COLD_SIGN_IN");
            const cookie = issued.headers.get("set-cookie")?.split(";")[0]; await issued.arrayBuffer();
            need(cookie, "B5_HOST_COLD_SIGN_IN");
            const get = (path: string) => fetch(origin + path, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
            try {
              const catalog = await get("/api/v1/projects"); await catalog.arrayBuffer();
              need(catalog.status === 200, "B5_HOST_COLD_CATALOG");
              const statusRead = await get(requestPath + "/status"); need(statusRead.status === 200, "B5_HOST_COLD_STATUS");
              const observed = loopImprovementStatusSchemaV1.parse(await statusRead.json());
              need(observed.engineRevision === status.revision && observed.startState === "started" && observed.confirmationCurrent
                && observed.runLinkId === link.id && observed.localVersion === Number(input.version), "B5_HOST_COLD_STATUS");
              // The real status read verifies the unique signed start and its
              // accepted result. Project only its authoritative saved fields.
              const starts = (await active.web.client.query<{ command_id: string; binding: unknown }>(`SELECT command_id,binding
                FROM control_loop_improvement_commands WHERE tenant_id=$1 AND request_id=$2 AND entry_kind='claim' AND operation='start'`,
              [scope.tenantId, input.request_id])).rows;
              need(starts.length === 1, "B5_HOST_START_JOIN");
              const start = starts[0], binding = loopBridgeBindingSchemaV1.parse(start.binding);
              need(binding.runLinkId === link.id && binding.authorizationId === authorization.id && binding.inputVersion === status.inputVersion
                && binding.requestSha256 === input.request_sha256 && binding.settingsSha256 === input.settings_sha256, "B5_HOST_START_JOIN");
              const target = loopFinalizationTargetSchemaV1.parse({ schemaVersion: 1, ...scope, projectId, ownerIdentityId: ownerId,
                requestId: input.request_id, runLinkId: link.id, localVersion: Number(input.version), authorizationId: authorization.id,
                startCommandId: start.command_id, startBindingDigest: sha256Digest(binding), run: status.run, inputVersion: status.inputVersion,
                requestSha256: input.request_sha256, settingsSha256: input.settings_sha256, settingsDigest: status.settingsDigest,
                expectedRevision: status.revision, schemaDigest: active.adapter.schemaDigest });
              const joined = await joinB5FinalProjectionV1({ ...projectionInput, finalization: active.adapter.finalization, target,
                readColdCard: async () => { const card = await get(requestPath + "/candidate");
                  need(card.status === 200, "B5_HOST_COLD_CARD"); return card.json(); } });
              need(current === active && !closing, "B5_HOST_GENERATION_CHANGED"); return joined;
            } finally {
              const signedOut = await fetch(origin + "/api/v1/local-owner-session", { method: "DELETE", headers: { origin, cookie },
                signal: AbortSignal.timeout(10_000) });
              need(signedOut.status === 204, "B5_HOST_COLD_SESSION_CLEANUP");
            }
          }); },
          async inspectOwned() {
            const stopped = pgRef ? !await pgRef.isRunning() : pgClean;
            const commandScratch = (await readdir(join(root, "work"))).some(name => /^loop-command-[a-f0-9]{32}$/u.test(name));
            const runScratchAbsent = !commandScratch && (pgRef ? !await lstat(pgRef.runDirectory).then(() => true, () => false) : pgClean);
            const descendants = await descendantPids();
            const processCount = [...descendants].filter(pid => !baselinePids.has(pid)).length + (stopped ? 0 : 1);
            // This reports owned cleanup only. Protected listeners are never
            // probed, so this method cannot attest their external state.
            return { processCount, listenerReleased: !!closing && bodyDone && !cleanupFailed && await listenerReleased(),
              postgresStopped: stopped && pgClean, runScratchAbsent };
          },
        },
      };
      ready.resolve(host);
      await finish.promise;
    } finally { bodyDone = true; await stopServing(); }
  }, { port: B5_PORTS.postgresBase, allowedPorts: Array.from({ length: B5_PORTS.postgresCount }, (_, i) => B5_PORTS.postgresBase + i),
    pgBin: process.env.PG_BIN, ...pgOwnership }).then(result => { pgClean = result.cleanedUp; }, async error => {
      // The helper also tears down when its body aborts, but returns no result
      // in that case. Observe destruction before distinguishing a clean abort
      // from failed/uncertain cleanup; never silently clear that latter fence.
      try {
        if (pgRef) {
          const absent = (file: string) => lstat(file).then(() => false, e => { if (e.code === "ENOENT") return true; throw e; });
          pgClean = !await pgRef.isRunning() && await absent(pgRef.dataDirectory)
            && await absent(pgRef.runDirectory) && await absent(pgRef.socketDirectory);
          if (!pgClean) cleanupFailed = true;
        }
      } catch { cleanupFailed = true; error = new B5RefusalV1("B5_HOST_CLEANUP_UNCERTAIN"); }
      finally { ready.reject(error); }
      throw error;
    });
  // Always observe failure, including one before the factory's await.
  void done.catch(() => {});
  function stopServing() { return servingClosed ??= (async () => {
    const deviceClosed = deviceMailbox?.close();
    // Observe an early mailbox rejection while draining the host.
    void deviceClosed?.catch(() => {});
    registry.application = undefined;
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown> | undefined) => {
      try { await work(); } catch (error) { failures.push(error); }
    };
    try {
      await attempt(() => hooks.at?.("closing"));
      await starting?.catch(() => {});
      await attempt(() => restarting);
      await Promise.allSettled([...privateReads]);
      await attempt(() => current?.close());
      await attempt(() => deviceClosed);
      if (failures.length) { cleanupFailed = true; throw new B5RefusalV1("B5_HOST_CLEANUP_UNCERTAIN"); }
    } finally { ownerCode = ""; finish.resolve(); }
  })(); }
  function close() { return closing ??= (async () => {
    signal.removeEventListener("abort", aborted);
    try { await stopServing(); }
    finally {
      try { await done; } finally { registry.application = undefined; registry.claimed = cleanupFailed || !pgClean; }
    }
    if (cleanupFailed) throw new B5RefusalV1("B5_HOST_CLEANUP_UNCERTAIN");
  })(); }
  function aborted() { void close().catch(() => {}); }
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  try { const host = await ready.promise; signal.throwIfAborted(); return host; }
  catch (error) { await close(); throw error; }
}

// The assembly entry is separate from the later journey controller. It never
// starts intake, binds inputs or claims device/provider readiness.
async function main() {
  if (process.argv.length === 4 && process.argv[2] === "--prepare") {
    await prepareFirstWebsiteAssemblyV1(process.argv[3]);
    console.log("RESULT: PASS B5 strict local assembly config written (assembly only)"); return;
  }
  const [flag, configFile, evidenceFlag, evidenceDir] = process.argv.slice(2);
  need(flag === "--config" && configFile && evidenceFlag === "--evidence-dir" && evidenceDir && process.argv.length === 6, "B5_USAGE");
  const preflight = await preflightFirstWebsiteV1({ configFile, evidenceDir,
    cliFile: join(dirname(dirname(configFile)), "product/scripts/workflow-journeys/first-website-proof.ts") });
  const abort = new AbortController(), interrupt = () => abort.abort(new B5RefusalV1("B5_HOST_INTERRUPTED"));
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const timer = setTimeout(() => abort.abort(new B5RefusalV1("B5_HOST_DEADLINE")), preflight.config.maxDurationMs);
  try { await withFirstWebsiteHostV1(preflight.config, abort.signal, async host => {
    need(host.startup.isReady(), "B5_HOST_NOT_READY");
    console.log("RESULT: PASS B5 local assembly start (assembly evidence only)");
  }); }
  finally { clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Finish module evaluation before the inert wrapper re-exports this module.
  // Awaiting main at module scope would deadlock that legitimate loader join.
  void main().catch(error => {
    console.log(`FAILED: ${error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_HOST_INTERNAL"}`); process.exitCode = 1;
  });
}
