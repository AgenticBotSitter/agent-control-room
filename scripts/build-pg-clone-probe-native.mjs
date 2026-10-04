#!/usr/bin/env node
/** The clone probe sidecar's release build, with an artifact manifest.
 *
 * FINDING 8. The sidecar was compiled by its own test into a temp directory, so
 * three things the review names were all missing at once:
 *
 *   (a) a production build — five sibling sidecars have one and this had none, so
 *       an implementer wiring item 18 had nothing to call;
 *   (b) an artifact manifest recording the SOURCE DIGEST and the TOOLCHAIN, so a
 *       later verifier can tell this binary is the one this source produced. The
 *       verdict the probe returns is unforgeable only if the binary returning it
 *       is the one that was reviewed; a sidecar rebuilt from an edited source and
 *       dropped in its place is not that binary, and nothing downstream can tell;
 *   (c) a strict PARSER in TypeScript, so the protocol is enforced in one place
 *       rather than in a test's regex. `pg-clone-probe-sidecar.ts` owns that.
 *
 * This script is an explicit release tool, never imported by the runtime, and it
 * uses the installed macOS toolchain only: no download, no install, no network.
 *
 * It does NOT install the artifact and it does NOT decide where it lives. That is
 * the installer's job, and the review is explicit that the placement, the
 * root-ownership check and the T1 check on `updater/<version>/` belong to the
 * wiring slice. What this gives that slice is a binary with a manifest, and a
 * manifest a verifier can bind.
 *
 * Usage: node scripts/build-pg-clone-probe-native.mjs --output-directory <dir>
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";

const run = promisify(execFile);
const sourcePath = fileURLToPath(new URL("../native/pg-clone-probe-v1.c", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = () => { throw new Error("pg_clone_probe_native_build_refused"); };

/**
 * The flags the sidecar is compiled with, and why they are here rather than in
 * the script.
 *
 * They are the same shape as `PROTECTED_DIRECTORY_NATIVE_CFLAGS_V1` in
 * `src/installer/v1/macos-protected-directory-native-sidecar.mjs`, and they are
 * a frozen export rather than a literal so a reviewer can diff this sidecar's
 * flags against a sibling's without reading two files, and so the manifest can
 * record exactly what was used.
 *
 * `-Wall -Wextra -Werror` because the C in this item has no warnings today and a
 * warning that is not an error is a warning the next compiler turns into a
 * build failure on someone else's machine. `-O2` because the probe runs on the
 * upgrade path. No `-fvisibility`, no LTO, no `-march`: the binary must be
 * loadable on any Mac the installer supports, and the probe's whole value is
 * that it is a known, boring program.
 */
export const PG_CLONE_PROBE_CFLAGS_V1 = Object.freeze([
  "-Wall", "-Wextra", "-Werror", "-O2",
]);

/**
 * Build the sidecar and write a manifest beside it.
 *
 * The manifest is the part finding 8 is actually about. It records:
 *
 *   - `sourceSha256`, so a verifier can confirm the binary came from this source;
 *   - `toolchain`, so a binary built by a different compiler is recognisable;
 *   - `executableSha256`, so the binary itself is pinned rather than its name;
 *   - `protocol`, so a parser written against one protocol refuses a binary
 *     speaking another;
 *   - `probePlacement`, the directory the probe MUST run in, which the review
 *     names: "the probe running in `pg/` itself, on the same volume as `data-A`,
 *     not in a temp dir". It is recorded rather than enforced here because the
 *     installer owns the layout, but a layout that violates it is a layout a
 *     verifier can now catch by reading this file.
 */
export async function buildPgCloneProbeNativeArtifactV1({ outputDirectory }) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)
    || typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)
    || resolve(outputDirectory) !== outputDirectory || outputDirectory === "/"
    || /[\x00-\x1f\x7f]/u.test(outputDirectory)) return refused();
  // The output parent must exist and be canonical, and the output itself must
  // NOT exist: an exclusive mkdir refuses a prior artifact rather than mixing
  // two builds in one directory, which is the same rule the other five sidecars
  // use.
  if (await realpath(dirname(outputDirectory)).catch(() => null) !== dirname(outputDirectory)) return refused();
  // MEASURED: the first version left this to the `mkdir` further down, so a
  // second build into the same directory failed with EEXIST from `mkdir` — a
  // refusal, but not THIS module's refusal, so a caller could not tell a
  // deliberate second build from a broken output directory. Checked here, where
  // the answer is the module's own name.
  if (await lstat(outputDirectory).then(() => true, () => false)) return refused();
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return refused();
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: await realpath(tmpdir()) };
  const options = { env: environment, timeout: 60_000, maxBuffer: 1 << 20 };
  const sdk = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], options)).stdout.trim();
  const sdkVersion = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], options)).stdout.trim();
  const compiler = (await run("/usr/bin/clang", ["--version"], options)).stdout.split("\n")[0].trim();
  if (!isAbsolute(sdk) || !/^\d+(?:\.\d+){1,2}$/u.test(sdkVersion)
    || !/^Apple clang version [0-9][\x20-\x7e]{1,160}$/u.test(compiler)) return refused();
  const work = await realpath(await mkdtemp(join(tmpdir(), "acr-pg-clone-probe-build-")));
  try {
    const name = "pg-clone-probe-v1";
    const executable = join(work, name);
    // The source is CAPTURED into the build directory and compiled from there,
    // so what is compiled is the bytes that were digested. A source edited
    // between the `lstat` above and the `clang` below would otherwise produce a
    // binary whose `sourceSha256` describes a file that no longer exists.
    const source = await readFile(sourcePath);
    const capturedSource = join(work, `${name}.c`);
    await writeFile(capturedSource, source, { flag: "wx", mode: 0o600 });
    const args = [...PG_CLONE_PROBE_CFLAGS_V1, "-isysroot", sdk,
      "-arch", process.arch === "x64" ? "x86_64" : "arm64", capturedSource, "-o", executable];
    await run("/usr/bin/clang", args, options);
    await chmod(executable, 0o755);
    const bytes = await readFile(executable);
    const manifest = {
      schema: "control-room.pg-clone-probe-native-artifact/v1",
      platform: "darwin",
      architecture: process.arch,
      minimumMacos: "13.0",
      /** The wire protocol `pg-clone-probe-sidecar.ts` parses. Nothing else is accepted. */
      protocol: "PGCLONE1",
      sourcePath: "native/pg-clone-probe-v1.c",
      sourceSha256: sha256(source),
      executableName: name,
      executableSha256: sha256(bytes),
      executableBytes: bytes.length,
      toolchain: { compiler, sdkVersion, flags: [...PG_CLONE_PROBE_CFLAGS_V1] },
      /**
       * Where the probe must run, from finding 8: "the probe running in `pg/`
       * itself, on the same volume as `data-A`, not in a temp dir". Recorded so a
       * layout that violates it is detectable, because the whole point of the
       * probe is that it measures the volume the preimage will be written to.
       */
      probePlacement: "pg/",
      /**
       * One line a hostile `_crdb` can act on, which the review asked for and
       * which is a real operational fact rather than a caveat: the sidecar
       * `unlink`s both probe names before `O_EXCL`-creating them, so a concurrent
       * process that re-creates the destination name forces EEXIST, which
       * classifies as `clonefile_unavailable` and a 3x reservation. That is the
       * SAFE direction — a 3x reservation is only wasted headroom — and it does
       * mean a hostile process can deny the 1x path for as long as it likes.
       */
      concurrentPreCreation: "EEXIST on the destination probe name classifies as clonefile_unavailable and a 3x reservation; safe, and denyable by a hostile process for as long as it holds the name",
      /** The sidecar does not install itself and this build does not either. */
      installs: false,
      downloads: false,
    };
    const manifestName = "PG_CLONE_PROBE_MANIFEST.json";
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(outputDirectory, { mode: 0o700 });
    // The executable lands INSIDE the artifact directory, next to its manifest,
    // so the pair travels together and a verifier that finds the manifest finds
    // the binary it describes.
    await writeFile(join(outputDirectory, name), bytes, { flag: "wx", mode: 0o755 });
    await writeFile(join(outputDirectory, manifestName), manifestBytes, { flag: "wx", mode: 0o644 });
    return Object.freeze({
      schema: manifest.schema,
      platform: "darwin",
      architecture: process.arch,
      protocol: manifest.protocol,
      executableName: name,
      executableSha256: `sha256:${manifest.executableSha256}`,
      sourceSha256: `sha256:${manifest.sourceSha256}`,
      manifestName,
      ownerQualified: false,
      installs: false,
      downloads: false,
    });
  } finally {
    // Only this invocation's mkdtemp work directory is removed; the output is
    // kept, because an artifact that deletes itself is not an artifact.
    await rm(work, { recursive: true, force: true });
  }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output-directory") refused();
    console.log(JSON.stringify(await buildPgCloneProbeNativeArtifactV1({ outputDirectory: process.argv[3] })));
  } catch {
    console.error("Control Room PostgreSQL clone-probe native build refused.");
    process.exitCode = 1;
  }
}
