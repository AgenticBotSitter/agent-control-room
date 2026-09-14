// Focused acceptance tests for the local worker inbox watcher package (issue #198).
//
// Disposable: every test uses its own temporary runtime directory, a fake GitHub API, and
// an injected clock. No scheduler is installed, no network call is made, and no credential
// is required. The fake API supplies the issue and comment shapes the accepted inbox client
// reads, so these tests exercise the real reuse path rather than a stand-in for it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readWorkerInbox } from "../scripts/public-worker-inbox.mjs";
import { artifactsFor, iso8601Duration, systemdQuote, xmlEscape } from "../scripts/worker-inbox-platform/lib/artifacts.mjs";
import { instructionsFor } from "../scripts/worker-inbox-platform/lib/instructions.mjs";
import {
  appendBoundedLog, ensureWorkerDirectory, isOwnedDirectory, logFile, readState, removeOwnedFiles,
  signalFile, stateFile, workerDirectory,
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
const REPOSITORY_NAME = "AgenticBotSitter/agent-control-room";
const WORKER_ID = "worker-inbox-test-01";
const CLOCK = () => new Date("2026-09-14T12:00:00Z");

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

  for (let index = 0; index < 40; index++) {
    Object.assign(github.holder, assignment({ state: index % 2 === 0 ? "working" : "changes-required" }));
    await runTick({ options, now: () => new Date(2026, 8, 14, 12, index) });
  }

  const bounded = readFileSync(logFile(workerDirectory({ workerId: WORKER_ID, runtimeRoot: root })), "utf8");
  assert.ok(statSync(logFile(workerDirectory({ workerId: WORKER_ID, runtimeRoot: root }))).size <= 512,
    "the log must stay within its bound");
  assert.match(bounded, /\[log truncated by worker-inbox-platform/u);
  assert.match(bounded, /2026-09-14T18:39:00\.000Z/u, "the newest line must survive truncation");

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
        platform, signalDirectory: join(root, "signals"), out: join(root, "generated", platform),
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

test("the accepted inbox client is reused rather than reimplemented", async (t) => {
  const root = scratch(t);
  const github = fakeGithub(assignment());
  const actions = await readWorkerInbox({
    workerId: WORKER_ID, repository: REPOSITORY_NAME, fetchImpl: github.fetchImpl,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].state, "changes-required");

  // The watcher passes every read through that same client: breaking its contract surfaces
  // here rather than being silently absorbed.
  const options = tickOptions(root, { fetchImpl: github.fetchImpl });
  const result = await runTick({ options, now: CLOCK });
  assert.deepEqual(result.observed.states, [`${actions[0].issue}:${actions[0].state}`]);
  assert.deepEqual(result.observed.issues, [actions[0].issue]);
});
