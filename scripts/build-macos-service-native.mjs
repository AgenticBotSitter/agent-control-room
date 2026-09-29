#!/usr/bin/env node
/** Explicit inert release-build tool for the fixed ACRSVC1 helper. It uses
 * only the installed Apple toolchain and never installs, publishes, registers,
 * starts, stops, or inspects a service. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MACOS_SERVICE_NATIVE_ARTIFACT_V1, MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1,
  MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-service-native-sidecar.mjs";

const run = promisify(execFile), sourcePath = fileURLToPath(new URL("../native/macos-service-v1.c", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = () => { throw new Error("macos_service_native_build_refused"); };

export async function buildMacosServiceNativeArtifactV1({ outputDirectory }) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)
    || typeof outputDirectory !== "string" || !isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory
    || outputDirectory === "/" || /[\u0000-\u001f\u007f]/u.test(outputDirectory)) refused();
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) refused();
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) refused();
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", ZERO_AR_DATE: "1", TMPDIR: await realpath(tmpdir()) };
  const options = { env: environment, timeout: 30_000, maxBuffer: 16_384 };
  const sdk = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], options)).stdout.trim();
  const sdkVersion = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], options)).stdout.trim();
  const compiler = (await run("/usr/bin/clang", ["--version"], options)).stdout.split("\n")[0];
  if (!isAbsolute(sdk) || !/^\d+(?:\.\d+){1,2}$/u.test(sdkVersion)
    || !/^Apple clang version [0-9][\x20-\x7e]{1,160}$/u.test(compiler)) refused();
  const work = await realpath(await mkdtemp(join(tmpdir(), "acr-service-native-build-")));
  try {
    const source = await readFile(sourcePath), capturedSource = join(work, "macos-service-v1.c");
    await writeFile(capturedSource, source, { flag: "wx", mode: 0o600 });
    const executable = join(work, "macos-service-v1");
    await run("/usr/bin/clang", [...MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1, "-isysroot", sdk,
      "-arch", process.arch === "x64" ? "x86_64" : "arm64", capturedSource, "-o", executable], options);
    await chmod(executable, 0o755);
    const files = [];
    for (const name of ["LICENSE", "NOTICE"]) {
      const bytes = await readFile(new URL(`../${name}`, import.meta.url));
      await writeFile(join(work, name), bytes, { flag: "wx", mode: 0o644 });
      files.push({ path: name, mode: "0644", bytes: bytes.length, sha256: sha256(bytes) });
    }
    const executableBytes = await readFile(executable);
    files.push({ path: "macos-service-v1", mode: "0755", bytes: executableBytes.length, sha256: sha256(executableBytes) });
    const manifest = { schema: MACOS_SERVICE_NATIVE_ARTIFACT_V1, platform: "darwin", architecture: process.arch,
      minimumMacos: "13.0", protocol: "ACRSVC1", sourceSha256: sha256(source),
      toolchain: { compiler, sdkVersion, flags: [...MACOS_SERVICE_NATIVE_REVIEWED_CFLAGS_V1] }, files, ownerQualified: false };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(outputDirectory, { mode: 0o700 });
    await chmod(outputDirectory, 0o700);
    for (const name of ["LICENSE", "NOTICE", "macos-service-v1"]) {
      const bytes = await readFile(join(work, name));
      await writeFile(join(outputDirectory, name), bytes, { flag: "wx", mode: name === "macos-service-v1" ? 0o755 : 0o644 });
      await chmod(join(outputDirectory, name), name === "macos-service-v1" ? 0o755 : 0o644);
    }
    await writeFile(join(outputDirectory, MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1), manifestBytes, { flag: "wx", mode: 0o644 });
    await chmod(join(outputDirectory, MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1), 0o644);
    const checksummed = [["LICENSE", await readFile(join(outputDirectory, "LICENSE"))],
      [MACOS_SERVICE_NATIVE_MANIFEST_NAME_V1, manifestBytes], ["NOTICE", await readFile(join(outputDirectory, "NOTICE"))],
      ["macos-service-v1", executableBytes]];
    const sums = checksummed.map(([name, bytes]) => `${sha256(bytes)}  ${name}`).sort().join("\n") + "\n";
    await writeFile(join(outputDirectory, "SHA256SUMS"), sums, { flag: "wx", mode: 0o644 });
    await chmod(join(outputDirectory, "SHA256SUMS"), 0o644);
    return Object.freeze({ schema: MACOS_SERVICE_NATIVE_ARTIFACT_V1, platform: "darwin", architecture: process.arch,
      protocol: "ACRSVC1", sourceSha256: `sha256:${sha256(source)}`,
      executableSha256: `sha256:${sha256(executableBytes)}`, ownerQualified: false,
      installs: false, startsService: false, downloads: false });
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output-directory") refused();
    console.log(JSON.stringify(await buildMacosServiceNativeArtifactV1({ outputDirectory: process.argv[3] })));
  } catch { console.error("Control Room macOS service native build refused."); process.exitCode = 1; }
}
