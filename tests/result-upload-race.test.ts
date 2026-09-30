// The upload staging area, raced with REAL processes.
//
// Part 1's review (files4) proved that a store can pass every single-writer
// test and still hand a live writer's lock and its half-written file to a second
// program, so the store's own lane drives real processes at one directory. The
// upload path has the same shape and none of that evidence, because until now
// nothing but one process ever touched a staging area: `create()` is called once
// per gateway process, and the review's 40-second race was never run against it.
//
// The staging area is where a half-written CHUNK lives, so its four counters map
// onto the store's four with the differences spelled out rather than assumed:
//
//   * halfWrittenChunks — a `.part` scratch file visible in the directory while
//     its upload also has a finalised chunk name. That is two writers inside one
//     chunk's write, and the loser of `rename` would overwrite the winner's bytes.
//   * unknownEntries    — a directory entry that is neither a derived chunk name
//     nor a scratch file. Every writer's next operation refuses on it, so one
//     unexplained entry stops the whole install's uploads.
//   * rawErrnos         — a system errno escaping stage/read/assemble. The
//     staging area's contract is its four fixed codes and nothing else.
//   * tornChunks        — a finalised chunk whose bytes do not hash to the digest
//     the writer sent, which is the corruption the whole design exists to stop.
//
// The counters are observed by the parent from the CHILDREN'S OWN reports plus a
// read-only observer, and the observer opens nothing and removes nothing, so it
// cannot be the thing that breaks what it measures.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const TENANT = "tenant:upload-race";
const PROJECT = "project:upload-race";
/** The staging area's own answers: its `code` values and nothing else. A child's
 * error is one of these, which is the area working, or a system errno, which is a
 * breach of its contract. Injected into every child so the two cannot drift. */
const STAGING_CODES = ["staging_invalid", "staging_missing", "staging_conflict", "staging_ambiguous"];
const STAGING_MODULE = join(process.cwd(), "src/artifacts/v1/result-upload-staging.ts");
/** 64 KiB: the same payload size part 1's store race used, so the two lanes are
 * comparable, and large enough that the scratch window is wide enough to catch. */
const PAYLOAD = 65_536;
/** 40 seconds, kept at part 1's measurement window so a reviewer comparing the
 * two reports is comparing like with like. */
const SECONDS = 40;
const WRITERS = 2;
const OPENERS = 4;

/** The one derived chunk name EVERY writer contends for. Two writers, one name:
 * that is the race. A per-writer name makes each writer's read a same-process
 * echo and the whole lane vacuous. */
const SHARED_UPLOAD = "result-upload:" + "f".repeat(32);
const configurationV1 = (rootPath: string) => ({
  rootPath, maximumChunkBytes: 8 * 1024 * 1024, operationTimeoutMs: 30_000,
});


/** Deterministic payload per (upload, ordinal), so a reader that finds the same
 * bytes twice can tell a replay from a torn write without trusting either child. */
const payloadOf = (upload: number, ordinal: number): Uint8Array => {
  const bytes = new Uint8Array(PAYLOAD);
  for (let index = 0; index < PAYLOAD; index += 1) bytes[index] = (upload * 31 + ordinal * 7 + index) % 251;
  return bytes;
};

/** A child that has been asked to run, and a promise for its output.
 *
 * The ref'd interval is load-bearing and not decoration: a `ChildProcess` is not
 * a ref'd handle, so a test that only awaits `once("exit")` leaves Node nothing
 * to keep the event loop alive and the lane ends "promise resolution still
 * pending". That is part 1's B2 arriving through the test, and it reads exactly
 * like a hang. */
function racerV1(script: string): { child: ChildProcess; exited: Promise<number | null>; output: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd(),
  });
  let out = "";
  child.stdout!.on("data", chunk => { out += String(chunk); });
  // stderr is captured rather than inherited, and reported in the assertion
  // message: a child that died must say why rather than leaving the lane to fail
  // on a counter that never moved.
  child.stderr!.on("data", chunk => { out += String(chunk); });
  const keepAlive = setInterval(() => {}, 1_000);
  const exited = new Promise<number | null>(resolve => {
    child.once("exit", code => { clearInterval(keepAlive); resolve(code); });
  });
  return { child, exited, output: () => out };
}

/** A writer: open the staging area, then stage and read chunks as fast as it can
 * for the window, each on its own derived upload so two writers never share a
 * name by accident.
 *
 * Every error is counted BY CODE, because the distinction that matters is between
 * the area's own refusals and a raw errno. A refusal is a correct answer to
 * "another writer is in here"; a raw `ENOENT` is a lost chunk. */
const writerScriptV1 = (root: string, seed: number) => `
  const { openResultUploadStagingV1 } = await import(${JSON.stringify(STAGING_MODULE)});
  const STAGING_CODES = new Set(${JSON.stringify(STAGING_CODES)});
  const { createHash } = await import("node:crypto");
  const TENANT = ${JSON.stringify(TENANT)}, PROJECT = ${JSON.stringify(PROJECT)};
  const PAYLOAD = ${PAYLOAD}, SEED = ${seed};
  const SHARED_UPLOAD = ${JSON.stringify(SHARED_UPLOAD)};
  const payloadOf = (upload, ordinal) => {
    const bytes = new Uint8Array(PAYLOAD);
    for (let i = 0; i < PAYLOAD; i += 1) bytes[i] = (upload * 31 + ordinal * 7 + i) % 251;
    return bytes;
  };
  const configuration = ${JSON.stringify(configurationV1(root))};
  const codes = {};
  let staging = null;
  for (;;) {
    try { staging = await openResultUploadStagingV1(configuration); codes.opened = (codes.opened ?? 0) + 1; break; }
    catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      codes[key] = (codes[key] ?? 0) + 1;
      if (!STAGING_CODES.has(key)) { console.log("RAW " + JSON.stringify({ key, syscall: error.syscall })); break; }
    }
  }
  if (staging) {
    const end = Date.now() + ${SECONDS * 1000};
    while (Date.now() < end) {
      // The SAME derived name for every writer and every iteration, so two
      // processes really do contend for ONE chunk. A per-writer name would make
      // each writer's read a same-process echo of its own write and the race
      // would be vacuous -- which is exactly what the first version of this lane
      // did, and mutation proved it: replacing the staging area's scratch-then-
      // rename with a direct write under the final name left the lane green.
      //

      const id = SHARED_UPLOAD;
      // The SAME bytes in every writer, so two processes contending for one
      // ordinal is a genuine replay -- the create-once path -- rather than two
      // different chunks for one name. With per-writer bytes the loser gets the
      // area's own staging_conflict, which is correct and would hide the race
      // this lane exists to measure.
      const bytes = payloadOf(0, 1);
      const expected = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      // Every writer sends the same bytes, so a read-back that hashes to
      // anything else IS a torn write -- the area promised create-once and the
      // scratch-then-rename is what delivers it.
      try {
        await staging.stage({ tenantId: TENANT, projectId: PROJECT, uploadId: id, ordinal: 1 }, bytes);
        // Read it BACK and re-hash. A torn or overwritten chunk fails here, which
        // is the corruption this whole design exists to prevent -- and it is the
        // only way a reader proves a writer's bytes survived the race.
        const read = await staging.read({ tenantId: TENANT, projectId: PROJECT, uploadId: id, ordinal: 1 });
        const actual = read ? "sha256:" + createHash("sha256").update(read).digest("hex") : null;
        if (actual === expected && read && read.byteLength === PAYLOAD) codes.ok = (codes.ok ?? 0) + 1;
        else if (actual !== null) { codes.torn = (codes.torn ?? 0) + 1; console.log("TORN " + JSON.stringify({ expected, actual })); }
        await staging.discardSession({ tenantId: TENANT, projectId: PROJECT, uploadId: id });
      } catch (error) {
        const key = error && error.code ? error.code : (error ? error.name : "unknown");
        codes[key] = (codes[key] ?? 0) + 1;
        if (STAGING_CODES.has(key)) codes.refusals = (codes.refusals ?? 0) + 1;
        else console.log("RAW " + JSON.stringify({ key, syscall: error.syscall }));
      }
    }
  }
  console.log("CODES " + JSON.stringify(codes));`;

/** An opener: open the staging area as often as it can. `create()` runs the
 * accounting over every entry, so a concurrent writer's scratch file is exactly
 * what it has to tolerate, and a refusal here is the area being honest about a
 * directory it cannot account for. */
const openerScriptV1 = (root: string) => `
  const { openResultUploadStagingV1 } = await import(${JSON.stringify(STAGING_MODULE)});
  const STAGING_CODES = new Set(${JSON.stringify(STAGING_CODES)});
  const configuration = ${JSON.stringify(configurationV1(root))};
  const codes = {};
  const end = Date.now() + ${SECONDS * 1000};
  while (Date.now() < end) {
    try { await openResultUploadStagingV1(configuration); codes.opened = (codes.opened ?? 0) + 1; }
    catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      codes[key] = (codes[key] ?? 0) + 1;
      if (STAGING_CODES.has(key)) codes.refusals = (codes.refusals ?? 0) + 1;
      else console.log("RAW " + JSON.stringify({ key, syscall: error.syscall }));
    }
  }
  console.log("CODES " + JSON.stringify(codes));`;

test("the upload staging area survives two writers and four openers racing one directory",
  { timeout: 300_000 }, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-upload-staging-race-")));
    const racers: ReturnType<typeof racerV1>[] = [];
    try {
      const root = join(base, "staging");
      await mkdir(root, { mode: 0o700 });

      // The observer. It samples the directory names as fast as it can and records
      // the two states that must never occur. It reads NAMES ONLY: it opens
      // nothing, takes no lock and removes nothing, so it cannot be the thing that
      // breaks the exclusion it is measuring.
      let samples = 0;
      let unknownEntries = 0;
      const onDisk = /^[a-f0-9]{64}\.chunk$/u;
      const scratch = /^\.staging-[a-f0-9]{64}-[a-z0-9]+-\d+\.part$/u;
      void scratch;
      let stop = false;
      const observer = (async () => {
        while (!stop) {
          let entries: string[] = [];
          try { entries = await readdir(root); } catch { continue; }
          samples += 1;
          // Every writer writes the SAME chunk name here, so a scratch file and a
          // finalised chunk in one sample are the ordinary shape (one writer's
          // scratch beside another's finished chunk). What must never appear is a
          // scratch file for a chunk that is ALREADY finalised -- that is two
          // writers inside one chunk's write, which is the state a direct write
          // under the final name produces and which mutation testing showed the
          // first version of this lane could not see.
          // (The scratch-vs-finalised shape is NOT counted here: with one shared
          // name a scratch beside a finalised chunk is ordinary, and a counter
          // that can never move is not a measurement.)
          const unknown = entries.filter((entry) => !onDisk.test(entry) && !scratch.test(entry));
          if (unknown.length) { unknownEntries += 1; console.log("UNKNOWN " + JSON.stringify(unknown)); }
        }
      })();

      for (let index = 0; index < WRITERS; index += 1)
        racers.push(racerV1(writerScriptV1(root, index + 1)));
      for (let index = 0; index < OPENERS; index += 1)
        racers.push(racerV1(openerScriptV1(root)));
      const exits = await Promise.all(racers.map(racer => racer.exited));
      stop = true;
      await observer;

      const output = racers.map(racer => racer.output());
      // The children are the measurement, so their own report has to be read
      // before anything is asserted: a writer that never got past `create()` and
      // a writer that did fifty writes both report `fail 0` here.
      const codes = output.flatMap(text => text.split("\n").filter(line => line.startsWith("CODES "))
        .map(line => JSON.parse(line.slice("CODES ".length)) as Record<string, number>));
      const raw = output.flatMap(text => text.split("\n").filter(line => line.startsWith("RAW ")));
      const torn = output.flatMap(text => text.split("\n").filter(line => line.startsWith("TORN ")));
      const unknown = output.flatMap(text => text.split("\n").filter(line => line.startsWith("UNKNOWN ")));

      const landed = codes.reduce((total, entry) => total + (entry.ok ?? 0), 0);
      const opened = codes.reduce((total, entry) => total + (entry.opened ?? 0), 0);
      const refusals = codes.reduce((total, entry) => total + (entry.refusals ?? 0), 0);
      const report = { landed, opened, refusals, samples, unknownEntries };

      assert.deepEqual(exits, Array(WRITERS + OPENERS).fill(0),
        `every child exited cleanly: ${JSON.stringify(report)}\n${output.join("\n")}`);
      // The measurement has to have happened, or the zeros below prove nothing.
      assert.ok(landed > 0, `both writers actually wrote and re-read chunks: ${JSON.stringify(report)}`);
      assert.ok(opened > 0, `the area really was opened repeatedly: ${JSON.stringify(report)}`);

      // The four counters. Each is zero because the design holds, not because the
      // window was too short to matter -- which is what `landed > 0` above proves.
      assert.deepEqual(raw, [],
        `a raw system errno escaped the staging area, which forbids it: ${JSON.stringify(report)}\n${raw.join("\n")}`);
      assert.deepEqual(torn, [],
        `a chunk was read back with bytes that are not the ones written: ${JSON.stringify(report)}\n${torn.join("\n")}`);
      assert.equal(unknown.length, 0,
        `the directory held an entry this area cannot account for: ${JSON.stringify(report)}\n${unknown.join("\n")}`);
      assert.equal(unknownEntries, 0, `the observer saw an unaccountable entry: ${JSON.stringify(report)}`);

      // And the area still opens afterwards, with an empty directory it can fully
      // account for -- a crashed upload must never lock the next one out, which
      // is part 1's crash-lock-out lesson applied here.
      const { openResultUploadStagingV1 } = await import(STAGING_MODULE);
      const reopened = await openResultUploadStagingV1(configurationV1(root));
      assert.deepEqual(await reopened.stagedNames(), [],
        "the racing leaves no chunk behind, and the area reopens on a directory it can account for");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

/** Rounds for the different-bytes race, and how long each one lasts. Each round
 * is a fresh upload id shared by both writers, started on the same wall-clock
 * slot, so the two really are inside one chunk's write at once rather than one
 * trailing the other by a whole iteration. 320 rounds is the count the review's
 * own probe used (files2up S2: 30 of 320 double-creates under `rename`). */
const DIFFERENT_ROUNDS = 320;
const DIFFERENT_SLOT_MS = 100;

/** A writer that sends ITS OWN bytes for every round's one chunk and never
 * discards, so the parent can read afterwards exactly which bytes each round
 * kept. Its outcome per round is printed as `ROUND <k> <outcome>`. */
const differentWriterScriptV1 = (root: string, seed: number, startAt: number) => `
  const { openResultUploadStagingV1 } = await import(${JSON.stringify(STAGING_MODULE)});
  const STAGING_CODES = new Set(${JSON.stringify(STAGING_CODES)});
  const TENANT = ${JSON.stringify(TENANT)}, PROJECT = ${JSON.stringify(PROJECT)};
  const PAYLOAD = ${PAYLOAD}, SEED = ${seed};
  const bytes = new Uint8Array(PAYLOAD);
  for (let i = 0; i < PAYLOAD; i += 1) bytes[i] = (SEED * 97 + i) % 251;
  const staging = await openResultUploadStagingV1(${JSON.stringify(configurationV1(root))});
  const startAt = ${startAt};
  for (let round = 0; round < ${DIFFERENT_ROUNDS}; round += 1) {
    const slot = startAt + round * ${DIFFERENT_SLOT_MS};
    const wait = slot - Date.now();
    if (wait > 0) await new Promise((settle) => setTimeout(settle, wait));
    const uploadId = "result-upload:" + round.toString(16).padStart(32, "0");
    let outcome;
    try {
      const result = await staging.stage({ tenantId: TENANT, projectId: PROJECT, uploadId, ordinal: 1 }, bytes);
      outcome = result.replayed ? "replayed" : "created";
    } catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      outcome = STAGING_CODES.has(key) ? key : "RAW:" + key;
    }
    console.log("ROUND " + round + " " + outcome);
  }`;

test("two writers racing DIFFERENT bytes for one chunk: at most one ever creates it, and its bytes are the chunk",
  { timeout: 300_000 }, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-upload-staging-race-different-")));
    try {
      const root = join(base, "staging");
      await mkdir(root, { mode: 0o700 });
      // Far enough ahead that both children have imported the module before the
      // first slot, so round 0 is as contended as round 319.
      const startAt = Date.now() + 5_000;
      const racers = [1, 2].map((seed) => racerV1(differentWriterScriptV1(root, seed, startAt)));
      const exits = await Promise.all(racers.map((racer) => racer.exited));
      const outputs = racers.map((racer) => racer.output());
      assert.deepEqual(exits, [0, 0], `both writers exited cleanly\n${outputs.join("\n")}`);
      const outcomes = outputs.map((text) => new Map(text.split("\n").filter((line) => line.startsWith("ROUND "))
        .map((line) => { const [, round, outcome] = line.split(" "); return [Number(round), outcome!] as const; })));
      for (const [index, map] of outcomes.entries())
        assert.equal(map.size, DIFFERENT_ROUNDS, `writer ${index + 1} reported every round\n${outputs[index]}`);

      const payloadFor = (seed: number) => {
        const bytes = new Uint8Array(PAYLOAD);
        for (let i = 0; i < PAYLOAD; i += 1) bytes[i] = (seed * 97 + i) % 251;
        return bytes;
      };
      const { openResultUploadStagingV1 } = await import(STAGING_MODULE);
      const staging = await openResultUploadStagingV1(configurationV1(root));
      const doubleCreated: number[] = [], raw: string[] = [], wrongBytes: number[] = [], replays: number[] = [];
      let contended = 0;
      for (let round = 0; round < DIFFERENT_ROUNDS; round += 1) {
        const [first, second] = [outcomes[0]!.get(round)!, outcomes[1]!.get(round)!];
        for (const outcome of [first, second]) if (outcome.startsWith("RAW:")) raw.push(`${round}:${outcome}`);
        // Different bytes can never be a replay of each other.
        if (first === "replayed" || second === "replayed") replays.push(round);
        if (first === "created" && second === "created") doubleCreated.push(round);
        if (first !== "created" || second !== "created") contended += Number(first !== second);
        const creator = first === "created" ? 1 : second === "created" ? 2 : undefined;
        const kept = await staging.read({ tenantId: TENANT, projectId: PROJECT,
          uploadId: "result-upload:" + round.toString(16).padStart(32, "0"), ordinal: 1 });
        if (creator !== undefined && (!kept || !Buffer.from(kept).equals(Buffer.from(payloadFor(creator)))))
          wrongBytes.push(round);
      }
      const report = { rounds: DIFFERENT_ROUNDS, contended, doubleCreated: doubleCreated.length,
        wrongBytes: wrongBytes.length, replays: replays.length, raw: raw.length };
      // The measurement happened: in most rounds one writer lost, which is only
      // possible if both were writing that round's chunk.
      assert.ok(contended > DIFFERENT_ROUNDS / 2, `the two writers really contended: ${JSON.stringify(report)}`);
      assert.deepEqual(raw, [], `no raw errno escaped: ${JSON.stringify(report)}`);
      assert.deepEqual(replays, [], `different bytes were never answered as a replay: ${JSON.stringify(report)}`);
      assert.deepEqual(doubleCreated, [],
        `both writers were told they CREATED the same chunk: ${JSON.stringify(report)}`);
      assert.deepEqual(wrongBytes, [],
        `a round kept bytes other than the writer that was told it created them: ${JSON.stringify(report)}`);
      console.log(`different-bytes race: ${JSON.stringify(report)}`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
