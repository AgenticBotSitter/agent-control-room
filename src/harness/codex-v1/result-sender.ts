import { z } from 'zod';
import type { SqliteCodexStartJournalV1 } from './start-journal';
import type { SqliteBridgeJournal } from '../../node-bridge/journal';
import type { PortableNodeBridge } from '../../node-bridge/bridge';
import { signedCodexPhysicalQualificationReceiptSchemaV1,
  createCodexResultPublicationContractV1 } from './result-publication-contract';
import { createCodexResultReturnBodyV1, type CodexResultReturnReceiptFrameV1 } from './result-return';
import { projectCodexTerminalResultEvidenceV1 } from '../v1/terminal-result-evidence';
import { digestSchema, localId } from '../v1/native-run-identifiers';

type BridgeEvidence = Pick<SqliteBridgeJournal, 'acceptedCodexActivation' | 'codexResultReturn'>;
type StartEvidence = Pick<SqliteCodexStartJournalV1, 'load'>;
type ResultBridge = Pick<PortableNodeBridge, 'sendCodexResultReturn'>;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const inputSchema = z.object({
  runId: localId,
  queueId: localId,
  connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema,
  observedAt: instant,
  status: z.literal('completed'),
  identity: z.object({ runId: localId, threadId: localId, turnId: localId,
    source: z.literal('correlated_codex_start_receipts') }).passthrough(),
  exactPackageResult: z.unknown(),
}).strict();

export interface CodexRecoveredResultV1 extends z.input<typeof inputSchema> {}

const unavailable = (): never => { throw new Error('codex_result_sender_unavailable'); };

/**
 * Builds and sends one exact completed recovery result. All canonical lineage is
 * reconstructed from the protected activation/start journals; the recovery may
 * supply only its exact saved identity, selected projection and fresh process
 * connection evidence. The current bridge connection performs the only signing,
 * sequence allocation, transport send and receipt authentication.
 */
export function createCodexResultSenderV1(input: {
  bridgeEvidence: BridgeEvidence;
  startEvidence: StartEvidence;
  bridge: ResultBridge;
  qualificationReceipt: unknown;
  qualificationPublicKeySpki: string;
  qualificationMaximumAgeMs: number;
  receiptTimeoutMs?: number;
  clock(): number;
}) {
  const receipt = signedCodexPhysicalQualificationReceiptSchemaV1.parse(input.qualificationReceipt);
  const publicKey = z.string().min(1).max(8192).parse(input.qualificationPublicKeySpki);
  const maximumAge = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .parse(input.qualificationMaximumAgeMs);
  const receiptTimeoutMs = z.number().int().min(1).max(30_000).parse(input.receiptTimeoutMs ?? 5_000);
  const activationFor = input.bridgeEvidence.acceptedCodexActivation.bind(input.bridgeEvidence);
  const returned = input.bridgeEvidence.codexResultReturn.bind(input.bridgeEvidence);
  const loadStart = input.startEvidence.load.bind(input.startEvidence);
  const send = input.bridge.sendCodexResultReturn.bind(input.bridge);
  const clock = input.clock.bind(input);
  let attempted = false;

  return Object.freeze({
    async sendRecovered(value: CodexRecoveredResultV1,
      signal: AbortSignal): Promise<CodexResultReturnReceiptFrameV1> {
      if (attempted || !(signal instanceof AbortSignal) || signal.aborted) return unavailable();
      attempted = true;
      try {
        const recovered = inputSchema.parse(value);
        const nowMs = clock();
        if (!Number.isSafeInteger(nowMs) || nowMs < Date.parse(recovered.observedAt)) unavailable();
        const returnedAt = new Date(nowMs).toISOString();
        if (returned(recovered.runId)) unavailable();
        const activationEvidence = activationFor(recovered.queueId) ?? unavailable();
        const start = loadStart(recovered.runId);
        if (start.status !== 'recorded' || !start.readIdentity
          || activationEvidence.frame.body.runId !== recovered.runId
          || activationEvidence.frame.body.queueId !== recovered.queueId
          || start.readIdentity.queueId !== recovered.queueId
          || start.readIdentity.runId !== recovered.identity.runId
          || start.readIdentity.threadId !== recovered.identity.threadId
          || start.readIdentity.turnId !== recovered.identity.turnId
          || start.readIdentity.activationId !== activationEvidence.frame.body.activationId
          || start.readIdentity.activationDigest !== activationEvidence.frame.body.activationDigest) unavailable();
        const activation = activationEvidence.frame.body;
        const observation = recovered.exactPackageResult;
        const result = observation as { threadId?: string; turnId?: string; itemId?: string;
          projectionDigest?: string; rawResultDigest?: string; matchedTurnDigest?: string;
          contentHash?: string; sizeBytes?: number };
        if (result.threadId !== recovered.identity.threadId || result.turnId !== recovered.identity.turnId) unavailable();
        const identity = { tenantId: activation.tenantId, projectId: activation.projectId,
          jobId: activation.jobId, attemptId: activation.attemptId, runId: activation.runId,
          nodeId: activation.nodeId, leaseId: activation.leaseId, leaseEpoch: activation.leaseEpoch };
        const publicationBinding = {
          identity,
          delivery: { activationDigest: activation.activationDigest,
            dispatchBodyDigest: activation.dispatchBodyDigest, receiptBodyDigest: activation.receiptBodyDigest },
          connection: { connectionId: activation.connectionId,
            connectionAttemptId: recovered.connectionAttemptId,
            initializedConnectionDigest: recovered.initializedConnectionDigest,
            connectorProfileId: receipt.body.connectorProfileId,
            connectorProfileDigest: activation.connectorProfileDigest },
          result: { threadId: result.threadId!, turnId: result.turnId!, itemId: result.itemId!,
            projectionDigest: result.projectionDigest!, rawResultDigest: result.rawResultDigest!,
            rawTurnDigest: result.matchedTurnDigest!, contentHash: result.contentHash!,
            contentSizeBytes: result.sizeBytes! },
          physicalQualification: { qualificationId: receipt.body.qualificationId,
            receiptBodyDigest: receipt.body.bodyDigest,
            signerKeyId: receipt.body.qualificationSignerKeyId },
        };
        const publication = createCodexResultPublicationContractV1({ activation, observation,
          observationSource: 'stored_thread_read', connection: {
            connectionAttemptId: recovered.connectionAttemptId,
            initializedConnectionDigest: recovered.initializedConnectionDigest,
            connectorProfileId: receipt.body.connectorProfileId,
          }, binding: publicationBinding, qualificationReceipt: receipt,
          qualificationPublicKeySpki: publicKey });
        const terminalEvidence = projectCodexTerminalResultEvidenceV1({ lineage: {
          tenantId: identity.tenantId, projectId: identity.projectId, jobId: identity.jobId,
          attemptId: identity.attemptId, runId: identity.runId, nodeId: identity.nodeId,
        }, identity: { runId: identity.runId, threadId: result.threadId!, turnId: result.turnId! },
        completedTurn: observation, qualificationDigest: receipt.body.bodyDigest,
        observedAt: recovered.observedAt });
        const body = createCodexResultReturnBodyV1({ publication, terminalEvidence,
          qualificationReceipt: receipt, qualificationPublicKeySpki: publicKey,
          qualificationMaximumAgeMs: maximumAge, returnedAt });
        return await send(recovered.queueId, body, returnedAt, signal, receiptTimeoutMs);
      } catch { return unavailable(); }
    },
  });
}
