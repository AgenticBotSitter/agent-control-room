import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHermes021MacosSubprocessStreamJsonHostV1 } from "../src/harness/hermes-021-v1";

const configuration = { executablePath: "/private/fixture/bin/hermes", profile: "cr", model: "qwen3.8:27b-long", provider: "ollama", workingDirectory: "/private/fixture/work" };
const task = { tenantId: "tenant:fixture", projectId: "project:fixture", jobId: "job:fixture", attemptId: "attempt:fixture",
  runId: "run:fixture", nodeId: "node:fixture", prompt: "Return the approved answer", instructions: "Use no tools", deadline: 120_000 };

function child() {
  const events = new EventEmitter();
  const process = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { return true; } }) as unknown as ChildProcessWithoutNullStreams;
  return { process, cleanup() { process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy(); } };
}

test("local Hermes subprocess host uses fixed argv and a private task file", async t => {
  const fixture = child(); t.after(fixture.cleanup);
  let savedPath = "", savedText = "", removedPath = "";
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const host = createHermes021MacosSubprocessStreamJsonHostV1(configuration, (file, args, options) => {
    assert.equal(file, configuration.executablePath);
    assert.deepEqual(args.slice(0, 6), ["-p", "cr", "chat", "--query-file", "/private/tmp/control-room-hermes-task-fixture/task.txt", "--format"]);
    assert.equal(args.includes("--model"), true); assert.equal(args.at(-3), "qwen3.8:27b-long");
    assert.equal(args.at(-1), "ollama"); assert.equal(options.shell, false); assert.equal(options.cwd, configuration.workingDirectory);
    assert.deepEqual(options.env, { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" });
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    markStarted?.();
    return fixture.process;
  }, async prefix => { assert.equal(prefix.endsWith("/control-room-hermes-task-"), true); return "/private/tmp/control-room-hermes-task-fixture"; },
  async path => { removedPath = path; }, async (path, text, options) => {
    savedPath = path; savedText = text as string; assert.deepEqual(options, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }, () => 1);
  const lines: string[] = [];
  const pending = host.execute({ task, async onLine(line) { lines.push(line); } });
  await started;
  fixture.process.stdout.emit("data", Buffer.from('\n{"type":"progress"}\n{"type":"result"'));
  fixture.process.stdout.emit("data", Buffer.from(',"exit_code":0}\n'));
  fixture.process.emit("close", 0, null);
  await pending;
  assert.equal(savedPath, "/private/tmp/control-room-hermes-task-fixture/task.txt");
  assert.match(savedText, /Return the approved answer/); assert.match(savedText, /Use no tools/);
  assert.match(savedText, /plain-text review/); assert.match(savedText, /Do not call tools/);
  assert.deepEqual(lines, ['{"type":"progress"}', '{"type":"result","exit_code":0}']);
  assert.equal(removedPath, "/private/tmp/control-room-hermes-task-fixture");
});

test("local Hermes subprocess host refuses a late, aborted, or failed child without retaining the task file", async t => {
  for (const mode of ["late", "aborted", "nonzero"] as const) {
    const fixture = child(); t.after(fixture.cleanup); let launched = 0, removed = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const signal = new AbortController(); if (mode === "aborted") signal.abort();
    const host = createHermes021MacosSubprocessStreamJsonHostV1(configuration, () => { launched++; markStarted?.(); return fixture.process; },
      async () => "/private/tmp/control-room-hermes-task-fixture", async () => { removed++; }, async () => {}, () => mode === "late" ? 119_001 : 1);
    const pending = host.execute({ task, signal: signal.signal, async onLine() {} });
    if (mode === "nonzero") { await started; fixture.process.emit("close", 1, null); }
    await assert.rejects(pending, /hermes_021_macos_subprocess_host_unavailable/);
    assert.equal(launched, mode === "nonzero" ? 1 : 0);
    assert.equal(removed, mode === "nonzero" ? 1 : 0);
  }
});

test("an abort after Hermes starts terminates the owned child and removes private task material", async t => {
  const fixture = child(); t.after(fixture.cleanup);
  let removed = 0, kills = 0;
  fixture.process.kill = (() => {
    kills++;
    queueMicrotask(() => fixture.process.emit("close", null, "SIGTERM"));
    return true;
  }) as typeof fixture.process.kill;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const controller = new AbortController();
  const host = createHermes021MacosSubprocessStreamJsonHostV1(configuration, () => {
    markStarted?.(); return fixture.process;
  }, async () => "/private/tmp/control-room-hermes-task-fixture", async () => { removed++; }, async () => {}, () => 1);
  const pending = host.execute({ task, signal: controller.signal, async onLine() {} });
  await started;
  controller.abort();
  await assert.rejects(pending, /hermes_021_macos_subprocess_host_unavailable/);
  assert.equal(kills, 1);
  assert.equal(removed, 1, "the private task directory is removed only after child close");
});

test("local Hermes subprocess host requires owner-pinned absolute executable and work paths", () => {
  assert.throws(() => createHermes021MacosSubprocessStreamJsonHostV1({ ...configuration, executablePath: "hermes" }));
  assert.throws(() => createHermes021MacosSubprocessStreamJsonHostV1({ ...configuration, workingDirectory: "relative-work" }));
  assert.throws(() => createHermes021MacosSubprocessStreamJsonHostV1({ ...configuration, maximumTurns: 2 }));
  assert.throws(() => createHermes021MacosSubprocessStreamJsonHostV1({ ...configuration, maximumRunBudgetSeconds: 121 }));
});
