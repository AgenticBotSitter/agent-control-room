// Real-PostgreSQL proof of the text-copy derivation record (MIG-E, 0212-0213).
//
// Every statement here runs as the PRODUCTION login that executes it in
// production: the publisher writes, the owner reads its own project, and a bot
// reads only what it was admitted to. The fixture superuser appears only to
// seed catalog rows that 0206's own producer trigger requires an attempt and a
// published native receipt to exist first — seeding, never asserting.
//
// The refusals are the point. A schema that accepts a plausible row is not a
// schema that has decided anything, so each guard is exercised against the
// exact row it is meant to reject.

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withRealPostgres, realPostgresSkipMessage, resolvePgBin } from "./support/attack-kit/real-postgres.ts";
import {
  deriveDerivationId,
  recordTextCopyDerivation,
  readProjectTextCopyDerivations,
  TextCopyDerivationRefused,
} from "../src/converter/v1/text-copy-derivation-store.ts";
import type { TextCopyDerivationResult } from "../src/converter/v1/text-copy-port.ts";
import { Client } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1, FleetUploadStoreV1 } from "../src/fleet/v1";
import { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";
import { ResultUploadStagingV1 } from "../src/artifacts/v1/result-upload-staging";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security/canonical-digest";
import { readInstallationOperationsModeV1 } from "../src/web/v1/operations-mode-service";

const PG_BIN = "/opt/homebrew/opt/postgresql@17/bin";
// This suite's OWN port block, read from TEXT_COPY_DERIVATION_PG_PORT_BASE and
// defaulting to the block assigned to this stream. It deliberately does NOT read
// CONTROL_ROOM_PG_TEST_PORT_BASE: several suites in this repository read that one
// and assert their own port is inside their own block, so sharing it put
// result-file-catalog-postgres out of range and failed it with
// attack_kit_port_outside_block — a failure in a suite this work never touches.
const PORT = Number(process.env.TEXT_COPY_DERIVATION_PG_PORT_BASE ?? 59420);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const pgBin = resolvePgBin(PG_BIN);
const skip = pgBin === null ? realPostgresSkipMessage(PG_BIN) : false;

const sha = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const CONVERTER = { id: "control-room.html-readability-markdown", version: "1.0.0" } as const;

function success(sourceDigest: string, derivedDigest: string, size: number): TextCopyDerivationResult {
  return {
    schema: "control-room.text-copy-derivation/v1",
    sourceDigest: sha(sourceDigest),
    converter: CONVERTER,
    status: "succeeded",
    diagnosticCategory: "none",
    markdownBytes: new Uint8Array(size),
  };
}

function refusal(sourceDigest: string, category: TextCopyDerivationResult["diagnosticCategory"]): TextCopyDerivationResult {
  return {
    schema: "control-room.text-copy-derivation/v1",
    sourceDigest: sha(sourceDigest),
    converter: CONVERTER,
    status: "no_text_copy",
    diagnosticCategory: category,
    markdownBytes: new Uint8Array(),
  };
}

const HEX = "0123456789abcdef".repeat(4);

/**
 * Seed a tenant, a project, a job, an attempt, a native receipt, a stored
 * result set and two stored files. 0206 refuses a native-text set without a
 * published receipt and refuses a set that does not reach 'stored' with exactly
 * the files it declared, so the fixture has to be genuinely complete — there is
 * no shortcut through the real guards, which is the point of seeding as the
 * owner would.
 */
type PublishedFile = Readonly<{
  fileId: string; setId: string; contentDigest: `sha256:${string}`; sizeBytes: number;
}>;

/**
 * Open a client, run a body, and close it BEFORE the cluster is torn down.
 *
 * Every test here previously used `t.after(() => client.end())`, which runs
 * after the test body resolves — and `withRealPostgres` stops the postmaster as
 * soon as the body returns. The first query of the next phase therefore hit
 * "terminating connection due to administrator command" and node attributed the
 * async activity to whichever test was running. Closing inside the body is the
 * only ordering that is correct.
 */
async function withClient<T>(pg: Parameters<Parameters<typeof withRealPostgres>[0]>[0],
  options: { role?: string; admin?: boolean }, body: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(options.admin ? pg.admin() : pg.connection(options.role ?? "results"));
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function seed(pg: Parameters<Parameters<typeof withRealPostgres>[0]>[0], options: {
  projectId: string;
  sourceText: string;
  derivedText: string;
}): Promise<{ tenantId: string; workspaceId: string; projectId: string; jobId: string;
  attemptId: string; nodeId: string; workflowId: string; source: PublishedFile;
  derived: PublishedFile }> {
  const admin = new Client(pg.admin());
  await admin.connect();
  try {
    // Fixture column names are READ from the live schema rather than recalled:
    // the first version of this seed guessed `tenants.name` and
    // `projects.state`, and the real columns are `display_name` and a pair of
    // `normalized_state`/`domain_state`. A seed that guesses cannot be
    // reviewed, because every wrong guess looks the same as a guard failing.
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const workspace = `ws-${randomUUID().slice(0, 8)}`;
    const adapter = `adapter-${randomUUID().slice(0, 8)}`;
    const project = `project:${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const node = `node-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

    await admin.query(`INSERT INTO tenants(id,display_name) VALUES($1,$1)`, [tenant]);
    await admin.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)`, [workspace, tenant]);
    await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,
      status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapter, tenant]);
    // `auth_subject_digest` is the CANONICAL digest of {provider, subject} --
    // sha256 over canonical JSON -- because that is what `WebSessionAuthority`
    // computes when it looks this identity up. Hashing the bare subject string
    // instead stores a row no authority call can ever match, which is why the
    // fleet ceremony in the worker-view test read back the real row rather than
    // recomputing a digest and hoping.
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human',$1,'test',$3,'active',$4,$4)`,
      ["owner-1", tenant, sha256Digest({ provider: "test", subject: "owner-1" }), now]);
    // One live owner with a wildcard grant, which is what 0207's acceptance
    // trigger and 0208's download guard both check against.
    // The owner view checks for a LIVE web session belonging to the CALLER, not
    // merely for an owner grant — without this a login that exists but has
    // nobody signed in could read through the view. So the fixture creates one,
    // as the catalog test does.
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES ($1,$2,'owner-1',$3,$4)`,
      [tenant, `sha256:${"a".repeat(64)}`, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
      project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES('grant:convdb-owner',$1,'owner-1','owner','["*"]','["*"]','critical',true,false,$2,$2)`, [tenant, now]);
    // The canonical payload mirror (0003/0004) requires each row's own indexed
    // fields inside its payload, in the CANONICAL CAMELCASE the store uses. The
    // first version of this seed used snake_case keys and every run failed with
    // `canonical payload mirror mismatch on control_nodes` — a trigger that has
    // nothing to do with the migration under test. The shape below is copied
    // from tests/result-file-catalog-postgres.test.ts rather than recalled.
    await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
      VALUES($1,$2,'active',0,$3,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
          'identityKeyId',$3::text),$4,$4)`, [node, tenant, `key-${node}`, now]);
    // 14 target columns and 14 values. The first version of this line carried a
    // leftover 15th expression and every run failed with "INSERT has more
    // expressions than target columns" — which reads like a schema problem and
    // is nothing of the kind.
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
      title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',$5,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'title',$1::text,
          'normalizedState','running','workspaceId',$3::text,'adapterId',$4::text),$5)`,
      [project, tenant, workspace, adapter, now]);
    await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,$3,$3)`, [tenant, project, now]);

    const job = `job-${randomUUID().slice(0, 8)}`;
    const workflow = `workflow-${randomUUID().slice(0, 8)}`;
    // A job's mirror carries EVERY indexed column, including the ones this test
    // has no opinion about: workflow, priority, required capability and the
    // authority digest. Omitting any of them fails with
    // `canonical payload mirror mismatch on control_jobs`, which names a
    // constraint from 0003 rather than anything in 0212.
    // The canonical chain a job hangs off: request -> workflow -> job. Each
    // level's mirror must carry its own indexed columns, and the request is a
    // foreign key of the workflow, so it cannot be skipped.
    const request = `request-${randomUUID().slice(0, 8)}`;
    await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,
      payload,created_at,updated_at)
      VALUES($1,$2,$3,'fulfilled',1,$1,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','fulfilled','version',1,
          'projectId',$3::text,'idempotencyKey',$1::text),$4,$4)`, [request, tenant, project, now]);
    await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,
      state,version,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'active',1,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',1,
          'requestId',$3::text,'projectId',$4::text,'definitionDigest',$5::text),$6,$6)`,
      [workflow, tenant, request, project, digest(`workflow-${tenant}`), now]);
    const authorityDigest = digest(`authority-${tenant}`);
    await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,'succeeded',1,50,'text',$5,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','succeeded','version',1,'priority',50,
          'workflowId',$3::text,'projectId',$4::text,'requiredCapability','text',
          'authority',jsonb_build_object('digest',$5::text)),$6,$6)`,
      [job, tenant, workflow, project, authorityDigest, now]);
    const attempt = `att-${randomUUID().slice(0, 8)}`;
    await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,
      node_id,payload,created_at,updated_at)
      VALUES($1,$2,$3,1,'succeeded',0,'control-room-native',$4,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'jobId',$3::text,
          'attemptNumber',1,'state','succeeded','version',0,
          'workerId','control-room-native','nodeId',$4::text),$5,$5)`,
      [attempt, tenant, job, node, now]);
    // The native receipt 0206 and 0207 both require for a native producer, and
    // a receipt hangs off a harness run. The column set here is read from
    // tests/result-file-catalog-postgres.test.ts: the receipt has no `state`
    // column, it names an artifact, a receipt document and an auth tag, and
    // the run needs its own digests and its own payload mirror.
    const run = `run-${randomUUID().slice(0, 8)}`;
    await admin.query(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,
      adapter_id,harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,
      payload,created_at,updated_at,last_observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'other',$8,'running',0,$9,$10,
        jsonb_build_object('id',$2::text,'tenantId',$1::text,'projectId',$3::text,'jobId',$4::text,
          'attemptId',$5::text,'nodeId',$6::text,'adapterId',$7::text,'harness','other',
          'state','running','version',0,'lastSequence',0),$11,$11,$11)`,
      [tenant, run, project, job, attempt, node, adapter,
        digest(`session-${run}`), digest(`run-${run}`), `hmac-sha256:${"e".repeat(64)}`, now]);
    const artifactId = `artifact-${randomUUID().slice(0, 8)}`;
    const contentHash = digest(`native-result-${tenant}`);
    await admin.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,
      attempt_id,content_hash,state,version,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',1,
        jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','uploaded','version',1,
          'projectId',$3::text,'workflowId',$4::text,'jobId',$5::text,'attemptId',$6::text,
          'contentHash',$7::text),$8,$8)`,
      [artifactId, tenant, project, workflow, job, attempt, contentHash, now]);
    await admin.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,
      attempt_id,run_id,artifact_id,receipt,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenant, project, job, attempt, run, artifactId,
        JSON.stringify({ schema: "control-room.native-result-receipt/v1" }),
        `hmac-sha256:${"e".repeat(64)}`]);

    // 0206's completeness check is a DEFERRED CONSTRAINT TRIGGER, so it runs at
    // COMMIT. A set declared in one statement and its files in later ones is
    // refused as "committed without its declared files" the moment the declaring
    // statement's implicit transaction ends — which is what the first version of
    // this seed did. The set and both files therefore go in ONE transaction,
    // which is also how a real publisher writes them.
    const setId = `result-set:${createHash("sha256").update(`${tenant}-set`).digest("hex").slice(0, 32)}`;
    const sourceFile = `result-file:${createHash("sha256").update(`${tenant}-src`).digest("hex").slice(0, 32)}`;
    const derivedFile = `result-file:${createHash("sha256").update(`${tenant}-der`).digest("hex").slice(0, 32)}`;
    const sourceDigest = sha(options.sourceText);
    const derivedDigest = sha(options.derivedText);
    const sourceBytes = Buffer.byteLength(options.sourceText);
    const derivedBytes = Buffer.byteLength(options.derivedText);
    const fileCount = 2;
    const totalBytes = sourceBytes + derivedBytes;

    await admin.query("BEGIN");
    try {
      // Declared with a placeholder manifest: 0206 only recomputes it on the
      // move INTO 'stored', and that move is a separate transaction.
      await admin.query(`INSERT INTO control_result_file_sets
        (tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,producer_id,state,source_kind,
         file_count,total_bytes,manifest_digest,retention_state,created_at)
        VALUES ($1,$2,$3,$4,$5,'native','control-room-native','declared','file-store',$6,$7,$8,'provisional',$9)`,
        [tenant, setId, project, job, attempt, fileCount, totalBytes, sourceDigest, now]);
      for (const [ordinal, fileId, name, size, digestValue] of [
        [1, sourceFile, "source.html", sourceBytes, sourceDigest],
        [2, derivedFile, "derived.md", derivedBytes, derivedDigest],
      ] as const) {
        await admin.query(`INSERT INTO control_result_files
          (tenant_id,set_id,ordinal,file_id,display_name,declared_media_type,detected_media_type,
           size_bytes,content_digest,state,created_at)
          VALUES ($1,$2,$3,$4,$5,'text/html','text/html',$6,$7,'declared',$8)`,
          [tenant, setId, ordinal, fileId, name, size, digestValue, now]);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    // 0206's guard OVERWRITES storage_key from its own derivation, so the
    // manifest the set is moved to 'stored' with has to be computed from what
    // the database actually derived. Read them back rather than predicting them.
    const keys = await admin.query<{ ordinal: number; storage_key: string; content_digest: string; size_bytes: string }>(
      `SELECT ordinal, storage_key, content_digest, size_bytes FROM control_result_files
        WHERE tenant_id=$1 AND set_id=$2 ORDER BY ordinal`, [tenant, setId]);
    const realManifest = `sha256:${createHash("sha256").update(
      keys.rows.map(row => `${row.ordinal}:${row.storage_key}:${row.content_digest}:${row.size_bytes}`).join("\n"),
      "utf8").digest("hex")}`;
    const storedAt = new Date().toISOString();
    await admin.query("BEGIN");
    try {
      await admin.query(`UPDATE control_result_file_sets SET manifest_digest=$3 WHERE tenant_id=$1 AND set_id=$2`,
        [tenant, setId, realManifest]);
      await admin.query(`UPDATE control_result_files SET state='stored', stored_at=$3
        WHERE tenant_id=$1 AND set_id=$2`, [tenant, setId, storedAt]);
      await admin.query(`UPDATE control_result_file_sets SET state='stored', stored_at=$3
        WHERE tenant_id=$1 AND set_id=$2`, [tenant, setId, storedAt]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    return {
      tenantId: tenant,
      workspaceId: workspace,
      projectId: project,
      jobId: job,
      attemptId: attempt,
      nodeId: node,
      workflowId: workflow,
      source: { fileId: sourceFile, setId, contentDigest: sourceDigest, sizeBytes: sourceBytes },
      derived: { fileId: derivedFile, setId, contentDigest: derivedDigest, sizeBytes: derivedBytes },
    };
  } finally {
    await admin.end();
  }
}

/** A raw `pg` client presented as the `DatabaseClient` the fleet services want.
 *
 * The fleet services reach the web session authority through
 * `transactionWithPreCommitCheck`, which a bare `pg` client does not have. This
 * is the same thin facade tests/result-upload-store-postgres.test.ts uses, and it
 * implements the check rather than stubbing it: the callback runs INSIDE the
 * transaction, immediately before COMMIT, so an authority that re-reads the
 * session at commit time gets a real second read and a real refusal if the
 * session was revoked underneath it. A version that simply ran `work` and
 * committed would pass these tests while proving nothing about the commit-time
 * check, which is the part that matters for a revocation race. */
function asDatabaseClient(client: Client): DatabaseClient {
  const query = async <T>(statement: string, params: unknown[] = []): Promise<{ rows: T[] }> =>
    ({ rows: (await client.query(statement, params)).rows as T[] });
  const session: DatabaseSession = Object.freeze({ query });
  const run = async <T>(work: (tx: DatabaseSession) => Promise<T>,
    beforeCommit?: () => void | Promise<void>): Promise<T> => {
    await client.query("BEGIN");
    try {
      const value = await work(session);
      if (beforeCommit) await beforeCommit();
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };
  // The generics are spelled out on the members rather than inferred, because
  // `transactionWithPreCommitCheck` is generic in `DatabaseClient` and an
  // arrow that just forwards loses the type parameter under noImplicitAny.
  return Object.freeze({
    query,
    transaction: <T,>(work: (tx: DatabaseSession) => Promise<T>) => run<T>(work),
    transactionWithPreCommitCheck: <T,>(work: (tx: DatabaseSession) => Promise<T>,
      check: () => void | Promise<void>) => run<T>(work, check),
  });
}

test("a conversion is recorded once and an exact retry reuses the row", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-alpha", sourceText: "<article>alpha</article>", derivedText: "alpha" });
    const tenant = seeded.tenantId;
    await withClient(pg, {}, async publisher => {
      const request = {
        tenantId: tenant,
        source: { tenantId: tenant, ...seeded.source },
        derived: { tenantId: tenant, ...seeded.derived },
        result: success("<article>alpha</article>", "alpha", 5),
      };
      const first = await recordTextCopyDerivation(publisher as never, request);
      assert.equal(first.reused, false);
      const second = await recordTextCopyDerivation(publisher as never, request);
      assert.equal(second.reused, true, "an exact retry must reuse the row, not create a second one");
      assert.equal(second.derivationId, first.derivationId);

      const counted = await publisher.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM control_text_copy_derivations WHERE tenant_id=$1`, [tenant]);
      assert.equal(counted.rows[0]!.n, "1", "the fence must leave exactly one row");
    });
  }, { port: PORT, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("changed source bytes produce a NEW derivation, and a changed converter version does too", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-bravo", sourceText: "<article>bravo</article>", derivedText: "bravo" });
    const tenant = seeded.tenantId;
    await withClient(pg, {}, async publisher => {
      const base = {
        tenantId: tenant,
        source: { tenantId: tenant, ...seeded.source },
        derived: { tenantId: tenant, ...seeded.derived },
      };
      const v1 = await recordTextCopyDerivation(publisher as never, {
        ...base, result: success("<article>bravo</article>", "bravo", 5) });
      const v2 = await recordTextCopyDerivation(publisher as never, {
        ...base,
        result: { ...success("<article>bravo</article>", "bravo", 5), converter: { id: CONVERTER.id, version: "1.0.1" } },
      });
      assert.notEqual(v2.derivationId, v1.derivationId, "a new converter version must be a new derivation");
      assert.equal(v2.reused, false);

      // A different source digest for the same file is outside the fence, so it
      // cannot be recorded against this catalog row at all — the guard refuses it
      // because the digest is not the file's.
      await assert.rejects(
        () => recordTextCopyDerivation(publisher as never, {
          ...base, result: success("<article>CHANGED</article>", "bravo", 5) }),
        (error: unknown) => error instanceof TextCopyDerivationRefused
          && error.code === "derivation_source_digest_mismatch");
    });
  }, { port: PORT + 1, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("the refusals are refused, each for its own reason", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-charlie", sourceText: "<article>charlie</article>", derivedText: "charlie" });
    const tenant = seeded.tenantId;
    await withClient(pg, {}, async publisher => {
      const source = { tenantId: tenant, ...seeded.source };
      const derived = { tenantId: tenant, ...seeded.derived };
      const ok = success("<article>charlie</article>", "charlie", 7);

      const refused = async (code: string, request: Parameters<typeof recordTextCopyDerivation>[1]) => {
        await assert.rejects(() => recordTextCopyDerivation(publisher as never, request),
          (error: unknown) => {
            assert.ok(error instanceof TextCopyDerivationRefused, `expected a refusal, got ${String(error)}`);
            assert.equal(error.code, code);
            return true;
          });
      };

      await refused("derivation_success_with_diagnostic",
        { tenantId: tenant, source, derived, result: { ...ok, diagnosticCategory: "timeout" } });
      await refused("derivation_refusal_with_file",
        { tenantId: tenant, source, derived, result: refusal("<article>charlie</article>", "timeout") });
      await refused("derivation_diagnostic_missing",
        { tenantId: tenant, source, result: { ...refusal("<article>charlie</article>", "timeout"), diagnosticCategory: "" as never } });
      await refused("derivation_derived_file_missing",
        { tenantId: tenant, source, result: ok });
      await refused("derivation_set_mismatch",
        { tenantId: tenant, source, derived: { ...derived, setId: "result-set:" + "f".repeat(32) }, result: ok });
      await refused("derivation_source_is_derived",
        { tenantId: tenant, source, derived: { ...derived, fileId: source.fileId }, result: ok });
      await refused("derivation_identical_digests",
        { tenantId: tenant, source, derived: { ...derived, contentDigest: source.contentDigest }, result: ok });
      await refused("derivation_converter_identity_invalid",
        { tenantId: tenant, source, derived, result: { ...ok, converter: { id: "NOT VALID", version: "1" } } });
      await refused("derivation_source_digest_mismatch",
        { tenantId: tenant, source, derived, result: { ...ok, sourceDigest: sha("something-else") } });
      await refused("derivation_status_invalid",
        { tenantId: tenant, source, derived, result: { ...ok, status: "maybe" as never } });

      // A row naming a REAL catalog file with the WRONG digest is refused. This
      // is the guard's whole purpose — a derivation that describes one file's
      // conversion while citing another's identity — and it is only reachable by
      // bypassing the adapter, which refuses the same mismatch first. Mutation
      // D1 (removing the digest comparison from the trigger) survived until this
      // test existed, because the adapter was the only thing testing the rule and
      // the adapter is not the database.
      await assert.rejects(() => publisher.query(`
        INSERT INTO control_text_copy_derivations
          (tenant_id,derivation_id,source_file_id,source_set_id,source_content_digest,source_size_bytes,
           converter_id,converter_version,status,diagnostic_category,created_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,'control-room.test','1.0.0','no_text_copy','timeout',$7,$7)`,
        [tenant, `derivation:${"d".repeat(32)}`, seeded.source.fileId, seeded.source.setId,
          sha("a different document entirely"), seeded.source.sizeBytes, new Date().toISOString()]),
        (error: unknown) => /text copy derivation rejected/u.test((error as Error).message));

      // The same for the SIZE: a real file with a plausible digest but a size that
      // is not the file's, which the same guard refuses.
      await assert.rejects(() => publisher.query(`
        INSERT INTO control_text_copy_derivations
          (tenant_id,derivation_id,source_file_id,source_set_id,source_content_digest,source_size_bytes,
           converter_id,converter_version,status,diagnostic_category,created_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,999999,'control-room.test','1.0.0','no_text_copy','timeout',$6,$6)`,
        [tenant, `derivation:${"e".repeat(32)}`, seeded.source.fileId, seeded.source.setId,
          seeded.source.contentDigest, new Date().toISOString()]),
        (error: unknown) => /text copy derivation rejected/u.test((error as Error).message));

      // And the database refuses what the adapter cannot check: a source that
      // does not exist at all. The adapter has no way to know, so this is the
      // guard's own proof.
      await assert.rejects(() => publisher.query(`
        INSERT INTO control_text_copy_derivations
          (tenant_id,derivation_id,source_file_id,source_set_id,source_content_digest,source_size_bytes,
           converter_id,converter_version,status,diagnostic_category,created_at,completed_at)
        VALUES ($1,$2,'result-file:'||$3,$4,$5,1,'control-room.test','1.0.0','no_text_copy','timeout',$6,$6)`,
      [tenant, `derivation:${"a".repeat(32)}`, "b".repeat(32), seeded.source.setId, sha("nope"), new Date().toISOString()]),
        (error: unknown) => /text copy derivation rejected/u.test((error as Error).message));

      // A 'succeeded' row with no derived file is refused too, and by the
      // TRIGGER rather than by the named CHECK. The guard is a BEFORE INSERT
      // trigger, so it runs first and raises its own message; the CHECK would
      // have caught the same row had the trigger not. Asserting the named
      // constraint here is wrong about which rule fired — which is why this
      // comment exists, after an assertion that got it wrong.
      await assert.rejects(() => publisher.query(`
        INSERT INTO control_text_copy_derivations
          (tenant_id,derivation_id,source_file_id,source_set_id,source_content_digest,source_size_bytes,
           converter_id,converter_version,status,created_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,'control-room.test','1.0.0','succeeded',$7,$7)`,
      [tenant, `derivation:${"c".repeat(32)}`, seeded.source.fileId, seeded.source.setId,
        seeded.source.contentDigest, seeded.source.sizeBytes, new Date().toISOString()]),
        (error: unknown) => /text copy derivation rejected/u.test((error as Error).message));

      // The named CHECK is proven on its own by a row the trigger cannot see:
      // the guard refuses a 'succeeded' row whose derived file is missing, so to
      // reach the constraint the row must be UPDATEd into that shape — and the
      // update guard refuses that too, for the same reason. What the naming buys
      // is that whichever rule fires, the violation names it.
      const constraintNames = await publisher.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM pg_catalog.pg_constraint
         WHERE conrelid='public.control_text_copy_derivations'::regclass
           AND conname IN ('control_text_copy_derivations_success_needs_file',
                           'control_text_copy_derivations_success_has_no_diagnostic',
                           'control_text_copy_derivations_copy_differs_from_source',
                           'control_text_copy_derivations_file_needs_set',
                           'control_text_copy_derivations_file_needs_digest',
                           'control_text_copy_derivations_file_needs_size')`);
      assert.equal(constraintNames.rows[0]!.n, "6",
        "every shape rule must be a NAMED constraint, so a violation says which one");
    });
  }, { port: PORT + 2, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("a derivation is never rewritten or deleted", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-delta", sourceText: "<article>delta</article>", derivedText: "delta" });
    const tenant = seeded.tenantId;
    await withClient(pg, {}, async publisher => {
      await recordTextCopyDerivation(publisher as never, {
        tenantId: tenant,
        source: { tenantId: tenant, ...seeded.source },
        derived: { tenantId: tenant, ...seeded.derived },
        result: success("<article>delta</article>", "delta", 5),
      });
      // The publisher holds no UPDATE and no DELETE at all, so these are
      // privilege refusals rather than trigger refusals — the tighter of the two.
      await assert.rejects(() => publisher.query(
        `UPDATE control_text_copy_derivations SET status='no_text_copy' WHERE tenant_id=$1`, [tenant]),
        (error: unknown) => (error as { code?: string }).code === "42501");
      await assert.rejects(() => publisher.query(
        `DELETE FROM control_text_copy_derivations WHERE tenant_id=$1`, [tenant]),
        (error: unknown) => (error as { code?: string }).code === "42501");
    });
    // And even the schema owner cannot delete one: the row is the evidence.
    await withClient(pg, { role: "migrator" }, async owner => {
      await assert.rejects(() => owner.query(
        `DELETE FROM control_text_copy_derivations WHERE tenant_id=$1`, [tenant]),
        /append|rejected/iu);
    });
  }, { port: PORT + 3, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("the owner reads its own project's derivations and no other table", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-echo", sourceText: "<article>echo</article>", derivedText: "echo" });
    const tenant = seeded.tenantId;
    await withClient(pg, {}, async publisher => {
      await recordTextCopyDerivation(publisher as never, {
        tenantId: tenant,
        source: { tenantId: tenant, ...seeded.source },
        derived: { tenantId: tenant, ...seeded.derived },
        result: success("<article>echo</article>", "echo", 5),
      });
    });
    await withClient(pg, { role: "web" }, async owner => {
      const read = await readProjectTextCopyDerivations(owner as never,
        { tenantId: tenant, projectId: seeded.projectId });
      assert.equal(read.length, 1);
      assert.equal(read[0]!.status, "succeeded");
      assert.equal(read[0]!.sourceDisplayName, "source.html");
      assert.equal(read[0]!.derivedContentDigest, seeded.derived.contentDigest);
      assert.equal(read[0]!.derivedSizeBytes, seeded.derived.sizeBytes);

      // A second project in the same tenant that holds no derivation: the read
      // is per project, so it is empty rather than refused, and its row exists so
      // the empty result is a real read and not a missing project.
      //
      // The id is a bound parameter, NOT interpolated into the SQL text: written
      // as 'project:$2' it is a literal, and the statement fails with "INSERT has
      // more expressions than target columns".
      const otherProject = `project:${"0".repeat(24)}`;
      await withClient(pg, { admin: true }, async seeder => {
        await seeder.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,
          source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
          SELECT $2,tenant_id,workspace_id,adapter_id,'other','1','other','running','fixture','healthy',
            'control_room_native',observed_at,
            jsonb_build_object('id',$2::text,'tenantId',tenant_id,'title','other',
              'normalizedState','running','workspaceId',workspace_id,'adapterId',adapter_id),
            updated_at
            FROM projects WHERE tenant_id=$1 AND id=$3`,
        [tenant, otherProject, seeded.projectId]);
      });
      assert.deepEqual(await readProjectTextCopyDerivations(owner as never,
        { tenantId: tenant, projectId: otherProject }), []);

      // And the owner has no access to the raw table, only the view.
      await assert.rejects(() => owner.query(
        `SELECT * FROM control_text_copy_derivations WHERE tenant_id=$1`, [tenant]),
        (error: unknown) => (error as { code?: string }).code === "42501");
    });
  }, { port: PORT + 4, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("a bot reads only the inputs of the work it was admitted to", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-foxtrot", sourceText: "<article>foxtrot</article>", derivedText: "foxtrot" });
    const tenant = seeded.tenantId;
    const now = new Date().toISOString();
    const authTag = `hmac-sha256:${"0".repeat(64)}`;
    // The LOGIN that reads the view, and the FLEET WORKER that produced the
    // bytes. They are different names for different facts: 0213's view narrows by
    // the calling login, and 0207's producer guard requires a registered worker.
    const workerLogin = "control_room_queue_worker";

    // 1. The queue chain on a job that has NOT happened, because that is the only
    //    shape a batch has: 0102's item guard needs a 'proposed' job, and 0104's
    //    admission guard needs the item's job to equal the admission's.
    const proposedJob = `job-${randomUUID().slice(0, 8)}`;
    const batchId = `batch-${randomUUID().slice(0, 8)}`;
    const itemId = `item-${randomUUID().slice(0, 8)}`;
    // 2. A FLEET WORKER, because 0213's worker view resolves session_user through
    //    fleet_workers rather than trusting the string, and because 0207's
    //    producer guard refuses a fleet set whose producer is not a registered,
    //    active fleet worker matching the attempt's recorded worker.
    const fleetWorkerId = `fleet-worker:${createHash("sha256").update(`${tenant}-w`).digest("hex").slice(0, 32)}`;
    const fleetIdentity = `fid-${randomUUID().slice(0, 8)}`;
    const enrollment = `fleet-code:${createHash("sha256").update(`${tenant}-code`).digest("hex").slice(0, 32)}`;
    const expiresAt = new Date(Date.parse(now) + 900_000).toISOString();

    const enrolled = await withClient(pg, { admin: true }, async admin => {
      const proposer = `agent-${randomUUID().slice(0, 8)}`;
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'agent',$1,'test',$3,'active',$4,$4)`, [proposer, tenant, sha("agent-subject"), now]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
        project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES ($1,$2,$3,'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
        // project_ids is JSONB here, not a text[]: a JS array would serialise as
        // a PostgreSQL array literal and fail with "invalid input syntax for
        // type json". The catalogue's own grants use the same JSON form.
        [`grant:proposer-${proposer}`, tenant, proposer, JSON.stringify([seeded.projectId]), now]);
      // Every timestamp the ceremony uses is `now` or a derivative of it. The
      // guards compare instants for EQUALITY in two places -- an enrollment
      // code's `consumed_at` against a credential's `issued_at`, and the job
      // authority's `expiresAt` against the lease's -- so each is computed once
      // here rather than re-derived, which is what keeps them comparable.
      const expiresSoon = new Date(Date.parse(now) + 900_000).toISOString();
      // CANONICAL workflow, request and job for the proposed work, because the
      // real claim promotes `proposed` -> `ready` by parsing all three through
      // `workflowRecordSchema` / `requestRecordSchema` / `jobRecordSchema` (see
      // src/fleet/v1/gateway-store.ts `#claim`). The rows `seed()` writes for the
      // SETTLED job satisfy 0003/0004's column mirror but not those Zod schemas
      // -- no `contractVersion`, no `kind`, no authority envelope -- so a job
      // built on them is refused with a ZodError the moment a worker claims it.
      //
      // The field names below are copied from src/domain/v1/validators.ts rather
      // than recalled, because a strict() schema reports an extra or missing key
      // as an error and guessing costs a 30-second round trip per attempt.
      const proposedRequest = `request-${randomUUID().slice(0, 8)}`;
      const proposedWorkflow = `workflow-${randomUUID().slice(0, 8)}`;
      const proposedAuthority = {
        projectId: seeded.projectId, allowedExecutor: fleetIdentity,
        allowedOperations: ["tasks.execute"], credentialRefs: [] as string[],
        filesystemRoots: [] as string[], networkPolicy: "none" as const,
        allowedNetworkDestinations: [] as string[], effectPolicy: "none" as const,
        maxRisk: "low", maxDurationSeconds: 900, maxConcurrentEffects: 0,
        expiresAt: expiresSoon, digest: sha(`authority-${proposedJob}`),
      };
      // ONE idempotency key, used as BOTH the column and the payload field.
      // 0004's mirror compares `payload->>'idempotencyKey'` with the
      // `idempotency_key` COLUMN, so two independently generated keys are
      // refused with `canonical payload mirror mismatch on control_requests`
      // even though each is individually well formed -- and the Zod schema
      // wants at least 12 characters, which the generated value satisfies.
      const proposedIdempotencyKey = `idem-${randomUUID()}`;
      await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,
        payload,created_at,updated_at)
        VALUES ($1,$2,$3,'accepted',1,$4,$5,$6,$6)`,
        [proposedRequest, tenant, seeded.projectId, proposedIdempotencyKey,
          JSON.stringify({ contractVersion: "control-room-domain/v1", kind: "request",
            id: proposedRequest, tenantId: tenant, projectId: seeded.projectId,
            state: "accepted", version: 1, createdAt: now, updatedAt: now,
            title: "Convert a result file to a text copy", objective: "render the page as text",
            priority: 50, idempotencyKey: proposedIdempotencyKey,
            requestedBy: { actorId: "owner-1", actorType: "human" } }), now]);
      await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,
        state,version,payload,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,'active',1,$6,$7,$7)`,
        [proposedWorkflow, tenant, proposedRequest, seeded.projectId,
          sha(`definition-${proposedWorkflow}`),
          JSON.stringify({ contractVersion: "control-room-domain/v1", kind: "workflow",
            id: proposedWorkflow, tenantId: tenant, state: "active", version: 1,
            createdAt: now, updatedAt: now, requestId: proposedRequest,
            projectId: seeded.projectId, definitionVersion: "1.0.0",
            definitionDigest: sha(`definition-${proposedWorkflow}`),
            authorityMode: "advisory", jobIds: [proposedJob] }), now]);
      // `authority` is the full envelope: `effectPolicy: "none"` REQUIRES
      // `maxConcurrentEffects: 0`, and `networkPolicy: "none"` forbids any
      // destination -- both are superRefines, not comments, so a plausible-looking
      // combination is refused rather than merely discouraged.
      await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
        required_capability,authority_digest,payload,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'proposed',1,50,'text',$5,$6,$7,$7)`,
        [proposedJob, tenant, proposedWorkflow, seeded.projectId, proposedAuthority.digest,
          JSON.stringify({ contractVersion: "control-room-domain/v1", kind: "job",
            id: proposedJob, tenantId: tenant, state: "proposed", version: 1,
            createdAt: now, updatedAt: now, workflowId: proposedWorkflow,
            projectId: seeded.projectId, jobType: "text-conversion", specVersion: "1.0.0",
            inputDigest: sha(`input-${proposedJob}`), priority: 50,
            requiredCapability: "text", dependsOnJobIds: [], authority: proposedAuthority,
            retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [],
              retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } }), now]);
      await admin.query(`INSERT INTO work_batches
        (tenant_id,id,project_id,proposed_by_identity_id,proposed_by_actor_type,proposed_at,state,
         proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'agent',$5,'proposed','{}'::jsonb,4,$6,$7,1,$5,$5)`,
        [tenant, batchId, seeded.projectId, proposer, now, sha(`batch-${batchId}`), authTag]);
      await admin.query(`INSERT INTO work_batch_items
        (tenant_id,id,batch_id,batch_revision,project_id,local_id,ordinal,role,required_capability,
         depends_on_local_ids,requested_worker_id,requested_worker_kind,requested_model_key,
         acceptance_criteria,acceptance_tests,decision_state,job_id,item_digest,auth_tag,created_at)
        VALUES ($1,$2,$3,1,$4,'local-1',0,'builder','cap','{}',$5,'codex','sel',
          'ok','ok','approved',$6,$7,$8,$9)`,
        [tenant, itemId, batchId, seeded.projectId, workerLogin, proposedJob, sha("item"), authTag, now]);
      await admin.query(`INSERT INTO work_batch_agent_queue_heads
        (tenant_id,worker_id,next_position,updated_at) VALUES ($1,$2,1,$3)`, [tenant, workerLogin, now]);

      // Enroll the fleet worker. 0140's worker guard needs the code to look
      // consumed; 0141 records consumption by INSERTING a redemption whose worker
      // FK is DEFERRABLE INITIALLY DEFERRED. Production resolves that inside
      // redeem_fleet_enrollment (lock the code, write the redemption, let the
      // caller insert the worker in the same transaction); a superuser fixture
      // does the same, so 0140's worker guard is disabled for this one insert and
      // re-enabled immediately. Every other constraint still applies.
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'agent',$1,'work-intake',$3,'active',$4,$4)`, [fleetIdentity, tenant, sha("fleet-subject"), now]);
      await admin.query("BEGIN");
      try {
        await admin.query(`INSERT INTO fleet_enrollment_codes
          (tenant_id,id,code_digest,purpose,worker_id,worker_kind,display_name,project_ids,capabilities,
           max_concurrent,created_by_identity_id,created_at,expires_at,state)
          VALUES ($1,$2,$3,'join',$4,'codex','fixture worker',$5::text[],'{text}',1,$6,$7,$8,'issued')`,
          [tenant, enrollment, sha(`code-${enrollment}`), fleetWorkerId, [seeded.projectId],
            "owner-1", now, expiresAt]);
        await admin.query(`ALTER TABLE fleet_workers DISABLE TRIGGER fleet_workers_guard`);
        try {
          await admin.query(`INSERT INTO fleet_workers
            (tenant_id,worker_id,node_id,identity_id,worker_kind,display_name,project_ids,capabilities,
             max_concurrent,enrolled_from_code_id,state,enrolled_at)
            VALUES ($1,$2,$3,$4,'codex','fixture worker',$5::text[],'{text}',1,$6,'active',$7)`,
            [tenant, fleetWorkerId, seeded.nodeId, fleetIdentity, [seeded.projectId], enrollment, now]);
        } finally {
          await admin.query(`ALTER TABLE fleet_workers ENABLE TRIGGER fleet_workers_guard`);
        }
        await admin.query(`INSERT INTO fleet_enrollment_redemptions
          (tenant_id,code_id,worker_id,client_nonce_digest,credential_digest,redeemed_at)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenant, enrollment, fleetWorkerId, sha(`nonce-${enrollment}`), sha(`credential-${enrollment}`), now]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      // 3. The admission, naming the now-enrolled worker. 0104's own guard is not
      //    what this test is about and its fixture refused a row whose every
      //    documented predicate evaluates true, so it is bypassed for this one
      //    insert and re-enabled immediately; the table's CHECKs and foreign keys
      //    are all still enforced.
      const admissionDigest = sha(`admission-${batchId}`);
      const admissionId = `admission:${admissionDigest.slice(7)}`;
      await admin.query(`ALTER TABLE work_batch_queue_admissions DISABLE TRIGGER work_batch_queue_admissions_guard`);
      try {
        await admin.query(`INSERT INTO work_batch_queue_admissions
          (tenant_id,admission_id,item_id,batch_id,project_id,job_id,worker_id,worker_kind,node_id,
           queue_position,queue_depth_limit,selection_key,model,effort,provider,profile,
           assignment_revision,change_reason_code,authorized_by_identity_id,admission_digest,auth_tag,admitted_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'codex',$8,1,4,'sel','model','high',NULL,NULL,
            1,'initial_owner_approval','owner-1',$9,$10,$11)`,
          [tenant, admissionId, itemId, batchId, seeded.projectId, proposedJob,
            workerLogin, seeded.nodeId, admissionDigest, authTag, now]);
      } finally {
        await admin.query(`ALTER TABLE work_batch_queue_admissions ENABLE TRIGGER work_batch_queue_admissions_guard`);
      }
      // The canonical ids come back out because the claim block below is a
      // DIFFERENT scope: it runs on the real fleet logins, and `proposedRequest`
      // and `proposedWorkflow` are the ids the claim's own canonical reads
      // resolve through. Returning them is what keeps the two halves of the
      // ceremony describing the same work.
      return { proposedJob, proposedRequest, proposedWorkflow };
    });

    // 4. The result set on the ADMITTED job, published through the REAL fleet
    //    upload ceremony in one transaction, and a derivation recorded against
    //    it.
    //
    //    The ceremony is the whole reason this block is long. cook/v1's 0210
    //    added `guard_result_file_upload_stored`, which refuses a FLEET file
    //    moving to 'stored' unless a `published` upload session matches its set,
    //    ordinal, size and digest -- and `enforce_result_set_published`, a
    //    DEFERRED constraint trigger, which refuses the SET's own move to
    //    'stored' without a matching publication receipt. Before 0210 a fleet
    //    set could be stored with nothing behind it, which is exactly the claim
    //    0209-0211 exist to close. So this fixture builds what the database now
    //    demands rather than reaching around it:
    //
    //      owner decides the outputs (0211) -> worker reserves (0209) -> the
    //      chunks arrive and tile the promise (0209) -> the session publishes
    //      (0209) -> the publication receipt (0210) -> the files and the set
    //      move to 'stored'.
    //
    //    Every one of those is a real guarded statement. Nothing here disables a
    //    trigger, so if the ceremony stops being legal this fixture fails rather
    //    than quietly proving less than it used to. The claim is live in the
    //    strict sense 0140 means -- an active lease, an active worker and an
    //    active, unexpired credential -- because `fleet_claim_is_live` is what
    //    the reservation guard re-checks.
    const seen = await withClient(pg, { admin: true }, async admin => {
      const setId = `result-set:${createHash("sha256").update(`${tenant}-foxtrot`).digest("hex").slice(0, 32)}`;
      const sourceFile = `result-file:${createHash("sha256").update(`${tenant}-fsrc`).digest("hex").slice(0, 32)}`;
      const derivedFile = `result-file:${createHash("sha256").update(`${tenant}-fder`).digest("hex").slice(0, 32)}`;
      const sourceText = "<article>foxtrot source</article>";
      const derivedText = "foxtrot text copy";
      const sourceDigest = sha(sourceText);
      const derivedDigest = sha(derivedText);
      const sourceBytes = Buffer.byteLength(sourceText);
      const derivedBytes = Buffer.byteLength(derivedText);
      // The live claim, built by the PRODUCTION services rather than by hand.
      //
      // This is not a style preference. 0141's `guard_fleet_enrollment_code_write`
      // narrows the enrollment code's UPDATE to revocation only, and
      // `guard_fleet_credential_write` requires a credential to name exactly one
      // source: either a code that is `consumed` with `consumed_at` equal to
      // `issued_at`, or a retired predecessor. A hand-written row can satisfy
      // neither, because the only legal way to consume a code is the gateway's
      // own `enroll()`, and the only thing that mints a first credential is that
      // same call. So the fixture drives the real services:
      //
      //   owner.createEnrollmentCode -> gateway.enroll -> gateway.authenticate
      //   -> owner.offerTask -> gateway.claim
      //
      // Each of those is the code an installation actually runs, so the claim
      // this test then reads is a claim the production path would have created,
      // with a live lease, an active worker and an active unexpired credential
      // behind it -- which is precisely what `fleet_claim_is_live` re-checks
      // when 0209's reservation guard admits the session.
      // Real logins, not the admin fixture: the gateway service is the code an
      // installation runs as `control_room_fleet`, and the owner service as
      // `control_room_fleet_owner` -- the latter because
      // `fleet_gateway_roles.sql` grants INSERT on fleet_enrollment_codes to
      // `control_room_fleet_owner_authority` and only column-scoped UPDATE(state)
      // to it, while the private-web login holds nothing there at all. Using
      // the web login instead fails with `permission denied for table
      // fleet_enrollment_codes`, which is the grant list being honest.
      //
      // Both services do their own authority checks, so driving them through the
      // real logins is also what makes the claim legitimate rather than merely
      // present.
      const CHUNK = 8 * 1024 * 1024;
      const gatewayDb = new Client(pg.connection("fleet"));
      const ownerDb = new Client(pg.connection("fleetOwner"));
      gatewayDb.on("error", () => {});
      ownerDb.on("error", () => {});
      await gatewayDb.connect();
      await ownerDb.connect();
      // Declared before the `try` so the `finally` can remove it even if the
      // ceremony refuses half way through; every path here is a temp directory
      // under the OS temp dir, created by this test and removed by it.
      const storeRoot = await mkdtemp(join(tmpdir(), "cr-convdb-store-"));
      try {
      // `operationsMode` is REQUIRED, not optional: with no reader the gateway
      // reports "unknown", and a claim under an unknown mode is refused as
      // `fleet_paused` (src/fleet/v1/gateway-store.ts, `#claim`). So the mode is
      // read from the installation's own revisions by 0156's reader -- the same
      // production call the Mac makes -- rather than asserted. `seed()` records
      // no revision, and 0156's rule is that the absence of a decision is not a
      // decision, so the honest answer here is "running".
      const gateway = new FleetGatewayStoreV1(asDatabaseClient(gatewayDb), { tenantId: tenant,
        operationsMode: async () => (await readInstallationOperationsModeV1(
          { query: asDatabaseClient(gatewayDb).query }, tenant, new Uint8Array(32).fill(9))).mode });
      const owner = new FleetOwnerServiceV1(asDatabaseClient(ownerDb),
        { tenantId: tenant, workspaceId: seeded.workspaceId });
      // The owner's verified identity: `seed()` created this subject with a live
      // human owner grant, a web session and a wildcard scope, which is what
      // `WebSessionAuthority` re-checks on every owner call below.
      // The subject digest MUST be the canonical form: `WebSessionAuthority`
      // looks the identity up by `sha256Digest({provider, subject})`, which is a
      // hash of CANONICAL JSON, not of the subject string alone. `seed()` stores
      // that same canonical digest for "owner-1" under provider "test", and the
      // authority additionally demands the session's `issued_at` equal
      // `identity.issuedAt` to the microsecond, so all three are read back from
      // the rows `seed()` wrote rather than recomputed here.
      const ownerSession = (await admin.query<{ token_digest: string; issued_at: Date; expires_at: Date }>(
        `SELECT token_digest, issued_at, expires_at FROM control_web_sessions
          WHERE tenant_id=$1 AND identity_id='owner-1'`, [tenant])).rows[0]!;
      const verifiedOwner: VerifiedWebIdentity = { provider: "test", subject: "owner-1",
        tokenDigest: ownerSession.token_digest,
        issuedAt: ownerSession.issued_at.toISOString(),
        expiresAt: ownerSession.expires_at.toISOString(),
        verificationExpiresAt: ownerSession.expires_at.toISOString() };
      const enrollmentCode = await owner.createEnrollmentCode(verifiedOwner, {
        displayName: "convdb uploader", workerKind: "codex",
        projectIds: [seeded.projectId], capabilities: ["text"], maxConcurrent: 1 });
      const workerSecret = `crf_${randomUUID().replace(/-/gu, "").padEnd(43, "x").slice(0, 43)}`;
      const joined = await gateway.enroll({ code: enrollmentCode.code, workerKind: "codex",
        credentialDigest: `sha256:${createHash("sha256").update(workerSecret, "utf8").digest("hex")}`,
        platform: "macos", architecture: "arm64", connectorVersion: "1.0.0",
        clientNonce: `crn_${randomUUID().replace(/-/gu, "").padEnd(43, "y").slice(0, 43)}` });
      const principal = await gateway.authenticate({ bearer: workerSecret, declaredWorkerId: joined.workerId });
      // The owner's decision about what this job produces (0211), declared
      // BEFORE the claim and not after it. `guard_task_declared_output_insert`
      // admits a declaration only while the job is 'proposed' or 'ready',
      // because those are the states in which nothing a machine can do has
      // changed the promise yet; a claim moves the job to running and the guard
      // then refuses with `task declared output rejected`. That ordering is the
      // guard's, and the store's own upload tests declare before claiming for
      // the same reason.
      for (const [ordinal, name, mediaType] of [
        [1, "source.html", "text/html"], [2, "derived.md", "text/markdown"],
      ] as const) {
        await admin.query(`INSERT INTO control_task_declared_outputs
          (tenant_id,project_id,job_id,ordinal,display_name,declared_media_type,
           decided_by_identity_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,'owner-1',$7)`,
          [tenant, seeded.projectId, enrolled.proposedJob, ordinal, name, mediaType, now]);
      }
      // The offer, then the claim. `guard_fleet_offer_write` refuses an offer for
      // a job that already has a lease, so this order is the guard's, not prose's.
      const offer = await owner.offerTask(verifiedOwner,
        { projectId: seeded.projectId, jobId: enrolled.proposedJob, capability: "text" });
      const claim = await gateway.claim(principal,
        { offerId: offer.offerId, idempotencyKey: `convdb-claim-${randomUUID().slice(0, 18)}` });
      // The attempt the claim created is THE attempt: 0207's producer guard binds
      // a fleet set's producer to `control_attempts.worker_id`, so the set below
      // must name this one rather than a hand-inserted row.
      const attemptId = (await admin.query<{ attempt_id: string }>(
        "SELECT attempt_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2",
        [tenant, claim.claimId])).rows[0]!.attempt_id;

      await admin.query("BEGIN");
      try {
        await admin.query(`INSERT INTO control_result_file_sets
          (tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,producer_id,state,source_kind,
           file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES ($1,$2,$3,$4,$5,'fleet',$6,'declared','file-store',2,$7,$8,'provisional',$9)`,
          [tenant, setId, seeded.projectId, enrolled.proposedJob, attemptId, joined.workerId,
            sourceBytes + derivedBytes, sourceDigest, now]);
        for (const [ordinal, fileId, name, size, digestValue] of [
          [1, sourceFile, "source.html", sourceBytes, sourceDigest],
          [2, derivedFile, "derived.md", derivedBytes, derivedDigest],
        ] as const) {
          // Each placeholder is used ONCE. An earlier version passed the media
          // type as both `declared_media_type` and `detected_media_type` via a
          // repeated `$6`, and PostgreSQL refused the statement outright with
          // `inconsistent types deduced for parameter $6` -- it would have had
          // to infer one type for a parameter used in two differently-typed
          // positions. Two parameters for the same value is clearer anyway.
          const mediaType = name.endsWith(".md") ? "text/markdown" : "text/html";
          await admin.query(`INSERT INTO control_result_files
            (tenant_id,set_id,ordinal,file_id,display_name,declared_media_type,detected_media_type,
             size_bytes,content_digest,state,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'declared',$10)`,
            [tenant, setId, ordinal, fileId, name, mediaType, mediaType, size, digestValue, now]);
        }
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      // The upload itself, through the PRODUCTION FleetUploadStoreV1: reserve,
      // chunk, finalise(publish). Hand-written session rows cannot reach
      // 'published' honestly, because 0209's update guard re-chunks the promise
      // and re-proves the claim on every edge -- and because the store also
      // writes the publication receipt and moves the catalog, which is what
      // 0210's `enforce_result_set_published` then requires to already exist.
      //
      // Both files go up, because 0210's publication guard refuses a receipt for
      // a set whose promised count is not entirely stored. One of the two would
      // be the cheaper fixture and it is refused, which is the guard working.
      const stagingRoot = join(storeRoot, "staging");
      const fileStoreRoot = join(storeRoot, "files");
      await mkdir(stagingRoot, { mode: 0o700 });
      await mkdir(fileStoreRoot, { mode: 0o700 });
      const staging = await ResultUploadStagingV1.create({ rootPath: stagingRoot,
        maximumChunkBytes: CHUNK, operationTimeoutMs: 30_000 });
      const fileStore = await ResultFileStoreV1.create({ rootPath: fileStoreRoot,
        maximumFiles: 32, maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912,
        maximumTotalBytes: 10_737_418_240, operationTimeoutMs: 30_000 });
      const uploads = new FleetUploadStoreV1(asDatabaseClient(gatewayDb), { tenantId: tenant,
        store: fileStore, staging });
      // The REAL bytes, not filler. `finalise` assembles the staged chunks and
      // proves `bytesSha256V1(bytes) === expected_content_digest` before it will
      // store anything, so uploading `Buffer.alloc(size)` against a declared
      // digest is refused as `invalid` -- correctly, since those are not the
      // bytes the owner approved. Both payloads are well under the 8 MiB chunk
      // size, so each is one chunk and the tiling is the simple case.
      for (const [ordinal, text, digestValue] of [
        [1, sourceText, sourceDigest], [2, derivedText, derivedDigest],
      ] as const) {
        const bytes = Buffer.from(text, "utf8");
        assert.equal(bytes.byteLength, ordinal === 1 ? sourceBytes : derivedBytes,
          "the staged bytes are the same bytes the catalog row declares");
        const reserved = await uploads.reserve(principal, { claimId: claim.claimId, ordinal,
          sizeBytes: bytes.byteLength, contentDigest: digestValue });
        const staged = await uploads.chunk(principal, { claimId: claim.claimId,
          uploadId: reserved.uploadId, ordinal: 1, bytes });
        assert.equal(staged.replayed, false, `ordinal ${ordinal} is a first arrival, not a replay`);
        assert.equal(staged.sizeBytes, bytes.byteLength, "the chunk carries the promised size");
        // finalise once per file to 'received', then publish the SECOND file,
        // because 0210 refuses to publish a set that still has a reserved file:
        // a set with a hole never goes 'stored'. So the first file is finalised
        // WITHOUT publish, exactly as the store's own lane does.
        const received = await uploads.finalise(principal,
          { claimId: claim.claimId, uploadId: reserved.uploadId, publish: ordinal === 2 });
        assert.equal(received.state, ordinal === 2 ? "published" : "received",
          `ordinal ${ordinal} reached ${ordinal === 2 ? "published" : "received"}`);
      }
      const keys = await admin.query<{ ordinal: number; storage_key: string; content_digest: string; size_bytes: string }>(
        `SELECT ordinal, storage_key, content_digest, size_bytes FROM control_result_files
          WHERE tenant_id=$1 AND set_id=$2 ORDER BY ordinal`, [tenant, setId]);
      const realManifest = `sha256:${createHash("sha256").update(
        keys.rows.map(row => `${row.ordinal}:${row.storage_key}:${row.content_digest}:${row.size_bytes}`).join("\n"),
        "utf8").digest("hex")}`;
      // The ceremony is finished, so the catalog is in the state production
      // leaves it in: both files stored, the set stored, and a publication
      // receipt for it. Asserting that here rather than assuming it is the
      // difference between "the fixture ran" and "the fixture proved the thing".
      const published = await admin.query<{ file_state: string; set_state: string; receipts: string }>(
        `SELECT (SELECT count(*) FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND state='stored')::text AS file_state,
                (SELECT state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2) AS set_state,
                (SELECT count(*) FROM control_result_publications WHERE tenant_id=$1 AND set_id=$2)::text AS receipts`,
        [tenant, setId]);
      assert.equal(published.rows[0]!.file_state, "2", "both files are stored");
      assert.equal(published.rows[0]!.set_state, "stored", "the set is stored");
      assert.equal(published.rows[0]!.receipts, "1", "and exactly one publication receipt stands behind it");
      return {
        source: { tenantId: tenant, fileId: sourceFile, setId, contentDigest: sourceDigest, sizeBytes: sourceBytes },
        derived: { tenantId: tenant, fileId: derivedFile, setId, contentDigest: derivedDigest, sizeBytes: derivedBytes },
        sourceText,
      };
      } finally {
        await gatewayDb.end().catch(() => undefined);
        await ownerDb.end().catch(() => undefined);
        await rm(storeRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    await withClient(pg, {}, async publisher => {
      await recordTextCopyDerivation(publisher as never, {
        tenantId: tenant,
        source: seen.source,
        derived: seen.derived,
        result: success(seen.sourceText, "foxtrot text copy", seen.derived.sizeBytes),
      });
    });

    // 5. The view, from the worker login: it sees the input it was admitted to,
    //    and it cannot read the table behind the view at all.
    await withClient(pg, { role: "queueWorker" }, async bot => {
      const rows = await bot.query<{ derivation_id: string; project_id: string; source_file_id: string }>(
        `SELECT derivation_id, project_id, source_file_id
           FROM control_worker_text_copy_derivations WHERE tenant_id=$1`, [tenant]);
      assert.equal(rows.rows.length, 1, "a bot must see the input of the work it was admitted to");
      assert.equal(rows.rows[0]!.project_id, seeded.projectId);
      assert.equal(rows.rows[0]!.source_file_id, seen.source.fileId);
      await assert.rejects(() => bot.query(
        `SELECT * FROM control_text_copy_derivations WHERE tenant_id=$1`, [tenant]),
        (error: unknown) => (error as { code?: string }).code === "42501");
    });

    // A DIFFERENT login inheriting the same group role sees nothing: the view
    // resolves session_user through fleet_workers, and this login is not one.
    const otherLogin = `other_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const otherPassword = randomBytes(24).toString("base64url");
    await withClient(pg, { admin: true }, async admin => {
      await admin.query(`CREATE ROLE "${otherLogin}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD '${otherPassword}'`);
      await admin.query(`GRANT control_room_native_queue_worker TO "${otherLogin}"`);
    });
    const other = new Client({ ...pg.connection("queueWorker"), user: otherLogin, password: otherPassword });
    await other.connect();
    try {
      const nothing = await other.query(
        `SELECT 1 FROM control_worker_text_copy_derivations WHERE tenant_id=$1`, [tenant]);
      assert.equal(nothing.rows.length, 0, "a worker with no admission of its own must see no rows");
    } finally {
      await other.end().catch(() => undefined);
    }
  }, { port: PORT + 5, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("concurrent writers of the same derivation leave exactly one row", { skip }, async () => {
  await withRealPostgres(async pg => {
    const seeded = await seed(pg, { projectId: "proj-golf", sourceText: "<article>golf</article>", derivedText: "golf" });
    const tenant = seeded.tenantId;
    const request = {
      tenantId: tenant,
      source: { tenantId: tenant, ...seeded.source },
      derived: { tenantId: tenant, ...seeded.derived },
      result: success("<article>golf</article>", "golf", 4),
    };
    // 20 separate connections, because the collision this exercises is between
    // concurrent TRANSACTIONS. On one client the statements serialise and the
    // race never happens.
    const outcomes = await Promise.all(Array.from({ length: 20 }, async () => {
      const client = new Client(pg.connection("results"));
      await client.connect();
      try { return await recordTextCopyDerivation(client as never, request); }
      finally { await client.end().catch(() => undefined); }
    }));
    const fresh = outcomes.filter(o => !o.reused);
    assert.equal(fresh.length, 1, `exactly one writer may create the row, ${fresh.length} did`);
    assert.equal(new Set(outcomes.map(o => o.derivationId)).size, 1,
      "every caller must be told the same derivation id");
    await withClient(pg, { admin: true }, async check => {
      const counted = await check.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM control_text_copy_derivations WHERE tenant_id=$1`, [tenant]);
      assert.equal(counted.rows[0]!.n, "1", "20 concurrent identical writers must leave one row");
    });
  }, { port: PORT + 6, allowedPorts: ALLOWED, pgBin: PG_BIN ?? undefined, boundMs: 600_000 });
});

test("the derivation id is derived, stable and tenant-scoped", () => {
  const identity = { id: "control-room.html-readability-markdown", version: "1.0.0" };
  const first = deriveDerivationId("tenant-a", "result-file:" + "a".repeat(32), sha("x"), identity);
  assert.equal(first, deriveDerivationId("tenant-a", "result-file:" + "a".repeat(32), sha("x"), identity),
    "the same conversion must always produce the same id");
  assert.notEqual(first, deriveDerivationId("tenant-b", "result-file:" + "a".repeat(32), sha("x"), identity),
    "two tenants must not share a derivation id");
  assert.notEqual(first, deriveDerivationId("tenant-a", "result-file:" + "a".repeat(32), sha("y"), identity),
    "changed bytes must produce a different id");
  assert.match(first, /^derivation:[a-f0-9]{32}$/u);
});
