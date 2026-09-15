import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { projectExactPackageCodexCompletedTurnV1 } from '../src/harness/codex-v1/completed-turn';
import { CODEX_APP_SERVER_ADAPTER } from '../src/harness/codex-v1/delivery-contract';
import { CODEX_RESULT_RETURN_FEATURE_V1, createCodexResultReturnBodyV1,
  createCodexResultReturnReceiptBodyV1 } from '../src/harness/codex-v1/result-return';
import { createCodexPhysicalQualificationReceiptBodyV1,
  createCodexResultPublicationContractV1 } from '../src/harness/codex-v1/result-publication-contract';
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract';
import { createCodexRecoveredResultRuntimeV1 } from '../src/harness/codex-v1/recovered-result-runtime';
import { projectCodexTerminalResultEvidenceV1 } from '../src/harness/v1/terminal-result-evidence';
import { PortableNodeBridge } from '../src/node-bridge/bridge';
import { SqliteBridgeJournal } from '../src/node-bridge/journal';
import { signArtifact } from '../src/node-policy/v1/crypto';
import { NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame,
  type SignedNodeFrame, type UnsignedNodeFrame } from '../src/node-protocol/v1';
import { sha256Digest } from '../src/security/canonical-digest';

const nodeKeys = generateKeyPairSync('ed25519');
const serverKeys = generateKeyPairSync('ed25519');
const qualificationKeys = generateKeyPairSync('ed25519');
const serverSpki = serverKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const qualificationSpki = qualificationKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const returnedAt = '2026-09-13T12:00:00.000Z';
const receivedAt = '2026-09-13T12:00:01.000Z';
const observedAt = '2026-09-13T11:59:59.000Z';

const exactPackage = () => ({ adapterId: CODEX_APP_SERVER_ADAPTER,
  packageName: CODEX_APP_SERVER_READ_CONTRACT.package,
  packageVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
  generatedSchemaBundleSha256: CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256,
  threadStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256,
  threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
  turnStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256,
  turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
  threadReadResponseSchemaSha256: CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256,
  agentMessageSourceSha256: CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256 });
const evidence = <T extends object>(material: T) => ({ ...material, evidenceDigest: sha256Digest(material) });

const rawCompletedResult = JSON.stringify({ thread: { id: 'thread:durable',
  cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
  turns: [{ id: 'turn:durable', status: 'completed', itemsView: 'full', items: [
    { type: 'agentMessage', id: 'item:final', phase: 'final_answer', text: 'Exact result.' },
  ] }] } });

function resultFixture() {
  const activationMaterial = { schema: 'control-room.codex-task-activation/v1' as const,
    tenantId: 'tenant:test', projectId: 'project:test', nodeId: 'node:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId: 'run:test', leaseId: 'lease:test', leaseEpoch: 7,
    queueId: 'queue:test', connectionId: 'connection:test',
    connection: { connectionAttemptId: 'connection:result',
      initializedConnectionDigest: sha256Digest('initialized:result') },
    dispatchMessageId: 'message:dispatch', dispatchFrameDigest: sha256Digest('dispatch-frame'),
    dispatchBodyDigest: sha256Digest('dispatch-body'), receiptMessageId: 'message:receipt',
    receiptFrameDigest: sha256Digest('receipt-frame'), receiptBodyDigest: sha256Digest('receipt-body'),
    permitDigest: sha256Digest('permit'), inputDigest: sha256Digest({ prompt: 'Do it', instructions: 'Exact' }),
    operationDigest: sha256Digest('operation'), effectClaimKey: sha256Digest('effect'),
    enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('profile'),
    workspaceIntentDigest: sha256Digest('workspace'), currentAdmissionDigest: sha256Digest('admission'),
    workspacePath: '/synthetic/workspace', prompt: 'Do it', instructions: 'Exact',
    receiptRecordedAt: '2026-09-13T11:57:00.000Z', receiptReceivedAt: '2026-09-13T11:57:01.000Z',
    activatedAt: '2026-09-13T11:57:02.000Z', activationExpiresAt: '2026-09-13T12:06:00.000Z',
    startsWork: false as const, authorizesExactStart: true as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const };
  const activationDigest = sha256Digest(activationMaterial);
  const activation = { ...activationMaterial,
    activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest };
  const observation = projectExactPackageCodexCompletedTurnV1({ threadId: 'thread:durable',
    turnId: 'turn:durable', rawResult: rawCompletedResult });
  const start = evidence({ evidenceId: 'evidence:start', processAttemptId: 'process:start',
    connectionAttemptId: 'connection:start', initializedConnectionDigest: sha256Digest('initialized:start'),
    threadId: 'thread:qualification', turnId: 'turn:qualification', startObserved: true as const,
    cleanupVerified: true as const });
  const restartRead = evidence({ evidenceId: 'evidence:restart', processAttemptId: 'process:restart',
    connectionAttemptId: 'connection:restart', initializedConnectionDigest: sha256Digest('initialized:restart'),
    threadId: 'thread:qualification', turnId: 'turn:qualification', itemId: 'item:qualification',
    restartObserved: true as const, exactReadObserved: true as const, cleanupVerified: true as const });
  const qualificationBody = createCodexPhysicalQualificationReceiptBodyV1({
    schema: 'control-room.codex-physical-qualification-receipt/v1', qualificationId: 'qualification:test',
    qualificationSignerKeyId: 'qualification-key:test', tenantId: 'tenant:test', nodeId: 'node:test',
    connectorProfileId: 'profile:codex:test', connectorProfileDigest: activation.connectorProfileDigest,
    exactPackage: exactPackage(), qualifiedAt: '2026-09-13T11:59:00.000Z', start, restartRead,
    oneFreshProcessPerAttempt: true, sameDurableThreadObserved: true, sameDurableTurnObserved: true,
    terminalCleanupVerified: true, processReuseObserved: false, retryObserved: false,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false });
  const qualification = signArtifact(qualificationBody, qualificationKeys.privateKey);
  const identity = { tenantId: activation.tenantId, projectId: activation.projectId, jobId: activation.jobId,
    attemptId: activation.attemptId, runId: activation.runId, nodeId: activation.nodeId,
    leaseId: activation.leaseId, leaseEpoch: activation.leaseEpoch };
  const binding = { identity, delivery: { activationDigest: activation.activationDigest,
    dispatchBodyDigest: activation.dispatchBodyDigest, receiptBodyDigest: activation.receiptBodyDigest },
  connection: { connectionId: activation.connectionId, connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'), connectorProfileId: 'profile:codex:test',
    connectorProfileDigest: activation.connectorProfileDigest },
  result: { threadId: observation.threadId, turnId: observation.turnId, itemId: observation.itemId,
    projectionDigest: observation.projectionDigest, rawResultDigest: observation.rawResultDigest,
    rawTurnDigest: observation.matchedTurnDigest, contentHash: observation.contentHash,
    contentSizeBytes: observation.sizeBytes },
  physicalQualification: { qualificationId: qualification.body.qualificationId,
    receiptBodyDigest: qualification.body.bodyDigest, signerKeyId: qualification.body.qualificationSignerKeyId } };
  const publication = createCodexResultPublicationContractV1({ activation, observation,
    observationSource: 'stored_thread_read', connection: {
      connectionAttemptId: binding.connection.connectionAttemptId,
      initializedConnectionDigest: binding.connection.initializedConnectionDigest,
      connectorProfileId: binding.connection.connectorProfileId }, binding,
    qualificationReceipt: qualification, qualificationPublicKeySpki: qualificationSpki });
  const terminalEvidence = projectCodexTerminalResultEvidenceV1({ lineage: {
    tenantId: identity.tenantId, projectId: identity.projectId, jobId: identity.jobId,
    attemptId: identity.attemptId, runId: identity.runId, nodeId: identity.nodeId },
  identity: { runId: identity.runId, threadId: observation.threadId, turnId: observation.turnId },
  completedTurn: observation, qualificationDigest: qualification.body.bodyDigest, observedAt });
  const body = createCodexResultReturnBodyV1({ publication, terminalEvidence,
    qualificationReceipt: qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, returnedAt });
  const activationFrame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
    senderKind: 'control_room', tenantId: 'tenant:test', actorId: 'server:test', keyId: 'server-key:test',
    connectionId: 'connection:test', sequence: 3, messageId: 'message:activation',
    correlationId: 'correlation:activation', causationId: activation.receiptMessageId,
    nonce: 'synthetic_activation_nonce_1234567890', sentAt: activation.activatedAt,
    expiresAt: activation.activationExpiresAt, type: 'harness.codex.dispatch.activation', body: activation },
  serverKeys.privateKey);
  return { body, activationFrame, observation, qualification };
}

function authenticator(journal: SqliteBridgeJournal) {
  return new NodeProtocolAuthenticator({ async resolve(input) {
    if (input.actorId !== 'server:test' || input.keyId !== 'server-key:test') return undefined;
    return { tenantId: 'tenant:test', actorId: 'server:test', senderKind: 'control_room' as const,
      keyId: 'server-key:test', algorithm: 'ed25519' as const, publicKeySpki: serverSpki,
      state: 'active' as const, principalState: 'active' as const, validFrom: '2026-09-13T11:00:00.000Z' };
  } }, journal, { async consume() {} });
}

async function connect(journal: SqliteBridgeJournal, sent: string[], connection = 'test',
  signResult?: (frame: UnsignedNodeFrame<'harness.codex.result.return'>) => Promise<SignedNodeFrame>,
  features: string[] = [CODEX_RESULT_RETURN_FEATURE_V1]) {
  const f = resultFixture();
  const database = (journal as unknown as { db: DatabaseSync }).db;
  if (!(database.prepare('SELECT queue_id FROM bridge_codex_deliveries WHERE queue_id=?')
    .get('queue:test'))) {
    database.prepare(`INSERT INTO bridge_codex_deliveries
      (queue_id,message_id,tenant_id,project_id,node_id,job_id,attempt_id,run_id,frame_json,frame_digest,
       receipt_json,receipt_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('queue:test',
      'message:dispatch', 'tenant:test', 'project:test', 'node:test', 'job:test', 'attempt:test', 'run:test',
      '{}', sha256Digest('seed-dispatch'), '{}', sha256Digest('seed-receipt'));
    database.prepare(`INSERT INTO bridge_codex_activations
      (queue_id,activation_id,message_id,run_id,receipt_message_id,frame_json,frame_digest,received_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('queue:test', f.activationFrame.body.activationId,
      f.activationFrame.messageId, 'run:test', 'message:receipt', JSON.stringify(f.activationFrame),
      sha256Digest(f.activationFrame), f.activationFrame.sentAt);
  }
  const unsafe = journal as unknown as {
    acceptedCodexActivation(queueId: string): { frame: typeof f.activationFrame; receivedAt: string } | undefined;
    acceptedCommandWithinTransaction(messageId: string): { frame: SignedNodeFrame; receivedAt: string } | undefined;
  };
  unsafe.acceptedCodexActivation = queueId => queueId === 'queue:test'
    ? { frame: f.activationFrame, receivedAt: f.activationFrame.sentAt } : undefined;
  unsafe.acceptedCommandWithinTransaction = messageId => messageId === f.activationFrame.messageId
    ? { frame: f.activationFrame, receivedAt: f.activationFrame.sentAt } : undefined;
  let id = 0;
  const bridge = new PortableNodeBridge({ tenantId: 'tenant:test', nodeId: 'node:test',
    keyId: 'node-key:test', features }, journal,
  { async sign(frame) { return frame.type === 'harness.codex.result.return' && signResult
      ? signResult(frame as UnsignedNodeFrame<'harness.codex.result.return'>)
      : signNodeFrame(frame, nodeKeys.privateKey); } }, authenticator(journal),
  () => id++ === 0 ? connection : `${connection}-result-${id}`);
  const transport = { async send(raw: string) { sent.push(raw); }, async close() {} };
  await bridge.open(transport, { now: returnedAt, transportIdentity: 'transport:test' });
  const hello = JSON.parse(sent[0]!) as SignedNodeFrame;
  const serverFrame = (sequence: number, type: UnsignedNodeFrame['type'], body: UnsignedNodeFrame['body']) =>
    signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node', senderKind: 'control_room',
      tenantId: 'tenant:test', actorId: 'server:test', keyId: 'server-key:test',
      connectionId: hello.connectionId, sequence, messageId: `message:server:${connection}:${sequence}`,
      correlationId: 'correlation:server', ...(sequence === 1 ? { causationId: hello.messageId } : {}),
      nonce: `synthetic_server_nonce_${connection}_${sequence}_123456`, sentAt: returnedAt,
      expiresAt: '2026-09-13T12:05:00.000Z', type, body } as UnsignedNodeFrame, serverKeys.privateKey);
  await bridge.receive(JSON.stringify(serverFrame(1, 'connection.accepted', { selectedProtocol: NODE_PROTOCOL_V1,
    enabledFeatures: features, maxFrameBytes: 262_144,
    heartbeatIntervalSeconds: 30, serverTime: returnedAt })), returnedAt);
  await bridge.receive(JSON.stringify(serverFrame(2, 'node.reconciliation.request', {
    lastAcknowledgedNodeSequence: 1, requestedAttemptIds: [] })), returnedAt);
  return { bridge, transport, fixture: f, serverFrame };
}

function autoReceipt(journal: SqliteBridgeJournal, sent: string[], getBridge: () => Awaited<ReturnType<typeof connect>>) {
  getBridge().transport.send = async (raw: string) => {
    sent.push(raw); const frame = JSON.parse(raw) as SignedNodeFrame;
    if (frame.type !== 'harness.codex.result.return') return;
    const receiptBody = createCodexResultReturnReceiptBodyV1({ frame: frame as never, recordedAt: receivedAt });
    const receipt = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      senderKind: 'control_room', tenantId: 'tenant:test', actorId: 'server:test', keyId: 'server-key:test',
      connectionId: frame.connectionId, sequence: 3, messageId: 'message:result-receipt',
      correlationId: frame.correlationId, causationId: frame.messageId,
      nonce: 'synthetic_result_receipt_nonce_123456789', sentAt: receivedAt,
      expiresAt: frame.expiresAt, type: 'harness.codex.result.return.receipt', body: receiptBody },
    serverKeys.privateKey);
    void journal;
    queueMicrotask(() => void getBridge().bridge.receive(JSON.stringify(receipt), receivedAt));
  };
}

function startEvidence(fixture: ReturnType<typeof resultFixture>, tamperAfterReads = -1) {
  let loads = 0;
  const identity = () => {
    loads++;
    const tampered = tamperAfterReads >= 0 && loads > tamperAfterReads;
    return { queueId: 'queue:test', runId: 'run:test', threadId: 'thread:durable', turnId: 'turn:durable',
      activationId: fixture.activationFrame.body.activationId,
      activationDigest: tampered ? sha256Digest('tampered') : fixture.activationFrame.body.activationDigest,
      cleanupVerified: true as const };
  };
  return { load() { return { status: 'recorded' as const, readIdentity: identity(),
    cleanupVerified: true as const } as never; },
    loads: () => loads };
}

function recoveryHost(fixture: ReturnType<typeof resultFixture>, calls: string[],
  mode: 'completed' | 'throw' | 'noncompleted' | 'mismatch' = 'completed',
  readMode: 'ok' | 'throw' | 'scope-mismatch' = 'ok') {
  return { read() {
      calls.push('read');
      if (readMode === 'throw') throw new Error('synthetic_recovery_read_unavailable');
      if (readMode === 'scope-mismatch') return { rawResult: rawCompletedResult,
        scope: { threadId: 'thread:other', turnId: 'turn:durable' } };
      return { rawResult: rawCompletedResult, scope: { threadId: 'thread:durable', turnId: 'turn:durable' } };
    },
    project(raw: string) {
    calls.push('project');
    if (mode === 'throw') throw new Error('synthetic_recovery_secret_malformed');
    if (mode === 'noncompleted') {
      return { threadId: 'thread:durable', turnId: 'turn:durable', status: 'running' };
    }
    if (mode === 'mismatch') {
      return { threadId: 'thread:other', turnId: 'turn:durable', status: 'completed',
        exactPackageResult: fixture.observation };
    }
    void raw;
    return { threadId: 'thread:durable', turnId: 'turn:durable', status: 'completed',
      exactPackageResult: fixture.observation };
  } };
}

function runtimeFor(journal: SqliteBridgeJournal, bridge: PortableNodeBridge,
  fixture: ReturnType<typeof resultFixture>, starts: ReturnType<typeof startEvidence>,
  recovery: ReturnType<typeof recoveryHost>, clockValue = returnedAt,
  lineage: { runId?: string; queueId?: string; threadId?: string; turnId?: string;
    activationId?: string; activationDigest?: string;
    connectionAttemptId?: string; initializedConnectionDigest?: string } = {}) {
  const channel = bridge.codexResultReturnChannel();
  if (!channel) assert.fail('negotiated result channel required');
  return createCodexRecoveredResultRuntimeV1({ runId: lineage.runId ?? 'run:test',
    queueId: lineage.queueId ?? 'queue:test',
    threadId: lineage.threadId ?? 'thread:durable', turnId: lineage.turnId ?? 'turn:durable',
    activationId: lineage.activationId ?? fixture.activationFrame.body.activationId,
    activationDigest: lineage.activationDigest ?? fixture.activationFrame.body.activationDigest,
    connectionAttemptId: lineage.connectionAttemptId ?? 'connection:result',
    initializedConnectionDigest: lineage.initializedConnectionDigest ?? sha256Digest('initialized:result'),
    journal, start: starts, bridge, channel, recovery,
    qualificationReceipt: fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(clockValue) });
}

const resultFrames = (sent: string[]) =>
  sent.map(raw => JSON.parse(raw) as SignedNodeFrame)
    .filter(frame => frame.type === 'harness.codex.result.return');

test('one journal instance supplies activation, bridge transmission and sender evidence; exact completed recovery publishes once and persists receipted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-recovered-runtime-')); chmodSync(directory, 0o700);
  const path = join(directory, 'bridge.sqlite');
  try {
    const journal = new SqliteBridgeJournal(path), sent: string[] = [];
    const holder: { current?: Awaited<ReturnType<typeof connect>> } = {};
    const f = await connect(journal, sent);
    holder.current = f;
    autoReceipt(journal, sent, () => holder.current!);
    const calls: string[] = [];
    const starts = startEvidence(f.fixture);
    const runtime = runtimeFor(journal, f.bridge, f.fixture, starts, recoveryHost(f.fixture, calls));
    const outcome = await runtime.recover(observedAt, new AbortController().signal);
    assert.equal(outcome.disposition, 'receipted');
    if (outcome.disposition !== 'receipted') assert.fail('receipt required');
    assert.equal(outcome.receipt.body.disposition, 'transport_received');
    assert.equal(resultFrames(sent).length, 1);
    assert.equal(journal.codexResultReturn('run:test')?.status, 'receipted');
    assert.deepEqual(calls, ['read', 'project']);
    assert.ok(starts.loads() >= 2);
    runtime.close(); await f.bridge.close(); journal.close();
    const reopened = new SqliteBridgeJournal(path);
    (reopened as unknown as { acceptedCommand(messageId: string): unknown }).acceptedCommand = messageId =>
      messageId === f.fixture.activationFrame.messageId
        ? { frame: f.fixture.activationFrame, receivedAt: f.fixture.activationFrame.sentAt } : undefined;
    assert.equal(reopened.codexResultReturn('run:test')?.receipt?.body.receiptId, outcome.receipt.body.receiptId);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing, summary, secret, malformed and noncompleted output sends no frame', async () => {
  const journal2 = new SqliteBridgeJournal(':memory:'), sent2: string[] = [];
  const g = await connect(journal2, sent2);
  const cases: Array<{ mode: 'throw' | 'noncompleted' | 'mismatch'; raw: string }> = [
    { mode: 'throw', raw: rawCompletedResult },
    { mode: 'noncompleted', raw: rawCompletedResult },
    { mode: 'mismatch', raw: rawCompletedResult },
  ];
  for (const [index, item] of cases.entries()) {
    const calls: string[] = [];
    const runtime = runtimeFor(journal2, g.bridge, g.fixture, startEvidence(g.fixture),
      recoveryHost(g.fixture, calls, item.mode));
    const outcome = await runtime.recover(observedAt, new AbortController().signal);
    assert.equal(outcome.disposition, 'observed', `case ${index} observes only`);
    runtime.close();
  }
  assert.equal(resultFrames(sent2).length, 0);
  assert.equal(journal2.codexResultReturn('run:test'), undefined);
  await assert.rejects(runtimeFor(journal2, g.bridge, g.fixture, startEvidence(g.fixture),
    recoveryHost(g.fixture, [], 'completed', 'throw')).recover(observedAt, new AbortController().signal),
  /codex_recovered_result_unavailable/);
  await g.bridge.close(); journal2.close();
});

test('prepared or sent prevents acquisition and transmission', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'node_to_server', senderKind: 'node',
    tenantId: 'tenant:test', actorId: 'node:test', keyId: 'node-key:test', connectionId: 'connection:test',
    sequence: journal.nextOutboundSequence('connection:test'), messageId: 'message:prepared-result',
    correlationId: `correlation:${f.fixture.body.returnId}`,
    causationId: f.fixture.body.activation.activationId,
    nonce: 'synthetic_prepared_result_nonce_123456789', sentAt: returnedAt,
    expiresAt: f.fixture.body.physicalQualification.validUntil,
    type: 'harness.codex.result.return', body: f.fixture.body }, nodeKeys.privateKey);
  journal.prepareCodexResultReturn(frame, f.fixture.activationFrame, returnedAt, () => {});
  assert.equal(journal.codexResultReturn('run:test')?.status, 'prepared');
  const calls: string[] = [];
  const runtime = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture), {
    read() { calls.push('read'); throw new Error('must_not_read'); },
    project() { calls.push('project'); throw new Error('must_not_acquire'); },
  });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_delivery_uncertain/);
  assert.deepEqual(calls, []);
  assert.equal(resultFrames(sent).length, 0);
  await f.bridge.close(); journal.close();
});

test('receipted replays locally without read or send', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-recovered-replay-')); chmodSync(directory, 0o700);
  const path = join(directory, 'bridge.sqlite');
  try {
    const journal = new SqliteBridgeJournal(path), sent: string[] = [];
    const holder: { current?: Awaited<ReturnType<typeof connect>> } = {};
    const f = await connect(journal, sent);
    holder.current = f;
    autoReceipt(journal, sent, () => holder.current!);
    const first = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture),
      recoveryHost(f.fixture, []));
    const outcome = await first.recover(observedAt, new AbortController().signal);
    if (outcome.disposition !== 'receipted') assert.fail('receipt required');
    const framesBefore = resultFrames(sent).length;
    first.close(); await f.bridge.close(); journal.close();
    const reopened = new SqliteBridgeJournal(path), sent2: string[] = [];
    const g = await connect(reopened, sent2, 'reconnect');
    const replay = runtimeFor(reopened, g.bridge, g.fixture, startEvidence(g.fixture), {
      read() { throw new Error('must_not_read'); },
      project() { throw new Error('must_not_read'); },
    });
    const replayed = await (replay as unknown as {
      recover(at: string, signal: AbortSignal): Promise<{ disposition: string; receipt: { body: { receiptId: string } } }>;
    }).recover(observedAt, new AbortController().signal);
    assert.equal(replayed.disposition, 'receipted');
    assert.equal(replayed.receipt.body.receiptId, outcome.receipt.body.receiptId);
    assert.equal(resultFrames(sent2).length, 0);
    assert.equal(framesBefore, 1);
    replay.close(); await g.bridge.close(); reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('disconnect before preparation sends nothing', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const channel = f.bridge.codexResultReturnChannel();
  if (!channel) assert.fail('channel required');
  await f.bridge.disconnected();
  let sends = 0;
  const counting = { sendCodexResultReturn: async (
    ...args: Parameters<PortableNodeBridge['sendCodexResultReturn']>) => {
    sends++;
    return f.bridge.sendCodexResultReturn(...args);
  } };
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: startEvidence(f.fixture), bridge: counting, channel,
    recovery: recoveryHost(f.fixture, []),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_unavailable/);
  assert.equal(sends, 0);
  assert.equal(resultFrames(sent).length, 0);
  assert.equal(journal.codexResultReturn('run:test'), undefined);
  await f.bridge.close(); journal.close();
});

test('disconnect after sent remains uncertain and reconnect sends nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-recovered-uncertain-')); chmodSync(directory, 0o700);
  const path = join(directory, 'bridge.sqlite');
  try {
    const journal = new SqliteBridgeJournal(path), sent: string[] = [];
    const f = await connect(journal, sent);
    f.transport.send = async raw => { sent.push(raw); const frame = JSON.parse(raw) as SignedNodeFrame;
      if (frame.type === 'harness.codex.result.return') throw new Error('synthetic_lost_after_write'); };
    const runtime = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture),
      recoveryHost(f.fixture, []));
    await assert.rejects(runtime.recover(observedAt, new AbortController().signal), error => {
      assert.match(String(error), /codex_recovered_result_delivery_uncertain/);
      assert.doesNotMatch(String(error), /synthetic|secret/); return true;
    });
    assert.equal(journal.codexResultReturn('run:test')?.status, 'sent');
    await f.bridge.close(); journal.close();
    const reopened = new SqliteBridgeJournal(path), sent2: string[] = [];
    const g = await connect(reopened, sent2, 'reconnect');
    const retry = runtimeFor(reopened, g.bridge, g.fixture, startEvidence(g.fixture),
      recoveryHost(g.fixture, []));
    await assert.rejects(retry.recover(observedAt, new AbortController().signal),
      /codex_recovered_result_delivery_uncertain/);
    assert.equal(resultFrames(sent2).length, 0);
    assert.equal(reopened.codexResultReturn('run:test')?.status, 'sent');
    retry.close(); await g.bridge.close(); reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sender error with no durable return is unavailable with no automatic retry', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent, 'test', async () => { throw new Error('synthetic_sign_secret'); });
  const runtime = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture),
    recoveryHost(f.fixture, []));
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal), error => {
    assert.match(String(error), /codex_recovered_result_unavailable/);
    assert.doesNotMatch(String(error), /synthetic|secret/); return true;
  });
  assert.equal(journal.codexResultReturn('run:test'), undefined);
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_unavailable/);
  await f.bridge.close(); journal.close();
});

test('altered receipt fails closed and cleanup doubt survives close', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const forged = { body: { identity: { runId: 'run:other' }, activation: { activationId: 'codex-activation:other' },
    returnFrameDigest: sha256Digest('forged') } };
  let sends = 0;
  const fakeBridge = { sendCodexResultReturn: async () => { sends++; return forged; } };
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: startEvidence(f.fixture), bridge: fakeBridge as never,
    channel: f.bridge.codexResultReturnChannel()!,
    recovery: recoveryHost(f.fixture, []),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  assert.equal(runtime.cleanupDoubt, true);
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_receipt_invalid/);
  assert.equal(sends, 1);
  assert.equal(runtime.cleanupDoubt, true);
  runtime.close(); runtime.close();
  assert.equal(runtime.cleanupDoubt, true);
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_unavailable/);
  await f.bridge.close(); journal.close();
});

test('post-read lineage change fails closed before any send', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  let sends = 0;
  const counting = { sendCodexResultReturn: async (
    ...args: Parameters<PortableNodeBridge['sendCodexResultReturn']>) => {
    sends++;
    return f.bridge.sendCodexResultReturn(...args);
  } };
  const channel = f.bridge.codexResultReturnChannel();
  if (!channel) assert.fail('channel required');
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: startEvidence(f.fixture, 1), bridge: counting, channel,
    recovery: recoveryHost(f.fixture, []),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_unavailable/);
  assert.equal(sends, 0);
  assert.equal(resultFrames(sent).length, 0);
  await f.bridge.close(); journal.close();
});

test('returnFrameDigest mismatch fails closed even with matching identity and activation', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const holder: { current?: Awaited<ReturnType<typeof connect>> } = {};
  const f = await connect(journal, sent);
  holder.current = f;
  autoReceipt(journal, sent, () => holder.current!);
  const tampering = { sendCodexResultReturn: async (
    ...args: Parameters<PortableNodeBridge['sendCodexResultReturn']>) => {
    const receipt = await f.bridge.sendCodexResultReturn(...args);
    const forged = structuredClone(receipt) as unknown as { body: { returnFrameDigest: string } };
    forged.body.returnFrameDigest = sha256Digest('forged-frame');
    return forged as unknown as Awaited<ReturnType<PortableNodeBridge['sendCodexResultReturn']>>;
  } };
  const channel = f.bridge.codexResultReturnChannel();
  if (!channel) assert.fail('channel required');
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: startEvidence(f.fixture), bridge: tampering, channel,
    recovery: recoveryHost(f.fixture, []),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_receipt_invalid/);
  assert.equal(journal.codexResultReturn('run:test')?.status, 'receipted');
  runtime.close(); await f.bridge.close(); journal.close();
});

test('connectionAttemptId substitution for the durable activation connection refuses', async () => {
  // Finding 2: connectionAttemptId and initializedConnectionDigest come from
  // the caller but must be bound to authenticated durable activation
  // evidence before being placed into publication evidence. Substitution
  // refuses with connection_binding_invalid.
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const calls: string[] = [];
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    // Substituted connectionAttemptId: not the durable activation value.
    connectionAttemptId: 'connection:forged',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: startEvidence(f.fixture), bridge: f.bridge, channel: (() => {
      const channel = f.bridge.codexResultReturnChannel();
      if (!channel) throw new Error('channel required'); return channel;
    })(), recovery: recoveryHost(f.fixture, calls),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_connection_binding_invalid/);
  runtime.close(); await f.bridge.close(); journal.close();
});

test('initializedConnectionDigest substitution refuses even when connectionAttemptId matches', async () => {
  // Finding 2: substitution of initializedConnectionDigest must refuse
  // independently of connectionAttemptId.
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const calls: string[] = [];
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:forged'),
    journal, start: startEvidence(f.fixture), bridge: f.bridge, channel: (() => {
      const channel = f.bridge.codexResultReturnChannel();
      if (!channel) throw new Error('channel required'); return channel;
    })(), recovery: recoveryHost(f.fixture, calls),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_connection_binding_invalid/);
  runtime.close(); await f.bridge.close(); journal.close();
});

test('cleanup_uncertain refuses publication when start evidence does not certify cleanup verified', async () => {
  // Finding 1: lifecycle gate refuses when the task process did not retire
  // with cleanup verified.
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const calls: string[] = [];
  const lifecycleStart = { load() { return { status: 'recorded' as const,
    readIdentity: { queueId: 'queue:test', runId: 'run:test', threadId: 'thread:durable',
      turnId: 'turn:durable', activationId: f.fixture.activationFrame.body.activationId,
      activationDigest: f.fixture.activationFrame.body.activationDigest,
      cleanupVerified: false as const }, cleanupVerified: false as const } as never; } };
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: lifecycleStart, bridge: f.bridge, channel: (() => {
      const channel = f.bridge.codexResultReturnChannel();
      if (!channel) throw new Error('channel required'); return channel;
    })(), recovery: recoveryHost(f.fixture, calls),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_cleanup_uncertain/);
  assert.equal(resultFrames(sent).length, 0);
  runtime.close(); await f.bridge.close(); journal.close();
});

test('read_scope_mismatch refuses when the owned read returns a different thread/turn scope', async () => {
  // Finding 1: the host-owned bounded read must declare the thread/turn
  // scope the read was bounded to. If that scope doesn't match the supplied
  // lineage, refuse before projection.
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const calls: string[] = [];
  const runtime = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture),
    recoveryHost(f.fixture, calls, 'completed', 'scope-mismatch'));
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_read_scope_mismatch/);
  assert.deepEqual(calls, ['read']);
  runtime.close(); await f.bridge.close(); journal.close();
});

test('clock_mismatch refuses when caller observedAt is outside the 1s auditing window', async () => {
  // Finding 1: observation time derives from the trusted clock. A caller-
  // supplied observedAt more than 1s off the trusted clock refuses.
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const calls: string[] = [];
  const farObservedAt = '2026-09-13T11:00:00.000Z'; // ~1h before trusted clock
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal, start: startEvidence(f.fixture), bridge: f.bridge, channel: (() => {
      const channel = f.bridge.codexResultReturnChannel();
      if (!channel) throw new Error('channel required'); return channel;
    })(), recovery: recoveryHost(f.fixture, calls),
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000,
    clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(farObservedAt, new AbortController().signal),
    /codex_recovered_result_clock_mismatch/);
  runtime.close(); await f.bridge.close(); journal.close();
});

test('stored receipt replay path validates runId / activationId / returnFrameDigest against the supplied lineage', async () => {
  // Finding 3: full-lineage replay validation. The runtime inspects a
  // receipted durable entry and refuses with replay_lineage_mismatch if any
  // of {runId, activationId, returnFrameDigest} disagree with the supplied
  // lineage. The journal's integrity layer prevents external tamper of the
  // SQLite-backed row, so the validation logic is exercised by injecting a
  // minimal journal stub whose returned receipt body intentionally disagrees.
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  const safeJournal = journal as unknown as { acceptedCodexActivation: typeof journal.acceptedCodexActivation;
    codexResultReturn: typeof journal.codexResultReturn };
  safeJournal.codexResultReturn = () => ({ status: 'receipted' as const,
    receipt: { body: { identity: { runId: 'run:other' }, // mismatched runId
      activation: { activationId: 'codex-activation:other' },
      returnFrameDigest: sha256Digest('other') } } as never,
    frame: {} as never,
    preparedAt: '2026-09-13T12:00:00.000Z', receiptedAt: '2026-09-13T12:00:01.000Z' });
  const calls: string[] = [];
  const runtime = createCodexRecoveredResultRuntimeV1({ runId: 'run:test', queueId: 'queue:test',
    threadId: 'thread:durable', turnId: 'turn:durable',
    activationId: f.fixture.activationFrame.body.activationId,
    activationDigest: f.fixture.activationFrame.body.activationDigest,
    connectionAttemptId: 'connection:result',
    initializedConnectionDigest: sha256Digest('initialized:result'),
    journal: safeJournal as never, start: startEvidence(f.fixture), bridge: f.bridge, channel: (() => {
      const channel = f.bridge.codexResultReturnChannel();
      if (!channel) throw new Error('channel required'); return channel;
    })(), recovery: { read() { calls.push('read'); throw new Error('must_not_read'); },
      project() { calls.push('project'); throw new Error('must_not_read'); } },
    qualificationReceipt: f.fixture.qualification, qualificationPublicKeySpki: qualificationSpki,
    qualificationMaximumAgeMs: 300_000, receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
  await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
    /codex_recovered_result_replay_lineage_mismatch/);
  assert.deepEqual(calls, []);
  runtime.close(); await f.bridge.close(); journal.close();
});

test('stored receipt replay refuses every same-run substitution across the full lineage', async () => {
  // Correction review item 1: the replay gate must validate the complete
  // saved queue, thread, turn, attempt, activation, profile and connection
  // lineage — not only run ID, activation ID and frame digest. Each case
  // substitutes exactly one field of an otherwise exact sealed entry and
  // requires replay_lineage_mismatch with no recovery read.
  const receiptCases: Array<{ name: string; tamper: (body: Record<string, any>) => void }> = [
    { name: 'runId', tamper: body => { body.identity.runId = 'run:other'; } },
    { name: 'attemptId', tamper: body => { body.identity.attemptId = 'attempt:other'; } },
    { name: 'threadId', tamper: body => { body.result.threadId = 'thread:other'; } },
    { name: 'turnId', tamper: body => { body.result.turnId = 'turn:other'; } },
    { name: 'activationId', tamper: body => { body.activation.activationId = 'codex-activation:other'; } },
    { name: 'activationDigest', tamper: body => { body.activation.activationDigest = sha256Digest('other'); } },
    { name: 'profileDigest', tamper: body => { body.connector.profileDigest = sha256Digest('other'); } },
    { name: 'profileId-empty', tamper: body => { body.connector.profileId = ''; } },
    { name: 'profileId-missing', tamper: body => { delete body.connector.profileId; } },
    { name: 'returnFrameDigest', tamper: body => { body.returnFrameDigest = sha256Digest('other'); } },
  ];
  const lineageCases: Array<{ name: string;
    lineage: { queueId?: string; threadId?: string; turnId?: string;
      activationId?: string; activationDigest?: string;
      connectionAttemptId?: string; initializedConnectionDigest?: string } }> = [
    { name: 'queueId', lineage: { queueId: 'queue:other' } },
    { name: 'caller-threadId', lineage: { threadId: 'thread:other' } },
    { name: 'caller-turnId', lineage: { turnId: 'turn:other' } },
    { name: 'caller-activationId', lineage: { activationId: 'codex-activation:other' } },
    { name: 'caller-activationDigest', lineage: { activationDigest: sha256Digest('other') } },
    { name: 'connectionAttemptId', lineage: { connectionAttemptId: 'connection:other' } },
    { name: 'initializedConnectionDigest',
      lineage: { initializedConnectionDigest: sha256Digest('other') } },
  ];
  for (const item of receiptCases) {
    const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
    const f = await connect(journal, sent);
    const body = f.fixture.body;
    const returnFrame = { type: 'harness.codex.result.return', direction: 'node_to_server',
      senderKind: 'node', tenantId: 'tenant:test', actorId: 'node:test', keyId: 'node-key:test',
      connectionId: 'connection:test', messageId: 'message:prepared-result',
      correlationId: 'correlation:test', causationId: body.activation.activationId,
      sequence: 4, sentAt: body.returnedAt, expiresAt: body.physicalQualification.validUntil,
      nonce: 'synthetic_prepared_result_nonce_12345678901234567890',
      bodyDigest: sha256Digest(body), body };
    const sealed = createCodexResultReturnReceiptBodyV1({ frame: returnFrame as never,
      recordedAt: body.returnedAt });
    const tampered = structuredClone(sealed) as unknown as Record<string, any>;
    item.tamper(tampered);
    // The gate compares stored fields structurally; the journal integrity
    // layer (not this gate) owns receiptDigest authentication.
    (journal as unknown as { codexResultReturn: unknown }).codexResultReturn = () => ({
      status: 'receipted' as const, receipt: { body: tampered } as never,
      frame: returnFrame as never,
      preparedAt: '2026-09-13T12:00:00.000Z', receiptedAt: '2026-09-13T12:00:01.000Z' });
    const calls: string[] = [];
    const runtime = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture), {
      read() { calls.push('read'); throw new Error('must_not_read'); },
      project() { calls.push('project'); throw new Error('must_not_read'); },
    });
    await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
      /codex_recovered_result_replay_lineage_mismatch/, `receipt substitution: ${item.name}`);
    assert.deepEqual(calls, [], `no recovery read for: ${item.name}`);
    runtime.close(); await f.bridge.close(); journal.close();
  }
  for (const item of lineageCases) {
    const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
    const f = await connect(journal, sent);
    const body = f.fixture.body;
    const returnFrame = { type: 'harness.codex.result.return', direction: 'node_to_server',
      senderKind: 'node', tenantId: 'tenant:test', actorId: 'node:test', keyId: 'node-key:test',
      connectionId: 'connection:test', messageId: 'message:prepared-result',
      correlationId: 'correlation:test', causationId: body.activation.activationId,
      sequence: 4, sentAt: body.returnedAt, expiresAt: body.physicalQualification.validUntil,
      nonce: 'synthetic_prepared_result_nonce_12345678901234567890',
      bodyDigest: sha256Digest(body), body };
    const sealed = createCodexResultReturnReceiptBodyV1({ frame: returnFrame as never,
      recordedAt: body.returnedAt });
    (journal as unknown as { codexResultReturn: unknown }).codexResultReturn = () => ({
      status: 'receipted' as const, receipt: { body: sealed } as never,
      frame: returnFrame as never,
      preparedAt: '2026-09-13T12:00:00.000Z', receiptedAt: '2026-09-13T12:00:01.000Z' });
    const calls: string[] = [];
    const runtime = runtimeFor(journal, f.bridge, f.fixture, startEvidence(f.fixture), {
      read() { calls.push('read'); throw new Error('must_not_read'); },
      project() { calls.push('project'); throw new Error('must_not_read'); },
    }, returnedAt, item.lineage);
    await assert.rejects(runtime.recover(observedAt, new AbortController().signal),
      /codex_recovered_result_replay_lineage_mismatch/, `lineage substitution: ${item.name}`);
    assert.deepEqual(calls, [], `no recovery read for: ${item.name}`);
    runtime.close(); await f.bridge.close(); journal.close();
  }
});
