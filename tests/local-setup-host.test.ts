import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
import { createInstallationSetupViewV1 } from "../src/harness/v1/installation-setup-view";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createLocalSetupHostV1 } from "../src/installer/v1/local-setup-host";
import { createInstallationPlanViewV1 } from "../src/installer/v1/installation-plan-view";
import { createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { LOCAL_SETUP_JOURNAL_SOURCE_V1 } from "../src/installer/v1/local-setup-journal-source";
import { sha256Digest } from "../src/security/canonical-digest";
import { nodeExchange } from "./helpers/web-node";

const digest = (value: string) => sha256Digest(value);
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("db"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
const plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"),
  stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, digest(stage)])) });
const setup = createInstallationSetupViewV1({ plan: topology, localBackupRestoreVerified: false });

async function fixture() {
  let bridge: Parameters<NonNullable<Parameters<typeof createLocalSetupHostV1>[0]["createService"]>>[0] | undefined;
  let closed = 0; const calls = { render: 0, plan: 0, readiness: 0 };
  const host = createLocalSetupHostV1({ origin: "http://127.0.0.1:3210", port: 3210,
    assets: { count: 2, digest: digest("assets"), respond(path, method) {
      return ["/_next/static/app.js", "/favicon.svg"].includes(path)
        ? new Response(method === "HEAD" ? null : path === "/favicon.svg" ? "icon" : "asset") : undefined;
    } },
    render: () => { calls.render += 1; return new Response("setup-page", { headers: { "set-cookie": "forbidden=1" } }); },
    planSource: { async read() { calls.plan += 1; return { schema: LOCAL_SETUP_JOURNAL_SOURCE_V1, status: "available" as const,
      plan: createInstallationPlanViewV1(plan), restart: "ready_to_begin" as const, performsEffect: false as const,
      permitsRetry: false as const }; } },
    readinessSource: { async read() { calls.readiness += 1; return setup; } }, isApplicationReady: () => true,
    async closeApplication() { closed += 1; }, createService(candidate) { bridge = candidate;
      return { isReady: candidate.isReady, async start() {}, close: candidate.close }; } });
  if (!bridge) throw new Error("bridge_missing");
  async function send(path: string, options: { method?: string; headers?: string[]; peer?: string; host?: string } = {}) {
    const exchange = nodeExchange({ path, method: options.method, headers: options.headers, peer: options.peer });
    exchange.input.rawHeaders[1] = options.host ?? "127.0.0.1:3210";
    const completed = new Promise<void>((resolve, reject) => {
      (exchange.output as ServerResponse).once("finish", resolve); exchange.output.once("error", reject);
    });
    void bridge!.handle(exchange.input, exchange.output); await completed; return exchange;
  }
  return { host, send, closed: () => closed, calls: () => ({ ...calls }) };
}

test("local setup host exposes only the page, redacted reads, and verified assets", async t => {
  const f = await fixture(); t.after(() => f.host.close());
  assert.equal((await f.send("/setup")).body(), "setup-page");
  assert.equal((await f.send("/setup")).headers.has("set-cookie"), false);
  const planResponse = await f.send("/api/v1/installation-plan");
  assert.equal(planResponse.output.statusCode, 200);
  assert.match(planResponse.body(), /installation-plan-view/);
  assert.doesNotMatch(planResponse.body(), /sha256:|revision|inputDigest|outcomeDigest|planDigest/i);
  const readiness = await f.send("/api/v1/installation-readiness");
  assert.equal(readiness.output.statusCode, 200);
  assert.doesNotMatch(readiness.body(), /worker:local|connector:local|sha256:/);
  assert.equal((await f.send("/_next/static/app.js")).body(), "asset");
  assert.equal((await f.send("/favicon.svg")).body(), "icon");
  const head = await f.send("/setup", { method: "HEAD" }); assert.equal(head.output.statusCode, 200); assert.equal(head.body(), "");
  assert.equal((await f.send("/_next/static/app.js?x=1")).output.statusCode, 404);
  assert.equal((await f.send("/_next/static/missing.js")).output.statusCode, 404);
  assert.equal((await f.send("/projects")).output.statusCode, 404);
  await f.host.close(); assert.equal(f.closed(), 1);
});

test("local setup transport refuses credentials, forwarding, cross-site, writes, queries, wrong host and remote peers", async t => {
  const f = await fixture(); t.after(() => f.host.close());
  for (const headers of [["cookie", "owner=secret"], ["authorization", "Bearer secret"],
    ["cf-access-jwt-assertion", "secret"], ["x-forwarded-for", "127.0.0.1"], ["forwarded", "for=127.0.0.1"],
    ["sec-fetch-site", "cross-site"], ["sec-fetch-site", "same-site"], ["origin", "http://127.0.0.1:4444"]])
    assert.equal((await f.send("/setup", { headers })).output.statusCode, 403);
  assert.equal((await f.send("/setup", { method: "POST" })).output.statusCode, 405);
  assert.equal((await f.send("/setup?private=value")).output.statusCode, 404);
  assert.equal((await f.send("/setup", { host: "localhost:3210" })).output.statusCode, 403);
  assert.equal((await f.send("/setup", { peer: "192.0.2.1" })).output.statusCode, 403);
  assert.deepEqual(f.calls(), { render: 0, plan: 0, readiness: 0 });
});

test("malformed and unavailable setup readers fail closed without private detail", async () => {
  for (const mode of ["malformed-plan", "plan-error", "readiness-error"] as const) {
    let bridge: Parameters<NonNullable<Parameters<typeof createLocalSetupHostV1>[0]["createService"]>>[0] | undefined;
    const host = createLocalSetupHostV1({ origin: "http://127.0.0.1:3210", port: 3210,
      assets: { count: 2, digest: digest("assets"), respond: () => undefined }, render: () => new Response("setup"),
      planSource: { async read() {
        if (mode === "plan-error") throw new Error("private/path");
        if (mode === "malformed-plan") return { status: "available", plan: { privatePath: "/private/path" } } as never;
        return { schema: LOCAL_SETUP_JOURNAL_SOURCE_V1, status: "unavailable", performsEffect: false, permitsRetry: false };
      } }, readinessSource: { async read() { if (mode === "readiness-error") throw new Error("private/path"); return undefined; } },
      isApplicationReady: () => true, async closeApplication() {}, createService(candidate) { bridge = candidate;
        return { isReady: candidate.isReady, async start() {}, close: candidate.close }; } });
    if (!bridge) throw new Error("bridge_missing");
    const path = mode === "readiness-error" ? "/api/v1/installation-readiness" : "/api/v1/installation-plan";
    const exchange = nodeExchange({ path }); exchange.input.rawHeaders[1] = "127.0.0.1:3210";
    const completed = new Promise<void>((resolve, reject) => {
      exchange.output.once("finish", resolve); exchange.output.once("error", reject);
    });
    void bridge.handle(exchange.input, exchange.output); await completed;
    assert.equal(exchange.output.statusCode, 404); assert.doesNotMatch(exchange.body(), /private\/path/);
    await host.close();
  }
});

test("construction is inert and exact-loopback-only", async () => {
  let factories = 0;
  const base = { port: 3210, assets: { count: 2, digest: digest("assets"), respond: () => undefined },
    render: () => new Response("setup"), planSource: { async read() { return { schema: LOCAL_SETUP_JOURNAL_SOURCE_V1,
      status: "unavailable" as const, performsEffect: false as const, permitsRetry: false as const }; } },
    isApplicationReady: () => true, async closeApplication() {}, createService(bridge: Parameters<NonNullable<Parameters<typeof createLocalSetupHostV1>[0]["createService"]>>[0]) {
      factories += 1; return { isReady: bridge.isReady, async start() {}, close: bridge.close }; } };
  createLocalSetupHostV1({ ...base, origin: "http://127.0.0.1:3210" });
  assert.equal(factories, 1);
  for (const origin of ["http://localhost:3210", "https://127.0.0.1:3210", "http://127.0.0.1:3000", "http://0.0.0.0:3210"])
    assert.throws(() => createLocalSetupHostV1({ ...base, origin }), /local_setup_host_config_invalid|local_setup_serving_config_invalid/);
});
