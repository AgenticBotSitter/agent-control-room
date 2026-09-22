import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
  PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1,
  type PrivateInstallationJournalHeldSessionPortV1,
  type PrivateInstallationJournalHeldSessionV1 } from
  "../src/installer/v1/private-installation-journal-held-session-adapter";
import type { PrivateInstallationJournalNativeOperationRequestV1 } from
  "../src/installer/v1/private-installation-journal-native-custody-preparation";
import { PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
import { createPrivateInstalledJournalCustodyCompositionV1,
  createPrivateInstalledJournalCustodyPortsV1,
  MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1,
  PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1,
  PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1 } from
  "../src/installer/v1/private-installed-journal-custody-composer";

const refusal = { message: "private_installed_journal_custody_composer_refused" };
const heldFailure = /private_installation_journal_held_session_uncertain|installation_plan_journal_unavailable/u;

function sidecarIdentity() {
  return {
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: "0.1.0", portableReleaseManifestSha256: `sha256:${"1".repeat(64)}`,
    outerLauncherManifestSha256: `sha256:${"2".repeat(64)}`,
    sidecarManifestSha256: `sha256:${"3".repeat(64)}`, archiveSha256: `sha256:${"4".repeat(64)}`,
    artifactManifestSha256: `sha256:${"5".repeat(64)}`, executableSha256: `sha256:${"6".repeat(64)}`,
    platform: "darwin" as const, protocol: "ACRJNL1" as const, architecture: "arm64" as const,
  };
}

function preparation(rootPath: string, device = 101, inode = 202) {
  return {
    schema: PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
    installationId: "local-hermes", privateConfigurationData: { fixed: { value: "private-data" } },
    journal: { rootPath, expectedRootIdentity: { device, inode }, expectedOwnerUid: process.geteuid!(),
      expectedRootMode: 0o700 as const }, nativeSidecar: sidecarIdentity(),
    dataOnly: true as const, opensJournal: false as const, constructsJournal: false as const,
    stagesNativeSidecar: false as const, performsNativeOperation: false as const,
    writesInstalledManifest: false as const, autoUpgradesManifest: false as const,
  };
}

function staged(root: string) {
  const identity = sidecarIdentity();
  return {
    schema: MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1,
    nativeArtifact: {
      schema: MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1, verified: true as const,
      releaseVersion: identity.releaseVersion, platform: identity.platform, architecture: identity.architecture,
      minimumMacos: "13.0", protocol: identity.protocol,
      sidecarManifestSha256: identity.sidecarManifestSha256, archiveSha256: identity.archiveSha256,
      artifactManifestSha256: identity.artifactManifestSha256, executableSha256: identity.executableSha256,
      sourceSha256: "7".repeat(64),
      toolchain: { compiler: "Apple clang version 16.0.0", flags: ["reviewed"] },
      files: [{ path: "installation-journal-session-v1", mode: "0755", sha256: "6".repeat(64), bytes: 19 }],
      compiles: false as const, downloads: false as const, installs: false as const,
    },
    installationJournalNativeFactoryInput: {
      executablePath: join(root, ".acr-installation-journal-sidecar-fixture", "installation-journal-session-v1"),
      executableSha256: identity.executableSha256,
    },
    staged: true as const, compiles: false as const, downloads: false as const, installs: false as const,
  };
}

function emptySession(request: PrivateInstallationJournalNativeOperationRequestV1,
  hooks: { verified: number; closed: number }): PrivateInstallationJournalHeldSessionV1 {
  return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1,
    operationId: request.operationId, operation: request.operation,
    async listEntryNames() { return Object.freeze([]); },
    async statEntry() { return undefined; },
    async readEntry() { throw new Error("unexpected read"); },
    async createExclusiveEntry() { throw new Error("unexpected create"); },
    async writeExactBounded() { throw new Error("unexpected write"); },
    async syncFile() { throw new Error("unexpected sync"); },
    async linkNoReplace() { throw new Error("unexpected link"); },
    async unlinkExact() { throw new Error("unexpected unlink"); },
    async syncDirectory() { throw new Error("unexpected directory sync"); },
    async verifyRoot() { hooks.verified += 1; },
    async close() { hooks.closed += 1; },
  });
}

function fixturePorts(openSession: PrivateInstallationJournalHeldSessionPortV1["openSession"]) {
  const factoryInputs: unknown[] = [];
  return {
    factoryInputs,
    value: {
      schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1,
      createNativeSessionPort(input: unknown) {
        factoryInputs.push(input);
        return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1, openSession });
      },
    },
  };
}

function compose(root: string, ports: unknown, manifestBoundPreparation: unknown = preparation(root)) {
  return createPrivateInstalledJournalCustodyCompositionV1({
    schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1,
    manifestBoundPreparation, operationDeadlineMs: 1_000, ports,
  });
}

test("construction is inert and the separately-called one-use factory selects the retained chain", async () => {
  const root = "/private/tmp/acr-journal-composer-fixture";
  const requests: PrivateInstallationJournalNativeOperationRequestV1[] = [], hooks = { verified: 0, closed: 0 };
  const ports = fixturePorts(async request => { requests.push(request); return emptySession(request, hooks); });
  assert.equal(createPrivateInstalledJournalCustodyPortsV1().schema, PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1);
  const composition = compose(root, ports.value);
  assert.equal(composition.status, "journal_custody_factory_ready");
  assert.equal(ports.factoryInputs.length, 0);
  assert.deepEqual({ performsEffect: composition.performsEffect, stagesNativeSidecar: composition.stagesNativeSidecar,
    opensNativeSession: composition.opensNativeSession, createsDirectory: composition.createsDirectory,
    opensDatabase: composition.opensDatabase, startsService: composition.startsService,
    startsWorker: composition.startsWorker, invokesHermes: composition.invokesHermes,
    clearsOperatorBlocker: composition.clearsOperatorBlocker }, {
    performsEffect: false, stagesNativeSidecar: false, opensNativeSession: false, createsDirectory: false,
    opensDatabase: false, startsService: false, startsWorker: false, invokesHermes: false,
    clearsOperatorBlocker: false,
  });
  const activated = composition.custody.constructJournal(staged(root));
  assert.equal(activated.journal instanceof InstallationPlanFilesystemJournalV1, true);
  assert.equal(ports.factoryInputs.length, 1);
  assert.deepEqual(ports.factoryInputs[0], {
    executablePath: join(root, ".acr-installation-journal-sidecar-fixture", "installation-journal-session-v1"),
    executableSha256: `sha256:${"6".repeat(64)}`,
  });
  assert.equal(requests.length, 0);
  assert.deepEqual(await activated.journal.inspectSettledHistory(), []);
  assert.deepEqual(await activated.journal.readHistory(), []);
  assert.deepEqual(requests.map(value => value.operation), ["inspect_settled_history", "read_history"]);
  assert.equal(new Set(requests.map(value => value.operationId)).size, 2, "each explicit operation receives a new request");
  assert.deepEqual(requests.map(value => value.expectedRootIdentity), [{ device: 101, inode: 202 }, { device: 101, inode: 202 }]);
  assert.equal(hooks.verified, 2); assert.equal(hooks.closed, 2);
  assert.throws(() => composition.custody.constructJournal(staged(root)), refusal);
  assert.equal(ports.factoryInputs.length, 1, "one-use composition never replaces the native port");
});

test("forged, mutated, proxied and getter-backed manifest identities refuse before a factory call", () => {
  const root = "/private/tmp/acr-journal-composer-identity";
  const ports = fixturePorts(async request => emptySession(request, { verified: 0, closed: 0 }));
  const changed = preparation(root); changed.journal.expectedRootIdentity.inode += 1;
  const forged = { ...changed, journal: { ...changed.journal,
    expectedRootIdentity: { ...changed.journal.expectedRootIdentity, extra: true } } };
  assert.throws(() => compose(root, ports.value, forged), refusal);
  const proxied = preparation(root);
  proxied.journal.expectedRootIdentity = new Proxy(proxied.journal.expectedRootIdentity, {});
  assert.throws(() => compose(root, ports.value, proxied), refusal);
  const getter = preparation(root), identity = getter.journal.expectedRootIdentity;
  Object.defineProperty(identity, "inode", { enumerable: true, get() { return 202; } });
  assert.throws(() => compose(root, ports.value, getter), refusal);
  const preparationProxy = new Proxy(preparation(root), {});
  assert.throws(() => compose(root, ports.value, preparationProxy), refusal);
  assert.equal(ports.factoryInputs.length, 0);
});

test("every release-bound sidecar identity field and the fixed staged path must match", () => {
  const root = "/private/tmp/acr-journal-composer-sidecar";
  const fields = ["releaseVersion", "platform", "architecture", "protocol", "sidecarManifestSha256",
    "archiveSha256", "artifactManifestSha256", "executableSha256"] as const;
  for (const field of fields) {
    const ports = fixturePorts(async request => emptySession(request, { verified: 0, closed: 0 }));
    const value = staged(root), artifact = value.nativeArtifact as Record<string, unknown>;
    artifact[field] = field === "releaseVersion" ? "0.1.1" : field === "platform" ? "linux"
      : field === "architecture" ? "x64" : field === "protocol" ? "OTHER"
        : `sha256:${"a".repeat(64)}`;
    const composition = compose(root, ports.value);
    assert.throws(() => composition.custody.constructJournal(value), refusal, field);
    assert.equal(ports.factoryInputs.length, 0, field);
  }
  const ports = fixturePorts(async request => emptySession(request, { verified: 0, closed: 0 }));
  const linked = staged(root);
  linked.installationJournalNativeFactoryInput.executablePath = join(root, "replacement", "helper");
  assert.throws(() => compose(root, ports.value).custody.constructJournal(linked), refusal);
  const getter = staged(root);
  Object.defineProperty(getter.nativeArtifact, "archiveSha256", { enumerable: true, get() { return `sha256:${"4".repeat(64)}`; } });
  assert.throws(() => compose(root, ports.value).custody.constructJournal(getter), refusal);
  const proxy = staged(root); proxy.nativeArtifact = new Proxy(proxy.nativeArtifact, {});
  assert.throws(() => compose(root, ports.value).custody.constructJournal(proxy), refusal);
});

test("journal-root replacement is never adopted after manifest custody", async (t: TestContext) => {
  const parent = await mkdtemp(join(process.cwd(), ".journal-composer-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "journal"), original = join(parent, "journal-original");
  await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  const before = await lstat(root), observed: Array<{ device: number; inode: number }> = [];
  const ports = fixturePorts(async request => {
    observed.push(request.expectedRootIdentity);
    const current = await lstat(request.journalRootPath);
    if (current.dev !== request.expectedRootIdentity.device || current.ino !== request.expectedRootIdentity.inode)
      throw new Error("replacement refused");
    return emptySession(request, { verified: 0, closed: 0 });
  });
  const composition = compose(root, ports.value, preparation(root, before.dev, before.ino));
  const activated = composition.custody.constructJournal(staged(parent));
  await rename(root, original); await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  await assert.rejects(activated.journal.inspectSettledHistory(), heldFailure);
  assert.deepEqual(observed, [{ device: before.dev, inode: before.ino }]);
  assert.deepEqual(activated.journalBinding.expectedRootIdentity, { device: before.dev, inode: before.ino });
});

test("cancellation opens no replacement session and cannot reconstruct the spent factory", async () => {
  const root = "/private/tmp/acr-journal-composer-cancel";
  let opens = 0;
  const ports = fixturePorts(request => {
    opens += 1;
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  const composition = compose(root, ports.value), activated = composition.custody.constructJournal(staged(root));
  const controller = new AbortController(), operation = activated.journal.inspectSettledHistory(controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(operation);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 1); assert.equal(ports.factoryInputs.length, 1);
  assert.throws(() => composition.custody.constructJournal(staged(root)), refusal);
  assert.equal(ports.factoryInputs.length, 1, "cancellation cannot mint a replacement native port");
});
