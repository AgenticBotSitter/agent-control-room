import {
  currentResourceHolderProofSchemaV2,
  verifyCurrentResourceHolderProofV2,
  type CurrentResourceHolderProofV2,
} from '../../contracts/v1/project-coordination-boundaries';
import {
  createHostResultCollectorV1,
  dataMethodV1,
  exactHostDataSnapshotV1,
  isHostProxyV1,
  type HostResultCollectorV1,
} from '../../security/host-value';

const reflectApply = Reflect.apply;
const objectFreeze = Object.freeze;

const expectationKeys = [
  'tenantId',
  'projectId',
  'jobId',
  'attemptId',
  'leaseId',
  'nodeId',
  'runId',
  'admissionId',
  'resourceAdmissionDigest',
  'startAuthorizationDigest',
] as const;

const proofKeys = [
  'schema',
  ...expectationKeys,
  'admissionVersion',
  'state',
  'checkedAt',
  'expiresAt',
] as const;

export type CurrentResourceHolderExpectationV2 = Readonly<Pick<CurrentResourceHolderProofV2,
  'tenantId' | 'projectId' | 'jobId' | 'attemptId' | 'leaseId' | 'nodeId' | 'runId' | 'admissionId'
  | 'resourceAdmissionDigest' | 'startAuthorizationDigest'>>;

export interface AuthenticatedCurrentResourceHolderPortV2 {
  /** Authenticated lookup only. It must neither create nor reactivate a holder. */
  lookupCurrentHolder(expected: CurrentResourceHolderExpectationV2, collector: HostResultCollectorV1): Promise<void>;
}

export interface CurrentResourceHolderClockV2 {
  nowMs(): number;
}

export interface CurrentResourceHolderFenceDependenciesV2 {
  holder: AuthenticatedCurrentResourceHolderPortV2;
  clock: CurrentResourceHolderClockV2;
}

export interface CurrentResourceHolderFenceV2 {
  /**
   * Performs one fresh lookup and verifies one exact proof. Call immediately
   * before every start/effect step; a previous success is never cached.
   */
  assertCurrent(expected: CurrentResourceHolderExpectationV2): Promise<Readonly<CurrentResourceHolderProofV2>>;
}

export class CurrentResourceHolderFenceErrorV2 extends Error {
  readonly safeCode = 'current_resource_holder_unavailable' as const;

  constructor() {
    super('current_resource_holder_unavailable');
    this.name = 'CurrentResourceHolderFenceErrorV2';
    objectFreeze(this);
  }
}

function fail(): never {
  throw new CurrentResourceHolderFenceErrorV2();
}

function captureExpectation(value: unknown): CurrentResourceHolderExpectationV2 {
  const snapshot = exactHostDataSnapshotV1(value, expectationKeys);
  if (!snapshot) fail();
  try {
    const parsed = currentResourceHolderProofSchemaV2.parse({
      schema: 'control-room.current-resource-holder/v2',
      ...snapshot,
      admissionVersion: 1,
      state: 'held',
      checkedAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.001Z',
    });
    return objectFreeze({
      tenantId: parsed.tenantId,
      projectId: parsed.projectId,
      jobId: parsed.jobId,
      attemptId: parsed.attemptId,
      leaseId: parsed.leaseId,
      nodeId: parsed.nodeId,
      runId: parsed.runId,
      admissionId: parsed.admissionId,
      resourceAdmissionDigest: parsed.resourceAdmissionDigest,
      startAuthorizationDigest: parsed.startAuthorizationDigest,
    });
  } catch {
    fail();
  }
}

function captureProof(value: unknown): Record<string, unknown> {
  const snapshot = exactHostDataSnapshotV1(value, proofKeys);
  if (!snapshot) fail();
  return snapshot;
}

/**
 * Captures the authenticated lookup and trusted clock once at composition.
 * The returned component only checks evidence: it has no dispatch, process,
 * workspace, transport, retry, resume, or holder-mutation capability.
 */
export function createCurrentResourceHolderFenceV2(
  dependenciesValue: CurrentResourceHolderFenceDependenciesV2,
): Readonly<CurrentResourceHolderFenceV2> {
  const dependencies = exactHostDataSnapshotV1(dependenciesValue, ['holder', 'clock']);
  const holder = dependencies?.holder;
  const clock = dependencies?.clock;
  if (!holder || typeof holder !== 'object' || isHostProxyV1(holder)
    || !clock || typeof clock !== 'object' || isHostProxyV1(clock)) fail();

  const lookup = dataMethodV1(holder, 'lookupCurrentHolder');
  const now = dataMethodV1(clock, 'nowMs');
  if (!lookup || !now) fail();

  return objectFreeze({
    async assertCurrent(expectedValue: CurrentResourceHolderExpectationV2) {
      const expected = captureExpectation(expectedValue);
      const handoff = createHostResultCollectorV1();
      try {
        await reflectApply(lookup, holder, [expected, handoff.collector]);
        const proofValue = handoff.take();
        const proof = captureProof(proofValue);
        const nowMs = reflectApply(now, clock, []) as unknown;
        if (typeof nowMs !== 'number') fail();
        return objectFreeze(verifyCurrentResourceHolderProofV2(proof, expected, nowMs));
      } catch {
        handoff.abort();
        fail();
      }
    },
  });
}
