export const CONNECTION_CENTER_CONTRACT_V1 = "control-room-connection-center/v1" as const;

export type ConnectionCenterBlockerCodeV1 =
  | "native_qualification_missing"
  | "owner_effect_window_missing"
  | "admission_authority_not_configured"
  | "live_driver_not_configured";

export interface ConnectionCenterItemV1 {
  connectionReference: string;
  nodeReference: string;
  transport: "local_loopback" | "ssh_tunnel";
  runtimeRevision: string;
  runtimeCompatibility: "reviewed_exact_revision";
  enrollmentState: "accepted";
  profileState: "eligible";
  qualificationState: "required";
  livePanelState: "blocked";
  diagnosticState: "setup_required";
  signalFreshness: "current" | "stale" | "missing";
  signalFreshnessBasis: "authenticated_telemetry" | "none";
  signalObservedAt: string | null;
  signalExpiresAt: string | null;
  blockerCodes: ConnectionCenterBlockerCodeV1[];
  enrolledAt: string;
  enrollmentExpiresAt: string;
  lastEvaluatedAt: string;
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
  tenantScoped: true;
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
    currentSignalCount: number;
    staleSignalCount: number;
    missingSignalCount: number;
    attentionCount: number;
  };
  connections: ConnectionCenterItemV1[];
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

/** Server-only fact returned after authenticated fleet persistence has been read. */
export interface ConnectionCenterNodeFreshnessV1 {
  state: "current" | "stale" | "missing";
  basis: "authenticated_telemetry" | "none";
  observedAt: string | null;
  expiresAt: string | null;
}

export type ConnectionCenterDataStateV1 =
  | { state: "loading" }
  | { state: "available"; projection: ConnectionCenterProjectionV1 }
  | { state: "unavailable"; code: "authentication_required" | "connection_center_unavailable" | "invalid_response" | "request_failed" };
