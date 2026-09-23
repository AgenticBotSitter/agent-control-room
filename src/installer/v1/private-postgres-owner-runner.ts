import { createHash } from "node:crypto";
import { sha256Digest } from "../../security/canonical-digest";
import { POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1 } from "./postgres-owner-action-transaction";
import { POSTGRES_OWNER_ACTION_V1, type PostgresOwnerActionRequestV1 } from "./postgres-owner-action";
import { matchesPostgresProductionAclV1, POSTGRES_PRODUCTION_MEMBERSHIPS_V1 } from
  "./postgres-production-privilege-contract";

/**
 * Process-private, source-only orchestration for one already-prepared
 * PostgreSQL owner action. The reviewed runtime is deliberately injected: this
 * module has no filesystem, process, network, PostgreSQL, terminal, or native
 * integration of its own.
 */
export const PRIVATE_POSTGRES_OWNER_RUNNER_V1 = "control-room.private-postgres-owner-runner/v1" as const;
export const POSTGRES_OWNER_ATTACHED_TERMINAL_V1 =
  "control-room.postgres-owner-attached-terminal/v1" as const;

type Operation = PostgresOwnerActionRequestV1["operation"];

export type PostgresOwnerRunnerContextV1 = Readonly<{
  request: PostgresOwnerActionRequestV1;
  requestDigest: string;
  signal: AbortSignal;
}>;

export type PostgresOwnerAttachedTerminalConfirmationV1 = Readonly<{
  schema: typeof POSTGRES_OWNER_ATTACHED_TERMINAL_V1;
  requestDigest: string;
  operation: Operation;
  ownerAttached: true;
  confirmed: true;
}>;

export type PostgresOwnerToolObservationV1 = Readonly<{
  outcome: "succeeded";
  observationDigest: string;
}> | Readonly<{
  outcome: "failed_before_effect";
}>;

export type PostgresVerifiedMigrationLedgerEntryV1 = Readonly<{
  file: string;
  order: number;
  sha256: string;
  kind: "migrate" | "grants" | "provision";
}>;

export type PrivatePostgresOwnerRuntimeV1 = Readonly<{
  /** Never returned, hashed, logged, or included in an error. */
  privateConfiguration: unknown;
  signal: AbortSignal;
  controlDeadlineMs: number;
  cleanupDeadlineMs: number;
  verifyExactRelease: (configuration: unknown, context: PostgresOwnerRunnerContextV1) => Promise<Readonly<{
    outcome: "verified";
    releaseDigest: string;
  }>>;
  verifyExactMigrationLedger: (configuration: unknown, context: PostgresOwnerRunnerContextV1) => Promise<Readonly<{
    outcome: "verified";
    ledgerDigest: string;
    entries: readonly PostgresVerifiedMigrationLedgerEntryV1[];
  }>>;
  confirmOwnerAttachedTerminal: (context: PostgresOwnerRunnerContextV1) =>
    Promise<PostgresOwnerAttachedTerminalConfirmationV1>;
  /** Reviewed adapter for deploy/postgres/provision-database.sql. */
  provisionDatabase: (configuration: unknown, context: PostgresOwnerRunnerContextV1) =>
    Promise<PostgresOwnerToolObservationV1>;
  /** Reviewed adapter for the existing applyMigrations function. */
  applyMigrations: (configuration: unknown, context: PostgresOwnerRunnerContextV1) =>
    Promise<PostgresOwnerToolObservationV1>;
  /** The existing collectDatabaseEvidence function, injected directly. */
  collectDatabaseEvidence: (configuration: unknown, context: PostgresOwnerRunnerContextV1) => Promise<unknown>;
  cleanup: (signal: AbortSignal) => Promise<Readonly<{ outcome: "confirmed" }>>;
}>;

export type PrivatePostgresOwnerObservationV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_OWNER_RUNNER_V1;
  requestDigest: string;
  operation: Operation;
  disposition: "intermediate_observation";
  observationDigest: string;
  exactReleaseVerified: true;
  exactMigrationLedgerVerified: true;
  cleanupConfirmed: true;
  terminalConfirmation: null;
}>;

export type PrivatePostgresOwnerTerminalResultV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_OWNER_RUNNER_V1;
  requestDigest: string;
  operation: "collect_existing_database_evidence";
  disposition: "terminal_confirmation";
  observationDigest: string;
  exactReleaseVerified: true;
  exactMigrationLedgerVerified: true;
  cleanupConfirmed: true;
  terminalConfirmation: Readonly<{
    schema: typeof POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1;
    requestDigest: string;
    terminalEvidenceDigest: string;
    terminalState: "confirmed";
  }>;
}>;

export type PrivatePostgresOwnerRunnerResultV1 =
  | PrivatePostgresOwnerObservationV1
  | PrivatePostgresOwnerTerminalResultV1;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const expectedTools = Object.freeze({
  owner_provision_database: Object.freeze({ executable: "psql", entrypoint: "deploy/postgres/provision-database.sql",
    supportingPaths: Object.freeze([]) }),
  apply_existing_migration_ledger: Object.freeze({ executable: "node", entrypoint: "deploy/postgres/apply-migrations.mjs",
    supportingPaths: Object.freeze(["deploy/postgres/migration-ledger.json", "db/roles/production_provision.sql",
      "db/roles/production_table_grants.sql"]) }),
  collect_existing_database_evidence: Object.freeze({ executable: "node", entrypoint: "deploy/postgres/evidence.mjs",
    supportingPaths: Object.freeze([]) }),
} satisfies Readonly<Record<Operation, Readonly<{ executable: string; entrypoint: string; supportingPaths: readonly string[] }>>>);

const failureKinds = new WeakMap<object, "refused" | "uncertain">();
const sanitizedError = (kind: "refused" | "uncertain"): Error => {
  const error = new Error(`private_postgres_owner_runner_${kind}`);
  error.stack = undefined;
  failureKinds.set(error, kind);
  return error;
};

function failureKind(value: unknown): "refused" | "uncertain" | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? failureKinds.get(value as object) : undefined;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw sanitizedError("refused");
  }
  const result = value as Readonly<Record<string, unknown>>;
  if (Object.getOwnPropertyNames(result).some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(result, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) throw sanitizedError("refused");
  return result;
}

function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const result = plainRecord(value), keys = Object.keys(result);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(result, name))) throw sanitizedError("refused");
  return result;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw sanitizedError("refused");
  return value;
}

function operation(value: unknown): Operation {
  if (value !== "owner_provision_database" && value !== "apply_existing_migration_ledger"
    && value !== "collect_existing_database_evidence") throw sanitizedError("refused");
  return value;
}

function verifiedRequest(value: unknown): PostgresOwnerActionRequestV1 {
  const request = exactRecord(value, ["schema", "stage", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "postgresPreparationDigest", "ledgerDigest", "targetIdentityDigest",
    "operation", "precondition", "tool", "requiresOwnerPrivateConfiguration", "performsEffect", "startsProcess",
    "opensNetwork", "runsSql"]);
  const selected = operation(request.operation);
  const precondition = selected === "owner_provision_database" ? "empty_target_and_owner_attendance"
    : selected === "apply_existing_migration_ledger" ? "provisioned_target_and_owner_attendance"
      : "existing_verified_target_only";
  if (request.schema !== POSTGRES_OWNER_ACTION_V1 || request.stage !== "database_authority"
    || !Number.isSafeInteger(request.installationPlanRevision) || (request.installationPlanRevision as number) < 0
    || request.precondition !== precondition || request.requiresOwnerPrivateConfiguration !== true
    || request.performsEffect !== false || request.startsProcess !== false || request.opensNetwork !== false
    || request.runsSql !== false) throw sanitizedError("refused");
  for (const name of ["installationPlanDigest", "topologyPlanDigest", "releaseDigest", "postgresPreparationDigest",
    "ledgerDigest", "targetIdentityDigest"] as const) digest(request[name]);
  const tool = exactRecord(request.tool, ["kind", "executable", "entrypoint", "supportingPaths"]);
  const expected = expectedTools[selected];
  if (tool.kind !== "existing_postgres_tool" || tool.executable !== expected.executable
    || tool.entrypoint !== expected.entrypoint || !Array.isArray(tool.supportingPaths)
    || tool.supportingPaths.length !== expected.supportingPaths.length
    || tool.supportingPaths.some((path, index) => path !== expected.supportingPaths[index])) {
    throw sanitizedError("refused");
  }
  return request as PostgresOwnerActionRequestV1;
}

function verifiedRuntime(value: unknown): PrivatePostgresOwnerRuntimeV1 {
  const runtime = exactRecord(value, ["privateConfiguration", "signal", "controlDeadlineMs", "cleanupDeadlineMs",
    "verifyExactRelease", "verifyExactMigrationLedger", "confirmOwnerAttachedTerminal", "provisionDatabase",
    "applyMigrations", "collectDatabaseEvidence", "cleanup"]);
  if (runtime.privateConfiguration === undefined || !runtime.signal || typeof runtime.signal !== "object"
    || typeof (runtime.signal as AbortSignal).aborted !== "boolean"
    || typeof (runtime.signal as AbortSignal).addEventListener !== "function"
    || !Number.isSafeInteger(runtime.controlDeadlineMs) || (runtime.controlDeadlineMs as number) < 1
    || (runtime.controlDeadlineMs as number) > 300_000
    || !Number.isSafeInteger(runtime.cleanupDeadlineMs) || (runtime.cleanupDeadlineMs as number) < 1
    || (runtime.cleanupDeadlineMs as number) > 30_000
    || ["verifyExactRelease", "verifyExactMigrationLedger", "confirmOwnerAttachedTerminal", "provisionDatabase",
      "applyMigrations", "collectDatabaseEvidence", "cleanup"].some(name => typeof runtime[name] !== "function")) {
    throw sanitizedError("refused");
  }
  return runtime as unknown as PrivatePostgresOwnerRuntimeV1;
}

function exactRelease(value: unknown, expected: string) {
  const result = exactRecord(value, ["outcome", "releaseDigest"]);
  if (result.outcome !== "verified" || result.releaseDigest !== expected) throw sanitizedError("refused");
}

function exactLedger(value: unknown, expected: string): readonly PostgresVerifiedMigrationLedgerEntryV1[] {
  const result = exactRecord(value, ["outcome", "ledgerDigest", "entries"]);
  if (result.outcome !== "verified" || result.ledgerDigest !== expected || !Array.isArray(result.entries)
    || result.entries.length < 4) throw sanitizedError("refused");
  const entries: PostgresVerifiedMigrationLedgerEntryV1[] = [];
  for (let index = 0; index < result.entries.length; index += 1) {
    const parsed = exactRecord(result.entries[index], ["file", "order", "sha256", "kind"]);
    if (typeof parsed.file !== "string" || parsed.order !== index + 1 || typeof parsed.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(parsed.sha256)
      || (parsed.kind !== "migrate" && parsed.kind !== "grants" && parsed.kind !== "provision")) {
      throw sanitizedError("refused");
    }
    entries.push({ file: parsed.file, order: parsed.order, sha256: parsed.sha256, kind: parsed.kind });
  }
  const support = entries.slice(-3);
  if (entries.slice(0, -3).some(entry => entry.kind !== "migrate"
      || !/^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(entry.file))
    || JSON.stringify(support.map(entry => [entry.file, entry.kind])) !== JSON.stringify([
      ["db/roles/production_roles.sql", "grants"],
      ["db/roles/production_table_grants.sql", "grants"],
      ["db/roles/production_provision.sql", "provision"],
    ]) || new Set(entries.map(entry => entry.file)).size !== entries.length) throw sanitizedError("refused");
  const computed = `sha256:${createHash("sha256").update(JSON.stringify(entries.map(entry =>
    [entry.file, entry.order, entry.sha256, entry.kind]))).digest("hex")}`;
  if (computed !== expected) throw sanitizedError("refused");
  return Object.freeze(entries.map(entry => Object.freeze(entry)));
}

function attachedTerminal(value: unknown, requestDigest: string, selected: Operation) {
  const result = exactRecord(value, ["schema", "requestDigest", "operation", "ownerAttached", "confirmed"]);
  if (result.schema !== POSTGRES_OWNER_ATTACHED_TERMINAL_V1 || result.requestDigest !== requestDigest
    || result.operation !== selected || result.ownerAttached !== true || result.confirmed !== true) {
    throw sanitizedError("refused");
  }
}

function toolObservation(value: unknown): string {
  let result: Readonly<Record<string, unknown>>;
  try { result = plainRecord(value); }
  catch { throw sanitizedError("uncertain"); }
  if (result.outcome === "failed_before_effect") {
    if (Object.keys(result).length === 1) throw sanitizedError("refused");
    throw sanitizedError("uncertain");
  }
  try {
    const exact = exactRecord(value, ["outcome", "observationDigest"]);
    if (exact.outcome !== "succeeded") throw sanitizedError("uncertain");
    return digest(exact.observationDigest);
  } catch { throw sanitizedError("uncertain"); }
}

const requiredRoles = Object.freeze(new Map<string, boolean>([
  ["control_room_schema_owner", false],
  ["control_room_migrator", true],
  ["control_room_application", false],
  ["control_room_app", true],
  ["control_room_reader", false],
  ["control_room_backup", false],
  ["control_room_schedule_admissions", false],
  ["control_room_github_broker", false],
  ["control_room_scheduler", true],
]));

function substantiveEvidence(value: unknown,
  verifiedEntries: readonly PostgresVerifiedMigrationLedgerEntryV1[]): string {
  const evidence = exactRecord(value, ["ledger", "roles", "memberships", "grants", "rows", "schemaDigest", "databaseOwner"]);
  const migrations = verifiedEntries.filter(entry => entry.kind === "migrate");
  if (!Array.isArray(evidence.ledger) || evidence.ledger.length !== migrations.length || !Array.isArray(evidence.roles)
    || !Array.isArray(evidence.memberships) || !Array.isArray(evidence.grants) || evidence.grants.length < 1
    || !Array.isArray(evidence.rows) || evidence.databaseOwner !== "control_room_schema_owner") {
    throw sanitizedError("uncertain");
  }
  const schemaDigest = digest(evidence.schemaDigest);
  let previousPost: string | undefined;
  for (let index = 0; index < evidence.ledger.length; index += 1) {
    const raw = evidence.ledger[index], expected = migrations[index];
    const row = exactRecord(raw, ["filename", "digest", "ledger_order", "pre_schema_digest", "post_schema_digest"]);
    const pre = digest(row.pre_schema_digest), post = digest(row.post_schema_digest);
    if (row.filename !== expected?.file || row.ledger_order !== expected.order
      || row.digest !== `sha256:${expected.sha256}` || (previousPost !== undefined && pre !== previousPost)) {
      throw sanitizedError("uncertain");
    }
    previousPost = post;
  }
  if (previousPost !== schemaDigest) throw sanitizedError("uncertain");

  const roles = new Map<string, Readonly<Record<string, unknown>>>();
  let previousRole = "";
  for (const raw of evidence.roles) {
    const role = exactRecord(raw, ["rolname", "rolcanlogin", "rolcreatedb", "rolcreaterole", "rolsuper",
      "rolreplication", "rolbypassrls"]);
    if (typeof role.rolname !== "string" || !/^control_room_[a-z0-9_]+$/u.test(role.rolname)
      || role.rolname <= previousRole || typeof role.rolcanlogin !== "boolean"
      || role.rolcreatedb !== false || role.rolcreaterole !== false || role.rolsuper !== false
      || role.rolreplication !== false || role.rolbypassrls !== false) throw sanitizedError("uncertain");
    previousRole = role.rolname; roles.set(role.rolname, role);
  }
  for (const [name, canLogin] of requiredRoles) {
    if (roles.get(name)?.rolcanlogin !== canLogin) throw sanitizedError("uncertain");
  }

  const memberships: Array<Readonly<{ member: string; role: string; admin_option: false }>> = [];
  let previousMembership = "";
  for (const raw of evidence.memberships) {
    const membership = exactRecord(raw, ["member", "role", "admin_option"]);
    if (typeof membership.member !== "string" || typeof membership.role !== "string"
      || !/^control_room_[a-z0-9_]+$/u.test(membership.member)
      || !/^control_room_[a-z0-9_]+$/u.test(membership.role) || membership.member === membership.role
      || membership.admin_option !== false) throw sanitizedError("uncertain");
    const identity = `${membership.member}\0${membership.role}`;
    if (identity <= previousMembership) throw sanitizedError("uncertain");
    previousMembership = identity;
    memberships.push({ member: membership.member, role: membership.role, admin_option: false });
  }
  if (JSON.stringify(memberships) !== JSON.stringify(POSTGRES_PRODUCTION_MEMBERSHIPS_V1)) throw sanitizedError("uncertain");

  let previousGrant = "";
  for (const raw of evidence.grants) {
    const grant = exactRecord(raw, ["object", "owner", "acl"]);
    if (typeof grant.object !== "string" || !/^public\.[a-z0-9_]+$/u.test(grant.object)
      || grant.object <= previousGrant || grant.owner !== "control_room_schema_owner"
      || typeof grant.acl !== "string" || !matchesPostgresProductionAclV1(grant.object, grant.acl)) {
      throw sanitizedError("uncertain");
    }
    previousGrant = grant.object;
  }

  const rowTables = new Set<string>();
  for (const raw of evidence.rows) {
    const row = exactRecord(raw, ["table", "count", "hash"]);
    if (typeof row.table !== "string" || !/^[a-z0-9_]+$/u.test(row.table) || rowTables.has(row.table)
      || !Number.isSafeInteger(row.count) || (row.count as number) < 0) throw sanitizedError("uncertain");
    digest(row.hash); rowTables.add(row.table);
  }
  // Match deploy/postgres/evidence.mjs `digestOf`: the collector's ordered
  // evidence object is the existing database-evidence digest contract.
  return `sha256:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`;
}

function requestDigest(request: PostgresOwnerActionRequestV1): string {
  return sha256Digest({ purpose: "postgres-owner-action-request/v1", request });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(sanitizedError("uncertain"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(sanitizedError("uncertain"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function invokeControlled<T>(call: () => Promise<T>, signal: AbortSignal,
  thrown: "refused" | "uncertain"): Promise<T> {
  if (signal.aborted) throw sanitizedError(thrown);
  try {
    return await raceAbort(Promise.resolve().then(() => {
      if (signal.aborted) throw sanitizedError(thrown);
      return call();
    }), signal);
  }
  catch (error) { throw sanitizedError(failureKind(error) ?? thrown); }
}

async function cleanup(runtime: PrivatePostgresOwnerRuntimeV1): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(sanitizedError("uncertain")); }, runtime.cleanupDeadlineMs);
    });
    const result = await Promise.race([runtime.cleanup(controller.signal), deadline]);
    const parsed = exactRecord(result, ["outcome"]);
    return parsed.outcome === "confirmed";
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Executes exactly one selected PostgreSQL operation after byte verification
 * and owner-attached terminal confirmation. Provision and migration return a
 * non-terminal sanitized observation. Only substantive output from the
 * existing `collectDatabaseEvidence` function yields the terminal confirmation
 * accepted by the separate durable transaction boundary.
 */
async function runPrivatePostgresOwnerActionInternalV1(requestInput: unknown,
  runtimeInput: unknown): Promise<PrivatePostgresOwnerRunnerResultV1> {
  const request = verifiedRequest(requestInput), runtime = verifiedRuntime(runtimeInput);
  const preparedRequestDigest = requestDigest(request);
  const operationController = new AbortController();
  const abort = () => operationController.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listenerRegistered = false;
  let preAborted = false;
  let result: Omit<PrivatePostgresOwnerObservationV1, "cleanupConfirmed">
    | Omit<PrivatePostgresOwnerTerminalResultV1, "cleanupConfirmed"> | undefined;
  let failure: "refused" | "uncertain" | undefined;
  try {
    preAborted = runtime.signal.aborted;
    if (preAborted) throw sanitizedError("refused");
    runtime.signal.addEventListener("abort", abort, { once: true });
    listenerRegistered = true;
    if (runtime.signal.aborted) { operationController.abort(); throw sanitizedError("uncertain"); }
    timer = setTimeout(abort, runtime.controlDeadlineMs);
    const context = Object.freeze({ request, requestDigest: preparedRequestDigest, signal: operationController.signal });
    exactRelease(await invokeControlled(() => runtime.verifyExactRelease(runtime.privateConfiguration, context),
      operationController.signal, "refused"), request.releaseDigest);
    const ledgerEntries = exactLedger(await invokeControlled(() =>
      runtime.verifyExactMigrationLedger(runtime.privateConfiguration, context), operationController.signal, "refused"),
    request.ledgerDigest);
    attachedTerminal(await invokeControlled(() => runtime.confirmOwnerAttachedTerminal(context),
      operationController.signal, "refused"), preparedRequestDigest, request.operation);
    let observationDigest: string;
    if (request.operation === "owner_provision_database") {
      observationDigest = toolObservation(await invokeControlled(() =>
        runtime.provisionDatabase(runtime.privateConfiguration, context), operationController.signal, "uncertain"));
    } else if (request.operation === "apply_existing_migration_ledger") {
      observationDigest = toolObservation(await invokeControlled(() =>
        runtime.applyMigrations(runtime.privateConfiguration, context), operationController.signal, "uncertain"));
    } else {
      const evidence = await invokeControlled(() =>
        runtime.collectDatabaseEvidence(runtime.privateConfiguration, context), operationController.signal, "uncertain");
      try { observationDigest = substantiveEvidence(evidence, ledgerEntries); }
      catch { throw sanitizedError("uncertain"); }
    }
    if (request.operation === "collect_existing_database_evidence") {
      result = Object.freeze({ schema: PRIVATE_POSTGRES_OWNER_RUNNER_V1, requestDigest: preparedRequestDigest,
        operation: request.operation, disposition: "terminal_confirmation" as const, observationDigest,
        exactReleaseVerified: true as const, exactMigrationLedgerVerified: true as const,
        terminalConfirmation: Object.freeze({ schema: POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1,
          requestDigest: preparedRequestDigest, terminalEvidenceDigest: observationDigest,
          terminalState: "confirmed" as const }) });
    } else {
      result = Object.freeze({ schema: PRIVATE_POSTGRES_OWNER_RUNNER_V1, requestDigest: preparedRequestDigest,
        operation: request.operation, disposition: "intermediate_observation" as const, observationDigest,
        exactReleaseVerified: true as const, exactMigrationLedgerVerified: true as const,
        terminalConfirmation: null });
    }
  } catch (error) {
    failure = failureKind(error) ?? (operationController.signal.aborted ? "uncertain" : "refused");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const cleanupConfirmed = await cleanup(runtime);
  let cancelledAfterCleanup = false;
  try {
    cancelledAfterCleanup = runtime.signal.aborted || operationController.signal.aborted;
    if (listenerRegistered) runtime.signal.removeEventListener("abort", abort);
    cancelledAfterCleanup ||= runtime.signal.aborted || operationController.signal.aborted;
  } catch { failure = "uncertain"; }
  if (cancelledAfterCleanup && !preAborted) failure = "uncertain";
  if (!cleanupConfirmed || failure || !result) throw sanitizedError(!cleanupConfirmed || failure === "uncertain" ? "uncertain" : "refused");
  return Object.freeze({ ...result, cleanupConfirmed: true as const }) as PrivatePostgresOwnerRunnerResultV1;
}

export async function runPrivatePostgresOwnerActionV1(requestInput: unknown,
  runtimeInput: unknown): Promise<PrivatePostgresOwnerRunnerResultV1> {
  try { return await runPrivatePostgresOwnerActionInternalV1(requestInput, runtimeInput); }
  catch (error) { throw sanitizedError(failureKind(error) ?? "refused"); }
}
