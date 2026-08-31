import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  READY_FRONTIER_ACTIVATION_PACKET_V1,
  READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1,
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  ReadyFrontierContractErrorV1,
  buildReadyFrontierDisposableQualificationRequestV1,
  buildReadyFrontierProductionBoundaryAssessmentV1,
  buildReadyFrontierProductionBoundaryPlanV1,
  buildReadyFrontierProductionCustodyPlanV1,
  parseReadyFrontierActivationPacketV1,
  parseReadyFrontierDisposableQualificationRequestV1,
  projectReadyFrontierDisposableQualificationRequestV1,
  readyFrontierDisposableQualificationOperationCodesV1,
  readyFrontierDisposableQualificationRequirementCodesV1,
  readyFrontierRepositoryFixtureActivationPacketKeyV1,
  runReadyFrontierProductionCustodyFakeQualificationV1,
  type ReadyFrontierActivationPacketV1,
  type ReadyFrontierDisposableQualificationRequestV1,
  type ReadyFrontierProductionCustodyPlanV1,
  type ReadyFrontierProductionCustodyReportV1,
} from "../src/ready-frontier/v1/index.ts";
import { hmacSha256Tag, sha256Digest } from "../src/security/index.ts";
import { wipeHostUint8ArrayV1 } from "../src/security/host-value.ts";

const errorCode = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function activationPacketFixture(key: Uint8Array): ReadyFrontierActivationPacketV1 {
  const unsigned = {
    schema: READY_FRONTIER_ACTIVATION_PACKET_V1,
    packetId: "frontier.activation-packet.auto080.0001",
    tenantId: "tenant.owner",
    workspaceId: "workspace.control-room",
    simulationRunId: "frontier.no-relay-run.auto080.1",
    simulationRunDigest: sha256Digest({ fixture: "auto080-simulation-run" }),
    acceptedAuto030Commit: "adf0804a52a13d544192afc90506c3e989254ffd" as const,
    acceptedAuto030ReviewSha256:
      "sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2" as const,
    requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    state: "blocked_pending_production_proof" as const,
    createdAt: "2026-08-30T20:00:00.000Z",
    repositorySimulationOnly: true as const,
    productionOwnerApprovalPresent: false as const,
    productionPolicyEnrolled: false as const,
    productionConsumerQualified: false as const,
    productionDatabaseQualified: false as const,
    canActivateItself: false as const,
    permitsProtectedMaterial: false as const,
    permitsNetwork: false as const,
    permitsGitHubMutation: false as const,
    permitsAgentOrProviderContact: false as const,
    permitsDispatchOrExecution: false as const,
    permitsExternalEffects: false as const,
  };
  const packetDigest = sha256Digest(unsigned);
  return parseReadyFrontierActivationPacketV1({
    ...unsigned,
    packetDigest,
    packetAuthTag: hmacSha256Tag(key, {
      packetId: unsigned.packetId,
      simulationRunDigest: unsigned.simulationRunDigest,
      packetDigest,
    }),
  }, key);
}

interface Fixture {
  activationKey: Uint8Array;
  qualificationKey: Uint8Array;
  requestKey: Uint8Array;
  plan: ReadyFrontierProductionCustodyPlanV1;
  report: ReadyFrontierProductionCustodyReportV1;
  request: ReadyFrontierDisposableQualificationRequestV1;
}
function fixture(): Fixture {
  const activationKey = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  const qualificationKey = new Uint8Array(32).fill(70);
  const requestKey = new Uint8Array(32).fill(80);
  const packet = activationPacketFixture(activationKey);
  const boundaryPlan = buildReadyFrontierProductionBoundaryPlanV1({
    planId: "frontier.production-boundary.auto080.0001",
    activationPacket: packet,
    plannedAt: "2026-08-30T20:01:00.000Z",
    expiresAt: "2026-08-30T21:00:00.000Z",
  }, activationKey);
  const assessment = buildReadyFrontierProductionBoundaryAssessmentV1({
    assessmentId: "frontier.production-assessment.auto080.0001",
    plan: boundaryPlan,
    assessedAt: "2026-08-30T20:02:00.000Z",
  }, activationKey);
  const plan = buildReadyFrontierProductionCustodyPlanV1({
    planId: "frontier.production-custody.auto080.0001",
    assessment,
    plannedAt: "2026-08-30T20:03:00.000Z",
    expiresAt: "2026-08-30T20:59:00.000Z",
  }, activationKey, qualificationKey);
  const report = runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: "frontier.production-custody-run.auto080.0001",
    plan,
    startedAt: "2026-08-30T20:04:00.000Z",
    completedAt: "2026-08-30T20:05:00.000Z",
  }, activationKey, qualificationKey);
  const request = buildReadyFrontierDisposableQualificationRequestV1({
    requestId: "frontier.disposable-qualification.auto080.0001",
    sourceCustodyPlan: plan,
    sourceCustodyReport: report,
    requestedAt: "2026-08-30T20:06:00.000Z",
    expiresAt: "2026-08-30T20:58:00.000Z",
  }, activationKey, qualificationKey, requestKey);
  return { activationKey, qualificationKey, requestKey, plan, report, request };
}

test("CR11B-AUTO-080 binds the independently accepted AUTO-070 fake before requesting any effect", () => {
  const f = fixture();
  assert.equal(f.request.sourceCustodyPlanDigest, f.plan.planDigest);
  assert.equal(f.request.sourceCustodyReportDigest, f.report.reportDigest);
  assert.equal(f.request.acceptedAuto070Commit, READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1);
  assert.equal(f.request.acceptedAuto070ReviewSha256, READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1);
  assert.equal(f.request.requestedOperations.length, readyFrontierDisposableQualificationOperationCodesV1.length);
  assert.equal(f.request.blockingRequirementCodes.length,
    readyFrontierDisposableQualificationRequirementCodesV1.length);
  assert.equal(f.request.maxProviderCallsRequested,
    READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1);
  assert.equal(f.request.maxDurationSecondsRequested,
    READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1);
  assert.equal(f.request.state, "blocked_pending_owner_authorization_and_resources");
  assert.equal(f.request.liveQualificationAuthorized, false);
  assert.ok(Object.isFrozen(f.request));
  assert.ok(Object.isFrozen(f.request.sourceCustodyPlan));
  assert.ok(Object.isFrozen(f.request.sourceCustodyReport));
});

test("CR11B-AUTO-080 request contains no owner authority, provider selection, protected reference, or effect permission", () => {
  const request = fixture().request;
  assert.equal(request.packetKind, "controlled_effect_request_not_authority");
  assert.equal(request.providerSelected, false);
  assert.equal(request.disposableResourcesAssigned, false);
  assert.equal(request.protectedReferencesPresent, false);
  assert.equal(request.ownerAuthorizationPresent, false);
  assert.equal(request.ownerSignaturePresent, false);
  assert.equal(request.networkAuthorized, false);
  assert.equal(request.processStartAuthorized, false);
  assert.equal(request.databaseContactAuthorized, false);
  assert.equal(request.cleanupAuthorized, false);
  assert.equal(request.grantsExternalEffects, false);
  assert.equal(request.rawEvidenceRetentionAllowed, false);
  assert.equal(request.productionDataAllowed, false);
  assert.equal(request.publicEndpointAllowed, false);
});

test("CR11B-AUTO-080 exposes a bounded sanitized projection with every action disabled", () => {
  const f = fixture();
  const projection = projectReadyFrontierDisposableQualificationRequestV1(
    f.request, f.activationKey, f.qualificationKey, f.requestKey);
  assert.equal(projection.requestedOperations.length, 7);
  assert.equal(projection.blockingRequirementCodes.length, 10);
  assert.equal(projection.cleanupRequired, true);
  assert.equal(projection.canSelectProvider, false);
  assert.equal(projection.canResolveProtectedReferences, false);
  assert.equal(projection.canContactNetwork, false);
  assert.equal(projection.canStartProcesses, false);
  assert.equal(projection.canContactDatabase, false);
  assert.equal(projection.canRunLiveQualification, false);
  assert.equal(projection.canCleanupResources, false);
  assert.equal(projection.canActivateProduction, false);
  assert.equal(projection.canDispatchOrExecute, false);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /AuthTag|protectedAccessMode|evidenceDigest/);
  assert.doesNotMatch(serialized, /"sourceCustody(?:Plan|Report)":/);
  assert.ok(Object.isFrozen(projection));
});

test("CR11B-AUTO-080 refuses a failed fake qualification as the source of a controlled-effect request", () => {
  const f = fixture();
  const failed = runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: "frontier.production-custody-run.auto080.failed",
    plan: f.plan,
    startedAt: "2026-08-30T20:06:00.000Z",
    completedAt: "2026-08-30T20:07:00.000Z",
    injectedFault: "duplicate_claim",
  }, f.activationKey, f.qualificationKey);
  assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
    requestId: "frontier.disposable-qualification.auto080.failed",
    sourceCustodyPlan: f.plan,
    sourceCustodyReport: failed,
    requestedAt: "2026-08-30T20:08:00.000Z",
    expiresAt: "2026-08-30T20:58:00.000Z",
  }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("policy_denied"));
});

test("CR11B-AUTO-080 rejects wrong keys, source substitution, and request re-signing", () => {
  const f = fixture();
  assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
    f.request, f.activationKey, f.qualificationKey, new Uint8Array(32).fill(81)),
  errorCode("digest_mismatch"));

  const changed = clone(f.request);
  changed.sourceCustodyPlan.planId = "frontier.production-custody.auto080.changed";
  const unsigned = without(without(changed as unknown as Record<string, unknown>, "requestAuthTag"), "requestDigest");
  changed.requestDigest = sha256Digest(unsigned);
  changed.requestAuthTag = hmacSha256Tag(f.requestKey, {
    requestId: changed.requestId,
    requestDigest: changed.requestDigest,
    tenantId: changed.tenantId,
    workspaceId: changed.workspaceId,
    sourceCustodyPlanDigest: changed.sourceCustodyPlanDigest,
    sourceCustodyReportDigest: changed.sourceCustodyReportDigest,
    requestedAt: changed.requestedAt,
    expiresAt: changed.expiresAt,
  });
  assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
    changed, f.activationKey, f.qualificationKey, f.requestKey), errorCode("digest_mismatch"));
});

test("CR11B-AUTO-080 enforces source, request, expiry, and accepted-plan chronology", () => {
  const f = fixture();
  assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
    requestId: "frontier.disposable-qualification.auto080.before-report",
    sourceCustodyPlan: f.plan,
    sourceCustodyReport: f.report,
    requestedAt: "2026-08-30T20:04:59.000Z",
    expiresAt: "2026-08-30T20:58:00.000Z",
  }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("policy_denied"));
  assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
    requestId: "frontier.disposable-qualification.auto080.equal-expiry",
    sourceCustodyPlan: f.plan,
    sourceCustodyReport: f.report,
    requestedAt: "2026-08-30T20:06:00.000Z",
    expiresAt: "2026-08-30T20:06:00.000Z",
  }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("policy_denied"));
  assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
    requestId: "frontier.disposable-qualification.auto080.after-plan",
    sourceCustodyPlan: f.plan,
    sourceCustodyReport: f.report,
    requestedAt: "2026-08-30T20:06:00.000Z",
    expiresAt: "2026-08-30T20:59:00.001Z",
  }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("policy_denied"));
});

test("CR11B-AUTO-080 exact boundaries reject accessors and Proxies without caller behavior", () => {
  const f = fixture();
  let accessorCalls = 0;
  const accessor = {
    requestId: "frontier.disposable-qualification.auto080.accessor",
    sourceCustodyPlan: f.plan,
    sourceCustodyReport: f.report,
    requestedAt: "2026-08-30T20:06:00.000Z",
    get expiresAt() {
      accessorCalls += 1;
      return "2026-08-30T20:58:00.000Z";
    },
  };
  assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1(
    accessor, f.activationKey, f.qualificationKey, f.requestKey), errorCode("invalid_input"));
  assert.equal(accessorCalls, 0);

  let proxyCalls = 0;
  const proxied = new Proxy({
    requestId: "frontier.disposable-qualification.auto080.proxy",
    sourceCustodyPlan: f.plan,
    sourceCustodyReport: f.report,
    requestedAt: "2026-08-30T20:06:00.000Z",
    expiresAt: "2026-08-30T20:58:00.000Z",
  }, {
    get(target, property, receiver) {
      proxyCalls += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) {
      proxyCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1(
    proxied, f.activationKey, f.qualificationKey, f.requestKey), errorCode("invalid_input"));
  assert.equal(proxyCalls, 0);
});

test("CR11B-AUTO-080 key erasure never dispatches through ambient fill before or after helper load", async () => {
  const f = fixture();
  const defineProperty = Object.defineProperty;
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const descriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, "fill")!;
  let hostileCalls = 0;
  let retainedReceiver: Uint8Array | undefined;
  const retain = (value: Uint8Array) => { retainedReceiver = value; };
  const cleanupProbe = new Uint8Array([9, 8, 7, 6]);
  const preloadedProbe = new Uint8Array([5, 4, 3, 2]);
  try {
    defineProperty(typedArrayPrototype, "fill", {
      ...descriptor,
      value(this: Uint8Array) {
        hostileCalls += 1;
        retain(this);
        return this;
      },
    });
    assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
      f.request, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
    assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
      requestId: "frontier.disposable-qualification.auto080.fill-drift",
      sourceCustodyPlan: f.plan,
      sourceCustodyReport: f.report,
      requestedAt: "2026-08-30T20:06:00.000Z",
      expiresAt: "2026-08-30T20:58:00.000Z",
    }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
    assert.equal(hostileCalls, 0);
    assert.equal(retainedReceiver, undefined);
    assert.equal(wipeHostUint8ArrayV1(cleanupProbe), true);
    assert.deepEqual([...cleanupProbe], [0, 0, 0, 0]);
    const freshModulePath = "../src/security/host-value.ts?auto080-preloaded-fill";
    const freshHostValue = await import(freshModulePath) as typeof import("../src/security/host-value.ts");
    assert.equal(freshHostValue.wipeHostUint8ArrayV1(preloadedProbe), true);
    assert.deepEqual([...preloadedProbe], [0, 0, 0, 0]);
    assert.equal(hostileCalls, 0);
  } finally {
    defineProperty(typedArrayPrototype, "fill", descriptor);
  }
  const replay = parseReadyFrontierDisposableQualificationRequestV1(
    f.request, f.activationKey, f.qualificationKey, f.requestKey);
  assert.deepEqual(replay, f.request);
  const projection = projectReadyFrontierDisposableQualificationRequestV1(
    replay, f.activationKey, f.qualificationKey, f.requestKey);
  assert.equal(projection.canRunLiveQualification, false);
  const source = readFileSync(new URL(
    "../src/ready-frontier/v1/disposable-qualification.ts", import.meta.url), "utf8");
  const hostValueSource = readFileSync(new URL("../src/security/host-value.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /requestKey\.fill\s*\(/);
  assert.equal((source.match(/wipeKeyV1\(requestKey\)/g) ?? []).length, 2);
  assert.doesNotMatch(hostValueSource, /uint8ArrayFill|\.fill\s*\(\s*0\s*\)/);
});

test("CR11B-AUTO-080 HMAC never exposes private key copies to mutable binary metadata", () => {
  const f = fixture();
  const defineProperty = Object.defineProperty;
  const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array")!;
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const byteLengthDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!;
  const tampered = clone(f.request);
  tampered.requestAuthTag = tampered.requestAuthTag.endsWith("0")
    ? `${tampered.requestAuthTag.slice(0, -1)}1`
    : `${tampered.requestAuthTag.slice(0, -1)}0`;
  let hostileCalls = 0;
  let retainedKey: unknown;
  const retain = (value: unknown) => { retainedKey = value; };
  const hmacMaterial = { auto080: "host-verified-key" };
  const expectedHmac = hmacSha256Tag(f.requestKey, hmacMaterial);
  const verifyGuardedOperations = () => {
    assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
      f.request, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
    assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
      requestId: "frontier.disposable-qualification.auto080.binary-runtime-drift",
      sourceCustodyPlan: f.plan,
      sourceCustodyReport: f.report,
      requestedAt: "2026-08-30T20:06:00.000Z",
      expiresAt: "2026-08-30T20:58:00.000Z",
    }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
    assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
      tampered, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
  };

  const hostileConstructor = function HostileUint8Array() { return undefined; };
  defineProperty(hostileConstructor, Symbol.hasInstance, { value(value: unknown) {
    hostileCalls += 1;
    retain(value);
    return true;
  } });
  try {
    defineProperty(globalThis, "Uint8Array", { ...globalDescriptor, value: hostileConstructor });
    assert.equal(hmacSha256Tag(f.requestKey, hmacMaterial), expectedHmac);
    verifyGuardedOperations();
    assert.equal(hostileCalls, 0);
    assert.equal(retainedKey, undefined);
  } finally {
    defineProperty(globalThis, "Uint8Array", globalDescriptor);
  }

  try {
    defineProperty(typedArrayPrototype, "byteLength", {
      ...byteLengthDescriptor,
      get(this: unknown) {
        hostileCalls += 1;
        retain(this);
        return 32;
      },
    });
    assert.equal(hmacSha256Tag(f.requestKey, hmacMaterial), expectedHmac);
    verifyGuardedOperations();
    assert.equal(hostileCalls, 0);
    assert.equal(retainedKey, undefined);
  } finally {
    defineProperty(typedArrayPrototype, "byteLength", byteLengthDescriptor);
  }

  const replay = parseReadyFrontierDisposableQualificationRequestV1(
    f.request, f.activationKey, f.qualificationKey, f.requestKey);
  assert.deepEqual(replay, f.request);
  assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
    tampered, f.activationKey, f.qualificationKey, f.requestKey), errorCode("digest_mismatch"));
  const projection = projectReadyFrontierDisposableQualificationRequestV1(
    replay, f.activationKey, f.qualificationKey, f.requestKey);
  assert.equal(projection.canRunLiveQualification, false);
  const digestSource = readFileSync(new URL("../src/security/digest.ts", import.meta.url), "utf8");
  assert.doesNotMatch(digestSource, /key\s+instanceof\s+Uint8Array|key\.byteLength/);
});

test("CR11B-AUTO-080 HMAC finalization never dispatches through mutable keyed-object methods", () => {
  const f = fixture();
  const defineProperty = Object.defineProperty;
  const probe = createHmac("sha256", new Uint8Array(32));
  const hmacPrototype = Object.getPrototypeOf(probe) as object;
  probe.digest("hex");
  const updateDescriptor = Object.getOwnPropertyDescriptor(hmacPrototype, "update")!;
  const digestDescriptor = Object.getOwnPropertyDescriptor(hmacPrototype, "digest")!;
  const tampered = clone(f.request);
  tampered.requestAuthTag = tampered.requestAuthTag.endsWith("0")
    ? `${tampered.requestAuthTag.slice(0, -1)}1`
    : `${tampered.requestAuthTag.slice(0, -1)}0`;
  let hostileCalls = 0;
  let retainedCapability: unknown;
  const retain = (value: unknown) => { retainedCapability = value; };
  const verifyGuardedOperations = () => {
    assert.throws(() => hmacSha256Tag(f.requestKey, { auto080: "keyed-object-drift" }), /HMAC runtime invalid/);
    assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
      f.request, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
    assert.throws(() => buildReadyFrontierDisposableQualificationRequestV1({
      requestId: "frontier.disposable-qualification.auto080.hmac-runtime-drift",
      sourceCustodyPlan: f.plan,
      sourceCustodyReport: f.report,
      requestedAt: "2026-08-30T20:06:00.000Z",
      expiresAt: "2026-08-30T20:58:00.000Z",
    }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
    assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
      tampered, f.activationKey, f.qualificationKey, f.requestKey), errorCode("integrity_failed"));
  };
  const attacks = [
    { property: "update", descriptor: updateDescriptor, kind: "accessor" },
    { property: "update", descriptor: updateDescriptor, kind: "method" },
    { property: "digest", descriptor: digestDescriptor, kind: "accessor" },
    { property: "digest", descriptor: digestDescriptor, kind: "method" },
  ] as const;
  for (const attack of attacks) {
    try {
      if (attack.kind === "accessor") {
        defineProperty(hmacPrototype, attack.property, {
          configurable: true,
          enumerable: attack.descriptor.enumerable,
          get(this: unknown) {
            hostileCalls += 1;
            retain(this);
            throw new Error("hostile HMAC accessor executed");
          },
        });
      } else {
        defineProperty(hmacPrototype, attack.property, {
          ...attack.descriptor,
          value(this: unknown) {
            hostileCalls += 1;
            retain(this);
            throw new Error("hostile HMAC method executed");
          },
        });
      }
      verifyGuardedOperations();
      assert.equal(hostileCalls, 0);
      assert.equal(retainedCapability, undefined);
    } finally {
      defineProperty(hmacPrototype, attack.property, attack.descriptor);
    }
  }
  const replay = parseReadyFrontierDisposableQualificationRequestV1(
    f.request, f.activationKey, f.qualificationKey, f.requestKey);
  assert.deepEqual(replay, f.request);
  assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1(
    tampered, f.activationKey, f.qualificationKey, f.requestKey), errorCode("digest_mismatch"));
  const projection = projectReadyFrontierDisposableQualificationRequestV1(
    replay, f.activationKey, f.qualificationKey, f.requestKey);
  assert.equal(projection.canRunLiveQualification, false);
  const digestSource = readFileSync(new URL("../src/security/digest.ts", import.meta.url), "utf8");
  assert.doesNotMatch(digestSource, /createHmac\([^\n]+\)\.update|\bhmac\.(?:update|digest)\s*\(/);
});

test("CR11B-AUTO-080 rejects added credential and provider material instead of retaining it", () => {
  const f = fixture();
  assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1({
    ...f.request,
    databaseUrl: "postgresql://forbidden.invalid/db",
  }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("invalid_input"));
  assert.throws(() => parseReadyFrontierDisposableQualificationRequestV1({
    ...f.request,
    providerResourceId: "forbidden-resource",
  }, f.activationKey, f.qualificationKey, f.requestKey), errorCode("invalid_input"));
});

test("CR11B-AUTO-080 source has no provider, database, process, network, credential, or execution client", () => {
  const source = readFileSync(new URL(
    "../src/ready-frontier/v1/disposable-qualification.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']postgres["']/);
  assert.doesNotMatch(source, /node:child_process|node:net|node:http|node:https|node:tls|node:dns/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bspawn\s*\(|\bexecFile\s*\(|\bconnect\s*\(/);
  assert.doesNotMatch(source, /export function (run|execute|authorize|provision|destroy)/);
});
