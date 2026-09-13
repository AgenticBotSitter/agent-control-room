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
import { createCodexResultSenderV1 } from '../src/harness/codex-v1/result-sender';
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

function resultFixture() {
  const activationMaterial = { schema: 'control-room.codex-task-activation/v1' as const,
    tenantId: 'tenant:test', projectId: 'project:test', nodeId: 'node:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId: 'run:test', leaseId: 'lease:test', leaseEpoch: 7,
    queueId: 'queue:test', connectionId: 'connection:test',
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
  const rawResult = JSON.stringify({ thread: { id: 'thread:durable',
    cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: 'turn:durable', status: 'completed', itemsView: 'full', items: [
      { type: 'agentMessage', id: 'item:final', phase: 'final_answer', text: 'Exact result.' },
    ] }] } });
  const observation = projectExactPackageCodexCompletedTurnV1({ threadId: 'thread:durable',
    turnId: 'turn:durable', rawResult });
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
  completedTurn: observation, qualificationDigest: qualification.body.bodyDigest,
  observedAt: '2026-09-13T11:59:59.000Z' });
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

test('one current connection records sent before I/O, authenticates the exact receipt and reopens receipted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-result-sender-')); chmodSync(directory, 0o700);
  const path = join(directory, 'bridge.sqlite');
  try {
    const journal = new SqliteBridgeJournal(path), sent: string[] = [];
    const f = await connect(journal, sent);
    f.transport.send = async raw => {
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
      queueMicrotask(() => void f.bridge.receive(JSON.stringify(receipt), receivedAt));
    };
    const sender = createCodexResultSenderV1({ bridgeEvidence: journal, startEvidence: {
      load() { return { status: 'recorded' as const, readIdentity: {
        queueId: 'queue:test', runId: 'run:test', threadId: 'thread:durable', turnId: 'turn:durable',
        activationId: f.fixture.activationFrame.body.activationId,
        activationDigest: f.fixture.activationFrame.body.activationDigest,
      } } as never; },
    }, bridge: f.bridge, qualificationReceipt: f.fixture.qualification,
    qualificationPublicKeySpki: qualificationSpki, qualificationMaximumAgeMs: 300_000,
    receiptTimeoutMs: 1_000, clock: () => Date.parse(returnedAt) });
    const receipt = await sender.sendRecovered({ runId: 'run:test', queueId: 'queue:test',
      connectionAttemptId: 'connection:result', initializedConnectionDigest: sha256Digest('initialized:result'),
      observedAt: '2026-09-13T11:59:59.000Z', status: 'completed', identity: {
        runId: 'run:test', threadId: 'thread:durable', turnId: 'turn:durable',
        source: 'correlated_codex_start_receipts' }, exactPackageResult: f.fixture.observation,
    }, new AbortController().signal);
    assert.equal(receipt.body.disposition, 'transport_received');
    const outbound = sent.map(raw => JSON.parse(raw) as SignedNodeFrame)
      .filter(frame => frame.type === 'harness.codex.result.return');
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]!.expiresAt, f.fixture.body.physicalQualification.validUntil);
    assert.equal(journal.codexResultReturn('run:test')?.status, 'receipted');
    await assert.rejects(sender.sendRecovered({} as never, new AbortController().signal),
      /codex_result_sender_unavailable/);
    await f.bridge.close(); journal.close();
    const reopened = new SqliteBridgeJournal(path);
    (reopened as unknown as { acceptedCommand(messageId: string): unknown }).acceptedCommand = messageId =>
      messageId === f.fixture.activationFrame.messageId
        ? { frame: f.fixture.activationFrame, receivedAt: f.fixture.activationFrame.sentAt } : undefined;
    assert.equal(reopened.codexResultReturn('run:test')?.receipt?.body.receiptId, receipt.body.receiptId);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('transport uncertainty consumes the send slot and reconnect never replays or permits another return', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-result-uncertain-')); chmodSync(directory, 0o700);
  const path = join(directory, 'bridge.sqlite');
  try {
    let journal = new SqliteBridgeJournal(path), sent: string[] = [];
    const first = await connect(journal, sent);
    first.transport.send = async raw => { sent.push(raw); const frame = JSON.parse(raw) as SignedNodeFrame;
      if (frame.type === 'harness.codex.result.return') throw new Error('lost after write'); };
    await assert.rejects(first.bridge.sendCodexResultReturn('queue:test', first.fixture.body, returnedAt,
      new AbortController().signal, 100, () => returnedAt), /lost after write/);
    assert.equal(journal.codexResultReturn('run:test')?.status, 'sent');
    await first.bridge.close(); journal.close();
    journal = new SqliteBridgeJournal(path); sent = [];
    const second = await connect(journal, sent, 'reconnect');
    assert.equal(sent.some(raw => (JSON.parse(raw) as SignedNodeFrame).type === 'harness.codex.result.return'), false);
    await assert.rejects(second.bridge.sendCodexResultReturn('queue:test', second.fixture.body, returnedAt,
      new AbortController().signal, 100, () => returnedAt));
    assert.equal(journal.codexResultReturn('run:test')?.status, 'sent');
    await second.bridge.close(); journal.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an authenticated but mutated receipt fails closed and leaves the result durably sent', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent);
  f.transport.send = async raw => {
    sent.push(raw); const frame = JSON.parse(raw) as SignedNodeFrame;
    if (frame.type !== 'harness.codex.result.return') return;
    const body = createCodexResultReturnReceiptBodyV1({ frame: frame as never, recordedAt: receivedAt });
    const changed = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      senderKind: 'control_room', tenantId: 'tenant:test', actorId: 'server:test', keyId: 'server-key:test',
      connectionId: frame.connectionId, sequence: 3, messageId: 'message:changed-result-receipt',
      correlationId: 'correlation:mutated', causationId: frame.messageId,
      nonce: 'synthetic_changed_receipt_nonce_123456789', sentAt: receivedAt,
      expiresAt: frame.expiresAt, type: 'harness.codex.result.return.receipt', body }, serverKeys.privateKey);
    queueMicrotask(() => void f.bridge.receive(JSON.stringify(changed), receivedAt).catch(() => {}));
  };
  await assert.rejects(f.bridge.sendCodexResultReturn('queue:test', f.fixture.body, returnedAt,
    new AbortController().signal, 1_000, () => returnedAt), /Codex result return transport unavailable/);
  assert.equal(journal.codexResultReturn('run:test')?.status, 'sent');
  assert.equal(sent.filter(raw => (JSON.parse(raw) as SignedNodeFrame).type === 'harness.codex.result.return').length, 1);
  await f.bridge.close(); journal.close();
});

test('a crash after durable preparation leaves ambiguity that reconnect cannot replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-result-prepared-')); chmodSync(directory, 0o700);
  const path = join(directory, 'bridge.sqlite');
  try {
    let journal = new SqliteBridgeJournal(path), sent: string[] = [];
    const first = await connect(journal, sent);
    const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'node_to_server', senderKind: 'node',
      tenantId: 'tenant:test', actorId: 'node:test', keyId: 'node-key:test', connectionId: 'connection:test',
      sequence: journal.nextOutboundSequence('connection:test'), messageId: 'message:prepared-result',
      correlationId: `correlation:${first.fixture.body.returnId}`,
      causationId: first.fixture.body.activation.activationId,
      nonce: 'synthetic_prepared_result_nonce_123456789', sentAt: returnedAt,
      expiresAt: first.fixture.body.physicalQualification.validUntil,
      type: 'harness.codex.result.return', body: first.fixture.body }, nodeKeys.privateKey);
    journal.prepareCodexResultReturn(frame, first.fixture.activationFrame, returnedAt, () => {});
    assert.equal(journal.codexResultReturn('run:test')?.status, 'prepared');
    await first.bridge.close(); journal.close();
    journal = new SqliteBridgeJournal(path); sent = [];
    const second = await connect(journal, sent, 'prepared-reconnect');
    assert.equal(sent.some(raw => (JSON.parse(raw) as SignedNodeFrame).type === 'harness.codex.result.return'), false);
    assert.equal(journal.codexResultReturn('run:test')?.status, 'prepared');
    await assert.rejects(second.bridge.sendCodexResultReturn('queue:test', second.fixture.body, returnedAt,
      new AbortController().signal, 100, () => returnedAt));
    await second.bridge.close(); journal.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('abort and expiry discovered after signing prevent preparation and transport I/O', async () => {
  for (const mode of ['abort', 'expire'] as const) {
    const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
    let releaseSign!: () => void, signingStarted!: () => void;
    const started = new Promise<void>(resolve => { signingStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseSign = resolve; });
    const f = await connect(journal, sent, 'test', async frame => {
      signingStarted(); await released; return signNodeFrame(frame, nodeKeys.privateKey);
    });
    const controller = new AbortController();
    let current = returnedAt;
    const pending = f.bridge.sendCodexResultReturn('queue:test', f.fixture.body, returnedAt,
      controller.signal, 1_000, () => current);
    void pending.catch(() => {});
    await started;
    if (mode === 'abort') controller.abort();
    else current = f.fixture.body.physicalQualification.validUntil;
    releaseSign();
    await assert.rejects(pending, /Codex result return operation unavailable|Codex result qualification expired/);
    assert.equal(journal.codexResultReturn('run:test'), undefined);
    assert.equal(sent.some(raw => (JSON.parse(raw) as SignedNodeFrame).type === 'harness.codex.result.return'), false);
    await f.bridge.close(); journal.close();
  }
});

test('timeout, cancellation and disconnect bound a hung write and release the send queue', async () => {
  for (const mode of ['timeout', 'cancel', 'disconnect'] as const) {
    const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
    const f = await connect(journal, sent);
    let writeStarted!: () => void;
    const started = new Promise<void>(resolve => { writeStarted = resolve; });
    f.transport.send = async raw => {
      sent.push(raw);
      if ((JSON.parse(raw) as SignedNodeFrame).type === 'harness.codex.result.return') {
        writeStarted(); await new Promise<void>(() => {});
      }
    };
    const controller = new AbortController();
    const pending = f.bridge.sendCodexResultReturn('queue:test', f.fixture.body, returnedAt,
      controller.signal, mode === 'timeout' ? 20 : 1_000, () => returnedAt);
    void pending.catch(() => {});
    await started;
    if (mode === 'cancel') controller.abort();
    if (mode === 'disconnect') await f.bridge.disconnected();
    await assert.rejects(pending);
    assert.equal(journal.codexResultReturn('run:test')?.status, 'sent');
    await assert.rejects(Promise.race([
      f.bridge.sendCodexResultReturn('queue:test', f.fixture.body, returnedAt,
        new AbortController().signal, 20, () => returnedAt),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('send_queue_stuck')), 250)),
    ]), error => error instanceof Error && error.message !== 'send_queue_stuck');
    await f.bridge.close(); journal.close();
  }
});

test('native snapshot ACK flushing cannot block the following exact result receipt', async () => {
  const journal = new SqliteBridgeJournal(':memory:'), sent: string[] = [];
  const f = await connect(journal, sent, 'test', undefined,
    [CODEX_RESULT_RETURN_FEATURE_V1, 'harness.native.snapshot.v1']);
  let inbound: Promise<void> | undefined;
  f.transport.send = async raw => {
    sent.push(raw); const frame = JSON.parse(raw) as SignedNodeFrame;
    if (frame.type !== 'harness.codex.result.return') return;
    const ack = f.serverFrame(3, 'protocol.ack', { acknowledgedMessageIds: [frame.messageId],
      highestContiguousSequence: frame.sequence, disposition: 'accepted' });
    const receiptBody = createCodexResultReturnReceiptBodyV1({ frame: frame as never, recordedAt: receivedAt });
    const receipt = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: 'server_to_node',
      senderKind: 'control_room', tenantId: 'tenant:test', actorId: 'server:test', keyId: 'server-key:test',
      connectionId: frame.connectionId, sequence: 4, messageId: 'message:result-after-generic-ack',
      correlationId: frame.correlationId, causationId: frame.messageId,
      nonce: 'synthetic_result_after_ack_nonce_123456789', sentAt: receivedAt,
      expiresAt: frame.expiresAt, type: 'harness.codex.result.return.receipt', body: receiptBody },
    serverKeys.privateKey);
    inbound = Promise.resolve().then(async () => {
      await f.bridge.receive(JSON.stringify(ack), receivedAt);
      assert.equal(journal.codexResultReturn('run:test')?.status, 'sent');
      await f.bridge.receive(JSON.stringify(receipt), receivedAt);
    });
    void inbound.catch(() => {});
  };
  const receipt = await f.bridge.sendCodexResultReturn('queue:test', f.fixture.body, returnedAt,
    new AbortController().signal, 1_000, () => returnedAt);
  await inbound;
  assert.equal(receipt.body.disposition, 'transport_received');
  assert.equal(journal.codexResultReturn('run:test')?.status, 'receipted');
  await f.bridge.close(); journal.close();
});
