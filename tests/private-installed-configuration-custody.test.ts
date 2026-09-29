import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalJson } from "../src/security/canonical-digest";
import { consumePrivateInstalledClaudeProcessReleaseCapabilityV1, createPrivateInstalledConfigurationCustodyV1,
  createPrivateInstalledConfigurationCustodyV2, createPrivateInstalledConfigurationCustodyV3,
  PRIVATE_INSTALLED_CLAUDE_PROCESS_SIDECAR_IDENTITY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
  PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
  PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";

const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const encoded = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`, "utf8");

async function fixture(t: TestContext, configurationValue: unknown = {
  value: "private-data", nested: { permitted: true }, operatorFactory: "data-not-code",
}) {
  const root = await mkdtemp(join(process.cwd(), ".private-installed-custody-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const ownerUid = process.geteuid!(), configuration = encoded(configurationValue);
  const configurationName = "operator.json", journalName = "installation-journal", configurationPath = join(root, configurationName);
  await writeFile(configurationPath, configuration, { mode: 0o600 }); await chmod(configurationPath, 0o600);
  await mkdir(join(root, journalName), { mode: 0o700 }); await chmod(join(root, journalName), 0o700);
  const manifest = { schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, installationId: "local-hermes",
    ownerUid, configuration: { name: configurationName, bytes: configuration.length, sha256: digest(configuration) },
    journal: { directoryName: journalName } };
  const manifestBytes = encoded(manifest), manifestPath = join(root, "installed-manifest.json");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 }); await chmod(manifestPath, 0o600);
  const calls: string[] = [];
  const native = { async verifyProtectedPath(request: any) {
    calls.push(request.kind);
    return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified", descriptor: request.descriptor,
      device: request.identity.device, inode: request.identity.inode, ownerUid: request.identity.ownerUid,
      mode: request.identity.mode, extendedAcl: false, ancestorVerified: true };
  } };
  const input = { schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, manifestPath,
    manifestBytes: manifestBytes.length, manifestSha256: digest(manifestBytes), expectedOwnerUid: ownerUid,
    verificationDeadlineMs: 1_000, native };
  return { root, manifestPath, configurationPath, journalPath: join(root, journalName), manifest, manifestBytes,
    input, calls, native, configuration };
}

async function fixtureV2(t: TestContext) {
  const base = await fixture(t);
  const nativeSidecar = {
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: "0.1.0",
    portableReleaseManifestSha256: `sha256:${"1".repeat(64)}`,
    outerLauncherManifestSha256: `sha256:${"2".repeat(64)}`,
    sidecarManifestSha256: `sha256:${"3".repeat(64)}`,
    archiveSha256: `sha256:${"4".repeat(64)}`,
    artifactManifestSha256: `sha256:${"5".repeat(64)}`,
    executableSha256: `sha256:${"6".repeat(64)}`,
    platform: "darwin" as const,
    protocol: "ACRJNL1" as const,
    architecture: "arm64" as const,
  };
  const manifest = { ...base.manifest, schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
    journal: { ...base.manifest.journal, nativeSidecar } };
  const manifestBytes = encoded(manifest);
  await writeFile(base.manifestPath, manifestBytes, { mode: 0o600 }); await chmod(base.manifestPath, 0o600);
  const input = { ...base.input, schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
    manifestBytes: manifestBytes.length, manifestSha256: digest(manifestBytes) };
  return { ...base, manifest, manifestBytes, input, nativeSidecar };
}

async function fixtureV3(t: TestContext) {
  const base = await fixtureV2(t);
  const claudeCodeProcessNativeSidecar = {
    schema: PRIVATE_INSTALLED_CLAUDE_PROCESS_SIDECAR_IDENTITY_V1, releaseVersion: "0.1.0",
    releaseSha256: `sha256:${"7".repeat(64)}`, sidecarManifestSha256: `sha256:${"8".repeat(64)}`,
    archiveSha256: `sha256:${"9".repeat(64)}`, artifactManifestSha256: `sha256:${"a".repeat(64)}`,
    executableSha256: `sha256:${"b".repeat(64)}`, platform: "darwin" as const, architecture: "arm64" as const,
    minimumMacos: "13.0" as const, protocol: "ACRCCP1" as const,
  };
  const manifest = { ...base.manifest, schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
    claudeCodeProcessNativeSidecar };
  const manifestBytes = encoded(manifest);
  await writeFile(base.manifestPath, manifestBytes, { mode: 0o600 }); await chmod(base.manifestPath, 0o600);
  const input = { ...base.input, schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3,
    manifestBytes: manifestBytes.length, manifestSha256: digest(manifestBytes) };
  return { ...base, manifest, manifestBytes, input, claudeCodeProcessNativeSidecar };
}

test("fixed custody returns canonical data but explicitly blocks journal and operator composition", async t => {
  const f = await fixture(t), composition = await createPrivateInstalledConfigurationCustodyV1(f.input);
  assert.equal(composition.status, "configuration_ready");
  if (composition.status !== "configuration_ready") return assert.fail("expected configuration-ready custody");
  assert.equal(composition.schema, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1);
  assert.deepEqual(composition.operatorComposition,
    { status: "blocked", blocker: "native_journal_operation_custody_missing" });
  assert.equal("journal" in composition, false);
  assert.equal(composition.dataOnly, true);
  assert.equal(composition.operatorDependencies, "injected_separately");
  const data = await composition.custody.loadPrivateConfigurationData();
  assert.deepEqual(data, { nested: { permitted: true }, operatorFactory: "data-not-code", value: "private-data" });
  assert.equal(Object.isFrozen(data), true);
  assert.ok(f.calls.includes("ancestor")); assert.ok(f.calls.includes("manifest")); assert.ok(f.calls.includes("journal"));
  assert.ok(f.calls.includes("configuration"));
  assert.equal(composition.performsEffect, false); assert.equal(composition.createsDirectory, false);
  assert.equal(composition.repairsDirectory, false); assert.equal(composition.loadsModule, false);
  assert.equal(composition.loadsCallback, false);
});

test("v2 returns an inert manifest-bound sidecar and original journal identity as frozen data", async t => {
  const f = await fixtureV2(t), journalIdentity = await lstat(f.journalPath);
  const composition = await createPrivateInstalledConfigurationCustodyV2(f.input);
  assert.equal(composition.status, "manifest_bound_configuration_ready");
  if (composition.status !== "manifest_bound_configuration_ready") return assert.fail("expected v2 custody");
  assert.deepEqual(composition.operatorComposition,
    { status: "blocked", blocker: "native_journal_operation_custody_missing" });
  assert.equal(composition.writesInstalledManifest, false); assert.equal(composition.autoUpgradesManifest, false);
  assert.equal(composition.stagesNativeSidecar, false); assert.equal(composition.constructsJournal, false);
  const prepared = await composition.custody.loadManifestBoundPrivateConfigurationData();
  assert.equal(prepared.schema, PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1);
  assert.equal(prepared.installationId, "local-hermes");
  assert.deepEqual(prepared.privateConfigurationData,
    { nested: { permitted: true }, operatorFactory: "data-not-code", value: "private-data" });
  assert.deepEqual(prepared.journal, { rootPath: f.journalPath,
    expectedRootIdentity: { device: journalIdentity.dev, inode: journalIdentity.ino },
    expectedOwnerUid: process.geteuid!(), expectedRootMode: 0o700 });
  assert.deepEqual(prepared.nativeSidecar, f.nativeSidecar);
  assert.equal(prepared.dataOnly, true); assert.equal(prepared.opensJournal, false);
  assert.equal(prepared.constructsJournal, false); assert.equal(prepared.stagesNativeSidecar, false);
  assert.equal(prepared.performsNativeOperation, false); assert.equal(prepared.writesInstalledManifest, false);
  assert.equal(prepared.autoUpgradesManifest, false);
  assert.equal(Object.isFrozen(prepared), true); assert.equal(Object.isFrozen(prepared.journal), true);
  assert.equal(Object.isFrozen(prepared.journal.expectedRootIdentity), true);
  assert.equal(Object.isFrozen(prepared.nativeSidecar), true);
  assert.equal(Object.isFrozen(prepared.privateConfigurationData), true);
  assert.equal(Object.isFrozen((prepared.privateConfigurationData as any).nested), true);
  assert.equal("executablePath" in prepared.nativeSidecar, false);
  assert.equal("installationJournalNativeFactoryInput" in prepared, false);
});

test("v1 stays blocked and v1/v2 manifests are never auto-upgraded across APIs", async t => {
  const old = await fixture(t);
  const v1 = await createPrivateInstalledConfigurationCustodyV1(old.input);
  assert.equal(v1.status, "configuration_ready");
  if (v1.status === "configuration_ready") assert.deepEqual(v1.operatorComposition,
    { status: "blocked", blocker: "native_journal_operation_custody_missing" });
  await assert.rejects(createPrivateInstalledConfigurationCustodyV2({ ...old.input,
    schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2 }), /private_installed_configuration_custody_refused/u);

  const current = await fixtureV2(t);
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...current.input,
    schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1 }), /private_installed_configuration_custody_refused/u);
  assert.deepEqual(await readFile(old.manifestPath), old.manifestBytes);
  assert.deepEqual(await readFile(current.manifestPath), current.manifestBytes);
});

test("v3 binds one opaque Claude helper release capability without accepting v1/v2 as upgrades", async t => {
  const f = await fixtureV3(t), composition = await createPrivateInstalledConfigurationCustodyV3(f.input);
  assert.equal(composition.status, "manifest_bound_configuration_ready");
  if (composition.status !== "manifest_bound_configuration_ready") return;
  const prepared = await composition.custody.loadManifestBoundPrivateConfigurationData();
  assert.deepEqual(consumePrivateInstalledClaudeProcessReleaseCapabilityV1(
    prepared.claudeCodeProcessReleaseCapability), f.claudeCodeProcessNativeSidecar);
  assert.throws(() => consumePrivateInstalledClaudeProcessReleaseCapabilityV1(
    prepared.claudeCodeProcessReleaseCapability), /private_installed_configuration_custody_refused/u);
  assert.equal(prepared.writesInstalledManifest, false); assert.equal(prepared.autoUpgradesManifest, false);
  const v2 = await fixtureV2(t);
  await assert.rejects(createPrivateInstalledConfigurationCustodyV3({ ...v2.input,
    schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3 }), /private_installed_configuration_custody_refused/u);
  await assert.rejects(createPrivateInstalledConfigurationCustodyV2({ ...f.input,
    schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2 }), /private_installed_configuration_custody_refused/u);
});

test("v3 refuses omitted, extra, malformed, or architecture-drifted Claude sidecars", async t => {
  const f = await fixtureV3(t);
  const mutations = [
    undefined,
    { ...f.claudeCodeProcessNativeSidecar, extra: true },
    { ...f.claudeCodeProcessNativeSidecar, protocol: "OTHER" },
    { ...f.claudeCodeProcessNativeSidecar, architecture: "universal" },
    { ...f.claudeCodeProcessNativeSidecar, releaseSha256: `sha256:${"z".repeat(64)}` },
  ];
  for (const claudeCodeProcessNativeSidecar of mutations) {
    const manifest = { ...f.manifest } as Record<string, unknown>;
    if (claudeCodeProcessNativeSidecar === undefined) delete manifest.claudeCodeProcessNativeSidecar;
    else manifest.claudeCodeProcessNativeSidecar = claudeCodeProcessNativeSidecar;
    const bytes = encoded(manifest); await writeFile(f.manifestPath, bytes, { mode: 0o600 });
    await assert.rejects(createPrivateInstalledConfigurationCustodyV3({ ...f.input,
      manifestBytes: bytes.length, manifestSha256: digest(bytes) }), /private_installed_configuration_custody_refused/u);
  }
});

test("v2 refuses journal replacement across reread and preserves both directories", async t => {
  const f = await fixtureV2(t), composition = await createPrivateInstalledConfigurationCustodyV2(f.input);
  assert.equal(composition.status, "manifest_bound_configuration_ready");
  if (composition.status !== "manifest_bound_configuration_ready") return;
  const original = `${f.journalPath}.original`;
  t.after(() => rm(original, { recursive: true, force: true }));
  await rename(f.journalPath, original); await mkdir(f.journalPath, { mode: 0o700 }); await chmod(f.journalPath, 0o700);
  await writeFile(join(f.journalPath, "replacement-marker"), "preserve\n", { mode: 0o600 });
  await assert.rejects(composition.custody.loadManifestBoundPrivateConfigurationData(),
    /private_installed_configuration_custody_refused/u);
  assert.equal(await readFile(join(f.journalPath, "replacement-marker"), "utf8"), "preserve\n");
  assert.equal((await lstat(original)).isDirectory(), true);
});

test("v2 sidecar tuple is canonical and exact", async t => {
  const f = await fixtureV2(t);
  const mutations = [
    { ...f.nativeSidecar, releaseVersion: "latest" },
    { ...f.nativeSidecar, platform: "linux" },
    { ...f.nativeSidecar, protocol: "OTHER" },
    { ...f.nativeSidecar, architecture: "universal" },
    { ...f.nativeSidecar, executableSha256: `sha256:${"z".repeat(64)}` },
    { ...f.nativeSidecar, extra: true },
  ];
  for (const nativeSidecar of mutations) {
    const manifest = { ...f.manifest, journal: { ...f.manifest.journal, nativeSidecar } };
    const manifestBytes = encoded(manifest);
    await writeFile(f.manifestPath, manifestBytes, { mode: 0o600 }); await chmod(f.manifestPath, 0o600);
    await assert.rejects(createPrivateInstalledConfigurationCustodyV2({ ...f.input,
      manifestBytes: manifestBytes.length, manifestSha256: digest(manifestBytes) }),
    /private_installed_configuration_custody_refused/u);
  }
});

test("v2 captures mutable inputs and rejects proxy or getter seams without invoking them", async t => {
  const f = await fixtureV2(t), input = { ...f.input }, native = f.native;
  const composition = await createPrivateInstalledConfigurationCustodyV2(input);
  assert.equal(composition.status, "manifest_bound_configuration_ready");
  if (composition.status !== "manifest_bound_configuration_ready") return;
  input.manifestPath = "/private/replacement";
  native.verifyProtectedPath = async () => { throw new Error("mutated"); };
  assert.equal((await composition.custody.loadManifestBoundPrivateConfigurationData()).installationId, "local-hermes");
  assert.deepEqual(await createPrivateInstalledConfigurationCustodyV2({ ...f.input, native: new Proxy(f.native, {}) }), {
    schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2, status: "blocked",
    blocker: "native_custody_verifier_missing", performsEffect: false, createsDirectory: false,
    repairsDirectory: false, loadsModule: false, loadsCallback: false,
  });
  let getterCalls = 0;
  const accessor = { ...f.input } as Record<string, unknown>;
  Object.defineProperty(accessor, "native", { enumerable: true, get() { getterCalls++; return f.native; } });
  assert.equal((await createPrivateInstalledConfigurationCustodyV2(accessor)).status, "blocked");
  assert.equal(getterCalls, 0);
});

test("manifest digest and exact byte length are trusted inputs, not self-assertions", async t => {
  const f = await fixture(t);
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input,
    manifestBytes: f.manifestBytes.length + 1 }), /private_installed_configuration_custody_refused/u);
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input,
    manifestSha256: `sha256:${"0".repeat(64)}` }), /private_installed_configuration_custody_refused/u);
  await writeFile(f.manifestPath, Buffer.concat([f.manifestBytes, Buffer.from(" ")]), { mode: 0o600 });
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1(f.input),
    /private_installed_configuration_custody_refused/u);
});

test("configuration length, digest, mode and link count all fail closed on each load", async t => {
  const f = await fixture(t), composition = await createPrivateInstalledConfigurationCustodyV1(f.input);
  assert.equal(composition.status, "configuration_ready");
  if (composition.status !== "configuration_ready") return;
  await writeFile(f.configurationPath, Buffer.concat([f.configuration, Buffer.from(" ")]), { mode: 0o600 });
  await assert.rejects(composition.custody.loadPrivateConfigurationData(),
    /private_installed_configuration_custody_refused/u);
  await writeFile(f.configurationPath, f.configuration, { mode: 0o600 }); await chmod(f.configurationPath, 0o644);
  await assert.rejects(composition.custody.loadPrivateConfigurationData(),
    /private_installed_configuration_custody_refused/u);
  await chmod(f.configurationPath, 0o600);
  const secondName = join(f.root, "configuration-hard-link"); await link(f.configurationPath, secondName);
  await assert.rejects(composition.custody.loadPrivateConfigurationData(),
    /private_installed_configuration_custody_refused/u);
});

test("JSON remains frozen data and cannot provide callable operator dependencies", async t => {
  const f = await fixture(t, { verifyExactRelease: "pretend-callback", nested: { execute: false } });
  const composition = await createPrivateInstalledConfigurationCustodyV1(f.input);
  assert.equal(composition.status, "configuration_ready");
  if (composition.status !== "configuration_ready") return;
  const data = await composition.custody.loadPrivateConfigurationData() as Record<string, unknown>;
  assert.equal(data.verifyExactRelease, "pretend-callback");
  assert.notEqual(typeof data.verifyExactRelease, "function");
  assert.equal(composition.loadsCallback, false);
  assert.equal(composition.operatorDependencies, "injected_separately");
});

test("descriptor-to-name file substitution is detected and the replacement is preserved", async t => {
  const f = await fixture(t), captured = `${f.manifestPath}.captured`; let replaced = false;
  t.after(() => rm(captured, { force: true }));
  const native = { async verifyProtectedPath(request: any) {
    if (!replaced && request.kind === "manifest") {
      replaced = true;
      await rename(f.manifestPath, captured);
      await writeFile(f.manifestPath, f.manifestBytes, { mode: 0o600 });
    }
    return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified", descriptor: request.descriptor,
      device: request.identity.device, inode: request.identity.inode, ownerUid: request.identity.ownerUid,
      mode: request.identity.mode, extendedAcl: false, ancestorVerified: true };
  } };
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input, native }),
    /private_installed_configuration_custody_refused/u);
  assert.deepEqual(await readFile(f.manifestPath), f.manifestBytes);
  assert.deepEqual(await readFile(captured), f.manifestBytes);
});

test("protected ancestor substitution is detected and no replacement is deleted", async t => {
  const f = await fixture(t), held = `${f.root}.held`, rootIdentity = await lstat(f.root); let replaced = false;
  t.after(() => rm(held, { recursive: true, force: true }));
  const native = { async verifyProtectedPath(request: any) {
    if (!replaced && request.kind === "ancestor" && request.identity.device === rootIdentity.dev
      && request.identity.inode === rootIdentity.ino) {
      replaced = true; await rename(f.root, held); await mkdir(f.root, { mode: 0o700 });
      await writeFile(join(f.root, "replacement-marker"), "preserve\n", { mode: 0o600 });
    }
    return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified", descriptor: request.descriptor,
      device: request.identity.device, inode: request.identity.inode, ownerUid: request.identity.ownerUid,
      mode: request.identity.mode, extendedAcl: false, ancestorVerified: true };
  } };
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input, native }),
    /private_installed_configuration_custody_refused/u);
  assert.equal(await readFile(join(f.root, "replacement-marker"), "utf8"), "preserve\n");
});

test("native ACL refusal and a proxied verifier cannot cross the boundary", async t => {
  const f = await fixture(t);
  const badNative = { verifyProtectedPath: async (request: any) => ({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1,
    outcome: "verified", descriptor: request.descriptor, device: request.identity.device, inode: request.identity.inode,
    ownerUid: request.identity.ownerUid, mode: request.identity.mode, extendedAcl: true, ancestorVerified: true }) };
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input, native: badNative }),
    /private_installed_configuration_custody_refused/u);
  const proxiedNative = new Proxy(f.native, {});
  assert.deepEqual(await createPrivateInstalledConfigurationCustodyV1({ ...f.input, native: proxiedNative }), {
    schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, status: "blocked",
    blocker: "native_custody_verifier_missing", performsEffect: false, createsDirectory: false,
    repairsDirectory: false, loadsModule: false, loadsCallback: false,
  });
});

test("the custody reader accepts truthful harmless ACL evidence only for ordinary ancestors", async t => {
  const f = await fixture(t), protectedIdentity = await lstat(f.root);
  const native = { async verifyProtectedPath(request: any) {
    return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified",
      descriptor: request.descriptor, device: request.identity.device, inode: request.identity.inode,
      ownerUid: request.identity.ownerUid, mode: request.identity.mode,
      extendedAcl: request.kind === "ancestor" && request.identity.inode !== protectedIdentity.ino,
      ancestorVerified: true };
  } };
  const composition = await createPrivateInstalledConfigurationCustodyV1({ ...f.input, native });
  assert.equal(composition.status, "configuration_ready");
  if (composition.status === "configuration_ready") assert.deepEqual(await composition.custody.loadPrivateConfigurationData(),
    { nested: { permitted: true }, operatorFactory: "data-not-code", value: "private-data" });
  const protectedAcl = { async verifyProtectedPath(request: any) {
    return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, outcome: "verified",
      descriptor: request.descriptor, device: request.identity.device, inode: request.identity.inode,
      ownerUid: request.identity.ownerUid, mode: request.identity.mode, extendedAcl: true, ancestorVerified: true };
  } };
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input, native: protectedAcl }),
    /private_installed_configuration_custody_refused/u);
});

test("active cancellation aborts a running native verification", async t => {
  const f = await fixture(t), controller = new AbortController(); let entered = false, nativeAborted = false;
  const native = { async verifyProtectedPath(request: any) {
    entered = true;
    return await new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => {
      nativeAborted = true; reject(new Error("native-aborted"));
    }, { once: true }));
  } };
  const running = createPrivateInstalledConfigurationCustodyV1({ ...f.input, native, verificationDeadlineMs: 1_000 },
    controller.signal);
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(running, /This operation was aborted|AbortError/u);
  assert.equal(nativeAborted, true);
});

test("native verification has an active deadline and aborts the hung verifier", async t => {
  const f = await fixture(t); let nativeAborted = false;
  const native = { async verifyProtectedPath(request: any) {
    return await new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => {
      nativeAborted = true; reject(new Error("native-deadline"));
    }, { once: true }));
  } };
  const started = performance.now();
  await assert.rejects(createPrivateInstalledConfigurationCustodyV1({ ...f.input, native, verificationDeadlineMs: 20 }),
    /private_installed_configuration_custody_deadline/u);
  assert.ok(performance.now() - started < 500);
  assert.equal(nativeAborted, true);
});

test("missing native custody is a narrow explicit blocker and accessors are never invoked", async t => {
  const f = await fixture(t); let getterCalls = 0;
  const accessorInput = { schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, manifestPath: f.manifestPath,
    manifestBytes: f.manifestBytes.length, manifestSha256: digest(f.manifestBytes),
    expectedOwnerUid: process.geteuid!(), verificationDeadlineMs: 1_000 } as Record<string, unknown>;
  Object.defineProperty(accessorInput, "native", { enumerable: true, get() { getterCalls++; return f.native; } });
  const result = await createPrivateInstalledConfigurationCustodyV1(accessorInput);
  assert.deepEqual(result, { schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, status: "blocked",
    blocker: "native_custody_verifier_missing", performsEffect: false, createsDirectory: false,
    repairsDirectory: false, loadsModule: false, loadsCallback: false });
  assert.equal(getterCalls, 0);
});
