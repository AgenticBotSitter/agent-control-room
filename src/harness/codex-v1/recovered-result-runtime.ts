import { z } from 'zod';
import type { SqliteBridgeJournal } from '../../node-bridge/journal';
import type { SqliteCodexStartJournalV1 } from './start-journal';
import type { PortableNodeBridge } from '../../node-bridge/bridge';
import { createCodexResultSenderV1, type CodexRecoveredResultV1 } from './result-sender';
import type { CodexResultReturnReceiptFrameV1 } from './result-return';
import { digestSchema, localId } from '../v1/native-run-identifiers';
import { sha256Digest } from '../../security/canonical-digest';

type BridgeEvidence = Pick<SqliteBridgeJournal, 'acceptedCodexActivation' | 'codexResultReturn'>;
type StartEvidence = Pick<SqliteCodexStartJournalV1, 'load'>;
type ResultChannel = Pick<PortableNodeBridge, 'sendCodexResultReturn'>;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const rawResultSchema = z.string().min(1).max(262_144);

const exactLineageSchema = z.object({
  runId: localId,
  queueId: localId,
  threadId: localId,
  turnId: localId,
  activationId: localId,
  activationDigest: digestSchema,
  connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema,
}).strict();

/** Owned recovery read host: the host owns the bounded read. It returns the
 * raw result exactly once along with the scope the read is bounded to. The
 * runtime borrows this host and verifies the scope against the supplied
 * lineage before projecting. */
export interface CodexRecoveryReadHostV1 {
  read(): { rawResult: string; scope: { threadId: string; turnId: string } };
  project(rawResult: string): { threadId: string; turnId: string; status: string; exactPackageResult?: unknown };
}

/** Borrowed negotiated result-return channel: currency proof plus connection binding. */
export interface CodexResultReturnChannelV1 {
  connectionId: string;
  assertCurrent(): void;
}

export type CodexRecoveredResultDispositionV1 =
  | { disposition: 'receipted'; receipt: CodexResultReturnReceiptFrameV1 }
  | { disposition: 'observed' };

const refuse = (code: string): never => {
  throw new Error(`codex_recovered_result_${code}`);
};

type StoredReplayView = {
  receiptBody?: { identity?: { runId?: unknown; attemptId?: unknown };
    activation?: { activationId?: unknown; activationDigest?: unknown };
    connector?: { profileId?: unknown; profileDigest?: unknown };
    result?: { threadId?: unknown; turnId?: unknown };
    returnFrameDigest?: unknown };
  frame?: unknown;
  activationBody?: { queueId?: unknown; attemptId?: unknown; activationId?: unknown;
    activationDigest?: unknown; connectorProfileDigest?: unknown;
    connection?: { connectionAttemptId?: unknown; initializedConnectionDigest?: unknown } };
};

/** Stored-receipt replay gate. A receipted entry is returned only when the
 * stored receipt matches the caller's complete lineage: run, queue, thread,
 * turn, attempt, activation (the session binding), connector profile, and the
 * connection binding — plus the stored frame digest. Queue, attempt, profile
 * and connection lineage are proven through the durable activation accepted
 * under the caller's queueId; the receipt alone carries no queue. Any
 * disagreement, or an unreadable activation, refuses replay_lineage_mismatch.
 * Frame authentication stays with the bridge and journal integrity layer; this
 * gate binds the already-authenticated records to the exact supplied lineage
 * and grants no replay authority beyond it. */
function matchStoredReplayLineage(view: StoredReplayView, lineage: {
  runId: string; queueId: string; threadId: string; turnId: string;
  activationId: string; activationDigest: string;
  connectionAttemptId: string; initializedConnectionDigest: string;
}) {
  const receipt = view.receiptBody, activation = view.activationBody;
  const identity = receipt?.identity, storedActivation = receipt?.activation;
  const connector = receipt?.connector, result = receipt?.result;
  const connection = activation?.connection;
  if (!receipt || !activation || !identity || !storedActivation || !connector || !result || !connection
    || identity.runId !== lineage.runId
    || result.threadId !== lineage.threadId || result.turnId !== lineage.turnId
    || storedActivation.activationId !== lineage.activationId
    || storedActivation.activationDigest !== lineage.activationDigest
    || receipt.returnFrameDigest !== sha256Digest(view.frame)
    || activation.queueId !== lineage.queueId
    || activation.activationId !== lineage.activationId
    || activation.activationDigest !== lineage.activationDigest
    || identity.attemptId !== activation.attemptId
    || (typeof connector.profileId !== 'string' || connector.profileId === '')
    || connector.profileDigest !== activation.connectorProfileDigest
    || connection.connectionAttemptId !== lineage.connectionAttemptId
    || connection.initializedConnectionDigest !== lineage.initializedConnectionDigest) {
    refuse('replay_lineage_mismatch');
  }
}

interface Lineage {
  activationConnectionId: string;
  activationDigest: string;
}

/**
 * Returns one completed, exact Codex result through the already-authenticated live
 * node connection. The outer long-lived node owner opens both journals and the
 * bridge; this runtime only borrows them and never opens, closes or recreates any.
 * Exactly one sender owns the single send slot; every failure is sanitized.
 */
export function createCodexRecoveredResultRuntimeV1(input: {
  runId: string;
  queueId: string;
  threadId: string;
  turnId: string;
  activationId: string;
  activationDigest: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  journal: BridgeEvidence;
  start: StartEvidence;
  bridge: ResultChannel;
  channel: CodexResultReturnChannelV1;
  recovery: CodexRecoveryReadHostV1;
  qualificationReceipt: unknown;
  qualificationPublicKeySpki: string;
  qualificationMaximumAgeMs: number;
  receiptTimeoutMs?: number;
  clock(): number;
}) {
  const lineage = exactLineageSchema.parse({
    runId: input.runId, queueId: input.queueId, threadId: input.threadId, turnId: input.turnId,
    activationId: input.activationId, activationDigest: input.activationDigest,
    connectionAttemptId: input.connectionAttemptId,
    initializedConnectionDigest: input.initializedConnectionDigest,
  });
  const journal = input.journal, start = input.start, bridge = input.bridge, channel = input.channel;
  const recovery = input.recovery, clock = input.clock.bind(input);
  if (!journal || !start || !bridge || !channel || !recovery) refuse('unavailable');
  let sender: ReturnType<typeof createCodexResultSenderV1>;
  try {
    sender = createCodexResultSenderV1({ bridgeEvidence: journal, startEvidence: start, bridge,
      qualificationReceipt: input.qualificationReceipt,
      qualificationPublicKeySpki: input.qualificationPublicKeySpki,
      qualificationMaximumAgeMs: input.qualificationMaximumAgeMs,
      ...(input.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: input.receiptTimeoutMs }),
      clock });
  } catch { refuse('unavailable'); }
  let consumed = false, closed = false;

  const readLineage = (): Lineage => {
    let activation!: ReturnType<BridgeEvidence['acceptedCodexActivation']>;
    let started!: ReturnType<StartEvidence['load']>;
    try {
      activation = journal.acceptedCodexActivation(lineage.queueId);
      started = start.load(lineage.runId);
    } catch { refuse('unavailable'); }
    const body = activation?.frame.body;
    const identity = (started as { status?: unknown; readIdentity?: {
      queueId?: unknown; runId?: unknown; threadId?: unknown; turnId?: unknown;
      activationId?: unknown; activationDigest?: unknown } | null })?.readIdentity;
    if (!activation || !body || (started as { status?: unknown })?.status !== 'recorded' || !identity
      || body.runId !== lineage.runId || body.queueId !== lineage.queueId
      || body.activationId !== lineage.activationId || body.activationDigest !== lineage.activationDigest
      || identity.queueId !== lineage.queueId || identity.runId !== lineage.runId
      || identity.threadId !== lineage.threadId || identity.turnId !== lineage.turnId
      || identity.activationId !== lineage.activationId
      || identity.activationDigest !== lineage.activationDigest) refuse('unavailable');
    // Bind connectionAttemptId to the durable activation's connectionId
    // (server-signed). Substitution at the call site is refused. The
    // initializedConnectionDigest comes from the same durable activation body
    // and is compared byte-for-byte against the supplied lineage value.
    const bodyView = body as { connectionId?: string;
      connection?: { connectionAttemptId?: string; initializedConnectionDigest?: string } };
    const durableConnectionAttemptId = bodyView.connection?.connectionAttemptId ?? bodyView.connectionId;
    const durableInitializedConnectionDigest = bodyView.connection?.initializedConnectionDigest;
    if (typeof durableConnectionAttemptId !== 'string' || durableConnectionAttemptId === ''
      || typeof durableInitializedConnectionDigest !== 'string' || durableInitializedConnectionDigest === ''
      || durableConnectionAttemptId !== lineage.connectionAttemptId
      || durableInitializedConnectionDigest !== lineage.initializedConnectionDigest) {
      refuse('connection_binding_invalid');
    }
    // Lifecycle gate: refuse publication when the start evidence does not
    // certify that the task process retired with cleanup verified.
    const startLifecycle = (started as { cleanupVerified?: unknown }).cleanupVerified;
    if (startLifecycle !== true) refuse('cleanup_uncertain');
    return { activationConnectionId: (body as { connectionId: string }).connectionId,
      activationDigest: (body as { activationDigest: string }).activationDigest };
  };

  const readDurable = (): ReturnType<BridgeEvidence['codexResultReturn']> => {
    try { return journal.codexResultReturn(lineage.runId); }
    catch { return refuse('cleanup_uncertain'); }
  };

  const readBounded = (): { rawResult: string; scope: { threadId: string; turnId: string } } => {
    try { return recovery.read(); }
    catch { return refuse('unavailable'); }
  };

  return Object.freeze({
    /** The owned projection never verifies cleanup; doubt survives every path. */
    cleanupDoubt: true as const,
    async recover(observedAt: string | undefined,
      signal: AbortSignal): Promise<CodexRecoveredResultDispositionV1> {
      try {
        if (closed) refuse('unavailable');
        // Observation time derives from the trusted clock, not from the
        // caller. A caller-supplied observedAt is only accepted when it
        // matches the clock within one second (auditing window). Mismatch
        // refuses publication.
        const trustedObserved = new Date(clock()).toISOString();
        const observed = typeof observedAt === 'string' && instant.safeParse(observedAt).success
          ? observedAt : trustedObserved;
        if (observed !== trustedObserved
          && Math.abs(Date.parse(trustedObserved) - Date.parse(observed)) > 1000) {
          refuse('clock_mismatch');
        }
        if (!(signal instanceof AbortSignal) || signal.aborted) refuse('unavailable');
        const durable = readDurable();
        if (durable?.status === 'receipted' && durable.receipt) {
          // Full-lineage replay validation: the stored receipt is returned
          // only when it matches the supplied exact lineage across run,
          // queue, thread, turn, attempt, activation, profile and connection.
          // Without this gate, a caller could probe receipted entries by run
          // ID for unrelated runs.
          const storedReceipt = durable.receipt as { body?: StoredReplayView['receiptBody'] };
          let activationBody: StoredReplayView['activationBody'];
          try {
            activationBody = (journal.acceptedCodexActivation(lineage.queueId) as
              { frame?: { body?: StoredReplayView['activationBody'] } } | undefined)?.frame?.body;
          } catch { refuse('replay_lineage_mismatch'); }
          matchStoredReplayLineage({ receiptBody: storedReceipt.body, frame: durable.frame,
            activationBody }, lineage);
          return { disposition: 'receipted', receipt: durable.receipt };
        }
        if (durable && (durable.status === 'prepared' || durable.status === 'sent')) {
          refuse('delivery_uncertain');
        }
        // Owned bounded read: the host invokes its own read authority and
        // returns the raw result with the scope the read was bounded to.
        const readBack = readBounded();
        const raw = rawResultSchema.parse(readBack.rawResult);
        if (readBack.scope.threadId !== lineage.threadId
          || readBack.scope.turnId !== lineage.turnId) refuse('read_scope_mismatch');
        if (consumed) refuse('unavailable');
        try { channel.assertCurrent(); } catch { refuse('unavailable'); }
        const before = readLineage();
        if (before.activationConnectionId !== channel.connectionId) refuse('unavailable');
        let projected!: ReturnType<CodexRecoveryReadHostV1['project']>;
        try { projected = recovery.project(raw); }
        catch { return { disposition: 'observed' }; }
        if (!projected || projected.status !== 'completed' || !projected.exactPackageResult
          || projected.threadId !== lineage.threadId || projected.turnId !== lineage.turnId) {
          return { disposition: 'observed' };
        }
        const after = readLineage();
        if (after.activationConnectionId !== before.activationConnectionId
          || after.activationDigest !== before.activationDigest || readDurable() !== undefined) {
          refuse('unavailable');
        }
        const value: CodexRecoveredResultV1 = { runId: lineage.runId, queueId: lineage.queueId,
          connectionAttemptId: lineage.connectionAttemptId,
          initializedConnectionDigest: lineage.initializedConnectionDigest, observedAt: observed,
          status: 'completed', identity: { runId: lineage.runId, threadId: lineage.threadId,
            turnId: lineage.turnId, source: 'correlated_codex_start_receipts' },
          exactPackageResult: projected.exactPackageResult };
        consumed = true;
        let receipt!: CodexResultReturnReceiptFrameV1;
        try { receipt = await sender!.sendRecovered(value, signal); }
        catch {
          const settled = readDurable();
          if (settled?.status === 'receipted' && settled.receipt) {
            return { disposition: 'receipted', receipt: settled.receipt };
          }
          if (settled && (settled.status === 'prepared' || settled.status === 'sent')) {
            refuse('delivery_uncertain');
          }
          refuse('unavailable');
        }
        const stored = readDurable();
        if (!stored || stored.status !== 'receipted' || !stored.receipt) refuse('receipt_invalid');
        {
          const fresh = receipt as { body?: StoredReplayView['receiptBody'] };
          const storedFrame: unknown = (stored as { frame: unknown }).frame;
          let activationBody: StoredReplayView['activationBody'];
          try {
            activationBody = (journal.acceptedCodexActivation(lineage.queueId) as
              { frame?: { body?: StoredReplayView['activationBody'] } } | undefined)?.frame?.body;
          } catch { refuse('receipt_invalid'); }
          try {
            matchStoredReplayLineage({ receiptBody: fresh.body, frame: storedFrame,
              activationBody }, lineage);
          } catch { refuse('receipt_invalid'); }
        }
        return { disposition: 'receipted', receipt };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('codex_recovered_result_')) {
          throw error;
        }
        throw new Error('codex_recovered_result_unavailable');
      }
    },
    close() { closed = true; },
  });
}
