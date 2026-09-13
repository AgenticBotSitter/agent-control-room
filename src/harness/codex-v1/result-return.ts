import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import type { AuthenticatedFrameResult } from "../../node-protocol/v1/authentication";
import type { SignedNodeFrame } from "../../node-protocol/v1/types";
import { terminalResultEvidenceSchemaV1 } from "../v1/terminal-result-evidence";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import {
  codexResultPublicationContractSchemaV1,
  signedCodexPhysicalQualificationReceiptSchemaV1,
  verifyCodexPhysicalQualificationReceiptV1,
} from "./result-publication-contract";

export const CODEX_RESULT_RETURN_FEATURE_V1 = "harness.codex.result-return.v1" as const;
export const CODEX_RESULT_RETURN_SCHEMA_V1 = "control-room.codex-result-return/v1" as const;
export const CODEX_RESULT_RETURN_RECEIPT_SCHEMA_V1 = "control-room.codex-result-return-receipt/v1" as const;
export const CODEX_RESULT_RETURN_MAX_CONTENT_BYTES_V1 = 65_536;
export const CODEX_RESULT_RETURN_MAX_BODY_BYTES_V1 = 262_144;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const identitySchemaV1 = z.object({
  tenantId: localId,
  projectId: localId,
  jobId: localId,
  attemptId: localId,
  runId: localId,
  nodeId: localId,
  leaseId: localId,
  leaseEpoch: positiveSafeInteger,
}).strict();

const activationSchemaV1 = z.object({
  activationId: localId,
  activationDigest: digestSchema,
}).strict();

const connectorSchemaV1 = z.object({
  profileId: localId,
  profileDigest: digestSchema,
}).strict();

const resultBindingSchemaV1 = z.object({
  terminalFrameOrdinal: z.literal(1),
  terminalFrameCount: z.literal(1),
  threadId: localId,
  turnId: localId,
  itemId: localId,
  contentHash: digestSchema,
  sizeBytes: z.number().int().min(1).max(CODEX_RESULT_RETURN_MAX_CONTENT_BYTES_V1),
  projectionDigest: digestSchema,
  rawResultDigest: digestSchema,
  matchedTurnDigest: digestSchema,
}).strict();

const qualificationReferenceSchemaV1 = z.object({
  qualificationId: localId,
  receiptBodyDigest: digestSchema,
  signerKeyId: localId,
  qualifiedAt: instant,
  maximumAgeMs: positiveSafeInteger,
  validUntil: instant,
}).strict();

const inertReturnFlagsV1 = {
  startsWork: z.literal(false),
  approvalGranted: z.literal(false),
  canonicalPublicationAllowed: z.literal(false),
  completionRecorded: z.literal(false),
  releasesCapacity: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  permitsNewTurn: z.literal(false),
  permitsThreadRead: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
} as const;

const resultReturnMaterialSchemaV1 = z.object({
  schema: z.literal(CODEX_RESULT_RETURN_SCHEMA_V1),
  returnId: localId,
  identity: identitySchemaV1,
  activation: activationSchemaV1,
  connector: connectorSchemaV1,
  result: resultBindingSchemaV1,
  physicalQualification: qualificationReferenceSchemaV1,
  publication: codexResultPublicationContractSchemaV1,
  terminalEvidence: terminalResultEvidenceSchemaV1,
  terminalState: z.literal("completed"),
  returnedAt: instant,
  ...inertReturnFlagsV1,
}).strict();

function returnIdV1(value: z.infer<typeof resultReturnMaterialSchemaV1>): string {
  return `codex-result-return:${sha256Digest({
    ...value.identity,
    activationId: value.activation.activationId,
    threadId: value.result.threadId,
    turnId: value.result.turnId,
    itemId: value.result.itemId,
  }).slice(7)}`;
}

function returnBindingsMatchV1(value: z.infer<typeof resultReturnMaterialSchemaV1>): boolean {
  const publication = value.publication;
  const evidence = value.terminalEvidence;
  if (evidence.kind !== "codex_exact_completed_turn") return false;
  return sha256Digest(value.identity) === sha256Digest(publication.identity)
    && value.activation.activationId === publication.delivery.activationId
    && value.activation.activationDigest === publication.delivery.activationDigest
    && value.connector.profileId === publication.connection.connectorProfileId
    && value.connector.profileDigest === publication.connection.connectorProfileDigest
    && value.result.threadId === publication.result.threadId
    && value.result.turnId === publication.result.turnId
    && value.result.itemId === publication.result.itemId
    && value.result.contentHash === publication.result.contentHash
    && value.result.sizeBytes === publication.result.contentSizeBytes
    && value.result.projectionDigest === publication.result.projectionDigest
    && value.result.rawResultDigest === publication.result.rawResultDigest
    && value.result.matchedTurnDigest === publication.result.rawTurnDigest
    && value.physicalQualification.qualificationId === publication.physicalQualification.qualificationId
    && value.physicalQualification.receiptBodyDigest === publication.physicalQualification.receiptBodyDigest
    && value.physicalQualification.signerKeyId === publication.physicalQualification.signerKeyId
    && sha256Digest(evidence.lineage) === sha256Digest({
      tenantId: value.identity.tenantId,
      projectId: value.identity.projectId,
      jobId: value.identity.jobId,
      attemptId: value.identity.attemptId,
      runId: value.identity.runId,
      nodeId: value.identity.nodeId,
    })
    && evidence.terminalState === value.terminalState
    && evidence.content.contentHash === value.result.contentHash
    && evidence.content.sizeBytes === value.result.sizeBytes
    && evidence.source.threadId === value.result.threadId
    && evidence.source.turnId === value.result.turnId
    && evidence.source.itemId === value.result.itemId
    && evidence.source.projectionDigest === value.result.projectionDigest
    && evidence.source.rawResultDigest === value.result.rawResultDigest
    && evidence.source.matchedTurnDigest === value.result.matchedTurnDigest
    && evidence.source.qualificationDigest === value.physicalQualification.receiptBodyDigest;
}

export const codexResultReturnBodySchemaV1 = resultReturnMaterialSchemaV1.extend({
  returnDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { returnDigest, ...material } = value;
  const qualifiedAt = Date.parse(value.physicalQualification.qualifiedAt);
  const validUntil = Date.parse(value.physicalQualification.validUntil);
  if (value.returnId !== returnIdV1(material)
    || returnDigest !== sha256Digest(material)
    || !returnBindingsMatchV1(material)
    || validUntil !== qualifiedAt + value.physicalQualification.maximumAgeMs
    || Date.parse(value.returnedAt) < qualifiedAt
    || Date.parse(value.returnedAt) >= validUntil) {
    context.addIssue({ code: "custom", message: "Codex result return binding mismatch" });
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CODEX_RESULT_RETURN_MAX_BODY_BYTES_V1) {
    context.addIssue({ code: "custom", message: "Codex result return body oversized" });
  }
});

export type CodexResultReturnBodyV1 = z.infer<typeof codexResultReturnBodySchemaV1>;

const receiptMaterialSchemaV1 = z.object({
  schema: z.literal(CODEX_RESULT_RETURN_RECEIPT_SCHEMA_V1),
  receiptId: localId,
  returnMessageId: localId,
  returnFrameDigest: digestSchema,
  returnBodyDigest: digestSchema,
  returnId: localId,
  returnDigest: digestSchema,
  identity: identitySchemaV1,
  activation: activationSchemaV1,
  connector: connectorSchemaV1,
  result: resultBindingSchemaV1.omit({ projectionDigest: true, rawResultDigest: true,
    matchedTurnDigest: true, terminalFrameOrdinal: true, terminalFrameCount: true }),
  physicalQualification: qualificationReferenceSchemaV1.pick({
    qualificationId: true, receiptBodyDigest: true, signerKeyId: true, validUntil: true,
  }),
  disposition: z.literal("transport_received"),
  recordedAt: instant,
  acknowledgesTransportOnly: z.literal(true),
  ...inertReturnFlagsV1,
}).strict();

export const codexResultReturnReceiptBodySchemaV1 = receiptMaterialSchemaV1.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { receiptDigest, ...material } = value;
  if (receiptDigest !== sha256Digest(material)
    || value.receiptId !== `codex-result-return-receipt:${sha256Digest({
      returnMessageId: value.returnMessageId,
      returnFrameDigest: value.returnFrameDigest,
      returnDigest: value.returnDigest,
    }).slice(7)}`
    || Date.parse(value.recordedAt) >= Date.parse(value.physicalQualification.validUntil)) {
    context.addIssue({ code: "custom", message: "Codex result return receipt mismatch" });
  }
});

export type CodexResultReturnReceiptBodyV1 = z.infer<typeof codexResultReturnReceiptBodySchemaV1>;
export type CodexResultReturnFrameV1 = SignedNodeFrame<"harness.codex.result.return">;
export type CodexResultReturnReceiptFrameV1 = SignedNodeFrame<"harness.codex.result.return.receipt">;

function unavailable(): never { throw new Error("codex_result_return_unavailable"); }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds one inert return body from the already-validated canonical publication
 * inputs. The qualification age is a trusted caller policy, not a value selected
 * by an incoming frame.
 */
export function createCodexResultReturnBodyV1(input: {
  publication: unknown;
  terminalEvidence: unknown;
  qualificationReceipt: unknown;
  qualificationPublicKeySpki: string;
  qualificationMaximumAgeMs: number;
  returnedAt: string;
}): CodexResultReturnBodyV1 {
  try {
    const publication = codexResultPublicationContractSchemaV1.parse(input.publication);
    const terminalEvidence = terminalResultEvidenceSchemaV1.parse(input.terminalEvidence);
    if (terminalEvidence.kind !== "codex_exact_completed_turn") return unavailable();
    const qualificationMaximumAgeMs = positiveSafeInteger.parse(input.qualificationMaximumAgeMs);
    const returnedAt = instant.parse(input.returnedAt);
    const receipt = verifyCodexPhysicalQualificationReceiptV1({
      receipt: input.qualificationReceipt,
      expectedQualificationId: publication.physicalQualification.qualificationId,
      expectedBodyDigest: publication.physicalQualification.receiptBodyDigest,
      expectedSignerKeyId: publication.physicalQualification.signerKeyId,
      publicKeySpki: input.qualificationPublicKeySpki,
    });
    const qualifiedAtMs = Date.parse(receipt.body.qualifiedAt);
    const validUntilMs = qualifiedAtMs + qualificationMaximumAgeMs;
    if (!Number.isSafeInteger(validUntilMs)) return unavailable();
    const material = resultReturnMaterialSchemaV1.parse({
      schema: CODEX_RESULT_RETURN_SCHEMA_V1,
      returnId: "codex-result-return:pending",
      identity: publication.identity,
      activation: { activationId: publication.delivery.activationId,
        activationDigest: publication.delivery.activationDigest },
      connector: { profileId: publication.connection.connectorProfileId,
        profileDigest: publication.connection.connectorProfileDigest },
      result: {
        terminalFrameOrdinal: 1,
        terminalFrameCount: 1,
        threadId: publication.result.threadId,
        turnId: publication.result.turnId,
        itemId: publication.result.itemId,
        contentHash: publication.result.contentHash,
        sizeBytes: publication.result.contentSizeBytes,
        projectionDigest: publication.result.projectionDigest,
        rawResultDigest: publication.result.rawResultDigest,
        matchedTurnDigest: publication.result.rawTurnDigest,
      },
      physicalQualification: {
        qualificationId: receipt.body.qualificationId,
        receiptBodyDigest: receipt.body.bodyDigest,
        signerKeyId: receipt.body.qualificationSignerKeyId,
        qualifiedAt: receipt.body.qualifiedAt,
        maximumAgeMs: qualificationMaximumAgeMs,
        validUntil: new Date(validUntilMs).toISOString(),
      },
      publication,
      terminalEvidence,
      terminalState: "completed",
      returnedAt,
      approvalGranted: false,
      startsWork: false,
      canonicalPublicationAllowed: false,
      completionRecorded: false,
      releasesCapacity: false,
      permitsRetry: false,
      permitsResume: false,
      permitsNewTurn: false,
      permitsThreadRead: false,
      grantsExecutionAuthority: false,
    });
    const withId = { ...material, returnId: returnIdV1(material) };
    return deepFreeze(codexResultReturnBodySchemaV1.parse({ ...withId, returnDigest: sha256Digest(withId) }));
  } catch { return unavailable(); }
}

export function createCodexResultReturnReceiptBodyV1(input: {
  frame: CodexResultReturnFrameV1;
  recordedAt: string;
}): CodexResultReturnReceiptBodyV1 {
  try {
    const frame = input.frame, body = codexResultReturnBodySchemaV1.parse(frame.body);
    const recordedAt = instant.parse(input.recordedAt);
    if (frame.type !== "harness.codex.result.return" || frame.direction !== "node_to_server"
      || frame.senderKind !== "node" || frame.tenantId !== body.identity.tenantId
      || frame.actorId !== body.identity.nodeId || frame.causationId !== body.activation.activationId
      || frame.sentAt !== body.returnedAt || frame.bodyDigest !== sha256Digest(body)
      || Date.parse(frame.expiresAt) > Date.parse(body.physicalQualification.validUntil)
      || Date.parse(recordedAt) < Date.parse(frame.sentAt)
      || Date.parse(recordedAt) > Date.parse(frame.expiresAt)) return unavailable();
    const material = receiptMaterialSchemaV1.parse({
      schema: CODEX_RESULT_RETURN_RECEIPT_SCHEMA_V1,
      receiptId: `codex-result-return-receipt:${sha256Digest({
        returnMessageId: frame.messageId,
        returnFrameDigest: sha256Digest(frame),
        returnDigest: body.returnDigest,
      }).slice(7)}`,
      returnMessageId: frame.messageId,
      returnFrameDigest: sha256Digest(frame),
      returnBodyDigest: sha256Digest(body),
      returnId: body.returnId,
      returnDigest: body.returnDigest,
      identity: body.identity,
      activation: body.activation,
      connector: body.connector,
      result: { threadId: body.result.threadId, turnId: body.result.turnId,
        itemId: body.result.itemId, contentHash: body.result.contentHash, sizeBytes: body.result.sizeBytes },
      physicalQualification: { qualificationId: body.physicalQualification.qualificationId,
        receiptBodyDigest: body.physicalQualification.receiptBodyDigest,
        signerKeyId: body.physicalQualification.signerKeyId,
        validUntil: body.physicalQualification.validUntil },
      disposition: "transport_received",
      recordedAt,
      acknowledgesTransportOnly: true,
      approvalGranted: false,
      startsWork: false,
      canonicalPublicationAllowed: false,
      completionRecorded: false,
      releasesCapacity: false,
      permitsRetry: false,
      permitsResume: false,
      permitsNewTurn: false,
      permitsThreadRead: false,
      grantsExecutionAuthority: false,
    });
    return deepFreeze(codexResultReturnReceiptBodySchemaV1.parse({
      ...material, receiptDigest: sha256Digest(material),
    }));
  } catch { return unavailable(); }
}

const expectationSchemaV1 = z.object({
  identity: identitySchemaV1,
  activation: activationSchemaV1,
  connector: connectorSchemaV1,
  connectionId: localId,
  nodeActorId: localId,
  nodeKeyId: localId,
  serverActorId: localId,
  serverKeyId: localId,
  qualificationMaximumAgeMs: positiveSafeInteger,
  qualificationPublicKeySpki: z.string().min(1).max(8192),
}).strict();

export interface CodexResultReturnExpectationV1 extends z.infer<typeof expectationSchemaV1> {
  qualificationReceipt: unknown;
}

function matchesExpectedV1(body: CodexResultReturnBodyV1,
  expected: z.infer<typeof expectationSchemaV1>, qualificationReceiptValue: unknown, receivedAt: string): boolean {
  const receivedAtMs = Date.parse(receivedAt);
  try {
    const qualificationReceipt = verifyCodexPhysicalQualificationReceiptV1({
      receipt: qualificationReceiptValue,
      expectedQualificationId: body.physicalQualification.qualificationId,
      expectedBodyDigest: body.physicalQualification.receiptBodyDigest,
      expectedSignerKeyId: body.physicalQualification.signerKeyId,
      publicKeySpki: expected.qualificationPublicKeySpki,
    });
    const expectedValidUntil = Date.parse(qualificationReceipt.body.qualifiedAt) + expected.qualificationMaximumAgeMs;
    return sha256Digest(body.identity) === sha256Digest(expected.identity)
      && sha256Digest(body.activation) === sha256Digest(expected.activation)
      && sha256Digest(body.connector) === sha256Digest(expected.connector)
      && qualificationReceipt.body.tenantId === expected.identity.tenantId
      && qualificationReceipt.body.nodeId === expected.identity.nodeId
      && qualificationReceipt.body.connectorProfileId === expected.connector.profileId
      && qualificationReceipt.body.connectorProfileDigest === expected.connector.profileDigest
      && body.physicalQualification.maximumAgeMs === expected.qualificationMaximumAgeMs
      && body.physicalQualification.qualifiedAt === qualificationReceipt.body.qualifiedAt
      && Date.parse(body.physicalQualification.validUntil) === expectedValidUntil
      && Number.isFinite(receivedAtMs)
      && receivedAtMs >= Date.parse(body.returnedAt)
      && receivedAtMs < expectedValidUntil;
  } catch { return false; }
}

/**
 * One authenticated terminal-return exchange. Authentication is deliberately
 * supplied by NodeProtocolAuthenticator; this class adds exact peer, lineage,
 * qualification-freshness and one-terminal-frame semantics. It has no process,
 * provider, publisher, storage, retry, resume or capacity port.
 */
export class CodexResultReturnExchangeV1 {
  private accepted?: { frameDigest: string; receipt: CodexResultReturnReceiptFrameV1 };
  private state: "open" | "issuing" | "accepted" | "closed" = "open";
  private readonly expected!: z.infer<typeof expectationSchemaV1>;
  private readonly qualificationReceipt!: unknown;

  constructor(expected: CodexResultReturnExpectationV1) {
    try {
      const { qualificationReceipt, ...material } = expected;
      this.expected = deepFreeze(expectationSchemaV1.parse(material));
      this.qualificationReceipt = deepFreeze(signedCodexPhysicalQualificationReceiptSchemaV1.parse(qualificationReceipt));
    } catch { return unavailable(); }
  }

  async accept(input: {
    authenticated: AuthenticatedFrameResult;
    acknowledgementState: "initial" | "lost_acknowledgement";
    receivedAt: string;
    issueReceipt(body: CodexResultReturnReceiptBodyV1): Promise<unknown>;
  }): Promise<{ receipt: CodexResultReturnReceiptFrameV1; replayed: boolean }> {
    let consumedReceiptSlot = false;
    try {
      const frame = input.authenticated.frame;
      if (frame.type !== "harness.codex.result.return") return unavailable();
      const resultFrame = frame as CodexResultReturnFrameV1;
      const body = codexResultReturnBodySchemaV1.parse(resultFrame.body);
      const receivedAt = instant.parse(input.receivedAt);
      const frameDigest = sha256Digest(resultFrame);
      if (resultFrame.direction !== "node_to_server" || resultFrame.senderKind !== "node"
        || resultFrame.tenantId !== this.expected.identity.tenantId
        || resultFrame.actorId !== this.expected.nodeActorId
        || resultFrame.keyId !== this.expected.nodeKeyId
        || resultFrame.connectionId !== this.expected.connectionId
        || resultFrame.causationId !== body.activation.activationId
        || resultFrame.sentAt !== body.returnedAt
        || Date.parse(resultFrame.expiresAt) > Date.parse(body.physicalQualification.validUntil)
        || !matchesExpectedV1(body, this.expected, this.qualificationReceipt, receivedAt)) return unavailable();

      if (this.accepted) {
        if (this.state !== "accepted") return unavailable();
        if (input.acknowledgementState !== "lost_acknowledgement"
          || input.authenticated.delivery !== "duplicate"
          || frameDigest !== this.accepted.frameDigest) return unavailable();
        return deepFreeze({ receipt: structuredClone(this.accepted.receipt), replayed: true });
      }
      if (this.state !== "open" || input.acknowledgementState !== "initial"
        || input.authenticated.delivery !== "accepted") return unavailable();
      this.state = "issuing";
      consumedReceiptSlot = true;
      const receiptBody = createCodexResultReturnReceiptBodyV1({ frame: resultFrame, recordedAt: receivedAt });
      const issuedReceipt = await input.issueReceipt(receiptBody);
      // Runtime import avoids a schema-initialization cycle: the shared node schema
      // imports this module's body schemas. Callback output remains untrusted until
      // the complete protocol frame schema (including strict dates) accepts it.
      const parsedReceipt = (await import("../../node-protocol/v1/schemas")).signedNodeFrameSchema.parse(issuedReceipt);
      if (parsedReceipt.type !== "harness.codex.result.return.receipt") return unavailable();
      const receipt = parsedReceipt as CodexResultReturnReceiptFrameV1;
      if (receipt.direction !== "server_to_node"
        || receipt.senderKind !== "control_room" || receipt.tenantId !== body.identity.tenantId
        || receipt.actorId !== this.expected.serverActorId || receipt.keyId !== this.expected.serverKeyId
        || receipt.connectionId !== this.expected.connectionId || receipt.causationId !== resultFrame.messageId
        || receipt.bodyDigest !== sha256Digest(receiptBody)
        || sha256Digest(receipt.body) !== sha256Digest(receiptBody)
        || Date.parse(receipt.sentAt) < Date.parse(receivedAt)
        || Date.parse(receipt.expiresAt) > Date.parse(body.physicalQualification.validUntil)) return unavailable();
      this.accepted = deepFreeze({ frameDigest, receipt: structuredClone(receipt) });
      this.state = "accepted";
      return deepFreeze({ receipt: structuredClone(receipt), replayed: false });
    } catch {
      if (consumedReceiptSlot && this.state === "issuing") this.state = "closed";
      return unavailable();
    }
  }
}
