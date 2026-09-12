import { z } from 'zod';
import { sha256Digest } from '../../security/canonical-digest';
import { digestSchema, localId } from '../v1/native-run-identifiers';
import { CODEX_APP_SERVER_START_CONTRACT } from './schema-contract';

const instant = z.string().datetime();
const rpcId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const upstreamId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/);
const scopeSchema = z.object({
  tenantId: localId, nodeId: localId, projectId: localId, jobId: localId,
  attemptId: localId, runId: localId, leaseId: localId,
  leaseEpoch: z.number().int().positive(), operationDigest: digestSchema,
}).strict();

export const codexStartAdmissionSchemaV1 = z.object({
  schema: z.literal('control-room.codex-start-admission/v1'),
  admissionId: localId,
  scope: scopeSchema,
  requestMessageId: localId,
  deliveryDigest: digestSchema,
  enrollmentDigest: digestSchema,
  permitDigest: digestSchema,
  currentAdmissionDigest: digestSchema,
  inputDigest: digestSchema,
  method: z.literal('thread/start'),
  connectionAttemptId: localId,
  initializedConnectionDigest: digestSchema,
  threadStartRequestId: rpcId,
  adapter: z.object({
    package: z.literal(CODEX_APP_SERVER_START_CONTRACT.package),
    version: z.literal(CODEX_APP_SERVER_START_CONTRACT.version),
    generatedBundleSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.generatedBundleSha256),
    threadStartResponseSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256),
    turnStartResponseSchemaSha256: z.literal(CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256),
    transport: z.literal('json_rpc_stdio'),
  }).strict(),
  requestedAt: instant,
  deadline: instant,
  contractDigest: digestSchema,
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsResume: z.literal(false),
  permitsRetry: z.literal(false),
  permitsThreadRead: z.literal(false),
}).strict();

export type CodexStartAdmissionV1 = z.infer<typeof codexStartAdmissionSchemaV1>;

const withoutContractDigest = <T extends { contractDigest: string }>(value: T) => {
  const { contractDigest: _digest, ...unsigned } = value; void _digest; return unsigned;
};
const withoutReceiptDigest = <T extends { receiptDigest: string }>(value: T) => {
  const { receiptDigest: _digest, ...unsigned } = value; void _digest; return unsigned;
};
const withoutIntentDigest = <T extends { intentDigest: string }>(value: T) => {
  const { intentDigest: _digest, ...unsigned } = value; void _digest; return unsigned;
};

const fail = (): never => { throw new Error('codex_start_admission_unavailable'); };

/**
 * Creates inert, exact-scope evidence for a later authenticated Codex start.
 * The caller must obtain delivery, permit and current-admission digests from
 * separately verified core records. This function performs no I/O or start.
 */
export function createCodexStartAdmissionV1(value: Omit<CodexStartAdmissionV1,
  'admissionId' | 'adapter' | 'contractDigest' | 'startsWork' | 'grantsExecutionAuthority'
  | 'permitsResume' | 'permitsRetry' | 'permitsThreadRead'>): CodexStartAdmissionV1 {
  const adapter = {
    package: CODEX_APP_SERVER_START_CONTRACT.package,
    version: CODEX_APP_SERVER_START_CONTRACT.version,
    generatedBundleSha256: CODEX_APP_SERVER_START_CONTRACT.generatedBundleSha256,
    threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
    turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
    transport: 'json_rpc_stdio' as const,
  };
  const identity = { scope: value.scope, requestMessageId: value.requestMessageId,
    deliveryDigest: value.deliveryDigest, enrollmentDigest: value.enrollmentDigest,
    permitDigest: value.permitDigest, currentAdmissionDigest: value.currentAdmissionDigest,
    inputDigest: value.inputDigest, method: value.method,
    connectionAttemptId: value.connectionAttemptId,
    initializedConnectionDigest: value.initializedConnectionDigest,
    threadStartRequestId: value.threadStartRequestId, adapter,
    requestedAt: value.requestedAt, deadline: value.deadline };
  const admissionId = `codex-admission:${sha256Digest(identity).slice(7)}`;
  const unsigned = { schema: 'control-room.codex-start-admission/v1' as const, admissionId,
    ...identity, startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  const parsed = codexStartAdmissionSchemaV1.parse({ ...unsigned, contractDigest: sha256Digest(unsigned) });
  if (Date.parse(parsed.deadline) <= Date.parse(parsed.requestedAt)) return fail();
  return Object.freeze(parsed);
}

const requiredOwn = (keys: readonly string[]) => (value: object, context: z.RefinementCtx) => {
  for (const key of keys) if (!Object.hasOwn(value, key)) {
    context.addIssue({ code: 'custom', path: [key], message: `missing exact-package field: ${key}` });
  }
};
const threadProjectionSchema = z.object({
  id: upstreamId,
  sessionId: upstreamId,
  ephemeral: z.literal(false),
}).passthrough().superRefine(requiredOwn([
  'cliVersion', 'createdAt', 'cwd', 'ephemeral', 'id', 'modelProvider', 'preview',
  'projectId', 'sessionId', 'source', 'status', 'turns', 'updatedAt',
]));
const threadStartResultSchema = z.object({
  cwd: z.string(), model: z.string(), modelProvider: z.string(),
  thread: threadProjectionSchema,
}).passthrough().superRefine(requiredOwn(CODEX_APP_SERVER_START_CONTRACT.threadStart.responseRequired));
const threadResponseSchema = z.object({
  id: rpcId,
  result: threadStartResultSchema,
}).strict();

export const codexThreadStartReceiptSchemaV1 = z.object({
  schema: z.literal('control-room.codex-thread-start-receipt/v1'),
  admission: codexStartAdmissionSchemaV1,
  threadId: upstreamId,
  sessionId: upstreamId,
  responseDigest: digestSchema,
  recordedAt: instant,
  receiptDigest: digestSchema,
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsResume: z.literal(false),
  permitsRetry: z.literal(false),
  permitsThreadRead: z.literal(false),
}).strict();

export type CodexThreadStartReceiptV1 = z.infer<typeof codexThreadStartReceiptSchemaV1>;

function parseBoundedResponse(rawResponse: string) {
  if (typeof rawResponse !== 'string' || rawResponse.includes('\n') || rawResponse.includes('\r')
    || Buffer.byteLength(rawResponse, 'utf8') > 262_144) return fail();
  try { return JSON.parse(rawResponse) as unknown; } catch { return fail(); }
}

function verifyAdmission(value: unknown) {
  const admission = codexStartAdmissionSchemaV1.parse(value);
  const { admissionId: _admissionId, contractDigest: _contractDigest, schema: _schema,
    startsWork: _startsWork, grantsExecutionAuthority: _grants, permitsResume: _resume,
    permitsRetry: _retry, permitsThreadRead: _read, ...identity } = admission;
  void _admissionId; void _contractDigest; void _schema; void _startsWork; void _grants;
  void _resume; void _retry; void _read;
  if (admission.admissionId !== `codex-admission:${sha256Digest(identity).slice(7)}`
    || admission.contractDigest !== sha256Digest(withoutContractDigest(admission))
    || Date.parse(admission.deadline) <= Date.parse(admission.requestedAt)) return fail();
  return admission;
}

/** Accept only the response correlated to this exact thread/start request. */
function acceptCodexThreadStartV1(admissionValue: unknown, rawResponse: string,
  recordedAt: string): CodexThreadStartReceiptV1 {
  const admission = verifyAdmission(admissionValue);
  const response = threadResponseSchema.parse(parseBoundedResponse(rawResponse));
  if (response.id !== admission.threadStartRequestId || response.result.thread.id !== response.result.thread.sessionId
    || Date.parse(recordedAt) < Date.parse(admission.requestedAt)
    || Date.parse(recordedAt) > Date.parse(admission.deadline)) return fail();
  const unsigned = { schema: 'control-room.codex-thread-start-receipt/v1' as const,
    admission, threadId: response.result.thread.id, sessionId: response.result.thread.sessionId,
    responseDigest: sha256Digest(rawResponse), recordedAt,
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  return Object.freeze(codexThreadStartReceiptSchemaV1.parse({ ...unsigned, receiptDigest: sha256Digest(unsigned) }));
}

export const codexTurnStartIntentSchemaV1 = z.object({
  schema: z.literal('control-room.codex-turn-start-intent/v1'),
  threadReceiptDigest: digestSchema,
  method: z.literal('turn/start'),
  connectionAttemptId: localId,
  threadId: upstreamId,
  turnStartRequestId: rpcId,
  inputDigest: digestSchema,
  requestedAt: instant,
  deadline: instant,
  intentDigest: digestSchema,
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsResume: z.literal(false),
  permitsRetry: z.literal(false),
}).strict();
export type CodexTurnStartIntentV1 = z.infer<typeof codexTurnStartIntentSchemaV1>;

export function createCodexTurnStartIntentV1(threadReceiptValue: unknown, value: {
  turnStartRequestId: number; inputDigest: string; requestedAt: string; deadline: string;
}): CodexTurnStartIntentV1 {
  const thread = verifyThreadReceipt(threadReceiptValue);
  const unsigned = { schema: 'control-room.codex-turn-start-intent/v1' as const,
    threadReceiptDigest: thread.receiptDigest, method: 'turn/start' as const,
    connectionAttemptId: thread.admission.connectionAttemptId, threadId: thread.threadId,
    turnStartRequestId: value.turnStartRequestId,
    inputDigest: value.inputDigest, requestedAt: value.requestedAt, deadline: value.deadline,
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const };
  const parsed = codexTurnStartIntentSchemaV1.parse({ ...unsigned, intentDigest: sha256Digest(unsigned) });
  if (Date.parse(parsed.requestedAt) < Date.parse(thread.recordedAt)
    || Date.parse(parsed.deadline) > Date.parse(thread.admission.deadline)
    || Date.parse(parsed.deadline) <= Date.parse(parsed.requestedAt)) return fail();
  return Object.freeze(parsed);
}

const turnResponseSchema = z.object({
  id: rpcId,
  result: z.object({ turn: z.object({
    id: upstreamId,
    items: z.array(z.unknown()),
    status: z.literal('inProgress'),
  }).passthrough() }).strict(),
}).strict();

export const codexTurnStartReceiptSchemaV1 = z.object({
  schema: z.literal('control-room.codex-turn-start-receipt/v1'),
  threadReceipt: codexThreadStartReceiptSchemaV1,
  intent: codexTurnStartIntentSchemaV1,
  threadId: upstreamId,
  turnId: upstreamId,
  responseDigest: digestSchema,
  recordedAt: instant,
  receiptDigest: digestSchema,
  startAccepted: z.literal(true),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsResume: z.literal(false),
  permitsRetry: z.literal(false),
  permitsThreadRead: z.literal(false),
}).strict();
export type CodexTurnStartReceiptV1 = z.infer<typeof codexTurnStartReceiptSchemaV1>;

function verifyThreadReceipt(value: unknown) {
  const receipt = codexThreadStartReceiptSchemaV1.parse(value);
  verifyAdmission(receipt.admission);
  if (receipt.receiptDigest !== sha256Digest(withoutReceiptDigest(receipt))
    || receipt.threadId !== receipt.sessionId
    || Date.parse(receipt.recordedAt) < Date.parse(receipt.admission.requestedAt)
    || Date.parse(receipt.recordedAt) > Date.parse(receipt.admission.deadline)) return fail();
  return receipt;
}

function verifyTurnIntent(value: unknown) {
  const intent = codexTurnStartIntentSchemaV1.parse(value);
  if (intent.intentDigest !== sha256Digest(withoutIntentDigest(intent))) return fail();
  return intent;
}

function matchIntentToThread(intent: CodexTurnStartIntentV1, thread: CodexThreadStartReceiptV1) {
  if (intent.threadReceiptDigest !== thread.receiptDigest || intent.inputDigest !== thread.admission.inputDigest
    || intent.connectionAttemptId !== thread.admission.connectionAttemptId || intent.threadId !== thread.threadId
    || Date.parse(intent.requestedAt) < Date.parse(thread.recordedAt)
    || Date.parse(intent.deadline) > Date.parse(thread.admission.deadline)
    || Date.parse(intent.deadline) <= Date.parse(intent.requestedAt)) return fail();
}

/** Accept only the response correlated to the exact turn/start request. */
function acceptCodexTurnStartV1(threadReceiptValue: unknown, intentValue: unknown,
  rawResponse: string, recordedAt: string): CodexTurnStartReceiptV1 {
  const threadReceipt = verifyThreadReceipt(threadReceiptValue);
  const intent = verifyTurnIntent(intentValue);
  const response = turnResponseSchema.parse(parseBoundedResponse(rawResponse));
  matchIntentToThread(intent, threadReceipt);
  if (response.id !== intent.turnStartRequestId
    || Date.parse(recordedAt) < Date.parse(intent.requestedAt)
    || Date.parse(recordedAt) > Date.parse(intent.deadline)) return fail();
  const unsigned = { schema: 'control-room.codex-turn-start-receipt/v1' as const,
    threadReceipt, intent, threadId: threadReceipt.threadId, turnId: response.result.turn.id,
    responseDigest: sha256Digest(rawResponse), recordedAt, startAccepted: true as const,
    completionVerified: false as const, grantsExecutionAuthority: false as const,
    permitsResume: false as const, permitsRetry: false as const, permitsThreadRead: false as const };
  return Object.freeze(codexTurnStartReceiptSchemaV1.parse({ ...unsigned, receiptDigest: sha256Digest(unsigned) }));
}

/**
 * One dispatcher per initialized App Server connection identity. It keeps request reservations
 * and response provenance inside a closure, consumes every response attempt once,
 * and never reuses a JSON-RPC id on that connection. Connection identities remain
 * claimed for this process lifetime, including after close, because a connection
 * attempt must never be resumed or recreated under copied wrapper objects.
 */
const claimedConnectionIdentities = new Set<string>();

export function createCodexStartResponseDispatcherV1(connectionValue: {
  connectionAttemptId: string; initializedConnectionDigest: string;
}) {
  const connection = z.object({ connectionAttemptId: localId,
    initializedConnectionDigest: digestSchema }).strict().parse(connectionValue);
  const connectionIdentity = sha256Digest(connection);
  if (claimedConnectionIdentities.has(connectionIdentity)) return fail();
  claimedConnectionIdentities.add(connectionIdentity);
  const used = new Set<number>();
  let pending: { kind: 'thread'; requestId: number; contractDigest: string }
    | { kind: 'turn'; requestId: number; intentDigest: string; threadReceiptDigest: string }
    | undefined;
  let closed = false;
  const available = () => { if (closed) return fail(); };
  const reserveId = (requestId: number) => {
    available(); rpcId.parse(requestId);
    if (pending || used.has(requestId)) return fail();
    used.add(requestId);
  };
  return Object.freeze({
    reserveThread(admissionValue: unknown) {
      const admission = verifyAdmission(admissionValue);
      if (admission.connectionAttemptId !== connection.connectionAttemptId
        || admission.initializedConnectionDigest !== connection.initializedConnectionDigest) return fail();
      reserveId(admission.threadStartRequestId);
      pending = { kind: 'thread', requestId: admission.threadStartRequestId,
        contractDigest: admission.contractDigest };
    },
    receiveThread(admissionValue: unknown, rawResponse: string, recordedAt: string) {
      available(); const admission = verifyAdmission(admissionValue), reservation = pending; pending = undefined;
      if (!reservation || reservation.kind !== 'thread' || reservation.requestId !== admission.threadStartRequestId
        || reservation.contractDigest !== admission.contractDigest
        || admission.connectionAttemptId !== connection.connectionAttemptId
        || admission.initializedConnectionDigest !== connection.initializedConnectionDigest) return fail();
      return acceptCodexThreadStartV1(admission, rawResponse, recordedAt);
    },
    reserveTurn(threadValue: unknown, intentValue: unknown) {
      const thread = verifyThreadReceipt(threadValue), intent = verifyTurnIntent(intentValue);
      matchIntentToThread(intent, thread);
      if (thread.admission.connectionAttemptId !== connection.connectionAttemptId
        || thread.admission.initializedConnectionDigest !== connection.initializedConnectionDigest) return fail();
      reserveId(intent.turnStartRequestId);
      pending = { kind: 'turn', requestId: intent.turnStartRequestId, intentDigest: intent.intentDigest,
        threadReceiptDigest: thread.receiptDigest };
    },
    receiveTurn(threadValue: unknown, intentValue: unknown, rawResponse: string, recordedAt: string) {
      available(); const thread = verifyThreadReceipt(threadValue), intent = verifyTurnIntent(intentValue), reservation = pending;
      pending = undefined; matchIntentToThread(intent, thread);
      if (!reservation || reservation.kind !== 'turn' || reservation.requestId !== intent.turnStartRequestId
        || reservation.intentDigest !== intent.intentDigest || reservation.threadReceiptDigest !== thread.receiptDigest
        || thread.admission.connectionAttemptId !== connection.connectionAttemptId
        || thread.admission.initializedConnectionDigest !== connection.initializedConnectionDigest) return fail();
      return acceptCodexTurnStartV1(thread, intent, rawResponse, recordedAt);
    },
    close() { closed = true; pending = undefined; },
  });
}

/** Exact observation identity only. It cannot start, resume, retry or authorize a read. */
export function codexReadIdentityFromStartV1(threadReceiptValue: unknown, turnReceiptValue: unknown) {
  const thread = verifyThreadReceipt(threadReceiptValue);
  const turn = codexTurnStartReceiptSchemaV1.parse(turnReceiptValue);
  const embeddedThread = verifyThreadReceipt(turn.threadReceipt);
  const intent = verifyTurnIntent(turn.intent);
  matchIntentToThread(intent, thread);
  if (turn.receiptDigest !== sha256Digest(withoutReceiptDigest(turn))
    || sha256Digest(embeddedThread) !== sha256Digest(thread)
    || turn.threadReceipt.receiptDigest !== thread.receiptDigest
    || turn.intent.threadReceiptDigest !== thread.receiptDigest || turn.threadId !== thread.threadId
    || Date.parse(turn.recordedAt) < Date.parse(intent.requestedAt)
    || Date.parse(turn.recordedAt) > Date.parse(intent.deadline)) return fail();
  return Object.freeze({ ...thread.admission.scope, enrollmentDigest: thread.admission.enrollmentDigest,
    deliveryDigest: thread.admission.deliveryDigest, permitDigest: thread.admission.permitDigest,
    currentAdmissionDigest: thread.admission.currentAdmissionDigest,
    connectionAttemptId: thread.admission.connectionAttemptId,
    threadId: thread.threadId, turnId: turn.turnId,
    source: 'correlated_codex_start_receipts' as const,
    grantsExecutionAuthority: false as const, permitsResume: false as const,
    permitsRetry: false as const, permitsThreadRead: false as const,
    completionVerified: false as const });
}
