import { createHash } from "node:crypto";
import { z } from "zod";
import { createAccessVerifier, type AccessTrust } from "./access-verifier";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { verifyPrivateDatabase, privateWebSchemaDigest } from "./private-database-preflight";
import { createPrivateWebBootstrap } from "./private-startup";
import { createPrivateWebProcess } from "./private-process";
import { PrivateDatabaseError } from "./bounded-database";
import { createRehearsalProbe, type RehearsalProbe } from "./private-rehearsal-probe";
import { checkProtectedColumns, checkPostgresLimits, rehearsalCheckNames, type RehearsalCheck } from "./private-rehearsal-checks";
import { projectCatalogPageSchema, webProjectSchema } from "./project-wire";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), tree: z.string().regex(/^[a-f0-9]{40}$/), artifactDigest: digest }).strict();
const packetSchema = z.object({ manifest: manifestSchema, scopeDigest: digest, preparationDigest: digest,
  ownerApprovalDigest: digest, cleanupPlanDigest: digest, pgPackageDigest: digest,
  pgVersionNumber: z.number().int().min(170000).max(179999),
  expiresAt: z.number().int().positive(), durationMs: z.number().int().min(60_000).max(900_000),
  dedicatedSyntheticDatabase: z.literal(true), sameHostPrivatePrimary: z.literal(true),
  setupAccepted: z.literal(true), connectionPools: z.literal(2), maxWebConnections: z.literal(8),
  validationSessions: z.literal(2), physicalListener: z.literal(false), automaticRetry: z.literal(false),
  cleanup: z.literal("close_owned_connections_then_operator_database_cleanup"),
}).strict();
export type RehearsalPacket = z.infer<typeof packetSchema>;
export const rehearsalScope = Object.freeze({ origin: "https://private.example.invalid", issuer: "https://access.example.invalid",
  audience: "test-app", tenantId: "tenant:web", workspaceId: "workspace:web", ownerIdentityId: "identity:web" });
export interface RehearsalMaterial {
  /** Synthetic assertion/public key and fixture integrity material, never real Access/agent credentials. */
  assertion: string; keys: AccessTrust["keys"]; ideaIntegrityKey: Uint8Array;
  registryIntegrityKey: Uint8Array; telemetryIntegrityKey: Uint8Array;
}
type Pool = ReturnType<typeof createPrivatePostgresDatabase>;
interface Dependencies {
  openDatabase(config: PrivatePostgresConfiguration): Pool;
  openProbe(config: PrivatePostgresConfiguration, slot: "a" | "b"): RehearsalProbe;
  clock(): number; monotonic(): number;
  probeTiming?: Parameters<typeof checkPostgresLimits>[0]["timing"];
}
export interface RehearsalInput {
  manifest: z.infer<typeof manifestSchema>; packet: RehearsalPacket;
  database: PrivatePostgresConfiguration; material: RehearsalMaterial; signal?: AbortSignal;
}
export interface RehearsalEvidence {
  contract: "cr14b-database-rehearsal/v1"; execution: "native_postgres" | "injected_test";
  disposition: "setup_incomplete" | "checks_completed" | "stopped" | "cleanup_uncertain" | "already_attempted";
  checks: Record<RehearsalCheck, "not_exercised" | "observed">;
  manifest: z.infer<typeof manifestSchema> | null; schemaDigest: string;
  poolsCreated: number; probesCreated: number; poolsClosed: number; probesClosed: number;
  physicalConnectionAttempts: "not_observed"; idleTimeoutCause: "unavailable_from_driver";
  databaseCleanup: "not_owned_by_runner"; realPostgresAccepted: false; privateBetaAccepted: false;
  physicalListener: "not_exercised"; processRestart: "not_exercised"; backupRestore: "not_exercised";
  driverFaultInjection: "separate_test_evidence";
}
/** Operator packet binding only; not an approval signature or proof of the host/artifact's identity. */
export function rehearsalScopeDigest(config: PrivatePostgresConfiguration) {
  const validated = validatePrivatePostgresConfiguration(config);
  return sha({ ...rehearsalScope, host: validated.host, port: validated.port, database: validated.database,
    username: validated.username, majorVersion: validated.majorVersion });
}
const ensure = (value: unknown) => { if (value !== true) throw new Error("rehearsal_check_failed"); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

/** This is an operator harness, never a request endpoint, scheduler capability or self-authorization.
 * Construction is inert. run() is single-use, and the native factory below is the only native composition.
 */
function createRunner(dependencies: Dependencies, execution: RehearsalEvidence["execution"]) {
  let attempted = false;
  return Object.freeze({ async run(input: RehearsalInput): Promise<RehearsalEvidence> {
    const evidence: RehearsalEvidence = { contract: "cr14b-database-rehearsal/v1", execution, disposition: "setup_incomplete",
      checks: Object.fromEntries(rehearsalCheckNames.map(name => [name, "not_exercised"])) as RehearsalEvidence["checks"],
      manifest: null, schemaDigest: privateWebSchemaDigest, poolsCreated: 0, probesCreated: 0, poolsClosed: 0, probesClosed: 0,
      physicalConnectionAttempts: "not_observed", idleTimeoutCause: "unavailable_from_driver",
      databaseCleanup: "not_owned_by_runner", realPostgresAccepted: false, privateBetaAccepted: false,
      physicalListener: "not_exercised", processRestart: "not_exercised", backupRestore: "not_exercised", driverFaultInjection: "separate_test_evidence" };
    if (attempted) return { ...evidence, disposition: "already_attempted" };
    attempted = true;
    let config: PrivatePostgresConfiguration, packet: RehearsalPacket, material: RehearsalMaterial;
    const clock = dependencies.clock;
    const began = dependencies.monotonic();
    const startedAt = clock();
    try {
      packet = packetSchema.parse(input.packet); config = validatePrivatePostgresConfiguration(input.database);
      ensure(/^cr14b_rehearsal_[a-z0-9_]{1,40}$/.test(config.database));
      ensure(sha(manifestSchema.parse(input.manifest)) === sha(packet.manifest));
      ensure(packet.scopeDigest === rehearsalScopeDigest(config));
      ensure(Number.isSafeInteger(startedAt) && Number.isFinite(began) && packet.expiresAt >= startedAt + packet.durationMs);
      ensure(!input.signal?.aborted);
      const key = (value: Uint8Array) => { ensure(value instanceof Uint8Array && value.length === 32); return new Uint8Array(value); };
      material = { assertion: input.material.assertion, keys: structuredClone(input.material.keys),
        ideaIntegrityKey: key(input.material.ideaIntegrityKey), registryIntegrityKey: key(input.material.registryIntegrityKey),
        telemetryIntegrityKey: key(input.material.telemetryIntegrityKey) };
      const claims = createAccessVerifier({ ...rehearsalScope, keys: material.keys, maxSessionSeconds: 3600,
        validUntilMs: startedAt + packet.durationMs })(new Request(rehearsalScope.origin,
        { headers: { "cf-access-jwt-assertion": material.assertion } }), startedAt);
      ensure(claims.subject === "test-owner" && Date.parse(claims.expiresAt) >= startedAt + packet.durationMs);
      evidence.manifest = packet.manifest;
    } catch { return evidence; }

    const signal = input.signal;
    let stopped = false;
    const releases: (() => void)[] = [];
    const resources: { close: () => Promise<void>; kind: "pool" | "probe" }[] = [];
    const checkpoint = () => {
      if (stopped || signal?.aborted || dependencies.monotonic() - began >= packet.durationMs - 10_000
        || clock() < startedAt || clock() >= packet.expiresAt) throw new Error("rehearsal_stopped");
    };
    const record = (name: RehearsalCheck) => { checkpoint(); evidence.checks[name] = "observed"; };
    const own = <T extends { close(): Promise<void> }>(resource: T, kind: "pool" | "probe"): T => {
      let closing: Promise<void> | undefined;
      const close = () => closing ??= Promise.resolve().then(() => resource.close()).then(() => {
        if (kind === "pool") evidence.poolsClosed++; else evidence.probesClosed++;
      });
      resources.push({ close, kind });
      return { ...resource, close };
    };
    const openPool = () => { checkpoint(); ensure(evidence.poolsCreated < 2);
      const resource = own(dependencies.openDatabase(config), "pool"); evidence.poolsCreated++; return resource; };
    const openProbe = (slot: "a" | "b") => { checkpoint(); ensure(evidence.probesCreated < 2);
      const resource = own(dependencies.openProbe(config, slot), "probe"); evidence.probesCreated++; return resource; };
    const startup = { ...rehearsalScope, database: config, maxSessionSeconds: 3600,
      loadKeys: async () => material.keys, ideaProjects: { integrityKey: material.ideaIntegrityKey },
      connections: { registryIntegrityKey: material.registryIntegrityKey, telemetryIntegrityKey: material.telemetryIntegrityKey } };
    const request = (path = "/api/v1/projects", method = "GET", body?: unknown, key = "cr14b-rehearsal-create-0001") => {
      checkpoint(); return new Request(`${rehearsalScope.origin}${path}`, { method,
        headers: { origin: rehearsalScope.origin, "cf-access-jwt-assertion": material.assertion,
          "content-type": "application/json", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    let app: ReturnType<typeof createPrivateWebProcess> | undefined;
    const query = async <T>(pool: Pool, statement: string, params?: unknown[]) => {
      checkpoint(); const result = await pool.client.query<T>(statement, params); checkpoint(); return result;
    };
    const workload = async () => {
      let pool = openPool();
      const start = async () => {
        const owned = pool;
        const bootstrap = createPrivateWebBootstrap({ openDatabase: () => owned, clock,
          install: options => { checkpoint(); app = createPrivateWebProcess(options); return app; } });
        const runtime = await bootstrap.start(startup); checkpoint(); return runtime;
      };
      let runtime = await start(); record("preflight");
      const response = async (path?: string, method?: string, body?: unknown, key?: string) => {
        const result = await app!.handle(request(path, method, body, key), () => new Response("rehearsal shell"));
        checkpoint(); return result;
      };
      let rejected = false;
      try { await verifyPrivateDatabase(pool.client, config, { ...rehearsalScope, ownerIdentityId: "identity:absent-rehearsal" }, clock()); }
      catch { rejected = true; }
      ensure(rejected && pool.isAvailable()); record("unsuitable_scope_rejected");
      const baseline = (await query<{ valid: boolean; audits: string }>(pool, `SELECT
        current_setting('server_version_num')::integer=$3
        AND (SELECT count(*) FROM workspaces)=1 AND (SELECT count(*) FROM workspaces WHERE tenant_id=$1 AND id=$2)=1
        AND (SELECT count(*) FROM control_identities)=1 AND (SELECT count(*) FROM control_role_grants)=1
        AND EXISTS(SELECT 1 FROM control_role_grants WHERE identity_id=$4 AND (expires_at IS NULL OR expires_at>$5))
        AND (SELECT count(*) FROM control_web_sessions)=0 AND (SELECT count(*) FROM control_web_project_commands)=0
        AND (SELECT count(*) FROM control_manual_project_heads)=0 AND (SELECT count(*) FROM projects)=1
        AND (SELECT count(*) FROM projects WHERE tenant_id=$1 AND id='project.idea:web')=1
        AND (SELECT count(*) FROM control_connection_enrollments)=1 AS valid,
        (SELECT count(*)::text FROM audit_events WHERE tenant_id=$1) AS audits`, [rehearsalScope.tenantId, rehearsalScope.workspaceId,
        packet.pgVersionNumber, rehearsalScope.ownerIdentityId, new Date(startedAt + packet.durationMs).toISOString()])).rows[0];
      ensure(baseline?.valid === true && /^\d+$/.test(baseline.audits)); record("synthetic_fixture");

      const body = { title: "Disposable database rehearsal", summary: "Synthetic project; no agent or external work." };
      const created = await response(undefined, "POST", body); ensure(created.status === 201);
      const original = await created.json(); const project = webProjectSchema.parse(original.project);
      ensure(original.replayed === false && project.version === 1);
      const replay = await response(undefined, "POST", body); ensure(replay.status === 200);
      const replayed = await replay.json();
      ensure(replayed.replayed === true && sha(webProjectSchema.parse(replayed.project)) === sha(project));
      const path = `/api/v1/projects/${encodeURIComponent(project.projectId)}`;
      const transition = await response(`${path}/lifecycle`, "POST", { lifecycle: "paused", expectedVersion: 1 }, "cr14b-rehearsal-lifecycle-0001");
      ensure(transition.status === 200);
      const changed = await transition.json(); ensure(changed.project?.lifecycle === "paused" && changed.project?.version === 2);
      const read = await response(path); ensure(read.status === 200); ensure((await read.json()).project.version === 2);
      const receipts = async () => {
        const row = (await query<{ commands: string; audits: string; versions: boolean }>(pool, `SELECT
          (SELECT count(*)::text FROM control_web_project_commands WHERE tenant_id=$1 AND identity_id=$2) AS commands,
          (SELECT count(*)::text FROM audit_events WHERE tenant_id=$1) AS audits,
          EXISTS(SELECT 1 FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$3 AND lifecycle='paused' AND version=2) AS versions`,
        [rehearsalScope.tenantId, rehearsalScope.ownerIdentityId, project.projectId])).rows[0];
        ensure(row?.commands === "2" && Number(row.audits) === Number(baseline.audits) + 2 && row.versions === true);
      };
      await receipts(); record("project_commands");
      const catalogResponse = await response(); ensure(catalogResponse.status === 200);
      const catalog = projectCatalogPageSchema.parse(await catalogResponse.json());
      ensure(catalog.projects.length === 2 && catalog.projects.some(p => p.origin === "idea_lab") && catalog.nextCursor === null);
      const connections = await response("/api/v1/connections"); ensure(connections.status === 200);
      const connectionView = await connections.json(); ensure(connectionView.projection?.summary?.connectionCount === 1
        && connectionView.projection?.summary?.currentSignalCount === 1
        && connectionView.projection?.summary?.missingSignalCount === 0 && connectionView.projection?.summary?.staleSignalCount === 0
        && connectionView.projection?.summary?.livePanelEligibleCount === 0 && connectionView.telemetry === "configured");
      record("catalog_and_connections");

      const a = openProbe("a"), b = openProbe("b");
      // Check both independently connected sessions' identity/settings before any probe transaction.
      for (const probe of [a, b]) {
        const row = (await probe.query<{ valid: boolean }>(`SELECT current_user=session_user AND current_user=$1
          AND current_database()=$2 AND current_setting('server_version_num')::integer=$3
          AND current_setting('statement_timeout')='5s' AND current_setting('lock_timeout')='2s'
          AND current_setting('transaction_timeout')='10s' AND current_setting('idle_in_transaction_session_timeout')='5s' AS valid`,
        [config.username, config.database, packet.pgVersionNumber])).rows[0]; ensure(row?.valid === true); checkpoint();
      }
      await checkProtectedColumns(a); record("protected_columns");
      await checkPostgresLimits({ a, b, observer: pool.client, ...rehearsalScope, checkpoint, record, timing: dependencies.probeTiming });

      const entered = deferred<void>(), release = deferred<void>(); let active = 0;
      releases.push(() => release.resolve());
      const holding = Array.from({ length: 8 }, () => pool.client.transaction(async () => {
        checkpoint(); active++; if (active === 8) entered.resolve(); await release.promise; checkpoint();
      }));
      const joined = Promise.all(holding); void joined.catch(() => {});
      try {
        await Promise.race([entered.promise, joined.then(() => { throw new Error("capacity_incomplete"); })]); checkpoint();
        let ninthDenied = false;
        try { await pool.client.query("SELECT 1"); } catch (error) { ninthDenied = error instanceof PrivateDatabaseError && error.code === "database_unavailable"; }
        ensure(ninthDenied && pool.isAvailable());
      } finally { release.resolve(); }
      await joined; record("pool_capacity");

      const rendering = deferred<void>(), finishRender = deferred<Response>();
      releases.push(() => finishRender.resolve(new Response("rehearsal shell")));
      const pending = app!.handle(request("/projects"), () => { rendering.resolve(); return finishRender.promise; });
      void pending.catch(() => {});
      await Promise.race([rendering.promise, pending.then(() => { throw new Error("drain_not_entered"); })]); checkpoint();
      const closing = runtime.close(); void closing.catch(() => {});
      ensure(!runtime.isReady() && runtime.close() === closing);
      try { ensure((await response()).status === 503); }
      finally { finishRender.resolve(new Response("rehearsal shell")); }
      ensure((await pending).status === 200); await closing; ensure(evidence.poolsClosed === 1); record("drain");

      pool = openPool(); runtime = await start(); await receipts();
      ensure((await response(path)).status === 200); record("pool_reopen_receipts");
      ensure((await response("/api/v1/session/logout", "POST")).status === 204);
      for (const deniedPath of [path, "/api/v1/connections"]) ensure((await response(deniedPath)).status === 401);
      const tombstone = (await query<{ valid: boolean }>(pool, `SELECT count(*)=1 AND bool_and(revoked_at IS NOT NULL) AS valid
        FROM control_web_sessions WHERE tenant_id=$1 AND identity_id=$2`, [rehearsalScope.tenantId, rehearsalScope.ownerIdentityId])).rows[0];
      ensure(tombstone?.valid === true); await receipts(); record("logout"); await runtime.close();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    try {
      const limit = new Promise<never>((_, reject) => { abort = () => { stopped = true; reject(new Error("rehearsal_stopped")); };
        timer = setTimeout(abort, Math.max(1, packet.durationMs - 10_000 - (dependencies.monotonic() - began))); });
      signal?.addEventListener("abort", abort, { once: true });
      await Promise.race([workload(), limit]); evidence.disposition = "checks_completed";
    } catch { evidence.disposition = "stopped"; }
    finally {
      stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      for (const release of releases) release();
      const closed = await Promise.allSettled(resources.map(resource => resource.close()));
      if (app) { try { await app.close(); } catch { evidence.disposition = "cleanup_uncertain"; } }
      if (closed.some(result => result.status === "rejected")) evidence.disposition = "cleanup_uncertain";
    }
    // No raw row, assertion, config, host/database/login, error or caller-supplied free text is retained.
    return evidence;
  } });
}

export function createNativePrivateDatabaseRehearsal() {
  return createRunner({ openDatabase: createPrivatePostgresDatabase, openProbe: createRehearsalProbe,
    clock: Date.now, monotonic: () => performance.now() }, "native_postgres");
}
/** Explicit test label cannot become native evidence, even when the fake says every check passed. */
export function createInjectedPrivateDatabaseRehearsal(dependencies: Dependencies) {
  return createRunner(dependencies, "injected_test");
}
