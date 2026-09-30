// Fleet harness hand-off: `connector.mjs run` claims an offered task and hands
// it to the local harness the machine owner enabled, through the shared local
// CLI delivery contract, then reports progress, a blocker or the result
// through the ordinary gateway calls. These tests drive the real standalone
// connector against the real gateway handler and services over an in-process
// database with every migration applied, with deterministic fake adapters.
// tests/fleet-harness-handoff-postgres.test.ts repeats the end-to-end path as
// the production logins.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { createFleetHarnessAdapter } from "../src/fleet/v1/harness-adapters";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";
import * as fake from "./support/fleet-fake-harness-adapter.mjs";

const FAKE_MODULE = resolve("tests/support/fleet-fake-harness-adapter.mjs");
const REAL_MODULE = resolve("src/fleet/v1/harness-adapters.ts");

type Mode = FleetOperationsModeV1 | "throw";

async function fixture() {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  const db: DatabaseClient = adaptPglite(raw);
  await seedFleetTenant((sql, params) => raw.query(sql, params));
  const state = { mode: "running" as Mode };
  const gateway = new FleetGatewayStoreV1(db, { tenantId: FLEET_TENANT, operationsMode: async () => {
    if (state.mode === "throw") throw new Error("mode store unreachable");
    return state.mode;
  } });
  const owner = new FleetOwnerServiceV1(db, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
    afterDecision: () => gateway.reconcile() });
  const handler = createFleetGatewayHandlerV1({ store: gateway });
  const server: Server = createServer((request, response) => { void handler.handle(request, response); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "fleet-handoff-"));
  // Every request the connector makes, so a test can prove it spoke only to the gateway.
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => { requests.push(String(input)); return fetch(input, init); };
  return { raw, db, gateway, owner, origin, dir, state, requests, fetcher,
    query: <T>(sql: string, params?: unknown[]) => raw.query<T>(sql, params).then(r => r.rows),
    async close() { await new Promise(done => server.close(done)); await raw.close(); await rm(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function joinWorker(f: Fixture, name: string, workerKind = "codex") {
  const code = await f.owner.createEnrollmentCode(ownerIdentity(), { displayName: name, workerKind,
    projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
  const configPath = join(f.dir, `${name}.json`);
  const joined = await connector.join({ server: f.origin, code: code.code, configPath, fetcher: f.fetcher });
  return { configPath, joined, client: connector.createClient(await connector.loadConfig(configPath), f.fetcher) };
}

async function offer(f: Fixture, name: string) {
  const task = await seedProposedTask(f.db, PROJECT_A, name);
  const offered = await f.owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
  return { ...task, offerId: offered.offerId };
}

async function settings(f: Fixture, name: string, harnesses: Record<string, unknown>, adapterModule = FAKE_MODULE) {
  const path = join(f.dir, `${name}-harnesses.json`);
  await writeFile(path, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule, harnesses }), { mode: 0o600 });
  return path;
}
const fakeCodex = (fakeBehaviour: string, extra: Record<string, unknown> = {}) =>
  ({ codex: { enabled: true, deadlineMs: 2000, fakeBehaviour, ...extra } });

async function runOnce(f: Fixture, worker: { configPath: string }, harnessesPath: string, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath, fetcher: f.fetcher, once: true,
    log: (message: string) => { logs.push(message); }, progressIntervalMs: 25, ...extra });
  return { pass, logs };
}

const jobState = async (f: Fixture, jobId: string) =>
  (await f.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1", [jobId]))[0]!.state;
const events = async (f: Fixture, jobId: string) => (await f.query<{ kind: string; message: string }>(
  `SELECT e.kind,e.message FROM fleet_worker_events e JOIN fleet_claims c ON c.tenant_id=e.tenant_id AND c.claim_id=e.claim_id
   WHERE c.job_id=$1 ORDER BY e.occurred_at,e.event_id`, [jobId]));
const results = async (f: Fixture) => f.query<{ job_id: string; summary: string }>("SELECT job_id,summary FROM fleet_results");

test("success: run claims the offered task, the enabled harness answers, and the owner sees the result", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Studio");
  const task = await offer(f, "handoff-ok");
  fake.calls.length = 0;
  const { pass } = await runOnce(f, worker, await settings(f, "ok", fakeCodex("success")));
  assert.equal(pass.state, "ran");
  assert.equal(pass.outcome, "submitted");
  assert.equal(await jobState(f, task.jobId), "waiting_approval");
  const shown = await f.owner.listResults(ownerIdentity(), { awaitingOnly: true });
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.jobId, task.jobId);
  assert.match(shown[0]!.summary, /^Done by fake codex: Task handoff-ok\n\nWrite a short note for handoff-ok\.$/u);
  assert.equal(shown[0]!.decision, null, "submitting accepts nothing");
  assert.deepEqual((await events(f, task.jobId)).map(event => event.kind), ["progress"]);
  assert.match((await events(f, task.jobId))[0]!.message, /^Started on Codex on this machine\.$/u);

  // The adapter got the task text and a cancel signal, and nothing that grants
  // authority: not the credential, not the server address, not the claim.
  assert.equal(fake.calls.length, 1);
  const seen = JSON.stringify(fake.calls[0]);
  const secret = (JSON.parse(await readFile(worker.configPath, "utf8")) as { secret: string }).secret;
  assert.equal(seen.includes(secret), false);
  assert.equal(seen.includes("crf_"), false);
  assert.equal(seen.includes(f.origin), false);
  assert.equal(seen.includes("fleet-claim:"), false);
  assert.deepEqual(Object.keys(fake.calls[0]!.delivery).sort(), ["identity", "input"]);
  assert.equal(fake.calls[0]!.signalIsAbortSignal, true);
  // The connector made no network call other than to the gateway.
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(url => url.startsWith(`${f.origin}/fleet/v1/`)), f.requests.join("\n"));

  // The owner accepts through the owner path; the task is done.
  await f.owner.review(ownerIdentity(), { resultId: shown[0]!.resultId, decision: "accepted" });
  assert.equal(await jobState(f, task.jobId), "succeeded");
});

test("failure: a harness that fails reports a blocker, hands the task back, and is not retried here", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Failing");
  const task = await offer(f, "handoff-fail");
  const path = await settings(f, "fail", fakeCodex("failure"));
  const { pass } = await runOnce(f, worker, path);
  assert.equal(pass.outcome, "blocked");
  assert.deepEqual(await results(f), [], "no result is stored for a failed run");
  assert.equal(await jobState(f, task.jobId), "ready", "released back to the open offer");
  const blocker = (await events(f, task.jobId)).find(event => event.kind === "blocker");
  assert.match(blocker!.message, /^The Codex run did not finish \(failed:process_or_output_refused\)\. Nothing was submitted\.$/u);

  // The same run loop does not pick the task it just handed back.
  const logs: string[] = [];
  let passes = 0;
  const outcome = connector.runWorker({ configPath: worker.configPath, harnessesPath: path, fetcher: f.fetcher,
    log: (message: string) => { logs.push(message); }, progressIntervalMs: 25,
    sleep: async () => { passes += 1; if (passes >= 2) throw new Error("stop test loop"); } });
  await assert.rejects(outcome, /stop test loop/u);
  const claims = await f.query<{ count: number }>("SELECT count(*)::int AS count FROM fleet_claims WHERE job_id=$1", [task.jobId]);
  assert.equal(claims[0]!.count, 2, "one failed claim, one more failed claim in the new loop, then no third");
});

for (const [behaviour, pattern] of [
  ["throws", /^The Codex adapter failed before it gave an answer\. Nothing was submitted\.$/u],
  ["malformed", /^Codex gave an answer Control Room does not understand\. Nothing was submitted\.$/u],
  ["oversize", /^Codex's answer was larger than 64 KiB, so it was not submitted\. Ask for a shorter answer\.$/u],
  ["timeout", /^The Codex run did not finish \(timed_out:deadline_exceeded\)\. Nothing was submitted\.$/u],
] as const) {
  test(`${behaviour}: never becomes a result, always an honest blocker`, async t => {
    const f = await fixture(); t.after(() => f.close());
    const worker = await joinWorker(f, `W-${behaviour}`);
    const task = await offer(f, `handoff-${behaviour}`);
    const { pass } = await runOnce(f, worker, await settings(f, behaviour, fakeCodex(behaviour, { deadlineMs: 150 })));
    assert.equal(pass.outcome, "blocked");
    assert.deepEqual(await results(f), []);
    assert.equal(await jobState(f, task.jobId), "ready");
    assert.match((await events(f, task.jobId)).find(event => event.kind === "blocker")!.message, pattern);
  });
}

test("timeout: a harness that ignores its time limit is abandoned, reported, and run stops taking work", { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Hung");
  const task = await offer(f, "handoff-hang");
  const started = Date.now();
  await assert.rejects(runOnce(f, worker, await settings(f, "hang", fakeCodex("hang", { deadlineMs: 100 })),
    { watchdogGraceMs: 50 }), /did not stop by its time limit\. run has stopped taking work/u);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(await results(f), []);
  assert.equal(await jobState(f, task.jobId), "ready");
  assert.match((await events(f, task.jobId)).find(event => event.kind === "blocker")!.message,
    /^The Codex run did not stop by its time limit, so it was abandoned\. Nothing was submitted\.$/u);
});

test("not enabled: a machine runs only the harness its owner enabled locally", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Careful");
  const task = await offer(f, "handoff-off");
  fake.calls.length = 0;
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ["missing", undefined],
    ["disabled", { codex: { enabled: false } }],
    ["other-harness", { "claude-code": { enabled: true, deadlineMs: 2000 } }],
  ];
  for (const [name, harnesses] of cases) {
    const path = harnesses ? await settings(f, name, harnesses) : join(f.dir, "absent.json");
    const { pass, logs } = await runOnce(f, worker, path);
    assert.equal(pass.state, "not_enabled", name);
    assert.match(logs.join("\n"), /Codex is not enabled on this machine, so no work is taken/u);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(await jobState(f, task.jobId), "proposed", "nothing was claimed");
  assert.equal((await f.query<{ count: number }>("SELECT count(*)::int AS count FROM fleet_claims"))[0]!.count, 0);

  // An MCP-driven worker never has a harness started by run.
  const agent = await joinWorker(f, "Agent", "mcp-agent");
  assert.equal((await runOnce(f, agent, await settings(f, "agent", fakeCodex("success")))).pass.state, "no_harness");
  assert.equal(fake.calls.length, 0);
});

test("pause: Pause, Drain, Stop and an unreadable switch all stop new claims", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Obedient");
  const task = await offer(f, "handoff-paused");
  const path = await settings(f, "paused", fakeCodex("success"));
  for (const mode of ["paused", "draining", "stopped", "throw"] as const) {
    f.state.mode = mode;
    const expected = mode === "throw" ? "unknown" : mode;
    assert.equal((await worker.client.heartbeat()).operationsMode, expected);
    const { pass, logs } = await runOnce(f, worker, path);
    assert.equal(pass.state, "paused", mode);
    assert.match(logs.join("\n"), new RegExp(`Control Room is ${expected}, so no new work is taken`, "u"));
    // The server refuses the claim too, so an MCP agent or an old connector cannot slip past.
    await assert.rejects(worker.client.claim(task.offerId, `pause-claim-${mode}-000000`), /\(paused\)/u);
  }
  assert.equal(await jobState(f, task.jobId), "proposed");
  f.state.mode = "running";
  assert.equal((await runOnce(f, worker, path)).pass.outcome, "submitted");
});

test("stop during a run: the harness is cancelled and a blocker hands the task back", { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Stoppable");
  const task = await offer(f, "handoff-stop");
  setTimeout(() => { f.state.mode = "stopped"; }, 100);
  const { pass } = await runOnce(f, worker, await settings(f, "stop", fakeCodex("until-aborted", { deadlineMs: 60_000 })));
  assert.equal(pass.outcome, "blocked");
  assert.deepEqual(await results(f), []);
  assert.equal(await jobState(f, task.jobId), "ready");
  assert.match((await events(f, task.jobId)).find(event => event.kind === "blocker")!.message,
    /^Stopped from Control Room before Codex finished\. Nothing was submitted\.$/u);
});

test("revoked mid-run: the harness is cancelled and nothing is posted with the dead credential", { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Revoked");
  const task = await offer(f, "handoff-revoked");
  setTimeout(() => { void f.owner.revokeWorker(ownerIdentity(), worker.joined.workerId); }, 100);
  const { pass } = await runOnce(f, worker, await settings(f, "revoked", fakeCodex("until-aborted", { deadlineMs: 60_000 })));
  assert.equal(pass.outcome, "abandoned");
  assert.equal(pass.reason, "claim_lost");
  assert.deepEqual(await results(f), []);
  assert.equal((await events(f, task.jobId)).some(event => event.kind === "blocker"), false);
});

test("harness settings are refused unless the machine owner wrote them safely", async t => {
  const f = await fixture(); t.after(() => f.close());
  const write = async (name: string, value: unknown, mode = 0o600) => {
    const path = join(f.dir, name);
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
    await chmod(path, mode);
    return path;
  };
  const base = { schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE };
  assert.equal(await connector.loadHarnessSettings(join(f.dir, "none.json")), null);
  await assert.rejects(connector.loadHarnessSettings(await write("bad.json", "{")), /not valid JSON/u);
  await assert.rejects(connector.loadHarnessSettings(await write("schema.json", { ...base, schema: "x", harnesses: {} })), /schema/u);
  await assert.rejects(connector.loadHarnessSettings(await write("extra.json", { ...base, harnesses: {}, server: "x" })), /unknown setting/u);
  await assert.rejects(connector.loadHarnessSettings(await write("unknown.json", { ...base,
    harnesses: { bash: { enabled: true, deadlineMs: 1000 } } })), /unknown harness "bash"/u);
  await assert.rejects(connector.loadHarnessSettings(await write("flag.json", { ...base,
    harnesses: { codex: { enabled: "yes", deadlineMs: 1000 } } })), /codex\.enabled must be true or false/u);
  await assert.rejects(connector.loadHarnessSettings(await write("deadline.json", { ...base,
    harnesses: { codex: { enabled: true, deadlineMs: 7_200_000 } } })), /codex\.deadlineMs/u);
  await assert.rejects(connector.loadHarnessSettings(await write("relative.json", { ...base, adapterModule: "adapter.mjs",
    harnesses: { codex: { enabled: true, deadlineMs: 1000 } } })), /adapterModule must be an absolute path/u);
  if (process.platform !== "win32") {
    await assert.rejects(connector.loadHarnessSettings(await write("shared.json", { ...base,
      harnesses: { codex: { enabled: true, deadlineMs: 1000 } } }, 0o666)), /can be changed by other users/u);
    const loose = await write("loose-adapter.mjs", "export function createFleetHarnessAdapter() {}\n", 0o666);
    await assert.rejects(connector.loadHarnessSettings(await write("loose.json", { ...base, adapterModule: loose,
      harnesses: { codex: { enabled: true, deadlineMs: 1000 } } })), /adapter module .* can be changed by other users/u);
  }
  const good = await connector.loadHarnessSettings(await write("good.json", { ...base,
    harnesses: { codex: { enabled: true, deadlineMs: 1000, model: "gpt-x" }, hermes: { enabled: false } } }));
  assert.deepEqual(good!.harnesses.codex, { enabled: true, configuration: { deadlineMs: 1000, model: "gpt-x" } });
  // A disabled harness is never loaded, whatever the module would do.
  let imported = 0;
  assert.equal(await connector.loadHarnessAdapter(good, "hermes", async () => { imported += 1; return {}; }), null);
  assert.equal(await connector.loadHarnessAdapter(good, "bash", async () => { imported += 1; return {}; }), null);
  assert.equal(imported, 0);
});

// The real shared runner: the connector loads src/fleet/v1/harness-adapters.ts,
// which runs Codex through the existing owner-trusted local runner. A tiny
// script plays the Codex CLI so no real model is called.
async function fakeCodexCli(f: Fixture, body: string) {
  const path = join(f.dir, "codex");
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return path;
}

test("real shared Codex runner: the connector drives it through the shared contract end to end", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "RealCodex");
  const task = await offer(f, "handoff-real-codex");
  const cli = await fakeCodexCli(f, `let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const ok = process.argv.slice(2).join(" ").startsWith("exec --json --sandbox read-only") && input.includes("Write a short note for handoff-real-codex.");
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ok ? "A short note." : "wrong input" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 3 } }));
});`);
  const path = await settings(f, "real", { codex: { enabled: true, executablePath: cli, workingDirectory: f.dir, deadlineMs: 20_000 } },
    REAL_MODULE);
  const { pass } = await runOnce(f, worker, path);
  assert.equal(pass.outcome, "submitted", JSON.stringify(pass));
  assert.equal((await results(f))[0]!.summary, "A short note.");
  assert.equal(await jobState(f, task.jobId), "waiting_approval");
});

test("real shared Codex runner: a crashing CLI becomes a blocker, not a result", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "CrashCodex");
  const task = await offer(f, "handoff-crash-codex");
  const cli = await fakeCodexCli(f, `process.stdin.resume(); process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "half an answer" } }));
  process.exit(3);
});`);
  const path = await settings(f, "crash", { codex: { enabled: true, executablePath: cli, workingDirectory: f.dir, deadlineMs: 20_000 } },
    REAL_MODULE);
  const { pass } = await runOnce(f, worker, path);
  assert.equal(pass.outcome, "blocked");
  assert.deepEqual(await results(f), []);
  assert.equal(await jobState(f, task.jobId), "ready");
});

test("the repository adapter module maps only the three harnesses, each through its own validated runner", () => {
  const configuration = { executablePath: "/usr/bin/true", workingDirectory: "/tmp", deadlineMs: 1000 };
  assert.equal(typeof createFleetHarnessAdapter({ harness: "codex", configuration }).execute, "function");
  assert.equal(typeof createFleetHarnessAdapter({ harness: "claude-code", configuration }).execute, "function");
  assert.equal(typeof createFleetHarnessAdapter({ harness: "hermes", configuration: { ...configuration, profile: "cr",
    model: "model-x", provider: "provider-x" } }).execute, "function");
  assert.throws(() => createFleetHarnessAdapter({ harness: "bash", configuration }), /fleet_harness_adapter_unavailable/u);
  assert.throws(() => createFleetHarnessAdapter({ harness: "codex", configuration: { ...configuration, executablePath: "codex" } }));
  assert.throws(() => createFleetHarnessAdapter({ harness: "codex", configuration: { ...configuration, shell: true } }));
  assert.throws(() => createFleetHarnessAdapter({ harness: "hermes", configuration }));
});
