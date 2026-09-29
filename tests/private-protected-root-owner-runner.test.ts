import assert from "node:assert/strict";
import test from "node:test";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PersistentLocalArtifactStorageV1 } from "../src/artifacts/v1/persistent-local-storage";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { sha256Digest } from "../src/security/canonical-digest";
import { PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1,
  type ProtectedDataRecoveryOwnerActionRequestV1 } from "../src/installer/v1/protected-data-recovery-owner-action";
import { PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1, PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1,
  runPrivateProtectedRootOwnerActionV1, type PrivateProtectedRootOwnerRuntimeV1 } from
  "../src/installer/v1/private-protected-root-owner-runner";

const digest = (value: unknown) => sha256Digest(value);
const priorBinding = digest("prior-protected-data-observation");

function configurationFor(rootPath: string) {
  return captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1", storageClass: "local",
    storageNamespace: "artifacts:owner-runner", rootPath, maximumArtifacts: 10, maximumFileBytes: 65_536,
    maximumTotalBytes: 655_360, operationTimeoutMs: 2_000 },
  { releaseId: "release:owner-runner", releaseDigest: digest("release"), databaseSchemaVersion: "schema:owner-runner",
    databaseSchemaDigest: digest("schema") });
}
function request(operation: "owner_create_private_data_root" | "verify_owner_private_data_root" | "bind_verified_protected_storage",
  configuration: ReturnType<typeof configurationFor>): ProtectedDataRecoveryOwnerActionRequestV1 {
  const precondition = operation === "owner_create_private_data_root" ? "owner_attendance_and_unowned_target"
    : operation === "verify_owner_private_data_root" ? "existing_candidate_and_owner_attendance" : "verified_private_root_only";
  return Object.freeze({ schema: PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1, action: "protected_data", stage: "protected_data",
    installationPlanDigest: digest("plan"), installationPlanRevision: 7, topologyPlanDigest: digest("topology"),
    releaseDigest: configuration.inventory.releaseDigest, preparationDigest: digest("preparation"), protectedDataBindingDigest: priorBinding,
    storageConfigurationDigest: digest({ purpose: "protected-artifact-storage-configuration/v1",
      local: configuration.local, inventory: configuration.inventory }), storageNamespaceDigest: configuration.inventory.storageNamespaceDigest,
    operation, precondition, tool: Object.freeze({ kind: "existing_private_storage_and_recovery_tools" as const,
      entrypoints: Object.freeze(["src/web/v1/private-artifact-storage.ts", "src/artifacts/v1/persistent-local-storage.ts"]) }),
    requiresOwnerPrivateConfiguration: true, performsEffect: false, opensStorage: false, runsBackup: false,
    runsRestore: false, promotesRestore: false, startsService: false, grantsExecutionAuthority: false });
}

async function fixture(t: test.TestContext, name: string) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), `acr-private-root-${name}-`)));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "results"), configuration = configurationFor(root), controller = new AbortController(), calls: string[] = [];
  const configDigest = digest({ purpose: "protected-artifact-storage-configuration/v1", local: configuration.local, inventory: configuration.inventory });
  const runtime: PrivateProtectedRootOwnerRuntimeV1 = {
    privateConfiguration: configuration, selectedParentPath: parent, selectedRootPath: root, signal: controller.signal,
    controlDeadlineMs: 500, async effectiveOwnerUid() { calls.push("effective-uid"); return userInfo().uid; },
    filesystem: {
      async lstat(path) { calls.push(`lstat:${path === parent ? "parent" : path === root ? "root" : "other"}`); return lstat(path); },
      async realpath(path) { calls.push(`realpath:${path === parent ? "parent" : path === root ? "root" : "other"}`); return realpath(path); },
      async createExactPrivateDirectory(path, parentIdentity, mode) {
        calls.push(`create:root:${mode.toString(8)}`); const current = await lstat(parent);
        if (current.dev !== parentIdentity.device || current.ino !== parentIdentity.inode) throw new Error("parent changed");
        await mkdir(path, { mode }); const created = await lstat(path); return { device: created.dev, inode: created.ino };
      },
    },
    async confirmOwnerAttachedTerminal(context) {
      calls.push("confirm-owner"); return { schema: PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1,
        requestDigest: context.requestDigest, operation: context.operation as "owner_create_private_data_root" | "verify_owner_private_data_root",
        ownerAttached: true, confirmed: true };
    },
    async preflightExistingStorage(local, context) {
      calls.push("preflight"); await PersistentLocalArtifactStorageV1.create(local);
      return { schema: PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1, requestDigest: context.requestDigest,
        priorProtectedDataBindingDigest: priorBinding, storageConfigurationDigest: configDigest,
        storageNamespaceDigest: configuration.inventory.storageNamespaceDigest, rootIdentityDigest: context.rootIdentityDigest,
        outcome: "verified" };
    },
  };
  return { parent, root, configuration, runtime, calls, controller, configDigest };
}

test("creates only the exact absent root, confirms the attached owner, and returns a redacted receipt-bound observation", async t => {
  const f = await fixture(t, "create"), result = await runPrivateProtectedRootOwnerActionV1(request("owner_create_private_data_root", f.configuration), f.runtime);
  assert.equal(result.observedState, "verified"); assert.equal(result.createdDirectory, true);
  assert.ok(f.calls.includes("confirm-owner")); assert.ok(f.calls.includes("create:root:700")); assert.ok(f.calls.includes("preflight"));
  assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(result), /acr-private-root|rootPath|password|credential/i);
});

test("existing candidates are only inspected and preflighted; a create request refuses them", async t => {
  const f = await fixture(t, "existing"); await mkdir(f.root, { mode: 0o700 });
  const result = await runPrivateProtectedRootOwnerActionV1(request("verify_owner_private_data_root", f.configuration), f.runtime);
  assert.equal(result.createdDirectory, false); assert.equal(f.calls.some(item => item.startsWith("create:")), false);
  await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("owner_create_private_data_root", f.configuration), f.runtime),
    /private_protected_root_owner_runner_refused/);
  assert.equal((await lstat(f.root)).isDirectory(), true);
});

test("canonical paths, captured root, derived effective UID, exact confirmation and 0700 modes are required", async t => {
  const f = await fixture(t, "authority");
  for (const changed of [
    { ...f.runtime, selectedParentPath: `${f.parent}/` },
    { ...f.runtime, selectedRootPath: join(f.parent, "other") },
    { ...f.runtime, privateConfiguration: configurationFor(join(f.parent, "other")) },
    { ...f.runtime, effectiveOwnerUid: async () => userInfo().uid + 1 },
    { ...f.runtime, confirmOwnerAttachedTerminal: async (context: { requestDigest: string }) => ({
      schema: PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1, requestDigest: digest(context.requestDigest),
      operation: "owner_create_private_data_root" as const, ownerAttached: true as const, confirmed: true as const }) },
  ]) await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("owner_create_private_data_root", f.configuration), changed),
    /private_protected_root_owner_runner_refused/);
  assert.equal(f.calls.some(item => item.startsWith("create:") || item === "preflight"), false);
  await mkdir(f.root, { mode: 0o755 });
  await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("verify_owner_private_data_root", f.configuration), f.runtime),
    /private_protected_root_owner_runner_refused/);
  assert.equal((await lstat(f.root)).mode & 0o777, 0o755);
});

test("preflight requires one exact structured receipt bound to request, prior evidence and root identity", async t => {
  for (const result of [undefined, {}, { schema: PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1, outcome: "verified" }] as const) {
    const f = await fixture(t, "receipt"); await mkdir(f.root, { mode: 0o700 });
    await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("verify_owner_private_data_root", f.configuration), {
      ...f.runtime, async preflightExistingStorage() { return result as never; },
    }), /private_protected_root_owner_runner_refused/);
    assert.equal((await lstat(f.root)).isDirectory(), true);
  }
});

test("post-create failure, abort, and deadline become non-retryable uncertainty and preserve the created root", async t => {
  for (const kind of ["preflight", "abort", "timeout"] as const) {
    const f = await fixture(t, kind);
    const runtime = { ...f.runtime,
      controlDeadlineMs: kind === "timeout" ? 10 : f.runtime.controlDeadlineMs,
      filesystem: { ...f.runtime.filesystem, async createExactPrivateDirectory(path: string, parent: { device: number; inode: number }, mode: number) {
        const value = await f.runtime.filesystem.createExactPrivateDirectory(path, parent, mode);
        if (kind === "abort") f.controller.abort(); return value;
      } },
      async preflightExistingStorage(local: typeof f.configuration.local, context: Parameters<typeof f.runtime.preflightExistingStorage>[1]) {
        if (kind === "preflight") throw new Error(`private preflight ${f.root}`);
        if (kind === "timeout") return new Promise<never>(() => {});
        return f.runtime.preflightExistingStorage(local, context);
      },
    };
    await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("owner_create_private_data_root", f.configuration), runtime),
      /private_protected_root_owner_runner_uncertain/, kind);
    assert.equal((await lstat(f.root)).isDirectory(), true, kind);
  }
});

test("a deterministic parent substitution race is uncertainty and does not preflight the replacement tree", async t => {
  const f = await fixture(t, "substitution"), moved = `${f.parent}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const runtime = { ...f.runtime, filesystem: { ...f.runtime.filesystem,
    async createExactPrivateDirectory(path: string, _parent: { device: number; inode: number }, mode: number) {
      await rename(f.parent, moved); await mkdir(f.parent, { mode: 0o700 }); await mkdir(path, { mode });
      const value = await lstat(path); return { device: value.dev, inode: value.ino };
    },
  } };
  await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("owner_create_private_data_root", f.configuration), runtime),
    /private_protected_root_owner_runner_uncertain/);
  assert.equal((await lstat(f.root)).isDirectory(), true); assert.equal(f.calls.includes("preflight"), false);
});

test("symlinks, foreign entries, stale locks and linked valid artifacts refuse without deletion", async t => {
  for (const kind of ["symlink", "foreign", "lock", "hardlink"] as const) {
    const f = await fixture(t, kind);
    if (kind === "symlink") { const outside = join(f.parent, "outside"); await mkdir(outside, { mode: 0o700 }); await symlink(outside, f.root); }
    else {
      await mkdir(f.root, { mode: 0o700 });
      if (kind === "foreign") await writeFile(join(f.root, "foreign"), "preserve", { mode: 0o600 });
      if (kind === "lock") await writeFile(join(f.root, ".control-room-persistent-artifact.lock"), "stale", { mode: 0o600 });
      if (kind === "hardlink") {
        const storage = await PersistentLocalArtifactStorageV1.create(f.configuration.local);
        await storage.put({ artifactId: `artifact:native:${"a".repeat(64)}`, bytes: new TextEncoder().encode("verified artifact") });
        const artifact = (await readdir(f.root)).find(entry => entry.endsWith(".artifact")); assert.ok(artifact);
        await link(join(f.root, artifact), join(f.parent, "outside"));
      }
    }
    await assert.rejects(runPrivateProtectedRootOwnerActionV1(request("verify_owner_private_data_root", f.configuration), f.runtime),
      /private_protected_root_owner_runner_refused/, kind);
    if (kind === "symlink") assert.equal((await lstat(f.root)).isSymbolicLink(), true);
    if (kind === "foreign") assert.equal(await readFile(join(f.root, "foreign"), "utf8"), "preserve");
    if (kind === "lock") assert.equal((await lstat(join(f.root, ".control-room-persistent-artifact.lock"))).isFile(), true);
    if (kind === "hardlink") assert.equal((await lstat(join(f.root, (await readdir(f.root)).find(item => item.endsWith(".artifact"))!))).nlink, 2);
  }
});
