// CR-E081 usage shard: unchanged real publisher-to-web reader assertions.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";

import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { sha256Digest } from "../src/security";
import { rollupUsageGroupsV1 } from "../src/usage/v1/usage-cost";

import { PORT, PORTS, MODEL, UNCACHED_MODEL, INTEGRITY_KEY, ids, AUTHORITY_DIGEST, priceTable, seedScope, identity } from "./support/bounded-usage-fixture";

const PG = requiresRealPostgres();
let completed = 0;
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

test("the usage aggregate never merges two runs that price differently", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      const createdAt = new Date(Date.now() - 100_000).toISOString();
      const finishedAt = new Date(Date.now() - 90_000).toISOString();
      const digest = `sha256:${"b".repeat(64)}`, tag = `hmac-sha256:${"c".repeat(64)}`;
      // `priced` is on the cache-priced model, `unpriced` on the model whose entry
      // deliberately records no cache rate (see the price table below).
      // `priced` and `nocache` share a MODEL and differ only in whether any cache
      // tokens were reported — that pair is what `cached_input_tokens > 0` in the
      // GROUP BY exists to separate. `unpriced` differs in price, `contradiction`
      // in whether the billable input count is negative.
      const shapes = [
        { suffix: "priced", model: MODEL, input: 1000, output: 500, total: 1500, cached: 900, wall: 10 },
        { suffix: "nocache", model: MODEL, input: 1000, output: 500, total: 1500, cached: 0, wall: 10 },
        { suffix: "unpriced", model: UNCACHED_MODEL, input: 1000, output: 500, total: 1500, cached: 900, wall: 10 },
        { suffix: "contradiction", model: MODEL, input: 100, output: 20, total: 120, cached: 900, wall: 10 },
      ];
      await admin.query(`INSERT INTO control_harness_runs
        (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,
         state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
        SELECT 'run:bounded-usage-shape:'||s.suffix,$1::text,$2::text,$3::text,$4::text,$5::text,$6::text,'codex',
          'sha256:'||md5(s.suffix)||md5(('shape'||s.suffix)::text),'succeeded',4,$7::text,$8::text,
          jsonb_build_object('schemaVersion','control-room-harness/v1','id','run:bounded-usage-shape:'||s.suffix,
            'tenantId',$1::text,'projectId',$2::text,'jobId',$3::text,'attemptId',$4::text,'nodeId',$5::text,
            'adapterId',$6::text,'adapterVersion','1.0.0','harness','codex','harnessVersion','codex-shape-1',
            'nativeSessionKeyDigest','sha256:'||md5(s.suffix)||md5(('shape'||s.suffix)::text),
            'modelSelection',jsonb_build_object('model',s.model,'effort','medium'),'state','succeeded',
            'resumable',false,'cancelState','not_requested','createdAt',$9::text,'startedAt',$9::text,
            'updatedAt',$10::text,'finishedAt',$10::text,'lastObservedAt',$10::text),
          $9::timestamptz,$10::timestamptz,$10::timestamptz
        FROM unnest($11::text[],$12::text[],$13::int[],$14::int[],$15::int[],$16::int[],$17::int[])
          AS s(suffix,model,input,output,total,cached,wall)`,
      [ids.tenant, ids.project, ids.job, ids.attempt, ids.node, ids.adapter, digest, tag, createdAt, finishedAt,
        shapes.map(s => s.suffix), shapes.map(s => s.model), shapes.map(s => s.input), shapes.map(s => s.output),
        shapes.map(s => s.total), shapes.map(s => s.cached), shapes.map(s => s.wall)]);
      await admin.query(`INSERT INTO control_harness_run_events
        (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at)
        SELECT $1::text,'run:bounded-usage-shape:'||s.suffix,4,$2::timestamptz,'adapter',$3::text,$3::text,$4::text,
          jsonb_build_object('schemaVersion','control-room-harness-event/v1','tenantId',$1::text,
            'runId','run:bounded-usage-shape:'||s.suffix,'sequence',4,'occurredAt',$2::text,'source','adapter',
            'sourceEventKeyDigest',$3::text,
            'payload',jsonb_build_object('category','usage','inputTokens',s.input,'outputTokens',s.output,
              'totalTokens',s.total,'cachedInputTokens',s.cached,'reasoningTokens',null,'wallTimeMs',s.wall)),
          $2::timestamptz
        FROM unnest($5::text[],$6::int[],$7::int[],$8::int[],$9::int[],$10::int[])
          AS s(suffix,input,output,total,cached,wall)`,
      [ids.tenant, finishedAt, digest, tag, shapes.map(s => s.suffix), shapes.map(s => s.input),
        shapes.map(s => s.output), shapes.map(s => s.total), shapes.map(s => s.cached), shapes.map(s => s.wall)]);

      const login = postgres.connection("web");
      const web = bindPrivatePgPool(new Pool({ ...login, max: 4, application_name: "control-room-private-web",
        options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
        statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }));
      try {
        const groups = await new HarnessRunStoreV1(web.client, INTEGRITY_KEY)
          .inspectUsageRollup(ids.tenant, ids.project, ids.job);
        // Three runs, three pricing branches: they must be three GROUPS, not one.
        assert.equal(groups.length, 4,
          `four differently-priced runs collapsed into ${groups.length} group(s): ${JSON.stringify(groups)}`);
        const rollup = rollupUsageGroupsV1(groups, priceTable);
        // `rollupUsageGroupsV1` already returns the reasons sorted.
        assert.deepEqual(rollup.unknownCostReasons,
          ["cache_pricing_not_recorded", "partial_token_usage"],
          "each run's own refusal must survive the aggregate; none may borrow another's");
        assert.equal(rollup.knownCostRuns, 2,
          "only runs whose branch prices as known may produce a figure");
        // `priced`: 100 billable input x 1250 + 500 output x 10000 + 900 cached x 125.
        // `nocache`: 1000 input x 1250 + 500 output x 10000, no cache rate involved.
        assert.equal(rollup.knownCostNanoUsd,
          (BigInt(100) * BigInt(1250) + BigInt(500) * BigInt(10000) + BigInt(900) * BigInt(125)
            + BigInt(1000) * BigInt(1250) + BigInt(500) * BigInt(10000)).toString());
        // The displayed token sums still cover all four runs, refusals and all.
        assert.equal(rollup.runs, 4);
        // The REPORTED input counts (2100), not the billable ones. Codex's cached
        // tokens are a SUBSET of its input, so the page has always shown what the
        // run reported; only the COST nets them off. Presenting the net figure
        // would silently understate the tokens a run consumed.
        assert.equal(rollup.inputTokens, 1000 + 1000 + 1000 + 100,
          "the rollup must display reported input tokens, not the Codex-netted billable count");
        assert.equal(rollup.outputTokens, 500 + 500 + 500 + 20);
        assert.equal(rollup.totalTokens, 1500 + 1500 + 1500 + 120);
      } finally { await web.close(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 240_000 });
  completed += 1;
});

test("the usage aggregate reports the same evidence precedence the per-run path does", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      // Whole-second timestamps: `EXTRACT(EPOCH ...)` on a millisecond instant
      // lands 1-2ms either side of the second, which would make a duration
      // assertion depend on the wall clock's sub-second component.
      const startedAtMs = Math.floor(Date.now() / 1000) * 1000;
      const start = new Date(startedAtMs - 100_000).toISOString();
      const finish = new Date(startedAtMs - 30_000).toISOString(); // 70s of observed duration
      const digest = `sha256:${"b".repeat(64)}`, tag = `hmac-sha256:${"c".repeat(64)}`;

      // 1. No usage event at all, but the run started and finished. The per-run
      //    path reports wall time ALONE for this run, so a project containing it
      //    has a real wall-time total and reasons `usage_not_reported`. An
      //    aggregate that only looked inside a usage-event lateral dropped the
      //    duration and turned the whole total null.
      // 2. A native snapshot whose usage omits `totalTokens`. The per-run path
      //    reads the snapshot's total verbatim and does NOT derive input+output
      //    for a snapshot, so this run's total is null, not 48.
      // 3. An early snapshot WITH usage, then a later one whose `usage` is null.
      //    The later snapshot is the current observation, so the run reports
      //    nothing at all; resurrecting the superseded snapshot's numbers is
      //    reading evidence the owner has already seen superseded.
      // The superseded run gets its OWN job and attempt. Its whole point is that
      // it reports nothing: a later native snapshot says the run has no usage.
      // Read inside a scope with the other two, that reads as `null` either way,
      // because their runs are silent too — so the check has to see the run alone,
      // where a resurrected 900/900/1800 would be unmissable.
      const soloJob = `${ids.job}-solo`, soloAttempt = `${ids.attempt}-solo`;
      await admin.query(`INSERT INTO control_requests (id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
        SELECT $1::text,$2::text,$3::text,'accepted',0,$1::text,
          jsonb_build_object('id',$1::text,'kind','request','tenantId',$2::text,'projectId',$3::text,
            'contractVersion','control-room-domain/v1','title','Solo','objective','Solo scope.',
            'state','accepted','version',0,'priority',50,
            'requestedBy',jsonb_build_object('actorId',$4::text,'actorType','human'),'idempotencyKey',$1::text,
            'createdAt',$5::text,'updatedAt',$5::text),$5::timestamptz,$5::timestamptz`,
        [soloJob, ids.tenant, ids.project, ids.identity, start]);
      await admin.query(`INSERT INTO control_workflows (id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
        SELECT $1::text,$2::text,$3::text,$4::text,$5::text,'active',1,
          jsonb_build_object('id',$1::text,'kind','workflow','tenantId',$2::text,'requestId',$3::text,
            'projectId',$4::text,'contractVersion','control-room-domain/v1','definitionVersion','1.0.0',
            'definitionDigest',$5::text,'authorityMode','control_room_native','state','active','version',1,
            'jobIds',jsonb_build_array($3::text),'createdAt',$6::text,'updatedAt',$6::text),
          $6::timestamptz,$6::timestamptz`,
        [`${soloJob}-workflow`, ids.tenant, soloJob, ids.project, AUTHORITY_DIGEST, start]);
      // The solo job needs its own row: `control_attempts.job_id` is a foreign
      // key, and the mirrored payload must carry the same `priority`,
      // `requiredCapability` and `authority.digest` the original job row does.
      await admin.query(`INSERT INTO control_jobs
        (id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,
         created_at,updated_at)
        SELECT $1::text,$2::text,$3::text,$4::text,'leased',1,50,'fixture',$5::text,
          payload || jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','leased','version',1,
            'workflowId',$3::text,'projectId',$4::text,'createdAt',$6::text,'updatedAt',$6::text),
          $6::timestamptz,$6::timestamptz
        FROM control_jobs WHERE tenant_id=$2::text AND id=$7::text`,
        [soloJob, ids.tenant, `${soloJob}-workflow`, ids.project, AUTHORITY_DIGEST, start, ids.job]);
      await admin.query(`INSERT INTO control_attempts (id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
        VALUES($1::text,$2::text,$3::text,1,'running',1,$4::text,1,
          jsonb_build_object('id',$1::text,'kind','attempt','tenantId',$2::text,'contractVersion','control-room-domain/v1',
            'jobId',$3::text,'state','running','version',1,'nodeId',$4::text,'createdAt',$5::text,'offeredAt',$5::text,
            'startedAt',$5::text,'updatedAt',$5::text,'leaseEpoch',1,'attemptNumber',1),$5::timestamptz,$5::timestamptz)`,
        [soloAttempt, ids.tenant, soloJob, ids.node, start]);
      const runs = [
        { suffix: "noevent", kind: "none", job: ids.job, attempt: ids.attempt },
        { suffix: "snapshot-partial", kind: "snapshot", job: ids.job, attempt: ids.attempt },
        { suffix: "snapshot-superseded", kind: "superseded", job: soloJob, attempt: soloAttempt },
      ];
      await admin.query(`INSERT INTO control_harness_runs
        (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,
         state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
        SELECT 'run:bounded-usage-precedence:'||s.suffix,$1::text,$2::text,s.job,s.attempt,$3::text,$4::text,'codex',
          'sha256:'||md5(s.suffix)||md5(('prec'||s.suffix)::text),'succeeded',1,$5::text,$6::text,
          jsonb_build_object('schemaVersion','control-room-harness/v1','id','run:bounded-usage-precedence:'||s.suffix,
            'tenantId',$1::text,'projectId',$2::text,'jobId',s.job,'attemptId',s.attempt,'nodeId',$3::text,
            'adapterId',$4::text,'adapterVersion','1.0.0','harness','codex','harnessVersion','codex-precedence-1',
            'nativeSessionKeyDigest','sha256:'||md5(s.suffix)||md5(('prec'||s.suffix)::text),
            'modelSelection',jsonb_build_object('model',$7::text,'effort','medium'),'state','succeeded',
            'resumable',false,'cancelState','not_requested','createdAt',$8::text,'startedAt',$8::text,
            'updatedAt',$9::text,'finishedAt',$9::text,'lastObservedAt',$9::text),
          $8::timestamptz,$9::timestamptz,$9::timestamptz
        FROM unnest($10::text[],$11::text[],$12::text[]) AS s(suffix,job,attempt)`,
      [ids.tenant, ids.project, ids.node, ids.adapter, digest, tag, MODEL, start, finish,
        runs.map(one => one.suffix), runs.map(one => one.job), runs.map(one => one.attempt)]);

      // A snapshot body the real native contract accepts: the fields below are
      // the ones `nativeTaskSnapshotBodySchema` requires plus its usage block.
      const snapshot = (usage: unknown) => ({
        binding: null, version: 1, state: "completed", nativeRunId: null, observedAt: finish,
        upstreamUpdatedAt: null, availability: "current", streamAttempted: true, stopAttempted: false,
        resultText: null, usage, lastActivity: "none", safeReason: "none",
      });
      const events: { run: string; sequence: number; payload: unknown }[] = [
        // 2: one snapshot, usage without a total.
        { run: "run:bounded-usage-precedence:snapshot-partial", sequence: 1,
          payload: { category: "native_snapshot", snapshot: snapshot({ inputTokens: 40, outputTokens: 8,
            totalTokens: null, provenance: "upstream_reported", cachedInputTokens: null, reasoningTokens: null,
            calls: null, costUsd: null, hardCostLimitEnforced: false }) } },
        // 3: an early snapshot with usage, then a later one with usage null.
        { run: "run:bounded-usage-precedence:snapshot-superseded", sequence: 1,
          payload: { category: "native_snapshot", snapshot: snapshot({ inputTokens: 900, outputTokens: 900,
            totalTokens: 1800, provenance: "upstream_reported", cachedInputTokens: null, reasoningTokens: null,
            calls: null, costUsd: null, hardCostLimitEnforced: false }) } },
        { run: "run:bounded-usage-precedence:snapshot-superseded", sequence: 2, payload: { category: "native_snapshot", snapshot: snapshot(null) } },
        // The later snapshot's `usage` is JSON null, which is what the live schema
        // writes (`usage: usageSchema.nullable()`). A mutation that filters the
        // snapshot lookup on `->'usage' IS NOT NULL` therefore does NOT bite here:
        // a JSON null is still a present key, so the filter keeps this row and the
        // answer is unchanged. That is a real observation about the guard, not a
        // gap in the assertion — the assertion below pins the answer, and the
        // filter is not what produces it.
      ];
      for (const event of events) {
        // `UNIQUE (tenant_id,run_id,source_event_key_digest)` means the two
        // snapshots of the same run need their own key digest, exactly as a real
        // ingestion assigns one per snapshot version.
        const key = sha256Digest({ purpose: "bounded-usage-precedence", run: event.run, sequence: event.sequence });
        await admin.query(`INSERT INTO control_harness_run_events
          (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at)
          VALUES($1::text,$2::text,$3::int,$4::timestamptz,'harness_read',$5::text,$6::text,$7::text,
            jsonb_build_object('schemaVersion','control-room-harness-event/v1','tenantId',$1::text,'runId',$2::text,
              'sequence',$3::int,'occurredAt',$4::text,'source','harness_read','sourceEventKeyDigest',$5::text,
              'payload',$8::jsonb),$4::timestamptz)`,
        [ids.tenant, event.run, event.sequence, finish, key, digest, tag, JSON.stringify(event.payload)]);
      }

      const login = postgres.connection("web");
      const web = bindPrivatePgPool(new Pool({ ...login, max: 4, application_name: "control-room-private-web",
        options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
        statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }));
      try {
        const groups = await new HarnessRunStoreV1(web.client, INTEGRITY_KEY)
          .inspectUsageRollup(ids.tenant, ids.project, ids.job);
        // Wall time: all three runs started and finished, so each observes 70s
        // and their groups sum to 3 x 70s. The run with NO usage event is the one
        // this pins: its duration must still be counted, which is only possible
        // because the duration is computed for every run rather than inside the
        // usage-event lookup.
        // Two runs share this job; the third lives in the solo scope below.
        assert.equal(groups.reduce((sum, one) => sum + Number(one.wallTimeMs), 0), 70000 * 2,
          `every run here observed a 70s duration, so the groups must total ${70000 * 2}, got ${JSON.stringify(groups)}`);
        const rollup = rollupUsageGroupsV1(groups, priceTable);
        assert.equal(rollup.wallTimeMs, 70000 * 2,
          "wall time is reported for runs with no usage event, not only for those that have one");
        // The superseded-snapshot run ALONE. In the scope above its resurrected
        // tokens are invisible — the rollup's fields are already null because
        // other runs reported nothing — so this reads that one run's own group,
        // where a resurrected observation would be an unmistakable number.
        const soloStore = new HarnessRunStoreV1(web.client, INTEGRITY_KEY);
        const soloGroups = await soloStore.inspectUsageRollup(ids.tenant, ids.project, soloJob);
        assert.equal(soloGroups.length, 1, `the solo scope has one run: ${JSON.stringify(soloGroups)}`);
        assert.equal(soloGroups[0]!.runs, 1);
        assert.equal(soloGroups[0]!.inputTokens, null,
          "the LAST native snapshot reported no usage, so the run reports none; an earlier snapshot's 900 tokens are superseded evidence");
        assert.equal(soloGroups[0]!.outputTokens, null);
        assert.equal(soloGroups[0]!.totalTokens, null);
        assert.equal(soloGroups[0]!.wallTimeMs, "70000", "it still reports its own observed duration");
        assert.deepEqual(rollupUsageGroupsV1(soloGroups, priceTable).unknownCostReasons, ["usage_not_reported"]);

        // Exactly one run reported a usable token count: the snapshot whose usage
        // carried 40 in and 8 out. The other two — the run with no event at all,
        // and the run whose LAST snapshot reported no usage — report nothing, so
        // neither field is presented as a total over the scope. That is the
        // `every()` rule surviving the aggregate: one silent run makes the whole
        // field unknown rather than a partial sum presented as complete.
        assert.equal(rollup.inputTokens, null,
          "two of the three runs reported no input count, so no total may be presented");
        assert.equal(rollup.outputTokens, null);
        assert.equal(rollup.totalTokens, null,
          "a native snapshot that omitted totalTokens reports null; input+output is never derived for a snapshot");
        assert.equal(rollup.wallTimeMs, 70000 * 2, "wall time is reported for every run, including one with no usage event");
        // The snapshot's own cache count is null (see `cachedInputTokens: null`
        // in its usage below), and that contract cannot be overridden by any
        // producer: only a HARNESS that reports tokens can supply a zero. So a
        // native snapshot still refuses, and its reason is named rather than
        // merged into another run's.
        assert.deepEqual(rollup.unknownCostReasons, ["cached_usage_not_reported", "usage_not_reported"]);
        assert.equal(rollup.knownCostRuns, 0, "the snapshot reported tokens but its cache usage is unknown");
        assert.equal(rollup.unknownCostRuns, 2);
        assert.equal(rollup.knownCostNanoUsd, "0");
        assert.equal(rollup.runs, 2, "this scope holds the two runs that share the job");
        // The measured group is the assertion: the snapshot's tokens survived the
        // aggregate while its missing total did not become one.
        const measured = groups.find(one => one.inputTokens !== null)!;
        assert.equal(measured.inputTokens, "40");
        assert.equal(measured.outputTokens, "8");
        assert.equal(measured.totalTokens, null,
          "input+output must not be derived into a total for a native snapshot");
      } finally { await web.close(); }
    } finally { await admin.end(); }
  }, { port: PORT + 2, allowedPorts: PORTS, boundMs: 240_000 });
  completed += 1;
});

test("the bounded-usage pricing proof completed when PostgreSQL is available", () => {
  if (!PG) return;
  assert.equal(completed, 2, "a required-but-skipped cluster test must fail the run");
});
