import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexStartAdmissionV1, createCodexStartResponseDispatcherV1,
  createCodexTurnStartIntentV1 } from '../../src/harness/codex-v1/admission-contract';
import { createCodexReadRecovery } from '../../src/harness/codex-v1/read-recovery';
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_START_CONTRACT } from
  '../../src/harness/codex-v1/schema-contract';
import { codexTaskDispatchBodySchemaV1, codexTaskDispatchReceiptBodySchemaV1,
  codexTaskPayloadDigestV1, codexTaskRunIdV1, type CodexTaskDispatchBodyV1,
  type CodexTaskDispatchReceiptBodyV1 } from '../../src/harness/codex-v1/delivery-contract';
import { SqliteCodexStartJournalV1 } from '../../src/harness/codex-v1/start-journal';
import { SqliteBridgeJournal } from '../../src/node-bridge/journal';
import { openPrivateCodexConfigurationV1 } from '../../src/node-bridge/private-codex-configuration';
import { sha256Digest } from '../../src/security/canonical-digest';
import { computeArtifactBodyDigest, signArtifact } from '../../src/node-policy/v1/crypto';
import { computeEffectClaimKey } from '../../src/node-policy/v1/effect-claim';
import { computeNormalizedOperationDigest } from '../../src/node-policy/v1/policy-evaluator';
import { NODE_PROTOCOL_V1, signNodeFrame } from '../../src/node-protocol/v1';
import { runPrivateNode } from '../../scripts/run-private-node.mjs';

type OptionalNodeConnectorModule = {
  createNativeNodeRuntime(): { close(): Promise<void> };
  createNativeHttpsConnector(): {
    run(): Promise<{ disposition: string; state: string }>;
    close(): Promise<void>;
  };
};
type InstalledNodeRuntime = NonNullable<Parameters<typeof runPrivateNode>[1]>;
type FixtureNodeRuntime = Omit<InstalledNodeRuntime, 'loadRelease'> & {
  loadRelease(): Promise<OptionalNodeConnectorModule>;
};
// The launcher consumes only these two exports. Keep the synthetic optional
// provider fixture independent of unrelated additions to the release module.
const runPrivateNodeFixture = runPrivateNode as (args: string[], runtime: FixtureNodeRuntime) => Promise<number>;

const at = (offset = 0) => new Date(Date.parse('2026-09-13T12:00:00.000Z') + offset).toISOString();
const digest = (value: string) => sha256Digest(value);
const pairs = new Map<string, ReturnType<typeof buildSyntheticStartPair>>();

function buildSyntheticStartPair(name: string) {
  const connection = { connectionAttemptId: `connection-attempt:${name}`,
    initializedConnectionDigest: digest(`connection:${name}`) };
  const admission = createCodexStartAdmissionV1({ schema: 'control-room.codex-start-admission/v1',
    scope: { tenantId: 'tenant:synthetic', nodeId: 'node:synthetic', projectId: 'project:synthetic',
      jobId: `job:${name}`, attemptId: `attempt:${name}`, runId: `run:${name}`,
      leaseId: `lease:${name}`, leaseEpoch: 1, operationDigest: digest(`operation:${name}`) },
    queueId: `native-queue:${sha256Digest({ tenantId: 'tenant:synthetic', jobId: `job:${name}`,
      attemptId: `attempt:${name}` }).slice(7)}`, requestMessageId: `message:activation:${name}`,
    activationMessageId: `message:activation:${name}`, activationId: `activation:${name}`,
    activationDigest: digest(`activation:${name}`), activationFrameDigest: digest(`activation-frame:${name}`),
    dispatchMessageId: `message:dispatch:${name}`, dispatchFrameDigest: digest(`delivery:${name}`),
    receiptMessageId: `message:receipt:${name}`, receiptFrameDigest: digest(`receipt:${name}`),
    workspacePath: '/synthetic/project', deliveryDigest: digest(`delivery:${name}`),
    enrollmentDigest: digest('enrollment'), permitDigest: digest(`permit:${name}`),
    currentAdmissionDigest: digest(`current:${name}`), inputDigest: digest(`input:${name}`),
    method: 'thread/start', ...connection, threadStartRequestId: 10, requestedAt: at(),
    deadline: at(300_000) });
  const dispatcher = createCodexStartResponseDispatcherV1(connection);
  dispatcher.reserveThread(admission);
  const thread = dispatcher.receiveThread(admission, JSON.stringify({ id: 10, result: {
    approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: '/synthetic/project', model: 'model:synthetic',
    modelProvider: 'provider:synthetic', sandbox: { type: 'readOnly' }, instructionSources: [],
    thread: { id: `thread:${name}`, sessionId: `thread:${name}`, ephemeral: false,
      cliVersion: CODEX_APP_SERVER_START_CONTRACT.version, createdAt: 1, cwd: '/synthetic/project',
      modelProvider: 'provider:synthetic', preview: '', projectId: null, source: 'appServer',
      status: { type: 'idle' }, turns: [], updatedAt: 1 } } }), at(1_000));
  const intent = createCodexTurnStartIntentV1(thread, { turnStartRequestId: 20,
    inputDigest: admission.inputDigest, requestedAt: at(2_000), deadline: at(240_000) });
  dispatcher.reserveTurn(thread, intent);
  const turn = dispatcher.receiveTurn(thread, intent, JSON.stringify({ id: 20,
    result: { turn: { id: `turn:${name}`, status: 'inProgress', items: [] } } }), at(3_000));
  dispatcher.close();
  return { admission, thread, turn };
}

export function syntheticStartPair(name = 'lifecycle') {
  const existing = pairs.get(name); if (existing) return existing;
  const created = buildSyntheticStartPair(name); pairs.set(name, created); return created;
}

/** Build a fully-signed Codex dispatch frame + matching receipt body that
 * share the synthetic admission's identity (queue/tenant/project/node/job/
 * attempt/run/permit/enrollment digests). The fixture is deterministic and
 * routes through the bridge journal's `recordCodexDelivery` seam, so the same
 * integrity gates the production intake handler uses (digest match, scope
 * check, time window, no-update trigger) all apply to this call. */
export function buildSyntheticCodexDelivery(name = 'lifecycle') {
  const pair = syntheticStartPair(name);
  const admission = pair.admission;
  const now = Date.parse(admission.requestedAt);
  const expiry = now + 300_000;
  const server = generateKeyPairSync('ed25519');
  const approval = generateKeyPairSync('ed25519');
  const approvalSpki = approval.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const start: {
    schema: 'control-room.codex-task-start/v1'; tenantId: string; nodeId: string; projectId: string;
    jobId: string; attemptId: string; runId: string; leaseId: string; leaseEpoch: number;
    effectClaimKey: string; operationDigest: string; inputDigest: string;
    enrollmentDigest: string; connectorProfileDigest: string; workspaceIntentDigest: string;
    prompt: string; instructions: string; deadline: number;
  } = { schema: 'control-room.codex-task-start/v1',
    tenantId: admission.scope.tenantId, nodeId: admission.scope.nodeId,
    projectId: admission.scope.projectId, jobId: admission.scope.jobId,
    attemptId: admission.scope.attemptId, runId: `run:codex:${name}`,
    leaseId: admission.scope.leaseId, leaseEpoch: admission.scope.leaseEpoch,
    effectClaimKey: sha256Digest('effect:pending'), operationDigest: sha256Digest('operation:pending'),
    inputDigest: sha256Digest({ prompt: 'Inspect the synthetic project', instructions: '' }),
    enrollmentDigest: admission.enrollmentDigest,
    connectorProfileDigest: sha256Digest('connector-profile'),
    workspaceIntentDigest: sha256Digest(`workspace:${name}`), prompt: 'Inspect the synthetic project',
    instructions: '', deadline: expiry };
  const request = { contractVersion: 'control-room-node-policy/v1' as const,
    requestId: `request:codex:${name}`, tenantId: start.tenantId, nodeId: start.nodeId,
    nodeClass: 'personal-compute', projectId: start.projectId, jobId: start.jobId,
    attemptId: start.attemptId, leaseId: start.leaseId, leaseEpoch: start.leaseEpoch,
    executorId: 'executor:codex', operationId: 'harness.codex.app-server.start',
    operationDigest: '', payloadDigest: '',
    authorityDigest: sha256Digest('authority'), credentialRefs: ['credential:codex'],
    target: { kind: 'filesystem' as const, canonicalPath: admission.workspacePath },
    risk: 'low' as const, externalEffect: true, estimatedDurationSeconds: 60,
    occurredAt: new Date(now).toISOString() };
  request.payloadDigest = codexTaskPayloadDigestV1(start, request.authorityDigest);
  request.operationDigest = computeNormalizedOperationDigest(request);
  start.operationDigest = request.operationDigest;
  start.effectClaimKey = computeEffectClaimKey(request);
  start.runId = codexTaskRunIdV1(start);
  const permitBody = { schema: 'control-room.owner-approval-attestation/v1' as const,
    tenantId: start.tenantId, nodeId: start.nodeId, projectId: start.projectId,
    jobId: start.jobId, attemptId: start.attemptId, operationDigest: start.operationDigest,
    risk: 'low' as const, decision: 'approved' as const,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString(),
    nonce: `c3ludGhldGljLWNvZGV4-${name}`, approvalKeyId: `approval-key:${name}` };
  const permit = signArtifact({ ...permitBody, bodyDigest: computeArtifactBodyDigest(permitBody) },
    approval.privateKey);
  // Authorise the synthetic public key as a "pinned" approval by hand — the
  // journal does not consult trust, only the intake handler does. Direct calls
  // to recordCodexDelivery only need a schema-valid permit + frame.
  void approvalSpki;
  const body: CodexTaskDispatchBodyV1 = codexTaskDispatchBodySchemaV1.parse({
    schema: 'control-room.codex-task-dispatch/v1', queueId: admission.queueId, start, request,
    permit, permitDigest: sha256Digest(permit) });
  const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    messageId: `message:dispatch:${name}`, correlationId: `correlation:dispatch:${name}`,
    tenantId: body.start.tenantId, actorId: 'control-room:test', senderKind: 'control_room',
    keyId: 'server-key:test', connectionId: `connection:${name}`, sequence: 1,
    sentAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString(),
    nonce: `c3ludGhldGljLWZyYW1l-${name}`, type: 'harness.codex.dispatch', body },
    server.privateKey);
  // The recordedAt must satisfy schema: sent <= recorded < expires.
  const recordedAt = new Date(now + 1_000).toISOString();
  const receipt: CodexTaskDispatchReceiptBodyV1 = codexTaskDispatchReceiptBodySchemaV1.parse({
    schema: 'control-room.codex-task-dispatch-receipt/v1', queueId: body.queueId,
    dispatchMessageId: frame.messageId, dispatchBodyDigest: sha256Digest(body),
    tenantId: start.tenantId, projectId: start.projectId, nodeId: start.nodeId,
    jobId: start.jobId, attemptId: start.attemptId, permitDigest: body.permitDigest,
    enrollmentDigest: start.enrollmentDigest, recordedAt, disposition: 'recorded',
    safeReason: 'none', startsWork: false, grantsExecutionAuthority: false });
  return { body, frame, receipt };
}

/** Record a fully-signed Codex delivery into the bridge journal via the
 * production seam. Returns the receipt body that was persisted. */
export function recordSyntheticCodexDelivery(bridgePath: string, name = 'lifecycle') {
  const { frame, receipt } = buildSyntheticCodexDelivery(name);
  const journal = new SqliteBridgeJournal(bridgePath);
  try {
    const recorded = journal.recordCodexDelivery(frame, receipt, () => {});
    return Object.freeze({ receipt: recorded });
  } finally { journal.close(); }
}

export async function createWorkerLifecycleFixture(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const canonicalRoot = await realpath(root);
  const bridgePath = join(canonicalRoot, 'bridge.sqlite'), startPath = join(canonicalRoot, 'starts.sqlite');
  // Pre-create the same two durable journal types the private Codex configuration owns.
  new SqliteBridgeJournal(bridgePath).close();
  await chmod(bridgePath, 0o600);
  const starts = new SqliteCodexStartJournalV1(startPath); starts.close();
  return Object.freeze({ root: canonicalRoot, bridgePath, startPath });
}

export function recordSyntheticLifecycle(path: string, stage: 'reserved' | 'thread' | 'recorded', revoked = false) {
  const pair = syntheticStartPair();
  const journal = new SqliteCodexStartJournalV1(path);
  const current = () => { if (revoked) throw new Error('synthetic_revoked'); };
  try {
    journal.reserveStart(pair.admission, pair.admission.requestedAt, current);
    if (stage !== 'reserved') journal.recordThread(pair.thread, current);
    if (stage === 'recorded') journal.recordTurn(pair.thread, pair.turn, current);
    return journal.load(pair.admission.scope.runId);
  } finally { journal.close(); }
}

export function reopenSyntheticLifecycle(path: string) {
  const pair = syntheticStartPair(); const journal = new SqliteCodexStartJournalV1(path);
  try { return journal.load(pair.admission.scope.runId); } finally { journal.close(); }
}

export function projectSyntheticRecovery(path: string, status: 'inProgress' | 'completed') {
  const saved = reopenSyntheticLifecycle(path);
  if (saved.status !== 'recorded' || !saved.threadId || !saved.turnId) throw new Error('synthetic_recovery_unavailable');
  return createCodexReadRecovery({ threadId: saved.threadId, turnId: saved.turnId }).project(JSON.stringify({
    thread: { id: saved.threadId, cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
      turns: [{ id: saved.turnId, status }] } }));
}

export async function runSyntheticPrivateCodexRecovery(fixture: Awaited<ReturnType<typeof createWorkerLifecycleFixture>>) {
  const saved = reopenSyntheticLifecycle(fixture.startPath);
  if (saved.status !== 'recorded' || !saved.threadId || !saved.turnId) throw new Error('synthetic_recovery_unavailable');
  let acquisitions = 0, closes = 0, reads = 0;
  const responses = ['{"id":1,"result":{}}', JSON.stringify({ id: 2, result: { thread: {
    id: saved.threadId, cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: saved.turnId, status: 'completed', itemsView: 'full', items: [] }] } } })];
  const configuration = openPrivateCodexConfigurationV1({ mode: 'recover',
    paths: { bridge: fixture.bridgePath, starts: fixture.startPath }, runId: saved.runId,
    connectionAttemptId: 'connection-attempt:lifecycle-recover',
    initializedConnectionDigest: digest('lifecycle-recover'), readTimeoutMs: 1_000,
    cleanupTimeoutMs: 200, processCleanupTimeoutMs: 100 }, {
    authority: { assertCurrent() {} }, acquireProcess(binding) {
      acquisitions += 1;
      if (binding.mode !== 'recover' || binding.threadId !== saved.threadId || binding.turnId !== saved.turnId)
        throw new Error('wrong_recovery_binding');
      let finish!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = resolve; });
      let finishStdout!: () => void;
      const stdoutEnded = new Promise<undefined>(resolve => { finishStdout = () => resolve(undefined); });
      return { ready: Promise.resolve({ async writeStdin() {}, async readStdout() {
        const line = responses[reads++]; return line === undefined ? stdoutEnded : new TextEncoder().encode(`${line}\n`);
      }, async readStderr() { return undefined; }, async closeStdin() {},
      async terminate() { finishStdout(); finish({ code: null, signal: 'SIGTERM' }); }, exited }),
      async close() { closes += 1; } };
    } }, new AbortController().signal);
  try {
    const observation = await configuration.run(new AbortController().signal);
    return Object.freeze({ observation, acquisitions, closes });
  } finally { await configuration.close(); }
}

export async function runSyntheticLauncherScenario(scenario: 'completed' | 'revoked' | 'late-acquisition' | 'drain-failure' | 'hermes-completed') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'control-room-worker-launcher-')));
  await chmod(directory, 0o700); const operatorPath = join(directory, 'operator.mjs');
  const lifecycle = await createWorkerLifecycleFixture(directory);
  recordSyntheticLifecycle(lifecycle.startPath, 'thread');
  await writeFile(operatorPath, '// disposable synthetic fixture\n', { mode: 0o600 });
  const signals = new EventEmitter(); const reports: string[] = [], errors: string[] = [];
  let runs = 0, closes = 0, acquisitions = 0, releaseAcquire: (() => void) | undefined;
  const acquisitionStarted = new Promise<void>(resolve => { releaseAcquire = resolve; });
  const codePromise = runPrivateNodeFixture(['--configuration', operatorPath, '--mode', 'recover'], {
    signals: signals as unknown as NodeJS.Process,
    report: (value: string) => reports.push(value), reportError: (value: string) => errors.push(value),
    async loadRelease() {
      if (scenario !== 'hermes-completed') throw new Error('provider_release_must_not_load');
      return { createNativeNodeRuntime() { return { async close() {} }; },
        createNativeHttpsConnector() { return { async run() { runs += 1;
          return { disposition: 'terminal', state: 'completed' }; }, async close() {} }; } };
    },
    async loadOperator() { return { schema: 'control-room.private-node-configuration/v1',
      async createConfiguration({ signal, mode }: { signal: AbortSignal; mode: string }) {
        acquisitions += 1; releaseAcquire?.();
        if (scenario === 'late-acquisition') await new Promise<void>(resolve => signal.addEventListener('abort', () => {
          queueMicrotask(resolve);
        }, { once: true }));
        if (scenario === 'hermes-completed') return { harness: 'hermes-native-v1', node: {}, dependencies: {},
          https: {}, settings: {}, sources: {}, async close() { closes += 1; } };
        return { harness: 'codex-local-v1', mode,
          async run() { runs += 1; if (scenario === 'revoked') throw new Error('synthetic_revoked');
            return { disposition: 'observed', mode: 'recover', status: 'not_observed', usage: 'unknown',
              canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
              permitsRetry: false, permitsResume: false, permitsNewTurn: false, writesResult: false,
              writesArtifact: false, writesReview: false, releasesCapacity: false }; },
          async close() { closes += 1; if (scenario === 'drain-failure') throw new Error('synthetic_drain_failed'); } };
      } } },
  });
  await acquisitionStarted;
  if (scenario === 'late-acquisition') signals.emit('SIGTERM');
  try {
    const code = await codePromise;
    const journalStatus = reopenSyntheticLifecycle(lifecycle.startPath).status;
    return Object.freeze({ scenario, code, runs, closes, acquisitions,
      journalStatus, reports: Object.freeze(reports), errors: Object.freeze(errors) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
