import { posix } from "node:path";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { sha256Digest } from "../../security/canonical-digest";

/** A deliberately small, pure parser for the native files already presented by
 * a release builder. It neither reads paths nor asks dyld to resolve anything. */
export const MACOS_HERMES_MACHO_DEPENDENCY_CLOSURE_V1 =
  "control-room.macos-hermes-macho-dependency-closure/v1" as const;

const cpu = { arm64: 0x0100000c, x64: 0x01000007 } as const;
const systemLibraries = new Set([
  "/usr/lib/libSystem.B.dylib", "/usr/lib/libc++.1.dylib", "/usr/lib/libc++abi.dylib",
  "/usr/lib/libobjc.A.dylib",
  "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
  "/System/Library/Frameworks/Security.framework/Versions/A/Security",
  "/System/Library/Frameworks/SystemConfiguration.framework/Versions/A/SystemConfiguration",
]);
const LC_LOAD_DYLIB = 0x0c, LC_ID_DYLIB = 0x0d, LC_LOAD_DYLINKER = 0x0e;
const LC_BUILD_VERSION = 0x32, LC_VERSION_MIN_MACOSX = 0x24;
const fatMagics = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const fixedExecutablePath = "bin/hermes";
const knownHeaderFlags = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100
  | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x8000 | 0x10000 | 0x80000
  | 0x100000 | 0x200000 | 0x400000 | 0x800000 | 0x1000000;

export type MacosHermesMachODependencyClosureV1 = Readonly<{
  schema: typeof MACOS_HERMES_MACHO_DEPENDENCY_CLOSURE_V1;
  status: "source_only_native_dependency_closure_validated";
  architecture: "arm64" | "x64";
  executablePath: string;
  imagePaths: readonly string[];
  imageInventory: readonly Readonly<{ path: string; sha256: string }>;
  closureDigest: string;
  macosBaseline: "13.0";
  filesystemInspected: false; hostPathSearchPerformed: false; readyForPackaging: false;
  readyForLaunch: false; grantsPackagingAuthority: false; grantsLaunchAuthority: false;
  grantsInstallAuthority: false; grantsQualificationAuthority: false;
}>;

type Image = Readonly<{ path: string; kind: "regular_file"; bytes: Uint8Array }>;
function refuse(): never { const error = new Error("macos_hermes_macho_dependency_closure_refused"); error.stack = undefined; throw error; }
function own(object: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(object, key);
  if (!d || !d.enumerable || !("value" in d)) refuse(); return d.value;
}
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length
    || Object.getOwnPropertyNames(value).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) refuse();
  for (const key of keys) own(value, key); return value as Record<string, unknown>;
}
function safePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.startsWith("/")
    || value.includes("\\") || value.includes("\0") || posix.normalize(value) !== value
    || value.split("/").some(part => !part || part === "." || part === ".." || !/^[\x21-\x7e]+$/u.test(part))) refuse();
  return value;
}
function u32(bytes: Uint8Array, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.length) refuse();
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0;
}
function asciiCString(bytes: Uint8Array, start: number, end: number): string {
  if (start < 0 || start >= end || end > bytes.length) refuse();
  let stop = start; while (stop < end && bytes[stop] !== 0) stop += 1;
  if (stop === end || stop === start) refuse();
  for (let i = start; i < stop; i += 1) if (bytes[i]! < 0x20 || bytes[i]! > 0x7e) refuse();
  for (let i = stop + 1; i < end; i += 1) if (bytes[i] !== 0) refuse();
  return Buffer.from(bytes.subarray(start, stop)).toString("ascii");
}
function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function versionAtMost13(value: number): boolean {
  const major = value >>> 16, minor = value >>> 8 & 0xff, patch = value & 0xff;
  return major > 0 && (major < 13 || major === 13 && minor === 0 && patch === 0);
}
function parseImage(image: Image, architecture: "arm64" | "x64"): Readonly<{ dependencies: readonly string[]; hasDylinker: boolean }> {
  const bytes = image.bytes;
  const expectedFiletype = image.path === fixedExecutablePath ? 2 : 6;
  const expectedSubtype = architecture === "arm64" ? 0 : 3;
  if (bytes.length < 32 || fatMagics.has(Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0))
    || u32(bytes, 0) !== 0xfeedfacf || u32(bytes, 4) !== cpu[architecture]
    || u32(bytes, 8) !== expectedSubtype || u32(bytes, 12) !== expectedFiletype
    || (u32(bytes, 24) & ~knownHeaderFlags) !== 0 || u32(bytes, 28) !== 0) refuse();
  const count = u32(bytes, 16), size = u32(bytes, 20), commandsStart = 32, commandsEnd = commandsStart + size;
  if (count === 0 || count > 4096 || !Number.isSafeInteger(commandsEnd) || commandsEnd > bytes.length) refuse();
  let at = commandsStart, baseline = false, dylinker = false; const dependencies: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 8 > commandsEnd) refuse(); const command = u32(bytes, at), commandSize = u32(bytes, at + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || at + commandSize > commandsEnd) refuse();
    if (command === LC_BUILD_VERSION) {
      const tools = u32(bytes, at + 20);
      if (commandSize !== 24 + tools * 8 || tools > 1024 || u32(bytes, at + 8) !== 1
        || !versionAtMost13(u32(bytes, at + 12))) refuse(); baseline = true;
      for (let tool = 0; tool < tools; tool += 1) {
        const toolType = u32(bytes, at + 24 + tool * 8), toolVersion = u32(bytes, at + 28 + tool * 8);
        if (toolType < 1 || toolType > 3 || toolVersion === 0) refuse();
      }
    } else if (command === LC_VERSION_MIN_MACOSX) {
      if (commandSize !== 16 || !versionAtMost13(u32(bytes, at + 8))) refuse(); baseline = true;
    } else if (command === LC_LOAD_DYLINKER) {
      const offset = u32(bytes, at + 8);
      if (offset < 12 || dylinker || asciiCString(bytes, at + offset, at + commandSize) !== "/usr/lib/dyld") refuse(); dylinker = true;
    } else if (command === LC_LOAD_DYLIB || command === LC_ID_DYLIB) {
      const offset = u32(bytes, at + 8);
      if (commandSize < 24 || offset < 24) refuse(); const name = asciiCString(bytes, at + offset, at + commandSize);
      if (command === LC_LOAD_DYLIB) dependencies.push(name);
      else if (!name.startsWith("@loader_path/") || resolveLoaderPath(image.path, name) !== image.path) refuse();
    } else refuse();
    at += commandSize;
  }
  if (at !== commandsEnd || !baseline) refuse();
  return Object.freeze({ dependencies: Object.freeze(dependencies), hasDylinker: dylinker });
}
function resolveLoaderPath(from: string, name: string): string {
  if (!name.startsWith("@loader_path/") || name.includes("\\") || name.includes("\0")) refuse();
  const target = posix.normalize(posix.join(posix.dirname(from), name.slice("@loader_path/".length)));
  if (!target || target === "." || target.startsWith("../") || target.includes("/../") || target.startsWith("/")) refuse();
  return target;
}

/** Validates a finite, supplied set of thin native images; no host filesystem is consulted. */
export function validateMacosHermesMachODependencyClosureV1(value: unknown): MacosHermesMachODependencyClosureV1 {
  const input = plain(value, ["architecture", "executablePath", "images"]);
  const architecture = own(input, "architecture"), executable = own(input, "executablePath"), rawImages = own(input, "images");
  if ((architecture !== "arm64" && architecture !== "x64") || !Array.isArray(rawImages)
    || types.isProxy(rawImages) || Object.getPrototypeOf(rawImages) !== Array.prototype
    || rawImages.length < 1 || rawImages.length > 4096 || Object.getOwnPropertyNames(rawImages).length !== rawImages.length + 1) refuse();
  if (Object.getOwnPropertySymbols(rawImages).length !== 0) refuse();
  const executablePath = safePath(executable), images: Image[] = [];
  if (executablePath !== fixedExecutablePath) refuse();
  for (let i = 0; i < rawImages.length; i += 1) {
    const raw = own(rawImages, String(i)), record = plain(raw, ["path", "kind", "bytes"]);
    const path = safePath(own(record, "path")), kind = own(record, "kind"), bytes = own(record, "bytes");
    if (kind !== "regular_file" || !(bytes instanceof Uint8Array) || types.isProxy(bytes)) refuse();
    images.push(Object.freeze({ path, kind: "regular_file", bytes: new Uint8Array(bytes) }));
  }
  if (new Set(images.map(image => image.path)).size !== images.length) refuse();
  const byPath = new Map(images.map(image => [image.path, image])); if (!byPath.has(executablePath)) refuse();
  const parsed = new Map<string, ReturnType<typeof parseImage>>();
  for (const image of images) parsed.set(image.path, parseImage(image, architecture));
  const reached = new Set<string>(), pending = [executablePath];
  while (pending.length) {
    const path = pending.pop()!; if (reached.has(path)) continue; reached.add(path);
    const result = parsed.get(path)!;
    if (path === executablePath ? !result.hasDylinker : result.hasDylinker) refuse();
    for (const name of result.dependencies) {
      if (systemLibraries.has(name)) continue;
      const target = resolveLoaderPath(path, name); if (!byPath.has(target)) refuse(); pending.push(target);
    }
  }
  if (reached.size !== images.length) refuse();
  const imageInventory = images.map(image => Object.freeze({ path: image.path, sha256: digest(image.bytes) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const closureDigest = sha256Digest({ schema: MACOS_HERMES_MACHO_DEPENDENCY_CLOSURE_V1,
    architecture, executablePath, imageInventory });
  return Object.freeze({ schema: MACOS_HERMES_MACHO_DEPENDENCY_CLOSURE_V1,
    status: "source_only_native_dependency_closure_validated", architecture,
    executablePath, imagePaths: Object.freeze([...reached].sort()), imageInventory: Object.freeze(imageInventory), closureDigest, macosBaseline: "13.0",
    filesystemInspected: false, hostPathSearchPerformed: false, readyForPackaging: false,
    readyForLaunch: false, grantsPackagingAuthority: false, grantsLaunchAuthority: false,
    grantsInstallAuthority: false, grantsQualificationAuthority: false });
}
