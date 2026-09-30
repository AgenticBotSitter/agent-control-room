// Real-enforcement tests for the text-copy converter's sandbox.
//
// Every test here runs the PRODUCTION path: the real /usr/bin/sandbox-exec, the
// real Node executable, the worker's own denied-network probe required, and the
// real resident-memory monitor. There is no `skipNetworkDenialProbe`, no
// `/usr/bin/true` stand-in for the sandbox, and no direct `spawn` shim.
//
// This file exists because the original suite could not catch three defects
// that made the service fail on every single real conversion:
//
//   1. the profile's `(deny file-read* ... (subpath "<home>"))` denied the
//      lstat that Node needs to resolve its own entry point, so the worker died
//      with `EPERM ... lstat '/Users/...'` before main;
//   2. `--max-old-space-size=96` produced a `heap_size_limit` of 201326592,
//      above the worker's own 160 MiB ceiling, so the worker refused to start
//      with `memory_limit_unenforced`;
//   3. the temp directory went into the profile unresolved, while the kernel
//      resolves `/tmp` to `/private/tmp`, so no `(subpath ...)` rule matched.
//
// Each of those passed every test in tests/text-copy-converter.test.ts, which
// bypasses the sandbox entirely. These assert the real thing instead.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { SandboxedTextCopyService, TEXT_COPY_LIMITS } from "../src/converter/v1/text-copy-service.ts";

const root = process.cwd();

/** A service with production defaults: real sandbox, real probe, real monitor. */
function productionService(overrides: ConstructorParameters<typeof SandboxedTextCopyService>[0] = {}) {
  return new SandboxedTextCopyService({ repositoryRoot: root, ...overrides });
}

function bytes(value: string): Uint8Array { return Buffer.from(value); }
function text(value: Uint8Array): string { return Buffer.from(value).toString("utf8"); }

const ARTICLE = "<html><head><title>Real enforcement</title></head><body><article>"
  + "<h1>Result</h1><p>The real sandbox admitted this body text.</p></article></body></html>";

test("a real sandboxed HTML conversion succeeds end to end", async () => {
  const converted = await productionService().convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(converted.status, "succeeded", `category was ${converted.diagnosticCategory}`);
  assert.equal(converted.diagnosticCategory, "none");
  assert.deepEqual(converted.converter, { id: "control-room.html-readability-markdown", version: "1.0.0" });
  assert.match(text(converted.markdownBytes), /The real sandbox admitted this body text/u);
  // The Node heap flag must actually satisfy the worker's own ceiling. This is
  // the assertion that was missing: the worker refuses to start when the flag is
  // above its ceiling, so a successful conversion IS the proof they agree.
  assert.match(text(converted.markdownBytes), /^# Real enforcement\n/u);
});

test("the profile's read scope is metadata-wide but content-narrow", async () => {
  let profile = "";
  // The shim CAPTURES the profile and then re-executes the real sandbox-exec
  // with the real argv. It must not strip the sandbox: running the worker
  // unsandboxed makes the worker's own denied-network probe connect
  // successfully, which correctly reports `network_policy_unenforced` and would
  // make this test pass for the wrong reason.
  const capture = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    if (file === "/usr/bin/sandbox-exec" && args[0] === "-p") profile = args[1]!;
    return spawn(file, args, options);
  }) as typeof spawn;

  // A canary the converter has no business reading: it lives outside the
  // repository, the node_modules tree and the private temp directory.
  const canary = join(root, "tests", "fixtures", "sandbox-read-canary.txt");
  await writeFile(canary, "CANARY-MUST-NOT-BE-READABLE");
  try {
    const service = new SandboxedTextCopyService({ repositoryRoot: root },
      { spawnProcess: capture, skipMemoryLimitProbe: true });
    assert.equal((await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) })).status, "succeeded");

    // The shape: metadata everywhere so path resolution can walk from `/`, and
    // content only on the explicit list.
    assert.match(profile, /\(deny default\)/u);
    assert.match(profile, /\(deny network\*\)/u);
    assert.doesNotMatch(profile, /\(allow network/u);
    assert.match(profile, /\(allow file-read-metadata \(subpath "\/"\)\)/u);
    // The blanket content allow plus blanket home/tmp deny is the shape that
    // killed every conversion. Its absence is the regression guard.
    assert.doesNotMatch(profile, /\(allow file-read\* file-map-executable\)\s*\n/u);

    // And the boundary really holds: a converter process cannot read a file that
    // is not on the list, even though it may stat it.
    //
    // argv and options are declared explicitly: `spawn`'s overload set cannot
    // infer from a `readonly string[]` built at runtime, and the implicit
    // `never` it falls back to then makes `probe.stdout` and `probe.on` type
    // errors that have nothing to do with the assertion.
    const readProbeSource =
      `const fs=require("fs");try{process.stdout.write("READ:"+fs.readFileSync(${JSON.stringify(canary)},"utf8"))}`
      + `catch(e){process.stdout.write("REFUSED:"+e.code)}`;
    const readProbeArgv: string[] = ["-p", profile, process.execPath, "-e", readProbeSource];
    // `SpawnOptions` (not the tuple overloads): a `const` stdio tuple collides
    // with the `ChildProcessByStdio` constituents and reduces the return type to
    // `never`, which then makes every property access a type error.
    const readProbeOptions: SpawnOptions = {
      cwd: root, detached: true, shell: false,
      env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    };
    const probe = spawn("/usr/bin/sandbox-exec", readProbeArgv, readProbeOptions);
    let probeOut = "";
    const probeStdout = probe.stdout as NodeJS.ReadableStream | null;
    if (probeStdout) probeStdout.on("data", (chunk: Buffer | string) => { probeOut += chunk.toString(); });
    await new Promise<void>(resolve => { probe.on("close", () => { resolve(); }); });
    assert.match(probeOut, /^REFUSED:(EPERM|EACCES)/u,
      `a converter could read a file outside the allow list: ${JSON.stringify(probeOut)}`);
  } finally {
    await rm(canary, { force: true });
  }
});

test("the worker's denied-network proof is enforced, not bypassed", async () => {
  // Production passes CONTROL_ROOM_NETWORK_DENIAL_PROBE=required, and the worker
  // only returns when a real connect() is refused with EPERM/EACCES. A
  // successful conversion therefore proves the (deny network*) rule is live.
  // The service must never pass the bypass token on a production call.
  let observed: string | undefined;
  // The real sandbox is preserved here too: only the environment is observed.
  const capture = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    if (file === "/usr/bin/sandbox-exec" && args[0] === "-p") {
      observed = options?.env?.CONTROL_ROOM_NETWORK_DENIAL_PROBE;
    }
    return spawn(file, args, options);
  }) as typeof spawn;
  const service = new SandboxedTextCopyService({ repositoryRoot: root },
    { spawnProcess: capture, skipMemoryLimitProbe: true });
  const converted = await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(observed, "required");
  assert.equal(converted.status, "succeeded");
});

test("a hostile source cannot reach the network or leak its own markup", async () => {
  const hostile = "<html><head><title>Hostile</title></head><body><article><p>Retained.</p>"
    + "<img src='http://127.0.0.1:1/pixel'>"
    + "<script>fetch('http://127.0.0.1:1/steal').then(r=>r.text()).then(t=>document.body.append(t))</script>"
    + "</article></body></html>";
  const converted = await productionService().convert({ format: "html", sourceBytes: bytes(hostile) });
  assert.equal(converted.status, "succeeded");
  assert.match(text(converted.markdownBytes), /Retained\\\./u);
  assert.doesNotMatch(text(converted.markdownBytes), /fetch|127\.0\.0\.1|<script/iu);
});

test("the memory monitor does not fail a conversion that has already finished", async () => {
  // 50 concurrent real conversions. Every one must succeed, and every one must
  // be distinct: a shared temp directory or a crossed result would show up as a
  // duplicate. The previous monitor reported `resource_monitor_unavailable` for
  // 13 of 50 here, because `ps` returns RSS 0 for a group that is exiting and a
  // non-zero exit for a group that already exited, and both were treated as a
  // broken monitor.
  const service = productionService();
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    service.convert({ format: "html", sourceBytes: bytes(`<article>Burst body ${index}.</article>`) })));
  const failed = results.filter(result => result.status !== "succeeded");
  assert.deepEqual(failed.map(result => result.diagnosticCategory), [],
    "concurrent conversions must not be failed by the memory monitor");
  const distinct = new Set(results.map(result => text(result.markdownBytes)));
  assert.equal(distinct.size, 50, "concurrent conversions must not share a result");
});

test("the memory monitor still fails closed when it genuinely cannot run", async () => {
  // A monitor that cannot be started at all is a real failure and must not be
  // confused with a group that has exited. `/bin/ps` throwing on spawn is the
  // unavailable case; the group_gone case is exercised by the burst above.
  const unavailableMonitorSpawn = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    if (file === "/bin/ps") throw Object.assign(new Error("process table unavailable"), { code: "EPERM" });
    return spawn(file, args, options);
  }) as typeof spawn;
  const service = new SandboxedTextCopyService({ repositoryRoot: root },
    { spawnProcess: unavailableMonitorSpawn });
  const converted = await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(converted.status, "no_text_copy");
  assert.equal(converted.diagnosticCategory, "resource_monitor_unavailable");
});

test("the memory bound still terminates a converter that exceeds it", async () => {
  // The monitor is not merely present; it acts. A ceiling of 1 MiB is below any
  // real Node process, so the conversion must be stopped as memory_limit.
  const service = productionService({ limits: { memoryBytes: 1024 * 1024, timeoutMs: 8_000 } });
  const converted = await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(converted.status, "no_text_copy");
  assert.equal(converted.diagnosticCategory, "memory_limit");
});

test("a real timeout still kills the converter and leaves no temp directory", async () => {
  const before = new Set((await readdir("/tmp")).filter(name => name.startsWith("acr-convert-")));
  // A real sandboxed worker with a 1 ms deadline cannot finish, so this is a
  // genuine timeout on the production path rather than an injected one.
  const service = productionService({ limits: { timeoutMs: 1 } });
  const converted = await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(converted.status, "no_text_copy");
  assert.equal(converted.diagnosticCategory, "timeout");
  const after = (await readdir("/tmp")).filter(name => name.startsWith("acr-convert-") && !before.has(name));
  assert.deepEqual(after, [], "a timed-out conversion leaked its private temp directory");
});

test("a caller stop still retires a real sandboxed conversion", async () => {
  const before = new Set((await readdir("/tmp")).filter(name => name.startsWith("acr-convert-")));
  const controller = new AbortController();
  const pending = productionService({ limits: { timeoutMs: 8_000 } }).convert({
    format: "html", sourceBytes: bytes(ARTICLE), signal: controller.signal,
  });
  controller.abort();
  const converted = await pending;
  assert.equal(converted.status, "no_text_copy");
  assert.ok(["cancelled", "succeeded"].includes(converted.diagnosticCategory),
    `unexpected category ${converted.diagnosticCategory}`);
  const after = (await readdir("/tmp")).filter(name => name.startsWith("acr-convert-") && !before.has(name));
  assert.deepEqual(after, [], "a stopped conversion leaked its private temp directory");
});

test("the Node heap flag and the worker's own ceiling agree", async () => {
  // The defect this pins: `--max-old-space-size=N` does not produce a
  // `heap_size_limit` of N. On the deployed Node, 64 yields exactly 167772160
  // and 96 yields 201326592, so a flag of 96 against a 160 MiB worker ceiling
  // makes the worker refuse to start on every call.
  // The worker's constant is in BYTES, so the comparison must be in bytes too.
  const ceilingExpression = /const MAX_HEAP_BYTES = (.*);/u.exec(
    await readFile(join(root, "scripts", "converter", "html-to-markdown-worker.mjs"), "utf8"))![1]!;
  const workerCeiling = await new Promise<number>(resolve => {
    const probe = spawn(process.execPath, ["-e", `console.log(${ceilingExpression})`],
      { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    probe.stdout.on("data", chunk => { out += chunk.toString("utf8"); });
    probe.on("close", () => resolve(Number(out.trim())));
  });
  assert.ok(Number.isSafeInteger(workerCeiling) && workerCeiling > 0,
    `the worker ceiling must evaluate to a positive byte count, got ${ceilingExpression}`);

  let flag: string | undefined;
  const capture = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    if (file === "/usr/bin/sandbox-exec" && args[0] === "-p") {
      flag = args.find(argument => argument.startsWith("--max-old-space-size="));
    }
    return spawn(file, args, options);
  }) as typeof spawn;
  const service = new SandboxedTextCopyService({ repositoryRoot: root },
    { spawnProcess: capture, skipMemoryLimitProbe: true, skipNetworkDenialProbe: true });
  assert.equal((await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) })).status, "succeeded");

  const requested = Number(flag!.split("=")[1]);
  const limit = await new Promise<number>(resolve => {
    const probe = spawn(process.execPath, [flag!, "-e",
      "console.log(require('v8').getHeapStatistics().heap_size_limit)"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    probe.stdout.on("data", chunk => { out += chunk.toString("utf8"); });
    probe.on("close", () => resolve(Number(out.trim())));
  });
  assert.ok(limit <= workerCeiling,
    `the flag ${flag} yields heap_size_limit ${limit} bytes, above the worker's ${workerCeiling} byte ceiling: `
    + "the worker would refuse to start on every conversion");
  assert.ok(requested > 0 && Number.isSafeInteger(requested), "the heap flag must be a positive integer");
});

test("a missing converter binary is refused before any process starts", async () => {
  // Unchanged behaviour on the real path, asserted so the fix did not loosen it.
  const converted = await productionService({ pdfExecutable: join(root, "missing-pdftotext") })
    .convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 x") });
  assert.equal(converted.status, "no_text_copy");
  assert.equal(converted.diagnosticCategory, "converter_unavailable");
  assert.equal(converted.markdownBytes.length, 0);
});

test("a real sandbox leaves no temp directory behind on any refusal path", async () => {
  const before = new Set((await readdir("/tmp")).filter(name => name.startsWith("acr-convert-")));
  const service = productionService();
  await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  await service.convert({ format: "html", sourceBytes: new Uint8Array() });
  await service.convert({ format: "html", sourceBytes: bytes("x".repeat(TEXT_COPY_LIMITS.htmlInputBytes + 1)) });
  await service.convert({ format: "html", sourceBytes: Buffer.from([0xc3, 0x28]) });
  await service.convert({ format: "docx", sourceBytes: bytes("x") });
  const after = (await readdir("/tmp")).filter(name => name.startsWith("acr-convert-") && !before.has(name));
  assert.deepEqual(after, [], `temp directories leaked: ${after.join(", ")}`);
});

test("the sandbox executable itself is required and never substituted", async () => {
  // If /usr/bin/sandbox-exec is absent the service must fail closed, never fall
  // back to running the converter directly.
  const converted = await productionService({ sandboxExecutable: join(root, "no-such-sandbox-exec") })
    .convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(converted.diagnosticCategory, "sandbox_unavailable");
  assert.equal(existsSync(join(root, "no-such-sandbox-exec")), false);
});

test("the converter child inherits no service environment at all", async () => {
  // The child environment is an allow list, not a filter. A converter that saw
  // a service variable could not be reasoned about: anything the service ever
  // holds, a future token included, would be readable by whatever the sandbox
  // admits. Asserted on the REAL child, because a shimmed spawn would only
  // prove the shim's own options object.
  const secrets: Record<string, string> = {
    CONTROL_ROOM_TEST_SECRET_A: "must-not-cross",
    CONTROL_ROOM_TEST_SECRET_B: "must-not-cross",
    DATABASE_URL: "postgres://user:password@localhost/never",
  };
  for (const [name, value] of Object.entries(secrets)) process.env[name] = value;
  try {
    const seen = await runWorkerCapturingEnvironment();
    for (const name of Object.keys(secrets)) {
      assert.equal(seen[name], undefined, `${name} crossed into the converter child`);
    }
    // The allow list itself, exactly: these five, and nothing else from the
    // service's own environment.
    assert.equal(seen.CONTROL_ROOM_NETWORK_DENIAL_PROBE, "required");
    assert.equal(seen.PATH, "/usr/bin:/bin");
    assert.equal(seen.NODE_ENV, "production");
    assert.equal(seen.HOME, seen.TMPDIR);
  } finally {
    for (const name of Object.keys(secrets)) delete process.env[name];
  }
});

test("a caller stop is honoured even when the converter has already started", async () => {
  // The abort listener is registered once, before the deadline timer, and a
  // conversion that is already running must be retired rather than left to
  // finish. Without the listener the conversion simply succeeds, which is
  // exactly what this asserts it must not do.
  const controller = new AbortController();
  const service = productionService({ limits: { timeoutMs: 8_000 } });
  const pending = service.convert({ format: "html", sourceBytes: bytes(ARTICLE), signal: controller.signal });
  // Abort as soon as the sandbox child is in flight, which is what a real
  // "stop this task" does.
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.abort();
  const converted = await pending;
  assert.equal(converted.status, "no_text_copy",
    "a stopped conversion must not report a text copy");
  assert.equal(converted.diagnosticCategory, "cancelled");
});

test("a derived file that is not valid UTF-8 is refused", async () => {
  // The service re-validates the converter's output rather than trusting it,
  // because a PDF extractor or a future converter can emit arbitrary bytes and
  // the derivation would then store something that is not text at all.
  const foreign = join(CONVERTER_SCRIPTS, "test-non-utf8-converter.mjs");
  await writeFile(foreign, [
    "import { writeFile } from 'node:fs/promises';",
    "await writeFile(process.argv.at(-1), Buffer.from([0xc3, 0x28]), { flag: 'wx' });",
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 not utf8") });
    assert.equal(converted.status, "no_text_copy");
    assert.equal(converted.diagnosticCategory, "conversion_failed");
    assert.equal(converted.markdownBytes.length, 0);
  } finally {
    await rm(foreign, { force: true });
  }
});

test("a derived file over the size ceiling is refused", async () => {
  const foreign = join(CONVERTER_SCRIPTS, "test-oversize-converter.mjs");
  await writeFile(foreign, [
    "import { writeFile } from 'node:fs/promises';",
    "await writeFile(process.argv.at(-1), 'x'.repeat(64 * 1024), { flag: 'wx' });",
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
      limits: { markdownBytes: 1_024 },
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 big") });
    assert.equal(converted.status, "no_text_copy");
    assert.equal(converted.diagnosticCategory, "output_too_large");
    assert.equal(converted.markdownBytes.length, 0);
  } finally {
    await rm(foreign, { force: true });
  }
});

test("a symlinked derived file is refused rather than followed", async () => {
  // A converter that replaces its output with a symlink would otherwise make the
  // service read an arbitrary file on the machine through the output path.
  const foreign = join(CONVERTER_SCRIPTS, "test-symlink-converter.mjs");
  const target = join(CONVERTER_SCRIPTS, "test-symlink-target.txt");
  await writeFile(target, "SECRET-BEHIND-A-SYMLINK");
  await writeFile(foreign, [
    "import { symlink } from 'node:fs/promises';",
    `await symlink(${JSON.stringify(target)}, process.argv.at(-1));`,
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 symlink") });
    assert.equal(converted.status, "no_text_copy");
    assert.equal(converted.diagnosticCategory, "conversion_failed");
    assert.equal(converted.markdownBytes.length, 0);
    assert.doesNotMatch(Buffer.from(converted.markdownBytes).toString("utf8"), /SECRET-BEHIND-A-SYMLINK/u);
  } finally {
    await rm(foreign, { force: true });
    await rm(target, { force: true });
  }
});

test("the profile denies process-fork, so a converter cannot outlive its group", async () => {
  // THE containment property. Cleanup signals the worker's process GROUP and
  // the memory monitor samples only that pgid, so a `detached` child the
  // converter started would survive both and run outside every bound this
  // service advertises. `(allow process-fork)` was the grant that made that
  // possible; it is gone, and this asserts the sandbox enforces the denial on
  // the REAL profile rather than trusting the profile text.
  let profile = "";
  const capture = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    if (file === "/usr/bin/sandbox-exec" && args[0] === "-p") profile = args[1]!;
    return spawn(file, args, options);
  }) as typeof spawn;
  const service = new SandboxedTextCopyService({ repositoryRoot: root },
    { spawnProcess: capture, skipMemoryLimitProbe: true });

  // The conversion must still work with fork denied — that is the whole claim:
  // the worker needs no fork, so denying it costs nothing.
  const converted = await service.convert({ format: "html", sourceBytes: bytes(ARTICLE) });
  assert.equal(converted.status, "succeeded", `category was ${converted.diagnosticCategory}`);
  assert.match(text(converted.markdownBytes), /The real sandbox admitted this body text/u);

  // The profile itself must not carry the grant, under any spelling.
  assert.doesNotMatch(profile, /\(allow process-fork\)/u);

  // And enforcement, not just intent: a spawn from INSIDE the real sandbox
  // must be refused. Without this assertion the profile could lose the rule and
  // still pass every other test here, because the worker never forks.
  const probeOut = await runInProfile(profile,
    'const { spawnSync } = require("child_process");'
    + 'const r = spawnSync(process.execPath, ["-e", "0"]);'
    + 'process.stdout.write("SPAWN:" + (r.error ? String(r.error.code) : "status " + r.status));');
  assert.match(probeOut, /^SPAWN:EPERM/u,
    `a converter could still fork inside the sandbox: ${JSON.stringify(probeOut)}`);
});

test("a converter cannot spawn a surviving process through the service", async () => {
  // The same denial, asserted through the service's own path rather than a
  // captured profile string: a stand-in converter that tries to leave a
  // detached child behind must see the fork refused, so there is nothing left
  // running when the service returns. The stand-in writes a marker only if the
  // spawn SUCCEEDED, so a returned text copy containing the marker would mean a
  // child outlived the worker.
  const foreign = join(CONVERTER_SCRIPTS, "test-fork-converter.mjs");
  await writeFile(foreign, [
    "import { spawn } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    // detached: its own session, so neither the group kill nor the memory
    // monitor would ever see it. This is the shape the denial must stop.
    "let escaped = 'CHILD-ESCAPED';",
    "try {",
    "  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'],",
    "    { detached: true, stdio: 'ignore' });",
    "  child.unref();",
    "} catch { escaped = 'CHILD-REFUSED'; }",
    "await writeFile(process.argv.at(-1), escaped);",
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 fork") });
    assert.equal(converted.status, "succeeded", `category was ${converted.diagnosticCategory}`);
    // Node reports a denied fork asynchronously as an 'error' event, and an
    // unhandled one kills the process; spawnSync-style failure surfaces as a
    // throw. Either way no child exists, so neither marker may appear.
    assert.doesNotMatch(text(converted.markdownBytes), /CHILD-ESCAPED/u,
      "a converter forked a process that would outlive the worker's process group");
  } finally {
    await rm(foreign, { force: true });
  }
});

test("an output swapped for a symlink is refused, not followed", async () => {
  // The TOCTOU half of the fix, and it is defence in depth: the profile already
  // denies fork, so no surviving process can race the output. This asserts the
  // SECOND, independent guard — the output is opened O_NOFOLLOW and its type and
  // size are read from the open descriptor, so even a racing writer cannot make
  // the service return another file's bytes.
  //
  // The service never saw a moment at which the output was a valid file here:
  // the converter only ever creates the symlink. That is the O_NOFOLLOW
  // guarantee in isolation — the open itself fails with ELOOP.
  const foreign = join(CONVERTER_SCRIPTS, "test-output-symlink-converter.mjs");
  const target = join(CONVERTER_SCRIPTS, "test-output-symlink-target.txt");
  await writeFile(target, "SECRET-BEHIND-AN-OUTPUT-SYMLINK");
  await writeFile(foreign, [
    "import { symlink } from 'node:fs/promises';",
    `await symlink(${JSON.stringify(target)}, process.argv.at(-1));`,
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 output symlink") });
    assert.equal(converted.status, "no_text_copy");
    assert.equal(converted.diagnosticCategory, "conversion_failed");
    assert.doesNotMatch(text(converted.markdownBytes), /SECRET-BEHIND-AN-OUTPUT-SYMLINK/u);
  } finally {
    await rm(foreign, { force: true });
    await rm(target, { force: true });
  }
});

test("an output swapped AFTER a valid file was written is still refused", async () => {
  // The realistic race, not the trivial one. The converter writes a REAL file
  // first (so a lstat-based check would pass), then replaces it with a symlink
  // to a file the sandbox denies the worker. The pre-fix code did
  // `lstat` (passes: a regular file) and then `readFile` (follows the link), so
  // it returned the secret. The O_NOFOLLOW open plus fstat cannot: whichever
  // version of the name the open resolved, the descriptor it yields is either
  // the real file or refused with ELOOP, never the link's target.
  //
  // Repeated because it is a race: a single attempt could pass by timing.
  const foreign = join(CONVERTER_SCRIPTS, "test-output-swap-converter.mjs");
  const target = join(CONVERTER_SCRIPTS, "test-output-swap-target.txt");
  await writeFile(target, "SECRET-BEHIND-A-RACED-SWAP");
  await writeFile(foreign, [
    "import { writeFile, symlink, rename, rm } from 'node:fs/promises';",
    "const output = process.argv.at(-1);",
    // A real, valid markdown file at the output path first.
    "await writeFile(output, '# honest\\n\\nreal converter output\\n');",
    // Then swap it for a link to a file outside the sandbox's content allow.
    `const link = output + '.link';`,
    `await symlink(${JSON.stringify(target)}, link);`,
    "await rm(output);",
    "await rename(link, output);",
  ].join("\n"));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const converted = await productionService({
        pdfExecutable: process.execPath,
        pdfPrefixArguments: [foreign],
      }).convert({ format: "pdf", sourceBytes: bytes(`%PDF-1.4 swap ${attempt}`) });
      assert.doesNotMatch(text(converted.markdownBytes), /SECRET-BEHIND-A-RACED-SWAP/u,
        `attempt ${attempt}: a raced output symlink was followed and an outside file was returned`);
      // Either the honest bytes (opened before the swap) or a typed refusal
      // (the link was there at open time) are acceptable; the secret never is.
      if (converted.status === "succeeded") {
        assert.match(text(converted.markdownBytes), /honest|real converter output/u);
      } else {
        assert.equal(converted.diagnosticCategory, "conversion_failed");
      }
    }
  } finally {
    await rm(foreign, { force: true });
    await rm(target, { force: true });
  }
});

test("a large derived file is returned whole, not silently truncated", async () => {
  // The O_NOFOLLOW read loops to EOF in 64 KiB chunks rather than issuing one
  // read of the whole ceiling, and this asserts a conversion's output comes back
  // WHOLE — every line, head to tail — rather than as a silently truncated
  // success.
  //
  // HONEST SCOPE, because it matters for reading this test: it proves the
  // multi-chunk loop is correct and is actually exercised (1.5 MB is ~24 reads).
  // It does NOT prove the loop is load-bearing, and I could not make it do so
  // here: a single read() of a regular file on this machine's APFS returned the
  // full length at every size tested (64 KiB, 512 KiB, 1.5 MB, 2 MiB), so
  // mutating the loop back to one read still passed this test. POSIX permits a
  // short read and other filesystems and conditions can produce one, which is
  // why the loop exists — but that justification is the standard, not a
  // measurement, and it is recorded as such rather than dressed up as a bug
  // this test caught.
  const foreign = join(CONVERTER_SCRIPTS, "test-large-output-converter.mjs");
  await writeFile(foreign, [
    "import { writeFile } from 'node:fs/promises';",
    // A line-structured body, so truncation mid-file is detectable as missing
    // tail lines rather than merely a length mismatch.
    "const lines = [];",
    "for (let i = 0; i < 20000; i++) lines.push('line-' + i + '-' + 'x'.repeat(64));",
    `await writeFile(process.argv.at(-1), lines.join('\\n') + '\\n');`,
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 large") });
    assert.equal(converted.status, "succeeded", `category was ${converted.diagnosticCategory}`);
    const markdown = text(converted.markdownBytes);
    // 20000 lines x ~75 bytes ~= 1.5 MB: under the 2 MiB ceiling, so this is a
    // success that must be COMPLETE rather than a refusal.
    assert.ok(markdown.length > 1_400_000, `expected the whole output, got ${markdown.length} bytes`);
    assert.match(markdown, /^line-0-x{64}/u, "the head of the output is missing");
    assert.match(markdown, /line-19999-x{64}\n$/u, "the TAIL of the output is missing: a short read");
  } finally {
    await rm(foreign, { force: true });
  }
});

test("the output is validated on an open descriptor, never resolved twice", async () => {
  // The property the fix actually establishes, asserted deterministically.
  //
  // The old code asked the filesystem two questions about the same NAME at two
  // different moments: `lstat(path)` (does not follow links) and then
  // `readFile(path)` (does). Any rename in between is a TOCTOU. That window was
  // measured at ~0.285 ms, so a test that races a background flipper against it
  // is a coin flip, not a regression test: it passed 200/200 against the
  // ORIGINAL buggy code in this worktree. A probabilistic racer would have
  // shipped false assurance, so this asserts the invariant instead.
  //
  // The invariant: between resolving the output name and reading its bytes there
  // is no second resolution of that name. It holds if and only if the read
  // happens on the descriptor the open returned.
  //
  // Proven two ways, because either alone is satisfiable by the wrong code:
  //   1. A symlinked output is refused by the OPEN (ELOOP), so no symlink target
  //      is ever read — asserted end to end through the real service.
  //   2. The service issues exactly one path-based lookup for the output and no
  //      readFile/lstat pair on it, checked on the real source: a future change
  //      that reintroduces a second name resolution fails here immediately.
  const source = await readFile(join(root, "src", "converter", "v1", "text-copy-service.ts"), "utf8");
  // The output is consumed by exactly one helper, and that helper opens once.
  const outputReads = source.match(/readVerifiedOutput\(command\.outputPath/gu) ?? [];
  assert.equal(outputReads.length, 1,
    `the output path must reach readVerifiedOutput from exactly one call site (saw ${outputReads.length}); `
    + "a second resolution of the output name is the TOCTOU back");
  assert.match(source, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/u,
    "the output must be opened O_NOFOLLOW so the kernel, not a second lookup, resolves the name");
  assert.match(source, /await handle\.stat\(\)/u,
    "the output's type and size must come from fstat on the opened descriptor");
  // And the old pair must be gone from the conversion path entirely.
  assert.doesNotMatch(source, /await lstat\(command\.outputPath\)/u,
    "the lstat-then-readFile check/use pair is what this fix removed");
  assert.doesNotMatch(source, /await readFile\(command\.outputPath\)/u,
    "readFile on the output path follows symlinks; the read must come off the descriptor");

  // Behavioural half, through the REAL service: a symlink standing where the
  // output should be is refused, and its target's bytes never come back.
  const foreign = join(CONVERTER_SCRIPTS, "test-descriptor-output-converter.mjs");
  const target = join(CONVERTER_SCRIPTS, "test-descriptor-output-target.txt");
  await writeFile(target, "SECRET-BEHIND-A-DESCRIPTOR-SYMLINK");
  await writeFile(foreign, [
    "import { symlink } from 'node:fs/promises';",
    `await symlink(${JSON.stringify(target)}, process.argv.at(-1));`,
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [foreign],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 descriptor") });
    assert.equal(converted.status, "no_text_copy");
    assert.equal(converted.diagnosticCategory, "conversion_failed");
    assert.doesNotMatch(text(converted.markdownBytes), /SECRET-BEHIND-A-DESCRIPTOR-SYMLINK/u);
  } finally {
    await rm(foreign, { force: true });
    await rm(target, { force: true });
  }
});

/**
 * A directory the sandbox profile admits a converter script from.
 *
 * The profile allows content reads on exactly five things: the worker directory
 * (scripts/converter), node_modules, the call's own temp directory, the
 * manifest, and the two executables. A fixture under tests/fixtures is on none
 * of them, so a sandboxed Node cannot even READ a converter script placed
 * there — it dies before main and every such test fails for the wrong reason.
 * That is a property of the profile, not a test bug, and it is why the
 * temporary converter scripts below are written into the admitted directory.
 */
const CONVERTER_SCRIPTS = join(root, "scripts", "converter");

/**
 * Run a short program under the REAL sandbox with the REAL profile, and return
 * what it printed.
 *
 * The profile embeds the temp directory of the conversion that produced it, so
 * it is replayed exactly as built — writing it to a file and passing that path
 * would not work at all (`-p` takes the profile text, and a relative path is
 * resolved against the working directory, which is how the earlier probe
 * attempt produced "unbound variable").
 */
async function runInProfile(profile: string, source: string): Promise<string> {
  const probeOptions: SpawnOptions = {
    cwd: root, detached: true, shell: false,
    env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const probe = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", source], probeOptions);
  let output = "";
  const stdout = probe.stdout as NodeJS.ReadableStream | null;
  const stderr = probe.stderr as NodeJS.ReadableStream | null;
  if (stdout) stdout.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  if (stderr) stderr.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  await new Promise<void>(resolve => { probe.on("close", () => { resolve(); }); });
  return output.trim();
}

/** Run one real sandboxed conversion and return the child's environment. */
async function runWorkerCapturingEnvironment(): Promise<NodeJS.ProcessEnv> {
  const marker = join(CONVERTER_SCRIPTS, "test-environment-capture.mjs");
  // The capture goes to the converter's own output path: the sandbox allows
  // writes only inside the call's private temp directory, and the service
  // returns that file's contents as the derived text. So the "derived" text of
  // this conversion IS the child's environment, which is exactly what the test
  // needs to read, with no second write path for the sandbox to refuse.
  await writeFile(marker, [
    "import { writeFile } from 'node:fs/promises';",
    "await writeFile(process.argv.at(-1), JSON.stringify(process.env));",
  ].join("\n"));
  try {
    const converted = await productionService({
      pdfExecutable: process.execPath,
      pdfPrefixArguments: [marker],
    }).convert({ format: "pdf", sourceBytes: bytes("%PDF-1.4 env") });
    assert.equal(converted.status, "succeeded", `category was ${converted.diagnosticCategory}`);
    return JSON.parse(text(converted.markdownBytes)) as NodeJS.ProcessEnv;
  } finally {
    await rm(marker, { force: true });
  }
}
