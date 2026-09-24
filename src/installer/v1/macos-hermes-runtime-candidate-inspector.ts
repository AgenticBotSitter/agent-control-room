import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { buildMacosHermesRuntimeImageManifestV1, type MacosHermesRuntimeImageEntryV1,
  type MacosHermesRuntimeImageManifestV1 } from "./macos-hermes-runtime-image-manifest";

const maximumEntries = 100_000, maximumFileBytes = 128 * 1024 * 1024;
const requiredNoticePaths = Object.freeze(["LICENSE", "NOTICE"] as const);
const machOMagics = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const fatMachOMagics = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export type MacosHermesRuntimeCandidateInspectionV1 = Readonly<{
  manifest: MacosHermesRuntimeImageManifestV1;
  observations: Readonly<{
    status: "public_candidate_inspected"; candidateTreeSha256: string;
    scannedRegularFileCount: number; scannedByteCount: number; requiredNoticePaths: readonly string[];
    allRequiredNoticesPresent: true; absolutePathsStored: false; fileContentsStored: false;
    filesystemCustodyVerified: false; readyForPackaging: false; readyForLaunch: false;
    grantsPackagingAuthority: false; grantsLaunchAuthority: false;
  }>;
}>;

function refuse(): never { const error = new Error("macos_hermes_runtime_candidate_inspection_refused"); error.stack = undefined; throw error; }
function safeRelativePath(value: string): string {
  if (!value || value.length > 512 || value.includes("\\") || value.includes("\0") || value.startsWith("/")
    || posix.normalize(value) !== value || value.split("/").some(part => !part || part === "." || part === "..")) refuse();
  return value;
}
function pathBelow(root: string, path: string): string { return safeRelativePath(relative(root, path).split(sep).join("/")); }
function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function contains(bytes: Uint8Array, text: string): boolean { return Buffer.from(bytes).indexOf(Buffer.from(text, "utf8")) !== -1; }
function isMachO(bytes: Uint8Array): boolean { return bytes.length >= 4 && machOMagics.has(Buffer.from(bytes).readUInt32BE(0)); }
function isFatMachO(bytes: Uint8Array): boolean { return bytes.length >= 4 && fatMachOMagics.has(Buffer.from(bytes).readUInt32BE(0)); }
function readOnlyMode(mode: number, expected: 0o444 | 0o555): boolean { return (mode & 0o7777) === expected; }
function input(value: unknown): Readonly<{ candidateDirectory: string; architecture: "arm64" | "x64"; expectedPaths: readonly string[] }> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || names.some(name => !["candidateDirectory", "architecture", "expectedPaths"].includes(name))) refuse();
  const directory = Object.getOwnPropertyDescriptor(value, "candidateDirectory"), architecture = Object.getOwnPropertyDescriptor(value, "architecture"), expected = Object.getOwnPropertyDescriptor(value, "expectedPaths");
  if (!directory || !directory.enumerable || !("value" in directory) || typeof directory.value !== "string" || !directory.value.startsWith("/")
    || !architecture || !architecture.enumerable || !("value" in architecture) || (architecture.value !== "arm64" && architecture.value !== "x64")
    || !expected || !expected.enumerable || !("value" in expected) || !Array.isArray(expected.value) || types.isProxy(expected.value)
    || Object.getPrototypeOf(expected.value) !== Array.prototype || expected.value.length < 1 || expected.value.length > maximumEntries
    || Object.getOwnPropertySymbols(expected.value).length || Object.getOwnPropertyNames(expected.value).length !== expected.value.length + 1) refuse();
  const rawPaths: unknown[] = [];
  for (let index = 0; index < expected.value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(expected.value, String(index));
    if (!item || !item.enumerable || !("value" in item)) refuse(); rawPaths.push(item.value);
  }
  const paths = rawPaths.map(item => typeof item === "string" ? safeRelativePath(item) : refuse());
  if (new Set(paths).size !== paths.length || !requiredNoticePaths.every(path => paths.includes(path))) refuse();
  return Object.freeze({ candidateDirectory: directory.value, architecture: architecture.value, expectedPaths: Object.freeze(paths) });
}

/** Build-time inspection only. The supplied directory is never packaged, installed, launched, or retained. */
export async function inspectMacosHermesRuntimeCandidateDirectoryV1(value: unknown): Promise<MacosHermesRuntimeCandidateInspectionV1> {
  const request = input(value), root = resolve(request.candidateDirectory), rootStat = await lstat(root).catch(refuse);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !readOnlyMode(rootStat.mode, 0o555)) refuse();
  const entries: MacosHermesRuntimeImageEntryV1[] = []; let scannedRegularFileCount = 0, scannedByteCount = 0;
  async function visit(directory: string): Promise<void> {
    const names = await readdir(directory).catch(refuse); names.sort();
    for (const name of names) {
      const file = resolve(directory, name); if (!name || file !== root && !file.startsWith(`${root}${sep}`)) refuse();
      const stat = await lstat(file).catch(refuse), path = pathBelow(root, file);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) refuse();
      if (stat.isDirectory()) {
        if (!readOnlyMode(stat.mode, 0o555)) refuse();
        entries.push({ path, kind: "directory", mode: "0555", sizeBytes: 0, sha256: null, linkCount: null }); if (entries.length > maximumEntries) refuse();
        await visit(file); continue;
      }
      if (!readOnlyMode(stat.mode, 0o444) && !readOnlyMode(stat.mode, 0o555) || stat.nlink !== 1 || stat.size > maximumFileBytes) refuse();
      const bytes = await readFile(file).catch(refuse); if (bytes.length !== stat.size || contains(bytes, "/nix/store/")) refuse();
      // Raw string scanning cannot prove a thin Mach-O's full dyld closure:
      // relative install names evade prefix-based checks. Until a reviewed
      // native dependency validator exists, all native Mach-O inputs refuse.
      if (isFatMachO(bytes) || isMachO(bytes)) refuse();
      entries.push({ path, kind: "regular_file", mode: (stat.mode & 0o777) === 0o555 ? "0555" : "0444", sizeBytes: bytes.length, sha256: digest(bytes), linkCount: 1 });
      scannedRegularFileCount += 1; scannedByteCount += bytes.length; if (!Number.isSafeInteger(scannedByteCount) || entries.length > maximumEntries) refuse();
    }
  }
  await visit(root);
  const observed = entries.map(entry => entry.path);
  if (observed.length !== request.expectedPaths.length || request.expectedPaths.some(path => !observed.includes(path)) || !requiredNoticePaths.every(path => observed.includes(path))) refuse();
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  if (!requiredNoticePaths.every(path => byPath.get(path)?.kind === "regular_file" && byPath.get(path)?.mode === "0444")) refuse();
  const candidateTreeSha256 = sha256Digest(entries.map(entry => ({ ...entry })).sort((left, right) => left.path.localeCompare(right.path)));
  const manifest = buildMacosHermesRuntimeImageManifestV1({ architecture: request.architecture, entries, expectedPaths: request.expectedPaths, runtimeImageSha256: candidateTreeSha256 });
  const observations = Object.freeze({ status: "public_candidate_inspected" as const, candidateTreeSha256, scannedRegularFileCount, scannedByteCount,
    requiredNoticePaths: Object.freeze([...requiredNoticePaths]), allRequiredNoticesPresent: true as const, absolutePathsStored: false as const,
    fileContentsStored: false as const, filesystemCustodyVerified: false as const, readyForPackaging: false as const,
    readyForLaunch: false as const, grantsPackagingAuthority: false as const, grantsLaunchAuthority: false as const });
  return Object.freeze({ manifest, observations });
}
export function serializeMacosHermesRuntimeCandidateInspectionV1(value: MacosHermesRuntimeCandidateInspectionV1): string { return `${canonicalJson(value)}\n`; }
