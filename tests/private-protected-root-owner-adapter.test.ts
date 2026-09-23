import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1,
  createPrivateProtectedRootOwnerAdapterV1, runPrivateProtectedRootOwnerAdapterV1,
  type PrivateProtectedRootNativeCreateRequestV1, type PrivateProtectedRootNativeReceiptV1 } from
  "../src/installer/v1/private-protected-root-owner-adapter";
import { PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1,
  type ProtectedDataRecoveryOwnerActionRequestV1 } from "../src/installer/v1/protected-data-recovery-owner-action";
import { PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1,
  runPrivateProtectedRootOwnerActionV1,
  type PrivateProtectedRootRunnerContextV1 } from "../src/installer/v1/private-protected-root-owner-runner";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
const priorBinding = digest("adapter-prior-protected-data-observation");

function configurationFor(rootPath: string) {
  return captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1", storageClass: "local",
    storageNamespace: "artifacts:protected-root-adapter", rootPath, maximumArtifacts: 10, maximumFileBytes: 65_536,
    maximumTotalBytes: 655_360, operationTimeoutMs: 500 },
  { releaseId: "release:protected-root-adapter", releaseDigest: digest("release"),
    databaseSchemaVersion: "schema:protected-root-adapter", databaseSchemaDigest: digest("schema") });
}

function request(operation: "owner_create_private_data_root" | "verify_owner_private_data_root" | "bind_verified_protected_storage",
  configuration: ReturnType<typeof configurationFor>): ProtectedDataRecoveryOwnerActionRequestV1 {
  const precondition = operation === "owner_create_private_data_root" ? "owner_attendance_and_unowned_target"
    : operation === "verify_owner_private_data_root" ? "existing_candidate_and_owner_attendance" : "verified_private_root_only";
  return Object.freeze({ schema: PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1, action: "protected_data", stage: "protected_data",
    installationPlanDigest: digest("plan"), installationPlanRevision: 9, topologyPlanDigest: digest("topology"),
    releaseDigest: configuration.inventory.releaseDigest, preparationDigest: digest("preparation"),
    protectedDataBindingDigest: priorBinding,
    storageConfigurationDigest: digest({ purpose: "protected-artifact-storage-configuration/v1",
      local: configuration.local, inventory: configuration.inventory }),
    storageNamespaceDigest: configuration.inventory.storageNamespaceDigest, operation, precondition,
    tool: Object.freeze({ kind: "existing_private_storage_and_recovery_tools" as const,
      entrypoints: Object.freeze(["src/web/v1/private-artifact-storage.ts", "src/artifacts/v1/persistent-local-storage.ts"]) }),
    requiresOwnerPrivateConfiguration: true, performsEffect: false, opensStorage: false, runsBackup: false,
    runsRestore: false, promotesRestore: false, startsService: false, grantsExecutionAuthority: false });
}

async function fixture(t: test.TestContext, name: string) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), `acr-protected-adapter-${name}-`)));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "results"), configuration = configurationFor(root), controller = new AbortController();
  const calls: string[] = [];
  const create = async (input: PrivateProtectedRootNativeCreateRequestV1): Promise<PrivateProtectedRootNativeReceiptV1> => {
    calls.push("native-create");
    assert.equal(input.schema, PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1);
    assert.equal(input.parentPath, parent); assert.equal(input.childName, "results");
    assert.equal(input.expectedOwnerUid, process.geteuid?.()); assert.equal(input.mode, 0o700);
    assert.equal(input.signal, controller.signal); assert.ok(input.deadlineUnixMs > Date.now());
    const before = await lstat(parent);
    assert.deepEqual(input.expectedParentIdentity, { device: before.dev, inode: before.ino });
    assert.equal(before.uid, input.expectedOwnerUid); assert.equal(before.mode & 0o777, 0o700);
    await mkdir(join(input.parentPath, input.childName), { mode: input.mode });
    const after = await lstat(root);
    return Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1, operation: "mkdirat_then_fstatat",
      parentIdentity: input.expectedParentIdentity, rootIdentity: Object.freeze({ device: after.dev, inode: after.ino }),
      ownerUid: after.uid, mode: 0o700, created: true, directory: true, symbolicLink: false,
      parentOpenedNoFollow: true, childInspectedNoFollow: true });
  };
  const nativeDirectory = { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, createOnePrivateChild: create };
  const terminal = { async confirmOwnerAttachedTerminal(context: PrivateProtectedRootRunnerContextV1) {
    calls.push("terminal");
    assert.notEqual(context.operation, "bind_verified_protected_storage");
    return { schema: PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1, requestDigest: context.requestDigest,
      operation: context.operation as "owner_create_private_data_root" | "verify_owner_private_data_root",
      ownerAttached: true as const, confirmed: true as const };
  } };
  const adapterInput = {
    privateConfiguration: configuration, selectedParentPath: parent, selectedRootPath: root,
    signal: controller.signal, controlDeadlineMs: 300,
    nativeDirectory, terminal,
  } as const;
  return { parent, root, configuration, controller, calls, create, nativeDirectory, terminal, adapterInput };
}

test("binds derived effective UID, attached terminal, native descriptor receipt and existing preflight", async t => {
  const f = await fixture(t, "success");
  const result = await runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), f.adapterInput);
  assert.equal(result.observedState, "verified"); assert.equal(result.createdDirectory, true);
  assert.deepEqual(f.calls, ["terminal", "native-create"]);
  assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(result), /acr-protected-adapter|rootPath|parentPath|password|secret|credential/iu);
});

test("symlinks, non-private permissions and foreign contents refuse without repair or deletion", async t => {
  {
    const f = await fixture(t, "symlink"), outside = join(f.parent, "outside");
    await mkdir(outside, { mode: 0o700 }); await symlink(outside, f.root);
    await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("verify_owner_private_data_root", f.configuration), f.adapterInput),
      /private_protected_root_owner_runner_refused/u);
    assert.equal((await lstat(f.root)).isSymbolicLink(), true); assert.deepEqual(f.calls, ["terminal"]);
  }
  {
    const f = await fixture(t, "permissions"); await chmod(f.parent, 0o755);
    await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), f.adapterInput),
      /private_protected_root_owner_runner_refused/u);
    assert.deepEqual(f.calls, ["terminal"]); assert.equal((await lstat(f.parent)).mode & 0o777, 0o755);
  }
  {
    const f = await fixture(t, "foreign"); await mkdir(f.root, { mode: 0o700 });
    const foreign = join(f.root, "foreign-owner-file"); await writeFile(foreign, "preserve", { mode: 0o600 });
    await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("verify_owner_private_data_root", f.configuration), f.adapterInput),
      /private_protected_root_owner_runner_refused/u);
    assert.equal(await readFile(foreign, "utf8"), "preserve"); assert.deepEqual(f.calls, ["terminal"]);
  }
});

test("parent rename and substitution during the native window is uncertainty and never preflights", async t => {
  const f = await fixture(t, "rename"), moved = `${f.parent}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const adapterInput = { ...f.adapterInput, nativeDirectory: { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
    async createOnePrivateChild(input: PrivateProtectedRootNativeCreateRequestV1) {
      f.calls.push("native-race"); await rename(f.parent, moved); await mkdir(f.parent, { mode: 0o700 });
      const replacement = await lstat(f.parent);
      assert.notDeepEqual({ device: replacement.dev, inode: replacement.ino }, input.expectedParentIdentity);
      throw new Error(`changed ${input.parentPath}`);
    } } } as const;
  await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), adapterInput),
    /private_protected_root_owner_runner_uncertain/u);
  assert.deepEqual(f.calls, ["terminal", "native-race"]);
  await assert.rejects(lstat(f.root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("a forged native no-follow receipt is uncertainty and preserves any created directory", async t => {
  const f = await fixture(t, "receipt");
  const adapterInput = { ...f.adapterInput, nativeDirectory: { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
    async createOnePrivateChild(input: PrivateProtectedRootNativeCreateRequestV1) {
      const receipt = await f.create(input);
      return { ...receipt, childInspectedNoFollow: false } as unknown as PrivateProtectedRootNativeReceiptV1;
    } } } as const;
  await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), adapterInput),
    /private_protected_root_owner_runner_uncertain/u);
  assert.equal((await lstat(f.root)).isDirectory(), true);
});

test("abort and deadline after native entry are uncertainty; pre-abort refuses without entry", async t => {
  {
    const f = await fixture(t, "pre-abort"); f.controller.abort();
    await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), f.adapterInput),
      /private_protected_root_owner_runner_refused/u);
    assert.deepEqual(f.calls, []);
  }
  {
    const f = await fixture(t, "abort");
    const adapterInput = { ...f.adapterInput, nativeDirectory: { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
      async createOnePrivateChild(input: PrivateProtectedRootNativeCreateRequestV1) {
        const receipt = await f.create(input); f.controller.abort(); return receipt;
      } } } as const;
    await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), adapterInput),
      /private_protected_root_owner_runner_uncertain/u);
    assert.equal((await lstat(f.root)).isDirectory(), true);
  }
  {
    const f = await fixture(t, "deadline");
    const adapterInput = { ...f.adapterInput, controlDeadlineMs: 15,
      nativeDirectory: { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
        async createOnePrivateChild() { f.calls.push("native-hang"); return new Promise<never>(() => {}); } } } as const;
    await assert.rejects(runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), adapterInput),
      /private_protected_root_owner_runner_uncertain/u);
    assert.deepEqual(f.calls, ["terminal", "native-hang"]);
  }
});

test("the adapter rejects a path-based or unbranded creation object instead of providing a fallback", async t => {
  const f = await fixture(t, "blocker");
  await assert.rejects(async () => runPrivateProtectedRootOwnerAdapterV1(request("owner_create_private_data_root", f.configuration), {
    ...f.adapterInput, nativeDirectory: { async createOnePrivateChild() { throw new Error("must not run"); } },
  }), /private_protected_root_owner_adapter_refused/u);
  await assert.rejects(lstat(f.root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("a native create method swap while attached-terminal confirmation is delayed cannot change the captured callable", async t => {
  const f = await fixture(t, "native-method-swap"), selected = request("owner_create_private_data_root", f.configuration);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminalEntered = new Promise<void>(resolve => { entered = resolve; });
  const terminal = { async confirmOwnerAttachedTerminal(context: PrivateProtectedRootRunnerContextV1) {
    f.calls.push("terminal-delayed"); entered(); await gate;
    return { schema: PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1, requestDigest: context.requestDigest,
      operation: context.operation as "owner_create_private_data_root", ownerAttached: true as const, confirmed: true as const };
  } };
  const nativeDirectory = { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
    createOnePrivateChild: f.create };
  const runtime = createPrivateProtectedRootOwnerAdapterV1(selected,
    { ...f.adapterInput, nativeDirectory, terminal });
  const attempt = runPrivateProtectedRootOwnerActionV1(selected, runtime);
  await terminalEntered;
  nativeDirectory.createOnePrivateChild = async () => {
    f.calls.push("swapped-native"); throw new Error("must not run");
  };
  release();
  const result = await attempt;
  assert.equal(result.observedState, "verified");
  assert.deepEqual(f.calls, ["terminal-delayed", "native-create"]);
});

test("a terminal confirmation method swap after runtime capture cannot change the captured callable", async t => {
  const f = await fixture(t, "terminal-method-swap"), selected = request("owner_create_private_data_root", f.configuration);
  const terminal = { confirmOwnerAttachedTerminal: f.terminal.confirmOwnerAttachedTerminal };
  const runtime = createPrivateProtectedRootOwnerAdapterV1(selected,
    { ...f.adapterInput, terminal });
  const attempt = runPrivateProtectedRootOwnerActionV1(selected, runtime);
  terminal.confirmOwnerAttachedTerminal = async context => {
    f.calls.push("swapped-terminal");
    return { schema: PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1, requestDigest: context.requestDigest,
      operation: context.operation as "owner_create_private_data_root", ownerAttached: true as const, confirmed: true as const };
  };
  const result = await attempt;
  assert.equal(result.observedState, "verified");
  assert.deepEqual(f.calls, ["terminal", "native-create"]);
});
