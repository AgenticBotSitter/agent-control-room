import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateClaudeCodeInstalledProcessHostV1,
  CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
  type PrivateClaudeCodeNativeChildV1 } from "../src/harness/claude-code-v1/private-installed-process-host";
import { createClaudeCodeOwnedProcessSessionV1 } from "../src/harness/claude-code-v1/owned-process-session";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const configuration = {
  schema: "control-room.claude-code-private-installed-process-host-configuration/v1",
  process: { executablePath: "/private/fixture/bin/claude", args: ["--print", "--output-format", "stream-json"],
    workingDirectory: "/private/fixture/work", cleanupMs: 50 },
  executableSha256: digest("1"), workingDirectoryBindingDigest: digest("2"), qualificationDigest: digest("3"),
  startupDeadlineMs: 25, terminateDeadlineMs: 10, killDeadlineMs: 10,
} as const;
const binding = { processAttemptId: "process-attempt:private-1", runId: "run:private-1",
  attemptId: "attempt:private-1", invocationDigest: digest("4") };
const currentAuthority = () => ({ assertCurrent() {} });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function verified() {
  return Object.freeze({ schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1, outcome: "verified" as const,
    executableSha256: configuration.executableSha256,
    workingDirectoryBindingDigest: configuration.workingDirectoryBindingDigest,
    qualificationDigest: configuration.qualificationDigest });
}

function child(options: { exitOn?: "term" | "kill" | "never" } = {}) {
  const exit = deferred<Readonly<{ code: number | null; signal: string | null }>>(), events: string[] = [], writes: Uint8Array[] = [];
  const native: PrivateClaudeCodeNativeChildV1 = {
    writeStdin: async bytes => { events.push("write"); writes.push(Uint8Array.from(bytes)); },
    readStdout: async () => { events.push("read-stdout"); return undefined; },
    readStderr: async () => { events.push("read-stderr"); return undefined; },
    closeStdin: async () => { events.push("close-stdin"); },
    signalTerminate: async () => { events.push("term"); if ((options.exitOn ?? "term") === "term") exit.resolve({ code: null, signal: "SIGTERM" }); },
    signalKill: async () => { events.push("kill"); if (options.exitOn === "kill") exit.resolve({ code: null, signal: "SIGKILL" }); },
    close: async () => { events.push("close"); }, exited: exit.promise,
  };
  return { native, events, writes, exit };
}

test("the private host verifies fixed installation evidence before launch and the session writes exact input once", async () => {
  const fake = child(), events = fake.events;
  const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    async verifyInstallation(request: unknown) { events.push("verify");
      assert.equal((request as { signal: AbortSignal }).signal instanceof AbortSignal, true); return verified(); },
    launch(request: unknown) { events.push("launch");
      assert.deepEqual(Object.keys(request as object).sort(), ["args", "binding", "executablePath", "executableSha256",
        "qualificationDigest", "schema", "workingDirectory", "workingDirectoryBindingDigest"].sort());
      assert.equal("env" in (request as object), false); return fake.native; },
  }, currentAuthority());
  const session = createClaudeCodeOwnedProcessSessionV1({ binding, initialInput: new TextEncoder().encode("one exact input"),
    signal: new AbortController().signal, acquire: host.acquire, cleanupMs: 50 });
  await session.ready;
  assert.deepEqual(events.slice(0, 5), ["verify", "launch", "write", "close-stdin", "read-stdout"]);
  assert.equal(fake.writes.length, 1); assert.equal(new TextDecoder().decode(fake.writes[0]), "one exact input");
  await session.close();
  assert.equal(events.includes("term"), true); assert.equal(events.at(-1), "close");
});

test("abort and deadline actively cancel verification and never permit a late launch", async () => {
  for (const mode of ["abort", "deadline"] as const) {
    let launches = 0, observedSignal: AbortSignal | undefined;
    const gate = deferred<ReturnType<typeof verified>>();
    const host = createPrivateClaudeCodeInstalledProcessHostV1({ ...configuration, startupDeadlineMs: 8 }, {
      verifyInstallation(request: { signal: AbortSignal }) { observedSignal = request.signal; return gate.promise; },
      launch() { launches++; return child().native; },
    }, currentAuthority());
    const controller = new AbortController(), owner = host.acquire({ ...binding, processAttemptId: `process-attempt:${mode}` }, controller.signal);
    if (mode === "abort") controller.abort();
    await assert.rejects(owner.ready, /_refused/);
    if (observedSignal) assert.equal(observedSignal.aborted, true);
    gate.resolve(verified()); await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(launches, 0, "late verification cannot acquire a process");
    await owner.close();
  }
});

test("cleanup escalates TERM to KILL, reaps the child, and reports unreaped ownership as uncertain", async () => {
  const killed = child({ exitOn: "kill" });
  const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    verifyInstallation: async () => verified(), launch: () => killed.native,
  }, currentAuthority());
  const owner = host.acquire({ ...binding, processAttemptId: "process-attempt:kill" }, new AbortController().signal);
  await owner.ready; await owner.close();
  assert.deepEqual(killed.events.filter(event => ["term", "kill", "close"].includes(event)), ["term", "kill", "close"]);

  const hung = child({ exitOn: "never" });
  const uncertainHost = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    verifyInstallation: async () => verified(), launch: () => hung.native,
  }, currentAuthority());
  const uncertainOwner = uncertainHost.acquire({ ...binding, processAttemptId: "process-attempt:hung" }, new AbortController().signal);
  await uncertainOwner.ready;
  await assert.rejects(uncertainOwner.close(), /_uncertain/);
  assert.deepEqual(hung.events.filter(event => ["term", "kill"].includes(event)), ["term", "kill"]);
});

test("configuration and native ports reject accessor/proxy substitution and malformed post-launch custody", async () => {
  const accessorPorts: Record<string, unknown> = { launch() { return child().native; } };
  Object.defineProperty(accessorPorts, "verifyInstallation", { enumerable: true, get() { return async () => verified(); } });
  assert.throws(() => createPrivateClaudeCodeInstalledProcessHostV1(configuration, accessorPorts, currentAuthority()), /_refused/);

  const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    verifyInstallation: async () => verified(), launch: () => ({}) as PrivateClaudeCodeNativeChildV1,
  }, currentAuthority());
  const owner = host.acquire({ ...binding, processAttemptId: "process-attempt:malformed" }, new AbortController().signal);
  await assert.rejects(owner.ready, /_uncertain/);
});

test("the host has no live default, credentials, discovery, service, or network authority", () => {
  const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    verifyInstallation: async () => verified(), launch: () => child().native,
  }, currentAuthority());
  assert.deepEqual({ startsWork: host.startsWork, grantsExecutionAuthority: host.grantsExecutionAuthority,
    permitsRetry: host.permitsRetry, permitsResume: host.permitsResume },
  { startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false });
  assert.deepEqual(Reflect.ownKeys(host.configuration), ["schema", "qualificationDigest"]);
});

test("a synchronous abort inside launch cannot memoize a no-op retirement and leak the returned child", async () => {
  const fake = child();
  const controller = new AbortController();
  const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    verifyInstallation: async () => verified(),
    launch() { controller.abort(); return fake.native; },
  }, currentAuthority());
  const owner = host.acquire({ ...binding, processAttemptId: "process-attempt:launch-abort" }, controller.signal);
  await assert.rejects(owner.ready, /_uncertain/);
  await owner.close();
  assert.deepEqual(fake.events.filter(event => ["term", "kill", "close"].includes(event)), ["term", "close"],
    "the child returned after synchronous cancellation is still terminated, reaped, and closed");
});

test("authority revoked while installation verification is pending is fenced immediately before launch", async () => {
  const gate = deferred<ReturnType<typeof verified>>();
  let current = true, launches = 0, authorityChecks = 0;
  const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    verifyInstallation: () => gate.promise,
    launch() { launches++; return child().native; },
  }, { assertCurrent() { authorityChecks++; if (!current) throw new Error("revoked"); } });
  const owner = host.acquire({ ...binding, processAttemptId: "process-attempt:authority-revoked" }, new AbortController().signal);
  current = false;
  gate.resolve(verified());
  await assert.rejects(owner.ready, /_refused/);
  assert.equal(authorityChecks, 1);
  assert.equal(launches, 0, "revoked authority cannot reach the native launcher");
  await owner.close();
});

test("Proxy-wrapped native ports, children, and authority callables are rejected", async () => {
  const ports = { verifyInstallation: async () => verified(), launch: () => child().native };
  assert.throws(() => createPrivateClaudeCodeInstalledProcessHostV1(configuration,
    new Proxy(ports, {}), currentAuthority()), /_refused/);
  assert.throws(() => createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
    ...ports, launch: new Proxy(ports.launch, {}),
  }, currentAuthority()), /_refused/);
  assert.throws(() => createPrivateClaudeCodeInstalledProcessHostV1(configuration, ports, {
    assertCurrent: new Proxy(() => {}, {}),
  }), /_refused/);

  const hostileChildren = [new Proxy(child().native, {}),
    { ...child().native, close: new Proxy(child().native.close, {}) }];
  for (const [index, launched] of hostileChildren.entries()) {
    const host = createPrivateClaudeCodeInstalledProcessHostV1(configuration, {
      verifyInstallation: async () => verified(), launch: () => launched,
    }, currentAuthority());
    const owner = host.acquire({ ...binding, processAttemptId: `process-attempt:proxy-${index}` },
      new AbortController().signal);
    await assert.rejects(owner.ready, /_uncertain/);
  }
});
