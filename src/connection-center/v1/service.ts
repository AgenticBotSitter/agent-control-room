import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  buildIdeaLabHermes021ConnectionRosterV1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  parseIdeaLabHermes021ConnectionSafeResultV1,
  type IdeaLabHermes021ConnectionRosterV1,
} from "../../idea-lab/v1";
import { sha256Digest } from "../../security";
import { exactHostDataArrayV1, exactHostDataSnapshotV1 } from "../../security/host-value";
import { connectionCenterProjectionSchemaV1 } from "./schemas";
import {
  CONNECTION_CENTER_CONTRACT_V1,
  type ConnectionCenterItemV1,
  type ConnectionCenterNodeFreshnessV1,
  type ConnectionCenterProjectionV1,
} from "./types";

export class ConnectionCenterReadErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_read_scope" | "invalid_roster") { super(safeCode); }
}

export interface ConnectionCenterRosterSourceV1 {
  /** Returns a server-owned roster. Implementations may not pass browser or remote objects through this port. */
  read(input: { tenantId: string; now: string }): Promise<IdeaLabHermes021ConnectionRosterV1>;
}

export interface ConnectionCenterFreshnessSourceV1 {
  /** Raw node identity remains server-side and may only select previously authenticated telemetry. */
  read(input: { tenantId: string; nodeId: string; now: string }): Promise<ConnectionCenterNodeFreshnessV1>;
}

const missingFreshness: ConnectionCenterNodeFreshnessV1 = Object.freeze({
  state: "missing", basis: "none", observedAt: null, expiresAt: null,
});

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
const exactTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function unsigned(value: ConnectionCenterProjectionV1): Omit<ConnectionCenterProjectionV1, "projectionDigest"> {
  const { projectionDigest: _projectionDigest, ...material } = value;
  void _projectionDigest;
  return material;
}

function freezeProjection(value: ConnectionCenterProjectionV1): ConnectionCenterProjectionV1 {
  for (const connection of value.connections) {
    Object.freeze(connection.blockerCodes);
    Object.freeze(connection);
  }
  Object.freeze(value.connections);
  Object.freeze(value.reviewedRuntime);
  Object.freeze(value.summary);
  return Object.freeze(value);
}

export function parseConnectionCenterProjectionV1(value: unknown): ConnectionCenterProjectionV1 {
  const parsed = connectionCenterProjectionSchemaV1.parse(value) as ConnectionCenterProjectionV1;
  if (sha256Digest(unsigned(parsed)) !== parsed.projectionDigest) throw new ConnectionCenterReadErrorV1("invalid_roster");
  return freezeProjection(parsed);
}

export function buildConnectionCenterProjectionV1(
  roster: IdeaLabHermes021ConnectionRosterV1,
  nodeFreshness: readonly ConnectionCenterNodeFreshnessV1[] = [],
): ConnectionCenterProjectionV1 {
  const capturedFreshness = exactHostDataArrayV1(nodeFreshness, 32);
  if (!capturedFreshness || (capturedFreshness.length !== 0 && capturedFreshness.length !== roster.connections.length)) {
    throw new ConnectionCenterReadErrorV1("invalid_roster");
  }
  const nodeReferences = new Map<string, string>();
  const connections: ConnectionCenterItemV1[] = roster.connections.map((candidate, index) => {
    const connection = parseIdeaLabHermes021ConnectionSafeResultV1(candidate);
    const captured = capturedFreshness.length
      ? exactHostDataSnapshotV1(capturedFreshness[index], ["state", "basis", "observedAt", "expiresAt"])
      : missingFreshness;
    if (!captured) throw new ConnectionCenterReadErrorV1("invalid_roster");
    const state = captured.state, basis = captured.basis, observedAt = captured.observedAt, expiresAt = captured.expiresAt;
    if ((state !== "current" && state !== "stale" && state !== "missing")
      || (basis !== "authenticated_telemetry" && basis !== "none")
      || (state === "missing") !== (basis === "none")
      || (state === "missing") !== (observedAt === null && expiresAt === null)
      || (state !== "missing" && (typeof observedAt !== "string" || typeof expiresAt !== "string"
        || !exactTime.test(observedAt) || !exactTime.test(expiresAt)
        || Number.isNaN(Date.parse(observedAt)) || Number.isNaN(Date.parse(expiresAt))))) {
      throw new ConnectionCenterReadErrorV1("invalid_roster");
    }
    const freshness: ConnectionCenterNodeFreshnessV1 = { state, basis,
      observedAt: observedAt as string | null, expiresAt: expiresAt as string | null };
    let nodeReference = nodeReferences.get(connection.nodeId);
    if (!nodeReference) {
      nodeReference = `node:inventory:${String(nodeReferences.size + 1).padStart(3, "0")}`;
      nodeReferences.set(connection.nodeId, nodeReference);
    }
    return {
      connectionReference: `connection:inventory:${String(index + 1).padStart(3, "0")}`,
      nodeReference,
      transport: connection.transport,
      runtimeRevision: connection.runtimeRevision,
      runtimeCompatibility: "reviewed_exact_revision",
      enrollmentState: "accepted",
      profileState: "eligible",
      qualificationState: "required",
      livePanelState: "blocked",
      diagnosticState: "setup_required",
      signalFreshness: freshness.state,
      signalFreshnessBasis: freshness.basis,
      signalObservedAt: freshness.observedAt,
      signalExpiresAt: freshness.expiresAt,
      blockerCodes: [...connection.blockerCodes],
      enrolledAt: connection.issuedAt,
      enrollmentExpiresAt: connection.expiresAt,
      lastEvaluatedAt: connection.evaluatedAt,
      locationVisible: false,
      credentialMaterialVisible: false,
      nativeLocatorVisible: false,
      presentationOnly: true,
      grantsApproval: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
  });
  const currentSignalCount = connections.filter((item) => item.signalFreshness === "current").length;
  const staleSignalCount = connections.filter((item) => item.signalFreshness === "stale").length;
  const missingSignalCount = connections.filter((item) => item.signalFreshness === "missing").length;
  const material = {
    contractVersion: CONNECTION_CENTER_CONTRACT_V1,
    tenantScoped: true as const,
    generatedAt: roster.evaluatedAt,
    sourceMode: "protected_enrollment_roster" as const,
    inventoryState: connections.length ? "enrolled" as const : "empty" as const,
    safeStatusCode: connections.length
      ? "enrollment_present_qualification_required" as const
      : "no_enrolled_connections" as const,
    reviewedRuntime: {
      releaseLine: "0.21" as const,
      runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
      sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    },
    summary: {
      connectionCount: roster.connectionCount,
      localConnectionCount: roster.localConnectionCount,
      sshConnectionCount: roster.sshConnectionCount,
      qualificationReadyCount: roster.qualificationReadyCount,
      nativeQualifiedCount: roster.nativeQualifiedCount,
      livePanelEligibleCount: roster.livePanelEligibleCount,
      currentSignalCount,
      staleSignalCount,
      missingSignalCount,
      attentionCount: connections.length,
    },
    connections,
    containsNativeLocators: false as const,
    containsProtectedValueMaterial: false as const,
    presentationOnly: true as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  return parseConnectionCenterProjectionV1({ ...material, projectionDigest: sha256Digest(material) });
}

export class ConnectionCenterReadServiceV1 {
  constructor(private readonly source: ConnectionCenterRosterSourceV1,
    private readonly freshnessSource?: ConnectionCenterFreshnessSourceV1) {}

  async read(input: { tenantId: string; now: string }): Promise<ConnectionCenterProjectionV1> {
    if (!safeId.test(input.tenantId) || !exactTime.test(input.now) || Number.isNaN(Date.parse(input.now))) {
      throw new ConnectionCenterReadErrorV1("invalid_read_scope");
    }
    try {
      const sourceRoster = await this.source.read(input);
      const roster = buildIdeaLabHermes021ConnectionRosterV1({ tenantId: sourceRoster.tenantId,
        evaluatedAt: sourceRoster.evaluatedAt, connections: sourceRoster.connections });
      if (roster.rosterDigest !== sourceRoster.rosterDigest) throw new ConnectionCenterReadErrorV1("invalid_roster");
      if (roster.tenantId !== input.tenantId || roster.evaluatedAt !== input.now) {
        throw new ConnectionCenterReadErrorV1("invalid_roster");
      }
      const freshness = this.freshnessSource
        ? await Promise.all(roster.connections.map((connection) => this.freshnessSource!.read({
          tenantId: input.tenantId, nodeId: connection.nodeId, now: input.now,
        })))
        : [];
      const parsed = buildConnectionCenterProjectionV1(roster, freshness);
      if (parsed.generatedAt !== input.now) {
        throw new ConnectionCenterReadErrorV1("invalid_roster");
      }
      return parsed;
    } catch (error) {
      if (error instanceof ConnectionCenterReadErrorV1) throw error;
      throw new ConnectionCenterReadErrorV1("invalid_roster");
    }
  }
}
