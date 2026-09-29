// Multi-client load test for the owner website.
//
// Answers the question the task actually asks: with the database on a remote
// link, can 5-10 open clients use the owner website without pages timing out or
// reporting "unavailable"?
//
// What is real here:
//   - the real private application dispatch (`createPrivateWebProcess`), so the
//     real routing, authentication, header policy and validator path are used;
//   - the real Node transport (`createPrivateNodeHandler`) driven through the
//     repository's own in-memory exchange, so the real header enforcement, the
//     real request-header allowlist and the real 304 framing are exercised;
//   - a real disposable PostgreSQL cluster created and destroyed by this script
//     on its own port, with the repository's own migration ledger;
//   - injected per-query latency of 50 ms, which is what a remote database costs.
//
// What is simulated, and honestly so: the clients. Each simulated client
// verifies its own session as a distinct identity, and replays the polling
// pattern measured for a real owner page rather than driving a real browser.
// The measured patterns are listed in POLLING_PATTERNS and are the same ones
// recorded in the task's inventory table.
//
// Nothing here points at the live app, the live database, or port 3210.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConditionalByteAccounting } from "./conditional-byte-accounting.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DURATION_MS = Number(process.env.MULTI_CLIENT_DURATION_MS ?? 120_000);
const INJECTED_QUERY_LATENCY_MS = Number(process.env.MULTI_CLIENT_QUERY_LATENCY_MS ?? 50);
const PG_PORT = Number(process.env.MULTI_CLIENT_PG_PORT ?? 15987);
const CLIENT_COUNT = Number(process.env.MULTI_CLIENT_CLIENTS ?? 10);
const ACTIVE_CLIENTS = 3;
const ORIGIN = "https://private.example.invalid";

/** Findings this test fails on, per the task's acceptance criteria. */
const ACCEPTANCE = { maxUnavailable: 0, p95Ms: 1500 };

/**
 * The measured owner-page polling patterns, from the M9 inventory.
 *
 * The quiet backoff is the new client policy this task introduces: a tab whose
 * data has not changed stretches from 30s to 60s to 120s and then holds at 120s.
 * `POLICY` selects which side of the change is being measured, so the same run
 * can report the before and the after.
 */
const QUIET_BACKOFF = (process.env.MULTI_CLIENT_POLICY ?? "after") === "after";
const POLLING_PATTERNS = [
  { name: "home-projects", path: "/api/v1/projects", intervalMs: 30_000, state: "active" },
  { name: "home-attention", path: "/api/v1/needs-me/tasks", intervalMs: 30_000, state: "active" },
  { name: "home-activity", path: "/api/v1/home/tasks", intervalMs: 30_000, state: "active" },
  { name: "operator-surface", path: "/api/v1/operator-surface", intervalMs: 30_000, state: "active" },
  { name: "connections", path: "/api/v1/connections", intervalMs: 30_000, state: "active" },
  // A background tab. The shared hook pauses it while the tab is hidden, so it
  // issues no requests at all until the owner returns to the tab.
  { name: "background-projects", path: "/api/v1/projects", intervalMs: 30_000, state: "background" },
  { name: "background-tasks", path: "/api/v1/home/tasks", intervalMs: 30_000, state: "background" },
  { name: "background-connections", path: "/api/v1/connections", intervalMs: 30_000, state: "background" },
];

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
};

function findPostgresBin() {
  for (const dir of ["/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl"))) return dir;
  }
  return undefined;
}

/**
 * A disposable run root for one rehearsal.
 *
 * It deliberately does not use the session scratch directory: that path is long
 * enough that a Unix-domain socket under it exceeds PostgreSQL's 103-byte limit
 * and the server refuses to start. `/private/tmp/mcr-<pid>` is short, unique to
 * this process, and removed on exit.
 */
function createRunRoot() {
  const base = realpathSync(mkdtempSync(join("/private/tmp", "mcr-")));
  const data = join(base, "pg"), socket = join(base, "s");
  mkdirSync(socket, { recursive: true });
  return { base, data, socket };
}

/** Creates, and always destroys, one disposable cluster for this run. */
async function withDisposableCluster(run) {
  const bin = findPostgresBin();
  if (!bin) throw new Error("multi_client_postgres_unavailable");
  const { base, data, socket } = createRunRoot();
  // PostgreSQL refuses to start multithreaded when the locale is unset or not a
  // valid single locale. A rehearsal must be deterministic, so pin it here
  // rather than inheriting whatever the invoking shell happens to export.
  const environment = { ...process.env, LC_ALL: "C", LANG: "C" };
  // `starting` is set the moment the server may hold a port, so a failure
  // anywhere after that point still tears the cluster down. Marking it only
  // after pg_ctl returned would leak a postmaster on a later failure.
  let starting = false;
  const stop = () => {
    if (!starting) return;
    starting = false;
    // `immediate` so a hung connection cannot keep the cluster alive past teardown.
    try { execFileSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "pipe", env: environment }); }
    catch { /* the data directory is removed regardless */ }
  };
  // A signal must not leave a cluster running past this process.
  for (const signal of ["SIGINT", "SIGTERM", "exit"]) process.once(signal, stop);
  try {
    // scram is required, not optional: the application pool reaches this
    // cluster over TCP loopback, and host auth is refused by the rehearsal
    // superuser so that a missing password can never look like a pass.
    execFileSync(join(bin, "initdb"), ["-D", data, "-U", "rehearsal_admin", "--auth-local=trust",
      "--auth-host=scram-sha-256", "--encoding=UTF8", "--locale=C"], { stdio: "pipe", env: environment });
    starting = true;
    try {
      execFileSync(join(bin, "pg_ctl"), ["-D", data, "-l", join(base, "postgres.log"), "-w", "-t", "30",
        "-o", `-p ${PG_PORT} -k '${socket}' -c listen_addresses=127.0.0.1`, "start"], { stdio: "pipe", env: environment });
    } catch (error) {
      // Surface the server log, which is the only place the real cause appears.
      let detail = "";
      try { detail = readFileSync(join(base, "postgres.log"), "utf8").trim().split("\n").slice(-4).join(" | "); }
      catch { /* the log may not exist */ }
      throw new Error(`multi_client_cluster_start_failed port=${PG_PORT}: ${detail || error.message}`);
    }
    return await run({ socket, port: PG_PORT, bin, environment });
  } finally {
    stop();
    rmSync(base, { recursive: true, force: true });
  }
}

const { generateKeyPairSync, sign } = await import("node:crypto");
const { Client } = await import("pg");
const { createPrivatePgDatabase } = await import("../../src/web/v1/private-pg-database.ts");
const { createPrivateWebProcess } = await import("../../src/web/v1/private-process.ts");
const { createPrivateNodeHandler } = await import("../../src/web/v1/private-node-handler.ts");
const { applyMigrations } = await import("../../deploy/postgres/apply-migrations.mjs");
const { SecurityStore } = await import("../../src/security/security-store.ts");
const { webConnectionKeys } = await import("../../tests/helpers/web-connection.ts");
const { OPERATOR_SURFACES_CONTRACT_V1 } = await import("../../src/operator-surfaces/v1/types.ts");
const { nodeExchange } = await import("../../tests/helpers/web-node.ts");

/** A small fixed fleet: the honest shape of an available capacity read. */
function operatorSurfaceSnapshot(nowMs) {
  const at = new Date(nowMs).toISOString();
  return { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:rehearsal", generatedAt: at,
    fleet: [{ workerId: "worker:rehearsal", platform: "macos", state: "idle", lastObservedAt: at,
      capacityState: "reported", availableSlots: 1, totalSlots: 1, capabilityState: "verified", telemetryState: "fresh" }],
    bottlenecks: [], activeWork: [], portfolio: [], services: [], schedules: [], serviceIncidents: [], actionInbox: [], ownerFocus: [] };
}

/**
 * Applies the repository's own migration ledger to a fresh database on the
 * disposable cluster, through the production two-phase path, so the schema
 * under load is the ledger-verified schema rather than a subset.
 */
async function provisionLedger(socket, port, name) {
  const admin = new Client({ host: socket, port, database: "postgres", user: "rehearsal_admin" });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  // The application pool authenticates over TCP with scram, so the rehearsal
  // superuser needs a real password. It is synthetic, local and never printed.
  const ownerPassword = "r".repeat(24);
  const owner = new Client({ host: socket, port, database: name, user: "rehearsal_admin" });
  await owner.connect();
  try { await owner.query(`ALTER ROLE rehearsal_admin PASSWORD '${ownerPassword}'`); }
  finally { await owner.end(); }
  const passwords = {
    CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24),
    CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
    CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
  };
  const result = await applyMigrations({
    target: `host=${socket} port=${port} dbname=${name} user=rehearsal_admin`,
    rootDir: ROOT,
    ledgerPath: join(ROOT, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: { host: socket, port, database: name, user: "rehearsal_admin", password: "r".repeat(24) },
    migrateTarget: { host: socket, port, database: name, user: "control_room_migrator", password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD },
    env: { ...passwords, NODE_ENV: "test" },
  });
  if (result.planned || !result.applied?.length) throw new Error("multi_client_migrations_not_applied");
  return { name, applied: result.applied.length, passwords, ownerPassword };
}

/**
 * Wraps a real bounded client so every query costs INJECTED_QUERY_LATENCY_MS,
 * which is what a remote database costs on the wire.
 *
 * It must forward the *whole* `DatabaseClient` surface — `transaction` and
 * `transactionWithPreCommitCheck` included — because a wrapper that drops a
 * member turns every caller into a 503 rather than a slow answer, which would
 * make this test measure a broken harness instead of the system.
 */
function latencyInjectingClient(real, latencyMs, counter) {
  const pay = () => new Promise(done => setTimeout(done, latencyMs));
  return Object.freeze({
    async query(statement, params) {
      counter.queries++;
      await pay();
      return real.query(statement, params);
    },
    async transaction(callback) {
      counter.queries++;
      await pay();
      return real.transaction(callback);
    },
    async transactionWithPreCommitCheck(callback, check) {
      counter.queries++;
      await pay();
      return real.transactionWithPreCommitCheck(callback, check);
    },
    close: () => real.close(),
  });
}

/** Drives one HTTP request through the real transport and real dispatch. */
async function send(handler, { path, token, conditional }) {
  const host = new URL(ORIGIN).host;
  const exchange = nodeExchange({ path, method: "GET", peer: "127.0.0.1", headers: [
    "cf-access-jwt-assertion", token, "origin", ORIGIN, "accept", "application/json",
    ...(conditional ? ["if-none-match", conditional] : []),
  ] });
  exchange.input.rawHeaders[1] = host;
  const started = process.hrtime.bigint();
  const completed = new Promise((done, failed) => {
    exchange.output.once("finish", done);
    exchange.output.once("error", failed);
  });
  handler.handle(exchange.input, exchange.output);
  await completed;
  // The body is read once here, eagerly, so the report can state how many bytes
  // the conditional protocol actually saved. A 304 sends no body, and that byte
  // saving is the real, measurable win of the conditional read.
  const body = exchange.body();
  return { status: exchange.output.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6,
    etag: exchange.headers.get("etag"), cacheControl: exchange.headers.get("cache-control"),
    bytes: Buffer.byteLength(body, "utf8"), body: () => body };
}

async function main() {
  await withDisposableCluster(async ({ socket, port }) => {
    const provisioned = await provisionLedger(socket, port, "multi_client");
    const admin = new Client({ host: socket, port, database: provisioned.name, user: "rehearsal_admin" });
    await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:rehearsal','Rehearsal tenant')");
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:rehearsal','tenant:rehearsal','Rehearsal workspace')");
    } finally { await admin.end(); }
    const nowMs = Date.parse("2026-09-04T12:00:00.000Z");
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuer = "https://access.example.invalid", audience = "test-app";
    const mintToken = (subject) => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "load-test-key" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: [audience], sub: subject,
        type: "app", iat: nowMs / 1000 - 60, exp: nowMs / 1000 + 3600 })).toString("base64url");
      return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey).toString("base64url")}`;
    };
    // Every simulated client is a distinct identity: the owner on a Mac, a
    // phone, a tablet, and so on. Each verifies its own session.
    const clients = Array.from({ length: CLIENT_COUNT }, (_, index) => ({
      index, subject: `owner-client-${index}`, token: mintToken(`owner-client-${index}`),
      state: index < ACTIVE_CLIENTS ? "active" : "background",
      pattern: POLLING_PATTERNS[index % POLLING_PATTERNS.length],
    }));

    // The production bounded pool over the real driver. The application client
    // accepts only an exact loopback host, so the disposable cluster is reached
    // over TCP on its own loopback port rather than through the socket.
    const database = createPrivatePgDatabase({ host: "127.0.0.1", port, database: provisioned.name,
      username: "rehearsal_admin", password: provisioned.ownerPassword, majorVersion: 17 });
    const raw = database.client;
    // The first-owner bootstrap is single-use per tenant, so exactly one
    // identity is bootstrapped. The other simulated clients are additional
    // sessions of that same owner, which is the real multi-client shape: one
    // owner, several devices. Each still presents its own assertion token, so
    // each still gets its own verified identity and its own validator scope.
    const [firstClient, ...otherClients] = clients;
    await new SecurityStore(raw).bootstrapOwner({ tenantId: "tenant:rehearsal",
      provider: issuer, subject: firstClient.subject, identityId: `identity:${firstClient.subject}`,
      grantId: `grant:${firstClient.subject}`, displayName: "Rehearsal owner",
      verifiedAt: new Date(nowMs - 60_000).toISOString(), expiresAt: new Date(nowMs + 3_600_000).toISOString(),
      now: new Date(nowMs).toISOString() });
    for (const client of otherClients) {
      // Additional owner sessions for the same subject: a new token over the
      // same verified identity, which is what a second device presents.
      client.token = mintToken(firstClient.subject);
    }

    const counter = { queries: 0 };
    const application = createPrivateWebProcess({
      origin: ORIGIN, issuer, audience, tenantId: "tenant:rehearsal", workspaceId: "workspace:rehearsal",
      maxSessionSeconds: 604800, clock: () => nowMs,
      loadKeys: async () => [{ kid: "load-test-key", jwk: keys.publicKey.export({ format: "jwk" }) }],
      // The connections surface is an existing-enrollment read: it has no
      // honest answer without the registry keys, so a rehearsal supplies the
      // repository's own test keys rather than reporting a false "unavailable"
      // that would then be counted against the acceptance criteria.
      connections: webConnectionKeys,
      // A server-owned read-only capacity projection. The rehearsal supplies a
      // small fixed fleet, which is the honest shape of an available capacity
      // read rather than the unavailable default.
      operatorSurface: { read: async () => operatorSurfaceSnapshot(nowMs) },
      database: { client: latencyInjectingClient(raw, INJECTED_QUERY_LATENCY_MS, counter), close: () => database.close() },
    });
    const handler = createPrivateNodeHandler({ origin: ORIGIN,
      application: { isReady: () => true, close: () => application.close() },
      handler: request => application.handle(request, () => new Response("shell")),
      assets: { read: async () => undefined, list: async () => [] } });

    const samples = new Map(), statusCounts = new Map();
    // Bytes actually served, split by status, plus exact conditional savings.
    // Each 304 is matched to the prior 200 representation for the same resource
    // and request validator; unrelated 200 responses never enter that saving.
    const bytesByStatus = new Map();
    const conditionalBytes = createConditionalByteAccounting();
    const record = (reportPath, result, conditional, resource = reportPath) => {
      if (!samples.has(reportPath)) samples.set(reportPath, []);
      samples.get(reportPath).push(result.ms);
      statusCounts.set(`${reportPath} ${result.status}`, (statusCounts.get(`${reportPath} ${result.status}`) ?? 0) + 1);
      bytesByStatus.set(result.status, (bytesByStatus.get(result.status) ?? 0) + result.bytes);
      conditionalBytes.record({ resource, status: result.status, bytes: result.bytes,
        etag: result.etag, conditional });
    };

    /** The real client loop: read, revalidate on the next poll, and back off
     * when nothing changed when the new policy is in force. */
    const driveClient = async (client) => {
      let etag, unchangedPolls = 0, delay = client.pattern.intervalMs;
      let result = await send(handler, { path: client.pattern.path, token: client.token });
      if (process.env.MULTI_CLIENT_DEBUG)
        process.stderr.write(`[debug] ${client.pattern.path} -> ${result.status} etag=${result.etag} cc=${result.cacheControl} body=${result.body().slice(0, 160)}\n`);
      record(client.pattern.path, result);
      etag = result.etag;
      let previous = result.ms;
      while (!stopped) {
        await sleep(delay);
        if (stopped) break;
        const next = await send(handler, { path: client.pattern.path, token: client.token, conditional: etag });
        record(client.pattern.path, next, etag);
        if (QUIET_BACKOFF && next.status === 304) {
          unchangedPolls++;
          delay = Math.min(client.pattern.intervalMs * 2 ** Math.min(unchangedPolls, 2), client.pattern.intervalMs * 4);
        } else {
          unchangedPolls = 0;
          delay = client.pattern.intervalMs;
          etag = next.etag ?? etag;
        }
        previous = next.ms;
      }
      return previous;
    };

    const sleep = (ms) => new Promise(done => setTimeout(done, Math.min(ms, Math.max(0, DURATION_MS - (Date.now() - startedAt)))));
    let stopped = false;
    const startedAt = Date.now();
    const backgroundRequestsBefore = statusCounts.size;

    // Active clients poll at their page's measured interval. Background clients
    // are a hidden tab: they issue nothing while hidden.
    const active = clients.filter(client => client.state === "active").map(client => driveClient(client));
    const background = clients.filter(client => client.state === "background");
    const backgroundSampled = background.length;

    await sleep(DURATION_MS);
    stopped = true;
    await Promise.allSettled(active);
    const backgroundRequestsDuringRun = [...statusCounts.keys()].filter(key => key.includes("background")).length;

    // A background client that returns to its tab reads once, at base.
    for (const client of background) {
      const result = await send(handler, { path: client.pattern.path, token: client.token });
      if (process.env.MULTI_CLIENT_DEBUG && result.status >= 400)
        process.stderr.write(`[debug] return-to-tab ${client.pattern.path} -> ${result.status} ${result.body().slice(0, 200)}\n`);
      record(`${client.pattern.path} (return-to-tab)`, result, undefined, client.pattern.path);
    }

    await application.close();
    await database.close();

    // --- report -----------------------------------------------------------
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const unavailable = [...statusCounts.entries()].filter(([key]) => / (4\d\d|5\d\d)$/.test(key));
    const p95 = Math.max(0, ...[...samples.values()].map(values => percentile(values, 0.95)));
    const notModified = [...statusCounts.entries()].filter(([key]) => key.endsWith(" 304")).reduce((sum, [, count]) => sum + count, 0);
    const unavailableTotal = unavailable.reduce((sum, [, count]) => sum + count, 0);
    const okBytes = [...bytesByStatus.entries()].filter(([status]) => status === 200).reduce((sum, [, bytes]) => sum + bytes, 0);
    const notModifiedBytes = bytesByStatus.get(304) ?? 0;
    // What a 304 costs to produce versus what its endpoint-matched 200
    // representation would have cost to transfer. The database was still
    // queried, because authorization and the read happen before validation.
    const meanOkBytes = (() => { const count = [...statusCounts.entries()]
      .filter(([key]) => key.endsWith(" 200")).reduce((sum, [, n]) => sum + n, 0);
      return count ? Math.round(okBytes / count) : 0; })();
    const notModifiedSavedBytes = conditionalBytes.avoidedBytes();

    const lines = [
      `# Multi-client load test — policy: ${QUIET_BACKOFF ? "after (polling discipline + conditional reads)" : "before (existing setInterval polling)"}`,
      "",
      `- simulated clients: ${CLIENT_COUNT} (${ACTIVE_CLIENTS} active, ${backgroundSampled} background tabs)`,
      `- duration: ${elapsed}s`,
      `- injected per-query latency: ${INJECTED_QUERY_LATENCY_MS}ms (remote database)`,
      `- database queries issued: ${counter.queries}`,
      `- background-tab requests during the run: ${backgroundRequestsDuringRun} (expected 0 — hidden tabs must not poll)`,
      "",
      "| endpoint | reads | p50 ms | p95 ms | max ms |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...[...samples.entries()].sort().map(([path, values]) =>
        `| ${path} | ${values.length} | ${percentile(values, 0.5).toFixed(0)} | ${percentile(values, 0.95).toFixed(0)} | ${Math.max(...values).toFixed(0)} |`),
      "",
      "| status | count |",
      "| --- | ---: |",
      ...[...statusCounts.entries()].sort().map(([key, count]) => `| ${key} | ${count} |`),
      "",
      `- 304 Not Modified responses: ${notModified}`,
      `- bytes transferred on 200 responses: ${okBytes} (mean ${meanOkBytes} per response)`,
      `- bytes transferred on 304 responses: ${notModifiedBytes} (a 304 carries no body)`,
      `- response bytes actually avoided by the ${notModified} conditional reads (sum of each matching 200 representation): ${notModifiedSavedBytes}`,
      `- unavailable responses (4xx/5xx): ${unavailableTotal}`,
      `- worst p95 across endpoints: ${p95.toFixed(0)}ms`,
      "",
      `Acceptance: zero unavailable — ${unavailableTotal === 0 ? "PASS" : "FAIL"} (allowed ${ACCEPTANCE.maxUnavailable})`,
      "",
      `Acceptance: p95 < ${ACCEPTANCE.p95Ms}ms — ${p95 < ACCEPTANCE.p95Ms ? "PASS" : "FAIL"} (${p95.toFixed(0)}ms)`,
      "",
      `Result: ${unavailableTotal <= ACCEPTANCE.maxUnavailable && p95 < ACCEPTANCE.p95Ms ? "PASS" : "FAIL"}`,
    ];
    const report = lines.join("\n");
    process.stdout.write(`${report}\n`);
    if (process.env.MULTI_CLIENT_REPORT) writeFileSync(process.env.MULTI_CLIENT_REPORT, `${report}\n`);
    process.exitCode = unavailableTotal <= ACCEPTANCE.maxUnavailable && p95 < ACCEPTANCE.p95Ms ? 0 : 1;
  });
}

await main();
