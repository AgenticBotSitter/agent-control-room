import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureMacLocalTaskRuntimeV1, createMacLocalTaskRuntimeFileV1, loadMacLocalTaskRuntimeFromRootV1,
  MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1, MAC_LOCAL_TASK_RUNTIME_V1 } from "../src/web/v1/mac-local-task-runtime";
import { parsePrepareTaskRuntimeArgumentsV1 } from "../scripts/mac-local/prepare-task-runtime";

const hermes = { profile: "cr", provider: "opencode-go", model: "space-bunny-free", destination: "https://models.example.invalid:443" };

async function protectedRoot(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "acr-task-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await mkdir(join(root, "config"), { mode: 0o700 });
  return root;
}

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const valid = () => ({ schema: MAC_LOCAL_TASK_RUNTIME_V1, hermes: { ...hermes },
  keys: Object.fromEntries(MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1.map((role, index) => [role, key(index + 1)])) });

test("creates a private file once with six distinct 32-byte role keys, then keeps it unchanged", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-runtime.json");
  assert.equal(await createMacLocalTaskRuntimeFileV1(root, hermes), "created");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const first = await readFile(file, "utf8");
  const loaded = await loadMacLocalTaskRuntimeFromRootV1(root);
  assert.deepEqual(Object.keys(loaded.keys).sort(), [...MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1].sort());
  assert.ok(Object.values(loaded.keys).every(value => value.length === 32));
  assert.equal(new Set(Object.values(loaded.keys).map(value => Buffer.from(value).toString("hex"))).size, 6);
  assert.deepEqual(loaded.hermes, hermes);
  assert.equal(await createMacLocalTaskRuntimeFileV1(root, { ...hermes, model: "other-model" }), "existing");
  assert.equal(await readFile(file, "utf8"), first, "an existing file is never regenerated or overwritten");
});

test("an invalid existing file is refused and left in place, never regenerated", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-runtime.json");
  await writeFile(file, "{\"schema\":\"wrong\"}\n", { mode: 0o600 });
  await assert.rejects(createMacLocalTaskRuntimeFileV1(root, hermes), /mac_local_task_runtime_invalid/u);
  assert.equal(await readFile(file, "utf8"), "{\"schema\":\"wrong\"}\n");
});

test("capture refuses shared keys, wrong lengths, non-canonical encodings, and extra or missing fields", () => {
  assert.equal(captureMacLocalTaskRuntimeV1(valid()).keys.review.length, 32);
  const shared = valid(); shared.keys.review = shared.keys.planning;
  const short = valid(); short.keys.results = Buffer.alloc(16, 9).toString("base64url");
  const padded = valid(); padded.keys.harness = `${key(3)}=`;
  const extraKey = { ...valid(), keys: { ...valid().keys, idea: key(40) } };
  const missingKey = valid(); delete (missingKey.keys as Record<string, string>).approvals;
  const extraTop = { ...valid(), comment: "x" };
  const badHermes = { ...valid(), hermes: { ...hermes, model: "has space" } };
  const plainHttp = { ...valid(), hermes: { ...hermes, destination: "http://models.example.invalid:80" } };
  const noPort = { ...valid(), hermes: { ...hermes, destination: "https://models.example.invalid" } };
  const withPath = { ...valid(), hermes: { ...hermes, destination: "https://models.example.invalid:443/v1" } };
  const { destination: _omitted, ...noDestination } = hermes;
  const missingDestination = { ...valid(), hermes: noDestination };
  for (const value of [shared, short, padded, extraKey, missingKey, extraTop, badHermes, plainHttp, noPort, withPath,
    missingDestination, { ...valid(), schema: "v0" }])
    assert.throws(() => captureMacLocalTaskRuntimeV1(value), /mac_local_task_runtime_invalid/u);
});

test("loading refuses a readable-by-others file, a symlink, or a non-private directory, without echoing content", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-runtime.json");
  await writeFile(file, `${JSON.stringify(valid())}\n`, { mode: 0o644 });
  await chmod(file, 0o644);
  await assert.rejects(loadMacLocalTaskRuntimeFromRootV1(root), error => error instanceof Error
    && error.message === "mac_local_task_runtime_invalid");
  await chmod(file, 0o600);
  assert.ok(await loadMacLocalTaskRuntimeFromRootV1(root));

  const other = await protectedRoot(t);
  await symlink(file, join(other, "config/task-runtime.json"));
  await assert.rejects(loadMacLocalTaskRuntimeFromRootV1(other), /mac_local_task_runtime_invalid/u);

  await chmod(join(root, "config"), 0o755);
  await assert.rejects(loadMacLocalTaskRuntimeFromRootV1(root), /mac_local_task_runtime_invalid/u);
  await assert.rejects(createMacLocalTaskRuntimeFileV1(root, hermes), /mac_local_task_runtime_invalid/u);
  await assert.rejects(loadMacLocalTaskRuntimeFromRootV1("relative/root"), /mac_local_task_runtime_invalid/u);
});

test("the prepare command takes exactly its four flags, with or without the pnpm separator", () => {
  const args = ["--protected-root", "/p", "--hermes-profile", "cr", "--hermes-provider", "opencode-go", "--hermes-model", "m",
    "--hermes-destination", "https://models.example.invalid:443"];
  assert.deepEqual(parsePrepareTaskRuntimeArgumentsV1(["--", ...args]),
    { protectedRoot: "/p", hermes: { profile: "cr", provider: "opencode-go", model: "m", destination: "https://models.example.invalid:443" } });
  assert.deepEqual(parsePrepareTaskRuntimeArgumentsV1(args), parsePrepareTaskRuntimeArgumentsV1(["--", ...args]));
  for (const bad of [args.slice(0, 8), [...args, "--extra", "x"], [...args.slice(0, 9), "--"], [...args, "--hermes-model", "n"]])
    assert.throws(() => parsePrepareTaskRuntimeArgumentsV1(bad), /arguments_refused/u);
});

test("the prepare command really runs when its path contains a space, and fails loudly on bad arguments", async t => {
  const outer = await mkdtemp(join(tmpdir(), "acr task runtime "));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const repo = join(outer, "Agent Control Room");
  await symlink(process.cwd(), repo);
  const result = spawnSync(process.execPath, ["--import", "tsx", join(repo, "scripts/mac-local/prepare-task-runtime.ts"), "--unknown", "x"],
    { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mac_local_task_runtime_arguments_refused/u);
});

test("a concurrent creator that wins the race is reported as existing, and no temporary file is left", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-runtime.json");
  const { link, lstat: realLstat, readFile: realRead, writeFile: realWrite, unlink } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const runtime = { lstat: realLstat, readFile: realRead, writeFile: realWrite, unlink, randomBytes, pid: 7,
    link: async (from: string, to: string) => { await writeFile(to, `${JSON.stringify(valid())}\n`, { mode: 0o600 }); return link(from, to); } };
  assert.equal(await createMacLocalTaskRuntimeFileV1(root, hermes, runtime as never), "existing");
  assert.deepEqual(await readdir(join(root, "config")), ["task-runtime.json"], "no temporary file is left behind");
  assert.equal(JSON.parse(await readFile(file, "utf8")).keys.planning, valid().keys.planning);
});
