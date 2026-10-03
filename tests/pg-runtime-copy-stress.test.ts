// Stress and unhappy-path coverage for item 3b.
//
// The owner rule asks for more than a green lane: a second concurrent caller, a
// retry after a failure, a stop halfway, and real load. Most of that is about
// the CLONE, because a clone is the one step here that touches a live
// database and the one step whose failure mode is silent (§8.6). Everything
// here is bounded and uses only temp roots on ports 59500-59509.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planPgClusterLayoutV1, verifyPgRuntimeEnvironmentV1 } from "../src/pg-runtime/v1/pg-cluster-layout";
import { planPgPreimageV1 } from "../src/pg-runtime/v1/pg-preimage-clone";
import {
  classifyPgCloneProbeV1, pgCloneReservationMultiplierV1, PG_CLONE_PROBE_BYTES_V1,
  type PgCloneProbeV1,
} from "../src/pg-runtime/v1/pg-clone-probe";
import { planPgRuntimeCopyV1, classifyPgRuntimeArchiveEntryV1 } from "../src/updater/v1/pg/pg-runtime-copy";

/**
 * A typed promise wrapper over `execFile`.
 *
 * `promisify(execFile)` types its callback as the LAST argument, so a
 * three-argument call whose options object does not match `ExecFileOptions`
 * picks the wrong overload and passes the options object itself as the
 * callback: `TypeError [ERR_INVALID_ARG_TYPE]: The "callback" argument must be
 * of type function. Received an instance of Object`. MEASURED three times,
 * because each partial fix only covered the call sites it happened to be
 * looking at. One wrapper, declared once, so no call in this file can reach
 * `execFile` by another route.
 */
const run = (file: string, args: readonly string[], options: {
  encoding: "utf8"; maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args as string[], options, (error, stdout, stderr) => {
      if (error) { rejectPromise(error); return; }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
const OS_ACCOUNT = userInfo().username;
const PG_BIN = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/bin"]
  .find(dir => dir && existsSync(join(dir, "initdb")));
const needsPg = PG_BIN ? false : "needs PostgreSQL 17 (PG_BIN)";
const PORT_BASE = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59500);
// A SHORT root, and that is a requirement rather than a preference.
// MEASURED: the layout refuses a socket path over 100 bytes, and this lane's
// own root under CONTROL_ROOM_PGRT_TMPDIR reached 104 — so every test in it
// failed on its own harness, not on the code. The budget exists because macOS
// `sun_path` is 104 bytes and a postmaster that overruns it fails deep inside
// the server, after initdb has written the data directory. A test harness that
// overruns the same budget is a harness that cannot test the thing.
const LANE_ROOT = join(process.env.TMPDIR ?? "/tmp", `p${process.pid.toString(36)}`);

function laneRun(label: string): string {
  mkdirSync(LANE_ROOT, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(LANE_ROOT, `${label}-`));
}
/**
 * Remove the lane root, restoring write permission first.
 *
 * The real-PostgreSQL lane creates its runtime directory 0555 because that is
 * how `runtime/` looks in production, and `rm -rf` cannot unlink inside a
 * directory it cannot write. MEASURED: without this, the lane leaves its whole
 * root behind and the operator's cleanup fails with `Permission denied`.
 */
process.on("exit", () => {
  try { execFileSync("/bin/chmod", ["-R", "u+rwx", LANE_ROOT]); } catch { /* best effort */ }
  try { rmSync(LANE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * The PG-family environment, typed for `execFile`. `ProcessEnv` here requires
 * `NODE_ENV` and no PG-family process gets one, so this says "an environment,
 * deliberately not a ProcessEnv" rather than adding a variable a real
 * postmaster would never have.
 */
// `as unknown as ProcessEnv`, not `as ProcessEnv`: the object has no index
// signature, so the direct cast is rejected (TS2352) and needs the two-step. It
// is still honest — the object IS an environment and is deliberately not a
// `ProcessEnv`, which requires a `NODE_ENV` no PG-family process receives.
const env = (): NodeJS.ProcessEnv =>
  ({ LC_ALL: "C", LANG: "C", TZ: "UTC" }) as unknown as NodeJS.ProcessEnv;

/**
 * Options for a PG-family call: the pinned environment and nothing else.
 *
 * A FUNCTION, not a shared constant, so one call's environment can never leak
 * into another's and no call site can mutate another's options.
 */
const execOptions = () =>
  ({ env: env(), encoding: "utf8" as const, maxBuffer: 1 << 26, timeout: 120_000 });

function freeBytes(path: string): number {
  return Number(execFileSync("/bin/df", ["-k", path], { encoding: "utf8" }).trim().split("\n").pop()!.split(/\s+/)[3]) * 1024;
}
function allocatedBytes(root: string): number {
  return Number(execFileSync("/usr/bin/du", ["-sk", root], { encoding: "utf8" }).trim().split(/\s+/)[0]) * 1024;
}

/**
 * The sidecar, built ONCE by this lane through the real build script, and asked
 * through the real parser.
 *
 * FINDING 8's answer to "there is no TypeScript that spawns it and parses
 * `ok <n>` / `errno <n>`". Using the real `runPgCloneProbeV1` here rather than a
 * hand-rolled spawn is the point: this lane must not drift from the way item 18
 * will call the probe, and a lane that spawned the binary itself would keep
 * passing if the parser were wrong.
 */
const ARTIFACT_DIRECTORY = join(LANE_ROOT, "clone-probe-artifact");
let sidecarPromise: Promise<string> | undefined;

/** The built sidecar's path, building it on first use. */
async function pgCloneProbeSidecar(): Promise<string> {
  sidecarPromise ??= (async () => {
    const { buildPgCloneProbeNativeArtifactV1 } = await import("../scripts/build-pg-clone-probe-native.mjs");
    await buildPgCloneProbeNativeArtifactV1({ outputDirectory: ARTIFACT_DIRECTORY });
    return join(ARTIFACT_DIRECTORY, "pg-clone-probe-v1");
  })();
  return sidecarPromise;
}

/**
 * The kernel's answer for `directory`, as the sidecar printed it.
 *
 * The verdict is re-derived from `classifyPgCloneProbeV1` rather than read off
 * the run, so the assertions in this lane are about the MECHANISM and both
 * halves come from the same real run of the real binary.
 */
async function kernelProbe(directory: string): Promise<PgCloneProbeV1> {
  const { runPgCloneProbeV1 } = await import("../src/pg-runtime/v1/pg-clone-probe-sidecar");
  const run = await runPgCloneProbeV1({ sidecarPath: await pgCloneProbeSidecar(), pgDirectory: directory });
  assert.equal(run.unrecognised, false,
    `the sidecar must print the protocol; it printed ${JSON.stringify(run.raw)}`);
  // `runPgCloneProbeV1` already classified it, and this asserts that the run's
  // own verdict is the one the lane reports — a mismatch would mean the parser
  // and this test disagree about what the binary said.
  assert.equal(run.verdict.cloned, /^ok /u.test(run.raw),
    "the verdict must follow the sidecar's own line, with no threshold in between");
  return run.verdict;
}

/**
 * The clone verdict, from the KERNEL, in the directory the preimage would use.
 *
 * FINDING 7, and this is the port the review asked for: the two tests that
 * asserted on `classifyPgCloneV1` now go through the sidecar, because that
 * function is deleted. The old probe here was a 1 MB non-sparse file through
 * `cp -c` measured with `df` deltas, and the review's words for it were "the
 * exact mechanism finding 12 rejected".
 *
 * The `df` measurement is kept as a REPORTED number, not as the decision,
 * because it is the honest record of what the volume charged and it is what
 * makes the kernel's answer checkable by a person: if the kernel cloned and the
 * delta is 100% of the probe, the delta is the wrong measurement, not the
 * verdict. The stress lane's own test flaked on exactly that once in the
 * reviewer's run — a real APFS clone charged 52% of the probe and the threshold
 * called it a copy.
 */
async function cloneProbe(directory: string): Promise<Readonly<{
  sourceBytes: number; consumedBytes: number; verdict: PgCloneProbeV1;
}>> {
  const sourceBytes = 1024 * 1024;
  const source = join(directory, "clone-probe.bin");
  writeFileSync(source, Buffer.alloc(sourceBytes, 0x5a));
  const before = freeBytes(directory);
  execFileSync("/bin/cp", ["-c", source, targetName(directory)], { env: env() });
  const consumedBytes = before - freeBytes(directory);
  rmSync(targetName(directory), { force: true });
  rmSync(source, { force: true });
  return { sourceBytes, consumedBytes, verdict: await kernelProbe(directory) };
}
const targetName = (directory: string): string => join(directory, "clone-probe-copy.bin");

async function startCluster(label: string, portOffset: number, load = false) {
  const root = laneRun(label);
  const port = PORT_BASE + portOffset;
  // pgRoot is the lane run itself, not `<run>/pg`: the layout checks the socket
  // path against a 100-byte budget and this harness's own root is what overruns
  // it. MEASURED — every test in this lane failed on its own path before this.
  const layout = planPgClusterLayoutV1({
    pgRoot: root, dataId: "data-A", runtimeDirectory: join(root, "pg-current"),
    accounts: { database: OS_ACCOUNT, migrator: "cr_migrator_test", deployer: "cr_deployer_test" }, port,
  });
  assert.equal(layout.status, "socket_only_cluster_layout_built", layout.refusal?.detail);
  const data = join(root, "data-A");
  mkdirSync(join(root, "socket"), { recursive: true, mode: 0o750 });
  await run(join(PG_BIN!, "initdb"), ["-D", data, "-U", "postgres", "-E", "UTF8", "--auth-local=trust", "-N"], execOptions());
  writeFileSync(join(data, "postgresql.conf"), layout.postgresqlConf);
  writeFileSync(join(data, "pg_hba.conf"), layout.pgHbaConf);
  writeFileSync(join(data, "pg_ident.conf"), layout.pgIdentConf);
  const cluster = { root, data, socket: join(root, "socket"), port, layout };
  await run(join(PG_BIN!, "pg_ctl"), ["-D", data, "-o", `-p ${port} -c fsync=off`, "-l", join(root, "log"),
    "-w", "-t", "60", "start"], execOptions());
  if (load) {
    await run(join(PG_BIN!, "psql"), ["-w", "-h", cluster.socket, "-p", String(port), "-U", "postgres",
      "-d", "postgres", "-Atc",
      "CREATE TABLE b(id int primary key, v bytea); INSERT INTO b SELECT g, repeat('x',4000)::bytea FROM generate_series(1,40000) g; CHECKPOINT;"],
    execOptions());
    await run(join(PG_BIN!, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "60", "stop"], execOptions());
  }
  return cluster;
}
const stopCluster = (c: { data: string }) =>
  run(join(PG_BIN!, "pg_ctl"), ["-D", c.data, "-m", "immediate", "-w", "-t", "20", "stop"], execOptions())
    .catch(() => undefined);

// ---------------------------------------------------------------------------

test("20 parallel preimage plans for the same source all refuse or all agree, never half of each", { skip: needsPg, timeout: 300_000 }, async () => {
  // The updater is a single actor (§7.2) with a lease, so a second concurrent
  // caller is a bug in the caller, not something the plan should tolerate
  // silently. What the plan CAN do is refuse a source with a postmaster in it —
  // and once one caller starts the clone the source is unchanged, so 20 callers
  // planning against the same cleanly-shut-down source must produce 20
  // IDENTICAL plans. A plan that read mutable state and got it wrong would
  // produce a mixture.
  const cluster = await startCluster("concurrent", 0, true);
  try {
    const control = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", cluster.data], { encoding: "utf8" });
    const state = /Database cluster state:.*/u.exec(control)?.[0] ?? "";
    const input = {
      sourceDataDirectory: cluster.data, targetDataDirectory: join(cluster.root, "data-B"),
      sourceHasPidFile: existsSync(join(cluster.data, "postmaster.pid")),
      controlDataClusterState: state, freeBytes: freeBytes(cluster.data),
      sourceBytes: allocatedBytes(cluster.data), sameFilesystem: true, targetEntries: [] as string[],
    };
    const plans = await Promise.all(Array.from({ length: 20 }, async () => planPgPreimageV1(input)));
    const serialised = new Set(plans.map(plan => JSON.stringify(plan)));
    assert.equal(serialised.size, 1, "20 concurrent plans for one source must be byte-identical");
    assert.equal(plans[0]!.status, "root_mkdir_then_clone_planned");
    // Now the refusal path, which is what a second caller actually hits once a
    // postmaster is up: every one of the 20 must refuse, none may proceed.
    const live = await startCluster("concurrent-live", 1);
    try {
      const liveControl = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", live.data], { encoding: "utf8" });
      const refusals = await Promise.all(Array.from({ length: 20 }, async () => planPgPreimageV1({
        ...input, sourceDataDirectory: live.data, targetDataDirectory: join(live.root, "pg", "data-B"),
        sourceHasPidFile: existsSync(join(live.data, "postmaster.pid")),
        controlDataClusterState: /Database cluster state:.*/u.exec(liveControl)?.[0] ?? "",
      })));
      assert.equal(refusals.every(plan => plan.status === "root_mkdir_then_clone_refused"), true,
        "a live source must be refused by every concurrent caller, not some of them");
      assert.equal(new Set(refusals.map(plan => plan.refusal?.reason)).size, 1,
        "all 20 must refuse for the SAME reason, so the operator is told one thing");
    } finally { await stopCluster(live); }
  } finally { await stopCluster(cluster); }
});

test("a clone interrupted halfway leaves a target the plan refuses on the retry", { skip: needsPg, timeout: 300_000 }, async () => {
  // "A stop halfway" for this item. `cp` is killed mid-copy, so the target holds
  // a partial tree. The retry must be REFUSED, not merged: the design's reason
  // for root-mkdir-then-clone is that a half-filled target is not a cluster, and
  // `cp -c` into a populated directory merges rather than replaces.
  const cluster = await startCluster("halfway", 2, true);
  try {
    const target = join(cluster.root, "data-B");
    mkdirSync(target, { mode: 0o700 });
    const copy = spawnSync("/bin/cp", ["-c", "-R", "-p", `${cluster.data}/.`, `${target}/`],
      { env: env(), timeout: 1_000, killSignal: "SIGKILL" as const });
    const partial = readdirSync(target);
    if (partial.length === 0) {
      // The copy finished inside 1 s on this volume, so there is no partial state
      // to assert against. Recorded rather than asserted, because asserting it
      // would encode this machine's copy speed.
      assert.ok(true, "the copy completed before the kill; the retry assertion below still runs");
    } else {
      const control = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", cluster.data], { encoding: "utf8" });
      const retry = planPgPreimageV1({
        sourceDataDirectory: cluster.data, targetDataDirectory: target,
        sourceHasPidFile: existsSync(join(cluster.data, "postmaster.pid")),
        controlDataClusterState: /Database cluster state:.*/u.exec(control)?.[0] ?? "",
        freeBytes: freeBytes(cluster.data), sourceBytes: allocatedBytes(cluster.data),
        sameFilesystem: true, targetEntries: partial,
      });
      assert.equal(retry.status, "root_mkdir_then_clone_refused");
      assert.equal(retry.refusal?.reason, "preimage_target_not_empty",
        "a half-filled target must be refused, because cp -c merges into it");
    }
    // And a CLEAN retry after the target is removed succeeds: the refusal is
    // about the state, not a one-way door.
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { mode: 0o700 });
    const control = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", cluster.data], { encoding: "utf8" });
    const retry = planPgPreimageV1({
      sourceDataDirectory: cluster.data, targetDataDirectory: target,
      sourceHasPidFile: existsSync(join(cluster.data, "postmaster.pid")),
      controlDataClusterState: /Database cluster state:.*/u.exec(control)?.[0] ?? "",
      freeBytes: freeBytes(cluster.data), sourceBytes: allocatedBytes(cluster.data),
      sameFilesystem: true, targetEntries: readdirSync(target),
    });
    assert.equal(retry.status, "root_mkdir_then_clone_planned", retry.refusal?.detail);
    void copy;
  } finally { await stopCluster(cluster); }
});

test("the clone measurement is stable across 20 back-to-back preimages on a loaded cluster", { skip: needsPg, timeout: 420_000 }, async () => {
  // Load, for the measurement the whole item turns on. Twenty real clones of a
  // ~40 MB loaded cluster: every one must be classified as a clone, and the
  // per-clone byte cost must stay under half the source. A single full copy
  // would show up as a cost near 1.0x, and a filesystem that started
  // fragmenting would show up as a rising sequence.
  const cluster = await startCluster("load", 3, true);
  try {
    const sourceBytes = allocatedBytes(cluster.data);
    assert.ok(sourceBytes > 15_000_000, `the cluster must be loaded for this to mean anything (${sourceBytes})`);
    const costs: number[] = [];
    const probe = await cloneProbe(cluster.root);
    // The probe is measured FIRST and asserted, so a lane that is really running
    // on a filesystem which cannot clone fails here with a clear reason rather
    // than 20 times over.
    //
    // FINDING 7, and this assertion is the port of the one the review called a
    // flake: the old text was `probe.consumedBytes < probe.sourceBytes *
    // PG_PROBE_CLONE_MAX_V1`, a threshold over a `df` delta, and the reviewer's
    // run of this very lane failed it with "the probe file must clone on this
    // filesystem; it charged 540672 of 1048576 bytes" — a REAL APFS clone at 52%
    // of the probe, called a failure by a threshold. The assertion is now on the
    // KERNEL's answer, which is the same bytes with no threshold in the way, and
    // the `df` delta is reported beside it rather than believed.
    assert.equal(probe.verdict.cloned, true,
      `clonefile(2) must clone on this filesystem; it reported ${probe.verdict.mechanism} ` +
      `(the df delta said ${probe.consumedBytes} of ${probe.sourceBytes} bytes, which is not the evidence)`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const target = join(cluster.root, `data-B-${attempt}`);
      mkdirSync(target, { mode: 0o700 });
      const before = freeBytes(cluster.data);
      // `cp -c` here is a BEST-EFFORT REQUEST and nothing more, and the plan no
      // longer names it (finding 7). What decides the attempt is the volume's own
      // answer from `clonefile(2)`, asked again for every iteration so a volume
      // that stopped cloning mid-run is caught.
      await run("/bin/cp", ["-c", "-R", "-p", `${cluster.data}/.`, `${target}/`], execOptions());
      const consumed = before - freeBytes(cluster.data);
      costs.push(consumed);
      const verdict = await kernelProbe(cluster.root);
      assert.equal(verdict.cloned, true,
        `clone ${attempt} was not classified as a clone: ${verdict.consequence}`);
      // The tree ratio is REPORTED and not asserted, on purpose: it is the weak
      // measurement, and asserting it is what flaked in the reviewer's run.
      assert.ok(Number.isFinite(consumed));
      rmSync(target, { recursive: true, force: true });
    }
    // The tree's free-space delta is RECORDED and deliberately NOT asserted on,
    // and that is the honest conclusion of twenty measurements. MEASURED, same
    // volume, same 60 MB loaded cluster, same `cp -c`:
    //
    //   deltas across 20 attempts ranged from -23,638,016 to +34,275,328 bytes
    //
    // A negative delta means the volume reported MORE free space after the copy
    // than before it, which is not a measurement of anything the copy did — it
    // is `df` rounding, APFS deferred allocation, and the sparse relation files
    // being counted differently in each direction. A signal that swings by 58 MB
    // around zero cannot be asserted on, and an earlier version of this test DID
    // assert on it, which is how this file learned that the tree ratio is the
    // weak measurement and the probe is the strong one.
    //
    // So the twenty attempts assert what they can: every one was classified as a
    // clone by the probe, every one produced a cluster, and the probe still says
    // "clone" afterwards. The spread is printed so a human can see it.
    process.stderr.write(`# clone deltas across 20 attempts: min ${Math.min(...costs)}, max ${Math.max(...costs)}, source ${sourceBytes}\n`);
    // And the probe still says "clone" after twenty of them, which is the
    // statement about the volume rather than about one copy. The df delta is
    // printed beside it so a person can see the two disagree, which is the point
    // finding 7's deletion of the threshold was making.
    const after = await cloneProbe(cluster.root);
    assert.equal(after.verdict.cloned, true,
      `after 20 clones the kernel still reports ${after.verdict.mechanism} ` +
      `(the df delta said ${after.consumedBytes} of ${after.sourceBytes} bytes)`);
    // And every clone produced a cluster pg_controldata can read, which is the
    // only proof that a clone is a cluster and not a directory of files.
    const target = join(cluster.root, "data-B-final");
    mkdirSync(target, { mode: 0o700 });
    await run("/bin/cp", ["-c", "-R", "-p", `${cluster.data}/.`, `${target}/`], execOptions());
    const control = execFileSync(join(PG_BIN!, "pg_controldata"), ["-D", target], { encoding: "utf8" });
    assert.match(control, /Database cluster state:\s*shut down/u);
    assert.equal(readFileSync(join(target, "PG_VERSION"), "utf8").trim(), "17");
  } finally { await stopCluster(cluster); }
});

test("the runtime layout survives 20 concurrent readers and never disagrees with itself", { timeout: 120_000 }, async () => {
  // The layout is a pure function, so "concurrent callers" means the same
  // question asked 20 ways at once from 20 modules. A plan that read a clock, a
  // counter or process state would drift here; one that is pure cannot. The
  // 500 iterations are the load part: it is a hot function in the installer's
  // retry path, and it must stay allocation-stable enough to be cheap.
  const results = await Promise.all(Array.from({ length: 20 }, async () => {
    for (let index = 0; index < 25; index += 1) {
      const layout = planPgClusterLayoutV1({
        pgRoot: "/Library/Application Support/Control Room/pg", dataId: "data-B",
        runtimeDirectory: "/Library/Application Support/Control Room/runtime/pg-current",
        accounts: { database: OS_ACCOUNT, migrator: "control_room_migrator", deployer: "control_room_deployer" },
      });
      assert.equal(layout.status, "socket_only_cluster_layout_built");
      assert.equal(verifyPgRuntimeEnvironmentV1({
        environment: layout.environment,
        runtimeDirectory: "/Library/Application Support/Control Room/runtime/pg-current",
      }).pinned, true, "the layout must satisfy its own verifier; they are two halves of one contract");
    }
    return true;
  }));
  assert.equal(results.every(Boolean), true);
});

test("a hostile archive cannot smuggle anything into the runtime through 200 crafted entry names", { timeout: 120_000 }, async () => {
  // Every name here is either refused or classified as excluded. One that was
  // not would be a file in a root-owned 0555 tree that this item never chose.
  const names = [
    "", "/", "/etc/sudoers", "../etc/sudoers", "pgsql/../../etc/sudoers", "pgsql/lib/../../../tmp/x",
    "pgsql/lib//libssl.3.dylib", "pgsql/bin/../lib/libssl.3.dylib",
    `pgsql/lib/${"x".repeat(300)}.dylib`, "pgsql/lib/\u0000evil.dylib",
    "pgsql/lib/libssl.3.dylib\u0000.png", "pgsql/pgAdmin 4.app/lib/libpq.5.dylib",
    "pgsql/doc/libevil.dylib", "pgsql/share/libevil.dylib", "pgsql/etc/libevil.dylib",
    "pgsql/share/man/libevil.dylib", "pgsql/share/postgresql.conf.sample",
    // An extension module, which finding 6 makes ALLOWED: `lib/postgresql/*.dylib`
    // is the vendored runtime's pkglibdir, resolved relative to the binary. The
    // previous version of this list carried `pgcrypto.dylib` as a name that had
    // to be refused, which stopped being true when the allow-list was corrected.
    "pgsql/lib/postgresql/pgcrypto.dylib", "pgsql/lib/postgresql/plpgsql.dylib",
    // …but only `.dylib` at that depth, and only files the catalog needs. These
    // are the hostile versions of the entry the list above now admits.
    "pgsql/lib/postgresql/pgcrypto.so", "pgsql/lib/postgresql/README",
    "pgsql/bin/pgbench", "pgsql/bin/pg_isready",
    "pgsql/bin/postgres", "pgsql/bin/psql", "pgsql/lib/libssl.3.dylib", "pgsql/lib/libz.dylib",
    "./pgsql/lib/libz.dylib", "pgsql//lib/libz.dylib", "pgsql/LIB/libz.dylib", "pgsql/lib/LIBz.dylib",
  ];
  let refused = 0, excluded = 0, accepted = 0;
  const acceptedNames: string[] = [];
  const refusingNames: string[] = [];
  for (const name of names) {
    let classified: { kind: string; destination?: string };
    // A name that makes the classifier THROW is a refusal, and refusing is the
    // correct outcome for a hostile name — so it is counted, not treated as a
    // crash. The first version of this loop let the throw escape and failed the
    // test on `pgsql//lib/libz.dylib`, which is a name the classifier is RIGHT
    // to refuse.
    try { classified = classifyPgRuntimeArchiveEntryV1(name); }
    catch { refused += 1; refusingNames.push(name); continue; }
    if (classified.kind === "excluded") { excluded += 1; continue; }
    accepted += 1;
    acceptedNames.push(`${name} -> ${classified.destination}`);
  }
  // And every refusal is for a reason that makes it a refusal, not an accident.
  //
  // MEASURED, and two reasons were added when finding 5 landed. The root segment
  // is now REQUIRED to be `pgsql`, and a name that fails it is refused — which
  // covers three shapes this corpus carries and the old list could not explain:
  //
  //   ""                        no root at all
  //   "/"                       a single separator, so no root
  //   "./pgsql/lib/libz.dylib"  the root is `.` — the escape guard does not fire
  //                             on it, because a leading `.` segment is a legal
  //                             relative name, and the root check does
  //   "pgsql//lib/libz.dylib"   the root is `pgsql` but the second segment is
  //                             empty, which the segment check refuses
  //
  // Each of those was ALREADY refused before finding 5, by the empty-segment and
  // the allow-list respectively. What changed is the reason, and a corpus that
  // asserted only the old reasons was asserting an implementation detail that the
  // fix was entitled to change.
  const harmlessLooking = (name: string): boolean => name === "" || name === "/"
    || name.startsWith("/") || name.includes("..") || name.includes("//")
    || name.includes("\u0000") || name.length > 256
    // A name whose FIRST segment is not `pgsql` is refused by the root check
    // unless something earlier already refused it. `./pgsql/…` is that case.
    || name.startsWith("./")
    // A leading `.` with nothing after it, and a bare `..`, are the same shape.
    || name === "." || name === "..";
  assert.ok(refusingNames.every(harmlessLooking),
    `these names were refused but look harmless: ${refusingNames.filter(name => !harmlessLooking(name)).join(", ")}`);
  // Only the real programs, the real libraries and the real extension modules may
  // be accepted, and each only at its documented destination. The extension
  // pattern is the reason `lib/postgresql/*.dylib` appears here at all, and its
  // exclusions appear above so that this assertion is not trivially satisfied by
  // a classifier that accepts everything under `lib/`.
  const allowed = /^pgsql\/(bin\/(postgres|psql)|lib\/lib(ssl\.3|z)\.dylib|lib\/postgresql\/[\w.+-]+\.dylib)\b/u;
  assert.deepEqual(acceptedNames.filter(entry => !allowed.test(entry)), [],
    `only the allow-listed files may be copied; these were not: ${acceptedNames.join(", ")}`);
  // And the count is asserted, so a classifier that accepted NOTHING would also
  // satisfy the filter above. A test that passes for both reasons is not a test.
  assert.ok(accepted >= 5, `expected the real programs, libraries and extension modules to be accepted, got ${accepted}`);
  // The non-`.dylib` names at pkglibdir depth must be among the excluded.
  for (const refused of ["pgsql/lib/postgresql/pgcrypto.so", "pgsql/lib/postgresql/README",
    "pgsql/share/man/libevil.dylib", "pgsql/share/postgresql.conf.sample", "pgsql/share/libevil.dylib"])
    assert.ok(!acceptedNames.some(entry => entry.startsWith(`${refused} ->`)), `${refused} must not be copied`);
  assert.equal(refused > 0 && excluded > 0 && accepted > 0, true,
    `the corpus must exercise all three outcomes, got refused=${refused} excluded=${excluded} accepted=${accepted}`);
  // The PLAN over a corpus that contains a hostile name must REFUSE, not
  // partially succeed: the build reads a real archive's central directory, and
  // an archive with a traversal in it is refused whole rather than having its
  // good entries copied first. This is the difference between a refusal and a
  // throw, and it is the one that matters at install time.
  assert.throws(() => planPgRuntimeCopyV1(names), /pg_runtime_copy_refused/u,
    "a corpus containing a traversal must be refused whole, not copied up to the bad entry");
  // The good subset still plans, and adds nothing beyond the allow-list. The
  // pattern names the extension modules too: `lib/postgresql/*.dylib` is the
  // vendored runtime's pkglibdir, which finding 6 established resolves relative
  // to the binary. MEASURED: this assertion predated that finding and read
  // `lib/postgresql/pgcrypto.dylib must not be in the runtime` — a message that
  // was true then and false now, and a test that would have kept asserting it.
  const good = names.filter(name => !refusingNames.includes(name));
  for (const file of planPgRuntimeCopyV1(good).files)
    assert.match(file, /^(bin\/(postgres|psql)|lib\/lib(ssl\.3|z)\.dylib|lib\/postgresql\/[\w.+-]+\.dylib)$/u,
      `${file} must not be in the runtime`);
  // Duplicates collapse: the same entry twice is one file.
  const repeated = planPgRuntimeCopyV1(["pgsql/bin/postgres", "pgsql/bin/postgres", "pgsql/lib/libz.dylib"]);
  assert.deepEqual([...repeated.files], ["bin/postgres", "lib/libz.dylib"]);
});

test("the environment verifier names every leak, not just the first, so one run tells the whole story", { timeout: 60_000 }, async () => {
  // A verifier that reports one reason per run forces an operator into a loop
  // of edit-restart cycles on a configuration with four wrong values. This one
  // is called "measurements, not a first failure" and it has to be.
  const runtimeDirectory = "/Library/Application Support/Control Room/runtime/pg-current";
  const result = verifyPgRuntimeEnvironmentV1({
    environment: {
      LC_ALL: "en_US.UTF-8", LANG: "C", TZ: "UTC",
      PGSYSCONFDIR: `${runtimeDirectory}/etc`,
      OPENSSL_CONF: "/etc/openssl.cnf", OPENSSL_MODULES: `${runtimeDirectory}/lib/ossl-modules`,
      KRB5_CONFIG: "/opt/homebrew/etc/krb5.conf", KRB5_KDC_PROFILE: "/dev/null",
      PATH: "/opt/homebrew/bin", HOME: "/Users/someone", DEVELOPER_DIR: "/Users/someone/Xcode",
    },
    runtimeDirectory,
    gucs: { ssl: "on", listen_addresses: "127.0.0.1" },
    peerMapText: "cr root gssapi/control_room_deployer",
  });
  assert.equal(result.pinned, false);
  const text = result.reasons.join("\n");
  for (const expected of ["LC_ALL", "OPENSSL_CONF", "KRB5_CONFIG", "PATH", "HOME", "DEVELOPER_DIR",
    "ssl", "listen_addresses", "gss"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `the verifier must report ${expected}; it reported: ${text}`);
  }
  // Every reason names the variable or GUC it is about, so a report is
  // actionable without a second run. A "PATH is present" is a finding an
  // operator has to look up; a "PATH is present, expected it to be absent" is
  // one they can act on. MEASURED: the first version of the verifier emitted
  // the shorter form, and this assertion is why it does not.
  for (const reason of result.reasons) {
    assert.match(reason, /[A-Za-z_]/u, `a reason naming nothing is not actionable: ${reason}`);
    assert.match(reason, /present|expected|found|must contain/u,
      `a reason must say what it found and what it wanted: ${reason}`);
  }
  // The leak reasons must name the value that was actually there, because a
  // leaked DEVELOPER_DIR is only diagnosable with its value.
  assert.match(text, /DEVELOPER_DIR[^\n]*\/Users\/someone\/Xcode/u,
    `a leaked variable must be reported with its value, not just its name: ${text}`);
});
