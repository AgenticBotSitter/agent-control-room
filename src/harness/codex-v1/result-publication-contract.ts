import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertNoSecretMaterial } from '../../security/redaction';
import { sha256Digest } from '../../security/canonical-digest';
import { computeArtifactBodyDigest, verifyArtifactSignature } from '../../node-policy/v1/crypto';
import { digestSchema, localId } from '../v1/native-run-identifiers';
import { codexTaskActivationBodySchemaV1 } from './activation-contract';
import { CODEX_APP_SERVER_ADAPTER } from './delivery-contract';
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from './schema-contract';

export const CODEX_PHYSICAL_QUALIFICATION_RECEIPT_SCHEMA_V1 =
  'control-room.codex-physical-qualification-receipt/v1' as const;
export const CODEX_RESULT_PUBLICATION_CONTRACT_SCHEMA_V1 =
  'control-room.codex-result-publication-contract/v1' as const;

const MAXIMUM_RESULT_BYTES = 65_536;
const MAXIMUM_QUALIFICATION_RECEIPT_BYTES = 32_768;
const MAXIMUM_PUBLICATION_CONTRACT_BYTES = 131_072;
const instant = z.string().datetime();
const signature = z.string().regex(/^[A-Za-z0-9_-]{64,256}$/);

const exactPackageSchemaV1 = z.object({
  adapterId: z.literal(CODEX_APP_SERVER_ADAPTER),
  packageName: z.literal(CODEX_APP_SERVER_READ_CONTRACT.package),
  packageVersion: z.literal(CODEX_APP_SERVER_READ_CONTRACT.version),
  generatedSchemaBundleSha256: z.literal(CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256),
  threadStartParamsSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256),
  threadStartResponseSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256),
  turnStartParamsSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256),
  turnStartResponseSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256),
  threadReadResponseSchemaSha256: z.literal(CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256),
  agentMessageSourceSha256: z.literal(CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256),
}).strict();

function exactPackageV1(): z.infer<typeof exactPackageSchemaV1> {
  return {
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
  };
}

const qualificationStartSchemaV1 = z.object({
  evidenceId: localId,
  processAttemptId: localId,
  connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema,
  threadId: localId,
  turnId: localId,
  startObserved: z.literal(true),
  cleanupVerified: z.literal(true),
  evidenceDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { evidenceDigest, ...material } = value;
  if (evidenceDigest !== sha256Digest(material)) {
    context.addIssue({ code: 'custom', message: 'qualification start evidence digest mismatch' });
  }
});

const qualificationRestartReadSchemaV1 = z.object({
  evidenceId: localId,
  processAttemptId: localId,
  connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema,
  threadId: localId,
  turnId: localId,
  itemId: localId,
  restartObserved: z.literal(true),
  exactReadObserved: z.literal(true),
  cleanupVerified: z.literal(true),
  evidenceDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { evidenceDigest, ...material } = value;
  if (evidenceDigest !== sha256Digest(material)) {
    context.addIssue({ code: 'custom', message: 'qualification restart/read evidence digest mismatch' });
  }
});

const qualificationReceiptMaterialSchemaV1 = z.object({
  schema: z.literal(CODEX_PHYSICAL_QUALIFICATION_RECEIPT_SCHEMA_V1),
  qualificationId: localId,
  qualificationSignerKeyId: localId,
  tenantId: localId,
  nodeId: localId,
  connectorProfileId: localId,
  connectorProfileDigest: digestSchema,
  exactPackage: exactPackageSchemaV1,
  qualifiedAt: instant,
  start: qualificationStartSchemaV1,
  restartRead: qualificationRestartReadSchemaV1,
  oneFreshProcessPerAttempt: z.literal(true),
  sameDurableThreadObserved: z.literal(true),
  sameDurableTurnObserved: z.literal(true),
  terminalCleanupVerified: z.literal(true),
  processReuseObserved: z.literal(false),
  retryObserved: z.literal(false),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  permitsThreadRead: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.start.processAttemptId === value.restartRead.processAttemptId
    || value.start.connectionAttemptId === value.restartRead.connectionAttemptId
    || value.start.evidenceId === value.restartRead.evidenceId
    || value.start.evidenceDigest === value.restartRead.evidenceDigest
    || value.start.threadId !== value.restartRead.threadId
    || value.start.turnId !== value.restartRead.turnId) {
    context.addIssue({ code: 'custom', message: 'qualification replay or durable identity ambiguity' });
  }
});

export const codexPhysicalQualificationReceiptBodySchemaV1 = qualificationReceiptMaterialSchemaV1.safeExtend({
  bodyDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (value.bodyDigest !== computeArtifactBodyDigest(value)) {
    context.addIssue({ code: 'custom', message: 'qualification receipt digest mismatch' });
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAXIMUM_QUALIFICATION_RECEIPT_BYTES) {
    context.addIssue({ code: 'custom', message: 'qualification receipt oversized' });
  }
});

export const signedCodexPhysicalQualificationReceiptSchemaV1 = z.object({
  body: codexPhysicalQualificationReceiptBodySchemaV1,
  signatureAlgorithm: z.literal('Ed25519'),
  signature,
}).strict();

export type CodexPhysicalQualificationReceiptBodyV1 =
  z.infer<typeof codexPhysicalQualificationReceiptBodySchemaV1>;
export type SignedCodexPhysicalQualificationReceiptV1 =
  z.infer<typeof signedCodexPhysicalQualificationReceiptSchemaV1>;

function unavailable(): never { throw new Error('codex_result_publication_contract_unavailable'); }

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++index >= value.length) return false;
      const low = value.charCodeAt(index);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Builds only the bounded body that an external qualification authority may sign. No key is selected here. */
export function createCodexPhysicalQualificationReceiptBodyV1(
  input: z.input<typeof qualificationReceiptMaterialSchemaV1>,
): CodexPhysicalQualificationReceiptBodyV1 {
  try {
    const material = qualificationReceiptMaterialSchemaV1.parse(input);
    return deepFreeze(codexPhysicalQualificationReceiptBodySchemaV1.parse({
      ...material, bodyDigest: computeArtifactBodyDigest(material),
    }));
  } catch { return unavailable(); }
}

/** Verifies one explicitly selected signer and receipt. It confers no runtime or publication authority. */
export function verifyCodexPhysicalQualificationReceiptV1(input: {
  receipt: unknown;
  expectedQualificationId: string;
  expectedBodyDigest: string;
  expectedSignerKeyId: string;
  publicKeySpki: string;
}): SignedCodexPhysicalQualificationReceiptV1 {
  try {
    const expected = z.object({ expectedQualificationId: localId, expectedBodyDigest: digestSchema,
      expectedSignerKeyId: localId, publicKeySpki: z.string().min(1).max(8192) }).strict().parse({
        expectedQualificationId: input.expectedQualificationId, expectedBodyDigest: input.expectedBodyDigest,
        expectedSignerKeyId: input.expectedSignerKeyId, publicKeySpki: input.publicKeySpki,
      });
    const receipt = signedCodexPhysicalQualificationReceiptSchemaV1.parse(input.receipt);
    if (receipt.body.qualificationId !== expected.expectedQualificationId
      || receipt.body.bodyDigest !== expected.expectedBodyDigest
      || receipt.body.qualificationSignerKeyId !== expected.expectedSignerKeyId
      || !verifyArtifactSignature(receipt, expected.publicKeySpki)) return unavailable();
    return deepFreeze(receipt);
  } catch { return unavailable(); }
}

const completedTurnMaterialSchemaV1 = z.object({
  schema: z.literal('control-room.codex-exact-package-completed-turn/v1'),
  threadId: localId,
  turnId: localId,
  itemId: localId,
  phase: z.enum(['unphased', 'final_answer']),
  text: z.string(),
  sizeBytes: z.number().int().min(1).max(MAXIMUM_RESULT_BYTES),
  contentHash: digestSchema,
  rawResultDigest: digestSchema,
  matchedTurnDigest: digestSchema,
  source: z.literal('exact_package_generated_schema'),
  selectedResultItemSchemaQualified: z.literal(true),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  permitsThreadRead: z.literal(false),
}).strict();

const completedTurnObservationSchemaV1 = completedTurnMaterialSchemaV1.extend({
  projectionDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { projectionDigest, ...material } = value;
  const bytes = Buffer.from(value.text, 'utf8');
  if (!wellFormed(value.text) || value.text.trim().length === 0 || bytes.byteLength !== value.sizeBytes
    || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== value.contentHash
    || sha256Digest(material) !== projectionDigest) {
    context.addIssue({ code: 'custom', message: 'completed turn content binding mismatch' });
  }
});

const resultPublicationMaterialSchemaV1 = z.object({
  schema: z.literal(CODEX_RESULT_PUBLICATION_CONTRACT_SCHEMA_V1),
  publicationId: localId,
  identity: z.object({
    tenantId: localId, projectId: localId, jobId: localId, attemptId: localId,
    runId: localId, nodeId: localId, leaseId: localId, leaseEpoch: z.number().int().positive(),
  }).strict(),
  delivery: z.object({
    activationId: localId, activationDigest: digestSchema,
    dispatchMessageId: localId, dispatchFrameDigest: digestSchema, dispatchBodyDigest: digestSchema,
    receiptMessageId: localId, receiptFrameDigest: digestSchema, receiptBodyDigest: digestSchema,
  }).strict(),
  connection: z.object({
    connectionId: localId, connectionAttemptId: localId, initializedConnectionDigest: digestSchema,
    connectorProfileId: localId, connectorProfileDigest: digestSchema,
  }).strict(),
  exactPackage: exactPackageSchemaV1,
  result: z.object({
    projectionSchema: z.literal('control-room.codex-exact-package-completed-turn/v1'),
    threadId: localId, turnId: localId, itemId: localId,
    phase: z.enum(['unphased', 'final_answer']), text: z.string(),
    projectionDigest: digestSchema, rawResultDigest: digestSchema, rawTurnDigest: digestSchema,
    contentHash: digestSchema, contentSizeBytes: z.number().int().min(1).max(MAXIMUM_RESULT_BYTES),
  }).strict(),
  physicalQualification: z.object({
    qualificationId: localId, receiptBodyDigest: digestSchema, signerKeyId: localId,
    qualificationSchema: z.literal(CODEX_PHYSICAL_QUALIFICATION_RECEIPT_SCHEMA_V1),
  }).strict(),
  observationSource: z.literal('stored_thread_read'),
  selectedResultItemSchemaQualified: z.literal(true),
  physicalQualificationVerified: z.literal(true),
  startsWork: z.literal(false),
  writesResult: z.literal(false),
  writesArtifact: z.literal(false),
  writesReview: z.literal(false),
  releasesCapacity: z.literal(false),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  permitsNewTurn: z.literal(false),
  permitsThreadRead: z.literal(false),
  performsIo: z.literal(false),
}).strict();

function completedTurnProjectionMaterialV1(value: z.infer<typeof resultPublicationMaterialSchemaV1>['result']) {
  return {
    schema: value.projectionSchema,
    threadId: value.threadId,
    turnId: value.turnId,
    itemId: value.itemId,
    phase: value.phase,
    text: value.text,
    sizeBytes: value.contentSizeBytes,
    contentHash: value.contentHash,
    rawResultDigest: value.rawResultDigest,
    matchedTurnDigest: value.rawTurnDigest,
    source: 'exact_package_generated_schema' as const,
    selectedResultItemSchemaQualified: true as const,
    canonicalPublicationAllowed: false as const,
    completionVerified: false as const,
    grantsExecutionAuthority: false as const,
    permitsRetry: false as const,
    permitsResume: false as const,
    permitsThreadRead: false as const,
  };
}

function publicationIdV1(value: Pick<z.infer<typeof resultPublicationMaterialSchemaV1>, 'identity' | 'result'>) {
  return `codex-result:${sha256Digest({ ...value.identity, threadId: value.result.threadId,
    turnId: value.result.turnId, itemId: value.result.itemId }).slice(7)}`;
}

export const codexResultPublicationContractSchemaV1 = resultPublicationMaterialSchemaV1.extend({
  contractDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { contractDigest, ...material } = value;
  const bytes = Buffer.from(value.result.text, 'utf8');
  let containsSecret = false;
  try { assertNoSecretMaterial(value.result.text, 'Codex result publication content'); }
  catch { containsSecret = true; }
  if (!wellFormed(value.result.text) || value.result.text.trim().length === 0
    || bytes.byteLength !== value.result.contentSizeBytes
    || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== value.result.contentHash
    || sha256Digest(completedTurnProjectionMaterialV1(value.result)) !== value.result.projectionDigest
    || publicationIdV1(value) !== value.publicationId || containsSecret) {
    context.addIssue({ code: 'custom', message: 'result publication content or identity mismatch' });
  }
  if (contractDigest !== sha256Digest(material)) {
    context.addIssue({ code: 'custom', message: 'result publication contract digest mismatch' });
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAXIMUM_PUBLICATION_CONTRACT_BYTES) {
    context.addIssue({ code: 'custom', message: 'result publication contract oversized' });
  }
});

export type CodexResultPublicationContractV1 = z.infer<typeof codexResultPublicationContractSchemaV1>;

const expectedPublicationBindingSchemaV1 = z.object({
  identity: resultPublicationMaterialSchemaV1.shape.identity,
  delivery: z.object({ activationDigest: digestSchema, dispatchBodyDigest: digestSchema,
    receiptBodyDigest: digestSchema }).strict(),
  connection: resultPublicationMaterialSchemaV1.shape.connection,
  result: z.object({ threadId: localId, turnId: localId, itemId: localId,
    projectionDigest: digestSchema, rawResultDigest: digestSchema, rawTurnDigest: digestSchema,
    contentHash: digestSchema, contentSizeBytes: z.number().int().min(1).max(MAXIMUM_RESULT_BYTES) }).strict(),
  physicalQualification: z.object({ qualificationId: localId, receiptBodyDigest: digestSchema,
    signerKeyId: localId }).strict(),
}).strict();

/**
 * Creates an inert, exact result-publication contract. This function performs no I/O and grants no
 * execution, read, retry, resume, publication, write, review, or capacity-release capability.
 */
export function createCodexResultPublicationContractV1(input: {
  activation: unknown;
  observation: unknown;
  observationSource: 'stored_thread_read';
  connection: { connectionAttemptId: string; initializedConnectionDigest: string; connectorProfileId: string };
  binding: z.input<typeof expectedPublicationBindingSchemaV1>;
  qualificationReceipt: unknown;
  qualificationPublicKeySpki: string;
}): CodexResultPublicationContractV1 {
  try {
    const activation = codexTaskActivationBodySchemaV1.parse(input.activation);
    const observation = completedTurnObservationSchemaV1.parse(input.observation);
    assertNoSecretMaterial(observation.text, 'Codex result publication content');
    const binding = expectedPublicationBindingSchemaV1.parse(input.binding);
    const connection = z.object({ connectionAttemptId: localId, initializedConnectionDigest: digestSchema,
      connectorProfileId: localId }).strict().parse(input.connection);
    if (input.observationSource !== 'stored_thread_read') return unavailable();
    const receipt = verifyCodexPhysicalQualificationReceiptV1({ receipt: input.qualificationReceipt,
      expectedQualificationId: binding.physicalQualification.qualificationId,
      expectedBodyDigest: binding.physicalQualification.receiptBodyDigest,
      expectedSignerKeyId: binding.physicalQualification.signerKeyId,
      publicKeySpki: input.qualificationPublicKeySpki });
    if (receipt.body.tenantId !== activation.tenantId || receipt.body.nodeId !== activation.nodeId
      || receipt.body.connectorProfileId !== connection.connectorProfileId
      || receipt.body.connectorProfileDigest !== activation.connectorProfileDigest
      || sha256Digest(receipt.body.exactPackage) !== sha256Digest(exactPackageV1())) return unavailable();
    const actualIdentity = { tenantId: activation.tenantId, projectId: activation.projectId,
      jobId: activation.jobId, attemptId: activation.attemptId, runId: activation.runId,
      nodeId: activation.nodeId, leaseId: activation.leaseId, leaseEpoch: activation.leaseEpoch };
    const actualDelivery = { activationDigest: activation.activationDigest,
      dispatchBodyDigest: activation.dispatchBodyDigest, receiptBodyDigest: activation.receiptBodyDigest };
    const actualConnection = { connectionId: activation.connectionId,
      connectionAttemptId: connection.connectionAttemptId,
      initializedConnectionDigest: connection.initializedConnectionDigest,
      connectorProfileId: connection.connectorProfileId,
      connectorProfileDigest: activation.connectorProfileDigest };
    const actualResult = { threadId: observation.threadId, turnId: observation.turnId,
      itemId: observation.itemId, projectionDigest: observation.projectionDigest,
      rawResultDigest: observation.rawResultDigest, rawTurnDigest: observation.matchedTurnDigest,
      contentHash: observation.contentHash, contentSizeBytes: observation.sizeBytes };
    if (sha256Digest(binding.identity) !== sha256Digest(actualIdentity)
      || sha256Digest(binding.delivery) !== sha256Digest(actualDelivery)
      || sha256Digest(binding.connection) !== sha256Digest(actualConnection)
      || sha256Digest(binding.result) !== sha256Digest(actualResult)) return unavailable();
    const publicationIdentity = { tenantId: activation.tenantId, projectId: activation.projectId,
      jobId: activation.jobId, attemptId: activation.attemptId, runId: activation.runId,
      nodeId: activation.nodeId, leaseId: activation.leaseId, leaseEpoch: activation.leaseEpoch,
      threadId: observation.threadId, turnId: observation.turnId, itemId: observation.itemId };
    const material = resultPublicationMaterialSchemaV1.parse({
      schema: CODEX_RESULT_PUBLICATION_CONTRACT_SCHEMA_V1,
      publicationId: `codex-result:${sha256Digest(publicationIdentity).slice(7)}`,
      identity: { tenantId: activation.tenantId, projectId: activation.projectId, jobId: activation.jobId,
        attemptId: activation.attemptId, runId: activation.runId, nodeId: activation.nodeId,
        leaseId: activation.leaseId, leaseEpoch: activation.leaseEpoch },
      delivery: { activationId: activation.activationId, activationDigest: activation.activationDigest,
        dispatchMessageId: activation.dispatchMessageId, dispatchFrameDigest: activation.dispatchFrameDigest,
        dispatchBodyDigest: activation.dispatchBodyDigest, receiptMessageId: activation.receiptMessageId,
        receiptFrameDigest: activation.receiptFrameDigest, receiptBodyDigest: activation.receiptBodyDigest },
      connection: actualConnection,
      exactPackage: exactPackageV1(),
      result: { projectionSchema: observation.schema, threadId: observation.threadId,
        turnId: observation.turnId, itemId: observation.itemId, phase: observation.phase, text: observation.text,
        projectionDigest: observation.projectionDigest, rawResultDigest: observation.rawResultDigest,
        rawTurnDigest: observation.matchedTurnDigest, contentHash: observation.contentHash,
        contentSizeBytes: observation.sizeBytes },
      physicalQualification: { qualificationId: receipt.body.qualificationId,
        receiptBodyDigest: receipt.body.bodyDigest, signerKeyId: receipt.body.qualificationSignerKeyId,
        qualificationSchema: receipt.body.schema },
      observationSource: input.observationSource, selectedResultItemSchemaQualified: true,
      physicalQualificationVerified: true, startsWork: false, writesResult: false, writesArtifact: false,
      writesReview: false, releasesCapacity: false, canonicalPublicationAllowed: false,
      completionVerified: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false,
      permitsNewTurn: false, permitsThreadRead: false, performsIo: false,
    });
    return deepFreeze(codexResultPublicationContractSchemaV1.parse({
      ...material, contractDigest: sha256Digest(material),
    }));
  } catch { return unavailable(); }
}
