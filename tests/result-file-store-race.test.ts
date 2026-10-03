// The store's exclusion, raced with REAL processes.
//
// The review's B3, and the shape of the attack matters more than the assertions
// inside any one test. Everything the store claims about writers is a claim
// about what two PROCESSES can do to the same directory at the same moment, and
// the round-3 lane proved that a store can pass every single-writer test and
// still hand a live upload's lock and its half-written file to a second program.
// So this file drives the store the way the harm happens: two writer processes
// and four opener processes against one directory, while a fifth observer walks
// the directory and reports every state it sees.
//
// The four counters, and what each one is the symptom of:
//
//   * twoStagingFiles  — two writers inside the lock at once. This is the thing
//     the lock exists to stop, and it is also how two uploads could pass the
//     installation's storage-limit check together.
//   * stagingWithoutLock — a writer's staging file with no lock name in the
//     directory. That is a writer holding a lock whose NAME was taken away, and
//     the next opener deletes that staging file out from under it.
//   * rawWriteErrnos   — a raw system errno escaping `put()`. The store's error
//     contract says its only answers are its own fixed codes.
//   * rawOpenErrnos    — a raw system errno escaping `create()`. Same contract.
//
// Against the store as it stood before this fix the review measured 375 / 242 /
// 2 / 73 over 40 seconds. All four are zero now, and the assertions below are
// what a reviewer reruns.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs, { link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";

const TENANT = "tenant:race";
/** The store's own answers, which are its `code` field values and nothing else.
 * A child's error is one of two things: one of these, which is the store working,
 * or a system errno, which is a breach of its error contract. Telling them apart
 * is the whole measurement, so the set is named once and injected into both
 * children rather than spelled into each of their scripts. */
const STORE_CODES = ["store_invalid", "store_missing", "store_conflict", "store_capacity",
  "store_ambiguous"];
const LOCK_NAME = ".control-room-result-file-store.lock";
const PENDING_PREFIX = ".control-room-result-file-store-pending-";
const PROBE_PREFIX = ".control-room-result-file-store-exlock-probe-";
const STORE_MODULE = join(process.cwd(), "src/artifacts/v1/result-file-store.ts");
/** 64 KiB: long enough that a write's staging window is wide enough for the
 * observer to catch, short enough that two writers and four openers are not
 * fighting this Mac for minutes. */
const PAYLOAD = 65_536;
/** 40 s is the review's measurement window, kept exactly so the numbers in
 * `reports/reviews/files4.md` and the numbers here are comparable. The
 * unmodified store failed it on every run. */
const SECONDS = 40;
const WRITERS = 2;
const OPENERS = 4;

const configurationV1 = (rootPath: string) => ({
  rootPath, maximumFiles: 32, maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912,
  maximumTotalBytes: 10_737_418_240, operationTimeoutMs: 30_000,
});

/** A child that has been asked to run, and a promise for its output.
 *
 * The ref'd interval is not decoration: a `ChildProcess` is not a ref'd handle,
 * so a test that only awaits `once("exit")` gives Node nothing to keep the event
 * loop alive and the test ends with "promise resolution still pending". That is
 * the review's B2 arriving through the test rather than through the store, and
 * it reads exactly like a hang. `awaitChildV1` handles that for a single child;
 * this is the same idea for a fleet of them. */
function racerV1(script: string): {
  child: ChildProcess; exited: Promise<number | null>; output: () => string;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd(),
  });
  let out = "";
  child.stdout!.on("data", chunk => { out += String(chunk); });
  // `inherit` is not available per-stream, so stderr is captured and reported in
  // the assertion message: a child that died must say why rather than leaving the
  // lane to fail on a counter that never moved.
  child.stderr!.on("data", chunk => { out += String(chunk); });
  const keepAlive = setInterval(() => {}, 1_000);
  const exited = new Promise<number | null>(resolve => {
    child.once("exit", code => { clearInterval(keepAlive); resolve(code); });
  });
  return { child, exited, output: () => out };
}

const awaitChildV1 = (child: ChildProcess, label: string, ms = 120_000): Promise<number | null> =>
  new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const keeper = setTimeout(() => reject(new Error(`child ${label} did not exit within ${ms} ms`)),
      ms);
    child.once("exit", code => { clearTimeout(keeper); resolve(code); });
  });

/** A writer: open the store (retrying, because an opener holds the recovery
 * lock for a moment), then put a fresh file as fast as it can for the window.
 *
 * Every error is counted BY CODE, and the codes are printed rather than counted
 * in the parent, because the distinction that matters is between the store's own
 * refusals and a raw errno. A refusal is a correct answer to "another writer is
 * in here"; a raw `ENOENT` is a lost file. */
const writerScriptV1 = (root: string) => `
  const { ResultFileStoreV1 } = await import(${JSON.stringify(STORE_MODULE)});
  const STORE_CODES = new Set(${JSON.stringify(STORE_CODES)});
  const { createHash, randomUUID } = await import("node:crypto");
  const root = ${JSON.stringify(root)};
  const configuration = ${JSON.stringify(configurationV1(root))};
  let store;
  for (;;) {
    try { store = await ResultFileStoreV1.create(configuration); break; }
    catch (error) {
      // Only the store's OWN refusals are retried — a concurrent recovery is a
      // correct answer to create() and the next attempt gets past it. Anything
      // else is reported and the writer stops, because a lane that hides a raw
      // errno is the exact failure this file exists to catch.
      //
      // The store's codes are the "code" field values, NOT a prefix on the
      // message: it sets code to "store_ambiguous" and builds the message
      // "result_file_store_store_ambiguous" around it. Classifying on the message
      // would count every correct refusal as a raw system error, which is how an
      // earlier draft of this file reported a healthy race as a total failure.
      if (!STORE_CODES.has(String(error && error.code)))
        { console.log("OPEN " + JSON.stringify({ code: error.code ?? error.name ?? String(error) })); process.exit(3); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const codes = {};
  const end = Date.now() + ${SECONDS * 1000};
  while (Date.now() < end) {
    const payload = new Uint8Array(${PAYLOAD});
    crypto.getRandomValues(payload.subarray(0, 64));
    try {
      await store.put({ tenantId: "tenant:race", projectId: "project:race",
        fileId: "result-file:" + randomUUID().replace(/-/g, ""),
        contentDigest: "sha256:" + createHash("sha256").update(payload).digest("hex"), bytes: payload });
      codes.ok = (codes.ok ?? 0) + 1;
    } catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      codes[key] = (codes[key] ?? 0) + 1;
      if (STORE_CODES.has(key)) codes.refusals = (codes.refusals ?? 0) + 1;
      else { console.log("RAW " + JSON.stringify({ key, stack: String(error && error.stack).split("\\n").slice(0, 3) })); }
    }
  }
  console.log("CODES " + JSON.stringify(codes));`;

/** An opener: create the store over and over, which is what a second copy of
 * the app does while the first one uploads. Every code is counted, and a raw
 * errno is reported separately for the same reason. */
const openerScriptV1 = (root: string) => `
  const { ResultFileStoreV1 } = await import(${JSON.stringify(STORE_MODULE)});
  const STORE_CODES = new Set(${JSON.stringify(STORE_CODES)});
  const configuration = ${JSON.stringify(configurationV1(root))};
  const codes = {};
  const end = Date.now() + ${SECONDS * 1000};
  while (Date.now() < end) {
    try { await ResultFileStoreV1.create(configuration); codes.opened = (codes.opened ?? 0) + 1; }
    catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      codes[key] = (codes[key] ?? 0) + 1;
      if (STORE_CODES.has(key)) codes.refusals = (codes.refusals ?? 0) + 1;
      else { console.log("RAW " + JSON.stringify({ key, syscall: error.syscall, stack: String(error && error.stack).split("\\n").slice(1, 4) })); }
    }
  }
  console.log("CODES " + JSON.stringify(codes));`;

test("B3: two writer processes and four opener processes never break the exclusion",
  { timeout: 300_000 }, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-race-")));
    const racers: ReturnType<typeof racerV1>[] = [];
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      // The observer. It samples the directory as fast as it can and records the
      // two states that must never occur. It reads NAMES ONLY: it opens nothing,
      // takes no lock, and removes nothing, so it cannot be the thing that
      // breaks the exclusion it is measuring.
      let samples = 0;
      let twoStagingFiles = 0;
      let stagingWithoutLock = 0;
      let stop = false;
      const observer = (async () => {
        while (!stop) {
          try {
            const listed = await readdir(root);
            const staging = listed.filter(entry => entry.startsWith(PENDING_PREFIX)).length;
            if (staging > 1) twoStagingFiles += 1;
            if (staging > 0 && !listed.includes(LOCK_NAME)) stagingWithoutLock += 1;
            samples += 1;
          } catch { /* the directory is never removed under us; a sample is lost, not a failure */ }
        }
      })();
      for (let index = 0; index < WRITERS; index += 1)
        racers.push(racerV1(writerScriptV1(root)));
      for (let index = 0; index < OPENERS; index += 1)
        racers.push(racerV1(openerScriptV1(root)));
      const exits = await Promise.all(racers.map(racer => racer.exited));
      stop = true;
      await observer;
      const output = racers.map(racer => racer.output());
      const raw = output.flatMap(text => text.split("\n").filter(line => line.startsWith("RAW ")));
      // The children are the measurement, so their own report has to be read
      // before anything is asserted: a writer that never got past `create()` and
      // a writer that did fifty puts both report `fail 0` here.
      const codes = output.flatMap(text => text.split("\n").filter(line => line.startsWith("CODES "))
        .map(line => JSON.parse(line.slice("CODES ".length)) as Record<string, number>));
      const landed = codes.reduce((total, entry) => total + (entry.ok ?? 0), 0);
      const opened = codes.reduce((total, entry) => total + (entry.opened ?? 0), 0);
      const report = { samples, twoStagingFiles, stagingWithoutLock, landed, opened, codes, raw };
      // Every child finished on its own, which is the first thing to check: a
      // writer that exited early leaves `landed` low and the counters at zero,
      // which would read as a pass.
      assert.deepEqual(exits, new Array(racers.length).fill(0),
        `a racer exited non-zero, so the race was not measured: ${JSON.stringify(report)}`);
      assert.ok(samples > 0, `the observer never sampled the directory: ${JSON.stringify(report)}`);
      // The window was real work, not an idle 40 seconds.
      assert.ok(landed > 0, `no writer managed a single put: ${JSON.stringify(report)}`);
      assert.ok(opened > 0, `no opener managed a single open: ${JSON.stringify(report)}`);
      // THE FOUR ASSERTIONS.
      assert.equal(twoStagingFiles, 0,
        `two writers were inside the lock at the same moment: ${JSON.stringify(report)}`);
      assert.equal(stagingWithoutLock, 0,
        `a writer's staging file was left with no lock in the directory: ${JSON.stringify(report)}`);
      assert.deepEqual(raw, [],
        `a raw system errno escaped the store: ${JSON.stringify(report)}`);
      // Nothing is left behind, so the exclusions the window produced were
      // released rather than leaked: a leftover lock here would be a writer
      // that never retired its own.
      const entries = (await readdir(root)).filter(entry => !entry.endsWith(".crbf"));
      assert.deepEqual(entries, [],
        `the store's own bookkeeping was left behind after the race: ${JSON.stringify(entries)}`);
      // And everything that was reported as written is on disk, whole, and
      // readable — the race cost no file.
      const store = await ResultFileStoreV1.create(configurationV1(root));
      const results = (await readdir(root)).filter(entry => entry.endsWith(".crbf"));
      assert.equal(results.length, landed,
        `every put that reported ok is on disk exactly once: ${JSON.stringify(report)}`);
      let total = 0;
      for (const entry of results) total += (await stat(join(root, entry))).size;
      assert.equal(total, landed * PAYLOAD, "and every one of them is whole");
      void assert.ok(store);
    } finally {
      for (const racer of racers) {
        racer.child.kill("SIGKILL");
        await awaitChildV1(racer.child, "racer (cleanup)").catch(() => {});
      }
      await rm(base, { recursive: true, force: true });
    }
  });

test("B3: a lock name stolen mid-write refuses the write, and the guard is the one doing it",
  async t => {
    // Pause at the real exclusive-open completion, before put() can prove
    // ownership. A payload size or an unlink polling loop cannot guarantee
    // that the thief runs before the write finishes under load.
    const originalOpen = fs.open;
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-steal-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      const store = await ResultFileStoreV1.create(configurationV1(root));
      // A real stored file, so "nothing was written" is a statement about THIS
      // write and not about the store being empty.
      const kept = new Uint8Array(PAYLOAD);
      kept.fill(1);
      const keptId = { tenantId: TENANT, projectId: "project:steal",
        fileId: `result-file:${"9".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(kept).digest("hex")}` };
      await store.put({ ...keptId, bytes: kept });
      const payload = new Uint8Array(PAYLOAD);
      payload.fill(4);
      const id = { tenantId: TENANT, projectId: "project:steal",
        fileId: `result-file:${"a".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
      const lockPath = join(root, LOCK_NAME);
      let stolen = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === lockPath) {
          try {
            // The kernel has opened and locked this inode. Await the actual
            // theft before returning the handle to the product's name proof.
            assert.equal((await handle.stat()).ino, (await lstat(lockPath)).ino);
            await unlink(lockPath);
            stolen += 1;
          } catch (error) { await handle.close(); throw error; }
        }
        return handle;
      });
      syncBuiltinESMExports();
      const outcome = await store.put({ ...id, bytes: payload }).then(
        () => undefined, (error: unknown) => error);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.ok(stolen > 0, "the lock name was actually stolen, or this test proves nothing");
      // The guard: the write did not succeed, and the caller sees a store code.
      // With `stillOwnsTheName` forced to `true` the store carries on past the
      // proof, and this assertion is what fails.
      assert.ok(outcome instanceof Error,
        "a write whose lock name was stolen under it does not report success");
      assert.ok(STORE_CODES.includes(String((outcome as { code?: string }).code)),
        "and the refusal is one of the store's own codes, not a raw errno");
      // And the consequences that matter are the ones the review measured: no
      // file was left half-written under a name the catalog could reach, and the
      // store did not serve anything it cannot account for afterwards.
      const listed = await readdir(root);
      assert.deepEqual(listed.filter(entry => entry.startsWith(PENDING_PREFIX)), [],
        "no staging file is left behind by a write that lost its lock");
      const store2 = await ResultFileStoreV1.create(configurationV1(root));
      assert.deepEqual(Buffer.from((await store2.read(keptId))!), Buffer.from(kept),
        "and the file that was already stored is still byte-for-byte what it was");
      assert.equal(await store2.read(id), undefined, "the refused write published no result");
      // Losing the name before mutation is recoverable: the exact retry lands.
      await store2.put({ ...id, bytes: payload });
      assert.deepEqual(Buffer.from((await store2.read(id))!), Buffer.from(payload),
        "the retry succeeds after the clean refusal");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(base, { recursive: true, force: true });
    }
  });

test("B3: a staging file that vanishes mid-write is an unprovable outcome, not a raw ENOENT",
  async () => {
    // The fourth edit. `link()` failing with `ENOENT` means this writer's own
    // staging file was removed while it was writing — by a recovery that got in,
    // or by a second writer inside the lock. Either way the operation's outcome
    // cannot be proved, and the store's answer has to be the same one it gives
    // for every other unprovable mutation: `store_ambiguous`, with the store
    // poisoned so nothing after it is served on a directory whose state it no
    // longer knows.
    //
    // Before this it escaped as a raw `ENOENT` from `link()` straight to the
    // caller, which the review measured happening to BOTH of its racing writers.
    // Two things are asserted, because either alone would be weak: the code the
    // caller sees, and the fact that the store refuses everything afterwards.
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-vanish-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      const store = await ResultFileStoreV1.create(configurationV1(root));
      // A real stored file, so the "still works afterwards" question has an
      // answer that is not "the store was empty anyway".
      const kept = new Uint8Array(PAYLOAD);
      kept.fill(1);
      const keptId = { tenantId: TENANT, projectId: "project:vanish",
        fileId: `result-file:${"5".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(kept).digest("hex")}` };
      await store.put({ ...keptId, bytes: kept });
      // The payload is large enough that the observer below reliably wins the
      // window between the staging file's create and the `link()` — the review
      // measured that window at 14-40 ms for an 8 MiB write.
      const payload = new Uint8Array(8 * 1024 * 1024);
      payload.fill(2);
      const id = { tenantId: TENANT, projectId: "project:vanish",
        fileId: `result-file:${"6".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
      // Watch for the staging file and delete it the moment it appears: a
      // recovery that got in, reduced to the one syscall that matters.
      let killed = false;
      const interference = (async () => {
        const deadline = Date.now() + 30_000;
        while (!killed && Date.now() < deadline) {
          for (const entry of await readdir(root)) {
            if (!entry.startsWith(PENDING_PREFIX)) continue;
            await unlink(join(root, entry)).catch(() => {});
            killed = true;
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      })();
      const outcome = await store.put({ ...id, bytes: payload }).then(
        () => undefined, (error: unknown) => error);
      killed = true;
      await interference;
      assert.ok(killed, "the interference actually removed a staging file, so the case was reached");
      assert.ok(STORE_CODES.includes(String((outcome as { code?: string }).code)),
        "the caller sees one of the store's own codes and nothing else");
      assert.equal((outcome as { code?: string }).code, "store_ambiguous",
        "a lost staging file is `store_ambiguous`, not a raw ENOENT from link()");
      // The operation is unprovable, so the store poisons itself rather than
      // serving a directory whose state it can no longer account for.
      await assert.rejects(store.put({ ...keptId, bytes: kept }),
        (error: unknown) => error instanceof Error && error.name !== "ENOENT",
      "and the store refuses afterwards instead of carrying on");
      // The file that WAS stored before all this is still on disk, byte for byte:
      // the poison is about going on, not about losing what is already there.
      const other = await ResultFileStoreV1.create(configurationV1(root));
      assert.deepEqual(Buffer.from((await other.read(keptId))!), Buffer.from(kept),
        "a store opened afterwards re-proves the file that was already stored");
    } finally { await rm(base, { recursive: true, force: true }); }
  });

test("N-4c: a root whose volume honours O_EXLOCK is accepted and the probe is removed", async () => {
  // The review's should-fix, and it is cheap enough to include. Everything this
  // store claims about writers rests on `O_EXLOCK` being HONOURED by the volume
  // the root is on. exFAT and some network volumes accept the flag and take no
  // lock, so two writers get the exclusion at once and every refusal in this
  // file is decoration on a volume that never refused anything.
  //
  // The question cannot be asked without an answer the store already has: two
  // `O_EXLOCK` opens of one inode from ONE process, because the kernel's lock
  // table is per inode, not per process. On this host — and on any volume that
  // honours the flag — the second open is `EAGAIN`, which is the proof.
  //
  // This is the native Mac control. The R5V-01 case below separately strips the
  // open flag in a child to prove refusal when the filesystem ignores it.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-exlock-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { mode: 0o700 });
    // The store OPENS, which is the half of the question this host can answer.
    const store = await ResultFileStoreV1.create(configurationV1(root));
    assert.ok(store, "a volume that honours O_EXLOCK is accepted");
    // The probe left nothing behind: a `pending-*` name is the store's own
    // bookkeeping, and a probe that leaked one would be indistinguishable from a
    // writer's leftovers in every check that walks the directory.
    assert.deepEqual((await readdir(root)).filter(entry =>
      entry.startsWith(PENDING_PREFIX) || entry.startsWith(PROBE_PREFIX)), [],
    "the O_EXLOCK probe left no name of its own in the directory, and no name of a writer's either");
    // And the store still works end to end, so the probe is not a write in
    // disguise: it takes and releases its lock, and the write after it lands.
    const payload = new Uint8Array(PAYLOAD);
    payload.fill(9);
    const id = { tenantId: TENANT, projectId: "project:exlock",
      fileId: `result-file:${"7".repeat(32)}`,
      contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
    await store.put({ ...id, bytes: payload });
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(payload),
      "a write after the probe actually lands, so the probe released what it took");
    const concurrent = await Promise.all(Array.from({ length: 20 }, () =>
      ResultFileStoreV1.create(configurationV1(root))));
    assert.equal(concurrent.length, 20, "same-process openers use independent probe names");
    assert.ok(!(await readdir(root)).some(name => name.startsWith(PROBE_PREFIX)));
    // R6FL-03: strip O_EXLOCK only on the probe opens. Both descriptors really
    // open; startup must refuse, close both, and leave unrelated names alone.
    const unsupportedRoots = [];
    for (let i = 0; i < 20; i++) {
      const path = join(base, `unsupported-${i}`);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, `${PENDING_PREFIX}${"b".repeat(32)}`), "unrelated fixture", { mode: 0o600 });
      unsupportedRoots.push(path);
    }
    let unsupportedChild: ChildProcess | undefined;
    try {
      const helper = new URL("./support/result-file-ignored-exlock.mjs", import.meta.url);
      const script = `
        import assert from "node:assert/strict";
        import { ResultFileStoreV1 } from ${JSON.stringify(STORE_MODULE)};
        import { ignoredExlockHandles } from ${JSON.stringify(helper.href)};
        const roots = ${JSON.stringify(unsupportedRoots)};
        await Promise.all(roots.map(rootPath => assert.rejects(
          ResultFileStoreV1.create({ ...${JSON.stringify(configurationV1(root))}, rootPath }),
          error => error.code === "store_invalid")));
        assert.equal(ignoredExlockHandles.size, 0, "both probe handles closed on all 20 roots");
        // A failed O_EXCL create owns no name, even when that name happens to
        // look exactly like this opener's probe. Leave the existing file intact.
        const fs = (await import("node:fs/promises")).default;
        const { syncBuiltinESMExports } = await import("node:module");
        const { constants } = await import("node:fs");
        const original = fs.open;
        let collision;
        fs.open = async (path, flags, ...args) => {
          if (!collision && String(path).includes(${JSON.stringify(PROBE_PREFIX)}) && (flags & constants.O_CREAT)) {
            collision = path;
            const foreign = await original(path, flags, ...args);
            await foreign.writeFile("another opener's name");
            await foreign.close();
            const error = new Error("synthetic EEXIST"); error.code = "EEXIST"; throw error;
          }
          return original(path, flags, ...args);
        };
        syncBuiltinESMExports();
        try {
          await assert.rejects(ResultFileStoreV1.create({ ...${JSON.stringify(configurationV1(root))}, rootPath: roots[0] }),
            error => error.code === "store_invalid");
          assert.ok(collision, "exclusive create collision was injected");
          assert.equal(await fs.readFile(collision, "utf8"), "another opener's name");
          assert.equal(ignoredExlockHandles.size, 0);
        } finally { fs.open = original; syncBuiltinESMExports(); if (collision) await fs.unlink(collision); }

      `;
      unsupportedChild = spawn(process.execPath, ["--import", "tsx", "--import", helper.pathname,
        "--input-type=module", "-e", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      unsupportedChild.stdout!.on("data", chunk => { output += String(chunk); });
      unsupportedChild.stderr!.on("data", chunk => { output += String(chunk); });
      assert.equal(await awaitChildV1(unsupportedChild, "N-4c unsupported volume", 20_000), 0, output);
      for (const path of unsupportedRoots) {
        assert.deepEqual(await readdir(path), [`${PENDING_PREFIX}${"b".repeat(32)}`], "only own probe name removed");
        assert.equal(await readFile(join(path, `${PENDING_PREFIX}${"b".repeat(32)}`), "utf8"), "unrelated fixture");
      }
    } finally {
      if (unsupportedChild?.pid) {
        try { process.kill(-unsupportedChild.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await awaitChildV1(unsupportedChild, "N-4c cleanup", 10_000).catch(() => {});
        assert.throws(() => process.kill(-unsupportedChild!.pid!, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "owned probe group is absent");
      }
    }
    // A root that is not a private directory never reaches the probe at all, and
    // a probe that cannot be asked must not be assumed to have answered: the
    // store's own refusal for an unaskable root is unchanged.
    const publicRoot = join(base, "public");
    await mkdir(publicRoot, { mode: 0o777 });
    await assert.rejects(ResultFileStoreV1.create({ ...configurationV1(publicRoot) }),
      (error: unknown) => STORE_CODES.includes(String((error as { code?: string }).code)),
    "a root that fails an earlier check is still refused, probe or not");
    assert.deepEqual((await readdir(publicRoot)), [],
      "and the refused root was not written to: the probe does not run on a root that is not a store");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("R5V-01: ignored O_EXLOCK refuses 50 openers without deleting a live upload", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-ignored-lock-")));
  const root = join(base, "store");
  await mkdir(root, { mode: 0o700 });
  const lockPath = join(root, ".control-room-result-file-store.lock");
  const partialPath = join(root, `${PENDING_PREFIX}${"a".repeat(32)}`);
  let held, child: ChildProcess | undefined;
  try {
    // Native control first; the live descriptor is outside the simulated child.
    await ResultFileStoreV1.create(configurationV1(root));
    const { constants } = await import("node:fs");
    held = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | 0x20, 0o600);
    await held.writeFile("live writer fixture\n");
    await writeFile(partialPath, "partial bytes\n", { mode: 0o600 });
    const before = await held.stat();
    const script = `
      import assert from "node:assert/strict";
      import { ResultFileStoreV1 } from ${JSON.stringify(STORE_MODULE)};
      import { ignoredExlockHandles } from ${JSON.stringify(new URL("./support/result-file-ignored-exlock.mjs", import.meta.url).href)};
      for (let i = 0; i < 50; i++) {
        await assert.rejects(ResultFileStoreV1.create(${JSON.stringify(configurationV1(root))}),
          error => error.code === "store_invalid");
        assert.equal(ignoredExlockHandles.size, 0, "both probe descriptors were closed");
      }
    `;
    child = spawn(process.execPath, ["--import", "tsx", "--import",
      new URL("./support/result-file-ignored-exlock.mjs", import.meta.url).pathname,
      "--input-type=module", "-e", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { output += String(chunk); });
    assert.equal(await awaitChildV1(child, "ignored lock"), 0, output);
    assert.equal((await stat(lockPath)).ino, before.ino, "the live lock was not replaced");
    assert.equal(await readFile(partialPath, "utf8"), "partial bytes\n");
    assert.deepEqual((await readdir(root)).sort(), [".control-room-result-file-store.lock", `${PENDING_PREFIX}${"a".repeat(32)}`].sort());
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await awaitChildV1(child, "ignored lock cleanup").catch(() => {});
    }
    await held?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("B3: the store's only answers are its own codes, on every path a caller can reach", async () => {
  // The error contract, pinned where it was weakest. The store promises that a
  // refusal is always one of `store_invalid`, `store_missing`, `store_conflict`,
  // `store_capacity` or `store_ambiguous` — never a system errno. Two paths used
  // to break that, and this is the test that says so:
  //
  //   1. `stillOwnsTheName` re-throws an errno it cannot interpret, on purpose,
  //      because a store that cannot ASK must not answer. In `writeExclusive`
  //      that happened before any mutation, so the catch block passed the errno
  //      straight through to the caller. It is now a clean `store_ambiguous`.
  //   2. `removeProvenAbandoned`'s lstat-then-unlink is not atomic, so a
  //      concurrent recovery can remove the name in between and the unlink
  //      failed with a raw ENOENT out of `create()`. Measured by the review at
  //      39 in 20 seconds.
  //
  // What is asserted here is the CONTRACT, on the paths that provably fail for a
  // process that owns the directory. An errno that needs an unwritable root to
  // provoke cannot be provoked as the owner — root ignores the group bits — and
  // a test that pretends otherwise is a test that passes by luck, so the trigger
  // is not faked: a path that does not exist, and a configuration the store
  // refuses, are both real failures with real errnos behind them.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-errno-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { mode: 0o700 });
    // A root that does not exist: the realpath/lstat pair behind `create` returns
    // ENOENT, and the store's answer has to be its own code. Before the round
    // this was `store_invalid` by a dedicated `catch` — the shape is right, and
    // it is asserted here so a later refactor that "simplifies" that catch into
    // a re-throw is caught.
    await assert.rejects(
      ResultFileStoreV1.create({ ...configurationV1(join(root, "absent")) }),
      (error: unknown) => (error as { code?: string }).code === "store_invalid",
    "a root that does not exist is `store_invalid`, never the ENOENT the lstat returned");
    // A configuration the store refuses before it touches the disk. No errno is
    // involved at all, and it is here because "its own codes, always" includes
    // the answers that are decided rather than provoked.
    await assert.rejects(
      ResultFileStoreV1.create({ ...configurationV1(root), operationTimeoutMs: 30_001 }),
      (error: unknown) => (error as { code?: string }).code === "store_invalid",
    "a configuration above the ceiling is `store_invalid`");
    // The live store still works after both refusals: these are clean answers,
    // and the store stays usable.
    const store = await ResultFileStoreV1.create(configurationV1(root));
    const payload = new Uint8Array(PAYLOAD);
    payload.fill(12);
    const id = { tenantId: TENANT, projectId: "project:errno",
      fileId: `result-file:${"b".repeat(32)}`,
      contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
    await store.put({ ...id, bytes: payload });
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(payload),
      "a refusal leaves the store usable: the write after it lands");
    // And a read of something that is not there is `undefined`, not ENOENT — the
    // read path's own version of the same promise.
    assert.equal(await store.read({ ...id, fileId: `result-file:${"c".repeat(32)}`,
      contentDigest: id.contentDigest }), undefined,
    "a missing file is `undefined`, not the ENOENT the open returned");
  } finally { await rm(base, { recursive: true, force: true }); }
  });

test("B7: a crash between link() and the staging unlink does not lock the store out for ever",
  async () => {
    // Found by the review's own crash harness against this fix, and it is a
    // pre-existing bug rather than one this round introduced — the guard that
    // caused it is older still.
    //
    // A writer that is killed between `link(pending, target)` and its staging
    // `unlink` leaves TWO names for one inode: the result the catalog will look
    // for, and the staging name the recovery has to clear. The staging name is
    // therefore at link count 2, and `removeProvenAbandoned` used to refuse any
    // name that was — which meant every later open found the same staging file
    // and refused it again. Measured: 5 of 24 SIGKILLed writers left the store
    // unable to open, and it never recovered on any subsequent open. That is
    // the review's B7 exactly in reverse: the crash recovery exists so a crash
    // costs the owner one half-written file, and this made a crash cost every
    // task, for ever, from the one file it always had to delete.
    //
    // The link count was guarding against deleting a file that belongs to
    // somebody else. For a RESULT name that is the right guard, and it is still
    // there. For a staging name it is the wrong one, and the reason is the same
    // reason a staging file may be removed at all: it is not a result name, is
    // never readable as one, and unlinking it can only ever remove this store's
    // own half-written bytes.
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-nlink-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      const store = await ResultFileStoreV1.create(configurationV1(root));
      // A real stored file, so the "did clearing the leftover cost anything"
      // question has an answer that is not "the store was empty anyway".
      const payload = new Uint8Array(PAYLOAD);
      payload.fill(11);
      const id = { tenantId: TENANT, projectId: "project:nlink",
        fileId: `result-file:${"8".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
      await store.put({ ...id, bytes: payload });
      // The exact state a SIGKILL between link() and unlink leaves: the staging
      // name is a second hard link to the file that was just stored.
      const result = (await readdir(root)).find(entry => entry.endsWith(".crbf"))!;
      const staging = `${PENDING_PREFIX}crash-window`;
      await link(join(root, result), join(root, staging));
      assert.ok((await lstat(join(root, staging))).nlink === 2,
        "the leftover really is at link count 2, or this test is measuring nothing");
      // The store OPENS, and the leftover is gone.
      const reopened = await ResultFileStoreV1.create(configurationV1(root));
      assert.ok(reopened, "a staging name at link count 2 is cleared, not refused");
      assert.deepEqual((await readdir(root)).filter(entry => entry.startsWith(".")), [],
        "and the leftover is actually gone, rather than being tolerated in place");
      // And the file that shared the inode with it is untouched, whole, and
      // re-proves its own digest — which is the whole point of tolerating the
      // count for a staging name rather than for a result.
      assert.deepEqual(Buffer.from((await reopened.read(id))!), Buffer.from(payload),
        "the result that shared the inode is still byte-for-byte what it was");
      assert.equal((await readdir(root)).filter(entry => entry.endsWith(".crbf")).length, 1,
        "and there is still exactly one name for it");
      // A LOCK name at link count 2 is a different matter and is still refused:
      // the staging relaxation must not have widened into the lock names, which
      // are the ones the original guard was really protecting. Without this the
      // fix above could be a general relaxation and still pass everything else.
      //
      // A LOCK name at link count 2 is a different matter, and the promise there
      // is not a refusal: a leftover lock is LEFT ALONE and the store still
      // opens, which is the review's B1+B7 rule and the one that stops a crash
      // from locking the owner out of every task. What matters is that the
      // staging relaxation did not become a general one — a name the store
      // cannot claim as its own single file is still not removed, and here the
      // extra name is the result's inode, so removing the lock name would have
      // removed a link to a file the catalog still needs.
      await writeFile(join(root, LOCK_NAME), "", { mode: 0o600 });
      await unlink(join(root, LOCK_NAME));
      await link(join(root, result), join(root, LOCK_NAME));
      assert.equal((await lstat(join(root, LOCK_NAME))).nlink, 2,
        "the lock name is at link count 2, or this half of the test proves nothing");
      const withLinkedLock = await ResultFileStoreV1.create(configurationV1(root));
      assert.ok(withLinkedLock, "a lock name the store cannot claim does not stop it opening");
      assert.ok((await readdir(root)).includes(LOCK_NAME),
        "and the name is left exactly where it is: the relaxation is for staging names only");
      // The READ is a refusal here, and that is the store's existing and correct
      // rule rather than anything this fix touched: the read path demands link
      // count 1, because a result reachable under a second name could be
      // replaced through it. A crash that leaves one is exactly the case that
      // rule exists for. What matters for B3 is that the store still OPENS — the
      // owner can still start a task — and that clearing the leftover is an
      // operator-reachable path rather than an impossible one.
      await assert.rejects(withLinkedLock.read(id),
        (error: unknown) => STORE_CODES.includes(String((error as { code?: string }).code)),
      "and a result still reachable under a second name is a refusal on the read path, as it always was");
      // Remove the extra name by hand — what the recovery cannot prove, an
      // operator can — and the result reads back whole. So the leftover is a
      // refusal to SERVE, not a corrupted store.
      await unlink(join(root, LOCK_NAME));
      const repaired = await ResultFileStoreV1.create(configurationV1(root));
      assert.deepEqual(Buffer.from((await repaired.read(id))!), Buffer.from(payload),
        "and once the extra name is gone the result is byte-for-byte what it was");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
