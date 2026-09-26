// Package 6b: one task per local agent (Hermes, Claude Code, Codex owner-trusted), driven only
// through the same HTTP API the website uses, against the exact disposable PG17 cluster made by
// `pnpm mac:rehearsal up`. Proves section 9/14 of MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md: project
// -> proposal -> plan -> assignment -> submission preview -> submit -> the task host's own queue
// worker runs a fake PINNED EXECUTABLE through the production process adapters -> pending review,
// exactly once per agent, with a replay returning the same receipt and queuing nothing new.
// The owner then reviews each result through the same HTTP API the website uses.
// Usage: node --import tsx scripts/mac-local/rehearsal/journey.ts ABSOLUTE_REHEARSAL_DIR
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "pg";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { sha256Digest } from "../../../src/security/canonical-digest";
import { applyMacLocalFirstOwnerV1 } from "../first-owner-vps.mjs";
import { serviceInstalled } from "../service.mjs";

const [arg] = process.argv.slice(2);
if (!arg || process.argv.length !== 3 || !isAbsolute(arg) || resolve(arg) !== arg) {
  process.stderr.write("usage: node --import tsx scripts/mac-local/rehearsal/journey.ts ABSOLUTE_REHEARSAL_DIR\n");
  process.exit(2);
}
const root = resolve(arg), protectedRoot = join(root, "protected");
let verifiedThisRehearsalCluster = false;
let stackMayBeUp = false;

const AGENTS = Object.freeze([
  { kind: "hermes" as const, worker: "hermes" as const, node: "hermes" },
  { kind: "claude" as const, worker: "claude-code" as const, node: "claude" },
  { kind: "codex" as const, worker: "codex" as const, node: "codex" },
]);

// One shell script per agent: it answers `--version` for the pin check, and
// otherwise reads (and discards) stdin, then emits exactly the stream the real
// production adapter for that agent parses (see the invoke() header comment
// on each block below for the exact source it was matched against). A fixed
// shebang path is used deliberately: the production spawn only exposes
// PATH=/usr/bin:/bin to the child, which would not resolve `env node`.
function hermesFakeScript(version: string) {
  return `#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && printf '%s\\n' '${version}' && exit 0; done
cat >/dev/null
printf '%s\\n' '{"type":"result","session_id":"fake-hermes-session-0001","exit_code":0,"text":"Fake Hermes pinned executable result.","tokens":{"input":3,"output":5,"total":8,"cache_read":0,"cache_write":0},"duration_ms":5,"timestamp":1}'
exit 0
`;
}
// Matches src/harness/claude-code-v1/owner-trusted-local-exec.ts (stdin prompt,
// OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1) and stream-json-decode.ts (init, then one
// terminal result frame with subtype "success", is_error false, a usage object).
function claudeFakeScript(version: string) {
  return `#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && printf '%s\\n' '${version}' && exit 0; done
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-00000000fa01","model":"fake-model"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"00000000-0000-4000-8000-00000000fa01","result":"Fake Claude Code pinned executable result.","total_cost_usd":0,"usage":{}}'
exit 0
`;
}
// Matches src/harness/codex-v1/owner-trusted-local-exec.ts (stdin prompt, args
// end with -C <cwd> -) and its parseLine(): item.completed/agent_message text,
// then turn.completed with a usage object.
function codexFakeScript(version: string) {
  return `#!/bin/sh
for a in "$@"; do [ "$a" = "--version" ] && printf '%s\\n' '${version}' && exit 0; done
cat >/dev/null
printf '%s\\n' '{"type":"item.completed","item":{"type":"reasoning"}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Fake Codex pinned executable result."}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":5}}'
exit 0
`;
}
const fakeScript = Object.freeze({ hermes: hermesFakeScript, "claude-code": claudeFakeScript, codex: codexFakeScript });

function invoke(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 180_000,
    env: { ...process.env, CONTROL_ROOM_PROTECTED_ROOT: protectedRoot },
  });
}
async function writeJsonPrivate(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function waitFor(check: () => Promise<boolean>, seconds: number) {
  for (let i = 0; i < seconds * 2; i++) { if (await check()) return true; await new Promise(r => setTimeout(r, 500)); }
  return false;
}

async function main() {
  const config = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
  const roleMap = JSON.parse(await readFile(join(protectedRoot, "config/database-roles.json"), "utf8"));
  if (config?.database?.host !== "127.0.0.1" || config.database.database !== "control_room"
    || config.database.majorVersion !== 17 || !Number.isInteger(config.database.port)
    || roleMap?.coordinator?.host !== "127.0.0.1" || roleMap.coordinator.port !== config.database.port
    || roleMap.coordinator.database !== "control_room") throw new Error("rehearsal_database_scope_refused");
  if (await serviceInstalled()) throw new Error("rehearsal_refused_existing_launchd_service");
  if (!existsSync(join(protectedRoot, "config/task-runtime.json")))
    throw new Error("journey_requires_mac_prepare_task_runtime_first");

  const target = `host=127.0.0.1 port=${config.database.port} dbname=control_room user=postgres`;
  const admin = connectTarget(target);
  await admin.connect();
  try {
    const identity = (await admin.query<{ data_directory: string; version_num: number; current_user: string; current_database: string }>(
      "SELECT current_setting('data_directory') AS data_directory,current_setting('server_version_num')::int AS version_num,current_user,current_database() AS current_database")).rows[0];
    if (resolve(identity?.data_directory ?? "") !== resolve(root, "pg")
      || Math.floor((identity?.version_num ?? 0) / 10_000) !== 17
      || identity?.current_user !== "postgres" || identity.current_database !== "control_room")
      throw new Error("rehearsal_database_scope_refused");
    verifiedThisRehearsalCluster = true;
  } finally { await admin.end(); }

  const coordinator = new Client({ host: roleMap.coordinator.host, port: roleMap.coordinator.port,
    database: roleMap.coordinator.database, user: roleMap.coordinator.username, password: roleMap.coordinator.password,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  await coordinator.connect();
  try {
    const roleName = (await coordinator.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user;
    if (roleName !== roleMap.coordinator.username) throw new Error("completion_gate_coordinator_role_mismatch");
    for (const table of ["control_completion_gate_integrity", "control_completion_gate_records"])
      await coordinator.query(`SELECT tenant_id FROM ${table} WHERE false`);
  } catch { throw new Error("STOP: coordinator lacks SELECT on a completion-gate table; do not widen grants or provision the tenant"); }
  finally { await coordinator.end(); }

  // Real, on-disk pinned executables. Not a code seam: the production process
  // adapters spawn these exact paths and parse their exact stdout.
  const fakeDirectory = join(protectedRoot, "fake-workers");
  await mkdir(fakeDirectory, { mode: 0o700 });
  await chmod(fakeDirectory, 0o700);
  for (const worker of config.enablement.workers) {
    const name = worker.kind === "claude-code" ? "claude" : worker.kind;
    const executable = join(fakeDirectory, name);
    const version = `${name} 1.0.0`;
    await writeFile(executable, fakeScript[worker.kind as keyof typeof fakeScript](version), { mode: 0o700, flag: "wx" });
    await chmod(executable, 0o700);
    worker.executablePath = executable;
    worker.recordedVersion = version;
  }
  await writeJsonPrivate(join(protectedRoot, "config/mac-local.json"), config);

  // probe-adapters.ts is not used here: it expects a real CLI that answers a
  // prompt and can be canceled/timed out mid-run, which a fixed-output fake
  // cannot honestly simulate. The fakes are instead proven end-to-end below,
  // by the same production process adapters the real task host queue worker
  // uses when a submitted task is actually delivered.

  // First-owner setup: the minimal positive path (see section13.ts for the
  // negative/fault-injection coverage of this same sequence).
  const manifestOut = join(root, "first-owner-manifest.json");
  const generate = invoke(["scripts/mac-local/first-owner-manifest.mjs", protectedRoot, manifestOut]);
  assert.equal(generate.status, 0, generate.stderr || generate.stdout);
  const manifest = JSON.parse(await readFile(join(protectedRoot, "config/first-owner-manifest.json"), "utf8"));
  const vps = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres",
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 30_000 });
  await vps.connect();
  let receipt: Awaited<ReturnType<typeof applyMacLocalFirstOwnerV1>>;
  try { receipt = await applyMacLocalFirstOwnerV1(vps, manifest); }
  finally { await vps.end(); }
  const receiptPath = join(protectedRoot, "config/first-owner-receipt.json");
  await writeJsonPrivate(receiptPath, receipt);
  const complete = invoke(["scripts/mac-local/complete-first-owner.mjs", protectedRoot, receiptPath]);
  assert.equal(complete.status, 0, complete.stderr || complete.stdout);

  const upArgs = ["scripts/mac-local/up.mjs", "--protected-root", protectedRoot];

  // First mac:up: no active project yet, so it is website-only. Create the
  // one project through the real HTTP boundary, exactly as the owner would.
  const start1 = invoke(upArgs);
  assert.equal(start1.status, 0, start1.stderr || start1.stdout);
  stackMayBeUp = true;
  const ownerCode = (await readFile(join(protectedRoot, "config/owner-sign-in.txt"), "utf8")).trim();
  const origin = `http://127.0.0.1:${config.port}`;
  const signIn = async () => {
    const response = await fetch(new URL("/api/v1/local-owner-session", origin), {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
    assert.equal(response.status, 201, "local disposable owner sign-in should succeed");
    const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.ok(cookie.startsWith("control_room_local_owner="));
    return cookie;
  };
  let cookie = await signIn();
  const projectResponse = await fetch(new URL("/api/v1/projects", origin), {
    method: "POST", headers: { origin, cookie, "content-type": "application/json", "idempotency-key": "journey-rehearsal-project" },
    body: JSON.stringify({ title: "Package 6b journey project", summary: "One task per local agent." }),
  });
  const { project } = await require5xxOr201(projectResponse, "create project") as { project: { projectId: string } };
  const projectId = project.projectId;

  // Restart the task host: only now does the task provider construct with
  // the queue worker (and, from mac-local-default-task-provider.ts, actually
  // require the first-owner completion-gate row this journey just created).
  const down1 = invoke(["scripts/mac-local/down.mjs", "--protected-root", protectedRoot]);
  assert.equal(down1.status, 0, down1.stderr || down1.stdout);
  stackMayBeUp = false;
  const start2 = invoke(upArgs);
  assert.equal(start2.status, 0, start2.stderr || start2.stdout);
  stackMayBeUp = true;
  cookie = await signIn();

  const workersResponse = await fetch(new URL("/api/v1/local-workers", origin), { headers: { cookie } });
  assert.equal(workersResponse.status, 200);
  const workersBody = await workersResponse.json() as { workers: { kind: string; state: string }[] };
  assert.equal(workersBody.workers?.length, 3);
  assert.ok(workersBody.workers.every(worker => worker.state === "ready"), `all three workers must be ready: ${JSON.stringify(workersBody.workers)}`);

  const idOf = (value: string) => encodeURIComponent(value);
  const outcomes: Record<string, unknown> = {};

  for (const agent of AGENTS) {
    // 1) proposal
    const proposed = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks`, origin), {
      method: "POST", headers: { origin, cookie, "content-type": "application/json", "idempotency-key": `journey-${agent.kind}-source-0001` },
      body: JSON.stringify({ title: `Journey ${agent.kind} task`, instructions: "Return one harmless short line." }),
    });
    const proposedBody = await require5xxOr201(proposed, `${agent.kind} propose`) as { receipt: { jobId: string } };
    const sourceJobId = proposedBody.receipt.jobId;
    const detail = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(sourceJobId)}`, origin), { headers: { cookie } });
    const detailBody = await requireOk(detail, 200, `${agent.kind} source detail`) as { inputDigest: string };
    const sourceInputDigest = detailBody.inputDigest;

    // 2) plan: the templateId is the deterministic id the same production
    // formula (mac-local-task-provider-templates.ts) computes for this
    // project and agent kind.
    const templateId = `template:mac-local:${agent.kind}:${sha256Digest(projectId).slice(7, 39)}`;
    const planned = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(sourceJobId)}/plan`, origin), {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedInputDigest: sourceInputDigest, templateId }),
    });
    const plannedBody = await require5xxOr201(planned, `${agent.kind} plan`) as { receipt: { jobId: string; inputDigest: string } };
    const jobId = plannedBody.receipt.jobId, inputDigest = plannedBody.receipt.inputDigest;

    // 3) assignment
    const nodeId = `${config.enablement.nodeId}.${agent.node}`;
    const assignmentOptions = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/assignment`, origin), { headers: { cookie } });
    assert.equal(assignmentOptions.status, 200, `${agent.kind} assignment options: ${await assignmentOptions.text()}`);
    const assigned = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/assignment`, origin), {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "assign", nodeId, expectedInputDigest: inputDigest }),
    });
    const assignedBody = await require5xxOr201(assigned, `${agent.kind} assignment`) as { receipt: { inputDigest: string } };
    const assignedInputDigest = assignedBody.receipt.inputDigest;

    // 4) submission preview, then submit with the exact previewed digest.
    const previewRead = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/submission?inputDigest=${assignedInputDigest}`, origin),
      { headers: { cookie } });
    const previewBody = await requireOk(previewRead, 200, `${agent.kind} submission preview read`) as
      { receipt: unknown; preview?: { packetDigest: string } };
    assert.equal(previewBody.receipt, null, `${agent.kind}: nothing should be queued yet`);
    assert.ok(previewBody.preview, `${agent.kind}: a preview must be present before anything is queued`);
    const packetDigest = previewBody.preview!.packetDigest;

    const submitted = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/submission`, origin), {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedInputDigest: assignedInputDigest, expectedPacketDigest: packetDigest }),
    });
    const submittedBody = await require5xxOr201(submitted, `${agent.kind} submit`) as
      { queueId: string; packetDigest: string; replayed: boolean };
    assert.equal(submittedBody.replayed, false, `${agent.kind}: the first submit must not be a replay`);
    assert.equal(submittedBody.packetDigest, packetDigest);

    // 5) replay: same digests, same receipt, nothing new queued.
    const replay = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/submission`, origin), {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedInputDigest: assignedInputDigest, expectedPacketDigest: packetDigest }),
    });
    const replayBody = await requireOk(replay, 200, `${agent.kind} replay`) as { queueId: string; replayed: boolean };
    assert.equal(replayBody.replayed, true, `${agent.kind}: the second identical submit must be a replay`);
    assert.equal(replayBody.queueId, submittedBody.queueId, `${agent.kind}: replay must return the same receipt`);

    // 6) poll for the task host's own queue worker to run the fake pinned
    // executable through the production adapter and reach pending review.
    let reviewStatus: string | undefined, items = 0;
    let pendingPage: { items: { artifactId: string; contentHash: string }[];
      reviews: { targetId: string; targetDigest: string; contentHash: string; status: string;
        matchingArtifactIds: string[]; reviews: { decision: string }[] }[] } | undefined;
    const polled = await waitFor(async () => {
      const results = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/results`, origin), { headers: { cookie } });
      if (results.status !== 200) return false;
      const body = await results.json() as NonNullable<typeof pendingPage>;
      items = body.items.length;
      reviewStatus = body.reviews[0]?.status;
      if (items === 1 && reviewStatus === "pending") pendingPage = body;
      return items === 1 && reviewStatus === "pending";
    // The Claude adapter permits 120 seconds for its pinned CLI. Do not call
    // delivery stuck before that budget and a short queue/publication margin.
    }, 135);
    assert.ok(polled, `${agent.kind}: expected exactly one result reaching pending review within the bounded timeout (items=${items}, reviewStatus=${reviewStatus})`);
    const page = pendingPage!;
    const artifact = page.items[0]!, target = page.reviews[0]!;
    assert.deepEqual(target.matchingArtifactIds, [artifact.artifactId], `${agent.kind}: the pending target must bind the one saved artifact`);
    assert.equal(target.contentHash, artifact.contentHash);
    assert.equal(target.reviews.length, 0);
    const reviewPath = `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/results/${idOf(artifact.artifactId)}/reviews/${idOf(target.targetId)}`;
    const options = await requireOk(await fetch(new URL(reviewPath, origin), { headers: { cookie } }), 200,
      `${agent.kind} review options`) as { canReview: boolean; availability: string; targetDigest: string;
        contentHash: string; ownReview: null | { decision: string; reviewId: string } };
    assert.equal(options.canReview, true, `${agent.kind}: owner must be able to review the pending result`);
    assert.equal(options.availability, "available");
    assert.equal(options.ownReview, null);
    assert.equal(options.targetDigest, target.targetDigest);
    assert.equal(options.contentHash, artifact.contentHash);
    const decision = agent.kind === "hermes" ? "changes_requested" : "accepted";
    const feedback = decision === "changes_requested" ? "Please revise the harmless test response." : "";
    const draft = { artifactId: artifact.artifactId, targetId: target.targetId,
      targetDigest: options.targetDigest, contentHash: options.contentHash, decision, feedback };
    const reviewKey = `journey-${agent.kind}-owner-review-0001`;
    const writeReview = () => fetch(new URL(reviewPath, origin), { method: "POST",
      headers: { origin, cookie, "content-type": "application/json", "idempotency-key": reviewKey },
      body: JSON.stringify(draft) });
    const recorded = await requireOk(await writeReview(), 201, `${agent.kind} owner review`) as
      { receipt: { reviewId: string; findingId: string | null; decision: string }; replayed: boolean };
    assert.equal(recorded.replayed, false);
    assert.equal(recorded.receipt.decision, decision);
    assert.equal(recorded.receipt.findingId !== null, decision === "changes_requested");
    const reviewReplay = await requireOk(await writeReview(), 200, `${agent.kind} owner review replay`) as typeof recorded;
    assert.equal(reviewReplay.replayed, true);
    assert.deepEqual(reviewReplay.receipt, recorded.receipt, `${agent.kind}: exact replay must not record another review`);
    let after = await requireOk(await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/results`, origin),
      { headers: { cookie } }), 200, `${agent.kind} reviewed result`) as NonNullable<typeof pendingPage>;
    assert.equal(after.items.length, 1, `${agent.kind}: result must remain singular after review`);
    assert.equal(after.reviews.length, 1, `${agent.kind}: target must remain singular after review`);
    // An owner acceptance is a saved quality vote, not automatic completion:
    // this profile also requires the separate structural verification scenario.
    assert.equal(after.reviews[0]?.status, decision === "accepted" ? "pending" : "changes_requested");
    assert.equal(after.reviews[0]?.reviews.length, 1, `${agent.kind}: owner decision must be recorded exactly once`);
    assert.equal(after.reviews[0]?.reviews[0]?.decision, decision);
    const afterOptions = await requireOk(await fetch(new URL(reviewPath, origin), { headers: { cookie } }), 200,
      `${agent.kind} saved review options`) as typeof options;
    assert.equal(afterOptions.canReview, false);
    assert.equal(afterOptions.availability, "already_reviewed");
    assert.equal(afterOptions.ownReview?.reviewId, recorded.receipt.reviewId);
    const taskUrl = new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}`, origin);
    let taskState = "", attemptState = "";
    if (decision === "accepted") {
      const completed = await waitFor(async () => {
        const taskResponse = await fetch(taskUrl, { headers: { cookie } });
        if (taskResponse.status !== 200) return false;
        const taskBody = await taskResponse.json() as { task: { state: string }; attempts: { state: string }[] };
        taskState = taskBody.task.state; attemptState = taskBody.attempts[0]?.state ?? "";
        if (taskState !== "succeeded" || attemptState !== "succeeded") return false;
        const resultsResponse = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/results`, origin),
          { headers: { cookie } });
        if (resultsResponse.status !== 200) return false;
        after = await resultsResponse.json() as NonNullable<typeof pendingPage>;
        return after.items.length === 1 && after.reviews.length === 1
          && after.reviews[0]?.reviews.length === 1 && after.reviews[0]?.reviews[0]?.decision === "accepted";
      }, 55);
      assert.ok(completed, `${agent.kind}: accepted result must complete exactly once through the Mac-local quality sweep (task=${taskState}, attempt=${attemptState})`);
      assert.equal(after.reviews[0]?.status, "ready", `${agent.kind}: verified accepted result must reach ready`);
      // Observe the canonical terminal state again. A replayed automatic sweep must not add a second result, review, or attempt.
      const stableTask = await requireOk(await fetch(taskUrl, { headers: { cookie } }), 200, `${agent.kind} completed task replay`) as
        { task: { state: string }; attempts: { state: string }[] };
      const stableResults = await requireOk(await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/results`, origin),
        { headers: { cookie } }), 200, `${agent.kind} completed result replay`) as NonNullable<typeof pendingPage>;
      assert.equal(stableTask.task.state, "succeeded");
      assert.equal(stableTask.attempts[0]?.state, "succeeded");
      assert.equal(stableResults.items.length, 1);
      assert.equal(stableResults.reviews.length, 1);
      assert.equal(stableResults.reviews[0]?.reviews.length, 1);
    } else {
      const unchangedTask = await requireOk(await fetch(taskUrl, { headers: { cookie } }), 200, `${agent.kind} changes-requested task`) as
        { task: { state: string } };
      taskState = unchangedTask.task.state;
      assert.notEqual(taskState, "succeeded", `${agent.kind}: changes-requested result must not complete`);
      assert.equal(after.reviews[0]?.status, "changes_requested");
    }
    outcomes[agent.kind] = { jobId: jobId.slice(0, 24), packetDigest: packetDigest.slice(0, 19),
      queueId: submittedBody.queueId.slice(0, 24), items, reviewStatus: after.reviews[0]?.status,
      ownerDecision: decision, reviewCount: after.reviews[0]?.reviews.length, taskState, attemptState };
  }

  process.stdout.write(`Package 6b journey: PASS ${JSON.stringify(outcomes)}\n`);

  // Exercise the publisher's implicit FK parent-before-child order against a
  // simultaneous reader. The conformance test above pins the real reader's
  // SQL lock sequence; this PG17 collision proves that order has no 40P01.
  const collisionConnection = () => new Client({ host: roleMap.coordinator.host, port: roleMap.coordinator.port,
    database: roleMap.coordinator.database, user: roleMap.coordinator.username, password: roleMap.coordinator.password,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  const collisionLookup = collisionConnection();
  await collisionLookup.connect();
  const collisionRow = (await collisionLookup.query<{ job_id: string; run_id: string; attempt_id: string; node_id: string; epoch: number }>(`
    SELECT r.job_id,r.id AS run_id,r.attempt_id,r.node_id,a.lease_epoch AS epoch
    FROM control_harness_runs r JOIN control_attempts a ON a.tenant_id=r.tenant_id AND a.id=r.attempt_id
    JOIN control_native_review_plans p ON p.tenant_id=r.tenant_id AND p.run_id=r.id
    WHERE r.tenant_id=$1 ORDER BY r.id LIMIT 1`, [config.localOwnerSession.tenantId])).rows[0];
  await collisionLookup.end();
  assert.ok(collisionRow, "collision proof requires a saved result");
  const publisher = collisionConnection(), reader = collisionConnection();
  await Promise.all([publisher.connect(), reader.connect()]);
  try {
    await publisher.query("BEGIN"); await reader.query("BEGIN");
    await publisher.query("SELECT id FROM control_jobs WHERE id=$1 FOR KEY SHARE", [collisionRow.job_id]);
    const read = (async () => {
      await reader.query("SELECT id FROM control_jobs WHERE id=$1 FOR UPDATE", [collisionRow.job_id]);
      await reader.query("SELECT id FROM control_attempts WHERE id=$1 FOR UPDATE", [collisionRow.attempt_id]);
      await reader.query("SELECT id FROM control_leases WHERE attempt_id=$1 AND node_id=$2 AND epoch=$3 FOR UPDATE",
        [collisionRow.attempt_id, collisionRow.node_id, collisionRow.epoch]);
      await reader.query("SELECT id FROM control_harness_runs WHERE id=$1 FOR UPDATE", [collisionRow.run_id]);
      await reader.query("SELECT run_id FROM control_native_artifact_receipts WHERE run_id=$1 FOR UPDATE", [collisionRow.run_id]);
      await reader.query("SELECT run_id FROM control_native_review_plans WHERE run_id=$1 FOR UPDATE", [collisionRow.run_id]);
    })();
    await new Promise(resolve => setTimeout(resolve, 100));
    await publisher.query("SELECT run_id FROM control_native_review_plans WHERE run_id=$1 FOR UPDATE", [collisionRow.run_id]);
    await publisher.query("COMMIT");
    await read;
    await reader.query("COMMIT");
  } finally {
    await Promise.allSettled([publisher.query("ROLLBACK"), reader.query("ROLLBACK")]);
    await Promise.allSettled([publisher.end(), reader.end()]);
  }
  process.stdout.write("Package 6b parent-before-child PG17 collision: PASS (no deadlock)\n");

  // Exact second collision captured in pg_locks: assignment held a tenant
  // FOR UPDATE while waiting for completion-gate integrity; completion held
  // integrity while its transition-event INSERT waited on the tenant FK.
  // The reader's tenant key-share must now precede integrity acquisition.
  const assignment = collisionConnection(), completion = collisionConnection();
  await Promise.all([assignment.connect(), completion.connect()]);
  try {
    await assignment.query("BEGIN"); await completion.query("BEGIN");
    const tenantId = config.localOwnerSession.tenantId;
    await assignment.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
    const complete = (async () => {
      await completion.query("SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE", [tenantId]);
      await completion.query("SELECT tenant_id FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      await completion.query(`INSERT INTO control_transition_events
        (id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,
         actor_id,actor_type,idempotency_key,safe_metadata,occurred_at)
        VALUES('transition:rehearsal-lock-order',$1,'service','service:rehearsal-lock-order',
          'pending','done',0,1,'service:rehearsal-lock-order','service',
          'rehearsal-lock-order','{}'::jsonb,now())`, [tenantId]);
    })();
    await new Promise(resolve => setTimeout(resolve, 100));
    await assignment.query("SELECT tenant_id FROM control_completion_gate_integrity WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    await assignment.query("COMMIT");
    await complete;
    await completion.query("ROLLBACK");
  } finally {
    await Promise.allSettled([assignment.query("ROLLBACK"), completion.query("ROLLBACK")]);
    await Promise.allSettled([assignment.end(), completion.end()]);
  }
  process.stdout.write("Package 6b tenant-before-gate PG17 collision: PASS (no deadlock)\n");

  const finalDown = invoke(["scripts/mac-local/down.mjs", "--protected-root", protectedRoot]);
  assert.equal(finalDown.status, 0, finalDown.stderr || finalDown.stdout);
  stackMayBeUp = false;
}

async function requireOk(response: Response, expected: number, label: string) {
  const text = await response.text();
  assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status}: ${text}`);
  return JSON.parse(text);
}
async function require5xxOr201(response: Response, label: string) {
  const text = await response.text();
  assert.ok([200, 201].includes(response.status), `${label}: expected 200/201, got ${response.status}: ${text}`);
  return JSON.parse(text);
}

try {
  await main();
} finally {
  if (verifiedThisRehearsalCluster) {
    if (stackMayBeUp) {
      const downHost = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/down.mjs", "--protected-root", protectedRoot], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      });
      if (downHost.status !== 0) throw new Error("rehearsal_mac_stack_stop_failed");
    }
    const down = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/rehearsal/setup.ts", "down", root], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
    });
    const status = spawnSync("pg_ctl", ["-D", join(root, "pg"), "status"], { encoding: "utf8", timeout: 10_000 });
    if (status.status === 0) throw new Error("rehearsal_cluster_still_running_after_cleanup");
    if (down.status !== 0 && !/data directory .* not exist/u.test(`${down.stderr}\n${down.stdout}`))
      throw new Error("rehearsal_cluster_stop_failed");
  }
}
