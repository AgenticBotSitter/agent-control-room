// Real-PostgreSQL proof that the task-detail usage read is BOUNDED and still
// EXACT, run as the production private-web login against the real role files.
//
// Why this file exists
// --------------------
// #412 replaced a deliberately `LIMIT 11`-bounded reader on the task-detail path
// with `inspectUsageScope`, an unbounded `SELECT` over every run in the job with
// every event, HMAC-verified row by row in the application. Row volume — not
// query count — was the exposure, and it grew monotonically with project
// history. `tests/task-read-query-budget.test.ts` cannot see it: it counts
// round trips, which stayed constant.
//
// What it proves, on a real cluster, with 5,000 usage rows in scope:
//   1. BOUNDED — the total number of database rows that cross into the
//      application while serving task detail does not grow with run history.
//   2. EXACT — the totals it reports equal the totals of every one of those
//      5,000 runs, computed independently from the seeded data.
//   3. ROLE-CORRECT — the read runs as `control_room_private_web`, the login
//      both deployments use, with the real role files and no superuser bypass.
//
// (3) is why this is not written against a fake client. A `DatabaseClient`
// stub cannot be refused a privilege, so it would prove nothing about whether
// the aggregate is readable by the role that actually runs this page.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { WebTaskService } from "../src/web/v1/task-service";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { sha256Digest } from "../src/security";
import { rollupUsageGroupsV1, usagePriceTableSchemaV1 } from "../src/usage/v1/usage-cost";

import { PORT, PORTS, RUNS, MODEL, INTEGRITY_KEY, SCOPE, ids, perRun, priceTable, seedScope, seedRuns, traced, publisherClient, identity } from "./support/bounded-usage-fixture";

const PG = requiresRealPostgres();
let completed = 0;
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

test("the task-detail usage read stays bounded and exact across 5,000 runs of a real job", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    // Fixture seeding is superuser work — it CREATEs roles' rows that the web
    // login has no INSERT for. Only production code runs as the real role.
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      const publisher = publisherClient(postgres);
      try {
        await seedRuns(new HarnessRunStoreV1(publisher, INTEGRITY_KEY), admin, RUNS);
      } finally {
        await publisher.close();
      }
      const present = await admin.query<{ runs: string }>(
        "SELECT count(*)::text AS runs FROM control_harness_runs WHERE tenant_id=$1 AND project_id=$2",
      [ids.tenant, ids.project]);
      assert.equal(Number(present.rows[0]!.runs), RUNS, "the fixture must actually hold 5,000 runs");
    } finally { await admin.end(); }

    // ---- the production read, as the production login ----
    const login = postgres.connection("web");
    // The production driver and bounded-database wrapper over a real `pg.Pool`,
    // pointed at the kit's socket. `privatePgOptions` is not used because it
    // validates the host against the installed-deployment allowlist, and this
    // cluster is socket-only by construction — the transport differs, the driver,
    // the session qualification and the role do not.
    const pool = new Pool({ ...login, max: 4, application_name: "control-room-private-web",
      // The exact session parameters production's `privatePgOptions` sets, because
      // `qualifyPrivatePgSession` CHECKS them: a client that skipped them would be
      // refused, and loosening the check for a test would be testing something
      // else. Only `host` differs — the kit cluster is socket-only.
      options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
      statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 });
    const web = bindPrivatePgPool(pool);
    try {
      // The read must be reachable by THIS role: the aggregate's new
      // `payload->` and `snapshot->usage->` paths add no column the role files
      // do not already grant, and this proves it rather than assuming it.
      const direct = new Client(login);
      await direct.connect();
      try {
        const roles = await direct.query<{ current_user: string; rolsuper: boolean }>(
          "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_web");
        assert.equal(roles.rows[0]!.rolsuper, false, "the read must not run as a superuser");
      } finally { await direct.end(); }

      const watched = traced(web.client);
      const service = new WebTaskService(watched.client, SCOPE, () => Date.now(),
        { harnessIntegrityKey: INTEGRITY_KEY, usagePriceTable: priceTable });

      const detail = await service.detail(identity, ids.project, ids.job).catch((error: unknown) => {
        const carried = error as { cause?: { message?: string }; message?: string; statement?: string };
        // Unwrap the driver's opaque mapping so a query bug reports itself as one.
        const root = carried.cause ?? error as { message?: string };
        assert.fail(`task detail read failed: ${String(root?.message ?? carried.message)}`
          + `${carried.statement === undefined ? "" : `\nstatement: ${carried.statement.slice(0, 400)}`}`);
      });

      // ---- (1) BOUNDED ----
      // The page displays at most 10 attempts' worth of runs (11 read per attempt)
      // and at most a handful of aggregate groups, so the rows crossing into the
      // application are a small constant. With an unbounded read this is ~5,000.
      const rows = watched.rowsRead();
      assert.ok(rows <= 200,
        `task detail read ${rows} rows from the database for ${RUNS} runs in scope; the read is unbounded again`);
      t.diagnostic(`rows read by one task-detail read with ${RUNS} runs in scope: ${rows}`);

      // The page-level display bounds still hold, and they are what the row
      // budget is derived from rather than a coincidence.
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0]!.runs.length, 10, "the page still shows exactly its ten-run bound");
      assert.equal(detail.attempts[0]!.additionalRunsOmitted, true,
        "with 5,000 runs the page must say it is showing a subset");

      // ---- (2) EXACT ----
      // Computed from the seeded data, independently of the code under test.
      assert.equal(detail.usageRollup.runs, RUNS, "the rollup must count every run in scope, not the bounded subset");
      assert.equal(detail.usageRollup.inputTokens, RUNS * perRun.inputTokens);
      assert.equal(detail.usageRollup.outputTokens, RUNS * perRun.outputTokens);
      assert.equal(detail.usageRollup.totalTokens, RUNS * perRun.totalTokens);
      assert.equal(detail.usageRollup.wallTimeMs, RUNS * perRun.wallTimeMs);
      // No cached tokens on this fixture's runs, so cached nets 0 and the price
      // is purely input and output: RUNS × (100×1250 + 20×10000).
      assert.equal(detail.usageRollup.knownCostNanoUsd,
        (BigInt(RUNS) * (BigInt(perRun.inputTokens) * BigInt(1250) + BigInt(perRun.outputTokens) * BigInt(10000))).toString());
      assert.equal(detail.usageRollup.knownCostRuns, RUNS);
      assert.equal(detail.usageRollup.unknownCostRuns, 0);
      // The per-attempt rollup is exact over the same set, from the same read.
      assert.equal(detail.attempts[0]!.usageRollup.runs, RUNS);
      assert.equal(detail.attempts[0]!.usageRollup.inputTokens, RUNS * perRun.inputTokens);
      assert.equal(detail.attempts[0]!.usageRollup.knownCostNanoUsd, detail.usageRollup.knownCostNanoUsd);

      // The displayed runs are the ten genuinely store-signed ones: the bounded
      // reader must still authenticate every row the page shows.
      assert.equal(detail.attempts[0]!.runs[0]!.usage?.inputTokens, perRun.inputTokens);
      assert.equal(detail.attempts[0]!.runs[0]!.cost.kind, "known");
      assert.equal(detail.attempts[0]!.runs[0]!.cost.nanoUsd,
        (BigInt(perRun.inputTokens) * BigInt(1250) + BigInt(perRun.outputTokens) * BigInt(10000)).toString());

      // ---- the project overview, the other read this fix touches ----
      const overviewWatch = traced(web.client);
      const overview = await new WebTaskService(overviewWatch.client,
        SCOPE, () => Date.now(), { harnessIntegrityKey: INTEGRITY_KEY, usagePriceTable: priceTable })
        .projectOverview(identity, ids.project);
      assert.ok(overviewWatch.rowsRead() <= 200,
        `project overview read ${overviewWatch.rowsRead()} rows for ${RUNS} runs in scope`);
      assert.equal(overview.usageRollup.runs, RUNS);
      assert.equal(overview.usageRollup.inputTokens, RUNS * perRun.inputTokens);
      assert.equal(overview.usageRollup.knownCostNanoUsd, detail.usageRollup.knownCostNanoUsd);
    } finally { await web.close(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 240_000 });
  completed += 1;
});

test("runs whose harness reported tokens but omitted the cache key still price", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      const createdAt = new Date(Date.now() - 100_000).toISOString();
      const finishedAt = new Date(Date.now() - 90_000).toISOString();
      // Three harness shapes that all reported tokens, all WITHOUT a cache key --
      // the shape the producers now record as an explicit zero. Codex, Claude
      // and Hermes, so the proof covers the three harnesses the fix touches
      // rather than one convenient row.
      const shapes = [
        { suffix: "codex", harness: "codex", input: 100, output: 20, total: 120 },
        { suffix: "claude", harness: "claude", input: 80, output: 20, total: 100 },
        { suffix: "hermes", harness: "hermes", input: 50, output: 10, total: 60 },
      ];
      // Written ONLY through the real `HarnessRunStoreV1`, as the production
      // evidence role, so every row the read authenticates carries a real digest.
      // A plain-SQL pre-insert would leave placeholder digests behind and the
      // store would refuse the run that tried to own the id.
      const publisher = publisherClient(postgres);
      try {
        for (const shape of shapes) {
          const runId = `run:bounded-usage-producer-zero:${shape.suffix}`;
          const store = new HarnessRunStoreV1(publisher, INTEGRITY_KEY);
          await store.create({
            schemaVersion: "control-room-harness/v1", id: runId, tenantId: ids.tenant, projectId: ids.project,
            jobId: ids.job, attemptId: ids.attempt, nodeId: ids.node, adapterId: ids.adapter,
            adapterVersion: "1.0.0", harness: shape.harness as "codex" | "claude" | "hermes",
            harnessVersion: "producer-zero-1",
            nativeSessionKeyDigest: sha256Digest({ purpose: "bounded-usage-producer-zero", runId }),
            modelSelection: { model: MODEL, effort: "medium" }, state: "discovered", resumable: false,
            cancelState: "not_requested", createdAt, updatedAt: createdAt, lastObservedAt: createdAt });
          for (const [sequence, occurredAt, payload] of [
            [1, createdAt, { category: "lifecycle" as const, state: "starting" as const }],
            [2, createdAt, { category: "lifecycle" as const, state: "running" as const }],
            [3, finishedAt, { category: "usage" as const, inputTokens: shape.input, outputTokens: shape.output,
              totalTokens: shape.total, cachedInputTokens: 0, reasoningTokens: null, wallTimeMs: 250 }],
            [4, finishedAt, { category: "lifecycle" as const, state: "succeeded" as const }],
          ] as const) {
            await store.append({ schemaVersion: "control-room-harness-event/v1", tenantId: ids.tenant, runId,
              sequence, occurredAt, source: "adapter", sourceEventKeyDigest: sha256Digest({ runId, sequence }), payload });
          }
        }
      } finally { await publisher.close(); }

      const login = postgres.connection("web");
      const web = bindPrivatePgPool(new Pool({ ...login, max: 4, application_name: "control-room-private-web",
        options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
        statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }));
      try {
        const groups = await new HarnessRunStoreV1(web.client, INTEGRITY_KEY)
          .inspectUsageRollup(ids.tenant, ids.project, ids.job);
        // Three harnesses, one group each: harness is in the grouping key.
        assert.equal(groups.length, 3, `the three harnesses must not collapse: ${JSON.stringify(groups)}`);
        // Every group carries a KNOWN cache count, never null. This is the
        // assertion the whole fix rests on: a null here would put all three
        // runs on `cached_usage_not_reported` and the page would read Unknown.
        for (const group of groups) assert.notEqual(group.cachedInputTokens, null,
          `${group.harness} reported tokens with no cache key; its cache count must be an explicit 0, not unknown`);
        // The price table prices Codex only for `MODEL`, so extend it here
        // rather than asserting on harnesses that were never priced: this
        // test is about the CACHE count surviving, not about the price table.
        const priced = usagePriceTableSchemaV1.parse({
          schema: "control-room.usage-price-table/v1", tableId: "owner-prices-bounded-usage",
          recordedAt: "2026-09-29T00:00:00.000Z",
          entries: [
            priceTable.entries[0],
            { entryId: "bounded-usage-claude-price", harness: "claude" as const, model: MODEL,
              billing: { kind: "token" as const, inputNanoUsdPerToken: "1250", outputNanoUsdPerToken: "10000" } },
            { entryId: "bounded-usage-hermes-price", harness: "hermes" as const, model: MODEL,
              billing: { kind: "token" as const, inputNanoUsdPerToken: "1250", outputNanoUsdPerToken: "10000" } },
          ] });
        const rollup = rollupUsageGroupsV1(groups, priced);
        assert.deepEqual(rollup.unknownCostReasons, [],
          `every run here reported tokens and a zero cache count, so none may refuse: ${JSON.stringify(rollup)}`);
        assert.equal(rollup.unknownCostRuns, 0);
        assert.equal(rollup.knownCostRuns, 3, "all three previously-unknown runs are priced again");
        // Code: 100 in x 1250 + 20 out x 10000 = 125000 + 200000 = 325000.
        // Claude: 80 x 1250 + 20 x 10000 = 100000 + 200000 = 300000.
        // Hermes: 50 x 1250 + 10 x 10000 = 62500 + 100000 = 162500.
        assert.equal(rollup.knownCostNanoUsd,
          (BigInt(325_000) + BigInt(300_000) + BigInt(162_500)).toString());
        // The token totals are unchanged by any of this.
        assert.equal(rollup.runs, 3);
        assert.equal(rollup.inputTokens, 100 + 80 + 50);
        assert.equal(rollup.outputTokens, 20 + 20 + 10);
      } finally { await web.close(); }
    } finally { await admin.end(); }
  }, { port: PORT + 4, allowedPorts: PORTS, boundMs: 240_000 });
  completed += 1;
});

test("the bounded-usage real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(completed, 0, "a lane without PostgreSQL completes no cluster bodies"); return; }
  assert.equal(completed, 2, "a required-but-skipped cluster test must fail the run");
});
