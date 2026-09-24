import { randomBytes, randomUUID } from "node:crypto";
import { codexCurrentAdmissionReadResponseSchemaV1, type CodexCurrentAdmissionReadResponseV1 }
  from "../../harness/codex-v1/current-admission-read-contract";
import { type DatabaseClient } from "../../persistence/database";
import { NODE_PROTOCOL_V1, type NodeProtocolAuthenticator, type SignedNodeFrame, type UnsignedNodeFrame }
  from "../../node-protocol/v1";
import { sha256Digest } from "../../security";
import { assertCanonicalCodexAdmissionInSession, readCodexActivationTransmissionIntentInSession }
  from "./codex-activation-transmission-intent";

export const CODEX_CURRENT_ADMISSION_READ_MAX_LIFETIME_MS_V1 = 30_000;
const unavailable = (): never => { throw new Error("codex_current_admission_read_unavailable"); };

/**
 * Controller-side, non-executing current-admission read. Authentication is
 * performed with the real negotiated node protocol before any canonical
 * database read. The surrounding server session owns transport and signing;
 * this source package only returns one signed-response payload.
 */
export function createCodexCurrentAdmissionReadResponderV1(input: {
  db: DatabaseClient;
  activationIntegrityKey: Uint8Array;
  authenticator: Pick<NodeProtocolAuthenticator, "verify">;
  tenantId: string;
  nodeId: string;
  connectionId: string;
  transportIdentity: string;
  /** Current server owner-trust revision from the same protected configuration used by withCodexPermit. */
  currentOwnerTrustRevision(): string;
  clock?: () => number;
}) {
  if (!input || !input.db || typeof input.db.transaction !== "function"
    || !(input.activationIntegrityKey instanceof Uint8Array) || input.activationIntegrityKey.length !== 32
    || !input.authenticator || typeof input.authenticator.verify !== "function"
    || typeof input.tenantId !== "string" || typeof input.nodeId !== "string"
    || typeof input.connectionId !== "string" || typeof input.transportIdentity !== "string"
    || typeof input.currentOwnerTrustRevision !== "function"
    || input.clock !== undefined && typeof input.clock !== "function") unavailable();
  const clock = input.clock ?? Date.now;

  return Object.freeze({
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
        const request = authenticated.frame;
        if (authenticated.delivery !== "accepted" || request.type !== "harness.codex.current-admission.read"
          || request.tenantId !== input.tenantId || request.actorId !== input.nodeId
          || request.connectionId !== input.connectionId || request.senderKind !== "node") unavailable();
        const body = request.body, scope = { tenantId: input.tenantId, projectId: body.projectId,
          jobId: body.jobId, attemptId: body.attemptId, inputDigest: body.inputDigest };
        const checked = await input.db.transaction(async tx => {
          const saved = await readCodexActivationTransmissionIntentInSession(tx, input.activationIntegrityKey, scope);
          if (!saved) unavailable();
          const admission = saved.currentAdmission;
          await assertCanonicalCodexAdmissionInSession(tx, admission);
          const revision = input.currentOwnerTrustRevision();
          if (sha256Digest(revision) !== admission.ownerTrustRevisionDigest
            || body.queueId !== admission.queueId || body.nodeId !== admission.nodeId
            || body.currentAdmissionDigest !== sha256Digest(admission)
            || body.activationFrameDigest !== sha256Digest(saved.frame)
            || admission.tenantId !== request.tenantId || admission.connectionId !== request.connectionId
            || saved.frame.body.currentAdmissionDigest !== body.currentAdmissionDigest
            || now >= Date.parse(admission.admissionExpiresAt) || now >= Date.parse(saved.frame.expiresAt)) unavailable();
          return Object.freeze({ admission, activationFrameDigest: sha256Digest(saved.frame) });
        });
        const expiresAt = Math.min(now + CODEX_CURRENT_ADMISSION_READ_MAX_LIFETIME_MS_V1,
          Date.parse(request.expiresAt), Date.parse(checked.admission.admissionExpiresAt));
        if (!Number.isFinite(expiresAt) || expiresAt <= now) unavailable();
        const response = codexCurrentAdmissionReadResponseSchemaV1.parse({
          schema: "control-room.codex-current-admission-read-response/v1", queueId: checked.admission.queueId,
          projectId: checked.admission.projectId, jobId: checked.admission.jobId, attemptId: checked.admission.attemptId,
          nodeId: checked.admission.nodeId, requestMessageId: request.messageId, requestBodyDigest: request.bodyDigest,
          challengeNonce: body.challengeNonce, activationFrameDigest: checked.activationFrameDigest,
          currentAdmissionDigest: body.currentAdmissionDigest,
          ownerTrustRevisionDigest: checked.admission.ownerTrustRevisionDigest,
          checkedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
          startsWork: false, grantsExecutionAuthority: false,
        });
        return Object.freeze({ request: request as SignedNodeFrame<"harness.codex.current-admission.read">,
          body: response, startsWork: false as const, grantsExecutionAuthority: false as const });
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
}
