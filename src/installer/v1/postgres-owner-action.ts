import { sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationActionPreparationV1 } from "./installation-action-preparation";

/**
 * A source-only hand-off to the existing PostgreSQL deployment package.
 *
 * This adapter retains the current installation-action plan as its only
 * authority fence, and names (but never imports or executes) the existing
 * provision SQL, migration applier, immutable migration ledger, and evidence
 * collector. It deliberately does not add a migration engine, SQL, database
 * connection, process launcher, journal, schema, or plan transition.
 */
export const POSTGRES_OWNER_ACTION_V1 = "control-room.postgres-owner-action/v1" as const;

type PostgresOperation = "owner_provision_database" | "apply_existing_migration_ledger" | "collect_existing_database_evidence";

type ExistingTool = Readonly<{
  kind: "existing_postgres_tool";
  executable: "psql" | "node";
  entrypoint: "deploy/postgres/provision-database.sql" | "deploy/postgres/apply-migrations.mjs" | "deploy/postgres/evidence.mjs";
  supportingPaths: readonly string[];
}>;

export type PostgresOwnerActionRequestV1 = Readonly<{
  schema: typeof POSTGRES_OWNER_ACTION_V1;
  stage: "database_authority";
  installationPlanDigest: string;
  installationPlanRevision: number;
  topologyPlanDigest: string;
  releaseDigest: string;
  postgresPreparationDigest: string;
  ledgerDigest: string;
  targetIdentityDigest: string;
  operation: PostgresOperation;
  precondition: "empty_target_and_owner_attendance" | "provisioned_target_and_owner_attendance" | "existing_verified_target_only";
  tool: ExistingTool;
  requiresOwnerPrivateConfiguration: true;
  performsEffect: false;
  startsProcess: false;
  opensNetwork: false;
  runsSql: false;
}>;

const refuse = (): never => { throw new Error("postgres_owner_action_refused"); };

function toolFor(operation: PostgresOperation): ExistingTool {
  if (operation === "owner_provision_database") return Object.freeze({ kind: "existing_postgres_tool",
    executable: "psql", entrypoint: "deploy/postgres/provision-database.sql", supportingPaths: Object.freeze([]) });
  if (operation === "apply_existing_migration_ledger") return Object.freeze({ kind: "existing_postgres_tool",
    executable: "node", entrypoint: "deploy/postgres/apply-migrations.mjs",
    supportingPaths: Object.freeze(["deploy/postgres/migration-ledger.json", "db/roles/production_provision.sql", "db/roles/production_table_grants.sql"]) });
  if (operation === "collect_existing_database_evidence") return Object.freeze({ kind: "existing_postgres_tool",
    executable: "node", entrypoint: "deploy/postgres/evidence.mjs", supportingPaths: Object.freeze([]) });
  return refuse();
}

function preconditionFor(operation: PostgresOperation): PostgresOwnerActionRequestV1["precondition"] {
  if (operation === "owner_provision_database") return "empty_target_and_owner_attendance";
  if (operation === "apply_existing_migration_ledger") return "provisioned_target_and_owner_attendance";
  if (operation === "collect_existing_database_evidence") return "existing_verified_target_only";
  return refuse();
}

function operation(value: unknown): PostgresOperation {
  if (value === "owner_provision_database" || value === "apply_existing_migration_ledger" || value === "collect_existing_database_evidence") return value;
  return refuse();
}

function precondition(value: unknown): PostgresOwnerActionRequestV1["precondition"] {
  if (value === "empty_target_and_owner_attendance" || value === "provisioned_target_and_owner_attendance" || value === "existing_verified_target_only") return value;
  return refuse();
}

function digest(value: unknown): string {
  if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) return value;
  return refuse();
}

function build(input: unknown): PostgresOwnerActionRequestV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse();
  const envelope = input as Readonly<{ actionPreparation?: unknown; actionInput?: unknown }>;
  if (Object.getPrototypeOf(envelope) !== Object.prototype || Object.getOwnPropertySymbols(envelope).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(envelope);
  if (names.length !== 2 || names.some(name => Object.getOwnPropertyDescriptor(envelope, name)?.enumerable !== true)
    || !("actionPreparation" in envelope) || !("actionInput" in envelope)) return refuse();
  const action = verifyInstallationActionPreparationV1(envelope.actionPreparation, envelope.actionInput);
  if (action.action !== "postgres" || action.stage !== "database_authority") return refuse();
  const prepared = action.preparedAction as Readonly<Record<string, unknown>>;
  const selectedOperation = operation(prepared.nextOperation), selectedPrecondition = precondition(prepared.precondition);
  if (selectedPrecondition !== preconditionFor(selectedOperation)) return refuse();
  const request = { schema: POSTGRES_OWNER_ACTION_V1, stage: "database_authority" as const,
    installationPlanDigest: action.installationPlanDigest, installationPlanRevision: action.installationPlanRevision,
    topologyPlanDigest: action.topologyPlanDigest, releaseDigest: action.releaseDigest,
    postgresPreparationDigest: digest(prepared.preparationDigest), ledgerDigest: digest(prepared.ledgerDigest),
    targetIdentityDigest: digest(prepared.targetIdentityDigest), operation: selectedOperation, precondition: selectedPrecondition,
    tool: toolFor(selectedOperation), requiresOwnerPrivateConfiguration: true as const,
    performsEffect: false as const, startsProcess: false as const, opensNetwork: false as const, runsSql: false as const };
  return Object.freeze({ ...request, tool: Object.freeze({ ...request.tool, supportingPaths: Object.freeze([...request.tool.supportingPaths]) }) });
}

/**
 * Rebuilds the current action preparation into a redacted request. It is pure:
 * production attendance, credentials, command arguments, process execution,
 * replay fencing and sanitized evidence recording remain in a later reviewed
 * owner-effect wrapper.
 */
export function preparePostgresOwnerActionV1(input: unknown): PostgresOwnerActionRequestV1 {
  try { return build(input); } catch { return refuse(); }
}
