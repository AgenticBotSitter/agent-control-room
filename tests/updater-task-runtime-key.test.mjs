import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureFirstOwnerStateV1, readFirstOwnerStateV1, FIRST_OWNER_STATE_V1 }
  from "../src/updater/v1/pg/first-owner-state.mjs";
import { createMacLocalTaskRuntimeFileV1, loadMacLocalTaskRuntimeFromRootV1, MAC_LOCAL_TASK_RUNTIME_V1,
  MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1 } from "../src/web/v1/mac-local-task-runtime.ts";

const hermes = { profile: "cr", provider: "opencode-go", model: "test-model", destination: "https://models.example.invalid:443" };
const refusal = /first_owner_state_refused/u;
const taskRefusal = /mac_local_task_runtime_invalid/u;
const stateValue = () => ({ schema: FIRST_OWNER_STATE_V1, createdAt: "2026-10-01T00:00:00.000Z",
  reviewKey: Buffer.alloc(32, 99).toString("base64url") });
const uid = process.getuid();
const statWithUid = (entry, ownerUid) => Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, { uid: ownerUid });

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "n1b-task-key-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const protectedRoot = join(root, "Protected"), directory = join(root, "updater-state");
  const file = join(directory, "first-owner.json"), taskFile = join(protectedRoot, "config/task-runtime.json");
  await fs.mkdir(join(protectedRoot, "config"), { recursive: true, mode: 0o750 });
  await fs.chmod(protectedRoot, 0o750);
  await fs.chmod(join(protectedRoot, "config"), 0o750);
  await fs.mkdir(directory, { mode: 0o700 });
  const state = stateValue();
  await fs.writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  // Only ownership is virtualised: this lane cannot chown to root. All reads,
  // O_NOFOLLOW, modes, links and concurrent publication use the real filesystem.
  const rootStat = entry => statWithUid(entry, 0);
  const runtime = { ...fs, randomBytes, pid: process.pid,
    lstat: async path => rootStat(await fs.lstat(path)),
    firstOwnerStateRuntime: {
      lstat: async path => rootStat(await fs.lstat(path)),
      open: async (...args) => {
        const handle = await fs.open(...args);
        return { stat: async () => rootStat(await handle.stat()),
          readFile: (...values) => handle.readFile(...values), close: () => handle.close() };
      },
    } };
  return { root, protectedRoot, directory, file, taskFile, state, runtime };
}

async function unchangedOnRefusal(f, before) {
  await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), refusal);
  await assert.rejects(fs.lstat(f.taskFile), { code: "ENOENT" });
  if (before !== undefined) assert.equal(await fs.readFile(f.file, "utf8"), before);
}

test("installed task settings reuse the stored review key byte-for-byte, keep other roles independent, and survive retry", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, "utf8");
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), "created");
  const contents = await fs.readFile(f.taskFile, "utf8"), body = JSON.parse(contents);
  assert.equal(body.keys.review, f.state.reviewKey, "regression: old code minted a different review key");
  const loaded = await loadMacLocalTaskRuntimeFromRootV1(f.protectedRoot, f.runtime);
  assert.deepEqual(Buffer.from(loaded.keys.review), Buffer.from(f.state.reviewKey, "base64url"));
  assert.equal(new Set(Object.values(body.keys)).size, 6);
  assert.equal((await fs.stat(f.taskFile)).mode & 0o777, 0o600);
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, { ...hermes, model: "another" }, f.runtime), "existing");
  assert.equal(await fs.readFile(f.taskFile, "utf8"), contents);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("a zero-byte state on an INSTALLED owner is refused, never replaced with a new review key", async t => {
  // m-rvint6 finding 2 (BLOCKING). The atk-fa F12 zero-byte recovery is right for a
  // killed FIRST writer, and wrong for every run after the task runtime adopted the
  // key: replacing the file mints a new key, and the Mac's own
  // `config/task-runtime.json` then fails its equality check on every later run, so
  // every stored plan, run and result is stranded with no way back.
  const f = await fixture(t);
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), "created");
  const adopted = JSON.parse(await fs.readFile(f.taskFile, "utf8")).keys.review;
  assert.equal(adopted, f.state.reviewKey);
  // A crash or an fs-truncate: no attacker needed for this damage.
  await fs.truncate(f.file, 0);
  assert.equal((await fs.lstat(f.file)).size, 0);
  await assert.rejects(ensureFirstOwnerStateV1(f.root), refusal,
    "regression: old code silently minted a new review key here");
  // Nothing was rotated and nothing was rewritten: the damaged file stays damaged and
  // visible, and the task runtime keeps the key it already adopted.
  assert.equal((await fs.lstat(f.file)).size, 0, "the damaged authority is never rewritten");
  assert.equal(JSON.parse(await fs.readFile(f.taskFile, "utf8")).keys.review, adopted);
  const loaded = await loadMacLocalTaskRuntimeFromRootV1(f.protectedRoot, f.runtime);
  assert.deepEqual(Buffer.from(loaded.keys.review), Buffer.from(adopted, "base64url"));
  assert.deepEqual(await fs.readdir(join(f.protectedRoot, "config")), ["task-runtime.json"],
    "no second task settings file is written beside the adopted one");
});

test("the zero-byte first-run recovery still works before anything has adopted the key", async t => {
  // atk-fa F12 must keep working: a zero-byte file left by a killed first writer, on a
  // root with no `Protected/config/task-runtime.json` yet, is still recoverable.
  const f = await fixture(t);
  await fs.rm(f.file);
  await fs.writeFile(f.file, "", { mode: 0o600 });
  const recovered = await ensureFirstOwnerStateV1(f.root);
  assert.match(recovered.reviewKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await fs.lstat(f.file)).size > 0, true);
  // And it is the SAME key on every later run: recovery adopts, never rotates.
  const again = await ensureFirstOwnerStateV1(f.root);
  assert.deepEqual(again, recovered);
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), "created");
  assert.equal(JSON.parse(await fs.readFile(f.taskFile, "utf8")).keys.review, recovered.reviewKey);
});

test("development roots still mint fresh review keys without any installed retry state", async t => {
  const f = await fixture(t), dev = join(f.root, "dev-protected");
  await fs.mkdir(join(dev, "config"), { recursive: true, mode: 0o700 });
  await fs.chmod(dev, 0o700);
  assert.equal(await createMacLocalTaskRuntimeFileV1(dev, hermes), "created");
  const body = JSON.parse(await fs.readFile(join(dev, "config/task-runtime.json"), "utf8"));
  assert.notEqual(body.keys.review, f.state.reviewKey);
});

for (const name of ["missing file", "missing directory", "symlink file", "symlink directory", "file mode", "directory mode",
  "hard link", "directory instead of file", "oversized file"]) {
  test(`installed writer refuses ${name}, creates no task settings and never replaces the state`, async t => {
    const f = await fixture(t);
    if (name === "missing file") await fs.unlink(f.file);
    if (name === "missing directory") await fs.rm(f.directory, { recursive: true });
    if (name === "symlink file") { await fs.rename(f.file, join(f.root, "original")); await fs.symlink(join(f.root, "original"), f.file); }
    if (name === "symlink directory") { await fs.rename(f.directory, join(f.root, "original")); await fs.symlink(join(f.root, "original"), f.directory); }
    if (name === "file mode") await fs.chmod(f.file, 0o640);
    if (name === "directory mode") await fs.chmod(f.directory, 0o750);
    if (name === "hard link") await fs.link(f.file, join(f.root, "alias"));
    if (name === "directory instead of file") { await fs.unlink(f.file); await fs.mkdir(f.file); }
    if (name === "oversized file") await fs.writeFile(f.file, " ".repeat(4097));
    const before = await fs.readFile(f.file, "utf8").catch(() => undefined);
    await unchangedOnRefusal(f, before);
  });
}

for (const [name, change] of [
  ["malformed JSON", () => "{"],
  ["null", () => "null"],
  ["array", () => "[]"],
  ["extra field", value => JSON.stringify({ ...value, extra: true })],
  ["missing field", value => JSON.stringify({ schema: value.schema, reviewKey: value.reviewKey })],
  ["wrong schema", value => JSON.stringify({ ...value, schema: "wrong" })],
  ["bad date format", value => JSON.stringify({ ...value, createdAt: "yesterday" })],
  ["extended year", value => JSON.stringify({ ...value, createdAt: "+010000-10-01T00:00:00.000Z" })],
  ["nonexistent date", value => JSON.stringify({ ...value, createdAt: "2026-02-30T00:00:00.000Z" })],
  ["invalid date", value => JSON.stringify({ ...value, createdAt: "2026-99-01T00:00:00.000Z" })],
  ["short key", value => JSON.stringify({ ...value, reviewKey: Buffer.alloc(16, 8).toString("base64url") })],
  ["noncanonical key", value => JSON.stringify({ ...value, reviewKey: `${value.reviewKey.slice(0, -1)}B` })],
]) {
  test(`shared reader and installed writer refuse ${name}`, async t => {
    const f = await fixture(t), before = change(f.state);
    await fs.writeFile(f.file, before);
    await assert.rejects(readFirstOwnerStateV1(f.root), refusal);
    await unchangedOnRefusal(f, before);
    await assert.rejects(ensureFirstOwnerStateV1(f.root), refusal);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
  });
}

test("the shared reader rejects wrong owners of both file and directory", async t => {
  const f = await fixture(t);
  // Real non-root state cannot be adopted as root-owned state.
  if (uid !== 0) await assert.rejects(readFirstOwnerStateV1(f.root, { ownerUid: 0 }), refusal);
  for (const wrong of ["file", "directory"]) {
    const runtime = { ...f.runtime, firstOwnerStateRuntime: { ...f.runtime.firstOwnerStateRuntime } };
    if (wrong === "directory") runtime.firstOwnerStateRuntime.lstat = async path => statWithUid(await fs.lstat(path), 1);
    else runtime.firstOwnerStateRuntime.open = async (...args) => {
      const handle = await fs.open(...args);
      return { stat: async () => statWithUid(await handle.stat(), 1),
        readFile: (...values) => handle.readFile(...values), close: () => handle.close() };
    };
    await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, runtime), refusal);
  }
  await assert.rejects(fs.lstat(f.taskFile), { code: "ENOENT" });
});

test("installed protected directories must belong to root and permit no group write or other access", async t => {
  const f = await fixture(t);
  if (uid !== 0) await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes), taskRefusal);
  for (const mode of [0o770, 0o751, 0o755]) {
    await fs.chmod(join(f.protectedRoot, "config"), mode);
    await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), taskRefusal);
  }
  await fs.chmod(join(f.protectedRoot, "config"), 0o750);
  const runtime = { ...f.runtime, lstat: async path => statWithUid(await fs.lstat(path), 1) };
  await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, runtime), taskRefusal);
  await assert.rejects(fs.lstat(f.taskFile), { code: "ENOENT" });
});

test("existing task settings with a different review key are refused, preserved and never repaired", async t => {
  const f = await fixture(t);
  const body = { schema: MAC_LOCAL_TASK_RUNTIME_V1, hermes,
    keys: Object.fromEntries(MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1.map((role, index) => [role, Buffer.alloc(32, index + 1).toString("base64url")])) };
  const before = `${JSON.stringify(body)}\n`;
  await fs.writeFile(f.taskFile, before, { mode: 0o600 });
  await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), taskRefusal);
  assert.equal(await fs.readFile(f.taskFile, "utf8"), before);
});

test("existing valid task settings still require the state; no missing-state fallback", async t => {
  const f = await fixture(t);
  await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime);
  const before = await fs.readFile(f.taskFile, "utf8");
  await fs.unlink(f.file);
  await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), refusal);
  assert.equal(await fs.readFile(f.taskFile, "utf8"), before);
  await assert.rejects(fs.lstat(f.file), { code: "ENOENT" });
});

test("50 concurrent installed creators publish one complete file with the stored key, then 50 retries preserve it", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 50 }, () => createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime)));
  assert.equal(results.filter(value => value === "created").length, 1);
  assert.equal(results.filter(value => value === "existing").length, 49);
  const before = await fs.readFile(f.taskFile, "utf8");
  assert.equal(JSON.parse(before).keys.review, f.state.reviewKey);
  const retry = await Promise.all(Array.from({ length: 50 }, () => createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime)));
  assert.ok(retry.every(value => value === "existing"));
  assert.equal(await fs.readFile(f.taskFile, "utf8"), before);
  assert.deepEqual(await fs.readdir(join(f.protectedRoot, "config")), ["task-runtime.json"]);
});

test("a partial temporary write is cleaned up, and retry uses the same first-owner key", async t => {
  const f = await fixture(t);
  const runtime = { ...f.runtime, writeFile: async (path, _body, options) => {
    await fs.writeFile(path, "{", options); throw new Error("injected_write_failure");
  } };
  await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, runtime), /injected_write_failure/u);
  assert.deepEqual(await fs.readdir(join(f.protectedRoot, "config")), []);
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), "created");
  assert.equal(JSON.parse(await fs.readFile(f.taskFile, "utf8")).keys.review, f.state.reviewKey);
});

test("a concurrent winner with another review key is refused even after EEXIST", async t => {
  const f = await fixture(t);
  const runtime = { ...f.runtime, link: async (from, to) => {
    const body = JSON.parse(await fs.readFile(from, "utf8"));
    body.keys.review = Buffer.alloc(32, 44).toString("base64url");
    await fs.writeFile(to, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    await fs.link(from, to);
  } };
  await assert.rejects(createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, runtime), taskRefusal);
  assert.deepEqual(await fs.readdir(join(f.protectedRoot, "config")), ["task-runtime.json"]);
});

test("killing a real creator halfway leaves no published task file; retry adopts the original key", async t => {
  const f = await fixture(t);
  const code = `
    import * as fs from "node:fs/promises";
    import { randomBytes } from "node:crypto";
    import { createMacLocalTaskRuntimeFileV1 } from "./src/web/v1/mac-local-task-runtime.ts";
    const rootStat = stat => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0 });
    const runtime = { ...fs, randomBytes, pid: process.pid,
      lstat: async path => rootStat(await fs.lstat(path)),
      firstOwnerStateRuntime: { lstat: async path => rootStat(await fs.lstat(path)),
        open: async (...args) => {
          const handle = await fs.open(...args);
          return { stat: async () => rootStat(await handle.stat()),
            readFile: (...args) => handle.readFile(...args), close: () => handle.close() };
        } },
      writeFile: async (...args) => {
        await fs.writeFile(...args);
        process.stdout.write("paused\\n");
        await new Promise(() => { setInterval(() => {}, 1000); });
      } };
    await createMacLocalTaskRuntimeFileV1(process.argv[1], ${JSON.stringify(hermes)}, runtime);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.protectedRoot],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let timer;
  try {
    const ready = once(child.stdout, "data");
    await Promise.race([ready.then(([data]) => assert.equal(data.toString(), "paused\n")),
      closed.then(() => { throw new Error("creator_exited_before_pause"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("creator_pause_timeout")), 10_000); })]);
    await assert.rejects(fs.lstat(f.taskFile), { code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await closed;
  }
  assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
  const leftovers = await fs.readdir(join(f.protectedRoot, "config"));
  assert.equal(leftovers.length, 1, "termination leaves only this creator's complete temporary file");
  assert.match(leftovers[0], /task-runtime\.json\.new-/u);
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), "created");
  assert.equal(JSON.parse(await fs.readFile(f.taskFile, "utf8")).keys.review, f.state.reviewKey);
});

test("shared reader refuses invalid roots with a fixed input error", async () => {
  for (const root of [null, "relative", "/", "/x/../y", "/x\0y"]) {
    await assert.rejects(readFirstOwnerStateV1(root), /first_owner_input_refused/u);
    await assert.rejects(ensureFirstOwnerStateV1(root), /first_owner_input_refused/u);
  }
});

test("shared reader closes the descriptor even on malformed content or a dropped read", async t => {
  const f = await fixture(t);
  for (const failRead of [true, false]) {
    let closed = 0;
    const open = async (...args) => {
      const handle = await fs.open(...args);
      return { stat: () => handle.stat(),
        readFile: async () => { if (failRead) throw new Error("dropped_read"); return Buffer.from("{"); },
        close: async () => { closed++; await handle.close(); } };
    };
    await assert.rejects(readFirstOwnerStateV1(f.root, { open }), refusal);
    assert.equal(closed, 1);
  }
});

test("metadata refusals happen before any state bytes are read, and close the descriptor", async t => {
  const f = await fixture(t);
  for (const property of ["kind", "nlink", "mode", "size", "uid"]) {
    let reads = 0, closes = 0;
    const open = async (...args) => {
      const handle = await fs.open(...args);
      return { stat: async () => {
        const stat = await handle.stat();
        if (property === "kind") stat.isFile = () => false;
        if (property === "nlink") stat.nlink = 2;
        if (property === "mode") stat.mode = 0o100644;
        if (property === "size") stat.size = 4097;
        if (property === "uid") stat.uid = uid + 1;
        return stat;
      }, readFile: async () => { reads++; return handle.readFile(); },
      close: async () => { closes++; await handle.close(); } };
    };
    await assert.rejects(readFirstOwnerStateV1(f.root, { open }), refusal);
    assert.equal(reads, 0, property);
    assert.equal(closes, 1, property);
  }
});

test("a non-directory state container is refused before attempting to open any file", async t => {
  const f = await fixture(t);
  let opens = 0;
  const lstat = async path => { const stat = await fs.lstat(path); stat.isDirectory = () => false; return stat; };
  await assert.rejects(readFirstOwnerStateV1(f.root, { lstat, open: async () => { opens++; throw new Error("unexpected_open"); } }), refusal);
  assert.equal(opens, 0);
});

test("first-owner retry creation also refuses an unsafe existing state directory", async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.file, "utf8");
  await fs.chmod(f.directory, 0o750);
  await assert.rejects(ensureFirstOwnerStateV1(f.root), refusal);
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("first-owner creation refuses an unsafe directory before minting any state", async t => {
  const f = await fixture(t);
  await fs.unlink(f.file);
  await fs.chmod(f.directory, 0o750);
  await assert.rejects(ensureFirstOwnerStateV1(f.root), refusal);
  await assert.rejects(fs.lstat(f.file), { code: "ENOENT" });
});

test("state file and directory modes reject special permission bits as well as group access", async t => {
  const f = await fixture(t);
  for (const [path, validMode] of [[f.file, 0o600], [f.directory, 0o700]]) {
    await fs.chmod(path, validMode | 0o1000);
    assert.equal((await fs.stat(path)).mode & 0o7777, validMode | 0o1000);
    await assert.rejects(readFirstOwnerStateV1(f.root), refusal);
    await unchangedOnRefusal(f, await fs.readFile(f.file, "utf8"));
    await fs.chmod(path, validMode);
  }
});

test("shared reader always opens with nonblocking and no-follow flags", async t => {
  const f = await fixture(t);
  const open = async (path, flags) => {
    assert.ok(flags & fsConstants.O_NONBLOCK, "a pipe must never hang the reader");
    assert.ok(flags & fsConstants.O_NOFOLLOW, "a symlink must never be followed");
    return fs.open(path, flags);
  };
  assert.equal((await readFirstOwnerStateV1(f.root, { open })).reviewKey, f.state.reviewKey);
});

test("regression: even private installed directories must reuse first-owner's review key", async t => {
  const f = await fixture(t);
  await fs.chmod(f.protectedRoot, 0o700);
  await fs.chmod(join(f.protectedRoot, "config"), 0o700);
  assert.equal(await createMacLocalTaskRuntimeFileV1(f.protectedRoot, hermes, f.runtime), "created");
  const body = JSON.parse(await fs.readFile(f.taskFile, "utf8"));
  assert.ok(body.keys.review === f.state.reviewKey, "old writer generated a different review key");
});
