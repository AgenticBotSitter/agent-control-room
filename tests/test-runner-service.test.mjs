import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTestRunnerService, readOrCreateToken } from "../scripts/test-runner/service.mjs";

async function eventually(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true");
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "acr-test-runner-test-"));
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const config = {
    schema: "control-room.test-runner/v1",
    port: 0,
    tokenFile: join(privateDirectory, "token"),
    auditLog: join(privateDirectory, "audit.jsonl"),
    allowedWorktreePrefixes: [join(await realpath(root), "worktree-")],
    allowedScripts: ["test:database"],
    pnpmBin: process.execPath,
    pgBin: dirname(process.execPath),
    nodeBin: process.execPath,
    portPool: { start: 28100, end: 28139, blockSize: 10 },
    concurrency: 2,
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    ...overrides,
  };
  const service = await createTestRunnerService(config);
  const address = await service.listen();
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  const worktrees = [];
  const makeWorktree = async (name, files = {}) => {
    const worktree = join(root, `worktree-${name}`);
    await mkdir(join(worktree, "tests"), { recursive: true });
    await mkdir(join(worktree, "node_modules", "tsx"), { recursive: true });
    await writeFile(join(worktree, "node_modules", "tsx", "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
    await writeFile(join(worktree, "node_modules", "tsx", "index.mjs"), "// Test-only no-op import hook.\n");
    await writeFile(join(worktree, "package.json"), JSON.stringify({
      type: "module",
      scripts: { "test:database": "node ignored", "test:everything": "node ignored" },
    }));
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(worktree, path)), { recursive: true });
      await writeFile(join(worktree, path), source);
    }
    worktrees.push(worktree);
    return worktree;
  };
  const call = async (body, authorization = `Bearer ${token}`) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, service, address, token, makeWorktree, call, worktrees };
}

test("auth guard refuses missing and incorrect bearer tokens with a loopback-only listener", async t => {
  const f = await fixture(t);
  assert.equal(f.address.address, "127.0.0.1");
  const missing = await fetch(`http://127.0.0.1:${f.address.port}/v1/runs`, { method: "POST", body: "{}" });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: "auth_refused" });
  assert.equal((await f.call({}, "Bearer incorrect")).status, 401);
});

test("private token guard creates mode 0600 and refuses a permissive token file", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-test-runner-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  await mkdir(directory, { mode: 0o700 });
  const tokenFile = join(directory, "token");
  assert.match(await readOrCreateToken(tokenFile), /^[a-f0-9]{64}$/u);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  await writeFile(tokenFile, `${"a".repeat(64)}\n`);
  await chmod(tokenFile, 0o644);
  await assert.rejects(readOrCreateToken(tokenFile), /token_file_not_private/u);
});

test("worktree path guard refuses an allowlisted-looking symlink escape", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(join(outside, "tests"), { recursive: true });
  await writeFile(join(outside, "package.json"), JSON.stringify({ scripts: {} }));
  const escape = join(f.root, "worktree-escape");
  await symlink(outside, escape);
  const result = await f.call({ worktree: escape, file: "tests/x.test.mjs" });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "worktree_refused");
});

test("command allowlist guard refuses unknown scripts, extra arguments, and test-file escapes", async t => {
  const f = await fixture(t);
  const worktree = await f.makeWorktree("commands", { "tests/ok.test.mjs": "import test from 'node:test'; test('ok', () => {});" });
  const unknown = await f.call({ worktree, script: "test:everything" });
  assert.deepEqual(unknown, { status: 403, body: { error: "command_refused" } });
  const flags = await f.call({ worktree, file: "tests/ok.test.mjs", args: ["--inspect"] });
  assert.deepEqual(flags, { status: 400, body: { error: "invalid_request" } });
  const escape = await f.call({ worktree, file: "tests/../outside.test.mjs" });
  assert.deepEqual(escape, { status: 403, body: { error: "command_refused" } });
});

test("fixed environment guard strips caller variables and assigns ports and a short TMPDIR", async t => {
  const previous = process.env.TEST_RUNNER_FORBIDDEN_SECRET;
  process.env.TEST_RUNNER_FORBIDDEN_SECRET = "must-not-cross";
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_RUNNER_FORBIDDEN_SECRET;
    else process.env.TEST_RUNNER_FORBIDDEN_SECRET = previous;
  });
  const f = await fixture(t);
  const worktree = await f.makeWorktree("environment", {
    "tests/environment.test.mjs": `
      import assert from "node:assert/strict";
      import test from "node:test";
      test("environment", () => {
        assert.equal(process.env.TEST_RUNNER_FORBIDDEN_SECRET, undefined);
        assert.match(process.env.PG_BIN, /^\\//);
        assert.match(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE, /^\\d+$/);
        assert.match(process.env.CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE, /^\\d+-\\d+$/);
        assert.match(process.env.TMPDIR, /^\\/tmp\\/acr-tr-/);
        console.log("ENVIRONMENT_GUARD_OK");
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/environment.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
  assert.match(result.body.logExcerpt, /ENVIRONMENT_GUARD_OK/u);
});

test("port lease guard gives overlapping runs disjoint blocks and releases them", async t => {
  const f = await fixture(t, { portPool: { start: 28100, end: 28119, blockSize: 10 } });
  const source = `
    import test from "node:test";
    test("hold", async () => {
      console.log("PORT=" + process.env.CONTROL_ROOM_PG_TEST_PORT_BASE);
      await new Promise(resolve => setTimeout(resolve, 250));
    });
  `;
  const first = await f.makeWorktree("ports-one", { "tests/hold.test.mjs": source });
  const second = await f.makeWorktree("ports-two", { "tests/hold.test.mjs": source });
  const [one, two] = await Promise.all([
    f.call({ worktree: first, file: "tests/hold.test.mjs" }),
    f.call({ worktree: second, file: "tests/hold.test.mjs" }),
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.notEqual(one.body.ports.base, two.body.ports.base);
  assert.ok(one.body.ports.end < two.body.ports.base || two.body.ports.end < one.body.ports.base);
  const again = await f.call({ worktree: first, file: "tests/hold.test.mjs" });
  assert.equal(again.status, 200);
  assert.ok([one.body.ports.base, two.body.ports.base].includes(again.body.ports.base));
});

test("timeout guard kills the complete process group", async t => {
  const f = await fixture(t, { timeoutMs: 150 });
  const worktree = await f.makeWorktree("timeout", {
    "tests/timeout.test.mjs": `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import test from "node:test";
      test("hang", async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync("grandchild.pid", String(child.pid));
        await new Promise(() => {});
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/timeout.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.timedOut, true);
  const pid = Number(await readFile(join(worktree, "grandchild.pid"), "utf8"));
  await eventually(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  });
});

test("concurrency guard refuses work above the configured limit", async t => {
  const f = await fixture(t, { concurrency: 1 });
  const worktree = await f.makeWorktree("concurrency", {
    "tests/hold.test.mjs": `import test from "node:test"; test("hold", () => new Promise(resolve => setTimeout(resolve, 350)));`,
  });
  const first = f.call({ worktree, file: "tests/hold.test.mjs" });
  await eventually(() => f.service.activeRuns.size === 1);
  const refused = await f.call({ worktree, file: "tests/hold.test.mjs" });
  assert.deepEqual(refused, { status: 429, body: { error: "concurrency_limit" } });
  assert.equal((await first).status, 200);

  const simultaneous = await Promise.all([
    f.call({ worktree, file: "tests/hold.test.mjs" }),
    f.call({ worktree, file: "tests/hold.test.mjs" }),
  ]);
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 429]);
});

test("output cap guard bounds the excerpt while retaining TAP results", async t => {
  const f = await fixture(t, { maxOutputBytes: 1_024 });
  const worktree = await f.makeWorktree("output", {
    "tests/output.test.mjs": `
      import test from "node:test";
      test("bounded output", () => console.log("x".repeat(10000)));
    `,
  });
  const result = await f.call({ worktree, file: "tests/output.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
  assert.equal(result.body.outputTruncated, true);
  assert.ok(result.body.outputBytes > 10_000);
  assert.ok(Buffer.byteLength(result.body.logExcerpt) < 1_200);
  assert.equal(result.body.tap.fail, 0);
});

test("happy path returns TAP failures and writes one secret-free audit line", async t => {
  const f = await fixture(t);
  const worktree = await f.makeWorktree("happy", {
    "tests/happy.test.mjs": `
      import assert from "node:assert/strict";
      import test from "node:test";
      test("passing example", () => assert.equal(2 + 2, 4));
    `,
  });
  const result = await f.call({ worktree, file: "tests/happy.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
  assert.equal(result.body.tap.pass, 1);
  assert.equal(result.body.tap.fail, 0);
  const audit = (await readFile(f.config.auditLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].runId, result.body.runId);
  assert.equal(audit[0].command, "node --import tsx --test tests/happy.test.mjs");
  assert.doesNotMatch(JSON.stringify(audit[0]), new RegExp(f.token, "u"));
  assert.equal((await stat(f.config.auditLog)).mode & 0o777, 0o600);
});

test("failing command reports its TAP name and the client exits nonzero", async t => {
  const f = await fixture(t);
  const worktree = await f.makeWorktree("client", {
    "tests/failing.test.mjs": `
      import assert from "node:assert/strict";
      import test from "node:test";
      test("intentional fake failure", () => assert.fail("fixture"));
    `,
  });
  const configPath = join(f.root, "client-config.json");
  await writeFile(configPath, JSON.stringify({ ...f.config, port: f.address.port }));
  const client = join(process.cwd(), "scripts/test-runner/client.mjs");
  const result = await new Promise(resolveResult => {
    const child = spawn(process.execPath, [client, "--config", configPath, "--worktree", worktree,
      "--file", "tests/failing.test.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("close", code => resolveResult({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /1 failed/u);
  assert.match(result.stdout, /intentional fake failure/u);
});
