import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, sha256Digest } from "../src/security/index.ts";
import { createHostResultCollectorV1 } from "../src/security/host-value.ts";
import {
  IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
  IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1,
  IDEA_LAB_HERMES_021_QUALIFICATION_PERMIT_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
  IdeaLabErrorV1,
  IdeaLabHermes021EnrolledGatewayPortV1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  sanitizeIdeaLabHermes021ConnectionEnrollmentV1,
  verifyIdeaLabHermes021QualificationPermitV1,
  type IdeaLabHermes021NativeBridgeV1,
  type IdeaLabHermes021QualificationSpendStoreV1,
} from "../src/idea-lab/v1/index.ts";

const digest = (label: string) => sha256Digest({ label });
const nodeKeys = generateKeyPairSync("ed25519"), authorityKeys = generateKeyPairSync("ed25519");
const nodeSpki = nodeKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const authoritySpki = authorityKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

function enrollment() {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1,
    enrollmentId: "enrollment:gateway-qualification",
    connectionId: "connection:johnny5-mac",
    tenantId: "tenant:local-owner",
    nodeId: "node:johnny5-mac",
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    route: { transport: "ssh_tunnel" as const, sshHostKeyFingerprintDigest: digest("host-key"),
      sshPublicKeyOnly: true as const, sshBatchMode: true as const, ownerVerifiedFirstHostKey: true as const,
      hostKeyChangesFailClosed: true as const },
    connectorRouteDigest: digest("opaque-route"),
    profileIdentityDigest: digest("empty-profile"),
    gatewayEndpointVisibility: "connector_private_loopback" as const,
    gatewaySessionValueCustody: "connector_private" as const,
    gatewayOperations: ["session.create", "prompt.submit", "session.steer", "session.interrupt", "session.resume",
      "session.status", "session.usage", "session.events.since", "session.close"] as const,
    arbitraryRemoteCommandAllowed: false as const, genericShellExposedToControlRoom: false as const,
    freshProfileNoSkills: true as const, protectedValueResolution: "global_root_read_only_per_provider" as const,
    protectedValueMaterialReturned: false as const,
    copiedContextCounts: { soul: 0 as const, memory: 0 as const, skills: 0 as const, plugins: 0 as const,
      mcpConfiguration: 0 as const, rules: 0 as const, sessions: 0 as const },
    toolsEnabled: false as const, mcpEnabled: false as const, pluginsEnabled: false as const,
    gatewayStartsMade: 0 as const, providerCallsMade: 0 as const,
    issuedAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-09-01T12:00:00.000Z",
  };
  const body = { ...material, bodyDigest: sha256Digest(material) };
  const envelope = { body, attestation: { algorithm: "ed25519" as const, keyId: "node-key:johnny5",
    publicKeySpki: nodeSpki, signature: sign(null, Buffer.from(canonicalJson(body)), nodeKeys.privateKey).toString("base64url") } };
  return sanitizeIdeaLabHermes021ConnectionEnrollmentV1(envelope, {
    evaluatedAt: "2026-09-01T10:01:00.000Z", expectedTenantId: body.tenantId, expectedNodeId: body.nodeId,
    expectedConnectionId: body.connectionId, expectedConnectorRouteDigest: body.connectorRouteDigest,
    expectedProfileIdentityDigest: body.profileIdentityDigest,
    expectedSshHostKeyFingerprintDigest: body.route.sshHostKeyFingerprintDigest,
    trustedNodeKeyId: "node-key:johnny5", trustedNodePublicKeySpki: nodeSpki,
    inputMode: "injected_signed_node_enrollment_only" as const,
  });
}

function permit(connection = enrollment(), changes: Record<string, unknown> = {}) {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_QUALIFICATION_PERMIT_V1,
    permitId: "permit:qualification-once", attemptId: "attempt:qualification-once",
    tenantId: connection.tenantId, nodeId: connection.nodeId, connectionId: connection.connectionId,
    enrollmentResultDigest: connection.resultDigest,
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    transport: connection.transport, connectorRouteDigest: connection.connectorRouteDigest,
    profileIdentityDigest: connection.profileIdentityDigest, conversationIdentityDigest: digest("conversation"),
    participantId: "participant:market-analyst", participantIdentityDigest: digest("participant-market-analyst"),
    runtimeIdentityDigest: digest("runtime"), markerDigest: digest("effect-marker"),
    ownerWindowDigest: digest("owner-window"), operationSetDigest: IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1,
    purpose: "one_disposable_native_qualification" as const,
    maximumNativeAttempts: 1 as const, maximumProviderCalls: 1 as const, maximumDurationSeconds: 300 as const,
    maximumOutputCharacters: 800 as const, toolsAllowed: 0 as const, mcpServersAllowed: 0 as const,
    pluginsAllowed: 0 as const, genericShellAllowed: false as const, automaticRetryAllowed: false as const,
    oneUse: true as const, issuedAt: "2026-09-01T10:02:00.000Z", expiresAt: "2026-09-01T10:07:00.000Z",
    ...changes,
  };
  const body = { ...material, bodyDigest: sha256Digest(material) };
  const envelope = { body, attestation: { algorithm: "ed25519" as const, keyId: "authority-key:local-owner",
    publicKeySpki: authoritySpki,
    signature: sign(null, Buffer.from(canonicalJson(body)), authorityKeys.privateKey).toString("base64url") } };
  const context = { evaluatedAt: "2026-09-01T10:03:00.000Z", expectedAttemptId: body.attemptId,
    expectedTenantId: body.tenantId, expectedNodeId: body.nodeId, expectedConnectionId: body.connectionId,
    expectedMarkerDigest: body.markerDigest, expectedOwnerWindowDigest: body.ownerWindowDigest,
    expectedParticipantId: body.participantId,
    expectedParticipantIdentityDigest: body.participantIdentityDigest,
    expectedRuntimeIdentityDigest: body.runtimeIdentityDigest,
    expectedConversationIdentityDigest: body.conversationIdentityDigest,
    trustedAuthorityKeyId: "authority-key:local-owner", trustedAuthorityPublicKeySpki: authoritySpki,
    inputMode: "injected_signed_owner_window_only" as const };
  return { connection, envelope, context };
}

function store(claimResult: "claimed" | "already_claimed" | "conflict" = "claimed") {
  const events: Array<Record<string, unknown>> = [];
  const value: IdeaLabHermes021QualificationSpendStoreV1 = {
    async claim(input) { events.push({ type: "claim", ...input }); return claimResult; },
    async settle(input) { events.push({ type: "settle", ...input }); },
  };
  return { value, events };
}

function bridge(options: { failExecute?: boolean; failCleanup?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const value: IdeaLabHermes021NativeBridgeV1 = {
    async executeFixedSession(input, collector) {
      calls.push({ type: "execute", ...input, signal: "redacted" });
      if (options.failExecute) throw new Error("uncertain");
      collector.submit({ frames: [] });
    },
    async cleanupFixedSession(input, collector) {
      calls.push({ type: "cleanup", ...input, signal: "redacted" });
      if (options.failCleanup) throw new Error("uncertain");
      collector.submit({ contractVersion: "control-room-hermes-021-panel-cleanup/v1" });
    },
  };
  return { value, calls };
}

function executeInput(bundle = permit()) {
  return { markerDigest: bundle.envelope.body.markerDigest, participantId: bundle.envelope.body.participantId,
    participantIdentityDigest: digest("participant-market-analyst"),
    round: 1, safeInstruction: "Return only the bounded structured opinion.", runtimeIdentityDigest: digest("runtime"),
    profileIdentityDigest: bundle.envelope.body.profileIdentityDigest,
    conversationIdentityDigest: bundle.envelope.body.conversationIdentityDigest,
    maximumOutputCharacters: 800 as const, signal: new AbortController().signal };
}

test("CR12B-IDEA-110A verifies an exact signed one-use owner window against one enrolled route", () => {
  const bundle = permit();
  const verified = verifyIdeaLabHermes021QualificationPermitV1({ enrollment: bundle.connection,
    envelope: bundle.envelope, context: bundle.context });
  assert.deepEqual([verified.connectionId, verified.enrollmentResultDigest, verified.grantsLivePanelAuthority,
    verified.grantsGenericShell], [bundle.connection.connectionId, bundle.connection.resultDigest, false, false]);
  assert.equal(JSON.stringify(verified).includes("owner-window"), false);
});

test("CR12B-IDEA-110A forwards only a fixed, feature-disabled session request and spends the permit once", async () => {
  const bundle = permit(), spend = store(), native = bridge();
  const port = new IdeaLabHermes021EnrolledGatewayPortV1({ enrollment: bundle.connection,
    permitEnvelope: bundle.envelope, permitContext: bundle.context, spendStore: spend.value,
    nativeBridge: native.value, now: () => "2026-09-01T10:04:00.000Z" });
  const handoff = createHostResultCollectorV1();
  await port.execute(executeInput(bundle), handoff.collector);
  assert.deepEqual([native.calls[0].toolsEnabled, native.calls[0].mcpEnabled, native.calls[0].pluginsEnabled,
    native.calls[0].genericShellEnabled], [false, false, false, false]);
  assert.equal(native.calls[0].connectorRouteDigest, bundle.connection.connectorRouteDigest);
  assert.equal("host" in native.calls[0] || "username" in native.calls[0] || "keyPath" in native.calls[0], false);
  assert.deepEqual(spend.events.map((event) => [event.type, event.outcome]),
    [["claim", undefined], ["settle", "execute_returned"]]);
  await assert.rejects(() => port.execute(executeInput(bundle), createHostResultCollectorV1().collector),
    (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-110A requires cleanup and terminally records uncertain execution or cleanup", async () => {
  const exact = permit(), uncertainSpend = store(), uncertainBridge = bridge({ failExecute: true });
  const uncertainPort = new IdeaLabHermes021EnrolledGatewayPortV1({ enrollment: exact.connection,
    permitEnvelope: exact.envelope, permitContext: exact.context, spendStore: uncertainSpend.value,
    nativeBridge: uncertainBridge.value, now: () => "2026-09-01T10:04:00.000Z" });
  await assert.rejects(() => uncertainPort.execute(executeInput(exact), createHostResultCollectorV1().collector),
    (error) => error instanceof IdeaLabErrorV1);
  assert.equal(uncertainSpend.events.at(-1)?.outcome, "terminal_ambiguity");

  const cleanupSpend = store(), cleanupBridge = bridge({ failCleanup: true });
  const cleanupPort = new IdeaLabHermes021EnrolledGatewayPortV1({ enrollment: exact.connection,
    permitEnvelope: exact.envelope, permitContext: exact.context, spendStore: cleanupSpend.value,
    nativeBridge: cleanupBridge.value, now: () => "2026-09-01T10:04:00.000Z" });
  await cleanupPort.execute(executeInput(exact), createHostResultCollectorV1().collector);
  await assert.rejects(() => cleanupPort.cleanup({ markerDigest: exact.envelope.body.markerDigest,
    signal: new AbortController().signal }, createHostResultCollectorV1().collector),
  (error) => error instanceof IdeaLabErrorV1);
  assert.equal(cleanupSpend.events.at(-1)?.outcome, "cleanup_uncertain");
});

test("CR12B-IDEA-110A blocks replay claims, expired windows, route drift, and signer substitution before native use", async () => {
  const exact = permit(), deniedSpend = store("already_claimed"), native = bridge();
  const denied = new IdeaLabHermes021EnrolledGatewayPortV1({ enrollment: exact.connection,
    permitEnvelope: exact.envelope, permitContext: exact.context, spendStore: deniedSpend.value,
    nativeBridge: native.value, now: () => "2026-09-01T10:04:00.000Z" });
  await assert.rejects(() => denied.execute(executeInput(exact), createHostResultCollectorV1().collector),
    (error) => error instanceof IdeaLabErrorV1);
  assert.equal(native.calls.length, 0);

  const expired = permit(undefined, { expiresAt: "2026-09-01T10:02:30.000Z" });
  const wrongKeys = generateKeyPairSync("ed25519");
  for (const [bundle, changedContext] of [
    [expired, expired.context],
    [exact, { ...exact.context, expectedMarkerDigest: digest("other-marker") }],
    [exact, { ...exact.context, expectedParticipantIdentityDigest: digest("other-participant") }],
    [exact, { ...exact.context, expectedRuntimeIdentityDigest: digest("other-runtime") }],
    [exact, { ...exact.context, trustedAuthorityPublicKeySpki: wrongKeys.publicKey
      .export({ format: "der", type: "spki" }).toString("base64url") }],
  ] as const) assert.throws(() => verifyIdeaLabHermes021QualificationPermitV1({ enrollment: bundle.connection,
    envelope: bundle.envelope, context: changedContext }), (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-110A source has no process, filesystem, network, SSH, credential, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "ssh ", "auth.json", "process.env", "readFile("]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes("IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1"), true);
});
