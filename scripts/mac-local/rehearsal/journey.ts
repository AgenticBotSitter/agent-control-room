// Package 6b: one task per local agent (Hermes, Claude Code, Codex owner-trusted), driven only
// through the same HTTP API the website uses, against the exact disposable PG17 cluster made by
// `pnpm mac:rehearsal up`. Proves section 9/14 of MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md: project
// -> proposal -> plan -> assignment -> submission preview -> submit -> the task host's own queue
// worker runs a fake PINNED EXECUTABLE through the production process adapters -> pending review,
// exactly once per agent, with a replay returning the same receipt and queuing nothing new.
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
    const polled = await waitFor(async () => {
      const results = await fetch(new URL(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(jobId)}/results`, origin), { headers: { cookie } });
      if (results.status !== 200) return false;
      const body = await results.json() as { items: unknown[]; reviews: { status: string }[] };
      items = body.items.length;
      reviewStatus = body.reviews[0]?.status;
      return items === 1 && reviewStatus === "pending";
    }, 55);
    assert.ok(polled, `${agent.kind}: expected exactly one result reaching pending review within the bounded timeout (items=${items}, reviewStatus=${reviewStatus})`);
    outcomes[agent.kind] = { jobId: jobId.slice(0, 24), packetDigest: packetDigest.slice(0, 19), queueId: submittedBody.queueId.slice(0, 24), items, reviewStatus };
  }

  process.stdout.write(`Package 6b journey: PASS ${JSON.stringify(outcomes)}\n`);

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
