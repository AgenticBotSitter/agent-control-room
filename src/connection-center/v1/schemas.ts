import { z } from "zod";
import { CONNECTION_CENTER_CONTRACT_V1 } from "./types";

const connectionReference = z.string().regex(/^connection:inventory:[0-9]{3}$/);
const nodeReference = z.string().regex(/^node:inventory:[0-9]{3}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: false, precision: 3 });
const blockers = z.enum([
  "native_qualification_missing",
  "owner_effect_window_missing",
  "admission_authority_not_configured",
  "live_driver_not_configured",
]);

export const connectionCenterItemSchemaV1 = z.object({
  connectionReference,
  nodeReference,
  transport: z.enum(["local_loopback", "ssh_tunnel"]),
  runtimeRevision: z.string().min(7).max(80),
  runtimeCompatibility: z.literal("reviewed_exact_revision"),
  enrollmentState: z.literal("accepted"),
  profileState: z.literal("eligible"),
  qualificationState: z.literal("required"),
  livePanelState: z.literal("blocked"),
  diagnosticState: z.literal("setup_required"),
  signalFreshness: z.enum(["current", "stale", "missing"]),
  signalFreshnessBasis: z.enum(["authenticated_telemetry", "none"]),
  signalObservedAt: instant.nullable(),
  signalExpiresAt: instant.nullable(),
  blockerCodes: z.array(blockers).length(4),
  enrolledAt: instant,
  enrollmentExpiresAt: instant,
  lastEvaluatedAt: instant,
  locationVisible: z.literal(false),
  credentialMaterialVisible: z.literal(false),
  nativeLocatorVisible: z.literal(false),
  presentationOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export const connectionCenterProjectionSchemaV1 = z.object({
  contractVersion: z.literal(CONNECTION_CENTER_CONTRACT_V1),
  tenantScoped: z.literal(true),
  generatedAt: instant,
  sourceMode: z.literal("protected_enrollment_roster"),
  inventoryState: z.enum(["empty", "enrolled"]),
  safeStatusCode: z.enum(["no_enrolled_connections", "enrollment_present_qualification_required"]),
  reviewedRuntime: z.object({
    releaseLine: z.literal("0.21"),
    runtimeRevision: z.string().min(7).max(80),
    sourceCandidateDigest: digest,
  }).strict(),
  summary: z.object({
    connectionCount: z.number().int().min(0).max(32),
    localConnectionCount: z.number().int().min(0).max(32),
    sshConnectionCount: z.number().int().min(0).max(32),
    qualificationReadyCount: z.number().int().min(0).max(32),
    nativeQualifiedCount: z.literal(0),
    livePanelEligibleCount: z.literal(0),
    currentSignalCount: z.number().int().min(0).max(32),
    staleSignalCount: z.number().int().min(0).max(32),
    missingSignalCount: z.number().int().min(0).max(32),
    attentionCount: z.number().int().min(0).max(32),
  }).strict(),
  connections: z.array(connectionCenterItemSchemaV1).max(32),
  containsNativeLocators: z.literal(false),
  containsProtectedValueMaterial: z.literal(false),
  presentationOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  projectionDigest: digest,
}).strict();
