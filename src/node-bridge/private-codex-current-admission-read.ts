import { randomBytes, randomUUID } from "node:crypto";
import { types } from "node:util";
import { codexCurrentAdmissionReadRequestSchemaV1,
  matchCodexCurrentAdmissionReadResponseV1,
  CODEX_CURRENT_ADMISSION_READ_FEATURE_V1, type CodexCurrentAdmissionReadResponseV1 }
  from "../harness/codex-v1/current-admission-read-contract";
import { digestSchema, localId } from "../harness/v1/native-run-identifiers";
import { PinnedApprovalTrustStore } from "../node-policy/v1/pinned-approval-trust";
import { SqliteNodeSecurityStateRepository } from "../node-policy/v1/persistent-security-state";
import type { NodePrivateKeyStore } from "../node-policy/v1/stores";
import { NODE_PROTOCOL_V1, signedNodeFrameSchema, verifyNodeFrameSignature, type SignedNodeFrame,
  type UnsignedNodeFrame } from "../node-protocol/v1";
import { sha256Digest } from "../security/canonical-digest";
import { codexApprovalPacketDigestV1 } from "../web/v1/codex-task-queue";
import { PortableNodeBridge } from "./bridge";
import { SqliteBridgeJournal } from "./journal";
import { ProtectedStoreFrameSigner } from "./protected-store-signer";

export const PRIVATE_CODEX_CURRENT_ADMISSION_READER_V1 =
  "control-room.private-codex-current-admission-reader/v1" as const;
export const PRIVATE_CODEX_CURRENT_ADMISSION_CAPABILITY_V1 =
  "control-room.private-codex-current-admission-capability/v1" as const;
export const CODEX_CURRENT_ADMISSION_READ_MAX_LIFETIME_MS_V1 = 30_000;

const unavailable = (): never => { throw new Error("private_codex_current_admission_read_unavailable"); };
const capabilities = new WeakMap<object, Readonly<{
  queueId: string; currentAdmissionDigest: string; serverTrustRevision: string; assertCurrent(): void;
}>>();

export type PrivateCodexCurrentAdmissionCapabilityV1 = Readonly<{
  schema: typeof PRIVATE_CODEX_CURRENT_ADMISSION_CAPABILITY_V1;
}>;

export type PrivateCodexCurrentAdmissionReaderV1 = Readonly<{
  schema: typeof PRIVATE_CODEX_CURRENT_ADMISSION_READER_V1;
  startsWork: false;
  issue(queueId: string): Promise<Readonly<{ request: SignedNodeFrame<"harness.codex.current-admission.read"> }>>;
  accept(queueId: string, rawResponse: string | Uint8Array): Promise<Readonly<{
    schema: typeof PRIVATE_CODEX_CURRENT_ADMISSION_CAPABILITY_V1;
    capability: PrivateCodexCurrentAdmissionCapabilityV1;
    response: Readonly<CodexCurrentAdmissionReadResponseV1>;
  }>>;
}>;

type Issued = Readonly<{
  request: SignedNodeFrame<"harness.codex.current-admission.read">;
  activationFrameDigest: string;
  admissionDigest: string;
  trustRevision: string;
  connectionId: string;
  expiresAt: number;
  nonce: string;
}>;

/**
 * Builds a private, one-use admission-read capability from actual protected
 * state. It creates a signed read request but deliberately has no transport;
 * a reconciled node session must carry it and later pass back raw server bytes.
 * It never starts Codex, opens a workspace, or exposes a signer/key.
 */
export function createPrivateCodexCurrentAdmissionReaderV1(input: {
  bridge: PortableNodeBridge;
  journal: SqliteBridgeJournal;
  security: SqliteNodeSecurityStateRepository;
  approvals: PinnedApprovalTrustStore;
  keys: NodePrivateKeyStore;
  clock?: () => number;
}): PrivateCodexCurrentAdmissionReaderV1 {
  if (!input || typeof input !== "object" || types.isProxy(input)
    || !(input.bridge instanceof PortableNodeBridge) || !(input.journal instanceof SqliteBridgeJournal)
    || !(input.security instanceof SqliteNodeSecurityStateRepository)
    || !(input.approvals instanceof PinnedApprovalTrustStore) || !input.keys
    || typeof input.keys.reference !== "function" || typeof input.keys.sign !== "function"
    || input.clock !== undefined && typeof input.clock !== "function") unavailable();
  const bridge = input.bridge, journal = input.journal, security = input.security, approvals = input.approvals;
  const keys = input.keys, clock = input.clock ?? Date.now, signer = new ProtectedStoreFrameSigner(keys);
  const issued = new Map<string, Issued>();

  const channelFor = (queueId: string) => {
    const channel = bridge.codexActivationChannel();
    const activation = journal.acceptedCodexActivation(queueId);
    const delivery = journal.acceptedCodexDelivery(queueId);
    if (!channel || !activation || !delivery || channel.grantsExecutionAuthority !== false) unavailable();
    const start = activation.frame.body;
    if (activation.frame.type !== "harness.codex.dispatch.activation" || channel.tenantId !== start.tenantId
      || channel.nodeId !== start.nodeId || activation.frame.connectionId !== channel.connectionId) unavailable();
    return { channel, activation, delivery, start };
  };
  const assertInstallationCurrent = (queueId: string, item: Issued) => {
    const { channel, activation } = channelFor(queueId);
    channel.assertCurrent(); approvals.assertAvailable();
    const binding = approvals.binding(), now = clock();
    if (binding.tenantId !== activation.frame.tenantId || binding.nodeId !== channel.nodeId
      || !Number.isSafeInteger(now) || now >= item.expiresAt
      || security.currentServerTrustRevision() !== item.trustRevision
      || sha256Digest(activation.frame) !== item.activationFrameDigest
      || activation.frame.body.currentAdmissionDigest !== item.admissionDigest) unavailable();
  };

  return Object.freeze({
    schema: PRIVATE_CODEX_CURRENT_ADMISSION_READER_V1,
    startsWork: false as const,
    async issue(queueId: string) {
      try {
        localId.parse(queueId); if (issued.has(queueId)) unavailable();
        const { channel, activation, delivery, start } = channelFor(queueId);
        channel.assertCurrent(); approvals.assertAvailable();
        const binding = approvals.binding();
        if (binding.tenantId !== activation.frame.tenantId || binding.nodeId !== channel.nodeId) unavailable();
        const now = clock(), expiresAt = Math.min(now + CODEX_CURRENT_ADMISSION_READ_MAX_LIFETIME_MS_V1,
          Date.parse(activation.frame.expiresAt));
        if (!Number.isSafeInteger(now) || !Number.isFinite(expiresAt) || expiresAt <= now) unavailable();
        const trustRevision = security.currentServerTrustRevision(); localId.parse(trustRevision);
        const nonce = randomBytes(32).toString("base64url");
        const body = codexCurrentAdmissionReadRequestSchemaV1.parse({
          schema: "control-room.codex-current-admission-read-request/v1", queueId,
          projectId: start.projectId, jobId: start.jobId, attemptId: start.attemptId, nodeId: start.nodeId,
          inputDigest: start.inputDigest, packetDigest: codexApprovalPacketDigestV1(delivery.frame.body),
          activationFrameDigest: sha256Digest(activation.frame),
          currentAdmissionDigest: start.currentAdmissionDigest, challengeNonce: nonce,
          startsWork: false, grantsExecutionAuthority: false,
        });
        const request = await signer.sign({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
          tenantId: channel.tenantId, actorId: channel.nodeId, keyId: keys.reference().keyId,
          connectionId: channel.connectionId, sequence: 1, messageId: `message:codex-admission:${randomUUID()}`,
          correlationId: `correlation:codex-admission:${randomUUID()}`,
          sentAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), nonce,
          type: "harness.codex.current-admission.read", body } as UnsignedNodeFrame<"harness.codex.current-admission.read">);
        issued.set(queueId, Object.freeze({ request, activationFrameDigest: body.activationFrameDigest,
          admissionDigest: body.currentAdmissionDigest, trustRevision,
          connectionId: channel.connectionId, expiresAt, nonce }));
        return Object.freeze({ request });
      } catch { return unavailable(); }
    },
    async accept(queueId: string, rawResponse: string | Uint8Array) {
      try {
        localId.parse(queueId); const item = issued.get(queueId) ?? unavailable();
        assertInstallationCurrent(queueId, item);
        const bytes = typeof rawResponse === "string" ? Buffer.from(rawResponse) : Buffer.from(rawResponse);
        const { channel, activation } = channelFor(queueId);
        if (bytes.byteLength > channel.maxFrameBytes) unavailable();
        const response = signedNodeFrameSchema.parse(JSON.parse(bytes.toString("utf8")));
        if (response.type !== "harness.codex.current-admission.read.response"
          || response.direction !== "server_to_node" || response.senderKind !== "control_room"
          || response.tenantId !== channel.tenantId || response.connectionId !== item.connectionId
          || response.actorId !== activation.frame.actorId || response.keyId !== activation.frame.keyId
          || response.causationId !== item.request.messageId) unavailable();
        const now = clock(), sentAt = Date.parse(response.sentAt), frameExpiresAt = Date.parse(response.expiresAt);
        if (!Number.isSafeInteger(now) || !Number.isFinite(sentAt) || !Number.isFinite(frameExpiresAt)
          || now >= item.expiresAt || now > frameExpiresAt || sentAt > now + 30_000 || frameExpiresAt > item.expiresAt) unavailable();
        const key = await security.resolveServerKey(response.keyId);
        if (!key || !verifyNodeFrameSignature(response, Buffer.from(key).toString("base64url"))) unavailable();
        const body = matchCodexCurrentAdmissionReadResponseV1(response.body, {
          requestMessageId: item.request.messageId, requestBodyDigest: item.request.bodyDigest, queueId,
          projectId: item.request.body.projectId, jobId: item.request.body.jobId,
          attemptId: item.request.body.attemptId, nodeId: channel.nodeId, challengeNonce: item.nonce,
          activationFrameDigest: item.activationFrameDigest, currentAdmissionDigest: item.admissionDigest,
          now, maximumExpiresAt: item.expiresAt,
        });
        if (body.expiresAt !== response.expiresAt) unavailable();
        assertInstallationCurrent(queueId, item);
        issued.delete(queueId);
        const capability = Object.freeze({ schema: PRIVATE_CODEX_CURRENT_ADMISSION_CAPABILITY_V1 });
        capabilities.set(capability, Object.freeze({ queueId, currentAdmissionDigest: body.currentAdmissionDigest,
          serverTrustRevision: item.trustRevision,
          assertCurrent: () => assertInstallationCurrent(queueId, item) }));
        return Object.freeze({ schema: PRIVATE_CODEX_CURRENT_ADMISSION_CAPABILITY_V1, capability, response: body });
      } catch { return unavailable(); }
    },
  });
}

/** The later private node-entry may consume this once to supply its session owner. */
export function consumePrivateCodexCurrentAdmissionCapabilityV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || (value as { schema?: unknown }).schema !== PRIVATE_CODEX_CURRENT_ADMISSION_CAPABILITY_V1) unavailable();
  const capability = value as PrivateCodexCurrentAdmissionCapabilityV1;
  const bound = capabilities.get(capability) ?? unavailable();
  if (!capabilities.delete(capability)) unavailable();
  return Object.freeze({
    currentAdmissionDigest(queueId: string) {
      if (queueId !== bound.queueId) unavailable(); bound.assertCurrent(); return bound.currentAdmissionDigest;
    },
    currentServerTrustRevision() { bound.assertCurrent(); return bound.serverTrustRevision; },
    assertCurrent(queueId: string) { if (queueId !== bound.queueId) unavailable(); bound.assertCurrent(); },
  });
}
