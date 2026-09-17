// Focused acceptance tests for the local worker inbox watcher package (issue #198).
//
// Disposable: every test uses its own temporary runtime directory, a fake GitHub API, and
// an injected clock. No scheduler is installed, no network call is made, and no credential
// is required. The fake API supplies the issue and comment shapes the accepted inbox client
// reads, so these tests exercise the real reuse path rather than a stand-in for it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readWorkerInbox, renderWorkerInbox } from "../scripts/public-worker-inbox.mjs";
import { actionsFingerprint } from "../scripts/worker-inbox-platform/lib/inbox-fingerprint.mjs";
import { artifactsFor, iso8601Duration, systemdQuote, windowCommandLine, xmlEscape } from "../scripts/worker-inbox-platform/lib/artifacts.mjs";
import { instructionsFor } from "../scripts/worker-inbox-platform/lib/instructions.mjs";
import {
  RUNTIME_VERSION, appendBoundedLog, ensureWorkerDirectory, isOwnedDirectory, logFile, markerFile,
  readState, removeOwnedFiles, signalFile, stateFile, workerDirectory, workerSlug, writeJsonAtomic,
} from "../scripts/worker-inbox-platform/lib/runtime.mjs";
import { isWellFormedXml } from "../scripts/worker-inbox-platform/lib/xml-wellformed.mjs";
import { generate } from "../scripts/worker-inbox-platform/worker-inbox-generate.mjs";
import { uninstall } from "../scripts/worker-inbox-platform/worker-inbox-uninstall.mjs";
import {
  EXIT_CONFIG, EXIT_OK, EXIT_TRANSIENT, argumentsFor as watchArguments, consoleDecision,
  main as watchMain, redactSecrets, resolveToken, runTick,
} from "../scripts/worker-inbox-platform/worker-inbox-watch.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WATCH_SCRIPT = join(REPOSITORY_ROOT, "scripts/worker-inbox-platform/worker-inbox-watch.mjs");
const UNINSTALL_SCRIPT = join(REPOSITORY_ROOT, "scripts/worker-inbox-platform/worker-inbox-uninstall.mjs");
const GENERATE_SCRIPT = join(REPOSITORY_ROOT, "scripts/worker-inbox-platform/worker-inbox-generate.mjs");
const REPOSITORY_NAME = "AgenticBotSitter/agent-control-room";
const WORKER_ID = "worker-inbox-test-01";
const CLOCK = () => new Date("2026-09-14T12:00:00Z");

test("broker backoff survives scheduled ticks without clearing observation or emitting a wake", async t => {
  const runtimeRoot = scratch(t);
  const broker = { url: "http://127.0.0.1:9999/v1/worker-operations", token: "synthetic-private-secret" };
  const options = { workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot, once: true, scheduled: true, broker };
  const good = await runTick({ options, now: CLOCK, reader: async () => [] });
  let reads = 0;
  options.fetchImpl = async () => { reads++; return new Response("{}", { status: 503 }); };
  const bad = await runTick({ options, now: CLOCK });
  assert.equal(bad.notified, false);
  assert.equal(bad.changed, false);
  assert.equal(consoleDecision({ result: bad, options }).print, false);
  const saved = readState(bad.statePath);
  assert.deepEqual(saved.observed, good.observed);
  assert.ok(saved.brokerState.nextBrokerAt > CLOCK().getTime());
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-private-secret/);
  const restarted = await runTick({ options, now: CLOCK });
  assert.equal(restarted.changed, false);
  assert.equal(reads, 1);
});

test("scheduled entry point passes explicit broker configuration without persisting credentials", async t => {
  const root = scratch(t);
  const environment = {
    ACR_WORKER_BROKER_URL: "https://broker.example/v1/worker-operations",
    ACR_WORKER_BROKER_TOKEN: "synthetic-worker-token",
    GITHUB_TOKEN: "synthetic-fallback-token",
  };
  const calls = [];
  const argv = ["--once", "--scheduled", "--worker-id", WORKER_ID,
    "--repository", REPOSITORY_NAME, "--runtime-root", root];
  const reader = async input => { calls.push(input); return []; };
  assert.equal(await watchMain(argv, { environment, reader, now: CLOCK }), EXIT_OK);
  assert.equal(await watchMain(argv, { environment, reader, now: CLOCK }), EXIT_OK);
  assert.equal(calls.length, 2);
  for (const input of calls) {
    assert.deepEqual(input.broker, {
      url: environment.ACR_WORKER_BROKER_URL, token: environment.ACR_WORKER_BROKER_TOKEN,
    });
    assert.equal(input.token, environment.GITHUB_TOKEN);
    assert.equal(input.includeReady, true);
    assert.equal(input.workerId, WORKER_ID);
  }
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  const state = readState(stateFile(directory));
  assert.equal(state.lastOutcome, "ok");
  assert.equal(state.lastChange.changed, false);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-worker-token|synthetic-fallback-token/);
  assert.doesNotMatch(readFileSync(logFile(directory), "utf8"), /synthetic-worker-token|synthetic-fallback-token/);
});

test("scheduled entry point rejects incomplete broker configuration before reading", async t => {
  const root = scratch(t);
  let reads = 0;
  const argv = ["--once", "--scheduled", "--worker-id", WORKER_ID, "--runtime-root", root];
  assert.equal(await watchMain(argv, {
    environment: { ACR_WORKER_BROKER_URL: "https://broker.example/v1/worker-operations" },
    reader: async () => { reads++; return []; }, now: CLOCK,
  }), EXIT_CONFIG);
  assert.equal(reads, 0);
});

test("scheduled entry point retains direct reads when no broker is configured", async t => {
  const root = scratch(t);
  let reads = 0;
  assert.equal(await watchMain(["--once", "--scheduled", "--worker-id", WORKER_ID, "--runtime-root", root], {
    environment: {}, now: CLOCK,
    reader: async input => {
      reads++;
      assert.equal(input.broker, undefined);
      return [];
    },
  }), EXIT_OK);
  assert.equal(reads, 1);
});

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "worker-inbox-platform-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function actionMarker(workerId, state, issue) {
  return `<!-- agent-control-room-action:v1 worker=${workerId} state=${state} issue=${issue} -->`;
}

function githubIssue(number, labels) {
  return {
    number,
    state: "open",
    title: `Issue ${number}`,
    html_url: `https://github.com/${REPOSITORY_NAME}/issues/${number}`,
    labels: labels.map(name => ({ name })),
  };
}

function githubComment(body) {
  return {
    body,
    user: { login: "MarvinAi5" },
    author_association: "MEMBER",
    html_url: `https://github.com/${REPOSITORY_NAME}/issues/0#issuecomment-1`,
  };
}

// Mutating holder so a test can change the assignment between ticks, as GitHub would.
function fakeGithub(initial = {}) {
  const holder = { issues: initial.issues ?? [], comments: initial.comments ?? {} };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/git/ref/heads/main")) {
      return jsonResponse({ object: { sha: "a".repeat(40) } });
    }
    if (url.includes("labels=status%3Aworking") || url.includes("labels=status%3Ain-review")) {
      return jsonResponse([]);
    }
    const commentMatch = /\/issues\/(\d+)\/comments/u.exec(url);
    if (commentMatch) return jsonResponse(holder.comments[Number(commentMatch[1])] ?? []);
    return jsonResponse(holder.issues);
  };
  return { holder, calls, fetchImpl };
}

// An assignment in the exact shape the accepted inbox client recognises.
function assignment({ state = "changes-required", number = 199, workerId = WORKER_ID } = {}) {
  return {
    issues: [githubIssue(number, [`status:${state}`, "action:worker"])],
    comments: { [number]: [githubComment(actionMarker(workerId, state, number))] },
  };
}

function emptyAssignment() {
  return { issues: [], comments: {} };
}

test("installed watcher signals newly ready work even when the worker owns nothing", async t => {
  const runtimeRoot = scratch(t);
  const api = fakeGithub();
  const options = { workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot, fetchImpl: api.fetchImpl };
  assert.equal((await runTick({ options, now: CLOCK })).notified, false);
  api.holder.issues = [{ ...githubIssue(208, ["status:ready", "platform:any"]), body:
    `<!-- acr-public-work:v1 ${JSON.stringify({ target: "main", base: "a".repeat(40), writeScopes: ["src/ideas/**"], dependencies: [], checks: ["pnpm check"], risk: "ordinary", effects: "none", leaseHours: 24 })} -->` }];
  const discovered = await runTick({ options, now: CLOCK });
  assert.equal(discovered.notified, true);
  assert.deepEqual(discovered.observed.states, ["208:ready-candidate"]);
  assert.equal((await runTick({ options, now: CLOCK })).notified, false);
  assert.ok(api.calls.every(call => call.method === "GET"));
});

// A controller record in the shape the accepted client treats as authoritative. Trust comes
// from the controller bot identity, never from repository membership.
function controllerComment(body) {
  return {
    id: 9_000,
    body,
    user: { login: "github-actions[bot]", type: "Bot" },
    author_association: "NONE",
    html_url: `https://github.com/${REPOSITORY_NAME}/issues/0#issuecomment-9000`,
  };
}

function handoffMarker({ workerId = WORKER_ID, state = "changes-required", number = 199, action = "worker", phase = "complete", acknowledged = false, head } = {}) {
  const record = { issue: number, workerId, state, action, phase, acknowledged };
  if (head !== undefined) record.head = head;
  return `<!-- agent-control-room-handoff:v1 ${JSON.stringify(record)} -->`;
}

function controllerAssignment({ state = "changes-required", number = 199, workerId = WORKER_ID, head, acknowledged = false } = {}) {
  return {
    issues: [githubIssue(number, [`status:${state}`, "action:worker"])],
    comments: { [number]: [controllerComment(handoffMarker({ workerId, state, number, head, acknowledged }))] },
  };
}

// A controller claim, in the exact shape the accepted client recognises. Note there is no
// action label anywhere: an accepted claim is actionable on the status label alone.
function claimComment({ workerId = WORKER_ID, number = 199, outcome = "ACCEPTED", request = 2 } = {}) {
  return controllerComment(
    `CLAIM ${outcome} — record\n`
    + `<!-- agent-control-room-claim:v2 issue=${number} request=${request} actor=MarvinAi5 worker=${workerId} -->`,
  );
}

function tickOptions(runtimeRoot, overrides = {}) {
  return {
    workerId: WORKER_ID,
    repository: REPOSITORY_NAME,
    runtimeRoot,
    maxLogBytes: 65536,
    ...overrides,
  };
}

function readRuntime(directory) {
  const parts = [stateFile(directory), logFile(directory), signalFile(directory)]
    .filter(existsSync).map(file => readFileSync(file, "utf8"));
  return parts.join("\n");
}

test("the watched action is read through the accepted inbox client, read-only", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment());
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  const result = await runTick({ options, now: CLOCK });

  assert.equal(result.outcome, "ok");
  assert.equal(result.observed.issues[0], 199);
  assert.ok(github.calls.length > 0, "the accepted inbox client must have been used");
  assert.ok(github.calls.every(call => call.method === "GET"), "the watcher must never write to GitHub");
});

test("a changed action notifies once and an unchanged inbox is deduplicated", async (t) => {
  const root = scratch(t);
  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl });

  const first = await runTick({ options, now: CLOCK });
  assert.equal(first.change, "baseline-action");
  assert.equal(first.notified, true);
  const signalAfterFirst = readFileSync(signalFile(first.directory), "utf8");
  assert.match(signalAfterFirst, /"kind": "baseline-action"/u);

  const second = await runTick({ options, now: CLOCK });
  assert.equal(second.change, "unchanged");
  assert.equal(second.notified, false);
  assert.equal(readFileSync(signalFile(second.directory), "utf8"), signalAfterFirst,
    "an unchanged inbox must not rewrite the signal");

  const third = await runTick({ options, now: CLOCK });
  assert.equal(third.change, "unchanged");
});

test("a correction or reassignment notifies again", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment({ state: "working" }));
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  assert.equal((await runTick({ options, now: CLOCK })).change, "baseline-action");

  Object.assign(github.holder, assignment({ state: "changes-required" }));
  const corrected = await runTick({ options, now: CLOCK });
  assert.equal(corrected.change, "action-changed");
  assert.equal(corrected.notified, true);
  assert.deepEqual(corrected.observed.states, ["199:changes-required"]);

  Object.assign(github.holder, assignment({ state: "working" }));
  const reassigned = await runTick({ options, now: CLOCK });
  assert.equal(reassigned.change, "action-changed");
  assert.deepEqual(reassigned.observed.states, ["199:working"]);

  // Reassignment *away*: the marker now names a different worker. The accepted client skips
  // it, so this worker's assignment is gone and that is reported as clearing, not as a
  // change belonging to someone else.
  Object.assign(github.holder, assignment({ state: "working", workerId: "some-other-worker-01" }));
  const reassignedAway = await runTick({ options, now: CLOCK });
  assert.equal(reassignedAway.change, "action-cleared");
  assert.deepEqual(reassignedAway.observed.issues, []);
});

test("a rate-limited read is reported, never masked as an empty inbox", async (t) => {
  const root = scratch(t);
  const options = tickOptions(root);
  // This is the real live behavior of an anonymous read once the rate limit is exhausted.
  const limited = async () => { throw new Error("worker_inbox_api_403"); };

  const result = await runTick({ options, reader: limited, now: CLOCK });
  assert.equal(result.outcome, "failure");
  assert.equal(result.quiet, true, "a scheduled rate-limit tick must not wake the AI worker");
  assert.match(readState(stateFile(result.directory)).lastError, /worker_inbox_api_403/u,
    "the failure code must be persisted, not swallowed");
  assert.match(readFileSync(logFile(result.directory), "utf8"), /worker_inbox_api_403/u,
    "the failure code must appear in the log");
  assert.equal(existsSync(signalFile(result.directory)), false, "a blocked read must not signal");
  assert.equal(readState(stateFile(result.directory)).observed, undefined,
    "a blocked read must not record an observed action at all");

  // Because nothing was observed, the next successful read is a baseline rather than a
  // change that would look like fresh work.
  const recovered = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl });
  assert.equal((await runTick({ options: recovered, now: CLOCK })).change, "baseline-action");
});

test("console output is quiet in a loop and reports a repeated failure only once", () => {
  const loop = { once: false, json: false };
  const unchanged = { outcome: "ok", notified: false, change: "unchanged", message: "Unchanged for worker X." };
  assert.equal(consoleDecision({ result: unchanged, options: loop, lastReported: undefined }).print, true,
    "the first tick should report");
  assert.equal(consoleDecision({ result: unchanged, options: loop, lastReported: "unchanged" }).print, false,
    "an unchanged poll must not repeat on the console every interval");

  const changed = { outcome: "ok", notified: true, change: "action-changed", message: "changed", observed: { fingerprint: "abc" } };
  const reportedChange = consoleDecision({ result: changed, options: loop, lastReported: "unchanged" });
  assert.equal(reportedChange.print, true);
  assert.equal(consoleDecision({ result: changed, options: loop, lastReported: reportedChange.signature }).print, false);

  const failure = { outcome: "failure", error: "worker_inbox_api_403", notified: false };
  const reportedFailure = consoleDecision({ result: failure, options: loop, lastReported: "unchanged" });
  assert.equal(reportedFailure.print, true);
  assert.equal(reportedFailure.stream, "stderr");
  assert.match(reportedFailure.line, /worker_inbox_api_403/u);
  assert.equal(consoleDecision({ result: failure, options: loop, lastReported: reportedFailure.signature }).print, false,
    "a repeated identical failure must not spam the operator");

  const rateLimit = { ...failure, quiet: true };
  assert.equal(consoleDecision({ result: rateLimit, options: loop, lastReported: undefined }).print, false,
    "a transient scheduled rate limit must stay silent rather than waking the worker");
  assert.equal(consoleDecision({ result: rateLimit, options: { once: true, scheduled: false, json: false }, lastReported: undefined }).print, true,
    "an operator-requested one-shot read still reports the rate limit");
  assert.equal(consoleDecision({ result: rateLimit, options: { once: true, scheduled: true, json: false }, lastReported: undefined }).print, false,
    "a scheduler one-shot keeps a transient rate limit silent");

  // --once always reports, because the operator asked for exactly one result.
  assert.equal(consoleDecision({ result: unchanged, options: { once: true, json: false }, lastReported: "unchanged" }).print, true);
  // --json always emits the whole tick.
  assert.equal(consoleDecision({ result: unchanged, options: { once: false, json: true }, lastReported: "unchanged" }).print, true);
});

test("no action is a quiet baseline, and clearing action notifies once", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(emptyAssignment());
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  const quiet = await runTick({ options, now: CLOCK });
  assert.equal(quiet.change, "baseline-empty");
  assert.equal(quiet.notified, false);
  assert.equal(existsSync(signalFile(quiet.directory)), false, "nothing to signal for an empty baseline");

  Object.assign(github.holder, assignment());
  assert.equal((await runTick({ options, now: CLOCK })).change, "action-changed");

  Object.assign(github.holder, emptyAssignment());
  const cleared = await runTick({ options, now: CLOCK });
  assert.equal(cleared.change, "action-cleared");
  assert.equal(cleared.notified, true);

  assert.equal((await runTick({ options, now: CLOCK })).change, "unchanged",
    "a cleared action must not notify repeatedly");
});

test("a read failure never clears the observed action and never re-notifies", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment());
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  const first = await runTick({ options, now: CLOCK });
  assert.equal(first.notified, true);
  const observedBefore = readState(stateFile(first.directory)).observed;

  const failing = async () => { throw new Error("worker_inbox_api_503"); };
  const failure = await runTick({ options, reader: failing, now: CLOCK });
  assert.equal(failure.outcome, "failure");
  assert.equal(failure.notified, false);

  const stateAfterFailure = readState(stateFile(first.directory));
  assert.equal(stateAfterFailure.lastOutcome, "failure");
  assert.deepEqual(stateAfterFailure.observed, observedBefore,
    "a network failure must not be recorded as an action change");

  const recovered = await runTick({ options, now: CLOCK });
  assert.equal(recovered.change, "unchanged", "recovery must not look like a new assignment");
  assert.equal(recovered.notified, false);
});

test("a read failure exits 2 while a configuration error exits 1", async (t) => {
  const root = scratch(t);
  const failing = async () => { throw new Error("worker_inbox_api_403"); };
  const base = ["--once", "--worker-id", WORKER_ID, "--repository", REPOSITORY_NAME, "--runtime-root", root];

  assert.equal(await watchMain(base, { reader: failing, environment: {} }), EXIT_TRANSIENT);
  assert.equal(await watchMain([...base, "--scheduled"], { reader: failing, environment: {} }), EXIT_OK,
    "scheduled rate limiting is recorded but must not wake a worker through failure output");
  assert.equal(await watchMain(["--help"], { environment: {} }), EXIT_OK);
  assert.equal(await watchMain(["--worker-id", "x", "--once"], { environment: {} }), EXIT_CONFIG);
  assert.equal(await watchMain(["--worker-id", WORKER_ID, "--repository", "not-a-repository", "--once"], { environment: {} }), EXIT_CONFIG);
  assert.equal(await watchMain(["--nonsense"], { environment: {} }), EXIT_CONFIG);
});

test("the CLI refuses an invalid worker ID before any read", () => {
  const result = spawnSync(process.execPath, [WATCH_SCRIPT, "--once", "--worker-id", "x"], { encoding: "utf8" });
  assert.equal(result.status, EXIT_CONFIG);
  assert.match(result.stderr, /worker_inbox_platform_worker_id_invalid/u);

  assert.throws(() => watchArguments(["--worker-id", "ab"]), /worker_inbox_platform_worker_id_invalid/u);
  assert.throws(() => watchArguments(["--worker-id", WORKER_ID, "--repository", "nope"]), /worker_inbox_platform_repository_invalid/u);
  assert.throws(() => watchArguments(["--worker-id", WORKER_ID, "--interval", "0"]), /worker_inbox_platform_interval_invalid/u);
  assert.throws(() => watchArguments(["--worker-id", WORKER_ID, "--scheduled"]), /scheduled_requires_once/u);
});

test("a restart reuses persisted state instead of re-notifying", async (t) => {
  const root = scratch(t);
  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl });

  const first = await runTick({ options, now: CLOCK });
  assert.equal(first.notified, true);
  const stateOnDisk = readState(stateFile(first.directory));
  assert.equal(stateOnDisk.lastOutcome, "ok");
  assert.equal(typeof stateOnDisk.observed.fingerprint, "string");

  // A fresh process: new options object, new client instance, same runtime directory.
  const restarted = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl });
  const afterRestart = await runTick({ options: restarted, now: () => new Date("2026-09-14T12:05:00Z") });
  assert.equal(afterRestart.change, "unchanged");
  assert.equal(afterRestart.notified, false,
    "a restart must not repeat a notification for the same action");

  const changed = tickOptions(root, { fetchImpl: fakeGithub(assignment({ state: "working" })).fetchImpl });
  assert.equal((await runTick({ options: changed, now: CLOCK })).change, "action-changed",
    "a restart must still notice a genuine change");
});

test("logs stay bounded and keep the newest line", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment({ state: "working" }));
  const options = tickOptions(root, { fetchImpl: github.fetchImpl, maxLogBytes: 512 });
  // Built in UTC and asserted from the same clock, so the expectation cannot depend on where this
  // runs. A host-local constructor plus a hard-coded offset passed on a UTC-6 machine and failed on
  // GitHub, which runs in UTC.
  const tickClock = index => new Date(Date.UTC(2026, 8, 14, 12, index));

  for (let index = 0; index < 40; index++) {
    Object.assign(github.holder, assignment({ state: index % 2 === 0 ? "working" : "changes-required" }));
    await runTick({ options, now: () => tickClock(index) });
  }

  const bounded = readFileSync(logFile(workerDirectory({ workerId: WORKER_ID, runtimeRoot: root })), "utf8");
  assert.ok(statSync(logFile(workerDirectory({ workerId: WORKER_ID, runtimeRoot: root }))).size <= 512,
    "the log must stay within its bound");
  assert.match(bounded, /\[log truncated by worker-inbox-platform/u);
  // The newest line is still named exactly, just without a hard-coded local offset.
  assert.match(bounded, new RegExp(tickClock(39).toISOString().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    "the newest line must survive truncation");

  // The tick loop above cannot prove the truncation POLICY: whether the final append happens to
  // trigger a truncation is incidental, so a truncation that discarded everything would still
  // leave the newest line present at the end of the log. This fills the log to within one line of
  // the bound and then appends the line that must overflow, so the newest-line assertion only
  // passes if the truncation kept the newest lines. The truncation is asserted, so this probe
  // cannot quietly stop testing anything.
  const overflow = join(root, "bound.log");
  const probeLine = suffix => `${"filler".repeat(10)}-${suffix}`;
  const probeSize = () => statSync(overflow, { throwIfNoEntry: false })?.size ?? 0;
  while (probeSize() <= 512 - (Buffer.byteLength(probeLine("newest-line")) + 1)) {
    appendBoundedLog(overflow, probeLine("filler"), { maxBytes: 512 });
  }
  const overflowing = appendBoundedLog(overflow, probeLine("newest-line"), { maxBytes: 512 });
  assert.equal(overflowing.truncated, true, "the probe must actually trigger a truncation");
  assert.match(readFileSync(overflow, "utf8"), /-newest-line/u,
    "the line that triggered the truncation must survive it");
  assert.ok(statSync(overflow).size <= 512, "and the bound must still hold after it");

  assert.throws(() => appendBoundedLog(join(root, "x.log"), "line", { maxBytes: 10 }),
    /worker_inbox_platform_log_bound_invalid/u);
});

test("uninstall removes only files this tool created", async (t) => {
  const root = scratch(t);
  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl });
  const first = await runTick({ options, now: CLOCK });
  const directory = first.directory;
  generate({ options: { workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, platform: "launchd" }, scriptPath: "script.mjs", nodePath: "node" });

  const foreign = join(directory, "keep-me.txt");
  writeFileSync(foreign, "operator file\n", "utf8");
  // The launcher's own console logs are part of this tool's footprint. If they were not owned
  // entries they would be preserved as unrecognised files, orphaning logs in a directory that
  // could then never be removed.
  writeFileSync(join(directory, "launchd.out.log"), "launcher stdout\n", "utf8");
  writeFileSync(join(directory, "launchd.err.log"), "launcher stderr\n", "utf8");

  const result = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root } });
  assert.equal(result.refused, false);
  assert.ok(result.removed.includes("state.json"));
  assert.ok(result.removed.includes("watch.log"));
  assert.ok(result.removed.includes("signal.json"));
  assert.ok(result.removed.includes("generated"));
  assert.ok(result.removed.includes("launchd.out.log"), "launcher stdout must be cleaned up");
  assert.ok(result.removed.includes("launchd.err.log"), "launcher stderr must be cleaned up");
  assert.deepEqual(result.preserved, ["keep-me.txt"]);
  assert.equal(result.directoryRemoved, false, "a directory with a foreign file must be kept");
  assert.equal(existsSync(stateFile(directory)), false);
  assert.equal(existsSync(foreign), true);

  // Dry run reports without removing.
  rmSync(foreign, { force: true });
  writeFileSync(stateFile(directory), "{}\n", "utf8");
  const dry = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root, dryRun: true } });
  assert.ok(dry.removed.includes("state.json"));
  assert.equal(existsSync(stateFile(directory)), true, "a dry run must remove nothing");

  const final = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root } });
  assert.equal(final.directoryRemoved, true);
  assert.equal(existsSync(directory), false);
});

test("uninstall refuses a directory this tool did not create", (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  mkdirSync(directory, { recursive: true });
  const unrelated = join(directory, "important.db");
  writeFileSync(unrelated, "do not delete\n", "utf8");

  assert.equal(isOwnedDirectory(directory), false);
  const result = removeOwnedFiles(directory);
  assert.equal(result.refused, true);
  assert.equal(result.reason, "worker_inbox_runtime_directory_not_owned");
  assert.equal(existsSync(unrelated), true);

  const cli = spawnSync(process.execPath, [UNINSTALL_SCRIPT, "--worker-id", WORKER_ID, "--runtime-root", root], { encoding: "utf8" });
  assert.equal(cli.status, 3);
  assert.equal(existsSync(unrelated), true);
});

test("paths containing spaces and shell metacharacters work end to end", async (t) => {
  const awkward = join(scratch(t), "runtime dir with spaces & 50% done");
  const options = tickOptions(awkward, { fetchImpl: fakeGithub(assignment()).fetchImpl });

  const first = await runTick({ options, now: CLOCK });
  assert.equal(first.outcome, "ok");
  assert.ok(first.directory.includes("runtime dir with spaces & 50% done"));
  assert.match(readFileSync(signalFile(first.directory), "utf8"), /"kind": "baseline-action"/u);

  const generated = generate({
    options: {
      workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: awkward, platform: "systemd",
      workingDirectory: join(awkward, "work tree"),
    },
    scriptPath: join(awkward, "scripts", "watch.mjs"),
    nodePath: join(awkward, "bin", "node"),
  });
  assert.equal(generated.written.length, 2);
  const service = generated.written.find(entry => entry.name.endsWith(".service"));
  const content = readFileSync(service.path, "utf8");
  assert.match(content, /ExecStart="\/.*runtime dir with spaces & 50%% done\/bin\/node"/u,
    "systemd requires the path quoted and % escaped");
  // Every space-bearing value must be quoted, not just ExecStart: systemd splits on unquoted
  // whitespace for these settings too, so an unquoted one silently misparses.
  assert.match(content, /EnvironmentFile=-"\/.*runtime dir with spaces & 50%% done\/[^"]+\/env"/u,
    "EnvironmentFile must be quoted and % escaped");
  assert.match(content, /WorkingDirectory="\/.*runtime dir with spaces & 50%% done\/work tree"/u,
    "WorkingDirectory must be quoted and % escaped");

  assert.equal(uninstall({ options: { workerId: WORKER_ID, runtimeRoot: awkward } }).directoryRemoved, true);
});

test("every platform renders a well-formed definition that names the worker and repository", (t) => {
  const root = scratch(t);
  const scriptPath = join(root, "scripts", "worker-inbox-watch.mjs");
  const nodePath = join(root, "bin", "node");
  for (const platform of ["launchd", "systemd", "windows"]) {
    const generated = generate({
      options: {
        workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root,
        platform, signalDirectory: join(root, "signals"),
        // Artifacts must live in the directory uninstall owns; an --out outside it would be
        // written and then orphaned, because uninstall only cleans inside the runtime directory.
        out: join(workerDirectory({ workerId: WORKER_ID, runtimeRoot: root }), "generated", platform),
      },
      scriptPath,
      nodePath,
    });
    assert.ok(generated.written.length >= 1);
    for (const artifact of generated.written) {
      const content = readFileSync(artifact.path, "utf8");
      if (/\.(?:xml|plist)$/u.test(artifact.name)) {
        assert.ok(isWellFormedXml(content), `${artifact.name} must be well-formed XML`);
      }
      assert.match(content, new RegExp(WORKER_ID, "u"));
    }
    assert.deepEqual(readdirSync(generated.artifactDirectory).sort(), generated.written.map(entry => entry.name).sort());
  }

  const launchd = artifactsFor({
    platform: "launchd", workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeDirectory: join(root, "runtime"),
    nodePath, scriptPath, workingDirectory: root, intervalSeconds: 600,
    standardOut: join(root, "out.log"), standardError: join(root, "err.log"),
  })[0].content;
  assert.match(launchd, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/u);
  assert.match(launchd, new RegExp(xmlEscape(scriptPath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  // launchd appends this process's console output itself. It must not share watch.log, which
  // the watcher bounds internally, or the advertised bound would not hold.
  const launchdGenerated = generate({
    options: { workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, platform: "launchd" },
    scriptPath,
    nodePath,
  });
  const plist = readFileSync(launchdGenerated.written[0].path, "utf8");
  assert.match(plist, /launchd\.out\.log/u);
  assert.match(plist, /launchd\.err\.log/u);
  assert.equal(/<key>StandardOutPath<\/key>\s*<string>[^<]*watch\.log<\/string>/u.test(plist), false,
    "the launcher must not write to the file the watcher bounds");

  const systemd = artifactsFor({
    platform: "systemd", workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeDirectory: join(root, "runtime"),
    nodePath, scriptPath, workingDirectory: root, intervalSeconds: 300,
  });
  assert.match(systemd.find(entry => entry.name.endsWith(".timer")).content, /OnUnitActiveSec=300s/u);
  assert.match(systemd.find(entry => entry.name.endsWith(".service")).content, /EnvironmentFile=-/u,
    "token use stays inherited from an owner-controlled environment file");

  const windows = artifactsFor({
    platform: "windows", workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeDirectory: join(root, "runtime"),
    nodePath, scriptPath, workingDirectory: root, intervalSeconds: 300,
    startBoundary: "2026-09-14T12:00:00",
  });
  const task = windows.find(entry => entry.name.endsWith(".xml")).content;
  assert.ok(isWellFormedXml(task));
  assert.match(task, /<Interval>PT5M<\/Interval>/u);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.ok(task.includes(`<Command>${xmlEscape(nodePath)}</Command>`), "the task must run node directly");
  assert.ok(task.includes("--worker-id"), "the task must name the worker explicitly");
  assert.ok(task.includes(xmlEscape(scriptPath)), "the task must invoke the watcher script");
  // No shell script is shipped that this repository cannot syntax-check off Windows.
  assert.equal(windows.length, 1);
  assert.ok(windows.every(entry => !entry.name.endsWith(".cmd")));
  assert.equal(iso8601Duration(45), "PT45S");
});

test("escaping is load-bearing, and the XML check rejects malformed input", () => {
  assert.equal(xmlEscape("a & b"), "a &amp; b");
  assert.equal(systemdQuote("/tmp/50% done"), '"/tmp/50%% done"');
  assert.equal(systemdQuote('/tmp/say "hi"'), '"/tmp/say \\"hi\\""');

  assert.equal(isWellFormedXml(`<root><path>${xmlEscape("/tmp/a & b")}</path></root>`), true);
  assert.equal(isWellFormedXml("<root><path>/tmp/a & b</path></root>"), false,
    "a raw ampersand must be rejected rather than shipped");
  assert.equal(isWellFormedXml("<root><a/></root>"), true);
  assert.equal(isWellFormedXml("<root><a></root>"), false);
  assert.equal(isWellFormedXml("<root><a/></root><second/>"), false);
  assert.equal(isWellFormedXml("<root"), false);
  assert.equal(isWellFormedXml(""), false);
  assert.equal(isWellFormedXml('<?xml version="1.0"?><!-- c --><root b="1"><c/></root>'), true);

  // Misuse is diagnosable: a wrong option name reports which input is missing instead of
  // surfacing a bare "Cannot read properties of undefined".
  assert.throws(() => artifactsFor({
    platform: "systemd", workerId: WORKER_ID, repository: REPOSITORY_NAME,
    nodePath: "n", scriptPath: "s", workingDirectory: "w",
  }), /worker_inbox_platform_artifact_input_missing:systemd:runtimeDirectory/u);

  // The generator refuses to write malformed XML instead of emitting a broken file, and an
  // unknown platform is rejected rather than silently producing nothing.
  assert.throws(() => artifactsFor({ platform: "unsupported" }), /worker_inbox_platform_platform_invalid/u);
});

test("a token is never written to state, log, signal, or generated artifacts", async (t) => {
  const sentinel = "ghp_SentinelTokenValue0123456789";
  const root = scratch(t);
  const github = fakeGithub(assignment());
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  await runTick({ options, token: sentinel, now: CLOCK });
  await runTick({ options, token: sentinel, now: CLOCK });
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });

  // A failure message that happens to contain the token must be redacted in the log.
  const leaky = async () => { throw new Error(`worker_inbox_api_500 token=${sentinel}`); };
  await runTick({ options, reader: leaky, token: sentinel, now: CLOCK });

  const generated = generate({ options: { workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, all: true }, scriptPath: "s.mjs", nodePath: "node" });
  const haystack = [
    readRuntime(directory),
    ...generated.written.map(entry => readFileSync(entry.path, "utf8")),
  ].join("\n");

  assert.equal(haystack.includes(sentinel), false, "no artifact may contain a token value");
  assert.match(readFileSync(logFile(directory), "utf8"), /\[REDACTED\]/u);
  assert.equal(redactSecrets(`boom ${sentinel}`, [sentinel]), "boom [REDACTED]");
  assert.equal(redactSecrets("short token untouched", ["abc"]), "short token untouched");
});

test("token resolution prefers the environment and never invents one", () => {
  const sentinel = "ghp_AnotherSentinelValue0123456";
  assert.equal(resolveToken({ environment: { GITHUB_TOKEN: sentinel } }), sentinel);
  assert.equal(resolveToken({ environment: {} }), undefined);
  assert.equal(resolveToken({ environment: { GITHUB_TOKEN: "   " } }), undefined);
  assert.equal(resolveToken({
    environment: {}, tokenFromGh: true, runCommand: () => ({ status: 0, stdout: "from-gh\n" }),
  }), "from-gh");
  assert.throws(() => resolveToken({
    environment: {}, tokenFromGh: true, runCommand: () => ({ status: 1, stdout: "" }),
  }), /worker_inbox_platform_gh_token_unavailable/u);
});

test("instructions cover start, inspect, stop, uninstall, and the wake limitation", () => {
  for (const platform of ["launchd", "systemd", "windows"]) {
    const text = instructionsFor({
      platform, workerId: WORKER_ID, artifactDirectory: "/tmp/a b/c",
      runtimeDirectory: "/tmp/a b/rt", repository: REPOSITORY_NAME,
    });
    assert.match(text, /Start/u);
    assert.match(text, /Inspect/u);
    assert.match(text, /Stop/u);
    assert.match(text, /Uninstall/u);
    assert.match(text, /cannot wake an idle agent/u, "the limitation must be stated, not implied");
    assert.match(text, /No token is generated, copied, printed, or stored/u);
    assert.match(text, /worker-inbox-uninstall\.mjs/u);
  }
  assert.throws(() => instructionsFor({ platform: "plan9", workerId: WORKER_ID, artifactDirectory: "a", runtimeDirectory: "b", repository: REPOSITORY_NAME }),
    /worker_inbox_platform_platform_invalid/u);
});

test("the generated instructions warn that a scheduler PATH can break --token-from-gh", () => {
  const forPlatform = platform => instructionsFor({
    platform, workerId: WORKER_ID, artifactDirectory: "/tmp/a b/c",
    runtimeDirectory: "/tmp/a b/rt", repository: REPOSITORY_NAME,
  });

  // launchd and systemd user services do not inherit the shell environment, so the flag they are
  // told to use can fail on a scheduler even though it works in a terminal. The generated text has
  // to say so, and name the failure, or an operator installs a job that never polls.
  for (const platform of ["launchd", "systemd"]) {
    const text = forPlatform(platform);
    assert.match(text, /Scheduler PATH/u, `${platform} instructions must warn about the scheduler PATH`);
    assert.match(text, /worker_inbox_platform_gh_token_unavailable/u,
      `${platform} instructions must name the failure an operator will actually see`);
    assert.match(text, /does not\s+fall back to anonymous|not\s+fall back to anonymous requests/u,
      `${platform} instructions must say the failure is not a silent fallback`);
  }

  // The remedy differs by platform, and advice that cannot be followed on the platform it is
  // printed for is worse than no advice: launchd reads no environment file, so telling a macOS
  // operator to use one sends them looking for a file that does not exist.
  const launchd = forPlatform("launchd");
  assert.match(launchd, /EnvironmentVariables/u, "the macOS remedy is a PATH in the property list");
  assert.doesNotMatch(launchd, /environment file the unit reads/u, "launchd reads no environment file");

  const systemd = forPlatform("systemd");
  assert.match(systemd, /EnvironmentFile=/u, "the systemd remedy is the unit's environment file");

  // Task Scheduler runs with the user environment, so it must NOT carry a caveat that does not
  // apply to it - a warning that cannot be acted on is its own kind of untrue.
  const windows = forPlatform("windows");
  assert.doesNotMatch(windows, /Scheduler PATH/u);
  assert.match(windows, /--token-from-gh/u, "windows still documents the flag it can use");
});

test("an output directory outside the owned one is refused, not written and orphaned", (t) => {
  const root = scratch(t);
  const runtimeDirectory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  const owned = join(runtimeDirectory, "generated");

  // Uninstall removes only entries it recognises inside the runtime directory, so artifacts written
  // anywhere else could never be cleaned up. The last case is a sibling that merely shares a
  // prefix with the owned directory: a string test would wrongly accept it.
  for (const stray of [join(root, "elsewhere"), join(root, "generated"), `${owned}-backup`]) {
    assert.throws(
      () => generate({
        options: {
          workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root,
          platform: "launchd", out: stray,
        },
        scriptPath: "script.mjs", nodePath: "node",
      }),
      /worker_inbox_platform_out_directory_not_owned/u,
      `${stray} is outside the owned directory and must be refused`,
    );
    assert.equal(existsSync(stray), false, `${stray} must not have been created`);
  }

  // A path inside the owned directory is accepted, and uninstall really does clean it up.
  const inside = join(owned, "launchd");
  const generated = generate({
    options: {
      workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root,
      platform: "launchd", out: inside,
    },
    scriptPath: "script.mjs", nodePath: "node",
  });
  assert.ok(generated.written.length >= 1);
  for (const artifact of generated.written) {
    assert.ok(artifact.path.startsWith(inside), `${artifact.path} must be inside the owned directory`);
  }

  const removed = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root } });
  assert.equal(removed.refused, false);
  assert.ok(removed.removed.includes("generated"), "artifacts must be owned and removed");
  assert.equal(existsSync(owned), false, "nothing may survive uninstall");

  // The operator gets a refusal and a non-zero status, not a silent success.
  const cli = spawnSync(process.execPath, [
    GENERATE_SCRIPT, "--worker-id", WORKER_ID, "--platform", "launchd",
    "--runtime-root", root, "--out", join(root, "nope"),
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1, "the generator maps any refusal to exit 1");
  assert.match(cli.stderr, /worker_inbox_platform_out_directory_not_owned/u);
  assert.equal(existsSync(join(root, "nope")), false);
});

test("the extra signal is written whole, recorded, and cleaned up without touching a foreign directory", async (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  const foreign = join(root, "elsewhere", "signals");
  mkdirSync(foreign, { recursive: true });
  // A file belonging to another process in the same directory. Uninstall must not go near it, and
  // must not remove the directory either: this tool did not create that directory.
  const operatorFile = join(foreign, "keep-me.txt");
  writeFileSync(operatorFile, "operator file\n", "utf8");

  const options = tickOptions(root, {
    fetchImpl: fakeGithub(assignment()).fetchImpl, signalDirectory: foreign,
  });
  const result = await runTick({ options, now: CLOCK });
  assert.equal(result.change, "baseline-action");

  const external = join(foreign, `${workerSlug(WORKER_ID)}.signal`);
  assert.equal(existsSync(external), true, "the extra signal must be written");
  // Content parity with the owned signal, which is written by the atomic helper. Atomicity itself
  // is NOT observable from a single-threaded read - a raw write reads back whole too - so this test
  // does not claim to prove it. The code uses the same atomic writer for both files; that is a
  // statement about the code, not something this assertion establishes.
  assert.equal(readFileSync(external, "utf8"), readFileSync(signalFile(directory), "utf8"),
    "the extra signal must carry the same payload as the owned one");

  const marker = JSON.parse(readFileSync(markerFile(directory), "utf8"));
  assert.deepEqual(marker.externalSignals, [external],
    "the exact file path must be recorded, not the directory that contains it");

  // Nothing on disk authorises the deletion: the operator names the directory on the command. Run
  // once without it and the file survives, while the operator is told what to pass.
  const withoutFlag = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root } });
  assert.equal(existsSync(external), true, "without --signal-directory the external file must survive");
  assert.deepEqual(withoutFlag.externalSignalDirectories, [foreign],
    "and the operator must be told which directory to name");

  // The follow-up run must still work even though the runtime directory has now been removed -
  // otherwise the hint just printed would be impossible to act on.
  const withFlag = uninstall({
    options: { workerId: WORKER_ID, runtimeRoot: root, signalDirectory: foreign },
  });
  assert.ok(withFlag.removed.includes(external), "naming the directory must remove the file");
  assert.equal(existsSync(external), false);
  assert.equal(existsSync(foreign), true, "the foreign directory must survive");
  assert.equal(existsSync(operatorFile), true, "another process's file must survive");
});

test("a foreign file at the external signal path is refused, not overwritten", async (t) => {
  const root = scratch(t);
  const signals = join(root, "signals");
  mkdirSync(signals, { recursive: true });
  const target = join(signals, `${workerSlug(WORKER_ID)}.signal`);
  writeFileSync(target, "someone else's data\n", "utf8");

  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl, signalDirectory: signals });
  await assert.rejects(() => runTick({ options, now: CLOCK }),
    /worker_inbox_platform_signal_file_not_owned/u,
    "a matching filename is not evidence of ownership, so this must refuse rather than overwrite");
  assert.equal(readFileSync(target, "utf8"), "someone else's data\n", "the foreign file must be untouched");

  // The refusal must not be so broad that it rejects this tool's own previous signal.
  writeJsonAtomic(target, { version: RUNTIME_VERSION, workerId: WORKER_ID, at: CLOCK().toISOString() });
  const result = await runTick({ options, now: CLOCK });
  assert.equal(result.notified, true, "our own signal is still updated in place");
  assert.equal(JSON.parse(readFileSync(target, "utf8")).workerId, WORKER_ID);
});

test("the watcher does not delete lookalike files in the operator's signal directory", async (t) => {
  const root = scratch(t);
  const signals = join(root, "signals");
  mkdirSync(signals, { recursive: true });
  const lookalike = join(signals, `${workerSlug(WORKER_ID)}.signal.999999.tmp`);
  writeFileSync(lookalike, "not ours\n", "utf8");

  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl, signalDirectory: signals });
  await runTick({ options, now: CLOCK });

  assert.equal(existsSync(lookalike), true,
    "this directory belongs to the operator: only files the tool records are ever removed there");
});

test("a symlink at the external signal path is refused whatever it points at", async (t) => {
  const root = scratch(t);
  const signals = join(root, "signals");
  mkdirSync(signals, { recursive: true });
  // The target deliberately holds a signal that would pass the content check, so the refusal cannot
  // be passing merely because the contents look foreign.
  const target = join(root, "elsewhere.signal");
  writeJsonAtomic(target, { version: RUNTIME_VERSION, workerId: WORKER_ID, at: CLOCK().toISOString() });
  const link = join(signals, `${workerSlug(WORKER_ID)}.signal`);
  symlinkSync(target, link);

  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl, signalDirectory: signals });
  await assert.rejects(() => runTick({ options, now: CLOCK }),
    /worker_inbox_platform_signal_path_is_symlink/u,
    "a symlink is not evidence of ownership, even when its target parses as our own signal");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the symlink must be left alone");
  assert.equal(existsSync(target), true, "and the file it points at must be untouched");
});

test("a dangling symlink at the external signal path is refused too", async (t) => {
  const root = scratch(t);
  const signals = join(root, "signals");
  mkdirSync(signals, { recursive: true });
  symlinkSync(join(root, "does-not-exist"), join(signals, `${workerSlug(WORKER_ID)}.signal`));

  const options = tickOptions(root, { fetchImpl: fakeGithub(assignment()).fetchImpl, signalDirectory: signals });
  await assert.rejects(() => runTick({ options, now: CLOCK }),
    /worker_inbox_platform_signal_path_is_symlink/u,
    "existsSync would follow the link and miss this, which is why the check uses lstat");
});

test("a hand-edited marker cannot authorise the deletion of any file", (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  ensureWorkerDirectory(directory, { workerId: WORKER_ID });

  // This file matches the tool's own naming exactly, so a basename check alone would call it ours.
  // Nothing readable off disk may authorise its removal - only the operator's own command can.
  const elsewhere = join(root, "not-ours");
  mkdirSync(elsewhere, { recursive: true });
  const lookalike = join(elsewhere, `${workerSlug(WORKER_ID)}.signal`);
  writeFileSync(lookalike, "someone else's file\n", "utf8");

  const marker = JSON.parse(readFileSync(markerFile(directory), "utf8"));
  marker.externalSignals = [lookalike, "/etc/hosts", 42];
  writeFileSync(markerFile(directory), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  const result = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root } });
  assert.equal(existsSync(lookalike), true, "recorded state must not authorise a deletion");
  assert.equal(existsSync("/etc/hosts"), true);
  assert.ok(!result.removed.includes(lookalike), "and it must not be reported as removed either");
  assert.deepEqual(result.externalSignalDirectories, [elsewhere],
    "the marker may only point the operator at a directory they decide to name");
});

test("a symlinked artifact directory cannot smuggle writes outside the owned directory", (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  const outside = join(root, "outside-artifacts");
  mkdirSync(outside, { recursive: true });
  mkdirSync(directory, { recursive: true });
  // generated/ points somewhere else entirely. A lexical check accepts this happily - the string
  // path really is inside the runtime directory - while the bytes land outside the boundary.
  symlinkSync(outside, join(directory, "generated"));

  assert.throws(
    () => generate({
      options: {
        workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, platform: "launchd",
      },
      scriptPath: "script.mjs", nodePath: "node",
    }),
    /worker_inbox_platform_out_directory_symlinked/u,
    "a symlinked generated directory must be refused, not written through",
  );
  assert.deepEqual(readdirSync(outside), [], "nothing may be written outside the owned directory");
});

test("a symlink that stays inside the runtime directory is refused too", (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  const staging = join(directory, "staging");
  mkdirSync(staging, { recursive: true });
  // This one resolves INSIDE the runtime directory, so a realpath containment check accepts it - but
  // uninstall removes the generated/ link itself and would leave these artifacts behind, owned by
  // nothing. Refusing the link is what keeps the ownership model true.
  symlinkSync(staging, join(directory, "generated"));

  assert.throws(
    () => generate({
      options: {
        workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, platform: "launchd",
      },
      scriptPath: "script.mjs", nodePath: "node",
    }),
    /worker_inbox_platform_out_directory_symlinked/u,
  );
  assert.deepEqual(readdirSync(staging), [], "no artifacts may be written through the link");
});

test("a failed atomic write cleans up its temporary file instead of leaving it unowned", (t) => {
  const root = scratch(t);
  // The target is a directory, so the rename fails after the temporary file has been written.
  const target = join(root, "a-directory");
  mkdirSync(target, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;

  assert.throws(() => writeJsonAtomic(target, { hello: "world" }));
  assert.equal(existsSync(temporary), false,
    "a temporary file left behind is not an owned entry, so uninstall could never remove it");
});

test("the external signal is recorded before it is written, so a failed write cannot orphan it", async (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  // An existing but unwritable directory: lstat on the signal path finds nothing, so the failure
  // happens at the write - after the recording, which is the ordering under test. (A file where a
  // directory is needed used to be the mechanism, but that now fails at lstat instead, before the
  // recording, and would have stopped testing the ordering at all.)
  const signals = join(root, "signals");
  mkdirSync(signals, { recursive: true });
  chmodSync(signals, 0o500);
  try {
    const options = tickOptions(root, {
      fetchImpl: fakeGithub(assignment()).fetchImpl, signalDirectory: signals,
    });
    await assert.rejects(() => runTick({ options, now: CLOCK }));
  } finally {
    chmodSync(signals, 0o700);
  }

  const marker = JSON.parse(readFileSync(markerFile(directory), "utf8"));
  assert.deepEqual(marker.externalSignals, [join(signals, `${workerSlug(WORKER_ID)}.signal`)],
    "recording must happen first: a recorded path that does not exist is harmless, an unrecorded file is an orphan");
});

test("a nested field whose key order differs between reads is not a change", () => {
  // The fingerprint serialises whatever fields the accepted client reports, so it must not be
  // sensitive to the order keys happen to be written in. If a future field nests an object
  // whose key order is not guaranteed, two reads of unchanged data would otherwise look
  // different and the operator would be notified on every tick - the opposite failure to the
  // one this package was just fixed for, and just as bad.
  const ordered = [{ issue: 199, state: "attention", detail: { alpha: 1, beta: { x: 1, y: 2 } } }];
  const reordered = [{ issue: 199, state: "attention", detail: { beta: { y: 2, x: 1 }, alpha: 1 } }];
  assert.equal(actionsFingerprint(ordered).fingerprint, actionsFingerprint(reordered).fingerprint,
    "key order alone must never count as a change");

  const changed = [{ issue: 199, state: "attention", detail: { alpha: 9, beta: { x: 1, y: 2 } } }];
  assert.notEqual(actionsFingerprint(ordered).fingerprint, actionsFingerprint(changed).fingerprint,
    "a real value change must still be detected");
});

test("a controller claim needs no action label, as the troubleshooting table states", async (t) => {
  // The README tells operators what makes an issue actionable, so pin that claim rather than
  // leaving it as prose. An accepted controller claim is actionable with only a status label,
  // and the client fetches every open issue instead of filtering by an action label. If either
  // changes, the documented troubleshooting advice silently becomes wrong again - which is
  // exactly what happened once, and cost a review round to catch.
  const number = 199;
  const github = fakeGithub({
    issues: [githubIssue(number, ["status:working"])],
    comments: { [number]: [claimComment({ number })] },
  });
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.equal(actions.length, 1, "an accepted claim without an action label must be actionable");
  assert.equal(actions[0].trust, "controller-record");
  assert.equal(actions[0].state, "working");
  assert.ok(!github.calls[0].url.includes("labels="),
    "the client must fetch all open issues, not only action-labelled ones");
});

test("a legacy action marker is advisory and never an actionable assignment", async (t) => {
  // The troubleshooting row lists what makes an issue actionable, and this clause was wrong
  // twice before it was pinned. A legacy action marker is NOT one of those paths: the client
  // treats an advisory record as needing attention even when its status label matches exactly,
  // so no amount of labelling turns it into an actionable controller assignment.
  const github = fakeGithub(assignment());
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.equal(actions.length, 1, "an advisory record is still reported, just not as actionable");
  assert.equal(actions[0].trust, "advisory");
  assert.equal(actions[0].disposition, "attention",
    "an advisory record must never be reported as an actionable assignment");
});

test("a handoff needs one matching action label while a claim does not", async (t) => {
  // Two halves of the same rule, deliberately in one test so they cannot drift apart again: the
  // action label is required for a handoff and not for a claim. This is the clause the previous
  // two documentation attempts each got wrong in a different way.
  const number = 199;
  const withLabel = fakeGithub(controllerAssignment({ state: "changes-required" }));
  const complete = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: withLabel.fetchImpl,
  });
  assert.equal(complete[0].disposition, "action", "a handoff carrying its action label is actionable");

  const withoutLabel = fakeGithub({
    issues: [githubIssue(number, ["status:changes-required"])],
    comments: { [number]: [controllerComment(handoffMarker({ number, state: "changes-required" }))] },
  });
  const missing = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: withoutLabel.fetchImpl,
  });
  assert.equal(missing.length, 1, "the issue is still fetched without any action label");
  assert.equal(missing[0].disposition, "attention",
    "a handoff missing its action label is not actionable");

  const claimed = fakeGithub({
    issues: [githubIssue(number, ["status:working"])],
    comments: { [number]: [claimComment({ number })] },
  });
  const claim = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: claimed.fetchImpl,
  });
  assert.equal(claim[0].disposition, "action", "a claim is actionable without any action label");
});

test("two labels of the same kind make an issue ambiguous, not actionable", async (t) => {
  // The row tells operators that conflicting labels produce an attention result. Pin it, since
  // "an operator adds a label" is exactly the wrong turn this advice is meant to prevent.
  const number = 199;
  const github = fakeGithub({
    issues: [githubIssue(number, ["status:changes-required", "status:working", "action:worker"])],
    comments: { [number]: [controllerComment(handoffMarker({ number, state: "changes-required" }))] },
  });
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].disposition, "attention",
    "two status labels must not be reported as an actionable assignment");
});

test("the client renders a Record line and the watcher console does not", async (t) => {
  // The troubleshooting row tells an operator to run the inbox client and read its Record: line,
  // and warns that the watcher does not print it. A row that prescribes a diagnostic the
  // recommended command cannot produce is accurate but useless, so both halves are pinned: the
  // accepted client renders the line, and the watcher's own console text must never be mistaken
  // for it.
  const github = fakeGithub(assignment());
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.match(renderWorkerInbox(WORKER_ID, actions), /^Record: /mu,
    "the accepted client must render a Record line for the row's instruction to be followable");

  const root = scratch(t);
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  const first = await runTick({ options, now: CLOCK });
  assert.equal(first.change, "baseline-action");
  // A second tick on the same runtime is unchanged, which takes the other console branch.
  const second = await runTick({ options, now: CLOCK });
  assert.equal(second.change, "unchanged");

  // Both branches, because the notification and the quiet bookkeeping line are built by different
  // paths and either could leak the Record line. Asserting on the tick result instead of the
  // console line proved nothing: it never exercised this function at all.
  for (const tick of [first, second]) {
    const emitted = consoleDecision({
      result: tick, options: { once: true, json: false }, lastReported: undefined,
    });
    assert.equal(emitted.print, true, "each tick must emit a console line for this to prove anything");
    assert.ok(!/Record:/u.test(emitted.line),
      `the console line for a ${tick.change} tick must not be mistaken for a Record line`);
  }
});

test("the accepted inbox client is reused rather than reimplemented", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment());
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.equal(actions.length, 1);
  // The accepted client's contract decides every field; the watcher neither recreates nor
  // reinterprets it. A legacy action marker is advisory under the current contract, so the
  // broad disposition sits in `state` and the requested state is carried separately.
  assert.equal(actions[0].state, "attention");
  assert.equal(actions[0].markerState, "changes-required");
  assert.equal(actions[0].trust, "advisory");

  // The watcher passes every read through that same client: breaking its contract surfaces
  // here rather than being silently absorbed.
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });
  const result = await runTick({ options, now: CLOCK });
  // Notifications report the requested state rather than the bare disposition, so the operator
  // is told a correction was requested instead of the uninformative word "attention".
  assert.deepEqual(result.observed.states, [`${actions[0].issue}:changes-required`]);
  assert.deepEqual(result.observed.issues, [actions[0].issue]);
});

test("a change hidden behind an unchanged disposition is still detected", async (t) => {
  // The accepted client collapses several genuinely different situations into state
  // "attention" and carries what actually changed - the requested state, trust, disposition,
  // head, and pull request - in other fields. An earlier version of this package fingerprinted
  // only {issue, state, instruction}, so it reported "unchanged" while the assignment had in
  // fact changed. Failing to notice a change is the single failure this watcher must not have,
  // so this test asserts the disposition really is identical on both sides.
  const root = scratch(t);
  const github = fakeGithub(assignment({ state: "changes-required" }));
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  assert.equal((await runTick({ options, now: CLOCK })).change, "baseline-action");

  const before = await readWorkerInbox({ workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl });
  Object.assign(github.holder, assignment({ state: "working" }));
  const after = await readWorkerInbox({ workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl });

  assert.equal(before[0].state, "attention");
  assert.equal(after[0].state, "attention",
    "both sides must share the disposition, otherwise this test would prove nothing");
  assert.notEqual(before[0].markerState, after[0].markerState, "the requested state is what differs");

  const second = await runTick({ options, now: CLOCK });
  assert.equal(second.change, "action-changed",
    "a change the client reports only through non-disposition fields must still be detected");
  assert.deepEqual(second.observed.states, ["199:working"]);
});

test("a new head on an unchanged request is still reported", async (t) => {
  // The requested state can stay identical while the thing that changed is the revision the
  // controller points at. Fingerprinting state alone would call this "unchanged", and the
  // operator would never learn that a new revision is waiting for them.
  const root = scratch(t);
  const github = fakeGithub(controllerAssignment({ state: "re-review", head: "aaaa1111" }));
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  assert.equal((await runTick({ options, now: CLOCK })).change, "baseline-action");

  const before = await readWorkerInbox({ workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl });
  Object.assign(github.holder, controllerAssignment({ state: "re-review", head: "bbbb2222" }));
  const after = await readWorkerInbox({ workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl });
  assert.equal(before[0].state, after[0].state, "the state must be unchanged for this test to mean anything");
  assert.notEqual(before[0].head, after[0].head, "the head is what changed");

  const changed = await runTick({ options, now: CLOCK });
  assert.equal(changed.change, "action-changed",
    "a change carried only in a non-state field must still be detected");
  assert.deepEqual(changed.observed.states, ["199:re-review"]);
});

test("an authoritative controller record is reported at its declared state", async (t) => {
  // Controller records own authority under the current contract; a legacy advisory marker does
  // not. The package must work against the authoritative path, not only the advisory one.
  const root = scratch(t);
  const github = fakeGithub(controllerAssignment({ state: "changes-required" }));
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].trust, "controller-record");
  assert.equal(actions[0].state, "changes-required");

  const options = tickOptions(root, { fetchImpl: github.fetchImpl });
  const result = await runTick({ options, now: CLOCK });
  assert.equal(result.change, "baseline-action");
  assert.deepEqual(result.observed.states, ["199:changes-required"]);
});

// The README says deduplication is about notifications rather than requests. Pin it: an unchanged
// tick must cost exactly the same GitHub reads as a changed one, so no page can claim otherwise.
test("an unchanged tick costs the same GitHub reads as a changed tick", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment());
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });

  const before = github.calls.length;
  const first = await runTick({ options, now: CLOCK });
  const changedReads = github.calls.length - before;

  const midway = github.calls.length;
  const second = await runTick({ options, now: CLOCK });
  const unchangedReads = github.calls.length - midway;

  assert.equal(first.change, "baseline-action");
  assert.equal(second.change, "unchanged");
  assert.ok(changedReads > 0, "a changed tick reads GitHub");
  assert.equal(
    unchangedReads, changedReads,
    "an unchanged tick must cost the same reads: the fingerprint dedupes notifications, not requests",
  );
});

// The docs tell operators that a `--token-from-gh` failure is loud rather than a silent fallback to
// anonymous requests. Pin both halves: the exit status, and that no request is made at all.
test("a token gh cannot supply fails loudly instead of going anonymous", async (t) => {
  const root = scratch(t);
  let reads = 0;
  const reader = async () => { reads += 1; return []; };
  const runCommand = () => ({ status: 127, stdout: "", stderr: "", error: new Error("spawnSync gh ENOENT") });

  assert.throws(
    () => resolveToken({ environment: {}, tokenFromGh: true, runCommand }),
    error => error.message === "worker_inbox_platform_gh_token_unavailable",
  );

  const code = await watchMain(
    ["--once", "--worker-id", WORKER_ID, "--runtime-root", root, "--token-from-gh"],
    { reader, environment: {}, runCommand, now: CLOCK },
  );

  assert.equal(code, EXIT_CONFIG, "an unusable gh is a configuration failure, not a transient one");
  assert.equal(reads, 0, "it must not fall back to anonymous requests after failing to resolve a token");
});

// A process killed between the atomic write and its rename leaves a temporary file behind. It is not
// a named entry, so before this was handled uninstall preserved it and the runtime directory could
// never be removed at all.
test("a temporary file left by a killed process does not make the runtime directory unremovable", (t) => {
  const root = scratch(t);
  const directory = workerDirectory({ workerId: WORKER_ID, runtimeRoot: root });
  ensureWorkerDirectory(directory, { workerId: WORKER_ID });
  const stale = `state.json.${process.pid}.tmp`;
  writeFileSync(join(directory, stale), "{", "utf8");

  const result = uninstall({ options: { workerId: WORKER_ID, runtimeRoot: root } });
  assert.ok(result.removed.includes(stale), "the tool's own temporary file must be treated as owned");
  assert.deepEqual(result.preserved, [], "and must not be reported as a preserved foreign file");
  assert.equal(existsSync(directory), false, "so the runtime directory can still be cleaned up");
});

// Uninstall only removes the extra signal when the operator names its directory, so the command the
// generated instructions print has to carry the flag - otherwise an operator following them to the
// letter leaves the file behind and is never told why.
test("the generated uninstall command names the signal directory when one was configured", () => {
  const base = {
    platform: "launchd", workerId: WORKER_ID, artifactDirectory: "/tmp/artifacts",
    runtimeDirectory: "/tmp/runtime", repository: REPOSITORY_NAME,
  };
  const configured = instructionsFor({ ...base, signalDirectory: "/tmp/signals" });
  assert.match(configured,
    /worker-inbox-uninstall\.mjs --worker-id \S+ --signal-directory "\/tmp\/signals"/u,
    "the printed uninstall command must carry the flag that makes the removal happen");
  const plain = instructionsFor(base);
  assert.doesNotMatch(plain, /--signal-directory/u,
    "and must not invent a flag for an install that has no extra signal");
});

// Portable scheduling follow-up: what lands on disk must be byte-exact,
// encoding-consistent, and repeatable on every platform — the importer
// evidence starts from bytes, not from strings in memory.
test("emitted artifacts are byte-exact UTF-8 with a matching declaration and no BOM", (t) => {
  const root = scratch(t);
  const generated = generate({
    options: {
      workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, all: true,
      workingDirectory: root, intervalSeconds: 1800,
    },
    scriptPath: join(root, "scripts", "worker-inbox-watch.mjs"),
    nodePath: join(root, "bin", "node"),
    now: CLOCK,
  });
  assert.ok(generated.written.length >= 4, "launchd + systemd pair + windows task");
  for (const artifact of generated.written) {
    const bytes = readFileSync(artifact.path);
    // written[].content is the emitted string the generator handed to the
    // writer: the bytes on disk must equal it exactly, so a changed,
    // truncated, or replaced payload fails here instead of passing.
    assert.deepEqual(bytes, Buffer.from(artifact.content, "utf8"), `${artifact.name} on-disk bytes must equal its content`);
    assert.equal(bytes.length, artifact.bytes, "the reported byte count must be the on-disk size");
    assert.equal(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, false,
      `${artifact.name} must not carry a BOM the declaration does not announce`);
    assert.equal(bytes.includes(0x0D), false, `${artifact.name} must use LF line endings, not CRLF`);
  }
  const byName = Object.fromEntries(generated.written.map((entry) => [entry.name, entry.content]));
  const plist = byName[`${generated.written.find((entry) => entry.name.endsWith(".plist")).name}`];
  const task = byName[`${generated.written.find((entry) => entry.name.endsWith(".xml")).name}`];
  assert.match(plist, /<\?xml version="1\.0" encoding="UTF-8"\?>/u, "plist declaration must match its UTF-8 bytes");
  assert.match(task, /<\?xml version="1\.0" encoding="UTF-8"\?>/u, "task declaration must match its UTF-8 bytes");
  assert.ok(isWellFormedXml(plist) && isWellFormedXml(task));
});

test("an explicit 1800-second schedule lands in all three definitions", (t) => {
  const root = scratch(t);
  const generated = generate({
    options: {
      workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeRoot: root, all: true,
      workingDirectory: root, intervalSeconds: 1800,
    },
    scriptPath: join(root, "scripts", "worker-inbox-watch.mjs"),
    nodePath: join(root, "bin", "node"),
    now: CLOCK,
  });
  const read = (suffix) => readFileSync(
    generated.written.find((entry) => entry.name.endsWith(suffix)).path, "utf8");
  assert.match(read(".plist"), /<key>StartInterval<\/key>\s*<integer>1800<\/integer>/u);
  assert.match(read(".timer"), /OnUnitActiveSec=1800s/u);
  assert.match(read(".xml"), /<Interval>PT30M<\/Interval>/u);
});

test("repeated generation with the same clock is byte-identical", (t) => {
  const root = scratch(t);
  const base = {
    workerId: WORKER_ID, repository: REPOSITORY_NAME, platform: "windows",
    runtimeRoot: root, workingDirectory: root, intervalSeconds: 1800,
  };
  const invoke = () => generate({
    options: { ...base }, scriptPath: join(root, "watch.mjs"),
    nodePath: join(root, "node"), now: CLOCK,
  });
  const before = Buffer.from(readFileSync(invoke().written[0].path));
  // startBoundary embeds the clock, so a fixed clock must yield identical bytes:
  // an operator re-running the generator sees no phantom diff.
  assert.deepEqual(Buffer.from(readFileSync(invoke().written[0].path)), before);
});

test("unicode, spaces, and metacharacters survive every platform renderer", (t) => {
  const root = scratch(t);
  const awkward = join(root, "tâches & 50% ünïcode \"quoted\"");
  const nodePath = join(awkward, "bin", "node");
  const scriptPath = join(awkward, "watch.mjs");
  for (const platform of ["launchd", "systemd", "windows"]) {
    const artifacts = artifactsFor({
      platform, workerId: WORKER_ID, repository: REPOSITORY_NAME, runtimeDirectory: awkward,
      nodePath, scriptPath, workingDirectory: awkward, intervalSeconds: 1800,
      standardOut: join(awkward, "out.log"), standardError: join(awkward, "err.log"),
    });
    for (const artifact of artifacts) {
      const bytes = Buffer.from(artifact.content, "utf8");
      assert.deepEqual(Buffer.from(bytes.toString("utf8"), "utf8"), bytes, `${artifact.name} must round-trip as UTF-8`);
      if (/\.(?:xml|plist)$/u.test(artifact.name)) {
        assert.ok(isWellFormedXml(artifact.content), `${artifact.name} must stay well-formed with awkward paths`);
        assert.equal(artifact.content.includes(awkward), false, "raw awkward paths must be escaped, never inline");
      }
    }
    // A renderer that drops a path would still pass the checks above: every
    // rendered artifact must carry the escaped path it was given.
    const joined = artifacts.map((entry) => entry.content).join("\n");
    if (platform === "launchd") {
      assert.ok(joined.includes(`<string>${xmlEscape(scriptPath)}</string>`), "plist must carry the escaped script path");
      assert.ok(joined.includes(`<string>${xmlEscape(awkward)}</string>`), "plist must carry the escaped working directory");
    }
    if (platform === "systemd") {
      assert.ok(joined.includes(systemdQuote(scriptPath)), "service must carry the quoted script path");
      assert.ok(joined.includes("%%"), "systemd must double the % in awkward paths");
    }
    if (platform === "windows") {
      // The task must quote every argument so CreateProcess reconstructs them:
      // re-quote the same values and require the exact rendered sequence.
      const expected = [scriptPath, "--once", "--scheduled", "--worker-id", WORKER_ID, "--repository", REPOSITORY_NAME,
        "--runtime-root", awkward].map(windowCommandLine).join(" ");
      assert.ok(joined.includes(`<Arguments>${xmlEscape(expected)}</Arguments>`),
        "task Arguments must carry the fully quoted command line");
      assert.ok(joined.includes(`<Command>${xmlEscape(nodePath)}</Command>`), "task must carry the escaped node path");
    }
  }
});

test("instructions name the last-run and last-result check on every platform", () => {
  const forPlatform = (platform) => instructionsFor({
    platform, workerId: WORKER_ID, artifactDirectory: "/tmp/a b/c",
    runtimeDirectory: "/tmp/a b/rt", repository: REPOSITORY_NAME,
  });
  assert.match(forPlatform("launchd"), /last exit code/u, "macOS names the last exit code check");
  assert.match(forPlatform("systemd"), /list-timers/u, "systemd names the last/next run check");
  assert.match(forPlatform("systemd"), /status \S+\.service/u, "systemd names the last result check");
  const windows = forPlatform("windows");
  assert.match(windows, /Get-ScheduledTaskInfo/u, "windows names the object-based last-result check");
  assert.match(windows, /LastTaskResult/u, "windows names the last result property");
  assert.match(windows, /-Encoding UTF8/u, "windows names the conversion input encoding explicitly");
  assert.match(windows, /does not diagnose the rejection/u, "windows states what the fixture does not prove");
});
