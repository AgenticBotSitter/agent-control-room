import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { projectExactPackageCodexCompletedTurnV1 } from "../src/harness/codex-v1/completed-turn";
import { CODEX_APP_SERVER_ADAPTER } from "../src/harness/codex-v1/delivery-contract";
import {
  CODEX_RESULT_RETURN_FEATURE_V1,
  CodexResultReturnExchangeV1,
  codexResultReturnBodySchemaV1,
  codexResultReturnReceiptBodySchemaV1,
  createCodexResultReturnBodyV1,
  type CodexResultReturnExpectationV1,
} from "../src/harness/codex-v1/result-return";
import {
  CODEX_APP_SERVER_READ_CONTRACT,
  CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT,
} from "../src/harness/codex-v1/schema-contract";
import {
  createCodexPhysicalQualificationReceiptBodyV1,
  createCodexResultPublicationContractV1,
} from "../src/harness/codex-v1/result-publication-contract";
import { decodeNativeHttpPacketUtf8 } from "../src/harness/v1/native-http-exchange";
import { decodeNativeWire, encodeNativeWire } from "../src/harness/v1/native-wire";
import { projectCodexTerminalResultEvidenceV1 } from "../src/harness/v1/terminal-result-evidence";
import { signArtifact } from "../src/node-policy/v1/crypto";
import {
  NODE_PROTOCOL_V1,
  NodeProtocolAuthenticator,
  signNodeFrame,
  type ReplayGuard,
  type SignedNodeFrame,
  type TrustedKeyResolver,
} from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security/canonical-digest";

const nodeKeys = generateKeyPairSync("ed25519");
const serverKeys = generateKeyPairSync("ed25519");
const qualificationKeys = generateKeyPairSync("ed25519");
const nodeSpki = nodeKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const serverSpki = serverKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const qualificationSpki = qualificationKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const returnedAt = "2026-09-13T12:00:00.000Z";
const receivedAt = "2026-09-13T12:00:01.000Z";
const qualificationMaximumAgeMs = 300_000;

const exactPackage = () => ({
  adapterId: CODEX_APP_SERVER_ADAPTER,
  packageName: CODEX_APP_SERVER_READ_CONTRACT.package,
  packageVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
  generatedSchemaBundleSha256: CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256,
  threadStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256,
  threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
  turnStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256,
  turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
  threadReadResponseSchemaSha256: CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256,
  agentMessageSourceSha256: CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256,
});

const evidence = <T extends Record<string, unknown>>(material: T) => ({
  ...material, evidenceDigest: sha256Digest(material),
});

function activation() {
  const material = {
    schema: "control-room.codex-task-activation/v1" as const,
    tenantId: "tenant:test", projectId: "project:test", nodeId: "node:test", jobId: "job:test",
    attemptId: "attempt:test", runId: "run:test", leaseId: "lease:test", leaseEpoch: 7,
    queueId: "queue:test", connectionId: "connection:test",
    connection: { connectionAttemptId: "connection:result",
      initializedConnectionDigest: sha256Digest("initialized:result") },
    dispatchMessageId: "message:dispatch", dispatchFrameDigest: sha256Digest("dispatch-frame"),
    dispatchBodyDigest: sha256Digest("dispatch-body"), receiptMessageId: "message:receipt",
    receiptFrameDigest: sha256Digest("receipt-frame"), receiptBodyDigest: sha256Digest("receipt-body"),
    permitDigest: sha256Digest("permit"), inputDigest: sha256Digest({ prompt: "Do it", instructions: "Exact" }),
    operationDigest: sha256Digest("operation"), effectClaimKey: sha256Digest("effect"),
    enrollmentDigest: sha256Digest("enrollment"), connectorProfileDigest: sha256Digest("profile"),
    workspaceIntentDigest: sha256Digest("workspace"), currentAdmissionDigest: sha256Digest("admission"),
    workspacePath: "/synthetic/workspace", prompt: "Do it", instructions: "Exact",
    receiptRecordedAt: "2026-09-13T11:57:00.000Z", receiptReceivedAt: "2026-09-13T11:57:01.000Z",
    activatedAt: "2026-09-13T11:57:02.000Z", activationExpiresAt: "2026-09-13T12:02:00.000Z",
    startsWork: false as const, authorizesExactStart: true as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const,
  };
  const activationDigest = sha256Digest(material);
  return { ...material, activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest };
}

function qualification() {
  const start = evidence({ evidenceId: "evidence:start", processAttemptId: "process:start",
    connectionAttemptId: "connection:start", initializedConnectionDigest: sha256Digest("initialized:start"),
    threadId: "thread:qualification", turnId: "turn:qualification",
    startObserved: true as const, cleanupVerified: true as const });
  const restartRead = evidence({ evidenceId: "evidence:restart", processAttemptId: "process:restart",
    connectionAttemptId: "connection:restart", initializedConnectionDigest: sha256Digest("initialized:restart"),
    threadId: "thread:qualification", turnId: "turn:qualification", itemId: "item:qualification",
    restartObserved: true as const, exactReadObserved: true as const, cleanupVerified: true as const });
  const body = createCodexPhysicalQualificationReceiptBodyV1({
    schema: "control-room.codex-physical-qualification-receipt/v1",
    qualificationId: "qualification:test", qualificationSignerKeyId: "qualification-key:test",
    tenantId: "tenant:test", nodeId: "node:test", connectorProfileId: "profile:codex:test",
    connectorProfileDigest: sha256Digest("profile"), exactPackage: exactPackage(),
    qualifiedAt: "2026-09-13T11:59:00.000Z", start, restartRead,
    oneFreshProcessPerAttempt: true, sameDurableThreadObserved: true, sameDurableTurnObserved: true,
    terminalCleanupVerified: true, processReuseObserved: false, retryObserved: false,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  return { body, signed: signArtifact(body, qualificationKeys.privateKey) };
}

function prepared(text = "Exact bounded terminal result.") {
  const activationValue = activation();
  const rawResult = JSON.stringify({ thread: { id: "thread:durable",
    cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: "turn:durable", status: "completed", itemsView: "full",
      items: [{ type: "agentMessage", id: "item:final", phase: "final_answer", text }] }] } });
  const observation = projectExactPackageCodexCompletedTurnV1({
    threadId: "thread:durable", turnId: "turn:durable", rawResult,
  });
  const qualificationValue = qualification();
  const binding = {
    identity: { tenantId: activationValue.tenantId, projectId: activationValue.projectId,
      jobId: activationValue.jobId, attemptId: activationValue.attemptId, runId: activationValue.runId,
      nodeId: activationValue.nodeId, leaseId: activationValue.leaseId, leaseEpoch: activationValue.leaseEpoch },
    delivery: { activationDigest: activationValue.activationDigest,
      dispatchBodyDigest: activationValue.dispatchBodyDigest, receiptBodyDigest: activationValue.receiptBodyDigest },
    connection: { connectionId: activationValue.connectionId, connectionAttemptId: "connection:result",
      initializedConnectionDigest: sha256Digest("initialized:result"), connectorProfileId: "profile:codex:test",
      connectorProfileDigest: activationValue.connectorProfileDigest },
    result: { threadId: observation.threadId, turnId: observation.turnId, itemId: observation.itemId,
      projectionDigest: observation.projectionDigest, rawResultDigest: observation.rawResultDigest,
      rawTurnDigest: observation.matchedTurnDigest, contentHash: observation.contentHash,
      contentSizeBytes: observation.sizeBytes },
    physicalQualification: { qualificationId: qualificationValue.body.qualificationId,
      receiptBodyDigest: qualificationValue.body.bodyDigest,
      signerKeyId: qualificationValue.body.qualificationSignerKeyId },
  };
  const publication = createCodexResultPublicationContractV1({ activation: activationValue, observation,
    observationSource: "stored_thread_read", connection: {
      connectionAttemptId: binding.connection.connectionAttemptId,
      initializedConnectionDigest: binding.connection.initializedConnectionDigest,
      connectorProfileId: binding.connection.connectorProfileId,
    }, binding, qualificationReceipt: qualificationValue.signed, qualificationPublicKeySpki: qualificationSpki });
  const terminalEvidence = projectCodexTerminalResultEvidenceV1({ lineage: {
      tenantId: publication.identity.tenantId, projectId: publication.identity.projectId,
      jobId: publication.identity.jobId, attemptId: publication.identity.attemptId,
      runId: publication.identity.runId, nodeId: publication.identity.nodeId,
    }, identity: { runId: publication.identity.runId, threadId: publication.result.threadId,
      turnId: publication.result.turnId }, completedTurn: observation,
    qualificationDigest: qualificationValue.body.bodyDigest, observedAt: "2026-09-13T11:59:59.000Z" });
  const body = createCodexResultReturnBodyV1({ publication, terminalEvidence,
    qualificationReceipt: qualificationValue.signed, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs, returnedAt });
  return { activationValue, qualificationValue, publication, terminalEvidence, body };
}

class ExactReplay implements ReplayGuard {
  private readonly seen = new Map<string, string>();
  async consume(frame: SignedNodeFrame): Promise<"accepted" | "duplicate"> {
    const digest = sha256Digest(frame), prior = this.seen.get(frame.messageId);
    if (prior === undefined) { this.seen.set(frame.messageId, digest); return "accepted"; }
    if (prior !== digest) throw new Error("changed replay");
    return "duplicate";
  }
}

function authenticator(direction: "node_to_server" | "server_to_node", replay = new ExactReplay()) {
  const keys: TrustedKeyResolver = { async resolve(input) {
    if (direction === "node_to_server" && input.actorId === "node:test" && input.keyId === "node-key:test") {
      return { tenantId: "tenant:test", actorId: "node:test", senderKind: "node", keyId: "node-key:test",
        algorithm: "ed25519", publicKeySpki: nodeSpki, state: "active", principalState: "active",
        validFrom: "2026-09-13T11:00:00.000Z" };
    }
    if (direction === "server_to_node" && input.actorId === "server:test" && input.keyId === "server-key:test") {
      return { tenantId: "tenant:test", actorId: "server:test", senderKind: "control_room", keyId: "server-key:test",
        algorithm: "ed25519", publicKeySpki: serverSpki, state: "active", principalState: "active",
        validFrom: "2026-09-13T11:00:00.000Z" };
    }
    return undefined;
  } };
  return new NodeProtocolAuthenticator(keys, replay, { async consume() {} });
}

function resultFrame(body = prepared().body, messageId = "message:result-return") {
  return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
    tenantId: "tenant:test", actorId: "node:test", keyId: "node-key:test", connectionId: "connection:test",
    sequence: 20, messageId, correlationId: "correlation:result-return",
    causationId: body.activation.activationId, nonce: "nonce_codex_result_return_1234567890",
    sentAt: body.returnedAt, expiresAt: "2026-09-13T12:03:00.000Z",
    type: "harness.codex.result.return", body }, nodeKeys.privateKey);
}

function expectation(value = prepared()): CodexResultReturnExpectationV1 {
  return { identity: value.body.identity, activation: value.body.activation, connector: value.body.connector,
    connectionId: "connection:test", nodeActorId: "node:test", nodeKeyId: "node-key:test",
    serverActorId: "server:test", serverKeyId: "server-key:test", qualificationMaximumAgeMs,
    qualificationPublicKeySpki: qualificationSpki, qualificationReceipt: value.qualificationValue.signed };
}

async function authenticated(frame: ReturnType<typeof resultFrame>, replay = new ExactReplay()) {
  const auth = authenticator("node_to_server", replay);
  return { auth, result: await auth.verify(decodeNativeHttpPacketUtf8(Buffer.from(JSON.stringify(frame))), {
    expectedDirection: "node_to_server", expectedConnectionId: "connection:test",
    receivedAt, transportIdentity: "transport:test",
  }) };
}

function issueReceipt(frame: ReturnType<typeof resultFrame>, calls: { value: number }) {
  return async (body: Parameters<Parameters<CodexResultReturnExchangeV1["accept"]>[0]["issueReceipt"]>[0]) => {
    calls.value += 1;
    return signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
      tenantId: "tenant:test", actorId: "server:test", keyId: "server-key:test", connectionId: "connection:test",
      sequence: 21, messageId: "message:result-return-receipt", correlationId: frame.correlationId,
      causationId: frame.messageId, nonce: "nonce_codex_result_receipt_123456789",
      sentAt: receivedAt, expiresAt: "2026-09-13T12:03:00.000Z",
      type: "harness.codex.result.return.receipt", body }, serverKeys.privateKey);
  };
}

test("returns one authenticated, bounded and wholly inert terminal result receipt", async () => {
  const value = prepared(), frame = resultFrame(value.body), auth = await authenticated(frame);
  const exchange = new CodexResultReturnExchangeV1(expectation(value)), calls = { value: 0 };
  const accepted = await exchange.accept({ authenticated: auth.result, acknowledgementState: "initial",
    receivedAt, issueReceipt: issueReceipt(frame, calls) });
  assert.equal(accepted.replayed, false); assert.equal(calls.value, 1);
  assert.equal(value.body.result.sizeBytes, Buffer.byteLength(value.body.publication.result.text));
  assert.equal(value.body.result.terminalFrameOrdinal, 1); assert.equal(value.body.result.terminalFrameCount, 1);
  assert.equal(value.body.physicalQualification.validUntil, "2026-09-13T12:04:00.000Z");
  assert.equal(value.body.publication.contractDigest, value.publication.contractDigest);
  assert.equal(value.body.terminalEvidence.evidenceDigest, value.terminalEvidence.evidenceDigest);
  for (const flag of ["startsWork", "approvalGranted", "canonicalPublicationAllowed", "completionRecorded",
    "releasesCapacity", "permitsRetry", "permitsResume", "permitsNewTurn", "permitsThreadRead",
    "grantsExecutionAuthority"] as const) {
    assert.equal(value.body[flag], false); assert.equal(accepted.receipt.body[flag], false);
  }
  assert.equal(accepted.receipt.body.acknowledgesTransportOnly, true);
  assert.ok(Object.isFrozen(value.body)); assert.ok(Object.isFrozen(value.body.result));
  assert.ok(Object.isFrozen(accepted.receipt)); assert.ok(Object.isFrozen(accepted.receipt.body.identity));
  assert.deepEqual(codexResultReturnBodySchemaV1.parse(value.body), value.body);
  assert.deepEqual(codexResultReturnReceiptBodySchemaV1.parse(accepted.receipt.body), accepted.receipt.body);

  const receiptAuth = authenticator("server_to_node");
  const verifiedReceipt = await receiptAuth.verify(JSON.stringify(accepted.receipt), {
    expectedDirection: "server_to_node", expectedConnectionId: "connection:test",
    receivedAt: "2026-09-13T12:00:02.000Z", transportIdentity: "transport:test",
  });
  assert.equal(verifiedReceipt.frame.type, "harness.codex.result.return.receipt");
  assert.equal(verifiedReceipt.frame.body.returnFrameDigest, sha256Digest(frame));
  assert.equal(CODEX_RESULT_RETURN_FEATURE_V1, "harness.codex.result-return.v1");
});

test("rejects every expected lineage, activation, connector, peer and connection mismatch", async () => {
  const value = prepared(), frame = resultFrame(value.body);
  const fields: Array<[string, (expected: CodexResultReturnExpectationV1) => void]> = [
    ["tenant", x => { x.identity = { ...x.identity, tenantId: "tenant:other" }; }],
    ["project", x => { x.identity = { ...x.identity, projectId: "project:other" }; }],
    ["job", x => { x.identity = { ...x.identity, jobId: "job:other" }; }],
    ["attempt", x => { x.identity = { ...x.identity, attemptId: "attempt:other" }; }],
    ["run", x => { x.identity = { ...x.identity, runId: "run:other" }; }],
    ["node", x => { x.identity = { ...x.identity, nodeId: "node:other" }; }],
    ["lease", x => { x.identity = { ...x.identity, leaseId: "lease:other" }; }],
    ["epoch", x => { x.identity = { ...x.identity, leaseEpoch: 8 }; }],
    ["activation id", x => { x.activation = { ...x.activation, activationId: "activation:other" }; }],
    ["activation digest", x => { x.activation = { ...x.activation, activationDigest: sha256Digest("other") }; }],
    ["profile id", x => { x.connector = { ...x.connector, profileId: "profile:other" }; }],
    ["profile digest", x => { x.connector = { ...x.connector, profileDigest: sha256Digest("other") }; }],
    ["connection", x => { x.connectionId = "connection:other"; }],
    ["node actor", x => { x.nodeActorId = "node:other"; }],
    ["node key", x => { x.nodeKeyId = "node-key:other"; }],
    ["server actor", x => { x.serverActorId = "server:other"; }],
    ["server key", x => { x.serverKeyId = "server-key:other"; }],
    ["qualification age", x => { x.qualificationMaximumAgeMs += 1; }],
  ];
  for (const [name, mutate] of fields) {
    const auth = await authenticated(frame), expected = structuredClone(expectation(value));
    mutate(expected);
    const exchange = new CodexResultReturnExchangeV1(expected);
    await assert.rejects(exchange.accept({ authenticated: auth.result, acknowledgementState: "initial",
      receivedAt, issueReceipt: issueReceipt(frame, { value: 0 }) }), /codex_result_return_unavailable/, name);
  }
});

test("rejects tampered nested bindings even when the outer return digest is recomputed", () => {
  const body = prepared().body;
  for (const mutation of [
    { identity: { ...body.identity, runId: "run:other" } },
    { result: { ...body.result, threadId: "thread:other" } },
    { result: { ...body.result, turnId: "turn:other" } },
    { result: { ...body.result, itemId: "item:other" } },
    { result: { ...body.result, contentHash: sha256Digest("other-content") } },
    { activation: { ...body.activation, activationDigest: sha256Digest("other-activation") } },
    { connector: { ...body.connector, profileDigest: sha256Digest("other-profile") } },
    { physicalQualification: { ...body.physicalQualification,
      receiptBodyDigest: sha256Digest("other-qualification") } },
    { terminalEvidence: { ...body.terminalEvidence, evidenceDigest: sha256Digest("other-evidence") } },
  ]) {
    const changed = { ...structuredClone(body), ...mutation } as Record<string, unknown>;
    const { returnDigest: _ignored, ...material } = changed;
    changed.returnDigest = sha256Digest(material);
    assert.equal(codexResultReturnBodySchemaV1.safeParse(changed).success, false);
  }
});

test("accepts only an exact lost-acknowledgement replay and never issues a second receipt", async () => {
  const value = prepared(), frame = resultFrame(value.body), replay = new ExactReplay();
  const auth = authenticator("node_to_server", replay);
  const first = await auth.verify(JSON.stringify(frame), { expectedDirection: "node_to_server",
    expectedConnectionId: "connection:test", receivedAt, transportIdentity: "transport:test" });
  const exchange = new CodexResultReturnExchangeV1(expectation(value)), calls = { value: 0 };
  const original = await exchange.accept({ authenticated: first, acknowledgementState: "initial",
    receivedAt, issueReceipt: issueReceipt(frame, calls) });
  const duplicate = await auth.verify(JSON.stringify(frame), { expectedDirection: "node_to_server",
    expectedConnectionId: "connection:test", receivedAt, transportIdentity: "transport:test" });
  await assert.rejects(exchange.accept({ authenticated: duplicate, acknowledgementState: "initial",
    receivedAt, issueReceipt: issueReceipt(frame, calls) }), /codex_result_return_unavailable/);
  const replayed = await exchange.accept({ authenticated: duplicate, acknowledgementState: "lost_acknowledgement",
    receivedAt, issueReceipt: issueReceipt(frame, calls) });
  assert.equal(replayed.replayed, true); assert.deepEqual(replayed.receipt, original.receipt); assert.equal(calls.value, 1);
});

test("rejects a second terminal frame and a changed same-item replay", async () => {
  const value = prepared(), firstFrame = resultFrame(value.body), firstAuth = await authenticated(firstFrame);
  const exchange = new CodexResultReturnExchangeV1(expectation(value));
  await exchange.accept({ authenticated: firstAuth.result, acknowledgementState: "initial", receivedAt,
    issueReceipt: issueReceipt(firstFrame, { value: 0 }) });

  const duplicateFrame = resultFrame(value.body, "message:second-terminal");
  const duplicateAuth = await authenticated(duplicateFrame);
  await assert.rejects(exchange.accept({ authenticated: duplicateAuth.result, acknowledgementState: "initial",
    receivedAt, issueReceipt: issueReceipt(duplicateFrame, { value: 0 }) }), /codex_result_return_unavailable/);

  const changed = prepared("Changed terminal bytes."), changedFrame = resultFrame(changed.body, "message:changed-terminal");
  const changedAuth = await authenticated(changedFrame);
  await assert.rejects(exchange.accept({ authenticated: changedAuth.result,
    acknowledgementState: "lost_acknowledgement", receivedAt,
    issueReceipt: issueReceipt(changedFrame, { value: 0 }) }), /codex_result_return_unavailable/);
});

test("rejects stale or forged physical qualification before issuing a receipt", async () => {
  const value = prepared(), frame = resultFrame(value.body), auth = await authenticated(frame);
  const stale = new CodexResultReturnExchangeV1(expectation(value));
  await assert.rejects(stale.accept({ authenticated: auth.result, acknowledgementState: "initial",
    receivedAt: value.body.physicalQualification.validUntil, issueReceipt: issueReceipt(frame, { value: 0 }) }),
  /codex_result_return_unavailable/);

  const otherKeys = generateKeyPairSync("ed25519");
  const forgedExpected = expectation(value);
  forgedExpected.qualificationReceipt = signArtifact(value.qualificationValue.body, otherKeys.privateKey);
  const forged = new CodexResultReturnExchangeV1(forgedExpected);
  await assert.rejects(forged.accept({ authenticated: auth.result, acknowledgementState: "initial",
    receivedAt, issueReceipt: issueReceipt(frame, { value: 0 }) }), /codex_result_return_unavailable/);
});

test("fatal UTF-8 and malformed Unicode are refused, and result bytes stop at 65,536", () => {
  assert.throws(() => decodeNativeHttpPacketUtf8(Uint8Array.from([0xc3, 0x28])), /native_http_unavailable/);
  assert.throws(() => decodeNativeHttpPacketUtf8("\ud800"), /native_http_unavailable/);
  const maximum = prepared("x".repeat(65_536));
  assert.equal(maximum.body.result.sizeBytes, 65_536);
  const maximumFrame = resultFrame(maximum.body);
  const packet = encodeNativeWire(JSON.stringify(maximumFrame), "node_to_server");
  const decoded = decodeNativeWire(Buffer.from(packet), "node_to_server");
  assert.equal(decoded.raw, JSON.stringify(maximumFrame)); assert.equal(decoded.bytes, undefined);
  assert.throws(() => prepared("x".repeat(65_537)), /codex_completed_turn_projection_unavailable/);
});

test("escape-heavy maximum content fails closed before publication when its encoded contract exceeds the inner limit", () => {
  const text = '"'.repeat(65_536);
  assert.equal(Buffer.byteLength(text), 65_536);
  assert.ok(Buffer.byteLength(JSON.stringify(text)) > 131_072);
  assert.throws(() => prepared(text), /codex_result_publication_contract_unavailable/);
});

test("wrong outer direction, peer identity, changed signed replay and malformed receipt all fail closed", async () => {
  const value = prepared(), frame = resultFrame(value.body);
  const replay = new ExactReplay(), auth = authenticator("node_to_server", replay);
  await auth.verify(JSON.stringify(frame), { expectedDirection: "node_to_server", expectedConnectionId: "connection:test",
    receivedAt, transportIdentity: "transport:test" });
  const changedMessage = resultFrame(prepared("Changed same-message bytes.").body);
  await assert.rejects(auth.verify(JSON.stringify(changedMessage), { expectedDirection: "node_to_server",
    expectedConnectionId: "connection:test", receivedAt, transportIdentity: "transport:test" }));
  await assert.rejects(authenticator("server_to_node").verify(JSON.stringify(frame), {
    expectedDirection: "server_to_node", expectedConnectionId: "connection:test", receivedAt,
    transportIdentity: "transport:test",
  }));

  const fresh = await authenticated(frame), exchange = new CodexResultReturnExchangeV1(expectation(value));
  await assert.rejects(exchange.accept({ authenticated: fresh.result, acknowledgementState: "initial", receivedAt,
    issueReceipt: async body => ({ ...await issueReceipt(frame, { value: 0 })(body), causationId: "message:other" }) }),
  /codex_result_return_unavailable/);
  await assert.rejects(exchange.accept({ authenticated: fresh.result, acknowledgementState: "initial", receivedAt,
    issueReceipt: issueReceipt(frame, { value: 0 }) }), /codex_result_return_unavailable/);
});

test("schema-invalid receipt timestamps and fields are never cached and permanently close issuance", async () => {
  const value = prepared(), frame = resultFrame(value.body);
  for (const mutate of [
    (receipt: Awaited<ReturnType<ReturnType<typeof issueReceipt>>>) => ({ ...receipt, sentAt: "not-an-instant" }),
    (receipt: Awaited<ReturnType<ReturnType<typeof issueReceipt>>>) => ({ ...receipt, expiresAt: "not-an-instant" }),
    (receipt: Awaited<ReturnType<ReturnType<typeof issueReceipt>>>) => ({ ...receipt, unexpected: true }),
  ]) {
    const fresh = await authenticated(frame), exchange = new CodexResultReturnExchangeV1(expectation(value));
    const calls = { value: 0 }, signer = issueReceipt(frame, calls);
    await assert.rejects(exchange.accept({ authenticated: fresh.result, acknowledgementState: "initial", receivedAt,
      issueReceipt: async body => mutate(await signer(body)) }), /codex_result_return_unavailable/);
    assert.equal(calls.value, 1);
    await assert.rejects(exchange.accept({ authenticated: fresh.result, acknowledgementState: "initial", receivedAt,
      issueReceipt: signer }), /codex_result_return_unavailable/);
    assert.equal(calls.value, 1);
  }
});
