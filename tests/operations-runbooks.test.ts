import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildOperationsRunbookRegistryV1,
  buildOperationsSyntheticRunbookEvidenceV1,
  OPERATIONS_RUNBOOK_IDS_V1,
  OperationsContractErrorV1,
  OperationsRunbookAuthenticatorV1,
  parseOperationsRunbookDefinitionV1,
  parseOperationsRunbookInstanceV1,
  parseOperationsRunbookRegistryV1,
  rehearseOperationsRunbookV1,
  renderOperationsRunbookGuideV1,
  type OperationsRunbookDefinitionV1,
  type OperationsRunbookEvidenceStateV1,
  type OperationsRunbookInstanceV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";
import { binaryViewAttack, observedProxy } from "./proxy-test-helper";

const base = Date.parse("2026-08-30T06:00:00.000Z");
const at = (seconds: number) => new Date(base + seconds * 1_000).toISOString();
const digest = (label: string) => sha256Digest({ test: "operations-runbooks", label });
const clone = <T>(value: T): T => structuredClone(value);
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}
function authenticator(fill = 31) {
  return new OperationsRunbookAuthenticatorV1(digest("authenticator"), new Uint8Array(32).fill(fill), { testOnly: true });
}
function start(auth: OperationsRunbookAuthenticatorV1, definition: OperationsRunbookDefinitionV1,
  suffix = definition.runbookId.split(":").at(-1)!) {
  const registry = buildOperationsRunbookRegistryV1();
  return auth.start({ registry, runbookId: definition.runbookId, instanceId: `instance:operations:runbook:${suffix}`,
    scopeDigest: digest(`scope:${suffix}`), operationDigest: digest(`operation:${suffix}`),
    createdAt: at(0), expiresAt: at(600) });
}
function evidence(definition: OperationsRunbookDefinitionV1, instance: OperationsRunbookInstanceV1,
  position: number, state: OperationsRunbookEvidenceStateV1 = "met", observed = position + 1, validUntil = 300) {
  return buildOperationsSyntheticRunbookEvidenceV1({ definition, instance, stepId: definition.steps[position]!.stepId,
    state, observedAt: at(observed), validUntil: at(validUntil) });
}
function advanceThrough(auth: OperationsRunbookAuthenticatorV1, definition: OperationsRunbookDefinitionV1,
  instance: OperationsRunbookInstanceV1, lastInclusive: number) {
  let current = instance;
  for (let position = 0; position <= lastInclusive; position += 1) {
    const proof = evidence(definition, current, position, "met", position + 1);
    current = auth.advance(current, definition, proof, at(position + 1));
  }
  return current;
}
const errorCode = (safeCode: string) => (error: unknown) =>
  error instanceof OperationsContractErrorV1 && error.safeCode === safeCode;

test("CR10A-OPS-090 freezes eight exact, ordered, non-authorizing operations runbooks", () => {
  const registry = buildOperationsRunbookRegistryV1();
  assert.deepEqual(parseOperationsRunbookRegistryV1(registry), registry);
  assert.deepEqual(registry.definitions.map((definition) => definition.runbookId), [...OPERATIONS_RUNBOOK_IDS_V1]);
  assert.deepEqual(registry.definitions.map((definition) => definition.steps.length), [10, 7, 7, 8, 7, 13, 7, 7]);
  for (const definition of registry.definitions) {
    assert.equal(definition.steps.every((step, position) => step.position === position
      && step.requiresPreviousStep === (position > 0) && step.requiresFreshEvidence
      && !step.nativeExecutorSlotPresent && !step.automaticRetryAllowed && !step.actionAuthorized
      && !step.grantsApproval && !step.grantsExecutionAuthority), true);
    assert.equal(definition.steps.at(-2)?.stepId, definition.cleanupStepId);
    assert.equal(definition.steps.at(-2)?.kind, "cleanup");
    assert.equal(definition.steps.at(-1)?.stepId, definition.reconciliationStepId);
    assert.equal(definition.steps.at(-1)?.kind, "reconciliation");
    assert.equal(definition.nativeExecutorPresent || definition.targetPresent || definition.automaticRetryAllowed
      || definition.authorized || definition.grantsApproval || definition.grantsExecutionAuthority, false);
    assert.deepEqual(definition.commandLines, []);
  }
  assert.equal(registry.nativeExecutorPresent || registry.productionValuesPresent || registry.grantsApproval
    || registry.grantsExecutionAuthority, false);
});

test("CR10A-OPS-090 rejects re-signed semantic drift in a step, definition, or registry", () => {
  const registry = buildOperationsRunbookRegistryV1(), definition = clone(registry.definitions[0]!);
  const changedStep = resign({ ...definition.steps[0], evidenceClass: "substituted_evidence" } as unknown as Record<string, unknown>, "stepDigest");
  definition.steps[0] = changedStep as never;
  assert.throws(() => parseOperationsRunbookDefinitionV1(resign(definition as unknown as Record<string, unknown>, "definitionDigest")));
  const reordered = clone(registry); reordered.definitions.reverse();
  assert.throws(() => parseOperationsRunbookRegistryV1(resign(reordered as unknown as Record<string, unknown>, "registryDigest")));
  const enabled = clone(registry.definitions[1]!) as unknown as Record<string, unknown>; enabled.nativeExecutorPresent = true;
  assert.throws(() => parseOperationsRunbookDefinitionV1(resign(enabled, "definitionDigest")));
});

test("CR10A-OPS-090 renders bounded guides with no controls, commands, targets, or execution claims", () => {
  for (const definition of buildOperationsRunbookRegistryV1().definitions) {
    const guide = renderOperationsRunbookGuideV1(definition);
    assert.deepEqual(guide.controls, []); assert.deepEqual(guide.commandLines, []);
    assert.equal(guide.stepCards.length, definition.steps.length);
    assert.deepEqual(guide.stepCards.map((card) => card.stepId), definition.steps.map((step) => step.stepId));
    assert.equal(guide.stepCards.filter((card) => card.ownerPromptCode).length,
      definition.steps.filter((step) => step.kind === "owner_gate").length);
    assert.equal(guide.nativeExecutorPresent || guide.performsAction || guide.grantsApproval || guide.grantsExecutionAuthority, false);
    assert.equal(JSON.stringify(guide).includes("credential") || JSON.stringify(guide).includes("hostname"), false);
  }
});

test("CR10A-OPS-090 rehearses every runbook end to end with synthetic evidence and zero effects", () => {
  const registry = buildOperationsRunbookRegistryV1(), auth = authenticator();
  for (const [position, definition] of registry.definitions.entries()) {
    const completed = rehearseOperationsRunbookV1({ authenticator: auth, registry, runbookId: definition.runbookId,
      instanceId: `instance:operations:rehearsal:${position}`, scopeDigest: digest(`rehearsal-scope:${position}`),
      operationDigest: digest(`rehearsal-operation:${position}`), startedAt: at(position * 20), expiresAt: at(500) });
    assert.equal(completed.status, "completed_evidence_only"); assert.equal(completed.currentStepPosition, definition.steps.length);
    assert.equal(completed.effectAttemptCount, 0); assert.deepEqual(completed.commandLines, []);
    assert.equal(completed.authorized || completed.grantsApproval || completed.grantsExecutionAuthority, false);
    assert.equal(completed.stepStates.every((step) => step.state === "met" && step.evidence?.syntheticOnly
      && !step.evidence.performsAction && !step.evidence.grantsApproval && !step.evidence.grantsExecutionAuthority), true);
  }
  auth.close();
});

test("CR10A-OPS-090 refuses skipped or out-of-order steps", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[0]!, auth = authenticator(), instance = start(auth, definition, "skip");
  const skipped = evidence(definition, instance, 1, "met", 1);
  assert.throws(() => auth.advance(instance, definition, skipped, at(1)), errorCode("unsupported_action"));
  assert.equal(auth.verify(instance).status, "not_started"); auth.close();
});

test("CR10A-OPS-090 records stale evidence and blocks safely before any rehearsed change", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[0]!, auth = authenticator(), instance = start(auth, definition, "stale"),
    stale = evidence(definition, instance, 0, "met", 1, 2), blocked = auth.advance(instance, definition, stale, at(3));
  assert.equal(blocked.status, "blocked_before_change"); assert.equal(blocked.stepStates[0]?.state, "stale");
  assert.equal(blocked.changeBoundaryRehearsed, false); assert.equal(blocked.effectAttemptCount, 0);
  assert.deepEqual(auth.advance(blocked, definition, stale, at(3)), blocked); auth.close();
});

test("CR10A-OPS-090 binds evidence to one instance, operation, definition, and step", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[0]!, auth = authenticator(),
    first = start(auth, definition, "binding-a"), second = start(auth, definition, "binding-b"), proof = evidence(definition, first, 0);
  assert.throws(() => auth.advance(second, definition, proof, at(1)), errorCode("scope_mismatch"));
  const mixed = resign({ ...proof, operationDigest: digest("foreign-operation") } as unknown as Record<string, unknown>, "recordDigest");
  assert.throws(() => auth.advance(first, definition, mixed, at(1)), errorCode("scope_mismatch"));
  const forgedDigest = resign({ ...proof, evidenceDigest: digest("forged-evidence") } as unknown as Record<string, unknown>, "recordDigest");
  assert.throws(() => auth.advance(first, definition, forgedDigest, at(1)), errorCode("scope_mismatch"));
  const wrongStep = resign({ ...proof, stepDigest: definition.steps[1]!.stepDigest } as unknown as Record<string, unknown>, "recordDigest");
  assert.throws(() => auth.advance(first, definition, wrongStep, at(1)), errorCode("scope_mismatch")); auth.close();
});

test("CR10A-OPS-090 makes exact replay inert and rejects changed replay without a retry path", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[0]!, auth = authenticator(), instance = start(auth, definition, "replay"),
    first = evidence(definition, instance, 0), advanced = auth.advance(instance, definition, first, at(1));
  assert.deepEqual(auth.advance(advanced, definition, first, at(1)), advanced);
  const changed = buildOperationsSyntheticRunbookEvidenceV1({ definition, instance: advanced, stepId: definition.steps[0]!.stepId,
    state: "failed", observedAt: at(2), validUntil: at(300) });
  assert.throws(() => auth.advance(advanced, definition, changed, at(2)), errorCode("invalid_transition"));
  assert.equal("retry" in auth || "reset" in auth, false); auth.close();
});

test("CR10A-OPS-090 forces cleanup then reconciliation after uncertainty at a change boundary", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[0]!, auth = authenticator(),
    effectPosition = definition.steps.findIndex((step) => step.kind === "effect_slot"),
    beforeEffect = advanceThrough(auth, definition, start(auth, definition, "ambiguous"), effectPosition - 1),
    uncertain = evidence(definition, beforeEffect, effectPosition, "unknown", effectPosition + 1),
    ambiguous = auth.advance(beforeEffect, definition, uncertain, at(effectPosition + 1)),
    cleanupPosition = definition.steps.findIndex((step) => step.kind === "cleanup"),
    reconciliationPosition = definition.steps.findIndex((step) => step.kind === "reconciliation");
  assert.equal(ambiguous.status, "ambiguous_cleanup_required"); assert.equal(ambiguous.currentStepPosition, cleanupPosition);
  assert.equal(ambiguous.ambiguityRecorded, true); assert.equal(ambiguous.effectAttemptCount, 0);
  const earlyReconciliation = evidence(definition, ambiguous, reconciliationPosition, "met", 20);
  assert.throws(() => auth.advance(ambiguous, definition, earlyReconciliation, at(20)), errorCode("unsupported_action"));
  const cleanup = evidence(definition, ambiguous, cleanupPosition, "met", 21), cleaned = auth.advance(ambiguous, definition, cleanup, at(21));
  assert.equal(cleaned.status, "ambiguous_reconciliation_required"); assert.equal(cleaned.currentStepPosition, reconciliationPosition);
  const reconciliation = evidence(definition, cleaned, reconciliationPosition, "met", 22), terminal = auth.advance(cleaned, definition, reconciliation, at(22));
  assert.equal(terminal.status, "terminal_ambiguity"); assert.equal(terminal.currentStepPosition, definition.steps.length);
  assert.equal(terminal.authorized || terminal.grantsApproval || terminal.grantsExecutionAuthority, false); auth.close();
});

test("CR10A-OPS-090 never retries uncertain cleanup or reconciliation", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[0]!, auth = authenticator(32),
    effectPosition = definition.steps.findIndex((step) => step.kind === "effect_slot"),
    cleanupPosition = definition.steps.findIndex((step) => step.kind === "cleanup"),
    reconciliationPosition = definition.steps.findIndex((step) => step.kind === "reconciliation"),
    beforeEffect = advanceThrough(auth, definition, start(auth, definition, "cleanup-uncertain"), effectPosition - 1),
    ambiguous = auth.advance(beforeEffect, definition, evidence(definition, beforeEffect, effectPosition, "unknown", 10), at(10)),
    failedCleanup = auth.advance(ambiguous, definition, evidence(definition, ambiguous, cleanupPosition, "failed", 11), at(11));
  assert.equal(failedCleanup.status, "ambiguous_reconciliation_required");
  assert.equal(failedCleanup.currentStepPosition, reconciliationPosition);
  const failedReconciliation = auth.advance(failedCleanup, definition,
    evidence(definition, failedCleanup, reconciliationPosition, "unknown", 12), at(12));
  assert.equal(failedReconciliation.status, "terminal_ambiguity");
  assert.deepEqual(auth.abort(failedReconciliation, definition, at(13)), failedReconciliation); auth.close();
});

test("CR10A-OPS-090 aborts safely before change and forces cleanup after a rehearsed boundary", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[1]!, auth = authenticator(), initial = start(auth, definition, "abort-before"),
    before = auth.abort(initial, definition, at(1));
  assert.equal(before.status, "blocked_before_change"); assert.equal(before.changeBoundaryRehearsed, false);
  const other = start(auth, definition, "abort-after"), effectPosition = definition.steps.findIndex((step) => step.kind === "effect_slot"),
    afterEffect = advanceThrough(auth, definition, other, effectPosition), aborted = auth.abort(afterEffect, definition, at(20));
  assert.equal(aborted.status, "ambiguous_cleanup_required");
  assert.equal(aborted.currentStepPosition, definition.steps.findIndex((step) => step.kind === "cleanup"));
  assert.equal(aborted.ambiguityRecorded, true); assert.equal(aborted.effectAttemptCount, 0);
  const cleanupPosition = definition.steps.findIndex((step) => step.kind === "cleanup"),
    throughCleanup = advanceThrough(auth, definition, start(auth, definition, "abort-after-cleanup"), cleanupPosition),
    afterCleanupAbort = auth.abort(throughCleanup, definition, at(30));
  assert.equal(afterCleanupAbort.status, "ambiguous_reconciliation_required");
  assert.equal(afterCleanupAbort.currentStepPosition, definition.steps.findIndex((step) => step.kind === "reconciliation")); auth.close();
});

test("CR10A-OPS-090 authenticates portable resume state and rejects the wrong key", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[2]!, key = new Uint8Array(32).fill(44), identity = digest("portable-auth"),
    writer = new OperationsRunbookAuthenticatorV1(identity, key, { testOnly: true }), started = start(writer, definition, "portable"),
    progressed = writer.advance(started, definition, evidence(definition, started, 0), at(1));
  writer.close();
  const reader = new OperationsRunbookAuthenticatorV1(identity, key, { testOnly: true });
  assert.deepEqual(reader.verify(clone(progressed)), progressed); reader.close();
  assert.throws(() => reader.verify(progressed), /authenticator closed/);
  const foreign = new OperationsRunbookAuthenticatorV1(identity, new Uint8Array(32).fill(45), { testOnly: true });
  assert.throws(() => foreign.verify(progressed), /authentication failed/); foreign.close();
});

test("CR10A-OPS-090 rejects an ordinarily re-signed but unauthenticated state forgery", () => {
  const definition = buildOperationsRunbookRegistryV1().definitions[3]!, auth = authenticator(), instance = start(auth, definition, "forgery"),
    forged = clone(instance) as unknown as Record<string, unknown>;
  forged.scopeDigest = digest("forged-scope");
  forged.instanceDigest = sha256Digest(Object.fromEntries(Object.entries(forged).filter(([key]) => !["instanceDigest", "stateAuthTag"].includes(key))));
  assert.deepEqual(parseOperationsRunbookInstanceV1(forged).scopeDigest, digest("forged-scope"));
  assert.throws(() => auth.verify(forged), /authentication failed/); auth.close();
});

test("CR10A-OPS-090 rejects extras, accessors, and Proxies without invoking hostile traps", () => {
  const registry = buildOperationsRunbookRegistryV1(), definition = registry.definitions[0]!, auth = authenticator();
  assert.throws(() => parseOperationsRunbookDefinitionV1({ ...definition, credential: "secret" }));
  let accesses = 0; const accessor = { registry, runbookId: definition.runbookId, instanceId: "instance:operations:accessor",
    scopeDigest: digest("accessor-scope"), operationDigest: digest("accessor-operation"), createdAt: at(0), expiresAt: at(600) };
  Object.defineProperty(accessor, "instanceId", { enumerable: true, get() { accesses += 1; return "instance:operations:accessor"; } });
  assert.throws(() => auth.start(accessor)); assert.equal(accesses, 0);
  const proxied = observedProxy({ registry, runbookId: definition.runbookId, instanceId: "instance:operations:proxy",
    scopeDigest: digest("proxy-scope"), operationDigest: digest("proxy-operation"), createdAt: at(0), expiresAt: at(600) }, "throwing");
  assert.throws(() => auth.start(proxied.value)); assert.equal(proxied.trapCount(), 0); auth.close();
  let optionAccesses = 0; const options = {} as { testOnly: true };
  Object.defineProperty(options, "testOnly", { enumerable: true, get() { optionAccesses += 1; return true; } });
  assert.throws(() => new OperationsRunbookAuthenticatorV1(digest("accessor-options"), new Uint8Array(32), options));
  assert.equal(optionAccesses, 0);
  const proxyOptions = observedProxy({ testOnly: true as const }, "throwing");
  assert.throws(() => new OperationsRunbookAuthenticatorV1(digest("proxy-options"), new Uint8Array(32), proxyOptions.value));
  assert.equal(proxyOptions.trapCount(), 0);
});

test("CR10A-OPS-090 rejects hostile or partial binary integrity keys without reading attacker properties", () => {
  for (const mode of ["shared", "buffer_getter", "buffer_data", "byte_length_getter", "byte_length_data", "subclass",
    "prototype_drift", "detached", "backing_constructor_getter", "method_getters", "subview_offset", "subview_prefix"] as const) {
    const attack = binaryViewAttack(mode);
    assert.throws(() => new OperationsRunbookAuthenticatorV1(digest(`hostile-key:${mode}`), attack.value, { testOnly: true }));
    assert.equal(attack.getterCount(), 0, mode);
  }
});

test("CR10A-OPS-090 protected implementation imports no effect-capable client", () => {
  const source = readFileSync(new URL("../src/operations/v1/runbooks.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "node:net", "node:http", "node:https", "node:sqlite",
    "from \"postgres\"", "fetch(", "systemctl", "docker ", "kubectl", "wrangler", "exec(", "spawn("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
