import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalJson } from "../src/security/canonical-digest";
import { createPrivateInstalledConfigurationCustodyV1, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1 } from "../src/installer/v1/private-installed-configuration-custody";

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
