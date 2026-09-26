import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMacosHermesMachODependencyClosureV1 as validate } from
  "../src/installer/v1/macos-hermes-macho-dependency-closure";

const refusal = /^Error: macos_hermes_macho_dependency_closure_refused$/u;
type Command = Readonly<{ type: number; body: Uint8Array }>;
const u32 = (buffer: Uint8Array, at: number, value: number) => buffer.set([value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255], at);
const u64 = (buffer: Uint8Array, at: number, value: number) => {
  u32(buffer, at, value >>> 0); u32(buffer, at + 4, Math.floor(value / 0x1_0000_0000));
};
function fixed(buffer: Uint8Array, at: number, value: string) { Buffer.from(value, "ascii").copy(buffer, at); }
function padded(text: string, prefix: number): Uint8Array {
  const size = Math.ceil((prefix + text.length + 1) / 8) * 8, result = new Uint8Array(size);
  Buffer.from(text).copy(result, prefix); return result;
}
function command(type: number, body: Uint8Array): Command { return { type, body }; }
type Section = Readonly<{ name: string; address: number; size: number; offset: number; flags: number }>;
function segment(name: string, vmStart: number, vmSize: number, fileStart: number, fileSize: number,
  maximumProtection: number, initialProtection: number, sections: readonly Section[] = []): Command {
  const body = new Uint8Array(64 + sections.length * 80);
  fixed(body, 0, name); u64(body, 16, vmStart); u64(body, 24, vmSize); u64(body, 32, fileStart);
  u64(body, 40, fileSize); u32(body, 48, maximumProtection); u32(body, 52, initialProtection); u32(body, 56, sections.length);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!, at = 64 + index * 80;
    fixed(body, at, section.name); fixed(body, at + 16, name); u64(body, at + 32, section.address);
    u64(body, at + 40, section.size); u32(body, at + 48, section.offset); u32(body, at + 52, 4);
    u32(body, at + 64, section.flags);
  }
  return command(0x19, body);
}
function uuid(): Command { return command(0x1b, Uint8Array.from({ length: 16 }, (_, index) => index + 1)); }
type DataLayout = "trailing_bss" | "backed_bss" | "bss_before_regular";
function build(architecture: "arm64" | "x64", commands: readonly Command[], minimum = 0x000d0000, filetype = 2,
  dataLayout?: DataLayout): Uint8Array {
  const version = new Uint8Array(16); u32(version, 0, 1); u32(version, 4, minimum);
  const page = architecture === "arm64" ? 0x4000 : 0x1000, base = 0x1_0000_0000;
  const textOffset = architecture === "arm64" ? 0x1000 : 0x800;
  const text = segment("__TEXT", base, page, 0, page, 5, 5,
    [{ name: "__text", address: base + textOffset, size: 0x100, offset: textOffset, flags: 0x80000400 }]);
  const extras: Command[] = [];
  if (dataLayout) {
    const dataStart = page, dataVm = base + page;
    const regular = { name: "__data", address: dataVm, size: 0x100, offset: dataStart, flags: 0 };
    const bss = { name: "__bss", address: dataVm + page, size: 0x100, offset: 0, flags: 1 };
    if (dataLayout === "backed_bss") bss.address = dataVm + 0x200;
    extras.push(segment("__DATA", dataVm, page * 2, dataStart, page, 3, 3,
      dataLayout === "bss_before_regular" ? [bss, regular] : [regular, bss]));
  }
  const linkFile = dataLayout ? page * 2 : page, linkVm = dataLayout ? base + page * 3 : base + page;
  const linkedit = segment("__LINKEDIT", linkVm, page, linkFile, 0x100, 1, 1);
  const all = [text, ...extras, linkedit, uuid(), command(0x32, version), ...commands];
  const commandBytes = all.reduce((total, item) => total + 8 + item.body.length, 0);
  const bytes = new Uint8Array(linkFile + 0x100); u32(bytes, 0, 0xfeedfacf); u32(bytes, 4, architecture === "arm64" ? 0x0100000c : 0x01000007);
  u32(bytes, 8, architecture === "arm64" ? 0 : 3); u32(bytes, 12, filetype); u32(bytes, 16, all.length); u32(bytes, 20, commandBytes); let at = 32;
  for (const item of all) { u32(bytes, at, item.type); u32(bytes, at + 4, 8 + item.body.length); bytes.set(item.body, at + 8); at += 8 + item.body.length; }
  return bytes;
}
function dylinker() { const body = padded("/usr/lib/dyld", 4); u32(body, 0, 12); return command(0x0e, body); }
function dylib(name: string, type = 0x0c) { const body = new Uint8Array(16 + padded(name, 0).length); u32(body, 0, 24); body.set(padded(name, 0), 16); return command(type, body); }
function fixture(architecture: "arm64" | "x64" = "arm64") {
  return { architecture, executablePath: "bin/hermes", images: [
    { path: "bin/hermes", kind: "regular_file" as const, bytes: build(architecture, [dylinker(), dylib("/usr/lib/libSystem.B.dylib"), dylib("@loader_path/../lib/libhermes.dylib")]) },
    { path: "lib/libhermes.dylib", kind: "regular_file" as const, bytes: build(architecture, [dylib("@loader_path/libhermes.dylib", 0x0d), dylib("/System/Library/Frameworks/Security.framework/Versions/A/Security")], undefined, 6) },
  ] };
}

function findCommand(bytes: Uint8Array, type: number, occurrence = 0): number {
  let at = 32;
  for (let index = 0, seen = 0; index < Buffer.from(bytes).readUInt32LE(16); index += 1) {
    if (Buffer.from(bytes).readUInt32LE(at) === type && seen++ === occurrence) return at;
    at += Buffer.from(bytes).readUInt32LE(at + 4);
  }
  throw new Error("fixture command missing");
}
function appendCommand(bytes: Uint8Array, item: Command): void {
  const count = Buffer.from(bytes).readUInt32LE(16), size = Buffer.from(bytes).readUInt32LE(20);
  const at = 32 + size, commandSize = 8 + item.body.length;
  u32(bytes, at, item.type); u32(bytes, at + 4, commandSize); bytes.set(item.body, at + 8);
  u32(bytes, 16, count + 1); u32(bytes, 20, size + commandSize);
}

test("accepts realistic supplied thin arm64 and x64 closures and grants no authority", () => {
  for (const architecture of ["arm64", "x64"] as const) {
    const value = fixture(architecture), result = validate(value);
    assert.deepEqual(result.imagePaths, ["bin/hermes", "lib/libhermes.dylib"]);
    assert.equal(result.imageInventory.length, 2); assert.match(result.closureDigest, /^sha256:[a-f0-9]{64}$/u);
    value.images[1]!.bytes[architecture === "arm64" ? 0x1080 : 0x880] = 0x5a;
    assert.notEqual(validate(value).closureDigest, result.closureDigest);
    assert.equal(result.macosBaseline, "13.0");
    for (const [key, field] of Object.entries(result)) if (key.startsWith("grants") || key.startsWith("ready")) assert.equal(field, false);
    assert.equal(result.filesystemInspected, false); assert.equal(result.hostPathSearchPerformed, false);
  }
});

test("refuses unresolved or non-exact dependency names and targets", () => {
  const mutations = [
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [dylinker(), dylib("@rpath/libhermes.dylib")]); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [dylinker(), dylib("@loader_path/../../escape.dylib")]); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [dylinker(), dylib("/usr/lib/libsqlite3.dylib")]); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [dylinker(), dylib("@loader_path/missing.dylib")]); },
    (v: ReturnType<typeof fixture>) => { v.images.push({ path: "lib/unreached.dylib", kind: "regular_file", bytes: build("arm64", [], undefined, 6) }); },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validate(value), refusal); }
});

test("refuses FAT, foreign architecture, unsafe versions, malformed bounds, rpaths and unreviewed dependency commands", () => {
  const mutations = [
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]); },
    (v: ReturnType<typeof fixture>) => { v.images[1]!.bytes = build("x64", [], undefined, 6); },
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 8, 1); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 12, 6); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 24, 0x4000000); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 28, 1); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [dylinker()], 0); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [dylinker()], 0x000d0001); },
    (v: ReturnType<typeof fixture>) => { const bytes = v.images[0]!.bytes; u32(bytes, findCommand(bytes, 0x32) + 20, 1); },
    (v: ReturnType<typeof fixture>) => { const bytes = v.images[0]!.bytes; u32(bytes, findCommand(bytes, 0x0e) + 4, 28); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [command(0x8000001c, new Uint8Array(8))]); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [command(0x02, new Uint8Array(0))]); },
    (v: ReturnType<typeof fixture>) => { const bytes = v.images[0]!.bytes; u32(bytes, findCommand(bytes, 0x19) + 4, 0xfffffff8); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [command(0x80000018, new Uint8Array(16))]); },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validate(value), refusal); }
});

test("refuses malformed segment and UUID bounds, overlaps, protections and debug sections", () => {
  const mutations = [
    (bytes: Uint8Array) => u64(bytes, findCommand(bytes, 0x19, 1) + 24, 0x1_0000_0000),
    (bytes: Uint8Array) => u64(bytes, findCommand(bytes, 0x19, 1) + 40, 0),
    (bytes: Uint8Array) => u64(bytes, findCommand(bytes, 0x19, 1) + 48, 0x200),
    (bytes: Uint8Array) => u32(bytes, findCommand(bytes, 0x19) + 56, 3),
    (bytes: Uint8Array) => u64(bytes, findCommand(bytes, 0x19) + 112, 0x4000),
    (bytes: Uint8Array) => u32(bytes, findCommand(bytes, 0x19) + 136, 0x82000400),
    (bytes: Uint8Array) => bytes.fill(0, findCommand(bytes, 0x1b) + 8, findCommand(bytes, 0x1b) + 24),
    (bytes: Uint8Array) => u32(bytes, findCommand(bytes, 0x1b) + 4, 16),
  ];
  for (const mutate of mutations) {
    const value = fixture(), bytes = value.images[0]!.bytes; mutate(bytes);
    assert.throws(() => validate(value), refusal);
  }
  const duplicate = fixture();
  appendCommand(duplicate.images[0]!.bytes, uuid());
  assert.throws(() => validate(duplicate), refusal);
  const armMisaligned = fixture();
  u64(armMisaligned.images[0]!.bytes, findCommand(armMisaligned.images[0]!.bytes, 0x19) + 24, 0x1_0000_1000);
  assert.throws(() => validate(armMisaligned), refusal);
});

test("accepts only terminal zero-fill sections outside the file-backed segment range", () => {
  const accepted = fixture();
  accepted.images[0]!.bytes = build("arm64", [dylinker(), dylib("@loader_path/../lib/libhermes.dylib")], undefined, 2, "trailing_bss");
  accepted.images[1]!.bytes = build("arm64", [dylib("@loader_path/libhermes.dylib", 0x0d)], undefined, 6, "trailing_bss");
  assert.equal(validate(accepted).imagePaths.length, 2);

  for (const layout of ["backed_bss", "bss_before_regular"] as const) {
    const value = fixture();
    value.images[0]!.bytes = build("arm64", [dylinker(), dylib("@loader_path/../lib/libhermes.dylib")], undefined, 2, layout);
    assert.throws(() => validate(value), refusal);
  }
  const overlapping = fixture();
  overlapping.images[0]!.bytes = build("arm64", [dylinker(), dylib("@loader_path/../lib/libhermes.dylib")], undefined, 2, "trailing_bss");
  const data = findCommand(overlapping.images[0]!.bytes, 0x19, 1);
  u64(overlapping.images[0]!.bytes, data + 184, 0x1_0000_4080);
  assert.throws(() => validate(overlapping), refusal);
});

test("refuses a missing or duplicated executable dylinker and hostile caller data without calling accessors", () => {
  for (const change of [
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", []); },
    (v: ReturnType<typeof fixture>) => { v.images[1]!.bytes = build("arm64", [dylinker()], undefined, 6); },
    (v: ReturnType<typeof fixture>) => { v.images.push({ ...v.images[1]! }); },
    (v: ReturnType<typeof fixture>) => { v.executablePath = "bin/other"; },
  ]) { const value = fixture(); change(value); assert.throws(() => validate(value), refusal); }
  let calls = 0; const hostile = fixture() as unknown as Record<string, unknown>;
  Object.defineProperty(hostile, "architecture", { enumerable: true, get() { calls += 1; return "arm64"; } });
  assert.throws(() => validate(hostile), refusal); assert.equal(calls, 0);
  const symbolic = fixture(); Object.defineProperty(symbolic.images, Symbol("hidden"), { value: true });
  assert.throws(() => validate(symbolic), refusal);
});
