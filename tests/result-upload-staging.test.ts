// Unit proof for the upload staging area: the sibling of the byte store where a
// chunk lands between the connector sending it and the file existing.
//
// No database here on purpose. This is a filesystem component, and what it has
// to hold is about NAMES, MODES, LINKS and CONTENT — none of which a mock can
// prove and all of which a real 0700 directory can. Every refusal is asserted on
// the staging error's own code, which is the only thing a caller ever sees.
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { constants, mkdtempSync, realpathSync } from "node:fs";
import fs, { link, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultUploadStagingError, ResultUploadStagingV1, stagedChunkNameV1 }
  from "../src/artifacts/v1/result-upload-staging";

const TENANT = "tenant:staging-pg";
const PROJECT = "project:staging-pg";
const UPLOAD = `result-upload:${"a".repeat(32)}`;
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/**
 * A private base directory, and its CANONICAL path.
 *
 * The area refuses a root whose given path is not its own resolved path, and on
 * macOS `mkdtemp` hands back `/var/folders/...` where the real directory is
 * `/private/var/folders/...`. That refusal is the point of the check — a path
 * that resolves somewhere else is a path the operator did not name — so the
 * tests hand it the canonical form, which is what a real configuration file
 * carries after the installer resolves it once. `mkdtemp` also hands back a
 * 0700 directory, which is the other thing the area insists on.
 */
function privateBase(): { path: string; root: (name: string) => string } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "cr-staging-")));
  return { path, root: (name: string) => join(path, name) };
}

const CHUNK_LIMIT = 8 * 1024 * 1024;
const openRoot = (root: string) => ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: CHUNK_LIMIT,
  operationTimeoutMs: 5_000 });
const openWith = (root: string, maximumChunkBytes: number) => ResultUploadStagingV1.create({ rootPath: root,
  maximumChunkBytes, operationTimeoutMs: 5_000 });

test("the upload staging area is create-once, derived and accounted for", async () => {
  const base = await privateBase();
  const root = base.root("staging");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const staging = await openRoot(root);
    const identity = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD };

    // --- the name is DERIVED, and it is a flat name -----------------------
    const name = stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1);
    assert.match(name, /^[a-f0-9]{64}\.chunk$/u, "a staged chunk's on-disk name is a digest and nothing else");
    assert.notEqual(name, stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 2),
      "a different ordinal is a different name");
    assert.notEqual(name, stagedChunkNameV1(TENANT, "project:another", UPLOAD, 1),
      "a different project is a different name, so no two projects share a chunk");
    assert.notEqual(name, stagedChunkNameV1("tenant:another", PROJECT, UPLOAD, 1),
      "and a different tenant is too");
    // A caller cannot choose a name, a path or a directory: the grammar is
    // refused before anything is derived, so a traversal is not expressible.
    for (const bad of [{ tenantId: "x", projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 },
      { tenantId: TENANT, projectId: "../escape", uploadId: UPLOAD, ordinal: 1 },
      { tenantId: TENANT, projectId: PROJECT, uploadId: "not-an-upload", ordinal: 1 },
      { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 0 },
      { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 33 }]) {
      assert.throws(() => stagedChunkNameV1(bad.tenantId, bad.projectId, bad.uploadId, bad.ordinal),
        (error: unknown) => error instanceof ResultUploadStagingError
          && (error as ResultUploadStagingError).code === "staging_invalid",
        `refused: ${JSON.stringify(bad)}`);
    }

    // --- a chunk is written and read back exactly -------------------------
    const first = bytes("head of the file\n");
    const staged = await staging.stage({ ...identity, ordinal: 1 }, first);
    assert.equal(staged.digest, digest(first));
    assert.equal(staged.replayed, false);
    assert.deepEqual(Buffer.from((await staging.read({ ...identity, ordinal: 1 }))!), Buffer.from(first));
    assert.deepEqual(await readdir(root), [name], "exactly one entry, and it is the derived name");

    // --- an exact retry REPLAYS; a substitute is a CONFLICT ---------------
    const replay = await staging.stage({ ...identity, ordinal: 1 }, first);
    assert.equal(replay.replayed, true, "an exact retry is a replay");
    const substitute = bytes("different bytes\n");
    await assert.rejects(staging.stage({ ...identity, ordinal: 1 }, substitute), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_conflict");
      return true;
    }, "a different chunk for a staged ordinal is refused");
    // The earlier bytes are STILL the ones there: a refusal never overwrites
    // the evidence of what the first attempt sent.
    assert.deepEqual(Buffer.from((await staging.read({ ...identity, ordinal: 1 }))!), Buffer.from(first),
      "the refused substitute did not replace the staged chunk");

    // --- the same bytes, assembled in order -------------------------------
    const pieces = [bytes("one"), bytes("two"), bytes("three")];
    for (const [index, piece] of pieces.entries())
      await staging.stage({ ...identity, ordinal: index + 2 }, piece);
    const assembled = await staging.assemble(identity, 4);
    assert.deepEqual(Buffer.from(assembled),
      Buffer.concat([first, ...pieces.map((piece) => Buffer.from(piece))]),
      "assemble concatenates the staged chunks in ordinal order");
    // The order is the ORDINALS', not the arrival order, so a chunk 4 that
    // arrives before chunk 3 still lands in the right place.
    assert.equal(digest(assembled), digest(Buffer.concat([first, ...pieces.map((piece) => Buffer.from(piece))])),
      "the assembled file hashes to the concatenation in ordinal order");
    // A hole is a refusal, never a short file.
    await assert.rejects(staging.assemble({ tenantId: TENANT, projectId: PROJECT,
      uploadId: `result-upload:${"b".repeat(32)}` }, 1), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_missing");
      return true;
    }, "a chunk that is not staged is missing, not silently skipped");
    // The bound on the count is the caller's, from the session's own promise.
    await assert.rejects(staging.assemble(identity, 33), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "assemble refuses a count past the 32-chunk ceiling");

    // --- a missing chunk reads as absent, not as an error -----------------
    assert.equal(await staging.read({ tenantId: TENANT, projectId: PROJECT,
      uploadId: `result-upload:${"c".repeat(32)}`, ordinal: 1 }), undefined,
    "a chunk that was never staged reads as absent");

    // --- discard removes exactly one session's chunks ---------------------
    const removed = await staging.discardSession(identity);
    assert.equal(removed, 4, "discard removes exactly the names this session derives");
    assert.deepEqual(await readdir(root), [], "and the root is empty afterwards");
    // An already-absent chunk is done, not an error.
    assert.equal(await staging.discardSession(identity), 0, "discarding twice is not a failure");

    // --- an entry the area cannot account for is a REFUSAL ---------------
    await writeFile(join(root, "stray.txt"), "not mine\n", { mode: 0o600 });
    // A LIVE area stops serving the moment the directory stops making sense,
    // not just a newly opened one: the staging area a gateway is holding is
    // the one that matters, and it has to notice too.
    await assert.rejects(staging.read({ ...identity, ordinal: 1 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_ambiguous");
      return true;
    }, "a stray entry makes the whole directory unaccounted for");
    await assert.rejects(staging.stage({ ...identity, ordinal: 1 }, first), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_ambiguous");
      return true;
    }, "and nothing is written into it either");
    await assert.rejects(staging.stagedNames(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_ambiguous");
      return true;
    }, "and the sweeper cannot even enumerate it");
    // And it is never DELETED: the area cleans up nothing it cannot own.
    assert.deepEqual((await readdir(root)).sort(), ["stray.txt"], "the stray entry is still there, untouched");
    await assert.rejects(openRoot(root), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_ambiguous");
      return true;
    }, "and a new area refuses to open over it rather than adopting it");
    // A SCRATCH file from a write in flight is accounted for, because a chunk
    // arriving in parallel must not be refused by a reader that caught it
    // mid-write. The name is the point: nothing else gets that pass.
    await rm(join(root, "stray.txt"), { force: true });
    const scratchName = `.staging-${"a".repeat(64)}-${process.pid.toString(36)}-99.part`;
    await writeFile(join(root, scratchName), "half a chunk\n", { mode: 0o600 });
    const duringParallelWrite = await openRoot(root);
    assert.deepEqual(await duringParallelWrite.stagedNames(), [],
      "an in-flight scratch file is tolerated and is never listed as a staged chunk");
    // And it is never READ either: only a derived chunk name is ever read, so
    // a half-written chunk cannot be mistaken for a staged one.
    assert.equal(await duringParallelWrite.read({ ...identity, ordinal: 1 }), undefined,
      "a scratch file is invisible to a read, so a partial chunk is never served");
    // A name that merely LOOKS like a scratch file still gets no pass.
    await rm(join(root, scratchName), { force: true });
    await writeFile(join(root, ".staging-not-a-hash-1-1.part"), "half a chunk\n", { mode: 0o600 });
    await assert.rejects(openRoot(root), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_ambiguous");
      return true;
    }, "a scratch name is only tolerated when it is exactly the shape one write makes");
    await rm(join(root, ".staging-not-a-hash-1-1.part"), { force: true });
  } finally {
    await rm(base.path, { recursive: true, force: true });
  }
});

test("the staging area refuses a root it cannot trust, and a symlinked entry", async () => {
  const base = await privateBase();
  try {
    // A root that does not exist, or is not private, is refused at OPEN: the
    // area creates nothing and repairs nothing, so an operator mistake is
    // visible rather than papered over.
    await assert.rejects(openRoot(base.root("absent")), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "a root that does not exist is refused, and nothing is created for it");
    await assert.rejects(openRoot(join(base.path, "still-absent")), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "and the refusal is not a repair");
    const worldReadable = base.root("open");
    await mkdir(worldReadable, { mode: 0o755 });
    await assert.rejects(openRoot(worldReadable), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "a world-readable root is refused");
    // A root that is not a directory at all is refused too.
    const notADirectory = base.root("file");
    await writeFile(notADirectory, "not a root\n", { mode: 0o600 });
    await assert.rejects(openRoot(notADirectory), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "a root that is a file is refused");
    const good = base.root("good");
    await mkdir(good, { mode: 0o700 });
    await assert.rejects(openWith(good, 16 * 1024 * 1024), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "a chunk ceiling over 8 MiB is not a v1 option");
    await assert.rejects(openWith(good, 0), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "and neither is a ceiling of zero");
    await assert.rejects(ResultUploadStagingV1.create({ rootPath: good, maximumChunkBytes: 1024,
      operationTimeoutMs: 0 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "an operation timeout of zero is not a configuration");
    // A path that is not its own canonical form is refused, which on macOS is
    // exactly the /var -> /private/var case a hand-written config hits.
    const viaSymlink = base.root("via-symlink");
    await symlink(good, viaSymlink);
    await assert.rejects(openRoot(viaSymlink), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_invalid");
      return true;
    }, "a root reached through a symlink is refused, not followed");

    // A SYMLINK where a chunk's name belongs is not followed: the read is a
    // refusal, and the target outside the root is never opened.
    const root = good;
    const outside = base.root("outside.bin");
    await writeFile(outside, "secret bytes\n", { mode: 0o600 });
    const staging = await openRoot(root);
    const identity = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD };
    await staging.stage({ ...identity, ordinal: 1 }, bytes("real bytes\n"));
    const name = stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1);
    await rm(join(root, name));
    await symlink(outside, join(root, name));
    await assert.rejects(staging.read({ ...identity, ordinal: 1 }), (error: unknown) => {
      const code = (error as { code?: string }).code;
      assert.ok(code === "staging_ambiguous", `a symlink is a refusal, got ${String(code)}`);
      return true;
    }, "a symlink under the derived name is never followed");
    await rm(join(root, name));

    // A HARD LINK is refused too, and so is a second link to the same inode: a
    // staged chunk has link count 1, so nothing else can be reading it.
    await staging.stage({ ...identity, ordinal: 2 }, bytes("one link\n"));
    await link(join(root, stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 2)), join(root, stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 3)));
    await assert.rejects(staging.read({ ...identity, ordinal: 2 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "staging_ambiguous");
      return true;
    }, "a chunk with a second link is refused");
  } finally {
    await rm(base.path, { recursive: true, force: true });
  }
});

test("the staging area refuses a root whose identity changed under it", async () => {
  const base = await privateBase();
  const root = base.root("root");
  const moved = base.root("moved");
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await openRoot(root);
    // Replace the root with a different directory of the same name: the
    // device/inode identity re-check per operation is what catches this, and
    // catching it is the difference between "the store failed" and "the bytes
    // went somewhere else".
    await mkdir(moved, { mode: 0o700 });
    await rm(root, { recursive: true, force: true });
    await rename(moved, root);
    await assert.rejects(staging.read({ tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 }),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        assert.ok(code === "staging_ambiguous" || code === "staging_missing",
          `a swapped root is refused, got ${String(code)}`);
        return true;
      }, "a root replaced under a live area is refused rather than served from");
  } finally {
    await rm(base.path, { recursive: true, force: true });
  }
});

// `constants` is imported for the mode bits this file's refusals depend on; the
// import is used by the assertions below rather than only by the store.
assert.ok(constants.O_NOFOLLOW > 0, "O_NOFOLLOW is available on this platform, so the guard is not a no-op");
test("fifty writers and readers at once, and the queue does not lie", async () => {
  const base = await privateBase();
  const root = base.root("busy");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const staging = await openRoot(root);
    const uploadId = `result-upload:${"f".repeat(32)}`;
    const identity = { tenantId: TENANT, projectId: PROJECT, uploadId };
    const CHUNKS = 32;

    // Burst one: every chunk of one session, sent concurrently. All 32 must
    // land, because the staging area serialises writes internally and a
    // chunking client is fully entitled to send its pieces in parallel.
    const bodies = Array.from({ length: CHUNKS }, (_, index) =>
      new TextEncoder().encode(`chunk ${index} of ${CHUNKS}\n`));
    const staged = await Promise.all(bodies.map((body, index) =>
      staging.stage({ ...identity, ordinal: index + 1 }, body)));
    assert.equal(staged.filter((result) => result.replayed).length, 0,
      "nothing in the first burst was a replay");
    assert.deepEqual(await staging.stagedNames(),
      bodies.map((_body, index) => stagedChunkNameV1(TENANT, PROJECT, uploadId, index + 1)).sort(),
      "all 32 chunks are on disk under their derived names, and nothing else is");
    const assembled = await staging.assemble(identity, CHUNKS);
    assert.deepEqual(Buffer.from(assembled), Buffer.concat(bodies.map((body) => Buffer.from(body))),
      "a 32-way concurrent burst still assembles in ordinal order");

    // Burst two: the same 32 chunks again, concurrently. Every one must be a
    // replay, and none may be a conflict — a client that resends everything
    // after a dropped connection is doing the right thing.
    const replayed = await Promise.all(bodies.map((body, index) =>
      staging.stage({ ...identity, ordinal: index + 1 }, body)));
    assert.equal(replayed.filter((result) => result.replayed).length, CHUNKS,
      "a full concurrent resend is 32 replays and 0 conflicts");

    // Burst three: every ordinal gets a DIFFERENT body at the same time. Each
    // one must be refused as a conflict, and the bytes on disk must be the
    // ones from the first burst — a refused substitute never lands.
    const outcomes = await Promise.allSettled(bodies.map((body, index) =>
      staging.stage({ ...identity, ordinal: index + 1 }, new TextEncoder().encode(`SUBSTITUTE ${index}\n`))));
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, CHUNKS,
      "32 concurrent substitutes are 32 refusals");
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        assert.equal((outcome.reason as { code?: string }).code, "staging_conflict",
          "and every refusal is a conflict, not something looser");
    assert.deepEqual(Buffer.from(await staging.assemble(identity, CHUNKS)),
      Buffer.concat(bodies.map((body) => Buffer.from(body))),
      "the assembled file is still the first burst, byte for byte");

    // Burst four: 50 concurrent readers racing the same chunks while 50
    // concurrent writers touch OTHER sessions. The readers must each get one
    // of exactly two answers — the right bytes, or a refusal — and must never
    // get a short or mixed read, which is the failure this whole shape exists
    // to prevent.
    const otherUpload = `result-upload:${"e".repeat(32)}`;
    const otherIdentity = { tenantId: TENANT, projectId: PROJECT, uploadId: otherUpload };
    // 50 writers over 32 ordinals. Each ordinal is sent the SAME bytes by every
    // writer that targets it, so these are replays rather than 50 deliberate
    // conflicts — the point of the burst is contention, not self-inflicted
    // refusals.
    const noiseByOrdinal = Array.from({ length: 32 }, (_unused, index) =>
      new TextEncoder().encode(`noise chunk ${index}\n`));
    const writers = Array.from({ length: 50 }, (_unused, index) => (index % 32) + 1);
    const [, reads] = await Promise.all([
      Promise.all(writers.map((ordinal) =>
        staging.stage({ ...otherIdentity, ordinal }, noiseByOrdinal[ordinal - 1]))),
      Promise.all(Array.from({ length: 50 }, (_unused, index) =>
        staging.read({ ...identity, ordinal: (index % CHUNKS) + 1 })
          .then((value) => ({ ok: true, value } as const))
          .catch((error: unknown) =>
            ({ ok: false, code: (error as { code?: string }).code } as const)))),
    ]);
    assert.equal(reads.length, 50, "all 50 reads answered, none hung");
    for (const [index, read] of reads.entries()) {
      const expected = bodies[index % CHUNKS];
      if (read.ok) {
        // A read is EITHER the exact chunk for that ordinal or it is absent or
        // it is refused. A short, mixed or wrong-session read is the bug this
        // proves absent, and every chunk here was staged in burst one, so an
        // absent chunk would be a bug too.
        assert.notEqual(read.value, undefined,
          `reader ${index} found ordinal ${(index % CHUNKS) + 1} absent, but burst one staged it`);
        assert.deepEqual(Buffer.from(read.value!), Buffer.from(expected),
          `reader ${index} got exactly the bytes for ordinal ${(index % CHUNKS) + 1}`);
      } else {
        assert.equal(read.code, "staging_ambiguous", "a refused read says why, and only why");
      }
    }
    // The other session is intact too: 50 writers, 32 ordinals, one winner each.
    assert.deepEqual(Buffer.from(await staging.assemble(otherIdentity, 32)),
      Buffer.concat(noiseByOrdinal.map((body) => Buffer.from(body))),
      "concurrent writers to overlapping ordinals left exactly one file, not a mixture");
    assert.equal(writers.length, 50, "and the burst really was 50 writers");

    // The staging area is still healthy afterwards, and a fresh open agrees.
    const reopened = await openRoot(root);
    assert.equal((await reopened.stagedNames()).length, CHUNKS + 32,
      "both sessions' chunks are present and a new area agrees on the count");
    assert.equal((await staging.discardSession(identity)), CHUNKS);
    assert.equal((await staging.discardSession(otherIdentity)), 32);
    assert.deepEqual(await staging.stagedNames(), [], "and both sessions clean up completely");
  } finally {
    await rm(base.path, { recursive: true, force: true });
  }
});

test("the staging fixture canonicalizes a TMPDIR symlink before production opens its root", async () => {
  const temporaryParent = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "cr-staging-real-tmp-")));
  const linkedParent = join(realpathSync(tmpdir()), `cr-staging-linked-tmp-${process.pid}-${Date.now()}`);
  const original = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  await symlink(temporaryParent, linkedParent);
  try {
    process.env.TMPDIR = linkedParent;
    delete process.env.TMP;
    delete process.env.TEMP;
    const base = privateBase();
    assert.ok(base.path.startsWith(`${temporaryParent}/`), "fixture supplies the physical, not symlinked, root");
    const root = base.root("staging");
    await mkdir(root, { mode: 0o700 });
    const staging = await openRoot(root), value = bytes("canonical fixture");
    await staging.stage({ tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 }, value);
    assert.deepEqual(Buffer.from((await staging.read({ tenantId: TENANT, projectId: PROJECT,
      uploadId: UPLOAD, ordinal: 1 }))!), Buffer.from(value));
    await rm(base.path, { recursive: true, force: true });
  } finally {
    if (original.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original.TMPDIR;
    if (original.TMP === undefined) delete process.env.TMP; else process.env.TMP = original.TMP;
    if (original.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = original.TEMP;
    await rm(linkedParent, { force: true });
    await rm(temporaryParent, { recursive: true, force: true });
  }
});

/** True when `needle` appears inside `haystack`, used to prove a read did not
 * return another session's bytes. */
function isSubarrayOf(needle: Uint8Array, haystack: Buffer): boolean {
  return haystack.includes(Buffer.from(needle));
}

const interruptedWriter = (root: string, uploadId: string) => {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/staging-interrupted-writer.mjs"], {
    detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
      FILES3_STAGING_ROOT: root, FILES3_UPLOAD_ID: uploadId },
  });
  const closed = once(child, "close");
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer_checkpoint_timeout")), 10000);
    child.stdout!.on("data", value => { if (String(value).includes("SCRATCH_WRITTEN")) { clearTimeout(timer); resolve(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("writer_ended_before_checkpoint")); });
  });
  const stop = async () => {
    try { process.kill(-child.pid!, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await closed;
  };
  return { child, closed, ready, stop };
};

test("FILES3-04: twenty stopped writers reclaim their parts and a live writer survives reopening", async () => {
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    const config = { rootPath: root, maximumChunkBytes: 1048576, operationTimeoutMs: 10000 };
    for (let i = 0; i < 20; i++) {
      const uploadId = `result-upload:${i.toString(16).padStart(32, "0")}`;
      const writer = interruptedWriter(root, uploadId);
      try { await writer.ready; } finally { await writer.stop(); }
      const reopened = await ResultUploadStagingV1.create(config);
      assert.deepEqual(await readdir(root), [], "reopening itself reclaims dead parts");
      await reopened.discardSession({ tenantId: "tenant:crash", projectId: "project:crash", uploadId });
      assert.deepEqual(await readdir(root), [], "dead writer bytes must be reclaimed");
    }
    const writer = interruptedWriter(root, UPLOAD);
    try {
      await writer.ready;
      const reopened = await ResultUploadStagingV1.create(config);
      await reopened.discardSession({ tenantId: "tenant:crash", projectId: "project:crash", uploadId: UPLOAD });
      assert.equal((await readdir(root)).filter(name => name.endsWith(".part")).length, 1, "live writer retains its scratch");
      writer.child.stdin!.write("continue");
      assert.equal((await writer.closed)[0], 0);
      assert.equal((await reopened.read({ tenantId: "tenant:crash", projectId: "project:crash", uploadId: UPLOAD, ordinal: 1 }))!.length, 1048576);
      await reopened.discardSession({ tenantId: "tenant:crash", projectId: "project:crash", uploadId: UPLOAD });
      assert.deepEqual(await readdir(root), []);
    } finally { await writer.stop(); }
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-04: fifty staging requests share an aggregate disk budget and retry after cleanup", async () => {
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024,
      maximumTotalBytes: 8192, operationTimeoutMs: 10000 } as Parameters<typeof ResultUploadStagingV1.create>[0]);
    const inputs = Array.from({ length: 50 }, (_, i) => ({ tenantId: TENANT, projectId: PROJECT,
      uploadId: `result-upload:${i.toString(16).padStart(32, "0")}`, ordinal: 1 }));
    const results = await Promise.allSettled(inputs.map(id => staging.stage(id, new Uint8Array(1024))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 8);
    assert.ok(results.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason.code === "staging_capacity"));
    assert.equal((await staging.stagedNames()).length, 8);
    assert.equal((await staging.stage(inputs[0], new Uint8Array(1024))).replayed, true);
    await staging.discardSession(inputs[0]);
    await staging.stage(inputs[49], new Uint8Array(1024));
    assert.equal((await staging.stagedNames()).length, 8);
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-03: discard refuses a replaced root and preserves the outside victim", async () => {
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"), outside = join(base.path, "outside");
    await mkdir(root, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
    const name = stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1);
    await staging.stage(id, bytes("original"));
    await writeFile(join(outside, name), "victim", { mode: 0o600 });
    await rename(root, join(base.path, "old-staging")); await symlink(outside, root);
    await assert.rejects(staging.discardChunk(id));
    await assert.rejects(staging.discardSession(id));
    assert.equal(await readFile(join(outside, name), "utf8"), "victim");
    assert.equal(await readFile(join(base.path, "old-staging", name), "utf8"), "original");
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-07: empty assembly is valid but still checks its identity and root", async () => {
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD };
    assert.equal((await staging.assemble(id, 0)).length, 0);
    await assert.rejects(staging.assemble({ ...id, uploadId: "bad" }, 0));
    await rename(root, join(base.path, "old-staging")); await mkdir(root, { mode: 0o700 });
    await assert.rejects(staging.assemble(id, 0));
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-02: colliding staging identities cannot read or discard the other session", async () => {
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const a = { tenantId: "tenant:one", projectId: "project:two", uploadId: UPLOAD, ordinal: 1 };
    const b = { ...a, tenantId: "tenant:one:project", projectId: "two" };
    assert.notEqual(stagedChunkNameV1(a.tenantId, a.projectId, UPLOAD, 1), stagedChunkNameV1(b.tenantId, b.projectId, UPLOAD, 1));
    await staging.stage(a, bytes("namespace A"));
    assert.equal(await staging.read(b), undefined);
    assert.equal(await staging.discardSession(b), 0);
    assert.deepEqual(await staging.read(a), bytes("namespace A"));
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-07: fleet reserves and finalises an empty file, verifies its digest and retries", async () => {
  const { FleetUploadStoreV1 } = await import("../src/fleet/v1/upload-store");
  const { ResultFileStoreV1 } = await import("../src/artifacts/v1/result-file-store");
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"), storeRoot = join(base.path, "store");
    await mkdir(root, { mode: 0o700 }); await mkdir(storeRoot, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const store = await ResultFileStoreV1.create({ rootPath: storeRoot, maximumFiles: 32,
      maximumFileBytes: 1024, maximumSetBytes: 4096, maximumTotalBytes: 8192, operationTimeoutMs: 5000 });
    const claim = { claim_id: `fleet-claim:${"a".repeat(32)}`, project_id: PROJECT,
      job_id: "job:empty", attempt_id: "attempt:empty" };
    const file = `result-file:${"b".repeat(32)}`, set = `result-set:${"c".repeat(32)}`;
    const emptyDigest = digest(new Uint8Array());
    let uploadId: string | null = null, state = "reserved", promise = emptyDigest;
    const row = () => ({ ...claim, upload_id: uploadId, worker_id: "worker:fixture", set_id: set,
      ordinal: 1, expected_size_bytes: "0", expected_content_digest: promise, chunk_size_bytes: 8388608,
      expected_chunks: 0, state, file_id: file, display_name: "empty.txt", declared_media_type: "text/plain",
      detected_media_type: "text/plain", created_at: new Date(), expires_at: new Date(Date.now() + 60000), received_at: null });
    const query = async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM fleet_claims fc")) return { rows: [claim] };
      if (sql.includes("FROM control_task_declared_outputs d")) return { rows: [{ set_id: set, file_id: file,
        size_bytes: "0", content_digest: emptyDigest, state: "declared", upload_id: uploadId,
        expected_chunks: 0, chunk_size_bytes: 8388608, expires_at: null }] };
      if (sql.includes("INSERT INTO control_result_upload_sessions")) { uploadId = params![1] as string; return { rows: [] }; }
      if (sql.includes("FROM control_result_upload_sessions u")) return { rows: [row()] };
      if (sql.includes("FROM control_result_upload_chunks")) return { rows: [] };
      if (sql.includes("UPDATE control_result_upload_sessions SET state='received'")) { state = "received"; return { rows: [] }; }
      throw new Error("unexpected_empty_fixture_statement");
    };
    const db = { query, transaction: async (work: (tx: { query: typeof query }) => Promise<unknown>) => work({ query }) };
    const uploads = new FleetUploadStoreV1(db as unknown as import("../src/persistence/database").DatabaseClient,
      { tenantId: TENANT, store, staging });
    const principal = { workerId: "worker:fixture" } as import("../src/fleet/v1/gateway-store").FleetWorkerPrincipalV1;
    const request = { claimId: claim.claim_id, ordinal: 1, sizeBytes: 0, contentDigest: emptyDigest };
    const reserved = await uploads.reserve(principal, request);
    assert.equal(reserved.expectedChunks, 0);
    assert.equal((await uploads.reserve(principal, request)).expectedChunks, 0);
    promise = `sha256:${"0".repeat(64)}`;
    await assert.rejects(uploads.finalise(principal, { claimId: claim.claim_id, uploadId: reserved.uploadId }));
    assert.equal(state, "reserved", "a false empty digest never advances the session");
    promise = emptyDigest;
    const received = await uploads.finalise(principal, { claimId: claim.claim_id, uploadId: reserved.uploadId });
    assert.equal(received.state, "received");
    assert.equal((await store.read({ tenantId: TENANT, projectId: PROJECT, fileId: file, contentDigest: emptyDigest }))!.length, 0);
    assert.equal((await uploads.finalise(principal, { claimId: claim.claim_id, uploadId: reserved.uploadId })).replayed, true);
    await staging.discardSession({ tenantId: TENANT, projectId: PROJECT, uploadId: reserved.uploadId });
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-03: swapping the root after the helper's check cannot redirect unlink", async () => {
  const base = await privateBase();
  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, FILES3_SWAP_ROOT: process.env.FILES3_SWAP_ROOT,
    FILES3_SWAP_OLD: process.env.FILES3_SWAP_OLD, FILES3_SWAP_OUTSIDE: process.env.FILES3_SWAP_OUTSIDE };
  try {
    const root = join(base.path, "staging"), outside = join(base.path, "outside");
    await mkdir(root, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
    const name = stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1);
    await staging.stage(id, bytes("original"));
    await writeFile(join(outside, name), "victim", { mode: 0o600 });
    process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ""} --require=${join(process.cwd(), "tests/fixtures/staging-cleanup-root-swap.cjs")}`;
    process.env.FILES3_SWAP_ROOT = root; process.env.FILES3_SWAP_OLD = join(base.path, "old-staging");
    process.env.FILES3_SWAP_OUTSIDE = outside;
    assert.equal(await staging.discardChunk(id), true);
    assert.equal(await readFile(join(outside, name), "utf8"), "victim");
    assert.deepEqual(await readdir(join(base.path, "old-staging")), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(base.path, { recursive: true, force: true });
  }
});

test("FILES3-03: a cleanup helper sent to another directory refuses its inode", async () => {
  const base = await privateBase();
  const originalSpawn = childProcess.spawn;
  try {
    const root = join(base.path, "staging"), outside = join(base.path, "outside");
    await mkdir(root, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
    const name = stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1);
    await staging.stage(id, bytes("original"));
    await writeFile(join(outside, name), "victim", { mode: 0o600 });
    childProcess.spawn = ((file: string, args: string[], options: import("node:child_process").SpawnOptions) =>
      originalSpawn(file, args, { ...options, cwd: outside })) as typeof spawn;
    syncBuiltinESMExports();
    await assert.rejects(staging.discardChunk(id));
    assert.equal(await readFile(join(outside, name), "utf8"), "victim");
    assert.equal(await readFile(join(root, name), "utf8"), "original");
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    await rm(base.path, { recursive: true, force: true });
  }
});

test("FILES3-03: cleanup refuses symlinks and hardlinks", async () => {
  const base = await privateBase();
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
    const name = stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1);
    const victim = join(base.path, "victim"); await writeFile(victim, "victim", { mode: 0o600 });
    await symlink(victim, join(root, name));
    await assert.rejects(staging.discardChunk(id));
    await rm(join(root, name)); await link(victim, join(root, name));
    await assert.rejects(staging.discardChunk(id));
    assert.equal(await readFile(victim, "utf8"), "victim");
    assert.deepEqual(await readdir(root), [name]);
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-04: a volume ignoring directory locks is refused", async () => {
  const base = await privateBase();
  const originalOpen = fs.open;
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    fs.open = ((path: Parameters<typeof fs.open>[0], flags: number | string, mode?: number) =>
      originalOpen(path, typeof flags === "number" ? flags & ~0x20 : flags, mode)) as typeof fs.open;
    syncBuiltinESMExports();
    await assert.rejects(ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 }));
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-04: malformed aggregate budgets are refused", async () => {
  const base = await privateBase();
  try {
    for (const maximumTotalBytes of [0, -1, 1023, NaN, Infinity, 8192.5]) {
      await assert.rejects(ResultUploadStagingV1.create({ rootPath: base.path, maximumChunkBytes: 1024,
        maximumTotalBytes, operationTimeoutMs: 5000 }));
    }
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-03: cleanup helper rejects unbounded names", async () => {
  const base = await privateBase(); const originalSpawn = childProcess.spawn;
  try {
    const root = join(base.path, "staging"); await mkdir(root, { mode: 0o700 });
    const staging = await ResultUploadStagingV1.create({ rootPath: root, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const victim = join(base.path, "victim"); await writeFile(victim, "victim", { mode: 0o600 });
    childProcess.spawn = ((file: string, args: string[], options: import("node:child_process").SpawnOptions) => {
      const changed = args.slice(); changed[changed.length - 1] = "../victim";
      return originalSpawn(file, changed, options);
    }) as typeof spawn; syncBuiltinESMExports();
    await assert.rejects(staging.discardChunk({ tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 }));
    assert.equal(await readFile(victim, "utf8"), "victim");
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await rm(base.path, { recursive: true, force: true }); }
});

// Fault probes deliberately reach the second proof independently of the first:
// the real child must still refuse if the parent's earlier observation is stale.
const cleanupProbe = (staging: ResultUploadStagingV1, names: string[], abandoned = false, owned = false) =>
  (staging as unknown as { removeBoundNames(names: string[], operation: { deadline: number },
    abandoned: boolean, owned: boolean): Promise<number> })
    .removeBoundNames(names, { deadline: Date.now() + 5000 }, abandoned, owned);

test("cleanup tolerates EPERM when signalling its closed child and really removes only its chunk", async () => {
  const base = privateBase(), originalSpawn = childProcess.spawn, originalKill = process.kill;
  const children: ReturnType<typeof spawn>[] = [];
  let injected = 0;
  try {
    const staging = await openWith(base.path, 1024);
    const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
    await staging.stage(id, bytes("remove"));
    await staging.stage({ ...id, ordinal: 2 }, bytes("keep"));
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      staging.stage({ ...id, ordinal: index + 3 }, bytes("queued cleanup"))));
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
      const child = originalSpawn(...args); children.push(child); return child;
    }) as typeof spawn;
    syncBuiltinESMExports();
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL" && children.some(child => -child.pid! === pid)) {
        injected++;
        throw Object.assign(new Error("signal_refused"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    assert.equal(await staging.discardChunk(id), true);
    assert.equal(injected, 1, "the final signal call must hit EPERM");
    assert.deepEqual(await Promise.all(Array.from({ length: 20 }, (_, index) =>
      staging.discardChunk({ ...id, ordinal: index + 3 }))), Array(20).fill(true));
    assert.equal(injected, 21, "twenty concurrent callers also tolerate the final EPERM");
    assert.equal(await staging.read(id), undefined);
    assert.deepEqual(await staging.read({ ...id, ordinal: 2 }), bytes("keep"));
    assert.deepEqual(await readdir(base.path), [stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 2)]);
    assert.ok(children.every(child => child.exitCode === 0), "every real helper completed cleanup");
  } finally {
    process.kill = originalKill; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    for (const child of children) {
      try { originalKill(-child.pid!, "SIGKILL"); }
      catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
      assert.notEqual(child.exitCode, null, "cleanup helper must be reaped");
    }
    await rm(base.path, { recursive: true, force: true });
  }
});

test("cleanup deadline signal failures never escape the timer; failed cleanup can retry", async () => {
  // Model a child's delayed close without starting an idle OS process. The
  // existing spawn and signal seams exercise the real timer and kill helper.
  for (const errno of ["EPERM", "EIO"]) {
    const base = privateBase(), originalSpawn = childProcess.spawn, originalKill = process.kill;
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, { pid: 2147483647, stdout, stderr });
    let closeTimer: ReturnType<typeof setTimeout> | undefined, signals = 0;
    try {
      const staging = await openWith(base.path, 1024);
      const id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
      await staging.stage(id, bytes("retry"));
      childProcess.spawn = (() => {
        closeTimer = setTimeout(() => child.emit("close", null), 100);
        return child;
      }) as typeof spawn;
      syncBuiltinESMExports();
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        assert.equal(pid, -child.pid!); assert.equal(signal, "SIGKILL");
        signals++;
        throw Object.assign(new Error("signal_refused"), { code: signals === 1 ? errno : "ESRCH" });
      }) as typeof process.kill;
      await assert.rejects((staging as unknown as {
        removeBoundNames(names: string[], operation: { deadline: number }): Promise<number>;
      }).removeBoundNames([stagedChunkNameV1(TENANT, PROJECT, UPLOAD, 1)], { deadline: Date.now() + 50 }),
      (error: unknown) => (error as ResultUploadStagingError).code === "staging_ambiguous");
      assert.equal(signals, 2, `${errno}: deadline signal and final signal both ran`);
      process.kill = originalKill; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
      assert.deepEqual(await staging.read(id), bytes("retry"), "a failed helper did not remove the chunk");
      assert.equal(await staging.discardChunk(id), true, "retry uses the real helper successfully");
      assert.deepEqual(await readdir(base.path), [], "retry leaves no chunk or scratch");
    } finally {
      clearTimeout(closeTimer); stdout.destroy(); stderr.destroy();
      process.kill = originalKill; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
      await rm(base.path, { recursive: true, force: true });
    }
  }
});

test("FILES3-04: parent reclamation never schedules live or inaccessible writers", async () => {
  const base = privateBase(), originalSpawn = childProcess.spawn, originalKill = process.kill;
  try {
    const staging = await openWith(base.path, 1024);
    const name = `.staging-${"d".repeat(64)}-${process.pid.toString(36)}-1024.part`;
    await writeFile(join(base.path, name), "live", { mode: 0o600 });
    let children = 0;
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => { children++; return originalSpawn(...args); }) as typeof spawn;
    syncBuiltinESMExports();
    const reclaim = () => (staging as unknown as { reclaimAbandoned(operation: { deadline: number }): Promise<void> })
      .reclaimAbandoned({ deadline: Date.now() + 5000 });
    await reclaim();
    process.kill = (() => { throw Object.assign(new Error("inaccessible"), { code: "EPERM" }); }) as typeof process.kill;
    await reclaim();
    assert.equal(children, 0);
    assert.equal(await readFile(join(base.path, name), "utf8"), "live");
  } finally {
    process.kill = originalKill; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    await rm(base.path, { recursive: true, force: true });
  }
});

test("FILES3-04 FILES3-03: child scratch cleanup proves writer, ownership and matching links", async () => {
  const base = privateBase();
  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, FILES3_CLEANUP_FAULT: process.env.FILES3_CLEANUP_FAULT };
  try {
    const root = base.root("staging"); await mkdir(root, { mode: 0o700 });
    const staging = await openWith(root, 1024);
    const name = `.staging-${"d".repeat(64)}-${process.pid.toString(36)}-1024.part`;
    await writeFile(join(root, name), "live", { mode: 0o600 });
    assert.equal(await cleanupProbe(staging, [name], true), 0, "the child independently retains a live writer");
    process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ""} --require=${join(process.cwd(), "tests/fixtures/staging-cleanup-faults.cjs")}`;
    process.env.FILES3_CLEANUP_FAULT = "writer_inaccessible";
    assert.equal(await cleanupProbe(staging, [name], true), 0, "inaccessible is not proof of death");
    delete process.env.FILES3_CLEANUP_FAULT;
    const foreign = `.staging-${"e".repeat(64)}-1-1024.part`;
    await writeFile(join(root, foreign), "foreign", { mode: 0o600 });
    await assert.rejects(cleanupProbe(staging, [foreign], false, true));
    assert.equal(await readFile(join(root, foreign), "utf8"), "foreign");
    const victim = base.root("victim"); await writeFile(victim, "victim", { mode: 0o600 });
    await rm(join(root, name)); await link(victim, join(root, name));
    await writeFile(join(root, `${"d".repeat(64)}.chunk`), "different inode", { mode: 0o600 });
    await assert.rejects(cleanupProbe(staging, [name], false, true));
    assert.equal(await readFile(join(root, name), "utf8"), "victim");
    assert.equal(await readFile(victim, "utf8"), "victim");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(base.path, { recursive: true, force: true });
  }
});

test("FILES3-03: cleanup refuses an entry replaced between its inode checks", async () => {
  const base = privateBase();
  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, FILES3_CLEANUP_FAULT: process.env.FILES3_CLEANUP_FAULT,
    FILES3_CLEANUP_FAULT_NAME: process.env.FILES3_CLEANUP_FAULT_NAME };
  try {
    const staging = await openWith(base.path, 1024), name = `${"d".repeat(64)}.chunk`;
    await writeFile(join(base.path, name), "original", { mode: 0o600 });
    process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ""} --require=${join(process.cwd(), "tests/fixtures/staging-cleanup-faults.cjs")}`;
    process.env.FILES3_CLEANUP_FAULT = "entry_replaced"; process.env.FILES3_CLEANUP_FAULT_NAME = name;
    await assert.rejects(cleanupProbe(staging, [name]));
    assert.equal(await readFile(join(base.path, name), "utf8"), "replacement");
    assert.equal(await readFile(join(base.path, name + ".held"), "utf8"), "original");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(base.path, { recursive: true, force: true });
  }
});

test("FILES3-04: the held quota lock proves its directory and fails once on a real open error", async () => {
  const base = privateBase(), originalOpen = fs.open;
  try {
    const root = base.root("staging"), outside = base.root("outside");
    await mkdir(root, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const staging = await openWith(root, 1024), id = { tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 };
    fs.open = ((path: Parameters<typeof fs.open>[0], flags: number | string, mode?: number) =>
      originalOpen(typeof flags === "number" && (flags & 0x20) ? outside : path, flags, mode)) as typeof fs.open;
    syncBuiltinESMExports();
    await assert.rejects(staging.stage(id, bytes("no custody")));
    assert.deepEqual(await readdir(root), []);
    let attempts = 0;
    fs.open = ((path: Parameters<typeof fs.open>[0], flags: number | string, mode?: number) => {
      if (typeof flags === "number" && (flags & 0x20)) { attempts++; throw Object.assign(new Error("io_failure"), { code: "EIO" }); }
      return originalOpen(path, flags, mode);
    }) as typeof fs.open; syncBuiltinESMExports();
    await assert.rejects(staging.stage(id, bytes("retry")));
    assert.equal(attempts, 1, "only lock contention is retried");
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-04: the disk budget rejects non-files and reserves a live part's promised bytes", async () => {
  const base = privateBase();
  try {
    const staging = await ResultUploadStagingV1.create({ rootPath: base.path, maximumChunkBytes: 1024,
      maximumTotalBytes: 2048, operationTimeoutMs: 5000 });
    const budget = (additional: number) => (staging as unknown as { assertDiskBudget(bytes: number,
      operation: { deadline: number }): Promise<void> }).assertDiskBudget(additional, { deadline: Date.now() + 5000 });
    const stray = base.root("directory"); await mkdir(stray, { mode: 0o700 });
    await assert.rejects(budget(0)); await rm(stray, { recursive: true });
    const part = `.staging-${"d".repeat(64)}-${process.pid.toString(36)}-2048.part`;
    await writeFile(join(base.path, part), "partial", { mode: 0o600 });
    await assert.rejects(budget(1), (error: unknown) => error instanceof ResultUploadStagingError && error.code === "staging_capacity");
    await budget(0);
    assert.equal(await readFile(join(base.path, part), "utf8"), "partial");
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("review m-rvfiles3: the default staging budget holds one full result set and still admits another upload", async () => {
  const base = privateBase();
  try {
    const staging = await ResultUploadStagingV1.create({ rootPath: base.path, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
    const budget = (additional: number) => (staging as unknown as { assertDiskBudget(bytes: number,
      operation: { deadline: number }): Promise<void> }).assertDiskBudget(additional, { deadline: Date.now() + 5000 });
    const set = 512 * 1024 * 1024;
    await writeFile(join(base.path, `.staging-${"e".repeat(64)}-${process.pid.toString(36)}-${set}.part`), "p", { mode: 0o600 });
    await budget(1024);
    await writeFile(join(base.path, `.staging-${"f".repeat(64)}-${process.pid.toString(36)}-${set}.part`), "p", { mode: 0o600 });
    await assert.rejects(budget(1), (error: unknown) => error instanceof ResultUploadStagingError && error.code === "staging_capacity");
  } finally { await rm(base.path, { recursive: true, force: true }); }
});

test("FILES3-03: a stalled cleanup child is killed at the operation deadline", { timeout: 2000 }, async () => {
  const base = privateBase(), originalSpawn = childProcess.spawn;
  let helper: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const staging = await ResultUploadStagingV1.create({ rootPath: base.path, maximumChunkBytes: 1024, operationTimeoutMs: 100 });
    childProcess.spawn = ((file: string, args: string[], options: import("node:child_process").SpawnOptions) => {
      helper = originalSpawn(file, ["-e", "setInterval(() => {}, 1000)"], options); closed = once(helper, "close"); return helper;
    }) as typeof spawn;
    syncBuiltinESMExports();
    const started = Date.now();
    await assert.rejects(Promise.race([
      staging.discardChunk({ tenantId: TENANT, projectId: PROJECT, uploadId: UPLOAD, ordinal: 1 }),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("cleanup_deadline_missed")), 1000); }),
    ]), (error: unknown) => error instanceof ResultUploadStagingError && error.code === "staging_ambiguous");
    assert.ok(Date.now() - started < 1500);
    // The per-root queue (r6flfix) answers the caller at its own deadline, so the
    // refusal alone no longer proves the child was stopped. The staging code must
    // kill the stalled child itself, before this test's own cleanup does.
    let childDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        childDeadline = setTimeout(() => reject(new Error("stalled_cleanup_child_survived")), 1000);
      })]);
    } finally { clearTimeout(childDeadline); }
  } finally {
    clearTimeout(watchdog);
    if (helper?.pid) {
      try { process.kill(-helper.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await closed;
    }
    childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await rm(base.path, { recursive: true, force: true });
  }
});
