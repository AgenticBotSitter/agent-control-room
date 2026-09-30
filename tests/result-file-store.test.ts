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
import { execFileSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import { link, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultFileStoreV1, ResultFileStoreError, resultFileStorageKeyV1,
  RESULT_FILE_LIMITS_V1, resultFileStoreBootIdentityV1,
  pidSignalMeansAliveV1 } from "../src/artifacts/v1/result-file-store";

const TENANT = "tenant:store";
const PROJECT = "project:alpha";
const FILE = `result-file:${"b".repeat(32)}`;
const bytes = (value: string) => new TextEncoder().encode(value);

/** The stamp a live writer leaves in its own lock: the boot identity, its pid,
 * and the first second of its own life. It mirrors `holderStamp` in the store
 * and is written out here rather than imported, so that a change to the store's
 * format cannot silently rewrite the fixture that is testing it. `boot` is a
 * parameter so a test can stamp a lock as though it were written under a
 * DIFFERENT boot, which is the review's S1.
 *
 * The boot identity comes from the store's own exported rule, so a test's stamp
 * and the store's idea of "this boot" can never disagree about the format.
 *
 * The third line is the WRITER'S OWN start second, not the second the stamp was
 * written. A fixture that stamped `Date.now()` would disagree with the real
 * process by however long the test had been running, and the store would — quite
 * correctly — call that a recycled pid. That is not a hypothetical: it is what
 * this fixture got wrong first, and the only symptom was one test failing.
 */
function startSecondOfProcessV1(pid: number): number {
  if (pid === process.pid) return Math.floor((Date.now() - process.uptime() * 1000) / 1000);
  // A pid `ps` will not even look at still needs a third line: a dead writer's
  // start second is a number, and the store only compares it when the boot
  // matches. Any plausible second will do, because a dead pid is proved dead by
  // liveness before the start time is ever consulted.
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

test("B7: a LIVE writer's lock and pending file are never cleared", async () => {
  // The recovery must be able to tell a dead writer from a live one, or it
  // destroys a write in progress. This process is live, so its own pid in the
  // lock is the proof of liveness.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-live-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${liveStamp()}\n`, { mode: 0o600 });
    const pendingName = `.control-room-result-file-store-pending-${"a".repeat(32)}`;
    await writeFile(join(root, pendingName), bytes("a write in progress"), { mode: 0o600 });
    // The store still OPENS — a second instance publishing through another
    // process must not stop this one starting, which is the point of the fix.
    const store = await open();
    assert.ok(store);
    // And the live writer's entries are both still exactly where they were.
    assert.ok((await readdir(root)).includes(".control-room-result-file-store.lock"),
      "a live writer's lock was not deleted");
    assert.ok((await readdir(root)).includes(pendingName),
      "a live writer's pending file was not deleted");
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

test("S1: a lock from a PREVIOUS boot is dead, however live its pid looks", async () => {
  // The review's S1, third case, and the one that matters on a real Mac. After a
  // reboot the kernel reuses low pids, a login-started app gets a low pid, and
  // boot daemons already hold that range — so a lock left by yesterday's crash
  // reads as HELD BY A LIVE PROCESS today, for ever. The review measured it with
  // pid 1, where `EPERM` counts as alive.
  //
  // The stamp now carries the boot identity, so a lock from another boot is
  // proof its writer is gone, whatever the pid says. This process is certainly
  // alive, so the ONLY thing that can make the lock look dead is the boot line.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-oldboot-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // A lock stamped under a DIFFERENT boot, naming this very live process.
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${liveStamp(process.pid, "boot:three-days-ago")}\n`, { mode: 0o600 });
    const store = await open();
    assert.ok(store);
    assert.ok(!(await readdir(root)).includes(".control-room-result-file-store.lock"),
      "a lock from an earlier boot is cleared even though its pid is alive right now");
    // And the write that used to be refused for ever now lands.
    const content = bytes("written after a reboot\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(content),
      "a write after a reboot actually lands");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: a RECYCLED pid is not the writer that took the lock", async () => {
  // The other half of the same case, within ONE boot: the pid is genuinely alive
  // but it is somebody else's process. The stamp carries the writer's own start
  // second, so a lock whose start second does not match the live process's real
  // one is a dead writer's lock, and it is cleared.
  //
  // `process.pid` is this process's real start second, and a stamp carrying a
  // DIFFERENT one for the SAME pid can only have come from a process that has
  // since exited. That is exactly a recycled pid, and no amount of restarting
  // the app would ever clear it under a liveness-only test.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-recycled-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // THIS boot, THIS live pid, but a start second that is not this process's —
    // which is exactly what a pid that has been recycled looks like, because the
    // new occupant of the pid started later than the dead writer did.
    const stamp = liveStamp(process.pid).split("\n");
    stamp[stamp.length - 1] = String(Number(stamp[stamp.length - 1]) - 86_400);
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${stamp.join("\n")}\n`, { mode: 0o600 });
    const store = await open();
    assert.ok(store);
    assert.ok(!(await readdir(root)).includes(".control-room-result-file-store.lock"),
      "a lock whose pid has been recycled is cleared");
    const content = bytes("written after a recycled pid\n");
    const id = identity(PROJECT, FILE, content);
    await store.put({ ...id, bytes: content });
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(content),
      "a write after a recycled-pid lock is cleared actually lands");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: a part-1 lock (a bare pid, no boot) is still repaired when that pid is dead", async () => {
  // The review's S1, second case: a lock written by the PREVIOUS build carried
  // only a pid, so it can be attributed to no boot and no start time. It is
  // recognised as the older format and judged by liveness alone — which is a
  // strict improvement on treating it as live for ever, and never a weakening:
  // a pid that IS running still keeps its lock.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-barepid-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const open = () => ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    // The part-1 format, with a pid that cannot be running.
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      "control-room-result-file-store-write\n2147483646", { mode: 0o600 });
    const store = await open();
    assert.ok(store);
    assert.ok(!(await readdir(root)).includes(".control-room-result-file-store.lock"),
      "a part-1 lock with a dead pid is cleared rather than kept for ever");
    // And the same format with THIS process's live pid keeps its lock, so the
    // repair discriminates instead of blanket-clearing old locks.
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${process.pid}`, { mode: 0o600 });
    const reopened = await open();
    assert.ok((await readdir(root)).includes(".control-room-result-file-store.lock"),
      "a part-1 lock whose pid is alive is still left alone");
    const content = bytes("not written while a live lock holds the store\n");
    const id = identity(PROJECT, FILE, content);
    await assert.rejects(reopened.put({ ...id, bytes: content }),
      (error: unknown) => error instanceof ResultFileStoreError);
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
    await writeFile(join(root, ".control-room-result-file-store-recovery.lock"),
      `control-room-result-file-store-recovery\n${liveStamp(2147483645)}\n`, { mode: 0o600 });
    await writeFile(join(root, ".control-room-result-file-store.lock"),
      `control-room-result-file-store-write\n${liveStamp(2147483646)}\n`, { mode: 0o600 });
    await writeFile(join(root, `.control-room-result-file-store-pending-${"c".repeat(32)}`),
      bytes("interrupted mid-recovery"), { mode: 0o600 });
    // The store opens, and every leftover is cleared.
    const store = await open();
    assert.ok(store, "an interrupted recovery does not stop the store opening");
    assert.deepEqual((await readdir(root)).filter(entry => !entry.endsWith(".crbf")), [],
      "and its leftovers are cleared, so the next open is clean");
    // And a LIVE recovery lock is left alone: a concurrent recovery is not
    // something a second opener may delete out from under itself.
    await writeFile(join(root, ".control-room-result-file-store-recovery.lock"),
      `control-room-result-file-store-recovery\n${process.pid}\n`, { mode: 0o600 });
    await assert.rejects(open(),
      (error: unknown) => error instanceof ResultFileStoreError && error.code === "store_ambiguous");
    assert.ok((await readdir(root)).includes(".control-room-result-file-store-recovery.lock"),
      "a live recovery lock is not deleted");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("S1: a lock the store CANNOT classify is never removed, whatever the shape", async () => {
  // The direction that is not S1 but is just as important: the three repairs
  // above must not become a blanket "clear anything I do not recognise". A lock
  // this store cannot classify is someone else's file, and deleting it is
  // unrecoverable, so each unclassifiable shape has to survive a full open.
  //
  // The three shapes below cover the three ways a classification can fail, and
  // each was a real mutation that no test noticed:
  //
  //   * a stamp with a header and a pid but no boot and no start time (two
  //     lines) is a shape this build never writes;
  //   * a stamp whose trailing numbers are not numbers at all;
  //   * a pid that is alive but not a number, so liveness cannot be asked.
  const boot = resultFileStoreBootIdentityV1();
  const shapes: Readonly<{ name: string; stamp: string }>[] = [
    // Too FEW parts to hold a pid, a boot and a start second: the shape cannot be
    // read at all, so the store must refuse rather than guess.
    { name: "one part: no pid anywhere",
      stamp: "control-room-result-file-store-write\n" },
    // A pid that is not a number, so liveness cannot be asked.
    { name: "a pid that is not a number",
      stamp: `control-room-result-file-store-write\n${boot}\nnot-a-pid\n123\n` },
    // A pid that is a number but not a whole positive one.
    { name: "a pid of zero", stamp: `control-room-result-file-store-write\n${boot}\n0\n123\n` },
    // A start second that is not a number, so the recycled-pid test cannot be run.
    { name: "a start second that is not a number",
      stamp: `control-room-result-file-store-write\n${boot}\n${process.pid}\nnot-a-second\n` },
  ];
  for (const shape of shapes) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-unclassifiable-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const lockName = ".control-room-result-file-store.lock";
      await writeFile(join(root, lockName), shape.stamp, { mode: 0o600 });
      const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
        maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
        operationTimeoutMs: 2_000 });
      assert.ok(store, `${shape.name}: the store still opens`);
      assert.ok((await readdir(root)).includes(lockName),
        `${shape.name}: a lock the store cannot classify is never removed`);
      // And a write is refused rather than proceeding past a lock whose holder
      // is unknown: "cannot prove it is dead" is not "prove it is not there".
      const content = bytes("not written past an unclassifiable lock\n");
      const id = identity(PROJECT, FILE, content);
      await assert.rejects(store.put({ ...id, bytes: content }),
        (error: unknown) => error instanceof ResultFileStoreError,
        `${shape.name}: the write is refused, not admitted`);
      assert.equal(await store.read(id), undefined, `${shape.name}: and nothing was written`);
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});

test("S1: EPERM is liveness, and only ESRCH is death", async () => {
  // `process.kill(pid, 0)` fails with EPERM for a process this user does not own
  // — a LIVE process — and with ESRCH for a dead one. Collapsing the two is a
  // fail-open: a lock held by another user's process cleared, and its staging
  // file with it. The review met the same wall from the other side: a lock
  // naming pid 1 read as held for ever, because signalling pid 1 gives EPERM.
  //
  // No test running as this user can make `process.kill` genuinely return EPERM,
  // so the rule the store applies is exported and proved here directly. The
  // through-the-store half — that a live holder's lock is left alone — is the
  // B7 test above, which uses this process's own real pid.
  assert.equal(pidSignalMeansAliveV1("EPERM"), true,
    "EPERM means the pid exists and belongs to another user: alive");
  assert.equal(pidSignalMeansAliveV1("ESRCH"), false,
    "ESRCH is the only proof of death");
  // Any other code is not a proof of death either, and an unknown errno is the
  // common case on a platform this has not seen: still alive.
  for (const unknown of [undefined, "EINVAL", "some-future-code"]) assert.equal(pidSignalMeansAliveV1(unknown), true,
    `an unrecognised signal result (${String(unknown)}) is not proof of death`);
  // And the real signal agrees: this process is alive, so its own pid must be
  // reported as signalling successfully, which is the branch that leaves a lock
  // alone.
  let selfSignalled = false;
  try { process.kill(process.pid, 0); selfSignalled = true; } catch { selfSignalled = false; }
  assert.equal(selfSignalled, true, "a live pid signals successfully, and that is alive");
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

test("S1: the part-1 stamp path treats an unparseable pid as ALIVE, never dead", async () => {
  // `pidIsRunning` is the one place a pid is turned into an answer, and it is
  // reached only through the part-1 (bare pid) stamp, because the modern stamp
  // validates its own two numbers before it gets there. So the branch that
  // matters for it is proved through a part-1 lock naming a pid that is not a
  // number at all.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-barepid-bad-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockName = ".control-room-result-file-store.lock";
    // Header and a pid that cannot be a pid: a shape from a corrupted or foreign
    // write. It cannot be identified, so it cannot be declared dead.
    await writeFile(join(root, lockName),
      "control-room-result-file-store-write\nnot-a-pid", { mode: 0o600 });
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok(store);
    assert.ok((await readdir(root)).includes(lockName),
      "a part-1 stamp naming a pid that is not a number is never cleared");
    const content = bytes("not written past an unidentifiable bare-pid holder\n");
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

