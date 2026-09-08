import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, writeFile, rm, chmod, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPrivateNativeConfiguration, validatePrivateNativeStatePaths,
  type PrivateNativeConfigurationInput, type PrivateNativeConfigurationPorts } from "../src/node-bridge/private-native-configuration";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { enrollment as template, instant } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import { computeArtifactBodyDigest, signArtifact } from "../src/node-policy/v1/crypto";
import type { NativeProfileAcceptanceBody } from "../src/harness/hermes-native-v1/profile-evidence";
import { createNativeStartAuthority } from "../src/harness/hermes-native-v1/start-authority";
import { HermesNativeRunAdapter } from "../src/harness/hermes-native-v1/adapter";
import type { NodePrivateKeyStore } from "../src/node-policy/v1/stores";
import { DatabaseSync } from "node:sqlite";

const openConfiguration: typeof openPrivateNativeConfiguration = process.env.CR_REUSE_COMPILED_NODE_CONFIGURATION === "1"
  ? (await import(new URL("../dist-vps/server/nodeConnector.js", import.meta.url).href)).openPrivateNativeConfiguration
  : openPrivateNativeConfiguration;
assert.equal(typeof openConfiguration, "function"); // No source fallback for compiled acceptance.

async function files(t: { after(fn: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cr-private-native-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { bridge: join(directory, "bridge.db"), runs: join(directory, "runs.db"),
    admissions: join(directory, "admissions.db"), executions: join(directory, "executions.db"), effects: join(directory, "effects.db") };
  for (const path of Object.values(paths)) await writeFile(path, "", { mode: 0o600 });
  return { directory, paths };
}
const signal = () => new AbortController().signal;
const pin = (keyId: string, spki: string) => ({ keyId, algorithm: "ed25519", spki,
  fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const { directory, paths } = await files(t), keys = generateKeyPairSync("ed25519");
  const { qualificationDigest: _old, ...identity } = template; void _old;
  const body: NativeProfileAcceptanceBody = { schema: "control-room.native-profile-acceptance/v1", enrollment: identity,
    nodeClass: "personal-compute", approvalKeyId: "approval-key:profile", issuedAt: instant,
    evidenceDigest: sha256Digest("synthetic profile acceptance only"), bodyDigest: "",
    guarantees: { dedicatedProfile: true, toolPolicyEnforced: true, mcpPolicyEnforced: true, pluginPolicyEnforced: true,
      skillPolicyEnforced: true, hardDeadlineEnforced: true, filesystemIsolationEnforced: true, networkIsolationEnforced: true } };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const acceptance = signArtifact(body, keys.privateKey), enrollment = { ...template, qualificationDigest: sha256Digest(acceptance) };
  const f = await nativeLeaseEvidenceFixture(enrollment); t.after(f.close); await f.provisionCeiling();
  const now = f.dependencies.clock!, r = f.startConfig.request;
  const input: PrivateNativeConfigurationInput = { paths,
    node: { queueId: "queue:synthetic", enrollment, nodeKeyId: "key:test", serverId: f.config.serverActorId,
      serverKeyId: f.grant.keyId, serverPublicKeySpki: Buffer.from((await f.trust.resolveServerKey(f.grant.keyId))!).toString("base64url") },
    policy: { request: r, executor: f.policy.executor, nodeClass: "personal-compute", leaseMessageId: f.grant.messageId,
      serverActorId: f.config.serverActorId, nodeSigningKeyReferenceId: "key:test", parentAuthorities: f.policy.lease.parentAuthorities },
    approvalPins: { schema: "control-room.owner-approval-pins/v1", tenantId: r.tenantId, nodeId: r.nodeId,
      nodeClass: "personal-compute", validFrom: instant, validUntil: enrollment.validUntil,
      keys: [pin(body.approvalKeyId, keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url")),
        pin(f.policy.approvalKey!.keyId, f.policy.approvalKey!.publicKeySpki)] },
    profileAcceptance: acceptance,
    https: { canonicalDestination: "https://native.example.test:443", connectorCredentialRef: "credential:synthetic",
      serverCa: "synthetic CA material", serverCertificateDigest: sha256Digest("synthetic") },
    settings: { maxCycles: 1, intervalMs: 1, timeoutMs: 1000 },
  };
  let keyEffects = 0;
  const forbidden = async () => { keyEffects++; assert.fail("no native credential/key effect"); };
  const ports: PrivateNativeConfigurationPorts = { security: f.trust, clock: now,
    keys: { reference: () => ({ keyId: "key:test" }) as ReturnType<NodePrivateKeyStore["reference"]>,
      availability: async () => f.policy.keyAvailability, sign: forbidden, unlock: forbidden, lock: forbidden, dispose: forbidden },
    serverKeys: { resolve: async () => undefined }, localPaused: () => false,
    readSupervisedState: () => ({ enrollmentDigest: sha256Digest(enrollment), profilePolicyDigest: enrollment.profilePolicyDigest,
      qualificationDigest: enrollment.qualificationDigest, revision: 1, observedAt: now(), validUntil: enrollment.validUntil,
      state: "active", credentialAvailable: true }),
    readLocalRecoveryState: () => ({ credentialRef: enrollment.credentialRef, revision: 1, credentialAvailable: true, recoveryAllowed: true }),
    hermesCredential: forbidden, connector: { assertCurrent() {}, credential: forbidden },
  };
  return { f, input, ports, directory, keyEffects: () => keyEffects,
    open: () => openConfiguration(input, ports, signal()) };
}

test("private path gate rejects aliases, shared access, symlinks and sidecar escapes without changing files", async t => {
  const x = await files(t); assert.deepEqual(validatePrivateNativeStatePaths(x.paths), x.paths);
  assert.throws(() => validatePrivateNativeStatePaths({ ...x.paths, runs: x.paths.bridge }));
  await chmod(x.paths.runs, 0o644); assert.throws(() => validatePrivateNativeStatePaths(x.paths)); await chmod(x.paths.runs, 0o600);
  const alias = join(x.directory, "alias.db"); await symlink(x.paths.runs, alias);
  assert.throws(() => validatePrivateNativeStatePaths({ ...x.paths, runs: alias }));
  const hard = join(x.directory, "hard.db"); await link(x.paths.runs, hard);
  assert.throws(() => validatePrivateNativeStatePaths(x.paths)); await rm(hard);
  const sidecar = `${x.paths.bridge}-wal`; await symlink(x.paths.runs, sidecar);
  assert.throws(() => validatePrivateNativeStatePaths(x.paths));
});

test("assembled real policy stores start once using fake transport and preserve markers across reopen", async t => {
  const x = await fixture(t), prepared = x.open();
  t.after(async () => prepared.close()); assert.equal(x.keyEffects(), 0);
  // Fixture-only authenticated lease/control setup. The production factory never
  // seeds these receipts or declares the node active.
  const journal = prepared.dependencies.journal;
  await journal.consume(x.f.hello, x.f.at);
  await journal.consume(x.f.grant, x.f.at); journal.recordCommand(x.f.grant, x.f.at);
  journal.upsertAttempt(x.f.summary, x.f.at);
  journal.initializeNodeControlState({ nodeId: x.input.node.enrollment.nodeId, nodeVersion: 1, state: "active", updatedAt: x.f.at });
  const controller = createNativeStartAuthority(x.f.startConfig, prepared.dependencies.local);
  t.after(async () => controller.close());
  const adapter = new HermesNativeRunAdapter(x.input.node.enrollment, prepared.dependencies.runs,
    controller.authority, x.f.transport, x.ports.clock);
  assert.equal((await adapter.start(x.f.prepared.start)).state, "queued");
  const binding = x.f.prepared.binding, marker = prepared.dependencies.local.effects.load(binding.effectClaimKey);
  assert.equal(marker?.kind, "full"); assert.ok(marker?.kind === "full" && marker.snapshot.markerDigest);
  assert.deepEqual(x.f.calls, ["capabilities", "start"]); controller.close(); prepared.close(); prepared.close();
  const reopened = x.open(); t.after(async () => reopened.close());
  assert.deepEqual(reopened.dependencies.local.effects.load(binding.effectClaimKey), marker);
  assert.equal(reopened.dependencies.runs.load(binding.runId)?.state, "queued");
  assert.deepEqual(reopened.dependencies.journal.acceptedCommand(x.f.grant.messageId)?.frame, x.f.grant);
  const next = createNativeStartAuthority(x.f.startConfig, reopened.dependencies.local);
  t.after(async () => next.close()); await assert.rejects(next.authority.check("start", binding));
  assert.deepEqual(x.f.calls, ["capabilities", "start"]); assert.equal(x.keyEffects(), 0);
});

test("missing lease/control is not filled in; invalid profile setup closes opened stores for safe reopening", async t => {
  const x = await fixture(t), prepared = x.open(); t.after(async () => prepared.close());
  await assert.rejects(prepared.dependencies.local.readCurrent(signal()));
  assert.equal(prepared.dependencies.journal.nodeControlState(x.input.node.enrollment.nodeId), undefined);
  prepared.close();
  const invalid = { ...x.input, profileAcceptance: {} };
  assert.throws(() => openConfiguration(invalid, x.ports, signal()), /private_native_configuration_unavailable/);
  const reopened = x.open(); reopened.close(); assert.equal(x.keyEffects(), 0);
  // Borrowed security was not disposed on success or failed assembly.
  assert.ok(await x.f.trust.loadTrustBundle());
});

test("a corrupt last journal closes its failed constructor and every previously opened database", async t => {
  const x = await fixture(t);
  await writeFile(x.input.paths.effects, "synthetic invalid SQLite contents", { mode: 0o600 });
  const original = DatabaseSync.prototype.close; let closes = 0;
  const mocked = t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes++; return original.call(this);
  });
  assert.throws(x.open, /private_native_configuration_unavailable/);
  assert.equal(closes, 5); mocked.mock.restore(); assert.equal(x.keyEffects(), 0);
});
