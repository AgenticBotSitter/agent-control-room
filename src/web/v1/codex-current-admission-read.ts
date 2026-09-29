import { randomBytes, randomUUID } from "node:crypto";
import { sha256Digest } from "../../security";
import { codexCurrentAdmissionReadResponseSchemaV1, type CodexCurrentAdmissionReadResponseV1 }
  from "../../harness/codex-v1/current-admission-read-contract";
import { nativeTaskSubmissionReferenceSchema } from "../../persistence/native-task-submission";
import { NODE_PROTOCOL_V1, type NodeProtocolAuthenticator, type SignedNodeFrame, type UnsignedNodeFrame }
  from "../../node-protocol/v1";
import type { TaskAssignmentCoordinator } from "./task-assignment-coordinator";
import type { AuthenticatedFrameResult } from "../../node-protocol/v1/authentication";
import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";

type ResponderPrivate = {
  readAuthenticated(authenticated: AuthenticatedFrameResult): Promise<Readonly<{
    request: SignedNodeFrame<"harness.codex.current-admission.read">;
    body: CodexCurrentAdmissionReadResponseV1; startsWork: false; grantsExecutionAuthority: false;
  }>>;
  recheck(reference: NativeTaskSubmissionReference, activation: SignedNodeFrame<"harness.codex.dispatch.activation">, nodeKeyId: string): Promise<void>;
};
const responders = new WeakMap<object, ResponderPrivate>();
/** Only the exact factory product can enter the owned server-session seam. */
export function captureCodexCurrentAdmissionResponderV1(responder: object): ResponderPrivate {
  const captured = responders.get(responder);
  if (!captured) return unavailable();
  return captured;
}

export const CODEX_CURRENT_ADMISSION_READ_MAX_LIFETIME_MS_V1 = 30_000;
const unavailable = (): never => { throw new Error("codex_current_admission_read_unavailable"); };

/**
 * Controller-side, non-executing current-admission read. Authentication is
 * performed with the real negotiated node protocol before any canonical
 * database read. The surrounding server session owns transport and signing;
 * this source package only returns one signed-response payload.
 */
export function createCodexCurrentAdmissionReadResponderV1(input: {
  coordinator: Pick<TaskAssignmentCoordinator, "readCurrentCodexQueuedAdmission">;
  authenticator: Pick<NodeProtocolAuthenticator, "verify">;
  tenantId: string;
  nodeId: string;
  connectionId: string;
  transportIdentity: string;
  clock?: () => number;
}) {
  if (!input || !input.coordinator || typeof input.coordinator.readCurrentCodexQueuedAdmission !== "function"
    || !input.authenticator || typeof input.authenticator.verify !== "function"
    || typeof input.tenantId !== "string" || typeof input.nodeId !== "string"
    || typeof input.connectionId !== "string" || typeof input.transportIdentity !== "string"
    || input.clock !== undefined && typeof input.clock !== "function") unavailable();
  const clock = input.clock ?? Date.now;
  input = Object.freeze({ ...input, coordinator: Object.freeze({
    readCurrentCodexQueuedAdmission: input.coordinator.readCurrentCodexQueuedAdmission.bind(input.coordinator),
  }), authenticator: Object.freeze({ verify: input.authenticator.verify.bind(input.authenticator) }) });

  const responder = Object.freeze({
    async read(rawRequest: string | Uint8Array): Promise<Readonly<{
      request: SignedNodeFrame<"harness.codex.current-admission.read">;
      body: CodexCurrentAdmissionReadResponseV1;
      startsWork: false;
      grantsExecutionAuthority: false;
    }>> {
      try {
        const now = clock();
        if (!Number.isSafeInteger(now)) unavailable();
        const authenticated = await input.authenticator.verify(rawRequest, {
          expectedDirection: "node_to_server", receivedAt: new Date(now).toISOString(),
          transportIdentity: input.transportIdentity, expectedConnectionId: input.connectionId,
        });
        return await readAuthenticated(authenticated);
      } catch { return unavailable(); }
    },
    /** Uses the caller's existing protected server signer; this helper never sends the frame. */
    unsignedResponse(request: SignedNodeFrame<"harness.codex.current-admission.read">,
      body: CodexCurrentAdmissionReadResponseV1, server: { serverId: string; serverKeyId: string }, sequence: number) {
      try {
        if (!Number.isInteger(sequence) || sequence <= 0 || request.tenantId !== input.tenantId
          || request.actorId !== input.nodeId || request.connectionId !== input.connectionId
          || body.requestMessageId !== request.messageId || body.requestBodyDigest !== request.bodyDigest) unavailable();
        return Object.freeze({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node" as const,
          senderKind: "control_room" as const, tenantId: input.tenantId, actorId: server.serverId, keyId: server.serverKeyId,
          connectionId: input.connectionId, sequence, messageId: `message:codex-admission:${randomUUID()}`,
          correlationId: request.correlationId, causationId: request.messageId, sentAt: body.checkedAt,
          expiresAt: body.expiresAt, nonce: randomBytes(32).toString("base64url"),
          type: "harness.codex.current-admission.read.response" as const, body,
        } satisfies UnsignedNodeFrame<"harness.codex.current-admission.read.response">);
      } catch { return unavailable(); }
    },
  });
  async function readAuthenticated(authenticated: AuthenticatedFrameResult) {
      try {
        const now = clock();
        if (!Number.isSafeInteger(now)) unavailable();
        const request = authenticated.frame;
        if (authenticated.delivery !== "accepted" || request.type !== "harness.codex.current-admission.read"
          || request.tenantId !== input.tenantId || request.actorId !== input.nodeId
          || request.connectionId !== input.connectionId || request.senderKind !== "node") return unavailable();
        const body = request.body;
        const reference = nativeTaskSubmissionReferenceSchema.parse({ schema: "control-room.native-task-submission/v1",
          tenantId: input.tenantId, projectId: body.projectId, jobId: body.jobId, attemptId: body.attemptId,
          queueId: body.queueId, inputDigest: body.inputDigest, packetDigest: body.packetDigest });
        const checked = await input.coordinator.readCurrentCodexQueuedAdmission(reference, {
          queueId: body.queueId, nodeId: body.nodeId, packetDigest: body.packetDigest,
          activationFrameDigest: body.activationFrameDigest, currentAdmissionDigest: body.currentAdmissionDigest,
        }, new AbortController().signal);
        const admission = checked.currentAdmission;
        if (admission.tenantId !== request.tenantId || admission.connectionId !== request.connectionId
          || now >= Date.parse(admission.admissionExpiresAt)) unavailable();
        const expiresAt = Math.min(now + CODEX_CURRENT_ADMISSION_READ_MAX_LIFETIME_MS_V1,
          Date.parse(request.expiresAt), Date.parse(admission.admissionExpiresAt));
        if (!Number.isFinite(expiresAt) || expiresAt <= now) unavailable();
        const response = codexCurrentAdmissionReadResponseSchemaV1.parse({
          schema: "control-room.codex-current-admission-read-response/v1", queueId: admission.queueId,
          projectId: admission.projectId, jobId: admission.jobId, attemptId: admission.attemptId,
          nodeId: admission.nodeId, requestMessageId: request.messageId, requestBodyDigest: request.bodyDigest,
          challengeNonce: body.challengeNonce, activationFrameDigest: checked.activationFrameDigest,
          currentAdmissionDigest: body.currentAdmissionDigest,
          ownerTrustRevisionDigest: admission.ownerTrustRevisionDigest,
          checkedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
          startsWork: false, grantsExecutionAuthority: false,
        });
        return Object.freeze({ request: request as SignedNodeFrame<"harness.codex.current-admission.read">,
          body: response, startsWork: false as const, grantsExecutionAuthority: false as const });
      } catch { return unavailable(); }
  }
  responders.set(responder, Object.freeze({ readAuthenticated, async recheck(reference: NativeTaskSubmissionReference,
    activation: SignedNodeFrame<"harness.codex.dispatch.activation">, nodeKeyId: string) {
    const checked = await input.coordinator.readCurrentCodexQueuedAdmission(reference, {
      queueId: reference.queueId, nodeId: input.nodeId, packetDigest: reference.packetDigest,
      activationFrameDigest: sha256Digest(activation), currentAdmissionDigest: activation.body.currentAdmissionDigest,
    }, new AbortController().signal);
    const admission = checked.currentAdmission;
    if (admission.tenantId !== input.tenantId || admission.nodeId !== input.nodeId
      || admission.connectionId !== input.connectionId || admission.connectionId !== activation.connectionId
      || admission.nodeKeyId !== nodeKeyId
      || admission.connectorProfileDigest !== activation.body.connectorProfileDigest
      || clock() >= Date.parse(admission.admissionExpiresAt)) unavailable();
  } }));
  return responder;
}
