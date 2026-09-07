import { createHash } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { createPrivatePostgresDatabase, privatePostgresOptions, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "./private-postgres";
import { privateWebSchemaDigest, readPrivateWebSchemaDigest } from "./private-database-preflight";
import { rehearsalScopeDigest, type RehearsalMaterial } from "./private-database-rehearsal";
import { buildPrivateRehearsalFixture } from "./private-rehearsal-fixture";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), tree: z.string().regex(/^[a-f0-9]{40}$/), artifactDigest: digest }).strict();
const packetSchema = z.object({ manifest: manifestSchema, migratorScopeDigest: digest, webScopeDigest: digest,
  ownerApprovalDigest: digest, cleanupPlanDigest: digest, pgPackageDigest: digest,
  pgVersionNumber: z.number().int().min(170000).max(179999), expiresAt: z.number().int().positive(),
  durationMs: z.number().int().min(10_000).max(60_000), dedicatedEmptyDatabase: z.literal(true),
  migrationsApplied: z.literal("0001-0054"), setupRolesAccepted: z.literal(true),
  maximumConnections: z.literal(1), maximumTransactions: z.literal(1), maximumStatements: z.literal(256),
  installOrProvision: z.literal(false), automaticRetry: z.literal(false),
  cleanup: z.literal("close_owned_client_then_operator_database_cleanup"),
}).strict();
export type FixturePreparationPacket = z.infer<typeof packetSchema>;
export type PrivateDatabaseCoordinates = Omit<PrivatePostgresConfiguration, "password">;
export interface FixturePreparationInput {
  manifest: z.infer<typeof manifestSchema>; packet: FixturePreparationPacket;
  migrator: PrivatePostgresConfiguration; webDatabase: PrivateDatabaseCoordinates; signal?: AbortSignal;
}
export interface FixturePreparationEvidence {
  contract: "cr14b-disposable-fixture-preparation/v1"; execution: "native_postgres" | "injected_test";
  disposition: "setup_incomplete" | "stopped" | "fixture_prepared" | "cleanup_uncertain" | "already_attempted";
  manifest: z.infer<typeof manifestSchema> | null; schemaDigest: string; scopeDigest: string | null;
  poolCreated: boolean; poolClosed: boolean; transactionStatementsIssued: number;
  fixtureCounts: { tenant: number; owner: number; workspace: number; idea: number; enrollment: number; signal: number };
  handoffStartBy: number | null;
  physicalConnectionAttempts: "not_observed"; databaseCleanup: "operator_owned";
  databaseProvisioned: false; schemaMigrated: false; rolesModified: false; realPostgresAccepted: false;
}
export interface FixturePreparationResult {
  evidence: FixturePreparationEvidence;
  preparationDigest: string;
  /** Available once, only after an acknowledged seed commit and successful owned-client shutdown.
   * Returned synthetic assertion/keys are private handoff inputs, not retained evidence.
   */
  takeMaterial?: () => RehearsalMaterial;
}
type Pool = ReturnType<typeof createPrivatePostgresDatabase>;
interface Dependencies { openDatabase(config: PrivatePostgresConfiguration): Pool; clock(): number; monotonic(): number }
const ensure = (condition: unknown) => { if (condition !== true) throw new Error("fixture_preparation_failed"); };

/** Pure target binding; not host attestation or an approval signature. */
export function fixtureMigratorScopeDigest(config: PrivatePostgresConfiguration) {
  const value = validatePrivatePostgresConfiguration(config);
  return sha({ host: value.host, port: value.port, database: value.database, username: value.username, majorVersion: value.majorVersion });
}
export function fixturePreparationPostgresOptions(config: PrivatePostgresConfiguration) {
  const options = privatePostgresOptions(config);
  return { ...options, max: 1, connection: { ...options.connection, application_name: "control-room-rehearsal-setup" } };
}

function createPreparation(dependencies: Dependencies, execution: FixturePreparationEvidence["execution"]) {
  let attempted = false;
  return Object.freeze({ async prepare(input: FixturePreparationInput): Promise<FixturePreparationResult> {
    const evidence: FixturePreparationEvidence = { contract: "cr14b-disposable-fixture-preparation/v1", execution,
      disposition: "setup_incomplete", manifest: null, schemaDigest: privateWebSchemaDigest, scopeDigest: null,
      poolCreated: false, poolClosed: false, transactionStatementsIssued: 0,
      fixtureCounts: { tenant: 0, owner: 0, workspace: 0, idea: 0, enrollment: 0, signal: 0 }, handoffStartBy: null,
      physicalConnectionAttempts: "not_observed", databaseCleanup: "operator_owned", databaseProvisioned: false,
      schemaMigrated: false, rolesModified: false, realPostgresAccepted: false };
    const result = (): FixturePreparationResult => {
      Object.freeze(evidence.manifest); Object.freeze(evidence.fixtureCounts); Object.freeze(evidence);
      return Object.freeze({ evidence, preparationDigest: sha(evidence) });
    };
    if (attempted) { evidence.disposition = "already_attempted"; return result(); }
    attempted = true;
    const clock = dependencies.clock, started = clock(), began = dependencies.monotonic();
    let packet: FixturePreparationPacket, config: PrivatePostgresConfiguration;
    const signal = input?.signal;
    try {
      packet = packetSchema.parse(input.packet); config = validatePrivatePostgresConfiguration(input.migrator);
      const web = validatePrivatePostgresConfiguration({ ...input.webDatabase, password: "coordinates-only-not-a-credential" });
      ensure(sha(manifestSchema.parse(input.manifest)) === sha(packet.manifest));
      ensure(/^cr14b_rehearsal_[a-z0-9_]{1,40}$/.test(config.database));
      ensure(config.host === web.host && config.port === web.port && config.database === web.database && config.username !== web.username);
      ensure(packet.migratorScopeDigest === fixtureMigratorScopeDigest(config) && packet.webScopeDigest === rehearsalScopeDigest(web));
      ensure(Number.isSafeInteger(started) && Number.isFinite(began) && packet.expiresAt >= started + packet.durationMs && !signal?.aborted);
      evidence.manifest = packet.manifest; evidence.scopeDigest = packet.webScopeDigest;
    } catch { return result(); }
    let stopped = false, pool: Pool | undefined, fixture: ReturnType<typeof buildPrivateRehearsalFixture> | undefined;
    const checkpoint = () => {
      if (stopped || signal?.aborted || clock() < started || clock() >= packet.expiresAt
        || dependencies.monotonic() - began >= packet.durationMs - 5000) throw new Error("fixture_preparation_stopped");
    };
    let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
    try {
      checkpoint(); pool = dependencies.openDatabase(config); evidence.poolCreated = true;
      const limit = new Promise<never>((_, reject) => { abort = () => { stopped = true; reject(new Error("fixture_preparation_stopped")); };
        timer = setTimeout(abort, Math.max(1, packet.durationMs - 5000 - (dependencies.monotonic() - began))); });
      signal?.addEventListener("abort", abort, { once: true });
      await Promise.race([pool.client.transactionWithPreCommitCheck(async original => {
        const tx: DatabaseSession = Object.freeze({ query: async <T>(statement: string, params?: unknown[]) => {
          checkpoint(); ensure(++evidence.transactionStatementsIssued <= 256);
          const value = await original.query<T>(statement, params); checkpoint(); return value;
        } });
        const metadata = (await tx.query<{ valid: boolean }>(`SELECT current_user=session_user AND current_user=$1
          AND current_database()=$2 AND current_setting('server_version_num')::integer=$3 AND NOT pg_is_in_recovery()
          AND current_setting('search_path')='pg_catalog, public' AND current_setting('statement_timeout')='5s'
          AND current_setting('lock_timeout')='2s' AND current_setting('transaction_timeout')='10s'
          AND current_setting('idle_in_transaction_session_timeout')='5s' AND current_setting('transaction_read_only')='off'
          AND current_setting('session_replication_role')='origin'
          AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin AND rolinherit
            AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
          AND NOT pg_has_role(current_user,'control_room_private_web','MEMBER')
          AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS valid`,
        [config.username, config.database, packet.pgVersionNumber])).rows[0];
        ensure(metadata?.valid === true); ensure(await readPrivateWebSchemaDigest(tx) === privateWebSchemaDigest);
        const tables = (await tx.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C"`)).rows;
        ensure(tables.length === 138 && tables.every(table => /^[a-z][a-z0-9_]{0,62}$/.test(table.name)));
        // The reviewed schema fingerprint precedes catalog-derived identifier construction. Names are
        // validated and quoted; no caller supplies a table or SQL fragment. Locks serialize empty checks
        // and all seed writes, preventing two preparers from adopting the same initially empty database.
        const names = tables.map(table => `public."${table.name}"`);
        await tx.query(`LOCK TABLE ${names.join(", ")} IN ACCESS EXCLUSIVE MODE`);
        // Recheck under the table locks: waiting for them must not turn a pre-lock schema
        // fingerprint into permission to seed a table changed by another setup session.
        ensure(await readPrivateWebSchemaDigest(tx) === privateWebSchemaDigest);
        const empty = (await tx.query<{ empty: boolean }>(`SELECT NOT bool_or(present) AS empty FROM (${names.map(name =>
          `SELECT EXISTS(SELECT 1 FROM ${name} LIMIT 1) AS present`).join(" UNION ALL ")}) presence`)).rows[0];
        ensure(empty?.empty === true);
        fixture = buildPrivateRehearsalFixture(clock()); checkpoint(); await fixture.seed(tx);
        const counts = (await tx.query<{ tenant: string; owner: string; workspace: string; idea: string; enrollment: string; signal: string }>(`SELECT
          (SELECT count(*)::text FROM tenants) AS tenant, (SELECT count(*)::text FROM control_identities) AS owner,
          (SELECT count(*)::text FROM workspaces) AS workspace, (SELECT count(*)::text FROM projects) AS idea,
          (SELECT count(*)::text FROM control_connection_enrollments) AS enrollment,
          (SELECT count(*)::text FROM control_connection_authenticated_telemetry_receipts) AS signal`)).rows[0];
        ensure(counts && Object.values(counts).every(value => value === "1"));
      }, checkpoint), limit]);
      checkpoint(); evidence.disposition = "fixture_prepared";
      evidence.fixtureCounts = { tenant: 1, owner: 1, workspace: 1, idea: 1, enrollment: 1, signal: 1 };
      evidence.handoffStartBy = Date.parse(fixture!.signalExpiresAt) - 60_000;
    } catch { evidence.disposition = "stopped"; }
    finally {
      stopped = true; clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort);
      if (pool) {
        try { await pool.close(); evidence.poolClosed = true; }
        catch { evidence.disposition = "cleanup_uncertain"; }
      }
    }
    if (evidence.disposition !== "fixture_prepared") { fixture = undefined; return result(); }
    let material: RehearsalMaterial | undefined = fixture!.material; fixture = undefined;
    const handoffStartBy = evidence.handoffStartBy!;
    const completed = result();
    return Object.freeze({ ...completed, takeMaterial: () => {
      const value = material; material = undefined;
      if (!value || clock() < started || clock() >= handoffStartBy) throw new Error("fixture_handoff_unavailable");
      return value;
    } });
  } });
}

/** Explicit operator effect only; no env/credential loading, provisioning, DDL or import-time I/O. */
export function createNativePrivateFixturePreparation() {
  return createPreparation({ openDatabase: config => createPrivatePostgresDatabase(config,
    () => postgres(fixturePreparationPostgresOptions(config))), clock: Date.now, monotonic: () => performance.now() }, "native_postgres");
}
export function createInjectedPrivateFixturePreparation(dependencies: Dependencies) {
  return createPreparation(dependencies, "injected_test");
}
