import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTeamContractErrorV1,
  buildHermesBotModeFixtureV1,
  buildUnknownHermesBotModeFixtureV1,
  evaluateHermesBotModeCompatibilityV1,
  hermesBotModeCompatibilityEvidenceFixtureV1,
  hermesBotModeManifestV1,
  hermesBotModeReadAdapterV1,
  normalizeHermesBotModeObservationV1,
  parseHermesBotModeProjectionV1,
  runHermesBotModeConformanceV1,
  type HermesBotModeObservationV1,
  type HermesBotModeReadAdapterV1,
  type HermesBotModeSafeProjectionV1,
} from "../src/agent-team/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

function clone(projectId = "project.test.hermes-bot"): HermesBotModeObservationV1 {
  return structuredClone(buildHermesBotModeFixtureV1(projectId));
}

function expectCode(action: () => unknown, code: AgentTeamContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof AgentTeamContractErrorV1 && error.safeCode === code);
}

function rehashProjection(value: HermesBotModeSafeProjectionV1): HermesBotModeSafeProjectionV1 {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.projectionDigest;
  return { ...value, projectionDigest: sha256Digest(unsigned) };
}

function rehashWorkspaceProjection(value: HermesBotModeSafeProjectionV1): HermesBotModeSafeProjectionV1 {
  assert.ok(value.workspace);
  const unsignedWorkspace = { ...value.workspace } as Record<string, unknown>;
  delete unsignedWorkspace.workspaceDigest;
  value.workspace.workspaceDigest = sha256Digest(unsignedWorkspace);
  return rehashProjection(value);
}

test("CR11A TEAM-040 freezes the exact read-only pin and capability ceiling", () => {
  assert.deepEqual({
    adapterId: hermesBotModeManifestV1.adapterId,
    adapterVersion: hermesBotModeManifestV1.adapterVersion,
    version: hermesBotModeManifestV1.hermesPackageVersion,
    revision: hermesBotModeManifestV1.hermesRevision,
    sourceMode: hermesBotModeManifestV1.sourceMode,
    reads: hermesBotModeManifestV1.supportedReads,
    writes: hermesBotModeManifestV1.supportedWrites,
    native: hermesBotModeManifestV1.nativeQualified,
  }, {
    adapterId: "adapter.hermes.bot-mode.read.v1",
    adapterVersion: "1.0.0",
    version: "0.20.6",
    revision: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5",
    sourceMode: "injected_only",
    reads: ["profiles", "rooms", "routines", "safe_summary_events"],
    writes: [],
    native: false,
  });
  assert.match(hermesBotModeManifestV1.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(hermesBotModeReadAdapterV1).sort(), ["evaluateCompatibility", "manifest", "normalizeObservation"]);
  for (const forbidden of ["connect", "readNativeProfile", "start", "send", "schedule", "approve", "dispatch", "execute", "write"]) {
    assert.equal(forbidden in hermesBotModeReadAdapterV1, false);
  }
  assert.equal(hermesBotModeManifestV1.researchContextOnly.includes("hermes_bot_mode_repository"), true);
  assert.equal(hermesBotModeManifestV1.compatibilityAuthority, "accepted_hermes_agent_revision");
});

test("CR11A TEAM-040 compatibility accepts only the exact ordered read ceiling", () => {
  assert.deepEqual(evaluateHermesBotModeCompatibilityV1(hermesBotModeCompatibilityEvidenceFixtureV1), { compatible: true, reasons: [] });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, hermesPackageVersion: "0.20.7" }, "version_drift"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, hermesRevision: "a".repeat(40) }, "revision_drift"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, observationContract: "drift" }, "contract_drift"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, sourceMode: "native" }, "source_mode_drift"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, readCapabilities: ["rooms", "profiles", "routines", "safe_summary_events"] }, "read_capability_drift"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, writeCapabilities: ["send"] }, "write_capability_present"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, nativeQualified: true }, "native_qualification_claimed"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, sharesProviderAccess: true }, "provider_sharing_claimed"],
    [{ ...hermesBotModeCompatibilityEvidenceFixtureV1, fullMessageReads: true }, "full_message_read_claimed"],
  ];
  for (const [evidence, reason] of cases) {
    const decision = evaluateHermesBotModeCompatibilityV1(evidence);
    assert.equal(decision.compatible, false);
    assert.equal(decision.reasons.includes(reason as never), true);
  }
});

test("CR11A TEAM-040 normalizes profiles, presence, routines, rooms, and events into the existing Team view", () => {
  const projection = normalizeHermesBotModeObservationV1(clone());
  assert.equal(Object.isFrozen(projection), true);
  assert.deepEqual(parseHermesBotModeProjectionV1(projection), projection);
  assert.equal(projection.workspace?.agents.length, 2);
  assert.equal(projection.workspace?.routines.length, 2);
  assert.equal(projection.workspace?.rooms.length, 1);
  assert.equal(projection.workspace?.rooms[0]?.messages.length, 3);
  assert.equal(projection.workspace?.activeAgentCount, 1);
  const working = projection.workspace?.agents.find((agent) => agent.status === "working");
  const stale = projection.workspace?.agents.find((agent) => agent.status === "stale");
  assert.deepEqual({ basis: working?.presenceBasis, work: working?.currentWorkItemId, kind: working?.kind }, {
    basis: "authenticated_heartbeat", work: "work.cr11a.team-040", kind: "hermes",
  });
  assert.deepEqual(projection.identityBindings.find((binding) => binding.agentId === working?.agentId)?.workingEvidence, {
    basis: "authenticated_heartbeat",
    evidenceDigest: sha256Digest({ fixture: "cr11a-team-040", kind: "presence", id: "architect-heartbeat" }),
    observedAt: "2026-08-30T14:59:45.000Z",
    validUntil: "2026-08-30T15:04:45.000Z",
    currentWorkItemId: "work.cr11a.team-040",
    currentWorkSummary: "Normalizing an injected read-only Bot Mode fixture.",
  });
  assert.equal(stale?.currentWorkItemId, undefined);
  assert.match(working?.handle ?? "", /^marvin@/);
  assert.equal(projection.workspace?.routines[1]?.state, "blocked");
  assert.equal(projection.workspace?.rooms[0]?.state, "needs_owner");
  assert.deepEqual({ work: projection.createsWorkItems, dispatch: projection.dispatchesWork, approval: projection.grantsApproval,
    lease: projection.grantsLeaseAuthority, command: projection.grantsCommandAuthority, execution: projection.grantsExecutionAuthority,
    schedules: projection.createsSchedules, messages: projection.retainsFullMessages, provider: projection.sharesProviderAccess },
  { work: false, dispatch: false, approval: false, lease: false, command: false, execution: false,
    schedules: false, messages: false, provider: false });
});

test("CR11A TEAM-040 represents unknown or absent collections without inventing an agent", () => {
  const projection = normalizeHermesBotModeObservationV1(buildUnknownHermesBotModeFixtureV1());
  assert.equal(projection.workspace, null);
  assert.deepEqual(projection.identityBindings, []);
  assert.deepEqual(projection.collectionTruth, { profiles: "unknown", routines: "absent", rooms: "unknown", events: "unknown" });
  const contradiction = buildUnknownHermesBotModeFixtureV1();
  contradiction.collectionTruth.profiles = "observed";
  expectCode(() => normalizeHermesBotModeObservationV1(contradiction), "invalid_input");
});

test("CR11A TEAM-040 never turns Bot activity alone into working presence", () => {
  const noEvidence = clone();
  noEvidence.presenceEvidence = [];
  const available = normalizeHermesBotModeObservationV1(noEvidence).workspace?.agents[0];
  assert.deepEqual({ status: available?.status, basis: available?.presenceBasis, work: available?.currentWorkItemId }, {
    status: "available", basis: "last_known", work: undefined,
  });
  const expired = clone();
  expired.evaluatedAt = "2026-08-30T15:05:00.000Z";
  const stale = normalizeHermesBotModeObservationV1(expired).workspace?.agents[0];
  assert.deepEqual({ status: stale?.status, basis: stale?.presenceBasis, work: stale?.currentWorkItemId }, {
    status: "stale", basis: "last_known", work: undefined,
  });
  const overlong = clone();
  overlong.presenceEvidence[0]!.validUntil = "2026-08-30T15:04:46.000Z";
  expectCode(() => normalizeHermesBotModeObservationV1(overlong), "presence_unproved");
});

test("CR11A TEAM-040 rejects scope drift and unknown identity bindings", () => {
  const profileScope = clone(); profileScope.profiles[0]!.projectId = "project.foreign";
  expectCode(() => normalizeHermesBotModeObservationV1(profileScope), "scope_mismatch");
  const presenceScope = clone(); presenceScope.presenceEvidence[0]!.projectId = "project.foreign";
  expectCode(() => normalizeHermesBotModeObservationV1(presenceScope), "scope_mismatch");
  const routineIdentity = clone(); routineIdentity.routines[0]!.profileKeyDigest = sha256Digest("unknown-profile");
  expectCode(() => normalizeHermesBotModeObservationV1(routineIdentity), "unknown_agent");
  const roomIdentity = clone(); roomIdentity.rooms[0]!.memberProfileKeyDigests[0] = sha256Digest("unknown-member");
  expectCode(() => normalizeHermesBotModeObservationV1(roomIdentity), "unknown_agent");
});

test("CR11A TEAM-040 rejects full-message fields, authority claims, secrets, accessors, and Proxies", () => {
  const fullMessage = clone();
  (fullMessage.rooms[0]!.events[0] as unknown as Record<string, unknown>).fullMessage = "not retained";
  expectCode(() => normalizeHermesBotModeObservationV1(fullMessage), "invalid_input");
  const authority = clone();
  (authority.rooms[0] as unknown as Record<string, unknown>).dispatchesWork = true;
  expectCode(() => normalizeHermesBotModeObservationV1(authority), "invalid_input");
  const secret = clone(); secret.rooms[0]!.events[0]!.safeSummary = "api_key=unsafe-value-123";
  expectCode(() => normalizeHermesBotModeObservationV1(secret), "redaction_rejected");
  let getterCalls = 0;
  const accessor = clone() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "projectId", { enumerable: true, get() { getterCalls += 1; return "project.test.hermes-bot"; } });
  expectCode(() => normalizeHermesBotModeObservationV1(accessor), "invalid_input");
  assert.equal(getterCalls, 0);
  const proxied = observedProxy(clone(), "transparent");
  expectCode(() => normalizeHermesBotModeObservationV1(proxied.value), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
});

test("CR11A TEAM-040 preserves room ceilings and rejects sequence and pair-loop overflow", () => {
  const sequence = clone(); sequence.rooms[0]!.events[1]!.sequence = 7;
  expectCode(() => normalizeHermesBotModeObservationV1(sequence), "room_budget_exceeded");
  const chronology = clone(); chronology.rooms[0]!.events[2]!.occurredAt = "2026-08-30T15:00:01.000Z";
  expectCode(() => normalizeHermesBotModeObservationV1(chronology), "room_budget_exceeded");
  const duration = clone(); duration.rooms[0]!.events[0]!.occurredAt = "2026-08-30T14:00:00.000Z";
  expectCode(() => normalizeHermesBotModeObservationV1(duration), "room_budget_exceeded");
  const roundRegression = clone(); roundRegression.rooms[0]!.events[0]!.round = 2;
  expectCode(() => normalizeHermesBotModeObservationV1(roundRegression), "room_budget_exceeded");
  const overCeiling = clone();
  (overCeiling.resourceCeilings as unknown as Record<string, unknown>).maxRoomEvents = 11;
  expectCode(() => normalizeHermesBotModeObservationV1(overCeiling), "invalid_input");
  const loop = clone();
  const first = loop.rooms[0]!.events[0]!;
  const secondProfile = loop.profiles[1]!.profileKeyDigest;
  loop.rooms[0]!.currentRound = 3;
  loop.rooms[0]!.events = Array.from({ length: 5 }, (_, index) => ({
    ...first,
    eventKeyDigest: sha256Digest({ loop: index }),
    sequence: index + 1,
    round: index < 2 ? 1 : index < 4 ? 2 : 3,
    mentionedProfileKeyDigests: [secondProfile],
  }));
  expectCode(() => normalizeHermesBotModeObservationV1(loop), "room_budget_exceeded");
});

test("CR11A TEAM-040 identity and projection digests are stable and tamper-evident", () => {
  const first = normalizeHermesBotModeObservationV1(clone());
  const replay = normalizeHermesBotModeObservationV1(clone());
  assert.deepEqual(replay, first);
  const changed = clone(); changed.profiles[0]!.deviceKeyDigest = sha256Digest("different-device");
  const changedProjection = normalizeHermesBotModeObservationV1(changed);
  assert.notEqual(changedProjection.identityBindings[0]?.agentId, first.identityBindings[0]?.agentId);
  assert.notEqual(changedProjection.projectionDigest, first.projectionDigest);
  const tampered = structuredClone(first);
  tampered.workspace!.agents[0]!.displayName = "Changed after binding";
  expectCode(() => parseHermesBotModeProjectionV1(rehashProjection(tampered)), "digest_mismatch");
  const substitutedBinding = structuredClone(first);
  substitutedBinding.identityBindings[0]!.deviceKeyDigest = sha256Digest("substituted-device");
  expectCode(() => parseHermesBotModeProjectionV1(rehashProjection(substitutedBinding)), "digest_mismatch");
  const downgradedPresence = structuredClone(first);
  const downgradedAgent = downgradedPresence.workspace!.agents[0]!;
  downgradedAgent.status = "available";
  downgradedAgent.presenceBasis = "last_known";
  delete downgradedAgent.currentWorkItemId;
  delete downgradedAgent.currentWorkSummary;
  downgradedPresence.workspace!.activeAgentCount = 0;
  expectCode(() => parseHermesBotModeProjectionV1(rehashWorkspaceProjection(downgradedPresence)), "presence_unproved");
  const substitutedKind = structuredClone(first);
  substitutedKind.workspace!.agents[0]!.kind = "codex";
  expectCode(() => parseHermesBotModeProjectionV1(rehashWorkspaceProjection(substitutedKind)), "digest_mismatch");
  const routineCount = structuredClone(first);
  routineCount.workspace!.agents[0]!.routineCount = 7;
  expectCode(() => parseHermesBotModeProjectionV1(rehashWorkspaceProjection(routineCount)), "digest_mismatch");
});

test("CR11A TEAM-040 conformance accepts sanitized observed and unknown fixtures", () => {
  const result = runHermesBotModeConformanceV1({
    adapter: hermesBotModeReadAdapterV1,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1,
    fixtures: [
      { name: "sanitized team observation", observation: clone(), expectedProfiles: 2, expectedRooms: 1, expectedRoutines: 2, expectedWorking: 1 },
      { name: "unknown empty observation", observation: buildUnknownHermesBotModeFixtureV1(), expectedProfiles: 0, expectedRooms: 0, expectedRoutines: 0, expectedWorking: 0 },
    ],
  });
  assert.deepEqual(result, {
    adapterId: "adapter.hermes.bot-mode.read.v1",
    compatible: true,
    fixtureCount: 2,
    normalizedProfiles: 2,
    normalizedRooms: 1,
    normalizedRoutines: 2,
    checks: { exactPin: true, injectedOnly: true, safeProjection: true, resourceCeilings: true, negativeAuthority: true },
    reasons: [],
  });
});

test("CR11A TEAM-040 conformance rejects drift, hidden methods, and normalization substitution", () => {
  const drift = runHermesBotModeConformanceV1({ adapter: hermesBotModeReadAdapterV1,
    compatibilityEvidence: { ...hermesBotModeCompatibilityEvidenceFixtureV1, hermesRevision: "a".repeat(40) }, fixtures: [] });
  assert.equal(drift.reasons[0], "compatibility_rejected");
  const hidden = Object.freeze({ ...hermesBotModeReadAdapterV1, execute: () => "effect" }) as unknown as HermesBotModeReadAdapterV1;
  assert.equal(runHermesBotModeConformanceV1({ adapter: hidden,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1, fixtures: [] }).reasons[0], "adapter_shape_invalid");
  const substituted = Object.freeze({
    ...hermesBotModeReadAdapterV1,
    normalizeObservation: () => ({ dispatchesWork: true }),
  }) as unknown as HermesBotModeReadAdapterV1;
  assert.equal(runHermesBotModeConformanceV1({ adapter: substituted,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1,
    fixtures: [{ name: "substituted", observation: clone(), expectedProfiles: 2, expectedRooms: 1, expectedRoutines: 2, expectedWorking: 1 }] }).reasons[0],
  "normalization_failed");
});

test("CR11A TEAM-040 conformance rejects hostile fixture and adapter containers without executing behavior", () => {
  let getterCalls = 0;
  const accessorFixture = {
    name: "accessor fixture",
    observation: clone(),
    expectedProfiles: 2,
    expectedRooms: 1,
    expectedRoutines: 2,
    expectedWorking: 1,
  };
  Object.defineProperty(accessorFixture, "observation", { enumerable: true, get() { getterCalls += 1; return clone(); } });
  assert.equal(runHermesBotModeConformanceV1({ adapter: hermesBotModeReadAdapterV1,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1, fixtures: [accessorFixture] }).reasons[0], "fixture_invalid");
  assert.equal(getterCalls, 0);

  const proxiedFixture = observedProxy({ name: "proxied fixture", observation: clone(), expectedProfiles: 2,
    expectedRooms: 1, expectedRoutines: 2, expectedWorking: 1 }, "transparent");
  assert.equal(runHermesBotModeConformanceV1({ adapter: hermesBotModeReadAdapterV1,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1,
    fixtures: [proxiedFixture.value as never] }).reasons[0], "fixture_invalid");
  assert.equal(proxiedFixture.trapCount(), 0);

  const hostileDecision = observedProxy({ compatible: true, reasons: [] }, "transparent");
  const decisionAdapter = Object.freeze({ ...hermesBotModeReadAdapterV1,
    evaluateCompatibility: () => hostileDecision.value }) as unknown as HermesBotModeReadAdapterV1;
  assert.equal(runHermesBotModeConformanceV1({ adapter: decisionAdapter,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1, fixtures: [] }).reasons[0], "compatibility_rejected");
  assert.equal(hostileDecision.trapCount(), 0);

  const cyclicManifest = { ...hermesBotModeManifestV1 } as Record<string, unknown>;
  cyclicManifest.self = cyclicManifest;
  Object.freeze(cyclicManifest);
  const cyclicAdapter = Object.freeze({ ...hermesBotModeReadAdapterV1, manifest: cyclicManifest }) as unknown as HermesBotModeReadAdapterV1;
  assert.equal(runHermesBotModeConformanceV1({ adapter: cyclicAdapter,
    compatibilityEvidence: hermesBotModeCompatibilityEvidenceFixtureV1, fixtures: [] }).reasons[0], "adapter_shape_invalid");
});
