import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  buildIdeaLabHermes021ConnectionRosterV1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  parseIdeaLabHermes021ConnectionSafeResultV1,
  type IdeaLabHermes021ConnectionRosterV1,
} from "../../idea-lab/v1";
import { sha256Digest } from "../../security";
import { connectionCenterProjectionSchemaV1 } from "./schemas";
import {
  CONNECTION_CENTER_CONTRACT_V1,
  type ConnectionCenterItemV1,
  type ConnectionCenterProjectionV1,
} from "./types";

export class ConnectionCenterReadErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_read_scope" | "invalid_roster") { super(safeCode); }
}

export interface ConnectionCenterRosterSourceV1 {
  /** Returns a server-owned roster. Implementations may not pass browser or remote objects through this port. */
  read(input: { tenantId: string; now: string }): Promise<IdeaLabHermes021ConnectionRosterV1>;
}

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
): ConnectionCenterProjectionV1 {
  const nodeReferences = new Map<string, string>();
  const connections: ConnectionCenterItemV1[] = roster.connections.map((candidate, index) => {
    const connection = parseIdeaLabHermes021ConnectionSafeResultV1(candidate);
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
  constructor(private readonly source: ConnectionCenterRosterSourceV1) {}

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
      const parsed = buildConnectionCenterProjectionV1(roster);
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
