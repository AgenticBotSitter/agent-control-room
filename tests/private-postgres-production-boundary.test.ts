import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivatePostgresProductionBoundaryV1, PRIVATE_POSTGRES_PRODUCTION_BOUNDARY_V1 } from
  "../src/installer/v1/private-postgres-production-boundary";
import type { PostgresOwnerRunnerContextV1 } from "../src/installer/v1/private-postgres-owner-runner";
import { POSTGRES_OWNER_ATTACHED_TERMINAL_V1 } from "../src/installer/v1/private-postgres-owner-runner";

const paths = ["deploy/postgres/provision-database.sql", "deploy/postgres/apply-migrations.mjs",
  "deploy/postgres/evidence.mjs", "deploy/postgres/migration-ledger.json"] as const;
const dependencyVersions = { pg: "8.23.0", "pg-cloudflare": "1.4.0", "pg-connection-string": "2.14.0",
  "pg-int8": "1.0.1", "pg-pool": "3.14.0", "pg-protocol": "1.16.0", "pg-types": "2.2.0",
  pgpass: "1.0.5", "postgres-array": "2.0.0", "postgres-bytea": "1.0.1", "postgres-date": "1.0.7",
  "postgres-interval": "1.2.0", split2: "4.2.0", xtend: "4.0.2" } as const;
const bytesDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-pg-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "deploy/postgres"), { recursive: true, mode: 0o700 });
  for (const [name, version] of Object.entries(dependencyVersions)) {
    await mkdir(join(root, "node_modules", name), { recursive: true, mode: 0o700 });
    const dependencies = name === "pg" ? Object.fromEntries(Object.entries(dependencyVersions).filter(([dependency]) => dependency !== "pg")) : {};
    await writeFile(join(root, "node_modules", name, "package.json"),
      `${JSON.stringify({ name, version, main: "index.js", dependencies })}\n`, { mode: 0o644 });
    await writeFile(join(root, "node_modules", name, "index.js"),
      name === "pg" ? "module.exports = { Client: class FixtureClient {} };\n" : "module.exports = {};\n", { mode: 0o644 });
  }
  const ledgerInputs = [
    { file: "db/migrations/0001_fixture.sql", kind: "migrate" },
    { file: "db/roles/production_roles.sql", kind: "grants" },
    { file: "db/roles/production_table_grants.sql", kind: "grants" },
    { file: "db/roles/production_provision.sql", kind: "provision" },
  ].map((entry, index) => ({ ...entry, order: index + 1,
    sha256: createHash("sha256").update(`-- ${entry.file}\n`).digest("hex") }));
  for (const entry of ledgerInputs) {
    await mkdir(join(root, entry.file.substring(0, entry.file.lastIndexOf("/"))), { recursive: true, mode: 0o700 });
    await writeFile(join(root, entry.file), `-- ${entry.file}\n`, { mode: 0o644 });
  }
  const ledger = `${JSON.stringify({ version: 1, digest: "a".repeat(64), entries: ledgerInputs }, null, 2)}\n`;
  const contents = ["-- inert\n",
    "export async function applyMigrations() { return { planned:false, applied:[], noOp:true, schemaDigest:'sha256:'+'a'.repeat(64), objects:0, logins:'applied', grants:'applied' }; }\n",
    "export async function collectDatabaseEvidence(_target, options) { return { databaseOwner:'control_room_schema_owner', requiredTables:options.requiredTables }; }\n",
    ledger];
  for (let index = 0; index < paths.length; index += 1) await writeFile(join(root, paths[index]), contents[index], { mode: 0o644 });
  const host = join(root, "deploy/postgres/private-owner-tool-host.mjs");
  const hostBytes = await readFile(new URL("../deploy/postgres/private-owner-tool-host.mjs", import.meta.url));
  await writeFile(host, hostBytes, { mode: 0o644 });
  await mkdir(join(root, "db/setup"), { recursive: true, mode: 0o700 });
  const setupSql = "-- inert setup\n";
  await writeFile(join(root, "db/setup/production_migration_ledger.sql"), setupSql, { mode: 0o644 });
  const psql = join(root, "psql-17");
  const modePath = join(root, "psql-mode"); await writeFile(modePath, "success\n", { mode: 0o600 });
  const psqlScript = `#!/bin/sh\nmode=$(cat ${JSON.stringify(modePath)})\nif [ "$mode" = overflow ]; then dd if=/dev/zero bs=1048576 count=5 2>/dev/null; exit 0; fi\nif [ "$mode" = deadline ]; then trap 'exit 0' TERM; while :; do :; done; fi\nexit 0\n`;
  await writeFile(psql, psqlScript, { mode: 0o700 }); await chmod(psql, 0o700);
  const node = join(root, "node-22");
  const nodeScript = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`;
  await writeFile(node, nodeScript, { mode: 0o700 }); await chmod(node, 0o700);
  const configuration = { schema: "control-room.private-postgres-owner-configuration/v1", majorVersion: 17,
    host: "127.0.0.1", port: 5432, database: "control_room", maintenanceDatabase: "postgres",
    operator: { username: "postgres", password: "operator-password-000000000000" },
    migratorPassword: "migrator-password-00000000000", applicationPassword: "application-password-000000000",
    schedulerPassword: "scheduler-password-00000000000", requiredTables: ["tenants"] };
  const configurationPath = join(root, "postgres-private.json"), configurationBytes = Buffer.from(JSON.stringify(configuration));
  await writeFile(configurationPath, configurationBytes, { mode: 0o600 });
  const reviewedFiles = { schema: "control-room.private-postgres-reviewed-files/v1" as const,
    releaseDigest: sha256Digest("release"), files: {
      provision: { path: paths[0], sha256: createHash("sha256").update(contents[0]).digest("hex") },
      migrations: { path: paths[1], sha256: createHash("sha256").update(contents[1]).digest("hex") },
      evidence: { path: paths[2], sha256: createHash("sha256").update(contents[2]).digest("hex") },
      ledger: { path: paths[3], sha256: createHash("sha256").update(contents[3]).digest("hex") } } };
  const signal = new AbortController().signal;
  const boundaryConfiguration = { schema: PRIVATE_POSTGRES_PRODUCTION_BOUNDARY_V1,
    configurationPath, configurationSha256: bytesDigest(configurationBytes), expectedOwnerUid: process.geteuid!(),
    releaseRoot: root, psqlPath: psql, psqlSha256: bytesDigest(Buffer.from(psqlScript)),
    postgresMajorVersion: 17 as const, nodePath: node, nodeSha256: bytesDigest(Buffer.from(nodeScript)),
    ownerToolHostSha256: bytesDigest(hostBytes), setupSqlSha256: bytesDigest(Buffer.from(setupSql)), reviewedFiles,
    baseRuntime: { signal, controlDeadlineMs: 2_000, cleanupDeadlineMs: 2_000,
      async verifyExactRelease() { return { outcome: "verified" as const, releaseDigest: reviewedFiles.releaseDigest }; },
      async verifyExactMigrationLedger() { return { outcome: "verified" as const, ledgerDigest: sha256Digest("ledger"), entries: [] }; },
      async confirmOwnerAttachedTerminal(context: PostgresOwnerRunnerContextV1) { return { schema: POSTGRES_OWNER_ATTACHED_TERMINAL_V1,
        requestDigest: context.requestDigest, operation: context.request.operation, ownerAttached: true as const, confirmed: true as const }; } } };
  const createRuntime = (options: { launch?: typeof spawn; verifyAcl?: (request: any) => Promise<any>;
    controlDeadlineMs?: number; cleanupDeadlineMs?: number } = {}) => createPrivatePostgresProductionBoundaryV1({
      ...boundaryConfiguration, baseRuntime: { ...boundaryConfiguration.baseRuntime,
        controlDeadlineMs: options.controlDeadlineMs ?? 2_000, cleanupDeadlineMs: options.cleanupDeadlineMs ?? 2_000 } }, {
      launch(executable, args, launchOptions) {
        const launch = options.launch ?? spawn;
        return launch(executable, [...args], launchOptions as never) as never;
      },
      async verifyNoExtendedAcl(request) {
        if (options.verifyAcl) return options.verifyAcl(request);
        return { outcome: "verified" as const, device: request.identity.device,
          inode: request.identity.inode, extendedAcl: false as const };
      },
    });
  const runtime = createRuntime();
  const context = { signal, requestDigest: sha256Digest("request"), request: { releaseDigest: reviewedFiles.releaseDigest } } as
    unknown as PostgresOwnerRunnerContextV1;
  return { root, runtime, context, configurationPath, psql, modePath, createRuntime, reviewedFiles };
}

test("production boundary is inert at construction and runs only the absolute digest-bound psql identity", async t => {
  const f = await fixture(t);
  const result = await f.runtime.provisionDatabase(f.runtime.privateConfiguration, f.context);
  assert.equal(result.outcome, "succeeded");
  assert.doesNotMatch(JSON.stringify(result), /operator-password|migrator-password/u);
  assert.deepEqual(await f.runtime.cleanup(new AbortController().signal), { outcome: "confirmed" });
});

test("configuration byte drift refuses before psql can be entered and errors contain no private values", async t => {
  const f = await fixture(t);
  await writeFile(f.configurationPath, "{}", { mode: 0o600 });
  let caught: unknown;
  try { await f.runtime.provisionDatabase(f.runtime.privateConfiguration, f.context); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error); assert.equal(caught.message, "private_postgres_owner_adapter_refused");
  assert.equal(caught.stack, undefined); assert.doesNotMatch(String(caught), /operator-password|postgres-private/u);
});

test("provisioning executes only the captured stage with -X and token-verified replacement environment", async t => {
  const f = await fixture(t); let launched: { executable: string; args: readonly string[]; options: any } | undefined;
  const runtime = f.createRuntime({ launch: ((executable: string, args: readonly string[], options: any) => {
    launched = { executable, args: [...args], options };
    writeFileSync(f.psql, "#!/bin/sh\nexit 41\n", { mode: 0o700 });
    writeFileSync(join(f.root, paths[0]), "-- changed after capture\n", { mode: 0o644 });
    return spawn(executable, [...args], options);
  }) as typeof spawn });
  assert.equal((await runtime.provisionDatabase(runtime.privateConfiguration, f.context)).outcome, "succeeded");
  assert.ok(launched); assert.equal(launched.args[0], "-X"); assert.equal(launched.options.shell, false);
  assert.match(launched.executable, /\.private-postgres-owner-[^/]+\/bin\/psql$/u);
  const fileIndex = launched.args.indexOf("-f"); assert.ok(fileIndex >= 0);
  assert.match(launched.args[fileIndex + 1]!, /\.private-postgres-owner-[^/]+\/deploy\/postgres\/provision-database\.sql$/u);
  assert.equal(launched.options.env.PGOPTIONS, "-c search_path=pg_catalog,\\ public -c timezone=UTC");
  assert.equal(Object.prototype.hasOwnProperty.call(launched.options.env, "PATH"), false);
  assert.doesNotMatch(JSON.stringify(launched.args), /operator-password|migrator-password/u);
  assert.equal((await readdir(f.root)).some(name => name.startsWith(".private-postgres-owner-")), false);
});

test("the staged child host invokes only the captured migration and evidence modules", async t => {
  const f = await fixture(t);
  const migrated = await f.runtime.applyMigrations(f.runtime.privateConfiguration, f.context);
  assert.equal(migrated.outcome, "succeeded");
  const evidence = await f.runtime.collectDatabaseEvidence(f.runtime.privateConfiguration, f.context) as any;
  assert.equal(evidence.databaseOwner, "control_room_schema_owner");
  assert.deepEqual(evidence.requiredTables, ["tenants"]);
});

test("native ACL refusal and descriptor-to-name substitution both refuse before process entry", async t => {
  const acl = await fixture(t);
  const refused = acl.createRuntime({ verifyAcl: async request => ({ outcome: "verified", device: request.identity.device,
    inode: request.identity.inode, extendedAcl: true }) });
  await assert.rejects(refused.provisionDatabase(refused.privateConfiguration, acl.context),
    /private_postgres_owner_adapter_refused/u);

  const race = await fixture(t); let first = true;
  const raced = race.createRuntime({ verifyAcl: async request => {
    if (first) {
      first = false; await rename(race.configurationPath, `${race.configurationPath}.captured`);
      await writeFile(race.configurationPath, "{}", { mode: 0o600 });
    }
    return { outcome: "verified", device: request.identity.device, inode: request.identity.inode, extendedAcl: false };
  } });
  await assert.rejects(raced.provisionDatabase(raced.privateConfiguration, race.context),
    /private_postgres_owner_adapter_refused/u);
});

test("a replaced protected ancestor is detected before spawn and the replacement is never deleted", async t => {
  const f = await fixture(t), moved = `${f.root}.captured`; let launched = false, replaced = false;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const rootIdentity = await stat(f.root);
  const runtime = f.createRuntime({
    launch: (() => { launched = true; throw new Error("must not launch"); }) as typeof spawn,
    verifyAcl: async request => {
      if (!replaced && request.identity.device === rootIdentity.dev && request.identity.inode === rootIdentity.ino) {
        replaced = true; await rename(f.root, moved); await mkdir(f.root, { mode: 0o700 });
        await writeFile(join(f.root, "replacement-marker"), "preserve\n", { mode: 0o600 });
      }
      return { outcome: "verified", device: request.identity.device,
        inode: request.identity.inode, extendedAcl: false };
    },
  });
  assert.deepEqual(await runtime.provisionDatabase(runtime.privateConfiguration, f.context),
    { outcome: "failed_before_effect" });
  assert.equal(launched, false);
  assert.equal((await readFile(join(f.root, "replacement-marker"), "utf8")), "preserve\n");
  await assert.rejects(runtime.cleanup(new AbortController().signal), /private_postgres_owner_adapter_uncertain/u);
});

test("the real production evidence module uses the captured pg closure after source dependency substitution", async t => {
  const f = await fixture(t), marker = join(f.root, "dependency-marker"), dependency = join(f.root, "node_modules/pg/index.js");
  const realEvidence = await readFile(new URL("../deploy/postgres/evidence.mjs", import.meta.url));
  await writeFile(join(f.root, paths[2]), realEvidence, { mode: 0o644 });
  f.reviewedFiles.files.evidence.sha256 = createHash("sha256").update(realEvidence).digest("hex");
  const safeDependency = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'captured');\nclass Client{async connect(){} async end(){} async query(sql){if(sql.includes('pg_database'))return {rows:[{owner:'control_room_schema_owner'}]};if(sql.includes('AS snapshot'))return {rows:[{snapshot:[]}]};return {rows:[]};}}\nmodule.exports={Client};\n`;
  await writeFile(dependency, safeDependency, { mode: 0o644 });
  const runtime = f.createRuntime({ launch: ((executable: string, args: readonly string[], options: any) => {
    writeFileSync(dependency, "throw new Error('substituted dependency executed');\n", { mode: 0o644 });
    return spawn(executable, [...args], options);
  }) as typeof spawn });
  const evidence = await runtime.collectDatabaseEvidence(runtime.privateConfiguration, f.context) as any;
  assert.equal(evidence.databaseOwner, "control_room_schema_owner");
  assert.equal(await readFile(marker, "utf8"), "captured");
});

test("stdout overflow and deadline cancellation remain uncertain even when the child exits zero", async t => {
  for (const mode of ["overflow", "deadline"] as const) {
    const f = await fixture(t); await writeFile(f.modePath, `${mode}\n`, { mode: 0o600 });
    const runtime = f.createRuntime({ controlDeadlineMs: mode === "deadline" ? 20 : 2_000 });
    await assert.rejects(runtime.provisionDatabase(runtime.privateConfiguration, f.context),
      /private_postgres_owner_adapter_uncertain/u);
  }
});

function fakeChild(schedule: (child: any) => void) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = [] as string[]; child.kill = (signal: string) => { child.kills.push(signal); return true; };
  queueMicrotask(() => schedule(child)); return child;
}

test("a failed stage deletion is permanently latched and cleanup cannot later report success", async t => {
  const f = await fixture(t); let replacementMarker: string | undefined;
  const runtime = f.createRuntime({ launch: ((executable: string) => {
    const stageRoot = join(executable, "../..");
    const held = `${stageRoot}.held`;
    renameSync(stageRoot, held); mkdirSync(stageRoot, { mode: 0o700 });
    replacementMarker = join(stageRoot, "replacement-marker");
    writeFileSync(replacementMarker, "preserve\n", { mode: 0o600 });
    return fakeChild(child => { child.emit("error", new Error("pre-spawn")); child.emit("close", null, null); });
  }) as typeof spawn });
  await assert.rejects(runtime.provisionDatabase(runtime.privateConfiguration, f.context),
    /private_postgres_owner_adapter_uncertain/u);
  assert.ok(replacementMarker); assert.equal(await readFile(replacementMarker, "utf8"), "preserve\n");
  await assert.rejects(runtime.cleanup(new AbortController().signal), /private_postgres_owner_adapter_uncertain/u);
});

test("pre-spawn error is definite, while every pipe failure after spawn is irreversibly uncertain", async t => {
  const before = await fixture(t);
  const failedBefore = before.createRuntime({ launch: (() => fakeChild(child => {
    child.emit("error", new Error("exec refused")); child.emit("close", null, null);
  })) as typeof spawn });
  assert.deepEqual(await failedBefore.provisionDatabase(failedBefore.privateConfiguration, before.context),
    { outcome: "failed_before_effect" });

  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    const after = await fixture(t);
    const pipeFailed = after.createRuntime({ launch: (() => fakeChild(child => {
      child.emit("spawn"); child[stream].emit("error", new Error("pipe")); child.emit("close", 0, null);
    })) as typeof spawn });
    await assert.rejects(pipeFailed.provisionDatabase(pipeFailed.privateConfiguration, after.context),
      /private_postgres_owner_adapter_uncertain/u);
  }
});

test("an unreaped child is retained and makes bounded cleanup uncertain", async t => {
  const f = await fixture(t);
  const runtime = f.createRuntime({ cleanupDeadlineMs: 20, launch: (() => fakeChild(child => child.emit("spawn"))) as typeof spawn });
  await assert.rejects(runtime.provisionDatabase(runtime.privateConfiguration, f.context),
    /private_postgres_owner_adapter_uncertain/u);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(runtime.cleanup(controller.signal), /private_postgres_owner_adapter_uncertain/u); }
  finally { clearTimeout(timer); }
});
