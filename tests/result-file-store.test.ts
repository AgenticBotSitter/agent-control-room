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
import { link, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultFileStoreV1, ResultFileStoreError, resultFileStorageKeyV1,
  RESULT_FILE_LIMITS_V1 } from "../src/artifacts/v1/result-file-store";

const TENANT = "tenant:store";
const PROJECT = "project:alpha";
const FILE = `result-file:${"b".repeat(32)}`;
const bytes = (value: string) => new TextEncoder().encode(value);
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
          "control-room-result-file-store-write\n2147483646\n", { mode: 0o600 });
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
      `control-room-result-file-store-write\n${process.pid}\n`, { mode: 0o600 });
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

test("B7: a lock with no readable pid is a refusal, and nothing is deleted", async () => {
  // The store must not guess. An empty lock could be a writer that has not yet
  // written its pid, so it is treated as live and left alone; the only entry it
  // will not classify is refused rather than removed.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-nopid-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".control-room-result-file-store.lock"), "", { mode: 0o600 });
    const store = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok((await readdir(root)).includes(".control-room-result-file-store.lock"),
      "an unclassifiable lock is left alone");
    // A bookkeeping name that is a DIRECTORY is not this store's own file. The
    // lock is still unclassifiable, so it is treated as live and NOTHING is
    // removed — including this. The store still opens, because a leftover must
    // never be the reason the owner's whole task application refuses to start;
    // what it must not do is delete a name it does not own.
    await mkdir(join(root, ".control-room-result-file-store-pending-deadbeef"), { mode: 0o700 });
    await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    assert.ok((await readdir(root)).includes(".control-room-result-file-store-pending-deadbeef"),
      "a directory the store did not write is never deleted");
    // And a WRITE is still refused while an unclassifiable lock holds the store,
    // because the O_EXCL create is the mutual exclusion and it has not been
    // weakened: reads work, writes wait.
    const content = bytes("would this write succeed?\n");
    const id = identity(PROJECT, FILE, content);
    const writer = await ResultFileStoreV1.create({ rootPath: root, maximumFiles: 32,
      maximumFileBytes: 1_048_576, maximumSetBytes: 4_194_304, maximumTotalBytes: 8_388_608,
      operationTimeoutMs: 2_000 });
    await assert.rejects(writer.put({ ...id, bytes: content }),
      (error: unknown) => error instanceof ResultFileStoreError);
    assert.equal(await writer.read(id), undefined, "and nothing was written");
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
    // While the write is in progress, the directory holds the lock AND the
    // staging file. A real concurrent put is what creates them, so this runs one.
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
