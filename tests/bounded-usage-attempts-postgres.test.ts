// CR-E081 usage shard: unchanged real publisher-to-web reader assertions.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { WebTaskService } from "../src/web/v1/task-service";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { sha256Digest } from "../src/security";
import { rollupUsageGroupsV1 } from "../src/usage/v1/usage-cost";

import { PORT, PORTS, MODEL, INTEGRITY_KEY, SCOPE, ids, perRun, priceTable, seedScope, traced, publisherClient, identity } from "./support/bounded-usage-fixture";

const PG = requiresRealPostgres();
let completed = 0;
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

test("the per-attempt rollup read stays bounded when a job has more attempts than the page shows", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  /** Four times the page's ten-attempt display bound. */
  const ATTEMPTS = 40;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      const createdAt = new Date(Date.now() - 100_000).toISOString();
      const finishedAt = new Date(Date.now() - 90_000).toISOString();
      const digest = `sha256:${"b".repeat(64)}`, tag = `hmac-sha256:${"c".repeat(64)}`;
      // The displayed ten are the HIGHEST attempt numbers: `detail()` reads
      // `ORDER BY attempt_number DESC LIMIT 11` then takes ten, so the page
      // renders the newest retries. The older attempts below them are the
      // history a per-attempt aggregate must not pay for.
      //
      // `seedScope` already inserted attempt 1 (it is the one `HarnessRunStoreV1`
      // accepts, being nonterminal), and that attempt has no runs — which is
      // realistic: an attempt can fail before it launches anything. The
      // remaining `ATTEMPTS` therefore start at 2, and EVERY one of them carries
      // exactly one run, so the job's total run count equals `ATTEMPTS` and the
      // headline total is `ATTEMPTS` runs across `ATTEMPTS + 1` attempts.
      // `HarnessRunStoreV1.create` refuses a run whose attempt is not
      // leased/running/waiting, so the ten store-signed attempts are inserted
      // `running` and the older bulk ones `succeeded`. Both are states the page
      // renders, and it is the newest ten the page displays either way.
      const newestTenFrom = ATTEMPTS + 1 - 10;
      // Two inserts rather than one conditional: a `running` attempt must not
      // carry a `finishedAt` KEY at all, and a JSON null is a PRESENT key, so
      // `attemptRecordSchema` rejects it. `task-service.ts` parses this payload
      // for every attempt the page renders, so a null fails the whole detail
      // read. Two statements state the two shapes honestly instead of building
      // one object and deleting a key from it.
      const attemptRows = (state: string, version: number, finished: boolean) => `INSERT INTO control_attempts
        (id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
        SELECT 'attempt:bounded-usage-history:'||lpad(g::text,3,'0'),$1::text,$2::text,g,${state},${version},$3::text,1,
          jsonb_build_object('id','attempt:bounded-usage-history:'||lpad(g::text,3,'0'),'kind','attempt',
            'tenantId',$1::text,'contractVersion','control-room-domain/v1','jobId',$2::text,
            'state',${state}::text,'version',${version},'nodeId',$3::text,'createdAt',$4::text,
            'offeredAt',$4::text,'startedAt',$4::text,'updatedAt',$4::text
            ${finished ? `,'finishedAt',$4::text` : ""},
            'leaseEpoch',1,'attemptNumber',g),
          $5::timestamptz,$5::timestamptz
        FROM generate_series($6::int,$7::int) g`;
      const attemptArgs = (from: number, to: number) =>
        [ids.tenant, ids.job, ids.node, createdAt, createdAt, from, to];
      // The older attempts are terminal; the newest ten are still `running`,
      // which is the only state (with leased/waiting) `HarnessRunStoreV1.create`
      // will attach a run to.
      await admin.query(attemptRows("'succeeded'", 2, true), attemptArgs(2, newestTenFrom - 1));
      await admin.query(attemptRows("'running'", 1, false), attemptArgs(newestTenFrom, ATTEMPTS + 1));
      // One run and one usage event per attempt, every run the same pricing
      // shape: so a bounded read returns at most one group per DISPLAYED
      // attempt, and the count cannot be inflated by shape variety.
      //
      // The run series covers the OLDER attempts only — 2..(ATTEMPTS + 1 - 10) —
      // and the ten NEWEST attempts are written through the real
      // `HarnessRunStoreV1` below. That split is forced, not cosmetic: the page
      // authenticates every run and event it DISPLAYS with
      // `verifyStoredHarnessRunV1`, and it displays the ten newest attempts, so
      // those ten must carry real HMACs or the read throws
      // `harness event integrity failure`. The older attempts are never
      // displayed, and the bounded aggregate deliberately hands the application
      // no event payload for them at all, so a placeholder digest is sufficient
      // for them — which is the same split, and the same reason, as the
      // 5,000-run fixture above.
      await admin.query(`INSERT INTO control_harness_runs
        (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,
         state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
        SELECT 'run:bounded-usage-history:'||lpad(g::text,3,'0'),$1::text,$2::text,$3::text,
          'attempt:bounded-usage-history:'||lpad(g::text,3,'0'),$4::text,$5::text,'codex',
          'sha256:'||md5(g::text)||md5(('hist'||g::text)::text),'succeeded',1,$6::text,$7::text,
          jsonb_build_object('schemaVersion','control-room-harness/v1','id','run:bounded-usage-history:'||lpad(g::text,3,'0'),
            'tenantId',$1::text,'projectId',$2::text,'jobId',$3::text,
            'attemptId','attempt:bounded-usage-history:'||lpad(g::text,3,'0'),'nodeId',$4::text,
            'adapterId',$5::text,'adapterVersion','1.0.0','harness','codex','harnessVersion','codex-history-1',
            'nativeSessionKeyDigest','sha256:'||md5(g::text)||md5(('hist'||g::text)::text),
            'modelSelection',jsonb_build_object('model',$8::text,'effort','medium'),'state','succeeded',
            'resumable',false,'cancelState','not_requested','createdAt',$9::text,'startedAt',$9::text,
            'updatedAt',$10::text,'finishedAt',$10::text,'lastObservedAt',$10::text),
          $9::timestamptz,$10::timestamptz,$10::timestamptz
        FROM generate_series(2,$11::int) g`,
      [ids.tenant, ids.project, ids.job, ids.node, ids.adapter, digest, tag, MODEL,
        createdAt, finishedAt, newestTenFrom - 1]);
      await admin.query(`INSERT INTO control_harness_run_events
        (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at)
        SELECT $1::text,'run:bounded-usage-history:'||lpad(g::text,3,'0'),1,$9::timestamptz,'adapter',
          $3::text,$3::text,$4::text,
          jsonb_build_object('schemaVersion','control-room-harness-event/v1','tenantId',$1::text,
            'runId','run:bounded-usage-history:'||lpad(g::text,3,'0'),'sequence',1,'occurredAt',$2::text,'source','adapter',
            'sourceEventKeyDigest',$3::text,
            'payload',jsonb_build_object('category','usage','inputTokens',$5::int,'outputTokens',$6::int,
              'totalTokens',$7::int,'cachedInputTokens',0,'reasoningTokens',null,'wallTimeMs',$8::int)),
          $9::timestamptz
        FROM generate_series(2,$10::int) g`,
      // The ISO string ($2) is a SEPARATE parameter from the `timestamptz` ($9) it
      // becomes. Reusing one parameter cannot work: PostgreSQL resolves a
      // parameter's type once, so `$9::timestamptz` in the column and `$2::text`
      // in the JSON must not share a parameter, or the text cast renders a
      // PostgreSQL timestamp literal that `harnessRunEventSchemaV1` rejects as
      // `occurredAt`.
      [ids.tenant, finishedAt, digest, tag, perRun.inputTokens, perRun.outputTokens, perRun.totalTokens,
        perRun.wallTimeMs, finishedAt, newestTenFrom - 1]);
      // The ten the page actually displays, written through the real store as the
      // production evidence role, so the runs the page authenticates are genuine.
      const publisher = publisherClient(postgres);
      try {
        for (let attempt = newestTenFrom; attempt <= ATTEMPTS + 1; attempt += 1) {
          const suffix = String(attempt).padStart(3, "0"), runId = `run:bounded-usage-signed:${suffix}`;
          const created = new Date(Date.now() - 100_000 + attempt * 1_000).toISOString();
          const finished = new Date(Date.now() - 90_000 + attempt * 1_000).toISOString();
          await new HarnessRunStoreV1(publisher, INTEGRITY_KEY).create({
            schemaVersion: "control-room-harness/v1", id: runId, tenantId: ids.tenant, projectId: ids.project,
            jobId: ids.job, attemptId: `attempt:bounded-usage-history:${suffix}`, nodeId: ids.node,
            adapterId: ids.adapter, adapterVersion: "1.0.0", harness: "codex", harnessVersion: "codex-history-1",
            nativeSessionKeyDigest: sha256Digest({ purpose: "bounded-usage-history", runId }),
            modelSelection: { model: MODEL, effort: "medium" }, state: "discovered", resumable: false,
            cancelState: "not_requested", createdAt: created, updatedAt: created, lastObservedAt: created });
          for (const [sequence, occurredAt, payload] of [
            [1, created, { category: "lifecycle" as const, state: "starting" as const }],
            [2, created, { category: "lifecycle" as const, state: "running" as const }],
            [3, finished, { category: "usage" as const, inputTokens: perRun.inputTokens,
              outputTokens: perRun.outputTokens, totalTokens: perRun.totalTokens, cachedInputTokens: 0,
              reasoningTokens: null, wallTimeMs: perRun.wallTimeMs }],
            [4, finished, { category: "lifecycle" as const, state: "succeeded" as const }],
          ] as const) {
            await new HarnessRunStoreV1(publisher, INTEGRITY_KEY).append({
              schemaVersion: "control-room-harness-event/v1", tenantId: ids.tenant, runId, sequence,
              occurredAt, source: "adapter", sourceEventKeyDigest: sha256Digest({ runId, sequence }), payload });
          }
        }
      } finally { await publisher.close(); }

      const login = postgres.connection("web");
      const web = bindPrivatePgPool(new Pool({ ...login, max: 4, application_name: "control-room-private-web",
        options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
        statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }));
      try {
        // The page's own ten: the newest ten attempt numbers, which is what
        // `detail()` renders. Derived here from the same ordering the page uses
        // rather than hard-coded, so the test cannot drift from the read path.
        const displayed = (await admin.query<{ id: string }>(
          "SELECT id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 ORDER BY attempt_number DESC LIMIT 11",
        [ids.tenant, ids.job])).rows.map(row => row.id).slice(0, 10);
        assert.equal(displayed.length, 10, "the page's own attempt bound is ten");

        const store = new HarnessRunStoreV1(web.client, INTEGRITY_KEY);
        const groups = await store.inspectUsageRollup(ids.tenant, ids.project, ids.job, displayed);
        // One group per displayed attempt, and no more: the thirty attempts the
        // page does not render contribute nothing, so the read is a function of
        // the set passed in rather than of the job's retry history.
        assert.equal(groups.length, displayed.length,
          `the per-attempt read returned ${groups.length} group(s) for ${displayed.length} displayed attempts`
          + ` and a job with ${ATTEMPTS} attempts: ${JSON.stringify(groups.map(one => one.attemptId))}`);
        assert.equal(new Set(groups.map(one => one.attemptId)).size, groups.length, "one group per attempt, not one covering several");
        for (const group of groups) assert.ok(displayed.includes(group.attemptId!),
          `the read returned a group for an attempt the page does not display: ${group.attemptId}`);

        // The headline total is a SEPARATE, job-wide read, and it must still
        // cover every attempt — including the thirty the page omits. That is why
        // this cannot be derived by splitting the per-attempt read.
        const jobWide = await store.inspectUsageRollup(ids.tenant, ids.project, ids.job);
        const jobRollup = rollupUsageGroupsV1(jobWide, priceTable);
        assert.equal(jobRollup.runs, ATTEMPTS,
          "the job-wide total must cover every attempt the job has recorded, not only the ten displayed");
        assert.equal(jobRollup.inputTokens, ATTEMPTS * perRun.inputTokens);
        assert.equal(jobRollup.knownCostNanoUsd,
          (BigInt(ATTEMPTS) * (BigInt(perRun.inputTokens) * BigInt(1250)
            + BigInt(perRun.outputTokens) * BigInt(10000))).toString());

        // And the page as the whole service reads it: a job with 40 attempts
        // must serve task detail within the same small row budget as a job with
        // one, with a per-attempt rollup for each of the ten it renders.
        const watched = traced(web.client);
        const detail = await new WebTaskService(watched.client, SCOPE, () => Date.now(),
          { harnessIntegrityKey: INTEGRITY_KEY, usagePriceTable: priceTable })
          .detail(identity, ids.project, ids.job);
        const rows = watched.rowsRead();
        assert.ok(rows <= 200,
          `task detail read ${rows} rows for a job with ${ATTEMPTS} attempts; the per-attempt read is unbounded again`);
        assert.equal(detail.attempts.length, 10, "the page renders its own ten-attempt bound");
        assert.equal(detail.usageRollup.runs, ATTEMPTS, "the headline total covers all 40 attempts");
        assert.equal(detail.attempts[0]!.usageRollup.runs, 1, "each displayed attempt rolls up its own runs only");
        t.diagnostic(`rows read by one task-detail read with ${ATTEMPTS} attempts: ${rows}`);
      } finally { await web.close(); }
    } finally { await admin.end(); }
  }, { port: PORT + 3, allowedPorts: PORTS, boundMs: 240_000 });
  completed += 1;
});

test("the bounded-usage attempts proof completed when PostgreSQL is available", () => {
  if (!PG) { assert.equal(completed, 0, "a lane without PostgreSQL completes no cluster bodies"); return; }
  assert.equal(completed, 1, "a required-but-skipped cluster test must fail the run");
});
