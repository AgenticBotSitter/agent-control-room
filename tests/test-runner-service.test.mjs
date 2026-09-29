import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTestRunnerService, readOrCreateToken } from "../scripts/test-runner/service.mjs";

const REAL_PG_BIN = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"]
  .find(candidate => candidate && existsSync(join(candidate, "initdb")) && existsSync(join(candidate, "postgres")));

async function eventually(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true");
}

const DATABASE_SCRIPT = "node --test tests/database.test.mjs";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "acr-test-runner-test-"));
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const resolvedOverrides = typeof overrides === "function" ? overrides(await realpath(root)) : overrides;
  const config = {
    schema: "control-room.test-runner/v1",
    port: 0,
    configPath: join(privateDirectory, "config.json"),
    tokenFile: join(privateDirectory, "token"),
    auditLog: join(privateDirectory, "audit.jsonl"),
    allowedWorktreePrefixes: [join(await realpath(root), "worktree-")],
    protectedReadPrefixes: [],
    allowedScripts: { "test:database": DATABASE_SCRIPT },
    pgBin: dirname(process.execPath),
    nodeBin: process.execPath,
    portPool: { start: 28100, end: 28139, blockSize: 10 },
    concurrency: 2,
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    ...resolvedOverrides,
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
    await writeFile(join(worktree, "tests", "database.test.mjs"),
      'import test from "node:test"; test("database placeholder", () => {});\n');
    await writeFile(join(worktree, "package.json"), JSON.stringify({
      type: "module",
      scripts: { "test:database": DATABASE_SCRIPT, "test:everything": "node ignored" },
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

test("client waits past several seconds for a long-running command with no timeout of its own", async t => {
  const f = await fixture(t, { timeoutMs: 8_000 });
  const worktree = await f.makeWorktree("slow-client", {
    "tests/slow.test.mjs": `import test from "node:test"; test("slow", () => new Promise(resolve => setTimeout(resolve, 3000)));`,
  });
  const configPath = join(f.root, "slow-client-config.json");
  await writeFile(configPath, JSON.stringify({ ...f.config, port: f.address.port }));
  const client = join(process.cwd(), "scripts/test-runner/client.mjs");
  const startedAt = Date.now();
  const result = await new Promise(resolveResult => {
    const child = spawn(process.execPath, [client, "--config", configPath, "--worktree", worktree,
      "--file", "tests/slow.test.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("close", code => resolveResult({ code, stdout, stderr }));
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(elapsedMs >= 3_000, `expected the client to wait for the full run, only waited ${elapsedMs}ms`);
});

test("sandbox guard blocks writes outside the worktree and this run's temp directory", async t => {
  const f = await fixture(t);
  const target = join(f.root, "escape-write.txt");
  const worktree = await f.makeWorktree("sandbox-write", {
    "tests/escape.test.mjs": `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import test from "node:test";
      test("attempt to write outside the worktree", () => {
        assert.throws(() => writeFileSync(${JSON.stringify(target)}, "PWNED"));
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/escape.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
  await assert.rejects(stat(target));
});

test("sandbox guard blocks reading the private token file", async t => {
  const f = await fixture(t);
  const worktree = await f.makeWorktree("sandbox-read", {
    "tests/read.test.mjs": `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import test from "node:test";
      test("attempt to read the runner's own token file", () => {
        assert.throws(() => readFileSync(${JSON.stringify(f.config.tokenFile)}, "utf8"));
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/read.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
});

test("sandbox guard blocks a connection to a port outside this run's assigned block", async t => {
  const f = await fixture(t);
  const blocker = createServer(socket => socket.destroy());
  await new Promise(resolveReady => blocker.listen(0, "127.0.0.1", resolveReady));
  const blockedPort = blocker.address().port;
  t.after(() => new Promise(resolveClosed => blocker.close(resolveClosed)));
  const worktree = await f.makeWorktree("sandbox-network", {
    "tests/network.test.mjs": `
      import assert from "node:assert/strict";
      import { connect } from "node:net";
      import test from "node:test";
      test("attempt to reach a port outside the assigned block", async () => {
        await assert.rejects(new Promise((resolveResult, reject) => {
          const socket = connect(${blockedPort}, "127.0.0.1");
          socket.once("connect", () => { socket.destroy(); resolveResult(); });
          socket.once("error", reject);
        }));
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/network.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
});

test("sandbox guard still allows reading inside the worktree when a protected prefix is one of its ancestors", async t => {
  // Seatbelt takes the LAST matching rule. A protected prefix that happens to
  // be an ancestor of the worktree (here, the fixture's own root, which is
  // also every worktree's parent) must not silently deny reads under the
  // worktree too — the profile must restore worktree/temp reads after every
  // deny, regardless of such overlap.
  const f = await fixture(t, root => ({ protectedReadPrefixes: [root] }));
  const worktree = await f.makeWorktree("ancestor-overlap", {
    "tests/read-self.test.mjs": `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import test from "node:test";
      test("read a file inside the worktree", () => {
        const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        assert.ok(text.length > 0);
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/read-self.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
});

test("pinned script guard refuses a worktree package.json that diverges from the configured exact command", async t => {
  const f = await fixture(t);
  const worktree = await f.makeWorktree("pin-mismatch");
  await writeFile(join(worktree, "package.json"), JSON.stringify({
    type: "module",
    scripts: { "test:database": `${DATABASE_SCRIPT} --extra-flag` },
  }));
  const result = await f.call({ worktree, script: "test:database" });
  assert.deepEqual(result, { status: 403, body: { error: "command_refused" } });
});

test("pinned script mode runs the exact configured node argv directly, without pnpm", async t => {
  const f = await fixture(t);
  const worktree = await f.makeWorktree("script-happy");
  const result = await f.call({ worktree, script: "test:database" });
  assert.equal(result.status, 200);
  assert.equal(result.body.exitCode, 0, result.body.logExcerpt);
  assert.equal(result.body.command, DATABASE_SCRIPT);
});

test("bounded pipe guard settles within timeoutMs plus grace even when a detached grandchild under TMPDIR holds the output pipe", async t => {
  // node's own `--test` runner does not exit on its own while a detached child
  // still holds its inherited stdout/stderr pipe open, so the fix under test
  // is not "the run finishes quickly" (it cannot, on its own) — it is that our
  // own timeout forcibly ends it well within timeoutMs + STOP_GRACE_MS rather
  // than the old `close`-based wait, which would have run out the clock on the
  // grandchild's full (here much longer) lifetime instead.
  const f = await fixture(t, { timeoutMs: 1_500 });
  const worktree = await f.makeWorktree("pipe-hold", {
    "tests/pipe-hold.test.mjs": `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import test from "node:test";
      test("spawn a detached grandchild under this run's tmp dir that inherits stdio", () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"],
          { detached: true, stdio: "inherit", cwd: process.env.TMPDIR });
        writeFileSync("grandchild.pid", String(child.pid));
        child.unref();
      });
    `,
  });
  const startedAt = Date.now();
  const result = await f.call({ worktree, file: "tests/pipe-hold.test.mjs" });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 200);
  assert.equal(result.body.timedOut, true, result.body.logExcerpt);
  assert.ok(elapsedMs < 3_000, `expected the run to settle within timeoutMs + grace, took ${elapsedMs}ms`);
  const pid = Number(await readFile(join(worktree, "grandchild.pid"), "utf8"));
  await eventually(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  }, 3_000);
});

test("server aborts a run and frees its slot when the client disconnects before it finishes", async t => {
  const f = await fixture(t, { timeoutMs: 10_000 });
  const worktree = await f.makeWorktree("disconnect", {
    "tests/hold.test.mjs": `import test from "node:test"; test("hold", () => new Promise(resolve => setTimeout(resolve, 6000)));`,
  });
  const controller = new AbortController();
  const requestPromise = fetch(`http://127.0.0.1:${f.address.port}/v1/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ worktree, file: "tests/hold.test.mjs" }),
    signal: controller.signal,
  }).catch(() => {});
  await eventually(() => f.service.activeRuns.size === 1);
  controller.abort();
  await requestPromise;
  await eventually(() => f.service.activeRuns.size === 0, 3_000);
});

test("ownership guard reaps a real pg_ctl-started postmaster on timeout, even though setsid removes it from the run's process group", { skip: REAL_PG_BIN ? false : "needs PostgreSQL 17 binaries" }, async t => {
  const f = await fixture(t, { pgBin: REAL_PG_BIN, timeoutMs: 6_000 });
  const worktree = await f.makeWorktree("pgctl-timeout", {
    "tests/pgctl-hang.test.mjs": `
      import { spawnSync } from "node:child_process";
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import { join, dirname } from "node:path";
      import { fileURLToPath } from "node:url";
      import test from "node:test";

      const pgBin = process.env.PG_BIN;
      const tmp = process.env.TMPDIR;
      const dataDirectory = join(tmp, "pgctl-hang-data");
      const socketDirectory = join(tmp, "pgctl-hang-sock");
      const port = process.env.CONTROL_ROOM_PG_TEST_PORT_BASE;
      const marker = join(dirname(fileURLToPath(import.meta.url)), "..", "pgctl-hang-marker.json");
      mkdirSync(dataDirectory, { recursive: true });
      mkdirSync(socketDirectory, { recursive: true });

      test("start a real cluster with pg_ctl (setsid) and hang", async () => {
        const init = spawnSync(join(pgBin, "initdb"), ["-D", dataDirectory, "-U", "postgres", "-A", "trust", "--no-sync"], { stdio: "ignore" });
        if (init.status !== 0) throw new Error("initdb failed");
        const start = spawnSync(join(pgBin, "pg_ctl"), ["-D", dataDirectory, "-l", join(dataDirectory, "log"), "-w", "-t", "30", "-o",
          \`-k \${socketDirectory} -p \${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20\`, "start"],
          { stdio: "ignore" });
        if (start.status !== 0) throw new Error("pg_ctl start failed");
        const pid = Number(readFileSync(join(dataDirectory, "postmaster.pid"), "utf8").split("\\n")[0]);
        writeFileSync(marker, JSON.stringify({ pid }));
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      });
    `,
  });
  const result = await f.call({ worktree, file: "tests/pgctl-hang.test.mjs" });
  assert.equal(result.status, 200);
  assert.equal(result.body.timedOut, true, result.body.logExcerpt);
  const marker = JSON.parse(await readFile(join(worktree, "pgctl-hang-marker.json"), "utf8"));
  await eventually(() => {
    try { process.kill(marker.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  }, 8_000);
});
