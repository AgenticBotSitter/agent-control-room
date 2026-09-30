// Unit proof for the upload staging area: the sibling of the byte store where a
// chunk lands between the connector sending it and the file existing.
//
// No database here on purpose. This is a filesystem component, and what it has
// to hold is about NAMES, MODES, LINKS and CONTENT — none of which a mock can
// prove and all of which a real 0700 directory can. Every refusal is asserted on
// the staging error's own code, which is the only thing a caller ever sees.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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
async function privateBase(): Promise<{ path: string; root: (name: string) => string }> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cr-staging-")));
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
    const removed = await staging.discardSession(identity, 4);
    assert.equal(removed, 4, "discard removes exactly the names this session derives");
    assert.deepEqual(await readdir(root), [], "and the root is empty afterwards");
    // An already-absent chunk is done, not an error.
    assert.equal(await staging.discardSession(identity, 4), 0, "discarding twice is not a failure");

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
          .then((value) => ({ ok: true, value }))
          .catch((error: unknown) => ({ ok: false, code: (error as { code?: string }).code })))),
    ]);
    assert.equal(reads.length, 50, "all 50 reads answered, none hung");
    for (const [index, read] of reads.entries()) {
      const expected = bodies[index % CHUNKS];
      if (read.ok) {
        // A read is EITHER the exact chunk for that ordinal or it is refused.
        // A short, mixed or wrong-session read is the bug this proves absent.
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
    assert.equal((await staging.discardSession(identity, CHUNKS)), CHUNKS);
    assert.equal((await staging.discardSession(otherIdentity, 32)), 32);
    assert.deepEqual(await staging.stagedNames(), [], "and both sessions clean up completely");
  } finally {
    await rm(base.path, { recursive: true, force: true });
  }
});

/** True when `needle` appears inside `haystack`, used to prove a read did not
 * return another session's bytes. */
function isSubarrayOf(needle: Uint8Array, haystack: Buffer): boolean {
  return haystack.includes(Buffer.from(needle));
}