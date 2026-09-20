import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration";
import { validatePrivateStartupConfiguration } from "../src/web/v1/private-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";
import { now, origin, request, token, trust } from "./helpers/web-foundation";
import { limitedWebFixture } from "./helpers/web-startup";

const configuration = (displayName: string, ideaLab: boolean) => ({
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1, displayName, defaultTimezone: "UTC",
  modules: { ideaLab, news: false, sessionObservations: false },
  limits: { maxProjects: 9, maxTasksPerProject: 9, maxResultsPerTask: 9, maxArticleSources: 0, maxIdeaParticipants: 0 },
  projectTemplates: [{ id: "ordinary", displayName: "Ordinary", enabledModules: [] }],
});

const options = (productConfiguration: ReturnType<typeof configuration>, database: Awaited<ReturnType<typeof limitedWebFixture>>["client"],
  close: () => Promise<void>) => ({ origin, ...trust,
  tenantId: "tenant:web", workspaceId: "workspace:web",
  database: { client: database, close }, loadKeys: async () => trust.keys,
  clock: () => now, productConfiguration });

test("two same-artifact processes retain distinct immutable portable configurations", async t => {
  const firstStore = await limitedWebFixture();
  const secondStore = await limitedWebFixture();
  const firstInput = configuration("Research Room", true);
  const secondInput = configuration("Operations Room", false);
  const first = createPrivateWebProcess(options(firstInput, firstStore.pool.client, firstStore.pool.close));
  const second = createPrivateWebProcess(options(secondInput, secondStore.pool.client, secondStore.pool.close));
  t.after(async () => { await first.close(); await second.close(); });
  firstInput.displayName = "mutated";
  const call = (app: typeof first, path: string) => app.handle(request(path), () => new Response("fallback", { status: 500 }));
  const one = await call(first, "/api/v1/product-configuration");
  const two = await call(second, "/api/v1/product-configuration");
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.equal((await one.json()).displayName, "Research Room");
  assert.equal((await two.json()).displayName, "Operations Room");
  assert.equal((await call(second, "/api/v1/ideas")).status, 404);
  assert.equal((await call(first, "/api/v1/product-configuration?after=x")).status, 400);
  const unknown = await first.handle(request("/api/v1/product-configuration", "GET", undefined,
    "test-request-key-0002", token({ sub: "unknown-owner" })), () => new Response("fallback", { status: 500 }));
  assert.equal(unknown.status, 403);
});

test("startup capture does not retain a mutable owner-settings product configuration", () => {
  const input = configuration("Isolated", false);
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, productConfiguration: input, ownerIdentityId: "identity:web", database: {
    host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
  } });
  input.displayName = "mutated";
  assert.equal(startup.productConfiguration?.displayName, "Isolated");
  assert.equal(Object.isFrozen(startup.productConfiguration), true);
});

test("startup capture preserves a reviewed immutable installation plan", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, ownerIdentityId: "identity:web", installationTopologyPlan: plan, database: {
      host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
    } });
  assert.equal(startup.installationTopologyPlan?.mode, "this_computer");
  assert.equal(Object.isFrozen(startup.installationTopologyPlan), true);
});

test("a saved installation plan is an authenticated read-only setup status", async t => {
  const store = await limitedWebFixture();
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-db"), schedulerAuthorityDigest: sha256Digest("one-scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" },
      { kind: "remote", workerId: "worker:remote", adapterId: "connector:remote-v1", adapterRevision: "00570550" }] });
  const app = createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close), installationTopologyPlan: plan });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/installation-topology"), () => new Response("fallback", { status: 500 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "several_computers");
  assert.equal((await app.handle(request("/api/v1/installation-topology?x=1"), () => new Response("fallback", { status: 500 }))).status, 400);
});
