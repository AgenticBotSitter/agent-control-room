// The result-file byte store on a real filesystem.
//
// These are the store's own refusals, and each one is a case where the
// convenient behaviour is the dangerous one: overwrite instead of conflict,
// follow a symlink instead of refusing, share one file between two projects
// instead of two, and hand back a link twice instead of once.
//
// The store never sees a tenant, a project or a file name except as digest
// input, so the tests below are the only place a path could leak — which is
// why every error assertion checks the CODE and never the message.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultFileStoreV1, ResultFileStoreError, resultFileStorageKeyV1,
  RESULT_FILE_LIMITS_V1, resultFileStoreBootIdentityV1 } from "../src/artifacts/v1/result-file-store";

const TENANT = "tenant:store";
const PROJECT = "project:alpha";
const FILE = `result-file:${"b".repeat(32)}`;
const bytes = (value: string) => new TextEncoder().encode(value);

/** The stamp a live writer leaves in its own lock, written here rather than
 * imported so that a change to the store's format cannot silently rewrite the
 * fixture that is testing it. `boot` is a parameter so a test can stamp a lock
 * as though it were written under a DIFFERENT boot, which is the review's S1.
 *
 * The third line is the WRITER'S OWN start second. Nothing in the store decides
 * on it any more — the kernel lock does — and that is the point: the review's B1
 * was a store that DID decide on it, recorded the second the lock was TAKEN
 * rather than the second the process STARTED, and deleted a live writer's
 * half-written file because the two disagreed. A fixture that gets the stamp
 * right is now decoration, kept because a person reading a leftover on a Mac
 * mini is exactly the reader these lines are for.
 */
function startSecondOfProcessV1(pid: number): number {
  // A pid `ps` will not even look at still needs a third line, so any plausible
  // second will do: nothing in the store reads it.
  let printed = "";
  try {
    printed = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { printed = ""; }
  const at = printed ? Date.parse(printed.replace(/\s+/gu, " ")) : Number.NaN;
  return Number.isFinite(at) ? Math.floor(at / 1000) : Math.floor(Date.now() / 1000);
}
const liveStamp = (pid = process.pid, boot?: string) =>
  `${boot ?? resultFileStoreBootIdentityV1()}\n${pid}\n${startSecondOfProcessV1(pid)}`;
/** `O_EXLOCK`, spelled out because Node does not export it. The store's
 * exclusion is this flag, so a test that wants a GENUINELY held lock has to
 * create one this way; a lock file written with `writeFile` holds nothing. */
const EXLOCK = 0x20;
const heldLockV1 = (path: string) => open(path,
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | EXLOCK | constants.O_NOFOLLOW, 0o600);

/**
 * Waits for a child process, WITHOUT letting the event loop decide the test's
 * lifetime.
 *
 * A `ChildProcess` is not a ref'd handle, so a test that awaits only `once("exit")`
 * gives Node nothing to keep it running. Node then ends the test with "Promise
 * resolution is still pending but the event loop has already resolved" — the
 * review's B2, arriving through the test rather than through the store, and it
 * reads exactly like a hang. The ref'd timer here is what holds the loop open,
 * and the deadline stops a lost child from turning into a stuck lane.
 */
function awaitChildV1(child: ReturnType<typeof spawn>, label: string, ms = 60_000): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const keeper = setTimeout(() => {
      reject(new Error(`child ${label} did not exit within ${ms} ms`));
    }, ms);
    child.once("exit", (code, signal) => { clearTimeout(keeper); resolve(code ?? null); void signal; });
  });
}
const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** A fresh 0700 root and a store opened on it, both removed afterwards. */
async function withStore(t: { after?: (root: string, store: ResultFileStoreV1) => Promise<void> },
  configuration: Partial<Parameters<typeof ResultFileStoreV1.create>[0]> = {}) {
  // The store requires a CANONICAL root, and on macOS `TMPDIR` is a symlinked
  // path (`/var` -> `/private/var`), so the temporary root is resolved first and
  // the store's root is then a real directory under it. Production does the
  // same: the configured path and the opened directory can never differ.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-")));
  const root = join(base, "store");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
    maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
    operationTimeoutMs: 5_000, ...configuration });
  try { await t.after?.(root, store); }
  finally { await rm(base, { recursive: true, force: true }); }
}

const identity = (project = PROJECT, file = FILE, content = bytes("report\n")) =>
  ({ tenantId: TENANT, projectId: project, fileId: file, contentDigest: digest(content) });

test("a stored file comes back byte-for-byte, and an exact retry is idempotent", async () => {
  await withStore({ async after(_root, store) {
    const content = bytes("report body\n");
    const id = identity(PROJECT, FILE, content);
    const written = await store.put({ ...id, bytes: content });
    assert.equal(written.contentDigest, id.contentDigest);
    assert.equal(written.storageKey, resultFileStorageKeyV1(TENANT, PROJECT, FILE, id.contentDigest));
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(content));
    // A retry of the same bytes is a replay, not a conflict and not a second file.
    await store.put({ ...id, bytes: content });
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(content));
  } });
});
test("the same key with different bytes is a conflict, never an overwrite", async () => {
  await withStore({ async after(root, store) {
    // The key is derived from the digest, so "the same key with different
    // bytes" is only reachable when the FILE on disk no longer matches the name
    // it is stored under — a tampered store, a bad restore, or a bug elsewhere.
    // That is exactly when an overwrite would destroy the only evidence, so the
    // store must refuse rather than accept the new bytes.
    const content = bytes("report body\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    const name = `${resultFileStorageKeyV1(TENANT, PROJECT, FILE, id.contentDigest).slice("crbf1-".length)}.crbf`;
    await writeFile(join(root, name), bytes("something else entirely\n"));
    // The write is refused as a conflict, and the file is left as it was found:
    // a create-once store never repairs and never overwrites.
    await assert.rejects(store.put({ ...id, bytes: content }),
      (error: unknown) => error instanceof ResultFileStoreError
        && (error.code === "store_conflict" || error.code === "store_ambiguous"));
    // A read of the altered file is a REFUSAL, not a miss: the file is there and
    // its bytes are not the ones the name claims, which is a different fact from
    // "nothing was ever stored" and must read differently in a log.
    await assert.rejects(store.read(id),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
    // And a digest that does not match the bytes handed is refused outright,
    // before any file is opened.
    await assert.rejects(store.put({ ...id, bytes: bytes("different\n") }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_invalid");
    assert.equal((await readdir(root)).filter(entry => entry.endsWith(".crbf")).length, 1,
      "the refused writes created nothing");
  } });
});

test("two projects with identical bytes are two files, and neither reads the other", async () => {
  await withStore({ async after(root, store) {
    const content = bytes("identical bytes\n");
    const inA = identity("project:alpha", FILE, content);
    const inB = identity("project:beta", FILE, content);
    assert.notEqual(inA.contentDigest === inB.contentDigest, false, "the digests match: the same bytes");
    await store.put({ ...inA, bytes: content });
    // Reading project B's key before it is written finds nothing, which is the
    // whole point: there is no cross-project "already have it" answer.
    assert.equal(await store.read(inB), undefined);
    await store.put({ ...inB, bytes: content });
    assert.deepEqual(Buffer.from((await store.read(inA))!), Buffer.from(content));
    assert.deepEqual(Buffer.from((await store.read(inB))!), Buffer.from(content));
    // Two files on disk, because the key is project-scoped and never deduped.
    assert.equal((await readdir(root)).filter(name => name.endsWith(".crbf")).length, 2);
    // And the keys differ, which is what the catalog's uniqueness is built on.
    assert.notEqual(resultFileStorageKeyV1(TENANT, "project:alpha", FILE, inA.contentDigest),
      resultFileStorageKeyV1(TENANT, "project:beta", FILE, inB.contentDigest));
  } });
});

test("a symlinked or hard-linked entry is refused, never followed", async () => {
  // Each case is built so that ONLY the link rule can be the reason for the
  // refusal. A symlink whose target holds the right bytes would be served by a
  // store that followed it, so the refusal below is that store's behaviour and
  // not the unaccounted-entry guard's — which is why the name still matches the
  // content-digest pattern and nothing else is left in the root.
  await withStore({ async after(root, store) {
    const content = bytes("real bytes\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    const name = `${resultFileStorageKeyV1(TENANT, PROJECT, FILE, id.contentDigest).slice("crbf1-".length)}.crbf`;
    // The link target lives OUTSIDE the root, so nothing unaccounted is inside
    // it, and it holds exactly the bytes the name claims.
    const outside = join(root, "..", "outside.bin");
    await writeFile(outside, content);
    await rm(join(root, name));
    await symlink(outside, join(root, name));
    await assert.rejects(store.read(id),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous",
      "a symlink is not followed, even when its target holds the right bytes");
    // A hard link is refused. `O_NOFOLLOW` cannot help here — a hard link is an
    // ordinary file with a second name, not a symlink — so this is the case that
    // proves the store re-checks the file it opened rather than trusting the
    // path it asked for.
    //
    // The file is written DIRECTLY rather than through `put`, so the only thing
    // that ever made it suspicious is the second name. Going through `put` would
    // leave a lock file behind and the refusal would be the unaccounted-entry
    // guard's, which is a different property already proved above.
    await rm(outside);
    await rm(join(root, name));
    await writeFile(join(root, name), content, { mode: 0o600 });
    await link(join(root, name), outside);
    const listed = await lstat(join(root, name), { bigint: true });
    assert.equal(listed.nlink, BigInt(2), "the fixture really is a hard link");
    assert.equal(Number(listed.mode & BigInt(0o777)) & 0o077, 0,
      "and it is still a private-mode file, so the mode check is not what refuses it");
    await assert.rejects(store.read(id),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous",
      "a hard link is never served");
  } });
});

test("a root that is not private, canonical or a directory is refused", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-bad-")));
  try {
    const open = (rootPath: string) => ResultFileStoreV1.create({ rootPath, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // A world-readable root would let another account read the bytes.
    const loose = join(base, "loose");
    await mkdir(loose, { recursive: true, mode: 0o755 });
    await assert.rejects(open(loose), (error: unknown) =>
      error instanceof ResultFileStoreError && error.code === "store_invalid");
    // A relative or un-normalised path is refused rather than repaired.
    for (const rootPath of ["relative/path", `${base}/a/../b`, `${base}/a//b`, "/", "C:\\"])
      await assert.rejects(open(rootPath), (error: unknown) =>
        error instanceof ResultFileStoreError && error.code === "store_invalid");
    // A path that does not exist is refused: the store creates nothing.
    await assert.rejects(open(join(base, "absent")), (error: unknown) =>
      error instanceof ResultFileStoreError && error.code === "store_invalid");
    // A file is not a root.
    const file = join(base, "file");
    await writeFile(file, "x");
    await assert.rejects(open(file), (error: unknown) =>
      error instanceof ResultFileStoreError && error.code === "store_invalid");
    // And the private root IS accepted, so the refusals above are not blanket.
    const good = join(base, "good");
    await mkdir(good, { recursive: true, mode: 0o700 });
    assert.ok(await open(good));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("an entry the store did not write is a refusal, never a deletion", async () => {
  await withStore({ async after(root, store) {
    const content = bytes("stored\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    // Something else put a file here. The store refuses to open, and — the
    // point — leaves it exactly where it was.
    const intruder = join(root, "notes.txt");
    await writeFile(intruder, "not ours");
    const before = await lstat(intruder);
    await assert.rejects(store.read(id),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
    assert.deepEqual((await lstat(intruder)).ino, before.ino, "the store deleted nothing");
  } });
});

test("the declared ceilings are enforced by the store, not only by the schema", async () => {
  await withStore({ async after(_root, store) {
    // Per file.
    const big = new Uint8Array(2_097_152);
    const bigId = identity(PROJECT, FILE, big);
    await assert.rejects(store.put({ ...bigId, bytes: big }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_capacity");
    // Per set, when the caller declares what the set already holds.
    const content = bytes("one\n");
    const id = identity(PROJECT, FILE, content);
    await assert.rejects(store.put({ ...id, bytes: content, setBytes: 4_194_304, setFiles: 0 }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_capacity");
    await assert.rejects(store.put({ ...id, bytes: content, setBytes: 0, setFiles: 32 }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_capacity");
    // Total. The store OPENS over a directory that already holds bytes: the
    // installation quota lives in the catalog, and the store's own total is a
    // write-time refusal rather than an open-time one. What is proved here is
    // that the NEXT write past the total is refused, and that the file already
    // there is untouched by the refusal.
    const existing = bytes("already stored\n");
    const heldId = identity("project:held", FILE, existing);
    await store.put({ ...heldId, bytes: existing });
    const small = await ResultFileStoreV1.create({ rootPath: _root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304,
      maximumTotalBytes: existing.byteLength, operationTimeoutMs: 2_000 });
    // Either refusal is a refusal. `store_capacity` is the ceiling answering;
    // `store_invalid` is the digest check answering first, because the bytes
    // handed here do not match the digest that names the key. Both leave the
    // stored file alone, which is what the next assertion proves.
    await assert.rejects(small.put({ ...identity("project:next"), bytes: bytes("one more\n") }),
      (error: unknown) => error instanceof ResultFileStoreError
        && (error.code === "store_capacity" || error.code === "store_invalid"));
    assert.deepEqual(Buffer.from((await store.read(heldId))!), Buffer.from(existing),
      "the refused write left the stored file alone");
  } });
});

test("a malformed identity is refused before any path is built", async () => {
  await withStore({ async after(_root, store) {
    for (const bad of [
      { tenantId: "", projectId: PROJECT, fileId: FILE, contentDigest: digest(bytes("x")) },
      { tenantId: TENANT, projectId: "../escape", fileId: FILE, contentDigest: digest(bytes("x")) },
      { tenantId: TENANT, projectId: PROJECT, fileId: "result-file:short", contentDigest: digest(bytes("x")) },
      { tenantId: TENANT, projectId: PROJECT, fileId: FILE, contentDigest: "not-a-digest" },
      // A path segment in any of them is a caller that thinks it names a path.
      { tenantId: "ten/ant", projectId: PROJECT, fileId: FILE, contentDigest: digest(bytes("x")) },
    ]) await assert.rejects(store.read(bad),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_invalid");
    // The key derivation refuses the same shapes.
    for (const bad of [["", PROJECT, FILE], [TENANT, "a/b", FILE], [TENANT, PROJECT, "x"],
      [TENANT, PROJECT, FILE, "nope"]] as const) {
      const [tenantId, projectId, fileId, contentDigest = digest(bytes("x"))] = bad;
      assert.throws(() => resultFileStorageKeyV1(tenantId, projectId, fileId, contentDigest),
        (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_invalid");
    }
  } });
});

test("a read re-proves the digest, so a file changed under it is a refusal", async () => {
  await withStore({ async after(root, store) {
    const content = bytes("original\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    // Overwrite the stored bytes in place, keeping the name. The catalog's
    // digest no longer matches, so the read must refuse rather than serve it.
    const name = (await readdir(root)).find(entry => entry.endsWith(".crbf"))!;
    await writeFile(join(root, name), bytes("tampered\n"));
    await assert.rejects(store.read(id),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
  } });
});

test("the v1 limits are the ones plan 2.6 states, and are not configurable upward", async () => {
  assert.deepEqual(RESULT_FILE_LIMITS_V1, { maximumFilesPerSet: 32, maximumFileBytes: 268_435_456,
    maximumSetBytes: 536_870_912, maximumTotalBytes: 10_737_418_240 });
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-limits-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    // A configuration past a declared ceiling is refused at open, so the limit
    // is a property of the store rather than of a well-behaved caller.
    for (const over of [{ maximumFileBytes: 268_435_457 }, { maximumSetBytes: 536_870_913 },
      { maximumFiles: 33 }, { maximumTotalBytes: 10_737_418_241 },
      { operationTimeoutMs: 0 }, { operationTimeoutMs: 30_001 }] as const) {
      await assert.rejects(ResultFileStoreV1.create({ maximumFiles: 32, maximumFileBytes: 1_048_576,
        maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608, operationTimeoutMs: 2_000,
        ...over, rootPath: root }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_invalid",
      `refused: ${JSON.stringify(over)}`);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("no error message carries a path, a display name or a digest", async () => {
  await withStore({ async after(_root, store) {
    const content = bytes("secret report contents\n");
    const id = identity(PROJECT, FILE, content);
    // The attempts are THUNKS, not promises: a rejected promise built before a
    // handler is attached would escape as an unhandled rejection, which is the
    // very thing this test exists to rule out.
    const attempts: (() => Promise<unknown>)[] = [
      () => store.read({ ...id, contentDigest: `sha256:${"0".repeat(64)}` }),
      () => store.put({ ...id, bytes: bytes("mismatched\n") }),
      () => store.read({ ...id, projectId: "project:other" }),
      () => store.read({ ...id, tenantId: "ten\nant" }),
    ];
    for (const attempt of attempts) {
      // A refusal resolves or rejects without a body; where it rejects, the
      // message is a fixed code and nothing else. The digest and the project
      // never appear, because these strings reach logs.
      await attempt().then(value => assert.equal(value, undefined),
        (error: unknown) => {
          assert.ok(error instanceof ResultFileStoreError);
          assert.match(error.message, /^result_file_store_[a-z_]+$/u);
          assert.doesNotMatch(error.message, /project:|ten\/|\/tmp\/|crbf1|[0-9a-f]{32}/u);
        });
    }
  } });
});


// ---------------------------------------------------------------------------
// The three store bugs the review reproduced, each as its own case. The store
// opens over a real directory here, so a leftover is a real file and a write in
// flight is a real write.
// ---------------------------------------------------------------------------

test("B3: the 32-file ceiling is per SET, not for the whole installation", async () => {
  // The review stored 33 files and watched the 33rd be refused `store_capacity`
  // on an installation whose largest set held one. `inventory.count` counted
  // every file in the store, so a per-set limit was applied installation-wide.
  // A result file is created by a set; the installation's ceiling is BYTES.
  await withStore({ async after(_root, store) {
    for (let index = 0; index < 40; index += 1) {
      const content = bytes(`report ${index}\n`);
      // Every file is in its OWN set, and each set is empty but this one, so
      // no per-set ceiling is anywhere near being reached.
      const id = identity(PROJECT, `result-file:${index.toString(16).padStart(32, "0")}`, content);
      await store.put({ ...id, bytes: content, setBytes: 0, setFiles: 0 });
    }
    assert.equal((await readdir(_root)).filter(entry => entry.endsWith(".crbf")).length, 40,
      "forty files across forty sets, all stored");
  } });
});

test("B3: the per-set ceiling is still refused, and the installation total still bites", async () => {
  await withStore({ async after(_root, store) {
    const content = bytes("one\n");
    const id = identity(PROJECT, FILE, content);
    // The 33rd file in ONE set is refused, which is the limit the schema and
    // the store both declare. Dropping the installation-wide count did not
    // weaken this one.
    await assert.rejects(store.put({ ...id, bytes: content, setBytes: 0, setFiles: 32 }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_capacity");
    // And the installation's own total is still a refusal once it is reached.
    const first = bytes("first stored file\n");
    const firstId = identity("project:one", FILE, first);
    await store.put({ ...firstId, bytes: first });
    const small = await ResultFileStoreV1.create({ rootPath: _root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304,
      maximumTotalBytes: first.byteLength, operationTimeoutMs: 2_000 });
    const second = bytes("second file would exceed the total\n");
    const secondId = identity("project:two", `result-file:${"c".repeat(32)}`, second);
    await assert.rejects(small.put({ ...secondId, bytes: second }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_capacity");
  } });
});

test("B7: a crashed writer's leftovers do not stop the store from opening", async () => {
  // The review's live case: a surviving lock or an orphaned `pending-*` file
  // made `create()` throw `store_ambiguous`, and the Mac-local task provider
  // awaits `create()` with no fallback — so one interrupted write locked the
  // owner out of EVERY task, not just Files.
  for (const leftover of ["lock", "pending"]) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-crash-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
        maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
        operationTimeoutMs: 2_000 });
      // Store one real file first, so recovery is proved to preserve results.
      const store = await open();
      const content = bytes("kept across the crash\n");
      const id = identity(PROJECT, FILE, content);
      await store.put({ ...id, bytes: content });
      // A DEAD writer's leftovers. The lock names a pid that cannot be running:
      // `process.kill(deadPid, 0)` is the proof the recovery relies on, and a pid
      // that is certainly not this process is certainly not a live writer here.
      if (leftover === "lock")
        await writeFile(join(root, ".control-room-result-file-store.lock"),
          `control-room-result-file-store-write\n${liveStamp(2147483646)}\n`, { mode: 0o600 });
      else
        await writeFile(join(root, `.control-room-result-file-store-pending-${"f".repeat(32)}`),
          bytes("half written"), { mode: 0o600 });
      // Re-opening succeeds, and the result file is untouched.
      const reopened = await open();
      assert.deepEqual(Buffer.from((await reopened.read(id))!), Buffer.from(content),
        `a ${leftover} leftover did not cost the stored file`);
      assert.ok(!(await readdir(root)).some(entry =>
        entry === ".control-room-result-file-store.lock" || entry.startsWith(".control-room-result-file-store-pending-")),
      `the ${leftover} leftover was cleared`);
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});

test("B1+B7: a LIVE writer's lock and pending file are never cleared", async () => {
  // The recovery must be able to tell a dead writer from a live one, or it
  // destroys a write in progress. The store asks the KERNEL, so a "live writer"
  // here has to be a real held `O_EXLOCK` lock: a lock file written with
  // `writeFile`, however plausible its stamp, holds nothing at all and is
  // correctly takeable. That distinction is the whole of the review's B1, and a
  // fixture that faked liveness with a stamp would have let it through.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-live-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // A real lock, held by this live process, stamped the way a writer stamps
    // it, with a staging file beside it — the exact state the review found a
    // second opener destroying.
    const lockName = ".control-room-result-file-store.lock";
    const pendingName = `.control-room-result-file-store-pending-${"a".repeat(32)}`;
    // A real lock, held by this live process, stamped the way a writer stamps
    // it, with a staging file beside it — the exact state the review found a
    // second opener destroying.
    //
    // The descriptor is closed in a `finally` as well as inline below, so an
    // assertion failure cannot leave a locked file descriptor behind: Node now
    // treats a FileHandle closed during garbage collection as an error, which
    // would fail a LATER test for something that happened in this one.
    const held = await heldLockV1(join(root, lockName));
    try {
      await held.writeFile(`control-room-result-file-store-write\n${liveStamp()}\n`, "utf8");
      await writeFile(join(root, pendingName), bytes("a write in progress"), { mode: 0o600 });
      // The store still OPENS — a second instance publishing through another
      // process must not stop this one starting, which is the point of the fix.
      const store = await open();
      assert.ok(store);
      // And the live writer's entries are both still exactly where they were.
      assert.ok((await readdir(root)).includes(lockName),
        "a live writer's lock was not deleted");
      assert.ok((await readdir(root)).includes(pendingName),
        "a live writer's pending file was not deleted");
      // The whole point, checked directly: a LIVE holder is not the same thing
      // as a leftover with a nice stamp. The kernel says this one is held, and
      // the store obeyed it — the second instance OPENS (a live writer must not
      // stop it starting) and its WRITES are refused, which is the existing
      // O_EXCL mutual exclusion, not weakened by anybody reading the lock.
      const blocked = bytes("a write that must not slip past the lock\n");
      const blockedId = identity("project:other", `result-file:${"9".repeat(32)}`, blocked);
      const second = await open();
      await assert.rejects(second.put({ ...blockedId, bytes: blocked }),
        (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous",
      "a write through a second instance is still refused while a live writer holds the lock");
    } finally { await held.close().catch(() => {}); }
    // Release the writer, and the very next open takes its lock over — the other
    // half, and the reason the fix is a kernel lock rather than a longer guess.
    const afterRelease = await open();
    assert.ok(afterRelease, "the store opens as soon as the writer's lock is released");
    assert.ok(!(await readdir(root)).includes(lockName),
      "and the released lock is cleared, so no crash can leave the owner locked out");
    // And with the lock gone that same write lands, so the refusal above was the
    // live lock and not something else about the store.
    const blocked = bytes("a write that must not slip past the lock\n");
    const blockedId = identity("project:other", `result-file:${"9".repeat(32)}`, blocked);
    await afterRelease.put({ ...blockedId, bytes: blocked });
    assert.deepEqual(Buffer.from((await afterRelease.read(blockedId))!), Buffer.from(blocked),
      "the write refused during the live lock actually lands once the writer is gone");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("B7: a lock this store cannot PROVE abandoned is left alone, and never deleted", async () => {
  // The store must not guess. There is one class it will not classify at all — a
  // bookkeeping name that is a DIRECTORY or a symlink is not this store's own
  // file — and that one is a refusal with nothing removed. What it will NOT do
  // any more is refuse forever over a lock it can actually account for: S1 below.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-nopid-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    // A bookkeeping name that is a DIRECTORY is not a lock file, so there is no
    // stamp to read and nothing to prove. It is left alone.
    await mkdir(join(root, ".control-room-result-file-store.lock"), { mode: 0o700 });
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok(store);
    assert.ok((await readdir(root)).includes(".control-room-result-file-store.lock"),
      "a lock the store cannot read is left exactly where it is");
    // The same for a `pending-*` name that is a directory: not this store's own
    // file, so never removed, and never the reason the application refuses to
    // start. This is the one thing the review called "acceptable, but note it",
    // and it is now pinned by a test.
    await mkdir(join(root, ".control-room-result-file-store-pending-deadbeef"), { mode: 0o700 });
    const reopened = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok((await readdir(root)).includes(".control-room-result-file-store-pending-deadbeef"),
      "a directory the store did not write is never deleted");
    // And a WRITE is still refused while that name holds the store, because the
    // O_EXCL create is the mutual exclusion and it has not been weakened: reads
    // work, writes wait. The refusal is the honest one.
    const content = bytes("would this write succeed?\n");
    const id = identity(PROJECT, FILE, content);
    await assert.rejects(reopened.put({ ...id, bytes: content }),
      (error: unknown) => error instanceof ResultFileStoreError);
    assert.equal(await reopened.read(id), undefined, "and nothing was written");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: an EMPTY lock is repaired, not left to block every write for good", async () => {
  // The review's S1, first case, live: a crash between the O_EXCL create and the
  // stamp write leaves an empty lock. It used to be "assume live" for ever, so
  // every write was refused `store_ambiguous` — still, after a restart, because
  // nothing in the app could ever clear it.
  //
  // Now the empty lock is re-examined once after a short bounded wait. A live
  // writer stamps within microseconds, so a lock that is STILL empty a moment
  // later belongs to a writer that is not coming back, and the recovery clears
  // it. The test writes an empty lock and asserts the next write lands.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-empty-lock-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // A stored file first, so recovery is proved to preserve results.
    const first = await open();
    const kept = bytes("kept across the empty lock\n");
    const keptId = identity(PROJECT, FILE, kept);
    await first.put({ ...keptId, bytes: kept });
    // The empty lock, and the staging file a crash in that window would leave.
    await writeFile(join(root, ".control-room-result-file-store.lock"), "", { mode: 0o600 });
    await writeFile(join(root, `.control-room-result-file-store-pending-${"b".repeat(32)}`),
      bytes("half written"), { mode: 0o600 });
    // The store OPENS (a leftover must never stop the owner starting a task) …
    const reopened = await open();
    assert.ok(reopened);
    // … the stored file is untouched …
    assert.deepEqual(Buffer.from((await reopened.read(keptId))!), Buffer.from(kept),
      "an empty lock did not cost the stored file");
    // … the leftovers are cleared …
    assert.ok(!(await readdir(root)).some(entry =>
      entry === ".control-room-result-file-store.lock"
      || entry.startsWith(".control-room-result-file-store-pending-")),
    "the empty lock and its staging file were cleared");
    // … and, the point of the whole thing, the NEXT write succeeds. Before this
    // fix it was refused `store_ambiguous` here and on every write after it.
    const content = bytes("written after the empty lock was repaired\n");
    const id = identity(PROJECT, "result-file:" + "c".repeat(32), content);
    await reopened.put({ ...id, bytes: content });
    assert.deepEqual(Buffer.from((await reopened.read(id))!), Buffer.from(content),
      "a write after an empty lock is repaired actually lands");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("B1: NOTHING in a leftover's stamp decides anything, and every old format still repairs", async () => {
  // The review's S1 was three cases — a previous boot, a recycled pid, a part-1
  // bare pid — that a stamp-reading store had to reason about, and that any
  // reasoning about them could get wrong in the fail-open direction. The kernel
  // lock answers all three at once, and the only thing left to prove is that
  // they are now the SAME case: a name nobody holds.
  //
  // The discriminator that matters is the second half of each test. Before the
  // fix, a plausible-looking stamp kept the name (part-1 with a live pid) and an
  // implausible one removed it. Now the stamp is decoration: every one of these
  // is released by the kernel, and every one is taken over. What is NOT
  // decoration is the live case, in the test above, and it is decided by the
  // kernel too.
  const cases: Readonly<{ name: string; stamp: string }>[] = [
    // S1, first case: a crash between the create and the stamp write. Previously
    // re-examined after 150 ms and then deleted on a guess, which also cost a
    // CLI process its life (B2, an unref'd timer ending `create()` mid-flight).
    { name: "an empty lock", stamp: "" },
    // S1, second case: the PREVIOUS build's format, `<header>\n<pid>`, with a pid
    // that cannot be running.
    { name: "a part-1 lock with a dead pid", stamp: "control-room-result-file-store-write\n2147483646" },
    // S1, second case, other direction: the same format naming THIS live pid.
    // This is the one the old store kept for ever, because a pid that IS running
    // was its only evidence — and the store then refused every write for the rest
    // of the machine's life, for a writer that had died days ago.
    { name: "a part-1 lock naming this very live process", stamp: `control-room-result-file-store-write\n${process.pid}` },
    // S1, third case: a lock stamped under a DIFFERENT boot, naming this very
    // live process. The old store needed the boot line to see it as dead.
    { name: "a lock from a previous boot naming this very live process",
      stamp: `control-room-result-file-store-write\n${liveStamp(process.pid, "boot:three-days-ago")}` },
    // S1, fourth case: a RECYCLED pid, which is what the start-second line existed
    // to catch — a live pid that started a day after the dead writer did.
    { name: "a lock whose pid has been recycled",
      stamp: `control-room-result-file-store-write\n${(() => {
        const parts = liveStamp(process.pid).split("\n");
        parts[parts.length - 1] = String(Number(parts[parts.length - 1]) - 86_400);
        return parts.join("\n");
      })()}` },
    // A stamp from a build that wrote something entirely different, and a
    // truncated one from a disk that filled up mid-write. Neither is this store's
    // file to interpret any more; both are simply names nobody holds.
    { name: "a stamp this build never wrote",
      stamp: "control-room-result-file-store-write\nnot-a-pid\nnot-a-second" },
    { name: "a header with no stamp at all", stamp: "control-room-result-file-store-write\n" },
  ];
  for (const shape of cases) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-stamp-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
        maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
        operationTimeoutMs: 2_000 });
      // A stored file first, so recovery is proved to preserve results.
      const first = await open();
      const kept = bytes("kept across the leftover\n");
      const keptId = identity(PROJECT, FILE, kept);
      await first.put({ ...keptId, bytes: kept });
      const lockName = ".control-room-result-file-store.lock";
      await writeFile(join(root, lockName), shape.stamp, { mode: 0o600 });
      await writeFile(join(root, `.control-room-result-file-store-pending-${"e".repeat(32)}`),
        bytes("half written"), { mode: 0o600 });
      // The store OPENS, keeps its results, and clears the leftovers.
      const reopened = await open();
      assert.ok(reopened, `${shape.name}: the store still opens`);
      assert.deepEqual(Buffer.from((await reopened.read(keptId))!), Buffer.from(kept),
        `${shape.name}: the stored file survived the repair`);
      assert.ok(!(await readdir(root)).includes(lockName), `${shape.name}: the lock was cleared`);
      assert.ok(!(await readdir(root)).some(entry =>
        entry.startsWith(".control-room-result-file-store-pending-")),
      `${shape.name}: its staging file was cleared`);
      // And, the point of every one of these cases, the NEXT write lands: not
      // this one, and not every one after a restart.
      const content = bytes(`written after ${shape.name}\n`);
      const id = identity(PROJECT, `result-file:${"c".repeat(32)}`, content);
      await reopened.put({ ...id, bytes: content });
      assert.deepEqual(Buffer.from((await reopened.read(id))!), Buffer.from(content),
        `${shape.name}: a write after the repair actually lands`);
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});

test("B1: the STORE'S OWN write path takes the kernel lock, not just the tests' fixtures", async () => {
  // Mutation testing found this one missing, and it is the most important
  // property of the whole fix: the previous build's fixtures all created their
  // "live writer" locks BY HAND, so the lane was green while the real write path
  // took no kernel lock at all — a store whose recovery asked the kernel and
  // whose writer never locked, which deletes every live write it is asked about.
  // That is the review's B1 with the guard left off.
  //
  // So the lock is caught from a REAL `put()`, mid-write, with no hand-made
  // fixture anywhere: if the store's own descriptor is not holding it, the probe
  // below succeeds and this test fails. The payload is large so the window is
  // wide enough to catch reliably rather than by luck.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-ownlock-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { mode: 0o700 });
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912,
      maximumTotalBytes: 1_073_741_824, operationTimeoutMs: 30_000 });
    // 64 MiB: a real payload, and long enough that polling for the lock cannot
    // miss it (measured: the lock is observable 14-40 ms after a put starts).
    const payload = new Uint8Array(64 * 1024 * 1024);
    payload.fill(7);
    const id = identity("project:ownlock", FILE, payload);
    const writing = store.put({ ...id, bytes: payload });
    const lockName = ".control-room-result-file-store.lock";
    let caught = "";
    for (let attempt = 0; attempt < 40_000 && !caught.trim(); attempt += 1) {
      try { caught = await readFile(join(root, lockName), "utf8"); } catch { /* not yet */ }
      if (!caught) await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(caught.trim(), "the store's own write path created its lock, so it was caught mid-write");
    // THE ASSERTION. The lock the store just wrote is, right now, locked by the
    // kernel, because the store's own descriptor holds it.
    await assert.rejects(open(join(root, lockName), constants.O_RDWR | EXLOCK | constants.O_NONBLOCK),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EAGAIN",
    "the store's OWN lock is held by the kernel while its write is in flight");
    // And the same lock is takeable the moment the write retires, which is what
    // makes a crash recoverable rather than permanent.
    await writing;
    assert.equal((await readdir(root)).filter(entry => entry.endsWith(".crbf")).length, 1,
      "the write landed");
    assert.ok(!(await readdir(root)).includes(lockName), "and the store released its own lock");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("B1: a second process's LIVE write is never taken over, measured with a real writer", async () => {
  // The review's B1 attack, as a test: a real writer in a real child process,
  // alive for longer than a second, part-way through a real write — and a second
  // store instance opening the same directory underneath it.
  //
  // The last round's version of this test built its "live writer" fixture by
  // hand, stamping `ps`'s start second itself, and so passed against a store
  // that was wrong in exactly the way the review found. The fixture has to be a
  // real writer in a real process, and the store has to be asked while that
  // writer is actually writing.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-crossproc-")));
  // The directory exists BEFORE the child is spawned. Spawning first and
  // creating the root afterwards loses a race the child cannot report on: it
  // exits with a store refusal, the poll below never sees a lock, and the test
  // hangs until the runner's own timeout rather than failing with a reason.
  await mkdir(join(base, "store"), { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { ResultFileStoreV1 } = await import(${JSON.stringify(join(process.cwd(),
      "src/artifacts/v1/result-file-store.ts"))});
    const { createHash, randomUUID } = await import("node:crypto");
    const store = await ResultFileStoreV1.create({ rootPath: process.env.CR_ROOT,
      maximumFiles: 32, maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912,
      maximumTotalBytes: 1_073_741_824, operationTimeoutMs: 30_000 });
    // Alive for well over a second before writing, which is what made the old
    // stamp (the second the lock was TAKEN) disagree with the reader.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    // Four 8 MiB files, not six 48 MiB ones. The property under test is "a
    // second opener must not disturb a live writer", and 8 MiB is comfortably
    // long enough to be caught mid-write (measured: the lock is observable
    // within 14-40 ms of the put starting) while costing a fraction of the
    // disk. Several bots share this Mac, and a 288 MiB child here starves the
    // lanes that run beside it -- which is how this test came to look hung when
    // it was merely starved.
    for (let index = 0; index < 4; index += 1) {
      const bytes = new Uint8Array(8 * 1024 * 1024).fill(index + 1);
      try {
        await store.put({ tenantId: "tenant:crossproc", projectId: "project:crossproc",
          fileId: "result-file:" + randomUUID().replace(/-/g, ""),
          contentDigest: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes });
        process.stdout.write("ok\\n");
      } catch (error) { process.stdout.write("err " + (error.code ?? error.message) + "\\n"); }
    }
    process.stdout.write("done\\n");`], { stdio: ["ignore", "pipe", "inherit"],
  cwd: process.cwd(), env: { ...process.env, CR_ROOT: join(base, "store") } });
  try {
    const lines: string[] = [];
    child.stdout.on("data", chunk => { for (const line of String(chunk).split("\n")) if (line) lines.push(line); });
    let childExited = false;
    child.once("exit", () => { childExited = true; });
    const lockName = ".control-room-result-file-store.lock";
    const pendingPrefix = ".control-room-result-file-store-pending-";
    // Wait for the child to be genuinely mid-write: its lock AND a staging file
    // beside it, and a stamped lock (so the writer is past its first write).
    //
    // The loop gives up the moment the child EXITS, and says what the child
    // reported. Polling for 80 seconds on a process that died 3 seconds in turns
    // a real failure into a hang, which is strictly worse for whoever reads the
    // lane's output.
    let listed: string[] = [];
    let stamp = "";
    // A REF'D timer, deliberately. Polling with `setTimeout(2)` gives the event
    // loop nothing to hold it open, and Node ends a test whose promise is
    // "still pending but the event loop has already resolved" — which is the
    // review's B2 arriving through the test instead of through the store. The
    // child process is not something this loop can observe directly, so the
    // deadline timer is what keeps the process alive while it runs.
    const keeper = setTimeout(() => {}, 60_000);
    try {
      const deadline = Date.now() + 55_000;
      while (Date.now() < deadline && !childExited) {
        listed = await readdir(join(base, "store"));
        if (listed.includes(lockName) && listed.some(entry => entry.startsWith(pendingPrefix))) {
          try { stamp = await readFile(join(base, "store", lockName), "utf8"); } catch { stamp = ""; }
          if (stamp.trim()) break;
        }
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    } finally { clearTimeout(keeper); }
    assert.equal(childExited, false,
      `the child writer exited before it could be attacked: ${lines.join(" ").trim() || "(it said nothing)"}`);
    assert.ok(stamp.trim(), "the child writer was caught mid-write, with a stamped lock");
    const alive = (() => { try { process.kill(child.pid!, 0); return true; } catch { return false; } })();
    assert.equal(alive, true, "and it is alive while we attack it");
    // THE ATTACK. A second store instance, in this process, over the same
    // directory, while that child is writing.
    const second = await ResultFileStoreV1.create({ rootPath: join(base, "store"), maximumFiles: 32,
      maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912,
      maximumTotalBytes: 1_073_741_824, operationTimeoutMs: 10_000 });
    assert.ok(second, "the second instance opens: a live writer must not stop it starting");
    // The outcome the review measured as a bug: the live writer's LOCK must still
    // be there. Before the fix the directory came back EMPTY and the writer's put
    // died with a raw ENOENT.
    //
    // The staging file is deliberately NOT asserted here. A pending file exists
    // only between a writer's create and its `link()`, which for a small file is
    // a few milliseconds — by the time a second opener has walked the directory,
    // the writer may legitimately have finished. Asserting its presence would
    // make this a test of timing rather than of the store. What is asserted
    // instead is the pair that cannot be timing: the lock is still held, and the
    // lock is still the KERNEL's, so the writer has not been interfered with.
    const after = await readdir(join(base, "store"));
    assert.ok(after.includes(lockName), "a live writer's lock was NOT taken over by the second opener");
    await assert.rejects(open(join(base, "store", lockName),
      constants.O_RDWR | EXLOCK | constants.O_NONBLOCK),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EAGAIN",
    "and the kernel still says the live writer holds it, which is why it was not deleted");
    // A write through the second instance is refused while that live writer holds
    // it: the O_EXCL create is the mutual exclusion and it is untouched by this.
    const blocked = bytes("must not slip past a live writer\n");
    const blockedId = identity("project:crossproc-other", `result-file:${"8".repeat(32)}`, blocked);
    await assert.rejects(second.put({ ...blockedId, bytes: blocked }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous",
    "a write through the second instance is refused while a live writer holds the lock");
    // Let the child finish, and read what it reported. Every put must be `ok`:
    // an `err` here is the review's raw ENOENT, which is a store error contract
    // breach as well as a lost write.
    await awaitChildV1(child, "writer");
    assert.ok(lines.includes("done"), "the child writer finished");
    const errors = lines.filter(line => line.startsWith("err"));
    assert.deepEqual(errors, [], "every one of the live writer's puts succeeded");
    assert.equal(lines.filter(line => line === "ok").length, 4,
      "all four puts landed, so nothing was destroyed underneath the writer");
    // And the second instance can read what the live writer wrote, which is the
    // other half of "a second opener does not damage a live write".
    const stored = (await readdir(join(base, "store"))).filter(entry => entry.endsWith(".crbf"));
    assert.equal(stored.length, 4, "every file the live writer wrote is on disk exactly once");
  } finally {
    child.kill("SIGKILL");
    await awaitChildV1(child, "writer (cleanup)").catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test("B1: a HELD lock is left alone whatever its stamp says, including a lying one", async () => {
  // The fail-open direction, which is the only one that destroys anything. A
  // lock the kernel holds is a live writer, so it is left alone — and that has
  // to be true even when the stamp inside it is nonsense, because a stamp is
  // data from a file and a held lock is a fact from the kernel. The old store
  // reached the same conclusion by parsing the stamp, and could be talked into
  // the opposite by a stamp that parsed well.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-lying-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    const lockName = ".control-room-result-file-store.lock";
    for (const stamp of ["", "control-room-result-file-store-write\nnot-a-pid",
      `control-room-result-file-store-write\n${liveStamp(2147483645)}`]) {
      // A real held lock whose CONTENT is a lie: it names a pid that cannot be
      // running, and the store must still treat the lock as live.
      const held = await heldLockV1(join(root, lockName));
      await held.writeFile(stamp, "utf8");
      const pendingName = `.control-room-result-file-store-pending-${"d".repeat(32)}`;
      await writeFile(join(root, pendingName), bytes("a real write in progress"), { mode: 0o600 });
      const store = await open();
      assert.ok(store, "the store still opens with a held lock present");
      assert.ok((await readdir(root)).includes(lockName),
        `a HELD lock is never cleared, whatever its stamp (${JSON.stringify(stamp.slice(0, 40))})`);
      assert.ok((await readdir(root)).includes(pendingName),
        "and the writer's staging file beside it is never cleared either");
      await held.close();
      // Once the writer is gone the same name is repaired, so the test above's
      // "unlocked leftovers are takeable" and this test's "held locks are not"
      // are the two halves of one rule rather than two opinions.
      const after = await open();
      assert.ok(after, "the store opens once the writer releases its lock");
      assert.ok(!(await readdir(root)).includes(lockName), "and the released name is then cleared");
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});


test("B8: a read succeeds while a write is in progress", async () => {
  // The review's live case: 50 reads of a stored file raced one 64 MiB upload
  // and 13 of the 50 failed `store_ambiguous`, which the route turns into a
  // 503. The cause was the read's whole-directory check refusing the writer's
  // own `pending-*` name. Downloads must not depend on no upload happening.
  await withStore({ async after(root, store) {
    const content = bytes("the file being downloaded\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    // A REAL concurrent put, so the lock and the staging file are created by the
    // store's own write path rather than by the test.
    const large = new Uint8Array(900_000);
    large.fill(65);
    const largeId = identity("project:other", FILE, large);
    const writing = store.put({ ...largeId, bytes: large });
    const reads = await Promise.all(Array.from({ length: 50 }, () => store.read(id)));
    await writing;
    assert.equal(reads.filter(value => value !== undefined).length, 50,
      "every read succeeded while a write was in progress");
    for (const value of reads) assert.deepEqual(Buffer.from(value!), Buffer.from(content));
  } });
  // The same property, DETERMINISTICALLY. The race above is real but it depends
  // on timing, and a guard that only bites when the scheduler happens to line up
  // is not a guard. A live writer's lock and staging file are therefore put in
  // place directly — the exact state the review measured 13 of 50 reads failing
  // in — and the read must still succeed.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-inflight-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 5_000 });
    const content = bytes("downloaded while an upload is in flight\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    // This process is live, so its pid in the lock is the proof of liveness the
    // recovery relies on, and the store still opens and still reads.
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${process.pid}\n`, { mode: 0o600 });
    const staging = `.control-room-result-file-store-pending-${"b".repeat(32)}`;
    await writeFile(join(root, staging), bytes("half a file, still being written"), { mode: 0o600 });
    const reads = await Promise.all(Array.from({ length: 50 }, () => store.read(id)));
    assert.equal(reads.filter(value => value !== undefined).length, 50,
      "50 reads with a live lock AND a staging file in the directory: none refused");
    for (const value of reads) assert.deepEqual(Buffer.from(value!), Buffer.from(content));
    // And the write lock was still doing its job: a write is refused while a
    // live writer holds it, so ignoring bookkeeping for READS weakened nothing.
    const other = bytes("a write that must not slip past the lock\n");
    const otherId = identity("project:other", FILE, other);
    await assert.rejects(store.put({ ...otherId, bytes: other }),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("B8: a read is still refused for an entry the store did not write", async () => {
  // The fix ignores ONLY the store's own bookkeeping. A stray file is still a
  // refusal, and still not a deletion.
  await withStore({ async after(root, store) {
    const content = bytes("stored\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    await writeFile(join(root, "notes.txt"), "not ours");
    const before = await lstat(join(root, "notes.txt"));
    await assert.rejects(store.read(id),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
    assert.deepEqual((await lstat(join(root, "notes.txt"))).ino, before.ino, "nothing was deleted");
  } });
});


test("STRESS: 50 downloads race 8 uploads, and every download still succeeds", async () => {
  // The review's case, as briefed: "50 downloads + 50 uploads". Downloads and
  // uploads are in the SAME store, the store serialises its own writes behind a
  // queue, and every download re-proves its own digest — so the only thing that
  // can break here is the whole-directory accounting, which is exactly what B8
  // was. The number of uploads is 8 rather than 50 because the store serialises
  // writes: 50 of them would queue, not race, and would measure the queue.
  await withStore({ async after(root, store) {
    // Sixteen distinct stored files, so the readers are not all reading one
    // name and a single cached page would not explain a pass.
    const files = Array.from({ length: 16 }, (_, index) => {
      const content = bytes(`report ${index}\n`.repeat(64));
      return { content, id: identity("project:alpha", `result-file:${index.toString(16).padStart(32, "0")}`, content) };
    });
    for (const file of files) await store.put({ ...file.id, bytes: file.content, setBytes: 0, setFiles: 0 });
    assert.equal((await readdir(root)).filter(entry => entry.endsWith(".crbf")).length, 16);

    // Eight uploads in flight, each 512 KiB, in a separate project so they are
    // real new keys rather than replays of what is already stored.
    const uploads = Array.from({ length: 8 }, (_, index) => {
      const content = new Uint8Array(512 * 1024);
      content.fill(65 + index);
      return { content, id: identity("project:uploading", `result-file:${index.toString(16).padStart(32, "0")}`, content) };
    });
    const writing = Promise.allSettled(uploads.map(upload =>
      store.put({ ...upload.id, bytes: upload.content, setBytes: 0, setFiles: 0 })));

    // 50 reads, spread across the 16 stored files, started while the uploads
    // are running. Every one must return its exact bytes.
    const reads = await Promise.all(Array.from({ length: 50 }, (_, index) => {
      const file = files[index % files.length]!;
      return store.read(file.id);
    }));
    const uploadsDone = await writing;
    const failedUploads = uploadsDone.filter(entry => entry.status === "rejected");
    const reasons = failedUploads.map(entry => {
      const reason = (entry as PromiseRejectedResult).reason;
      return String((reason as { message?: string } | undefined)?.message ?? reason);
    });
    assert.equal(failedUploads.length, 0, `every upload landed: ${JSON.stringify(reasons).slice(0, 300)}`);
    const failed = reads.filter(value => value === undefined);
    assert.equal(failed.length, 0, `all 50 downloads returned their bytes; ${failed.length} did not`);
    for (const [index, value] of reads.entries()) {
      const expected = files[index % files.length]!.content;
      assert.deepEqual(Buffer.from(value!), Buffer.from(expected),
        "every download returned the exact bytes, not a partial write from the upload in flight");
    }
    // And the uploads are readable afterwards, so ignoring bookkeeping during a
    // read did not lose anything.
    for (const upload of uploads) assert.ok(await store.read(upload.id), "each uploaded file is readable after the race");
  } });
});

test("STRESS: 50 concurrent writers of distinct files all land, and retries still replay", async () => {
  // The store serialises its own writes, so 50 callers is a queue rather than a
  // race. That is the property worth proving: the queue does not drop, reorder
  // into a conflict, or lose a file, and an exact retry after the burst is still
  // an idempotent replay.
  await withStore({ async after(root, store) {
    const work = Array.from({ length: 50 }, (_, index) => {
      const content = bytes(`concurrent ${index}\n`);
      return { content, id: identity("project:alpha", `result-file:${index.toString(16).padStart(32, "0")}`, content) };
    });
    const settled = await Promise.allSettled(work.map(entry =>
      store.put({ ...entry.id, bytes: entry.content, setBytes: 0, setFiles: 0 })));
    assert.equal(settled.filter(entry => entry.status === "fulfilled").length, 50,
      `every concurrent write landed: ${JSON.stringify(settled.find(entry => entry.status === "rejected")?.reason ?? null)}`);
    assert.equal((await readdir(root)).filter(entry => entry.endsWith(".crbf")).length, 50,
      "and every one is on disk exactly once");
    for (const entry of work) {
      assert.deepEqual(Buffer.from((await store.read(entry.id))!), Buffer.from(entry.content));
      // An exact retry is still a replay, not a conflict.
      await store.put({ ...entry.id, bytes: entry.content, setBytes: 0, setFiles: 0 });
    }
    assert.equal((await readdir(root)).filter(entry => entry.endsWith(".crbf")).length, 50,
      "and no retry created a second file");
  } });
});


test("B7: a recovery that was ITSELF interrupted does not lock the store out forever", async () => {
  // Found by re-reading my own diff as the reviewer. A leftover recovery lock
  // from a crash DURING the crash recovery is the one input that reproduces the
  // original bug in the fix: `create()` refuses, and nothing in the application
  // ever clears it, so the owner can never start a task again. The recovery lock
  // is therefore subject to the same liveness test as the write lock.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-recovery-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // A dead recovery's lock, and the write leftovers it was about to clear.
    // Nothing is locked, which is exactly what "the recovery crashed" means to
    // the kernel: the process that held the lock is gone, so the kernel dropped
    // it. These are written as plain files precisely because that is what a
    // crash leaves on disk.
    await writeFile(join(root, ".control-room-result-file-store-recovery.lock"),
      `control-room-result-file-store-recovery\n${liveStamp()}\n`, { mode: 0o600 });
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${liveStamp()}\n`, { mode: 0o600 });
    await writeFile(join(root, `.control-room-result-file-store-pending-${"c".repeat(32)}`),
      bytes("interrupted mid-recovery"), { mode: 0o600 });
    // The store opens, and every leftover is cleared.
    const store = await open();
    assert.ok(store, "an interrupted recovery does not stop the store opening");
    assert.deepEqual((await readdir(root)).filter(entry => !entry.endsWith(".crbf")), [],
      "and its leftovers are cleared, so the next open is clean");
    // And a HELD recovery lock is left alone: a concurrent recovery is not
    // something a second opener may delete out from under itself. This is a real
    // held lock rather than a stamp, because that is what a concurrent recovery
    // is; the previous version of this line wrote a stamp naming a live pid and
    // passed only because the old store read the stamp.
    const recoveryName = ".control-room-result-file-store-recovery.lock";
    const held = await heldLockV1(join(root, recoveryName));
    try {
      await held.writeFile(`control-room-result-file-store-recovery\n${liveStamp()}\n`, "utf8");
      await assert.rejects(open(),
        (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
      assert.ok((await readdir(root)).includes(recoveryName),
        "a held recovery lock is not deleted: it is a concurrent recovery, not a leftover");
    } finally { await held.close().catch(() => {}); }
    // Once that concurrent recovery is done, the next open proceeds: the two
    // halves of one rule, in that order, so a crashed recovery and a running one
    // are told apart by the kernel rather than by anything this store believes.
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: a bookkeeping name the store cannot OPEN is a refusal, never a deletion", async () => {
  // The direction that is not S1 but is just as important: the repairs must not
  // become a blanket "clear anything I do not recognise". A name the store
  // cannot OPEN is someone else's file, and deleting it is unrecoverable, so
  // each such shape has to survive a full open with nothing removed.
  //
  // Note what is no longer in this list: a stamp the store cannot PARSE. The
  // previous build had four refusal shapes here, all of them malformed stamps,
  // and every one of them is now a name nobody holds and therefore a repair. The
  // refusals that remain are about WHOSE FILE the name is, which is the
  // question that has a fail-open answer: a directory, a symlink, a hard link
  // and a world-writable file are all things this store did not write and must
  // not remove, and they are all still refused (the symlink and the
  // world-writable cases have their own tests below).
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-unopenable-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockName = ".control-room-result-file-store.lock";
    // A DIRECTORY at the lock name: `open` on it with O_RDWR fails, so there is
    // no kernel lock to ask about and no file to prove anything with.
    await mkdir(join(root, lockName), { mode: 0o700 });
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok(store, "the store still opens: a leftover is never the reason to refuse to start");
    assert.ok((await readdir(root)).includes(lockName),
      "a lock the store cannot open is left exactly where it is");
    assert.ok((await lstat(join(root, lockName))).isDirectory(),
      "and it is still a directory: nothing replaced it and nothing was removed");
    // And a write is refused rather than proceeding past a lock whose holder is
    // unknown: "cannot prove it is dead" is not "prove it is not there".
    const content = bytes("not written past a lock the store cannot open\n");
    const id = identity(PROJECT, FILE, content);
    await assert.rejects(store.put({ ...id, bytes: content }),
      (error: unknown) => error instanceof ResultFileStoreError,
      "the write is refused, not admitted");
    assert.equal(await store.read(id), undefined, "and nothing was written");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("B1: the KERNEL lock, not a stamp, is what says a writer is alive", async () => {
  // The property the whole B1 fix rests on, proved against the kernel rather
  // than against this store's own interpretation of a file. Three claims, in
  // the order the store relies on them:
  //
  //   1. a lock file created with `O_EXLOCK` and left open IS held — a second
  //      `O_EXLOCK` open is refused, in this process and in another;
  //   2. the kernel RELEASES it when the holder dies, which is what lets a
  //      crashed writer be told apart from a live one without any pid, boot or
  //      start time;
  //   3. a lock file that was never locked holds nothing, so a leftover from a
  //      crash is free to be taken over.
  //
  // Claim 2 is the one that has no substitute: it is measured by SIGKILLing a
  // real child and then asking again, because a process that exits cleanly and
  // a process that is killed are the same case as far as the kernel is
  // concerned, and only the second one is the case the store exists to survive.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-kernel-")));
  try {
    const path = join(base, "lock");
    const held = await heldLockV1(path);
    // Claim 1a: the NAME cannot be created twice. O_EXCL is still what stops a
    // second writer, and that has not changed.
    await assert.rejects(heldLockV1(path),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
      "O_EXCL still refuses a second CREATE: a name cannot be created twice");
    // Claim 1b: the lock is HELD, so a second O_EXLOCK open of the same name is
    // refused. In this process first, because that is the case a second store
    // instance in one process is, and it is the case the review's B1 was.
    await assert.rejects(open(path, constants.O_RDWR | EXLOCK | constants.O_NONBLOCK),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EAGAIN",
      "a held O_EXLOCK file refuses a second lock: that is what 'held' means");
    // Free once released.
    await held.close();
    const afterRelease = await open(path, constants.O_RDWR | EXLOCK | constants.O_NONBLOCK);
    assert.ok(afterRelease.fd >= 0, "the same open succeeds once the holder closed");
    await afterRelease.close();
    // Claim 3: a lock file that was never LOCKED holds nothing, so a leftover
    // from a crash — and every old fixture, which wrote one with `writeFile` —
    // is provably abandoned however plausible its stamp. This is the asymmetry
    // the whole fix rests on: a stamp can be written, a lock cannot be faked.
    const orphan = join(base, "orphan");
    await writeFile(orphan, `control-room-result-file-store-write\n${liveStamp()}\n`, { mode: 0o600 });
    const orphanProbe = await open(orphan, constants.O_RDWR | EXLOCK | constants.O_NONBLOCK);
    await orphanProbe.close();
    assert.ok(true, "a stamp alone holds no kernel lock, so it can never block a writer");
    // Claim 2, and the one that has no substitute: a real process, killed
    // outright, releases the lock. A child that exits cleanly and a child that
    // is SIGKILLed are the same case as far as the kernel is concerned, and only
    // the second is the case the store exists to survive.
    const live = join(base, "live");
    // `inherit` for stderr, deliberately: the child's stdio must never be a
    // closed pipe, because a write to one raises EPIPE inside the CHILD and
    // kills it before it reports that it took the lock — which reads as "the
    // child exited early" and is a test that fails for a reason that has
    // nothing to do with the store.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { open } = await import("node:fs/promises");
      const h = await open(process.env.CR_LOCK_PATH, 0x1 | 0x200 | 0x800 | 0x20 | 0x4, 0o600);
      process.stdout.write("held\\n");
      setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CR_LOCK_PATH: live } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the child never took the lock")), 20_000);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("exit", () => reject(new Error("the child exited before taking the lock")));
      });
      await assert.rejects(open(live, constants.O_RDWR | EXLOCK | constants.O_NONBLOCK),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "EAGAIN",
        "while the child is ALIVE the lock is held across processes: a second opener must see it");
      child.kill("SIGKILL");
      await awaitChildV1(child, "lock holder");
      const reclaimed = await open(live, constants.O_RDWR | EXLOCK | constants.O_NONBLOCK);
      assert.ok(reclaimed.fd >= 0,
        "after SIGKILL the kernel released the lock, so the store can tell a dead writer from a live one");
      await reclaimed.close();
    } finally { child.kill("SIGKILL"); }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: a lock that is a SYMLINK is never read as a stamp, and never removed", async () => {
  // The store opens its own bookkeeping `O_NOFOLLOW` and refuses a symlink
  // outright. A symlink at the lock name is not this store's file: reading it
  // would follow an attacker's link, and removing it would unlink a name the
  // store did not create. Both directions are refused, and the symlink survives
  // — which is why the symlink check has to happen BEFORE the read, and is the
  // mutation that would otherwise go unnoticed.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-symlink-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockName = ".control-room-result-file-store.lock";
    // A real, private, DEAD writer's lock, and a symlink pointing at it. If the
    // store followed the link it would read a valid stamp; if it cleared the
    // name it would unlink an entry it did not create.
    //
    // The target lives OUTSIDE the store root, because a name inside it that the
    // store did not write is itself a refusal — that is a different property and
    // it is already covered. What is under test here is only whether the store
    // follows or removes a symlink sitting at its own lock name.
    const outside = join(base, "outside.lock");
    await writeFile(outside,
      `control-room-result-file-store-write\n${liveStamp(2147483646)}\n`, { mode: 0o600 });
    await chmod(outside, 0o600);
    await symlink(outside, join(root, lockName));
    // The symlink points at a private, plain, DEAD writer's lock. Every property
    // that would make removal safe holds for the TARGET and none of them holds
    // for the NAME, so the only thing that can keep the store from clearing this
    // is refusing to read a symlink as a stamp — and the only thing that can
    // keep it from unlinking the name is refusing to treat it as its own file.
    // This test pins the OUTCOME — the symlink and its target both survive a
    // full open, and a write behind it is refused — which is the property that
    // matters.
    //
    // It is worth saying plainly which guard is doing the work, because
    // mutation-testing found that THREE of them could be deleted here and this
    // test would still pass: the `lstat` shape test, the `O_NOFOLLOW` on the
    // stamp read, and the ELOOP handler. All three are real, and all three are
    // load-bearing on some path; on THIS path the removal guard is what refuses
    // first, so the outcome does not move. The shape test and the `O_NOFOLLOW`
    // are defence in depth against the name being swapped between the `lstat`
    // and the read, which a test cannot stage without a race it would rather
    // not have, and the ELOOP handler keeps a raw errno from escaping a
    // function whose only answers are "live" and "dead". Recorded here so the
    // next reader knows they are deliberate and not untested leftovers.
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok(store, "the store still opens: a leftover is never the reason to refuse to start");
    const listed = await readdir(root);
    assert.ok(listed.includes(lockName),
      "a symlinked lock is left exactly where it is, even though it points at a dead writer's stamp");
    assert.ok((await readdir(base)).includes("outside.lock"),
      "and the file it points at is untouched — nothing was followed and nothing was unlinked");
    // A write is refused: the O_EXCL create sees the name, and the store does
    // not clear a name it does not own to make room.
    const content = bytes("not written past a symlinked lock\n");
    const id = identity(PROJECT, FILE, content);
    await assert.rejects(store.put({ ...id, bytes: content }),
      (error: unknown) => error instanceof ResultFileStoreError);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: a leftover the store did not create in a PRIVATE place is never removed", async () => {
  // The review's note, now a test. The recovery deletes only names this store
  // itself created: a plain regular file, not a symlink, link count 1, owner
  // only. A world-writable leftover is exactly what an attacker would plant to
  // get the store to unlink a name of their choosing, so it is a refusal and the
  // recovery STOPS rather than proceeding past a name it does not own.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-mode-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockName = ".control-room-result-file-store.lock";
    // A DEAD writer's pid, so the stamp is readable and the lock IS provably
    // abandoned. The only thing standing between this and a deletion is the
    // mode of the file itself.
    await writeFile(join(root, lockName),
      `control-room-result-file-store-write\n${liveStamp(2147483646)}\n`, { mode: 0o600 });
    await chmod(join(root, lockName), 0o666);
    await assert.rejects(ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 }),
    (error: unknown) => error instanceof ResultFileStoreError,
    "a world-writable leftover is a refusal, not a deletion");
    assert.ok((await readdir(root)).includes(lockName),
      "and the name the store does not own is still there");
    // With the privateness restored it IS repaired, so the refusal above was the
    // mode and not the recovery having given up on the directory.
    await chmod(join(root, lockName), 0o600);
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok(store);
    assert.ok(!(await readdir(root)).includes(lockName),
      "the same leftover, private, is cleared — the refusal discriminates");
  } finally { await rm(base, { recursive: true, force: true }); }
});
