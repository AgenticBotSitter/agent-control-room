import { sha256Digest } from "../../security/canonical-digest";
import { type PostgresOwnerRunnerContextV1, type PostgresOwnerToolObservationV1,
  type PrivatePostgresOwnerRuntimeV1 } from "./private-postgres-owner-runner";

/**
 * Private binding from the reviewed owner runner to the existing PostgreSQL
 * deployment tools. It owns no credential source and opens no process or
 * connection itself. An installation-specific custody handle and tool
 * boundary are injected by private composition code.
 */
export const PRIVATE_POSTGRES_OWNER_ADAPTER_V1 =
  "control-room.private-postgres-owner-adapter/v1" as const;
export const PRIVATE_POSTGRES_CONFIGURATION_V1 =
  "control-room.private-postgres-owner-configuration/v1" as const;
export const PRIVATE_POSTGRES_REVIEWED_FILES_V1 =
  "control-room.private-postgres-reviewed-files/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const fixedPaths = Object.freeze({
  provision: "deploy/postgres/provision-database.sql",
  migrations: "deploy/postgres/apply-migrations.mjs",
  evidence: "deploy/postgres/evidence.mjs",
  ledger: "deploy/postgres/migration-ledger.json",
});

type Target = Readonly<{
  host: "127.0.0.1";
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false;
  sslnegotiation: "postgres";
  client_encoding: "UTF8";
  replication: "false";
  target_session_attrs: "primary";
  application_name: "control-room-owner-bootstrap" | "control-room-owner-migrate" | "control-room-owner-evidence";
  options: "-c search_path=pg_catalog,\\ public -c timezone=UTC";
  statement_timeout: 120000;
  lock_timeout: 5000;
  idle_in_transaction_session_timeout: 15000;
  connectionTimeoutMillis: 5000;
  keepAlive: true;
  binary: false;
}>;

export type PrivatePostgresOwnerConfigurationV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_CONFIGURATION_V1;
  majorVersion: 17;
  host: "127.0.0.1";
  port: number;
  database: string;
  maintenanceDatabase: string;
  operator: Readonly<{ username: string; password: string }>;
  migratorPassword: string;
  applicationPassword: string;
  schedulerPassword: string;
  requiredTables: readonly string[];
}>;

export type PrivatePostgresReviewedFilesV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_REVIEWED_FILES_V1;
  releaseDigest: string;
  files: Readonly<{
    provision: Readonly<{ path: typeof fixedPaths.provision; sha256: string }>;
    migrations: Readonly<{ path: typeof fixedPaths.migrations; sha256: string }>;
    evidence: Readonly<{ path: typeof fixedPaths.evidence; sha256: string }>;
    ledger: Readonly<{ path: typeof fixedPaths.ledger; sha256: string }>;
  }>;
}>;

export type PrivatePostgresConfigurationCustodyV1 = Readonly<{
  /** Supplies private material only for the duration of one callback. */
  withConfiguration: <T>(signal: AbortSignal,
    use: (configuration: unknown) => Promise<T>) => Promise<T>;
  close: (signal: AbortSignal) => Promise<void>;
}>;

type FileBinding = Readonly<{ path: string; sha256: string }>;
type CommonToolRequest = Readonly<{
  schema: typeof PRIVATE_POSTGRES_OWNER_ADAPTER_V1;
  releaseDigest: string;
  requestDigest: string;
  files: readonly FileBinding[];
}>;

export type PrivatePostgresProvisionRequestV1 = CommonToolRequest & Readonly<{
  operation: "provision_database";
  executable: "psql";
  args: readonly string[];
  environmentMode: "replace";
  env: Readonly<{
    PGPASSWORD: string;
    PGSSLMODE: "disable";
    PGAPPNAME: "control-room-owner-provision";
    PGOPTIONS: "-c search_path=pg_catalog, public -c timezone=UTC";
    PGCLIENTENCODING: "UTF8";
    PGREPLICATION: "false";
    PGCONNECT_TIMEOUT: "5";
  }>;
}>;

export type PrivatePostgresMigrationRequestV1 = CommonToolRequest & Readonly<{
  operation: "apply_migrations";
  module: typeof fixedPaths.migrations;
  exportName: "applyMigrations";
  /** The module host must replace, not inherit, process.env for this call. */
  environmentMode: "replace";
  bootstrapTarget: Target;
  migrateTarget: Target;
  ledgerPath: typeof fixedPaths.ledger;
  env: Readonly<{
    CONTROL_ROOM_MIGRATOR_PASSWORD: string;
    CONTROL_ROOM_APP_PASSWORD: string;
    CONTROL_ROOM_SCHEDULER_PASSWORD?: string;
  }>;
}>;

export type PrivatePostgresEvidenceRequestV1 = CommonToolRequest & Readonly<{
  operation: "collect_evidence";
  module: typeof fixedPaths.evidence;
  exportName: "collectDatabaseEvidence";
  /** The module host must replace process.env with this exact empty object. */
  environmentMode: "replace";
  env: Readonly<Record<string, never>>;
  target: Target;
  requiredTables: readonly string[];
}>;

export type PrivatePostgresOwnerToolBoundaryV1 = Readonly<{
  provisionDatabase: (request: PrivatePostgresProvisionRequestV1, signal: AbortSignal) =>
    Promise<Readonly<{ outcome: "succeeded"; exitCode: 0 }> | Readonly<{ outcome: "failed_before_effect" }>>;
  applyMigrations: (request: PrivatePostgresMigrationRequestV1, signal: AbortSignal) =>
    Promise<Readonly<{ outcome: "succeeded"; result: unknown }> | Readonly<{ outcome: "failed_before_effect" }>>;
  collectDatabaseEvidence: (request: PrivatePostgresEvidenceRequestV1, signal: AbortSignal) => Promise<unknown>;
  cleanup: (signal: AbortSignal) => Promise<void>;
}>;

type BaseRuntime = Pick<PrivatePostgresOwnerRuntimeV1, "signal" | "controlDeadlineMs" | "cleanupDeadlineMs"
  | "verifyExactRelease" | "verifyExactMigrationLedger" | "confirmOwnerAttachedTerminal">;

const refused = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };
function sanitized(kind: "refused" | "uncertain") {
  const error = new Error(`private_postgres_owner_adapter_${kind}`);
  error.stack = undefined;
  return error;
}

function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))
    || keys.some(name => !names.includes(name)) || keys.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function exactDenseArray(value: unknown, maximum: number, failure: () => never = uncertain): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum) return failure();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes("length")) return failure();
  const captured: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const name = String(index), descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return failure();
    captured.push(descriptor.value);
  }
  if (names.some(name => name !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(name)
    || Number(name) >= value.length))) return failure();
  return Object.freeze(captured);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) return refused();
  return value;
}

function secret(value: unknown): string {
  if (typeof value !== "string" || value.length < 24 || value.length > 4096 || value.includes("\0")) return refused();
  return value;
}

function configuration(value: unknown): PrivatePostgresOwnerConfigurationV1 {
  const input = exactRecord(value, ["schema", "majorVersion", "host", "port", "database", "maintenanceDatabase",
    "operator", "migratorPassword", "applicationPassword", "schedulerPassword", "requiredTables"]);
  if (input.schema !== PRIVATE_POSTGRES_CONFIGURATION_V1 || input.majorVersion !== 17 || input.host !== "127.0.0.1"
    || !Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65535) return refused();
  const operator = exactRecord(input.operator, ["username", "password"]);
  const required = exactDenseArray(input.requiredTables, 64, refused);
  if (required.length < 1) return refused();
  const requiredTables = required.map(identifier);
  if (new Set(requiredTables).size !== requiredTables.length) return refused();
  const schedulerPassword = secret(input.schedulerPassword);
  return Object.freeze({ schema: PRIVATE_POSTGRES_CONFIGURATION_V1, majorVersion: 17, host: "127.0.0.1",
    port: input.port as number, database: identifier(input.database), maintenanceDatabase: identifier(input.maintenanceDatabase),
    operator: Object.freeze({ username: identifier(operator.username), password: secret(operator.password) }),
    migratorPassword: secret(input.migratorPassword), applicationPassword: secret(input.applicationPassword), schedulerPassword,
    requiredTables: Object.freeze(requiredTables) });
}

function reviewedFiles(value: unknown): PrivatePostgresReviewedFilesV1 {
  const input = exactRecord(value, ["schema", "releaseDigest", "files"]);
  if (input.schema !== PRIVATE_POSTGRES_REVIEWED_FILES_V1) return refused();
  const files = exactRecord(input.files, ["provision", "migrations", "evidence", "ledger"]);
  const parsed = Object.fromEntries(Object.entries(fixedPaths).map(([name, path]) => {
    const file = exactRecord(files[name], ["path", "sha256"]);
    if (file.path !== path || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) return refused();
    return [name, Object.freeze({ path, sha256: file.sha256 })];
  })) as PrivatePostgresReviewedFilesV1["files"];
  return Object.freeze({ schema: PRIVATE_POSTGRES_REVIEWED_FILES_V1,
    releaseDigest: digest(input.releaseDigest), files: Object.freeze(parsed) });
}

function dependencies(value: unknown): Readonly<{
  custody: PrivatePostgresConfigurationCustodyV1;
  tools: PrivatePostgresOwnerToolBoundaryV1;
  reviewedFiles: PrivatePostgresReviewedFilesV1;
  baseRuntime: BaseRuntime;
}> {
  const input = exactRecord(value, ["custody", "tools", "reviewedFiles", "baseRuntime"]);
  const custody = exactRecord(input.custody, ["withConfiguration", "close"]);
  const tools = exactRecord(input.tools, ["provisionDatabase", "applyMigrations", "collectDatabaseEvidence", "cleanup"]);
  const base = exactRecord(input.baseRuntime, ["signal", "controlDeadlineMs", "cleanupDeadlineMs", "verifyExactRelease",
    "verifyExactMigrationLedger", "confirmOwnerAttachedTerminal"]);
  if (typeof custody.withConfiguration !== "function" || typeof custody.close !== "function"
    || ["provisionDatabase", "applyMigrations", "collectDatabaseEvidence", "cleanup"].some(name => typeof tools[name] !== "function")
    || !base.signal || typeof base.signal !== "object" || typeof base.verifyExactRelease !== "function"
    || typeof base.verifyExactMigrationLedger !== "function" || typeof base.confirmOwnerAttachedTerminal !== "function"
    || !Number.isSafeInteger(base.controlDeadlineMs) || (base.controlDeadlineMs as number) < 1
    || !Number.isSafeInteger(base.cleanupDeadlineMs) || (base.cleanupDeadlineMs as number) < 1) return refused();
  return Object.freeze({ custody: custody as unknown as PrivatePostgresConfigurationCustodyV1,
    tools: tools as unknown as PrivatePostgresOwnerToolBoundaryV1, reviewedFiles: reviewedFiles(input.reviewedFiles),
    baseRuntime: base as unknown as BaseRuntime });
}

function fileBindings(reviewed: PrivatePostgresReviewedFilesV1): readonly FileBinding[] {
  return Object.freeze([reviewed.files.provision, reviewed.files.migrations, reviewed.files.evidence, reviewed.files.ledger]
    .map(file => Object.freeze({ path: file.path, sha256: file.sha256 })));
}

function target(config: PrivatePostgresOwnerConfigurationV1, database: string, user: string, password: string,
  application_name: Target["application_name"]): Target {
  return Object.freeze({ host: config.host, port: config.port, database, user, password,
    ssl: false as const, sslnegotiation: "postgres" as const, client_encoding: "UTF8" as const,
    replication: "false" as const, target_session_attrs: "primary" as const, application_name,
    options: "-c search_path=pg_catalog,\\ public -c timezone=UTC" as const,
    statement_timeout: 120000 as const, lock_timeout: 5000 as const,
    idle_in_transaction_session_timeout: 15000 as const, connectionTimeoutMillis: 5000 as const,
    keepAlive: true as const, binary: false as const });
}

function common(context: PostgresOwnerRunnerContextV1, reviewed: PrivatePostgresReviewedFilesV1): CommonToolRequest {
  if (context.request.releaseDigest !== reviewed.releaseDigest) return refused();
  return Object.freeze({ schema: PRIVATE_POSTGRES_OWNER_ADAPTER_V1, releaseDigest: reviewed.releaseDigest,
    requestDigest: digest(context.requestDigest), files: fileBindings(reviewed) });
}

function isExactFailedBeforeEffect(value: unknown): boolean {
  try { return exactRecord(value, ["outcome"]).outcome === "failed_before_effect"; }
  catch { return false; }
}

function provisionObservation(value: unknown, body: unknown): PostgresOwnerToolObservationV1 {
  if (isExactFailedBeforeEffect(value)) return Object.freeze({ outcome: "failed_before_effect" as const });
  let result: Readonly<Record<string, unknown>>;
  try { result = exactRecord(value, ["outcome", "exitCode"]); }
  catch { return uncertain(); }
  if (result.outcome !== "succeeded" || result.exitCode !== 0) return uncertain();
  return Object.freeze({ outcome: "succeeded" as const,
    observationDigest: sha256Digest({ purpose: "private-postgres-tool-observation/v1", body }) });
}

function migrationToolObservation(value: unknown, body: unknown): PostgresOwnerToolObservationV1 {
  if (isExactFailedBeforeEffect(value)) return Object.freeze({ outcome: "failed_before_effect" as const });
  let result: Readonly<Record<string, unknown>>;
  try { result = exactRecord(value, ["outcome", "result"]); }
  catch { return uncertain(); }
  if (result.outcome !== "succeeded") return uncertain();
  const migration = migrationObservation(result.result);
  return Object.freeze({ outcome: "succeeded" as const,
    observationDigest: sha256Digest({ purpose: "private-postgres-tool-observation/v1",
      body: { ...body as Readonly<Record<string, unknown>>, result: migration } }) });
}

type MigrationObservation = Readonly<{
  planned: false;
  applied: readonly Readonly<{ file: string; order: number; preSchemaDigest: string; postSchemaDigest: string }>[];
  noOp: boolean;
  schemaDigest: string;
  objects: number;
  logins: "applied";
  grants: "applied";
}>;

function migrationObservation(value: unknown): MigrationObservation {
  const result = exactRecord(value, ["planned", "applied", "noOp", "schemaDigest", "objects", "logins", "grants"]);
  const rawApplied = exactDenseArray(result.applied, 10000);
  if (result.planned !== false || typeof result.noOp !== "boolean" || result.noOp !== (rawApplied.length === 0)
    || !Number.isSafeInteger(result.objects) || (result.objects as number) < 0 || (result.objects as number) > 10_000_000
    || result.logins !== "applied" || result.grants !== "applied") return uncertain();
  const seenFiles = new Set<string>(), seenOrders = new Set<number>();
  let priorOrder = 0;
  const applied: MigrationObservation["applied"][number][] = [];
  for (const value of rawApplied) {
    const entry = exactRecord(value, ["file", "order", "preSchemaDigest", "postSchemaDigest"]);
    if (typeof entry.file !== "string" || entry.file.length > 256
      || !/^db\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/u.test(entry.file)
      || !Number.isSafeInteger(entry.order) || (entry.order as number) < 1 || (entry.order as number) > 10000
      || (entry.order as number) <= priorOrder || seenFiles.has(entry.file) || seenOrders.has(entry.order as number)) return uncertain();
    const normalized = Object.freeze({ file: entry.file, order: entry.order as number,
      preSchemaDigest: digest(entry.preSchemaDigest), postSchemaDigest: digest(entry.postSchemaDigest) });
    priorOrder = normalized.order; seenFiles.add(normalized.file); seenOrders.add(normalized.order);
    applied.push(normalized);
  }
  return Object.freeze({ planned: false, applied: Object.freeze(applied), noOp: result.noOp,
    schemaDigest: digest(result.schemaDigest), objects: result.objects as number, logins: "applied", grants: "applied" });
}

/**
 * Composes the accepted runner runtime with private custody and existing-tool
 * ports. The opaque marker satisfies the runner's configuration slot; actual
 * secrets are lent by custody only inside each tool callback and are closed by
 * the runner's bounded cleanup phase.
 */
export function createPrivatePostgresOwnerAdapterV1(input: unknown): PrivatePostgresOwnerRuntimeV1 {
  let parsed: ReturnType<typeof dependencies>;
  try { parsed = dependencies(input); } catch { return refused(); }
  const { custody, tools, reviewedFiles: reviewed, baseRuntime } = parsed;
  const marker = Object.freeze({ schema: PRIVATE_POSTGRES_OWNER_ADAPTER_V1 });
  const adapterController = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closed = false, cleanupConfirmed = false;
  const use = async <T>(context: PostgresOwnerRunnerContextV1,
    callback: (config: PrivatePostgresOwnerConfigurationV1, signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (closed || context.signal.aborted) return refused();
    const operationController = new AbortController();
    const abort = () => operationController.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    adapterController.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted || adapterController.signal.aborted) operationController.abort();
    const operation = (async () => {
      const loanMarker = Object.freeze({});
      let entered = false;
      try {
        const returned = await custody.withConfiguration(operationController.signal, async raw => {
          if (entered || closed || operationController.signal.aborted) return uncertain();
          entered = true;
          const config = configuration(raw);
          if (closed || operationController.signal.aborted) return uncertain();
          return Object.freeze({ loanMarker, value: await callback(config, operationController.signal) });
        });
        if (!entered || closed || operationController.signal.aborted || !returned || typeof returned !== "object"
          || Array.isArray(returned) || (returned as { loanMarker?: unknown }).loanMarker !== loanMarker
          || !Object.prototype.hasOwnProperty.call(returned, "value")) return uncertain();
        return (returned as { value: T }).value;
      } catch (error) {
        if (!closed && !operationController.signal.aborted && error instanceof Error
          && error.message === "private_postgres_owner_adapter_refused") throw error;
        return uncertain();
      } finally {
        context.signal.removeEventListener("abort", abort);
        adapterController.signal.removeEventListener("abort", abort);
      }
    })();
    active.add(operation);
    void operation.catch(() => {}).finally(() => active.delete(operation));
    return operation;
  };
  return Object.freeze({ ...baseRuntime, privateConfiguration: marker,
    async provisionDatabase(value: unknown, context: PostgresOwnerRunnerContextV1) {
      if (value !== marker) return refused();
      const shared = common(context, reviewed);
      return use(context, async (config, signal) => {
        const args = Object.freeze(["-v", "ON_ERROR_STOP=1", "-v", `dbname=${config.database}`, "-f",
          fixedPaths.provision, "-h", config.host, "-p", String(config.port), "-U", config.operator.username,
          "-d", config.maintenanceDatabase]);
        const request = Object.freeze({ ...shared, operation: "provision_database" as const, executable: "psql" as const,
          args, environmentMode: "replace" as const, env: Object.freeze({ PGPASSWORD: config.operator.password,
            PGSSLMODE: "disable" as const, PGAPPNAME: "control-room-owner-provision" as const,
            PGOPTIONS: "-c search_path=pg_catalog, public -c timezone=UTC" as const,
            PGCLIENTENCODING: "UTF8" as const, PGREPLICATION: "false" as const, PGCONNECT_TIMEOUT: "5" as const }) });
        try {
          if (closed || signal.aborted) return uncertain();
          const result = await tools.provisionDatabase(request, signal);
          return provisionObservation(result, { operation: request.operation, requestDigest: request.requestDigest,
            releaseDigest: request.releaseDigest, files: request.files, exitCode: 0 });
        } catch { return uncertain(); }
      });
    },
    async applyMigrations(value: unknown, context: PostgresOwnerRunnerContextV1) {
      if (value !== marker) return refused();
      const shared = common(context, reviewed);
      return use(context, async (config, signal) => {
        const request = Object.freeze({ ...shared, operation: "apply_migrations" as const,
          module: fixedPaths.migrations, exportName: "applyMigrations" as const, environmentMode: "replace" as const,
          bootstrapTarget: target(config, config.database, config.operator.username, config.operator.password,
            "control-room-owner-bootstrap"),
          migrateTarget: target(config, config.database, "control_room_migrator", config.migratorPassword,
            "control-room-owner-migrate"),
          ledgerPath: fixedPaths.ledger,
          env: Object.freeze({ CONTROL_ROOM_MIGRATOR_PASSWORD: config.migratorPassword,
            CONTROL_ROOM_APP_PASSWORD: config.applicationPassword,
            CONTROL_ROOM_SCHEDULER_PASSWORD: config.schedulerPassword }) });
        try {
          if (closed || signal.aborted) return uncertain();
          const result = await tools.applyMigrations(request, signal);
          return migrationToolObservation(result, { operation: request.operation, requestDigest: request.requestDigest,
            releaseDigest: request.releaseDigest, files: request.files });
        } catch { return uncertain(); }
      });
    },
    async collectDatabaseEvidence(value: unknown, context: PostgresOwnerRunnerContextV1) {
      if (value !== marker) return refused();
      const shared = common(context, reviewed);
      return use(context, async (config, signal) => {
        const request = Object.freeze({ ...shared, operation: "collect_evidence" as const,
          module: fixedPaths.evidence, exportName: "collectDatabaseEvidence" as const,
          environmentMode: "replace" as const, env: Object.freeze({}),
          target: target(config, config.database, "control_room_migrator", config.migratorPassword,
            "control-room-owner-evidence"),
          requiredTables: config.requiredTables });
        try {
          if (closed || signal.aborted) return uncertain();
          return await tools.collectDatabaseEvidence(request, signal);
        }
        catch { return uncertain(); }
      });
    },
    async cleanup(signal: AbortSignal) {
      if (closed) {
        if (!cleanupConfirmed) return uncertain();
        return Object.freeze({ outcome: "confirmed" as const });
      }
      closed = true;
      adapterController.abort();
      const settleBeforeAbort = async (promise: Promise<unknown>): Promise<boolean> => {
        if (signal.aborted) return false;
        let abort: (() => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(sanitized("uncertain"));
          signal.addEventListener("abort", abort, { once: true });
        });
        try { await Promise.race([promise, cancelled]); return true; }
        catch { return false; }
        finally { if (abort) signal.removeEventListener("abort", abort); }
      };
      let toolCleanup: Promise<void>;
      try { toolCleanup = Promise.resolve(tools.cleanup(signal)); }
      catch (error) { toolCleanup = Promise.reject(error); }
      void toolCleanup.catch(() => {});
      let activeSettled = false;
      try {
        const pending = [...active];
        activeSettled = pending.length === 0 || await settleBeforeAbort(Promise.allSettled(pending));
        if (activeSettled) pending.forEach(operation => active.delete(operation));
      } catch { activeSettled = false; }
      let custodyClose: Promise<void>;
      try { custodyClose = Promise.resolve(custody.close(signal)); }
      catch (error) { custodyClose = Promise.reject(error); }
      void custodyClose.catch(() => {});
      const custodyClosed = await settleBeforeAbort(custodyClose);
      const toolClosed = await settleBeforeAbort(toolCleanup);
      if (!toolClosed || !activeSettled || !custodyClosed || signal.aborted || active.size > 0) return uncertain();
      cleanupConfirmed = true;
      return Object.freeze({ outcome: "confirmed" as const });
    },
  });
}
