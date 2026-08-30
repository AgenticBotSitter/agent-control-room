import { sha256Digest } from "../../security";
import { buildReadyFrontierPolicyV1, buildReadyFrontierSourceV1, evaluateReadyFrontierV1 } from "./controller";
import { buildReadyFrontierCanonicalReadV1 } from "./canonical-source";
import { projectReadyFrontierCycleV1 } from "./cycle-projection";
import { buildReadyFrontierFixtureV1 } from "./fixture";
import {
  READY_FRONTIER_CANONICAL_READ_V1,
  READY_FRONTIER_MANUAL_CYCLE_REQUEST_V1,
  type ReadyFrontierCanonicalReadV1,
  type ReadyFrontierCycleProjectionV1,
  type ReadyFrontierIntegrationFixtureV1,
  type ReadyFrontierReadRequestV1,
} from "./integration-types";
import type { ReadyFrontierEvaluationV1 } from "./types";

const sourceKey = () => new Uint8Array(32).fill(0x51);
const evaluationKey = () => new Uint8Array(32).fill(0x52);

function sameRequest(left: ReadyFrontierReadRequestV1, right: ReadyFrontierReadRequestV1): boolean {
  return left.readGroupId === right.readGroupId && left.tenantId === right.tenantId && left.revision === right.revision
    && left.observedAt === right.observedAt && left.readOnly && !left.permitsMutation && !left.permitsNetworkDiscovery
    && left.projectIds.length === right.projectIds.length
    && left.projectIds.every((projectId, index) => projectId === right.projectIds[index]);
}

export function readyFrontierRepositoryFixtureSourceKeyV1(): Uint8Array { return sourceKey(); }
export function readyFrontierRepositoryFixtureEvaluationKeyV1(): Uint8Array { return evaluationKey(); }

export function buildReadyFrontierIntegrationFixtureV1(integrityKeyValue: unknown = sourceKey()): ReadyFrontierIntegrationFixtureV1 {
  const fixture = buildReadyFrontierFixtureV1(), projectIds = fixture.source.projects.map((project) => project.projectId);
  const readGroupId = "frontier.read-group.repository.0001";
  const common = {
    schema: READY_FRONTIER_CANONICAL_READ_V1,
    readGroupId,
    tenantId: fixture.source.tenantId,
    revision: fixture.source.sourceRevision,
    observedAt: fixture.source.observedAt,
    projectIds,
    retainsRawInputContent: false as const,
    retainsUsableAccessData: false as const,
    retainsPrivateLocators: false as const,
  };
  const reads = new Map<ReadyFrontierCanonicalReadV1["channel"], ReadyFrontierCanonicalReadV1>();
  const add = (read: ReadyFrontierCanonicalReadV1) => { reads.set(read.channel, read); };
  add(buildReadyFrontierCanonicalReadV1({ ...common, channel: "projects", payload: {
    projects: fixture.source.projects,
  } }, integrityKeyValue));
  add(buildReadyFrontierCanonicalReadV1({ ...common, channel: "work", payload: {
    candidates: fixture.source.candidates.map(({ reviewTruth: _review, blockerCodes: _blockers, ...candidate }) => {
      void _review; void _blockers; return candidate;
    }),
    canonicalWork: fixture.source.canonicalWork,
    dependencyTruth: fixture.source.dependencyTruth,
  } }, integrityKeyValue));
  add(buildReadyFrontierCanonicalReadV1({ ...common, channel: "attention", payload: {
    attention: fixture.source.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      projectId: candidate.projectId,
      reviewTruth: candidate.reviewTruth,
      blockerCodes: candidate.blockerCodes,
      observedAt: fixture.source.observedAt,
      evidenceDigest: sha256Digest({ fixture: "cr11b-auto-010-attention", candidateId: candidate.candidateId }),
    })),
  } }, integrityKeyValue));
  add(buildReadyFrontierCanonicalReadV1({ ...common, channel: "capacity", payload: {
    routes: fixture.source.routes,
  } }, integrityKeyValue));
  const expected: ReadyFrontierReadRequestV1 = { readGroupId, tenantId: fixture.source.tenantId,
    revision: fixture.source.sourceRevision, observedAt: fixture.source.observedAt, projectIds,
    readOnly: true, permitsMutation: false, permitsNetworkDiscovery: false };
  const read = (channel: ReadyFrontierCanonicalReadV1["channel"], request: ReadyFrontierReadRequestV1): ReadyFrontierCanonicalReadV1 => {
    if (!sameRequest(request, expected)) throw new Error("fixture_read_scope_mismatch");
    const value = reads.get(channel); if (!value) throw new Error("fixture_read_missing"); return value;
  };
  return {
    request: {
      schema: READY_FRONTIER_MANUAL_CYCLE_REQUEST_V1,
      requestId: "frontier.request.repository.0001",
      cycleId: fixture.cycleId,
      readGroupId,
      tenantId: fixture.source.tenantId,
      sourceRevision: fixture.source.sourceRevision,
      historyRevision: fixture.source.historyRevision,
      sourceObservedAt: fixture.source.observedAt,
      evaluatedAt: fixture.evaluatedAt,
      projectIds,
      manualTrigger: true,
      scheduleId: null,
      permitsAutomaticRun: false,
      permitsCanonicalWorkCreation: false,
      permitsApproval: false,
      permitsReadyTransition: false,
      permitsClaimOrLease: false,
      permitsDispatchOrExecution: false,
      permitsProviderContact: false,
      permitsExternalEffects: false,
    },
    policy: fixture.policy,
    ports: {
      readProjects: (request) => read("projects", request),
      readWork: (request) => read("work", request),
      readAttention: (request) => read("attention", request),
      readCapacity: (request) => read("capacity", request),
    },
  };
}

/** Server-rendered repository fixture only. It performs no read, write, provider, network, schedule, or agent action. */
export function buildReadyFrontierRepositoryFixtureEvaluationV1(): ReadyFrontierEvaluationV1 {
  const fixture = buildReadyFrontierFixtureV1(), key = evaluationKey();
  const projectId = (value: string): string => ({
    "project.abs-news": "project.abs.ai-tech-news",
    "project.content-blooms": "project.blooms.content-ops",
    "project.wayfarer": "project.wayfarer.lazy-river",
  })[value] ?? value;
  const { sourceDigest: _sourceDigest, ...sourceInput } = fixture.source; void _sourceDigest;
  const source = buildReadyFrontierSourceV1({
    ...sourceInput,
    projects: fixture.source.projects.map((item) => ({ ...item, projectId: projectId(item.projectId) })),
    candidates: fixture.source.candidates.map((item) => ({ ...item, projectId: projectId(item.projectId) })),
    canonicalWork: fixture.source.canonicalWork.map((item) => ({ ...item, projectId: projectId(item.projectId) })),
    dependencyTruth: fixture.source.dependencyTruth.map((item) => ({ ...item, projectId: projectId(item.projectId) })),
    priorProposals: fixture.source.priorProposals.map((item) => ({ ...item, projectId: projectId(item.projectId) })),
  });
  const { policyDigest: _policyDigest, ...policyInput } = fixture.policy; void _policyDigest;
  const policy = buildReadyFrontierPolicyV1({ ...policyInput,
    projectPolicies: fixture.policy.projectPolicies.map((item) => ({ ...item, projectId: projectId(item.projectId) })) });
  try { return evaluateReadyFrontierV1({ ...fixture, source, policy }, key); }
  finally { key.fill(0); }
}

/** Server-rendered repository fixture only. It performs no read, write, provider, network, schedule, or agent action. */
export function buildReadyFrontierCycleProjectionFixtureV1(): ReadyFrontierCycleProjectionV1 {
  const key = evaluationKey();
  try { return projectReadyFrontierCycleV1(buildReadyFrontierRepositoryFixtureEvaluationV1(), key); }
  finally { key.fill(0); }
}
