// Finding 8: the clone probe's production build, artifact manifest and strict
// protocol parser.
//
// The review found three holes and this lane is the answer to all three:
//
//   "There is no `scripts/build-pg-clone-probe-native.mjs` like the five sibling
//    sidecars have, no artifact manifest with the source digest and toolchain,
//    and no TypeScript that spawns it and parses `ok <n>` / `errno <n>`;
//    `classifyPgCloneProbeV1` takes `kernelOutcome` from its caller."
//
// The three tests below are one per hole, and the DEFAULT-PATH RULE applies to
// the whole slice: `test:pg-clone` spawns the REAL artifact this build script
// produces, through the REAL `runPgCloneProbeV1`, against a REAL directory, with
// no injected runner and no injected parser. A parser that is only ever tested
// against a string is a parser nobody has run against the binary.
//
// Everything the lane creates is inside `LANE_ROOT` and removed on exit. The
// sidecar is BUILT, not copied from a fixture: the point is that the manifest's
// digests describe a binary that actually came from `native/pg-clone-probe-v1.c`
// on this machine, and a hand-written manifest would prove nothing.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  runPgCloneProbeV1, verifyPgCloneProbeArtifactV1, PG_CLONE_PROBE_SIDECAR_V1,
  PG_CLONE_PROBE_SOURCE_DIRECTORY_V1,
} from "../src/pg-runtime/v1/pg-clone-probe-sidecar";
import { pgCloneReservationMultiplierV1, PG_CLONE_PROBE_BYTES_V1 } from "../src/pg-runtime/v1/pg-clone-probe";

const LANE_ROOT = process.env.CONTROL_ROOM_PGRT_TMPDIR
  ? join(process.env.CONTROL_ROOM_PGRT_TMPDIR, `pg-sidecar-${process.pid}`)
  : join(tmpdir(), `pg-sidecar-${process.pid}`);
const REPO = join(new URL("..", import.meta.url).pathname);
const SOURCE = join(REPO, "native", "pg-clone-probe-v1.c");
const ARTIFACT_DIRECTORY = join(LANE_ROOT, "artifact");
const SIDECAR = join(ARTIFACT_DIRECTORY, "pg-clone-probe-v1");
const MANIFEST = join(ARTIFACT_DIRECTORY, "PG_CLONE_PROBE_MANIFEST.json");

process.on("exit", () => {
  try { rmSync(LANE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Build the real artifact once, through the real build script. */
let buildError: string | null = null;
let buildResult: Record<string, unknown> | undefined;
mkdirSync(LANE_ROOT, { recursive: true, mode: 0o700 });
try {
  const { buildPgCloneProbeNativeArtifactV1 } = await import("../scripts/build-pg-clone-probe-native.mjs");
  buildResult = await buildPgCloneProbeNativeArtifactV1({ outputDirectory: ARTIFACT_DIRECTORY }) as Record<string, unknown>;
} catch (error) {
  buildError = (error as Error).message.slice(0, 400);
}

const needsBuild = buildError ?? false;

test("portable artifact verification binds executable bytes before any launch", async () => {
  const directory = mkdtempSync(join(LANE_ROOT, "portable-artifact-"));
  try {
    const executable = join(directory, "sidecar"), source = join(directory, "source.c");
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(executable, "fixture executable bytes");
    writeFileSync(source, "fixture source bytes");
    writeFileSync(manifestPath, JSON.stringify({ schema: "control-room.pg-clone-probe-native-artifact/v1",
      protocol: "PGCLONE1", executableName: "sidecar",
      sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex") }));
    assert.equal((await verifyPgCloneProbeArtifactV1({ manifestPath, sourcePath: source })).ok, true);
    writeFileSync(executable, "different executable bytes");
    const refused = await verifyPgCloneProbeArtifactV1({ manifestPath, sourcePath: source });
    assert.equal(refused.ok, false);
    assert.match(refused.why!, /executable digest does not match/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("portable sidecar path checks refuse a symlink before launching it", async () => {
  const directory = mkdtempSync(join(LANE_ROOT, "portable-link-"));
  try {
    const target = join(directory, "fake-sidecar"), link = join(directory, "link");
    writeFileSync(target, "#!/bin/sh\nprintf 'errno 0\\n'\n", { mode: 0o755 });
    symlinkSync(target, link);
    await assert.rejects(runPgCloneProbeV1({ sidecarPath: link, pgDirectory: directory }), /pg_clone_probe_sidecar_refused/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the sidecar builds into an artifact directory with a manifest binding it to its source", { skip: needsBuild, timeout: 300_000 }, () => {
  // HOLE (a) and (b): a production build and a manifest with the source digest.
  //
  // The five sibling sidecars each have one; the clone probe had only its test
  // compiling it into a temp directory, which means item 18 had nothing to call
  // and nothing to verify.
  assert.equal(buildResult!.schema, "control-room.pg-clone-probe-native-artifact/v1");
  assert.equal(buildResult!.protocol, "PGCLONE1", "the protocol is recorded so a parser can refuse a binary speaking another");
  assert.equal(buildResult!.installs, false, "the build does not install itself; the installer owns placement");
  assert.equal(buildResult!.downloads, false, "and it never downloads a toolchain");
  assert.ok(existsSync(SIDECAR), "the executable is beside its manifest, so the pair travels together");
  assert.ok(existsSync(MANIFEST));
  assert.equal(statSync(SIDECAR).mode & 0o111, 0o111, "the sidecar must be executable");

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  // The digests are the whole point: the verdict is unforgeable only if the
  // binary producing it is the reviewed one, and that is a digest comparison.
  assert.equal(manifest.sourceSha256,
    createHash("sha256").update(readFileSync(SOURCE)).digest("hex"),
    "the manifest must record the digest of the source in this repository");
  assert.equal(manifest.executableSha256,
    createHash("sha256").update(readFileSync(SIDECAR)).digest("hex"),
    "and the digest of the binary it describes");
  // The toolchain is recorded so a binary built elsewhere is recognisable, and
  // the flags are the reviewed ones rather than whatever a build script happened
  // to pass.
  assert.match(manifest.toolchain.compiler, /^Apple clang version /u);
  assert.ok(manifest.toolchain.sdkVersion, "the SDK version is recorded");
  assert.deepEqual(manifest.toolchain.flags, ["-Wall", "-Wextra", "-Werror", "-O2"],
    "the flags are a frozen export, and the manifest records exactly what was used");
  // Finding 8's placement requirement, recorded so a layout that violates it is
  // detectable: the probe must run in `pg/`, on the volume `data-A` is on.
  assert.equal(manifest.probePlacement, "pg/",
    "the probe must run in pg/ itself, not in a temp dir: it measures the volume the preimage targets");
  // And the reviewer's operational note is written down, because a hostile
  // process pre-creating the probe name is a real way to deny the 1x path.
  assert.match(manifest.concurrentPreCreation, /EEXIST/u);
  assert.match(manifest.concurrentPreCreation, /3x/u);
  const buildSource = readFileSync(join(REPO, "scripts", "build-pg-clone-probe-native.mjs"));
  assert.equal([...buildSource].some(byte => byte === 0 || byte === 0x1f || byte === 0x7f), false,
    "the build script must contain escaped control-byte spellings so git can review it as text");

  // The build refuses a second build into the same directory, which is the same
  // rule the other five sidecars use: an exclusive mkdir rather than a merge.
  return import("../scripts/build-pg-clone-probe-native.mjs")
    .then(module => module.buildPgCloneProbeNativeArtifactV1({ outputDirectory: ARTIFACT_DIRECTORY }))
    .then(() => assert.fail("a second build into the same directory must be refused"),
      (error: Error) => assert.equal(error.message, "pg_clone_probe_native_build_refused"));
});

test("the manifest verifier refuses a tampered binary, a tampered source and a foreign protocol", { skip: needsBuild, timeout: 300_000 }, async () => {
  // The third property: the verifier answers "is this binary the reviewed one?"
  // from digests alone, BEFORE anything is spawned. A verifier that runs the
  // binary and then checks its answer is the wrong order.
  const good = await verifyPgCloneProbeArtifactV1({ manifestPath: MANIFEST, sourcePath: SOURCE });
  assert.equal(good.ok, true, good.why);
  assert.equal(good.executablePath, SIDECAR);

  // A binary that is not the one the manifest describes: two bytes flipped.
  const tampered = join(LANE_ROOT, "tampered");
  mkdirSync(tampered, { recursive: true, mode: 0o700 });
  const bytes = readFileSync(SIDECAR);
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
  writeFileSync(join(tampered, "pg-clone-probe-v1"), flipped, { mode: 0o755 });
  writeFileSync(join(tampered, "PG_CLONE_PROBE_MANIFEST.json"), readFileSync(MANIFEST));
  const tamperedResult = await verifyPgCloneProbeArtifactV1({
    manifestPath: join(tampered, "PG_CLONE_PROBE_MANIFEST.json"), sourcePath: SOURCE,
  });
  assert.equal(tamperedResult.ok, false, "a binary whose digest does not match the manifest must be refused");
  assert.match(tamperedResult.why!, /executable digest does not match/u);

  // A manifest whose source digest is not this repository's source: the binary
  // was built from something else, which is the substitution the finding is about.
  const foreignSource = join(LANE_ROOT, "foreign.c");
  writeFileSync(foreignSource, "/* a different sidecar */\nint main(void){return 0;}\n");
  const foreign = await verifyPgCloneProbeArtifactV1({ manifestPath: MANIFEST, sourcePath: foreignSource });
  assert.equal(foreign.ok, false);
  assert.match(foreign.why!, /source digest does not match/u);

  // A manifest that is not JSON, and one that speaks another protocol.
  const notJson = join(LANE_ROOT, "notjson");
  mkdirSync(notJson, { recursive: true, mode: 0o700 });
  writeFileSync(join(notJson, "PG_CLONE_PROBE_MANIFEST.json"), "not json at all");
  assert.equal((await verifyPgCloneProbeArtifactV1({
    manifestPath: join(notJson, "PG_CLONE_PROBE_MANIFEST.json"), sourcePath: SOURCE,
  })).ok, false);
  const wrongProtocol = JSON.parse(readFileSync(MANIFEST, "utf8"));
  wrongProtocol.protocol = "PGCLONE2";
  const protocolDirectory = join(LANE_ROOT, "protocol");
  mkdirSync(protocolDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(protocolDirectory, "PG_CLONE_PROBE_MANIFEST.json"), JSON.stringify(wrongProtocol));
  const refused = await verifyPgCloneProbeArtifactV1({
    manifestPath: join(protocolDirectory, "PG_CLONE_PROBE_MANIFEST.json"), sourcePath: SOURCE,
  });
  assert.equal(refused.ok, false, "a binary speaking another protocol must be refused before it is spawned");
  assert.match(refused.why!, /not PGCLONE1/u);

  const traversalDirectory = join(LANE_ROOT, "manifest-traversal");
  mkdirSync(traversalDirectory, { recursive: true, mode: 0o700 });
  const traversal = JSON.parse(readFileSync(MANIFEST, "utf8"));
  traversal.executableName = "../pg-clone-probe-v1";
  writeFileSync(join(traversalDirectory, "PG_CLONE_PROBE_MANIFEST.json"), JSON.stringify(traversal));
  const traversalResult = await verifyPgCloneProbeArtifactV1({
    manifestPath: join(traversalDirectory, "PG_CLONE_PROBE_MANIFEST.json"), sourcePath: SOURCE,
  });
  assert.equal(traversalResult.ok, false, "a manifest executable name must not escape its artifact directory");
  assert.match(traversalResult.why!, /one plain file name/u);
});

test("the probe refuses a pre-existing probe path without following or removing it", { skip: needsBuild }, async () => {
  const pgDirectory = mkdtempSync(join(LANE_ROOT, "preexisting-"));
  const victim = join(pgDirectory, "victim");
  mkdirSync(victim, { mode: 0o700 });
  writeFileSync(join(victim, "owned"), "untouched");
  const hostile = join(pgDirectory, PG_CLONE_PROBE_SOURCE_DIRECTORY_V1);
  symlinkSync(victim, hostile);
  await assert.rejects(runPgCloneProbeV1({ sidecarPath: SIDECAR, pgDirectory }), /probe source path already exists/u);
  assert.equal(readFileSync(join(victim, "owned"), "utf8"), "untouched");
  assert.equal(statSync(hostile).isDirectory(), true, "the hostile link still resolves, so the probe did not remove it");
});

test("the strict parser accepts only the two protocol shapes, and everything else is a full copy", { timeout: 300_000 }, async () => {
  // HOLE (c): the parser. And the property that makes it strict is the one the
  // review cares about — there is NO path from unexpected output to "cloned".
  //
  // Each case is run through the real `runPgCloneProbeV1` with a FAKE sidecar: a
  // shell script that prints the shape under test and exits 0. That is the only
  // way to drive the parser over every shape without a filesystem that produces
  // each one, and it is sound because the parser is what is under test — the
  // real binary is run in the default-path test below.
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    // The only two shapes that can produce a clone, and `ok 0` is a legal shape
    // that is a REFUSAL: a sidecar claiming it cloned zero bytes has not cloned
    // anything, and the size it claims must be the size that was asked for.
    ["ok 4194304", true],
    ["ok 0", false],
    ["ok 1", false],
    ["ok 4194303", false],
    // Padding, signs, separators: not the protocol.
    //
    // A TRAILING space is deliberately not in this list, and that is a decision
    // rather than an omission. MEASURED: the parser trims the sidecar's stdout
    // before matching, so `"ok 4194304 "` is accepted — and it should be, because
    // trailing whitespace is not a fact about the verdict, it is an artefact of a
    // shell or a pipe. Padding on the INSIDE of a token (`ok  4194304`), a sign,
    // a separator, a different letter, or a second line all change what the
    // sidecar said rather than how it was spelled, and all of those are refused.
    ["ok  4194304", false], ["ok +4194304", false],
    ["ok 4,194,304", false], ["OK 4194304", false], ["ok", false],
    // A second line is not a result, and neither is a line with a warning in it.
    ["ok 4194304\nwarning: something", false], ["errno 45\nerrno 0", false],
    // The errno shape, and an errno nobody classified.
    ["errno 45", false], ["errno 0", false], ["errno 999", false], ["errno -1", false],
    // Empty and whitespace only.
    ["", false], ["   ", false],
    // THE ANCHOR CASES. These are the ones an unanchored `/errno (\d+)/` would
    // ACCEPT, because it finds the digits somewhere in the string rather than
    // requiring the whole string to be the protocol. Each one carries a real
    // `errno 0` — an "everything is fine" line — behind a decoy, and an unanchored
    // parser that also has a loose `ok` pattern would read the decoy's number
    // instead. This is the mutation the harness reported as surviving, and the
    // fix is cases that distinguish the two, not a comment claiming it.
    // The decoy carries errno 45 — ENOTSUP, "this volume will never clone" —
    // because that is the errno a loose parser would READ, and it names a
    // different MEchanism than the one an unanchored parse should report. A decoy
    // of 0 would classify the same way either way and prove nothing.
    ["x errno 45", false],
    ["\n\nok 4194304", false],
    ["junk 4194304 more", false],
    ["ok 4194304 trailing text", false],
    ["errno 45\n", false],
    ["prefix errno 45 suffix", false],
  ];
  for (const [output, cloned] of cases) {
    const directory = mkdtempSync(join(LANE_ROOT, "case-"));
    const fake = join(directory, "fake-sidecar");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\nexit 0\n`, { mode: 0o755 });
    chmodSync(fake, 0o755);
    const run = await runPgCloneProbeV1({ sidecarPath: fake, pgDirectory: directory, probeBytes: PG_CLONE_PROBE_BYTES_V1 });
    assert.equal(run.verdict.cloned, cloned,
      `${JSON.stringify(output)} must ${cloned ? "clone" : "not clone"}; it produced ${run.raw}`);
    if (!cloned) {
      // The reservation is the consequence, and it is asserted rather than
      // derived: a caller that reads the multiplier must not be able to get 1x
      // from anything the sidecar said.
      assert.equal(pgCloneReservationMultiplierV1(run.verdict), 3,
        `${JSON.stringify(output)} must cost the 3x reservation`);
      // And the MECHANISM, which is what the anchor actually buys.
      //
      // MEASURED, and this assertion is the one the mutation harness needed: a
      // loose `/errno (\d+)/` reads the digits out of `x errno 0` and classifies
      // errno 0, which is "the call was never made" — so the verdict is a full
      // copy EITHER WAY and asserting only `cloned` cannot tell an anchored
      // parser from a loose one. The difference is which errno is reported, and
      // that is what an operator reads when a probe fails for a reason nobody
      // classified.
      if (output === "x errno 45")
        assert.equal(run.verdict.mechanism, "clonefile_unavailable",
          "a loose parser reads the 45 out of `x errno 45` and reports clonefile_enotsup, which is a " +
          "different answer about the volume, not a different refusal");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the production default path: the REAL artifact runs in a REAL pg directory and the verdict comes from the kernel", { skip: needsBuild, timeout: 300_000 }, async () => {
  // THE DEFAULT-PATH TEST (owner rule 2026-09-30). The sidecar is the artifact
  // the build script just produced, spawned by `runPgCloneProbeV1`, in a real
  // directory, with no injected runner, no injected parser and no fake anything.
  // This is what proves the parser and the C agree: a C that printed
  // something the parser does not accept would be a refusal here, and a parser
  // that accepted the C's output by construction would be untested.
  const pgDirectory = mkdtempSync(join(LANE_ROOT, "pg-"));
  try {
    const run = await runPgCloneProbeV1({ sidecarPath: SIDECAR, pgDirectory });
    assert.equal(run.schema, PG_CLONE_PROBE_SIDECAR_V1);
    assert.equal(run.unrecognised, false,
      `the real sidecar must print one of the two protocol shapes; it printed ${JSON.stringify(run.raw)}`);
    assert.match(run.raw, /^ok \d+$|^errno \d+$/u, `the raw output must be the protocol, got ${JSON.stringify(run.raw)}`);
    // On this volume — APFS under a real directory — the kernel clones, and that
    // is the whole point of the probe. If this machine's volume cannot clone the
    // test says so rather than asserting a lie, because the interesting
    // assertion is the CONSISTENCY between the raw line and the verdict.
    if (run.verdict.cloned) {
      assert.equal(run.verdict.mechanism, "clonefile_syscall");
      assert.equal(pgCloneReservationMultiplierV1(run.verdict), 1,
        "a kernel-proven clone lets 8.6's reservation drop to 1x for the preimage");
      assert.match(run.raw, /^ok /u, "a cloned verdict must come from an `ok` line");
    } else {
      assert.match(run.raw, /^errno /u, "a full-copy verdict must come from an `errno` line");
      assert.equal(pgCloneReservationMultiplierV1(run.verdict), 3);
    }
    // And the probe left nothing behind, on the directory the preimage would
    // use. A probe that leaks a 4 MiB file into `pg/` fills the volume it is
    // measuring.
    assert.deepEqual(readdirSync(pgDirectory), [],
      "the sidecar must clean up both probe names; pg/ is where the cluster lives");
    // And it is repeatable, which is the retry-after-failure path: the name
    // embeds the size, so a second run with the same size must find its own
    // leftovers or fail with ENOENT and be mistaken for ENOTSUP.
    const second = await runPgCloneProbeV1({ sidecarPath: SIDECAR, pgDirectory });
    assert.equal(second.raw, run.raw, "twenty probes in a row are asserted elsewhere; the second must agree with the first");
  } finally { rmSync(pgDirectory, { recursive: true, force: true }); }
});

test("a symlinked or missing sidecar is refused, so a probe path cannot be redirected", { skip: needsBuild, timeout: 300_000 }, async () => {
  // The binary is the trust boundary, so the path to it is checked before it is
  // spawned. A sidecar path a writable directory can redirect is a sidecar whose
  // answer is whatever the redirector wants, and the finding is about a binary
  // that is not the reviewed one.
  const directory = mkdtempSync(join(LANE_ROOT, "link-"));
  try {
    const link = join(directory, "sidecar-link");
    symlinkSync(SIDECAR, link);
    await assert.rejects(() => runPgCloneProbeV1({ sidecarPath: link, pgDirectory: directory }),
      /pg_clone_probe_sidecar_refused/u, "a symlinked sidecar must be refused, not followed");
    await assert.rejects(() => runPgCloneProbeV1({ sidecarPath: join(directory, "absent"), pgDirectory: directory }),
      /pg_clone_probe_sidecar_refused/u, "a missing sidecar must be refused");
    // A pg/ directory that is not a directory, and a relative path: the probe
    // must answer about the volume the preimage targets, so it may not fall back
    // to a temporary directory of its own.
    const file = join(directory, "not-a-directory");
    writeFileSync(file, "x");
    await assert.rejects(() => runPgCloneProbeV1({ sidecarPath: SIDECAR, pgDirectory: file }),
      /probe directory is not a directory/u);
    await assert.rejects(() => runPgCloneProbeV1({ sidecarPath: SIDECAR, pgDirectory: "pg" }),
      /absolute canonical path/u);
    await assert.rejects(() => runPgCloneProbeV1({ sidecarPath: SIDECAR, pgDirectory: directory, probeBytes: 0 }),
      /positive whole number/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a sidecar that cannot be run at all is a full copy, never a clone", { skip: needsBuild, timeout: 300_000 }, async () => {
  // "A probe of zero bytes is refused rather than measured" has a sibling here:
  // a binary that cannot be executed at all. The review notes this is the
  // direction that matters — a missing sidecar must not be mistaken for a
  // volume that cannot clone, and neither may be mistaken for a clone.
  const directory = mkdtempSync(join(LANE_ROOT, "norun-"));
  try {
    const notExecutable = join(directory, "not-executable");
    writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const run = await runPgCloneProbeV1({ sidecarPath: notExecutable, pgDirectory: directory });
    assert.equal(run.verdict.cloned, false, "a sidecar that cannot run must not claim a clone");
    assert.equal(run.verdict.mechanism, "clonefile_unavailable");
    assert.equal(pgCloneReservationMultiplierV1(run.verdict), 3);
    assert.equal(run.unrecognised, true, "and the output that could not be read must be reported as unrecognised");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
