#!/usr/bin/env node
/** Explicit release-build tool, never imported by the runtime. Uses the
 * installed macOS toolchain only. No toolchain/package download or install.
 * A separate native artifact is necessary: portable-node's manifest currently
 * normalizes every file to 0644. A later launcher composition must verify and
 * bind this platform artifact; this script does not enable live installation. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createDeterministicTarGzipV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-installation-journal-native-sidecar.mjs";

const run = promisify(execFile);
const sourcePath = fileURLToPath(new URL("../native/installation-journal-session-v1.c", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = () => { throw new Error("installation_journal_native_build_refused"); };
export const INSTALLATION_JOURNAL_NATIVE_CFLAGS_V1 = INSTALLATION_JOURNAL_NATIVE_REVIEWED_CFLAGS_V1;

export async function buildInstallationJournalNativeArtifactV1({ outputDirectory }) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)
    || typeof outputDirectory !== "string" || !isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory
    || outputDirectory === "/" || /[\u0000-\u001f\u007f]/u.test(outputDirectory)) return refused();
  // Output parent must exist/canonical; exclusive mkdir refuses prior artifacts.
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) return refused();
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return refused();
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", ZERO_AR_DATE: "1", TMPDIR: await realpath(tmpdir()) };
  const options = { env: environment, timeout: 30_000, maxBuffer: 16_384 };
  const sdk = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], options)).stdout.trim();
  const sdkVersion = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], options)).stdout.trim();
  const compiler = (await run("/usr/bin/clang", ["--version"], options)).stdout.split("\n")[0];
  if (!isAbsolute(sdk) || !/^\d+(?:\.\d+){1,2}$/u.test(sdkVersion)
    || !/^Apple clang version [0-9][\x20-\x7e]{1,160}$/u.test(compiler)) return refused();
  const work = await realpath(await mkdtemp(join(tmpdir(), "acr-native-build-")));
  try {
    const name = "installation-journal-session-v1", executable = join(work, name);
    const source = await readFile(sourcePath);
    const capturedSource = join(work, "installation-journal-session-v1.c");
    await writeFile(capturedSource, source, { flag: "wx", mode: 0o600 });
    const args = [...INSTALLATION_JOURNAL_NATIVE_CFLAGS_V1, "-isysroot", sdk,
      "-arch", process.arch === "x64" ? "x86_64" : "arm64", capturedSource, "-o", executable];
    await run("/usr/bin/clang", args, options);
    await chmod(executable, 0o755);
    const bytes = await readFile(executable);
    const files = [{ path: name, mode: "0755", bytes: bytes.length, sha256: sha256(bytes) }];
    for (const licenseName of ["LICENSE", "NOTICE"]) {
      const license = await readFile(new URL(`../${licenseName}`, import.meta.url));
      await writeFile(join(work, licenseName), license, { flag: "wx", mode: 0o644 });
      files.push({ path: licenseName, mode: "0644", bytes: license.length, sha256: sha256(license) });
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const manifest = {
      schema: "control-room.installation-journal-native-artifact/v1", platform: "darwin", architecture: process.arch,
      minimumMacos: "13.0", protocol: "ACRJNL1", sourceSha256: sha256(source),
      toolchain: { compiler, sdkVersion, flags: [...INSTALLATION_JOURNAL_NATIVE_CFLAGS_V1] },
      files,
      ownerQualified: false,
    };
    const manifestName = "INSTALLATION_JOURNAL_MANIFEST.json";
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(work, manifestName), manifestBytes, { flag: "wx", mode: 0o644 });
    const archiveRoot = `agent-control-room-installation-journal-darwin-${process.arch}`;
    const archive = await createDeterministicTarGzipV1(work, archiveRoot,
      [...files.map(({ path, mode }) => ({ path, mode })), { path: manifestName, mode: "0644" }]);
    const archiveName = `${archiveRoot}.tar.gz`;
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(join(outputDirectory, archiveName), archive, { flag: "wx", mode: 0o644 });
    await writeFile(join(outputDirectory, manifestName), manifestBytes, { flag: "wx", mode: 0o644 });
    await writeFile(join(outputDirectory, "SHA256SUMS"), `${sha256(archive)}  ${archiveName}\n`, { flag: "wx", mode: 0o644 });
    return Object.freeze({ schema: manifest.schema, archiveName, archiveSha256: sha256(archive),
      executableSha256: `sha256:${sha256(bytes)}`, platform: "darwin", architecture: process.arch,
      ownerQualified: false, installs: false, downloads: false });
  } finally {
    // Only this invocation's mkdtemp work directory is removed; output is kept.
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output-directory") refused();
    console.log(JSON.stringify(await buildInstallationJournalNativeArtifactV1({ outputDirectory: process.argv[3] })));
  } catch {
    console.error("Control Room installation-journal native build refused.");
    process.exitCode = 1;
  }
}
