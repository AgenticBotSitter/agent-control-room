import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";

export const OPERATIONS_PRODUCTION_DATABASE_TARGET_CONTRACT_V1 =
  "control-room-operations-production-database-target/v1" as const;

export const OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1 = [
  "native_host_qualification",
  "deployment_mode_selection",
  "private_network_boundary_evidence",
  "postgres_runtime_preparation",
  "database_role_separation",
  "credential_reference_custody",
  "backup_and_wal_configuration",
  "clean_restore_rehearsal",
  "migration_compatibility",
  "health_and_resource_monitoring",
  "fresh_owner_effect_packet",
  "independent_security_review",
] as const;

export type OperationsProductionDatabaseBlockerV1 =
  (typeof OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1)[number];

export interface OperationsProductionDatabaseTargetV1 {
  contractVersion: typeof OPERATIONS_PRODUCTION_DATABASE_TARGET_CONTRACT_V1;
  decisionId: string;
  status: "architecture_selected_live_work_deferred";
  providerTarget: "hostinger_kvm2_vps";
  hostingModel: "self_managed";
  databaseEngine: "postgresql";
  topology: "single_private_primary";
  authority: "sole_global_write_authority";
  applicationAccess: "host_local_or_private_network_only";
  inboundInternetAccessAllowed: false;
  publicDatabaseEndpointAllowed: false;
  awsRdsAllowed: false;
  pgliteUse: "local_development_and_tests_only";
  pgliteProductionAllowed: false;
  r2Use: "artifacts_and_encrypted_backups_only";
  r2CoordinationAllowed: false;
  r2TransactionalStateAllowed: false;
  reportedHostState: {
    source: "owner_relayed_hermes_report_unverified";
    awsCli: "reported_absent";
    awsConfiguration: "reported_absent";
    awsOrRdsEnvironment: "reported_absent";
    postgresClientTools: "reported_present";
    postgresRuntime: "reported_absent";
    acceptedAsLiveEvidence: false;
  };
  blockers: OperationsProductionDatabaseBlockerV1[];
  productionValuesPresent: false;
  hostnamesPresent: false;
  addressesPresent: false;
  portsPresent: false;
  credentialReferencesPresent: false;
  credentialValuesPresent: false;
  providerContactAttempted: false;
  hostContactAttempted: false;
  databaseConnectionAttempted: false;
  postgresRuntimeInstalledOrStarted: false;
  configurationWritten: false;
  migrationAttempted: false;
  backupOrRestoreAttempted: false;
  externalEffectOccurred: false;
  requiresNewExactOwnerAuthorization: true;
  requiresIndependentReviewBeforeLiveWork: true;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  decidedAt: string;
  decisionDigest: string;
}

const blocker = z.enum(OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1);
const inputSchema = z.object({ decisionId: id, decidedAt: time }).strict();
const targetSchema = z.object({
  contractVersion: z.literal(OPERATIONS_PRODUCTION_DATABASE_TARGET_CONTRACT_V1),
  decisionId: id,
  status: z.literal("architecture_selected_live_work_deferred"),
  providerTarget: z.literal("hostinger_kvm2_vps"),
  hostingModel: z.literal("self_managed"),
  databaseEngine: z.literal("postgresql"),
  topology: z.literal("single_private_primary"),
  authority: z.literal("sole_global_write_authority"),
  applicationAccess: z.literal("host_local_or_private_network_only"),
  inboundInternetAccessAllowed: z.literal(false),
  publicDatabaseEndpointAllowed: z.literal(false),
  awsRdsAllowed: z.literal(false),
  pgliteUse: z.literal("local_development_and_tests_only"),
  pgliteProductionAllowed: z.literal(false),
  r2Use: z.literal("artifacts_and_encrypted_backups_only"),
  r2CoordinationAllowed: z.literal(false),
  r2TransactionalStateAllowed: z.literal(false),
  reportedHostState: z.object({
    source: z.literal("owner_relayed_hermes_report_unverified"),
    awsCli: z.literal("reported_absent"),
    awsConfiguration: z.literal("reported_absent"),
    awsOrRdsEnvironment: z.literal("reported_absent"),
    postgresClientTools: z.literal("reported_present"),
    postgresRuntime: z.literal("reported_absent"),
    acceptedAsLiveEvidence: z.literal(false),
  }).strict(),
  blockers: z.array(blocker).length(OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1.length),
  productionValuesPresent: z.literal(false),
  hostnamesPresent: z.literal(false),
  addressesPresent: z.literal(false),
  portsPresent: z.literal(false),
  credentialReferencesPresent: z.literal(false),
  credentialValuesPresent: z.literal(false),
  providerContactAttempted: z.literal(false),
  hostContactAttempted: z.literal(false),
  databaseConnectionAttempted: z.literal(false),
  postgresRuntimeInstalledOrStarted: z.literal(false),
  configurationWritten: z.literal(false),
  migrationAttempted: z.literal(false),
  backupOrRestoreAttempted: z.literal(false),
  externalEffectOccurred: z.literal(false),
  requiresNewExactOwnerAuthorization: z.literal(true),
  requiresIndependentReviewBeforeLiveWork: z.literal(true),
  grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  decidedAt: time,
  decisionDigest: digest,
}).strict();

export function buildOperationsProductionDatabaseTargetV1(inputValue: unknown): OperationsProductionDatabaseTargetV1 {
  const input = parseExactOperationsV1(inputSchema, inputValue, "operations production database target input");
  const material: Omit<OperationsProductionDatabaseTargetV1, "decisionDigest"> = {
    contractVersion: OPERATIONS_PRODUCTION_DATABASE_TARGET_CONTRACT_V1,
    decisionId: input.decisionId,
    status: "architecture_selected_live_work_deferred",
    providerTarget: "hostinger_kvm2_vps",
    hostingModel: "self_managed",
    databaseEngine: "postgresql",
    topology: "single_private_primary",
    authority: "sole_global_write_authority",
    applicationAccess: "host_local_or_private_network_only",
    inboundInternetAccessAllowed: false,
    publicDatabaseEndpointAllowed: false,
    awsRdsAllowed: false,
    pgliteUse: "local_development_and_tests_only",
    pgliteProductionAllowed: false,
    r2Use: "artifacts_and_encrypted_backups_only",
    r2CoordinationAllowed: false,
    r2TransactionalStateAllowed: false,
    reportedHostState: {
      source: "owner_relayed_hermes_report_unverified",
      awsCli: "reported_absent",
      awsConfiguration: "reported_absent",
      awsOrRdsEnvironment: "reported_absent",
      postgresClientTools: "reported_present",
      postgresRuntime: "reported_absent",
      acceptedAsLiveEvidence: false,
    },
    blockers: [...OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1],
    productionValuesPresent: false,
    hostnamesPresent: false,
    addressesPresent: false,
    portsPresent: false,
    credentialReferencesPresent: false,
    credentialValuesPresent: false,
    providerContactAttempted: false,
    hostContactAttempted: false,
    databaseConnectionAttempted: false,
    postgresRuntimeInstalledOrStarted: false,
    configurationWritten: false,
    migrationAttempted: false,
    backupOrRestoreAttempted: false,
    externalEffectOccurred: false,
    requiresNewExactOwnerAuthorization: true,
    requiresIndependentReviewBeforeLiveWork: true,
    grantsApproval: false,
    grantsDeploymentAuthority: false,
    grantsExecutionAuthority: false,
    decidedAt: input.decidedAt,
  };
  return parseOperationsProductionDatabaseTargetV1({ ...material, decisionDigest: sha256Digest(material) });
}

export function parseOperationsProductionDatabaseTargetV1(value: unknown): OperationsProductionDatabaseTargetV1 {
  const parsed = parseExactOperationsV1(targetSchema, value, "operations production database target");
  for (let position = 0; position < OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1.length; position += 1) {
    if (parsed.blockers[position] !== OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1[position]) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "decisionDigest", parsed.decisionDigest);
  return parsed;
}

export const operationsProductionDatabaseTargetSchemasV1 = { target: targetSchema } as const;
