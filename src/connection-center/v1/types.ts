export const CONNECTION_CENTER_CONTRACT_V1 = "control-room-connection-center/v1" as const;

export type ConnectionCenterBlockerCodeV1 =
  | "native_qualification_missing"
  | "owner_effect_window_missing"
  | "admission_authority_not_configured"
  | "live_driver_not_configured";

export interface ConnectionCenterItemV1 {
  connectionId: string;
  nodeId: string;
  transport: "local_loopback" | "ssh_tunnel";
  runtimeRevision: string;
  runtimeCompatibility: "reviewed_exact_revision";
  enrollmentState: "accepted";
  profileState: "eligible";
  qualificationState: "required";
  livePanelState: "blocked";
  diagnosticState: "setup_required";
  blockerCodes: ConnectionCenterBlockerCodeV1[];
  enrolledAt: string;
  enrollmentExpiresAt: string;
  lastEvaluatedAt: string;
  sourceResultDigest: string;
  locationVisible: false;
  credentialMaterialVisible: false;
  nativeLocatorVisible: false;
  presentationOnly: true;
  grantsApproval: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
}

export interface ConnectionCenterProjectionV1 {
  contractVersion: typeof CONNECTION_CENTER_CONTRACT_V1;
  tenantId: string;
  generatedAt: string;
  sourceMode: "protected_enrollment_roster";
  inventoryState: "empty" | "enrolled";
  safeStatusCode: "no_enrolled_connections" | "enrollment_present_qualification_required";
  reviewedRuntime: {
    releaseLine: "0.21";
    runtimeRevision: string;
    sourceCandidateDigest: string;
  };
  summary: {
    connectionCount: number;
    localConnectionCount: number;
    sshConnectionCount: number;
    qualificationReadyCount: number;
    nativeQualifiedCount: 0;
    livePanelEligibleCount: 0;
    attentionCount: number;
  };
  connections: ConnectionCenterItemV1[];
  rosterDigest: string;
  containsNativeLocators: false;
  containsProtectedValueMaterial: false;
  presentationOnly: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  projectionDigest: string;
}

export type ConnectionCenterDataStateV1 =
  | { state: "loading" }
  | { state: "available"; projection: ConnectionCenterProjectionV1 }
  | { state: "unavailable"; code: "authentication_required" | "connection_center_unavailable" | "invalid_response" | "request_failed" };
