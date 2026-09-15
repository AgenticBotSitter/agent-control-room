import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { projectExactPackageCodexCompletedTurnV1 } from '../src/harness/codex-v1/completed-turn';
import { CODEX_APP_SERVER_ADAPTER } from '../src/harness/codex-v1/delivery-contract';
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from '../src/harness/codex-v1/schema-contract';
import { CODEX_PHYSICAL_QUALIFICATION_RECEIPT_SCHEMA_V1,
  CODEX_RESULT_PUBLICATION_CONTRACT_SCHEMA_V1,
  codexResultPublicationContractSchemaV1,
  createCodexPhysicalQualificationReceiptBodyV1,
  createCodexResultPublicationContractV1,
  verifyCodexPhysicalQualificationReceiptV1 } from '../src/harness/codex-v1/result-publication-contract';
import { computeArtifactBodyDigest, signArtifact } from '../src/node-policy/v1/crypto';
import { sha256Digest } from '../src/security/canonical-digest';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const publicKeySpki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const otherPublicKeySpki = otherKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

const exactPackage = () => ({
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
});

function activation() {
  const material = {
    schema: 'control-room.codex-task-activation/v1' as const,
    tenantId: 'tenant:test', projectId: 'project:test', nodeId: 'node:test', jobId: 'job:test',
    attemptId: 'attempt:test', runId: 'run:test', leaseId: 'lease:test', leaseEpoch: 7,
    queueId: 'queue:test', connectionId: 'connection:test',
    connection: { connectionAttemptId: 'connection:result',
      initializedConnectionDigest: sha256Digest('initialized:result') },
    dispatchMessageId: 'message:dispatch', dispatchFrameDigest: sha256Digest('dispatch-frame'),
    dispatchBodyDigest: sha256Digest('dispatch-body'), receiptMessageId: 'message:receipt',
    receiptFrameDigest: sha256Digest('receipt-frame'), receiptBodyDigest: sha256Digest('receipt-body'),
    permitDigest: sha256Digest('permit'), inputDigest: sha256Digest({ prompt: 'Do the work', instructions: 'Be exact' }),
    operationDigest: sha256Digest('operation'), effectClaimKey: sha256Digest('effect'),
    enrollmentDigest: sha256Digest('enrollment'), connectorProfileDigest: sha256Digest('profile'),
    workspaceIntentDigest: sha256Digest('workspace'), currentAdmissionDigest: sha256Digest('admission'),
    workspacePath: '/synthetic/workspace', prompt: 'Do the work', instructions: 'Be exact',
    receiptRecordedAt: '2026-09-13T12:00:00.000Z', receiptReceivedAt: '2026-09-13T12:00:01.000Z',
    activatedAt: '2026-09-13T12:00:02.000Z', activationExpiresAt: '2026-09-13T12:01:00.000Z',
    startsWork: false as const, authorizesExactStart: true as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const,
  };
  const activationDigest = sha256Digest(material);
  return Object.freeze({ ...material, activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest });
}

function observation(text = 'Exact bounded answer.') {
  const rawResult = JSON.stringify({ thread: { id: 'thread:durable',
    cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: 'turn:durable', status: 'completed', itemsView: 'full', items: [
      { type: 'agentMessage', id: 'item:final', phase: 'final_answer', text },
    ] }] } });
  return projectExactPackageCodexCompletedTurnV1({ threadId: 'thread:durable',
    turnId: 'turn:durable', rawResult });
}

function evidence<T extends Record<string, unknown>>(material: T) {
  return { ...material, evidenceDigest: sha256Digest(material) };
}

function qualificationMaterial(overrides: Record<string, unknown> = {}) {
  const start = evidence({ evidenceId: 'evidence:start', processAttemptId: 'process:start',
    connectionAttemptId: 'connection-attempt:start', initializedConnectionDigest: sha256Digest('start-initialized'),
    threadId: 'thread:qualification', turnId: 'turn:qualification', startObserved: true as const,
    cleanupVerified: true as const });
  const restartRead = evidence({ evidenceId: 'evidence:restart-read', processAttemptId: 'process:restart-read',
    connectionAttemptId: 'connection-attempt:restart-read', initializedConnectionDigest: sha256Digest('restart-initialized'),
    threadId: 'thread:qualification', turnId: 'turn:qualification', itemId: 'item:qualification',
    restartObserved: true as const, exactReadObserved: true as const, cleanupVerified: true as const });
  return { schema: CODEX_PHYSICAL_QUALIFICATION_RECEIPT_SCHEMA_V1,
    qualificationId: 'qualification:codex-app-server:0.150.0-alpha.8',
    qualificationSignerKeyId: 'qualification-key:test', tenantId: 'tenant:test', nodeId: 'node:test',
    connectorProfileId: 'profile:codex:test', connectorProfileDigest: sha256Digest('profile'),
    exactPackage: exactPackage(), qualifiedAt: '2026-09-13T11:00:00.000Z', start, restartRead,
    oneFreshProcessPerAttempt: true as const, sameDurableThreadObserved: true as const,
    sameDurableTurnObserved: true as const, terminalCleanupVerified: true as const,
    processReuseObserved: false as const, retryObserved: false as const,
    canonicalPublicationAllowed: false as const, completionVerified: false as const,
    grantsExecutionAuthority: false as const, permitsRetry: false as const, permitsResume: false as const,
    permitsThreadRead: false as const, ...overrides };
}

function signedQualification(material = qualificationMaterial()) {
  const body = createCodexPhysicalQualificationReceiptBodyV1(material as never);
  return signArtifact(body, keys.privateKey);
}

function fixture() {
  const activationValue = activation();
  const observationValue = observation();
  const qualificationReceipt = signedQualification();
  const binding = {
    identity: { tenantId: activationValue.tenantId, projectId: activationValue.projectId,
      jobId: activationValue.jobId, attemptId: activationValue.attemptId, runId: activationValue.runId,
      nodeId: activationValue.nodeId, leaseId: activationValue.leaseId, leaseEpoch: activationValue.leaseEpoch },
    delivery: { activationDigest: activationValue.activationDigest,
      dispatchBodyDigest: activationValue.dispatchBodyDigest, receiptBodyDigest: activationValue.receiptBodyDigest },
    connection: { connectionId: activationValue.connectionId,
      connectionAttemptId: 'connection-attempt:result-read', initializedConnectionDigest: sha256Digest('result-initialized'),
      connectorProfileId: 'profile:codex:test', connectorProfileDigest: activationValue.connectorProfileDigest },
    result: { threadId: observationValue.threadId, turnId: observationValue.turnId, itemId: observationValue.itemId,
      projectionDigest: observationValue.projectionDigest, rawResultDigest: observationValue.rawResultDigest,
      rawTurnDigest: observationValue.matchedTurnDigest, contentHash: observationValue.contentHash,
      contentSizeBytes: observationValue.sizeBytes },
    physicalQualification: { qualificationId: qualificationReceipt.body.qualificationId,
      receiptBodyDigest: qualificationReceipt.body.bodyDigest,
      signerKeyId: qualificationReceipt.body.qualificationSignerKeyId },
  };
  const input = { activation: activationValue, observation: observationValue,
    observationSource: 'stored_thread_read' as const,
    connection: { connectionAttemptId: binding.connection.connectionAttemptId,
      initializedConnectionDigest: binding.connection.initializedConnectionDigest,
      connectorProfileId: binding.connection.connectorProfileId }, binding,
    qualificationReceipt, qualificationPublicKeySpki: publicKeySpki };
  return { input, activationValue, observationValue, qualificationReceipt };
}

function create(input: Parameters<typeof createCodexResultPublicationContractV1>[0] = fixture().input) {
  return createCodexResultPublicationContractV1(input);
}

function resignUnsafe(material: Record<string, unknown>) {
  const body = { ...material, bodyDigest: computeArtifactBodyDigest(material) } as never;
  return signArtifact(body, keys.privateKey);
}

function setPath(value: unknown, path: string, replacement: unknown) {
  const copy = structuredClone(value) as Record<string, unknown>;
  const parts = path.split('.');
  let cursor = copy;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  cursor[parts.at(-1)!] = replacement;
  return copy;
}

function rehashContract(value: unknown) {
  const { contractDigest: _ignored, ...material } = structuredClone(value) as Record<string, unknown>;
  return { ...material, contractDigest: sha256Digest(material) };
}

function reprojectContractText(value: unknown, text: string) {
  const changed = structuredClone(value) as ReturnType<typeof create>;
  changed.result.text = text;
  changed.result.contentSizeBytes = Buffer.byteLength(text, 'utf8');
  changed.result.contentHash = `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
  changed.result.projectionDigest = sha256Digest({
    schema: changed.result.projectionSchema, threadId: changed.result.threadId,
    turnId: changed.result.turnId, itemId: changed.result.itemId, phase: changed.result.phase,
    text: changed.result.text, sizeBytes: changed.result.contentSizeBytes,
    contentHash: changed.result.contentHash, rawResultDigest: changed.result.rawResultDigest,
    matchedTurnDigest: changed.result.rawTurnDigest, source: 'exact_package_generated_schema',
    selectedResultItemSchemaQualified: true, canonicalPublicationAllowed: false,
    completionVerified: false, grantsExecutionAuthority: false, permitsRetry: false,
    permitsResume: false, permitsThreadRead: false,
  });
  return rehashContract(changed);
}

test('creates one exact, inert result contract and deeply freezes every nested binding', () => {
  const f = fixture();
  const contract = create(f.input);
  assert.equal(contract.schema, CODEX_RESULT_PUBLICATION_CONTRACT_SCHEMA_V1);
  assert.deepEqual(contract.identity, f.input.binding.identity);
  assert.equal(contract.delivery.activationDigest, f.activationValue.activationDigest);
  assert.equal(contract.delivery.dispatchFrameDigest, f.activationValue.dispatchFrameDigest);
  assert.equal(contract.delivery.receiptFrameDigest, f.activationValue.receiptFrameDigest);
  assert.deepEqual(contract.connection, f.input.binding.connection);
  assert.equal(contract.result.projectionDigest, f.observationValue.projectionDigest);
  assert.equal(contract.result.rawTurnDigest, f.observationValue.matchedTurnDigest);
  assert.equal(contract.result.contentHash, f.observationValue.contentHash);
  assert.equal(contract.result.contentSizeBytes, Buffer.byteLength(f.observationValue.text));
  assert.equal(contract.exactPackage.packageVersion, '0.150.0-alpha.8');
  assert.equal(contract.physicalQualification.receiptBodyDigest, f.qualificationReceipt.body.bodyDigest);
  for (const flag of ['startsWork', 'writesResult', 'writesArtifact', 'writesReview', 'releasesCapacity',
    'canonicalPublicationAllowed', 'completionVerified', 'grantsExecutionAuthority', 'permitsRetry',
    'permitsResume', 'permitsNewTurn', 'permitsThreadRead', 'performsIo'] as const) assert.equal(contract[flag], false);
  for (const nested of [contract, contract.identity, contract.delivery, contract.connection,
    contract.exactPackage, contract.result, contract.physicalQualification]) assert.equal(Object.isFrozen(nested), true);
  assert.throws(() => { (contract.result as { text: string }).text = 'changed'; }, TypeError);
  assert.deepEqual(create(f.input), contract);
});

test('signed physical qualification is separately verified and names all exact package schemas', () => {
  const receipt = signedQualification();
  const verified = verifyCodexPhysicalQualificationReceiptV1({ receipt,
    expectedQualificationId: receipt.body.qualificationId, expectedBodyDigest: receipt.body.bodyDigest,
    expectedSignerKeyId: receipt.body.qualificationSignerKeyId, publicKeySpki });
  assert.deepEqual(verified.body.exactPackage, exactPackage());
  assert.equal(verified.body.start.startObserved, true);
  assert.equal(verified.body.restartRead.restartObserved, true);
  assert.equal(verified.body.restartRead.exactReadObserved, true);
  assert.equal(verified.body.start.cleanupVerified, true);
  assert.equal(verified.body.restartRead.cleanupVerified, true);
  assert.equal(verified.body.terminalCleanupVerified, true);
  assert.equal(Object.isFrozen(verified.body.start), true);
  assert.equal(Object.isFrozen(verified.body.restartRead), true);
});

test('rejects every exact identity, delivery, connection, result, and qualification binding mismatch', () => {
  const f = fixture();
  const cases: Array<[string, unknown]> = [
    ['identity.tenantId', 'tenant:other'], ['identity.projectId', 'project:other'],
    ['identity.jobId', 'job:other'], ['identity.attemptId', 'attempt:other'], ['identity.runId', 'run:other'],
    ['identity.nodeId', 'node:other'], ['identity.leaseId', 'lease:other'], ['identity.leaseEpoch', 8],
    ['delivery.activationDigest', sha256Digest('other-activation')],
    ['delivery.dispatchBodyDigest', sha256Digest('other-dispatch')],
    ['delivery.receiptBodyDigest', sha256Digest('other-receipt')],
    ['connection.connectionId', 'connection:other'],
    ['connection.connectionAttemptId', 'connection-attempt:other'],
    ['connection.initializedConnectionDigest', sha256Digest('other-initialized')],
    ['connection.connectorProfileId', 'profile:other'],
    ['connection.connectorProfileDigest', sha256Digest('other-profile')],
    ['result.threadId', 'thread:other'], ['result.turnId', 'turn:other'], ['result.itemId', 'item:other'],
    ['result.projectionDigest', sha256Digest('other-projection')],
    ['result.rawResultDigest', sha256Digest('other-result')], ['result.rawTurnDigest', sha256Digest('other-turn')],
    ['result.contentHash', sha256Digest('other-content')], ['result.contentSizeBytes', f.observationValue.sizeBytes + 1],
    ['physicalQualification.qualificationId', 'qualification:other'],
    ['physicalQualification.receiptBodyDigest', sha256Digest('other-qualification')],
    ['physicalQualification.signerKeyId', 'qualification-key:other'],
  ];
  for (const [path, value] of cases) {
    const binding = setPath(f.input.binding, path, value);
    assert.throws(() => create({ ...f.input, binding } as never), /contract_unavailable/, path);
  }
});

test('rejects forged, substituted, malformed, or version-drifted physical qualification', () => {
  const f = fixture();
  assert.throws(() => create({ ...f.input, qualificationPublicKeySpki: otherPublicKeySpki }), /contract_unavailable/);
  assert.throws(() => create({ ...f.input,
    qualificationReceipt: signArtifact(f.qualificationReceipt.body, otherKeys.privateKey),
  }), /contract_unavailable/);
  assert.throws(() => create({ ...f.input, qualificationReceipt: {
    ...f.qualificationReceipt, unexpected: true,
  } }), /contract_unavailable/);
  for (const [path, replacement] of [
    ['exactPackage.packageVersion', '0.150.0-alpha.9'],
    ['exactPackage.generatedSchemaBundleSha256', '0'.repeat(64)],
    ['exactPackage.threadStartParamsSchemaSha256', '0'.repeat(64)],
    ['exactPackage.threadStartResponseSchemaSha256', '0'.repeat(64)],
    ['exactPackage.turnStartParamsSchemaSha256', '0'.repeat(64)],
    ['exactPackage.turnStartResponseSchemaSha256', '0'.repeat(64)],
    ['exactPackage.threadReadResponseSchemaSha256', '0'.repeat(64)],
    ['exactPackage.agentMessageSourceSha256', '0'.repeat(64)],
  ] as const) {
    const receipt = resignUnsafe(setPath(qualificationMaterial(), path, replacement));
    assert.throws(() => create({ ...f.input, qualificationReceipt: receipt }), /contract_unavailable/, path);
  }
});

test('rejects incomplete qualification and replay ambiguity between start and restart/read', () => {
  const f = fixture();
  for (const [path, replacement] of [
    ['start.startObserved', false], ['start.cleanupVerified', false],
    ['restartRead.restartObserved', false], ['restartRead.exactReadObserved', false],
    ['restartRead.cleanupVerified', false], ['terminalCleanupVerified', false],
    ['oneFreshProcessPerAttempt', false], ['sameDurableThreadObserved', false],
    ['sameDurableTurnObserved', false], ['processReuseObserved', true], ['retryObserved', true],
    ['restartRead.processAttemptId', 'process:start'],
    ['restartRead.connectionAttemptId', 'connection-attempt:start'],
    ['restartRead.evidenceId', 'evidence:start'],
    ['restartRead.threadId', 'thread:other'], ['restartRead.turnId', 'turn:other'],
  ] as const) {
    const changed = setPath(qualificationMaterial(), path, replacement) as Record<string, unknown>;
    const nested = path.startsWith('start.') ? 'start' : path.startsWith('restartRead.') ? 'restartRead' : undefined;
    if (nested) {
      const evidenceValue = changed[nested] as Record<string, unknown>;
      const { evidenceDigest: _ignored, ...material } = evidenceValue;
      changed[nested] = evidence(material);
    }
    const receipt = resignUnsafe(changed);
    assert.throws(() => create({ ...f.input, qualificationReceipt: receipt }), /contract_unavailable/, path);
  }
});

function syntheticObservation(text: string) {
  const original = observation('safe');
  const bytes = Buffer.from(text, 'utf8');
  const material = { ...original, text, sizeBytes: bytes.byteLength,
    contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const { projectionDigest: _ignored, ...withoutDigest } = material;
  return { ...withoutDigest, projectionDigest: sha256Digest(withoutDigest) };
}

test('rejects malformed, secret, oversized, or internally inconsistent result content', () => {
  const f = fixture();
  for (const result of [
    { ...f.observationValue, unexpected: true },
    { ...f.observationValue, contentHash: sha256Digest('wrong') },
    { ...f.observationValue, sizeBytes: f.observationValue.sizeBytes + 1 },
    { ...f.observationValue, projectionDigest: sha256Digest('wrong') },
    { ...f.observationValue, completionVerified: true },
    syntheticObservation('\ud800'),
    syntheticObservation('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature'),
    syntheticObservation('x'.repeat(65_537)),
  ]) {
    const binding = structuredClone(f.input.binding);
    binding.result = { threadId: result.threadId, turnId: result.turnId, itemId: result.itemId,
      projectionDigest: result.projectionDigest, rawResultDigest: result.rawResultDigest,
      rawTurnDigest: result.matchedTurnDigest, contentHash: result.contentHash, contentSizeBytes: result.sizeBytes };
    assert.throws(() => create({ ...f.input, observation: result, binding }), /contract_unavailable/);
  }
});

test('a repeated exact input is deterministic while a conflicting same-item result is refused by the exact binding', () => {
  const f = fixture();
  const first = create(f.input);
  assert.deepEqual(create(f.input), first);
  const conflicting = observation('Conflicting replay bytes.');
  assert.equal(conflicting.itemId, f.observationValue.itemId);
  assert.throws(() => create({ ...f.input, observation: conflicting }), /contract_unavailable/);
});

test('persisted contract readback revalidates content, projection, secrecy, Unicode, and deterministic identity', () => {
  const contract = create();
  assert.deepEqual(codexResultPublicationContractSchemaV1.parse(JSON.parse(JSON.stringify(contract))), contract);
  const tampered = [
    rehashContract(setPath(contract, 'result.contentHash', sha256Digest('other-content'))),
    rehashContract(setPath(contract, 'result.contentSizeBytes', contract.result.contentSizeBytes + 1)),
    rehashContract(setPath(contract, 'result.projectionDigest', sha256Digest('other-projection'))),
    rehashContract(setPath(contract, 'result.rawTurnDigest', sha256Digest('other-raw-turn'))),
    rehashContract(setPath(contract, 'result.phase', 'unphased')),
    rehashContract(setPath(contract, 'publicationId', `codex-result:${'0'.repeat(64)}`)),
    reprojectContractText(contract, '\ud800'),
    reprojectContractText(contract,
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature'),
  ];
  for (const value of tampered) {
    assert.equal(codexResultPublicationContractSchemaV1.safeParse(value).success, false);
  }
});
