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
const LC_SEGMENT_64 = 0x19, LC_UUID = 0x1b;
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
  imageInventory: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
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
function u64(bytes: Uint8Array, offset: number): number {
  const low = u32(bytes, offset), high = u32(bytes, offset + 4);
  const value = low + high * 0x1_0000_0000;
  if (!Number.isSafeInteger(value)) refuse();
  return value;
}
function fixedAscii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || length < 1 || start + length > bytes.length) refuse();
  let stop = start;
  while (stop < start + length && bytes[stop] !== 0) stop += 1;
  if (stop === start) refuse();
  for (let index = start; index < stop; index += 1) {
    if (bytes[index]! < 0x21 || bytes[index]! > 0x7e) refuse();
  }
  for (let index = stop; index < start + length; index += 1) if (bytes[index] !== 0) refuse();
  return Buffer.from(bytes.subarray(start, stop)).toString("ascii");
}
function checkedEnd(start: number, size: number, limit: number): number {
  const end = start + size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0
    || !Number.isSafeInteger(end) || end > limit) refuse();
  return end;
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
type Range = Readonly<{ start: number; end: number }>;
type Segment = Readonly<{
  name: string; vm: Range; file: Range; maxProtection: number; initialProtection: number;
  sectionVmRanges: readonly Range[]; sectionFileRanges: readonly Range[];
}>;
function overlaps(left: Range, right: Range): boolean {
  return left.start < right.end && right.start < left.end;
}
function assertNoOverlaps(ranges: readonly Range[]): void {
  const sorted = [...ranges].filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < sorted.length; index += 1) {
    if (overlaps(sorted[index - 1]!, sorted[index]!)) refuse();
  }
}
function parseSegment64(bytes: Uint8Array, at: number, commandSize: number, pageAlignment: number): Segment {
  if (commandSize < 72) refuse();
  const name = fixedAscii(bytes, at + 8, 16);
  if (!/^__[A-Z0-9_]{1,14}$/u.test(name)) refuse();
  const vmStart = u64(bytes, at + 24), vmSize = u64(bytes, at + 32);
  const fileStart = u64(bytes, at + 40), fileSize = u64(bytes, at + 48);
  const maxProtection = u32(bytes, at + 56), initialProtection = u32(bytes, at + 60);
  const sectionCount = u32(bytes, at + 64), flags = u32(bytes, at + 68);
  if (sectionCount > 4096 || commandSize !== 72 + sectionCount * 80 || flags !== 0
    || vmSize === 0 || vmStart % pageAlignment !== 0 || vmSize % pageAlignment !== 0
    || fileStart % pageAlignment !== 0 || fileSize > vmSize || (maxProtection & ~7) !== 0
    || (initialProtection & ~7) !== 0 || (initialProtection & ~maxProtection) !== 0
    || (initialProtection & 2) !== 0 && (initialProtection & 4) !== 0) refuse();
  const vmEnd = checkedEnd(vmStart, vmSize, Number.MAX_SAFE_INTEGER);
  const fileEnd = checkedEnd(fileStart, fileSize, bytes.length);
  if (name === "__TEXT" && (fileStart !== 0 || fileSize === 0 || maxProtection !== 5 || initialProtection !== 5)) refuse();
  if (name === "__LINKEDIT" && (fileSize === 0 || maxProtection !== 1 || initialProtection !== 1 || sectionCount !== 0)) refuse();
  if (name !== "__TEXT" && name !== "__LINKEDIT" && (maxProtection === 0 || initialProtection === 0)) refuse();

  const sectionVmRanges: Range[] = [], sectionFileRanges: Range[] = [];
  const sectionNames = new Set<string>();
  let previousVmEnd = vmStart, previousFileEnd = fileStart, sawZeroFill = false;
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionAt = at + 72 + index * 80;
    const sectionName = fixedAscii(bytes, sectionAt, 16);
    const sectionSegmentName = fixedAscii(bytes, sectionAt + 16, 16);
    const address = u64(bytes, sectionAt + 32), size = u64(bytes, sectionAt + 40);
    const offset = u32(bytes, sectionAt + 48), alignmentPower = u32(bytes, sectionAt + 52);
    const relocationOffset = u32(bytes, sectionAt + 56), relocationCount = u32(bytes, sectionAt + 60);
    const sectionFlags = u32(bytes, sectionAt + 64), reserved1 = u32(bytes, sectionAt + 68);
    const reserved2 = u32(bytes, sectionAt + 72), reserved3 = u32(bytes, sectionAt + 76);
    const sectionType = sectionFlags & 0xff;
    // S_ATTR_DEBUG is deliberately excluded until its segment-placement
    // semantics are part of a later reviewed parser phase.
    const knownAttributes = 0xfc000700;
    if (!/^__[A-Za-z0-9_]{1,14}$/u.test(sectionName) || sectionSegmentName !== name
      || sectionNames.has(sectionName) || size === 0 || alignmentPower > 15
      || (sectionFlags & ~(knownAttributes | 0xff)) !== 0 || sectionType > 2
      || relocationOffset !== 0 || relocationCount !== 0 || reserved1 !== 0 || reserved2 !== 0 || reserved3 !== 0) refuse();
    sectionNames.add(sectionName);
    const alignment = 2 ** alignmentPower;
    const sectionVmEnd = checkedEnd(address, size, vmEnd);
    if (address < previousVmEnd || address % alignment !== 0) refuse();
    sectionVmRanges.push(Object.freeze({ start: address, end: sectionVmEnd }));
    if (sectionType === 1) {
      if (offset !== 0 || address < vmStart + fileSize) refuse();
      sawZeroFill = true;
    } else {
      const sectionFileEnd = checkedEnd(offset, size, fileEnd);
      if (sawZeroFill || offset < previousFileEnd || offset % alignment !== 0
        || address - vmStart !== offset - fileStart) refuse();
      sectionFileRanges.push(Object.freeze({ start: offset, end: sectionFileEnd }));
      previousFileEnd = sectionFileEnd;
    }
    previousVmEnd = sectionVmEnd;
  }
  assertNoOverlaps(sectionVmRanges);
  assertNoOverlaps(sectionFileRanges);
  return Object.freeze({ name, vm: Object.freeze({ start: vmStart, end: vmEnd }),
    file: Object.freeze({ start: fileStart, end: fileEnd }), maxProtection, initialProtection,
    sectionVmRanges: Object.freeze(sectionVmRanges), sectionFileRanges: Object.freeze(sectionFileRanges) });
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
  let at = commandsStart, baseline = false, dylinker = false, uuid = false;
  const dependencies: string[] = [], segments: Segment[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 8 > commandsEnd) refuse(); const command = u32(bytes, at), commandSize = u32(bytes, at + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || at + commandSize > commandsEnd) refuse();
    if (command === LC_SEGMENT_64) {
      segments.push(parseSegment64(bytes, at, commandSize, architecture === "arm64" ? 16384 : 4096));
    } else if (command === LC_UUID) {
      if (commandSize !== 24 || uuid) refuse();
      let nonzero = false;
      for (let byte = at + 8; byte < at + 24; byte += 1) nonzero ||= bytes[byte] !== 0;
      if (!nonzero) refuse();
      uuid = true;
    } else if (command === LC_BUILD_VERSION) {
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
  if (at !== commandsEnd || !baseline || !uuid) refuse();
  if (new Set(segments.map(segment => segment.name)).size !== segments.length) refuse();
  const text = segments.find(segment => segment.name === "__TEXT");
  const linkedit = segments.find(segment => segment.name === "__LINKEDIT");
  if (!text || !linkedit || commandsEnd > text.file.end || linkedit.file.end !== bytes.length
    || linkedit.file.start < text.file.end) refuse();
  for (const range of text.sectionFileRanges) if (range.start < commandsEnd) refuse();
  assertNoOverlaps(segments.map(segment => segment.vm));
  assertNoOverlaps(segments.map(segment => segment.file));
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
