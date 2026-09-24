import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMacosHermesMachODependencyClosureV1 as validate } from
  "../src/installer/v1/macos-hermes-macho-dependency-closure";

const refusal = /^Error: macos_hermes_macho_dependency_closure_refused$/u;
type Command = Readonly<{ type: number; body: Uint8Array }>;
const u32 = (buffer: Uint8Array, at: number, value: number) => buffer.set([value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255], at);
function padded(text: string, prefix: number): Uint8Array {
  const size = Math.ceil((prefix + text.length + 1) / 8) * 8, result = new Uint8Array(size);
  Buffer.from(text).copy(result, prefix); return result;
}
function command(type: number, body: Uint8Array): Command { return { type, body }; }
function build(architecture: "arm64" | "x64", commands: readonly Command[], minimum = 0x000d0000, filetype = 2): Uint8Array {
  const version = new Uint8Array(16); u32(version, 0, 1); u32(version, 4, minimum);
  const all = [command(0x32, version), ...commands], commandBytes = all.reduce((total, item) => total + 8 + item.body.length, 0);
  const bytes = new Uint8Array(32 + commandBytes); u32(bytes, 0, 0xfeedfacf); u32(bytes, 4, architecture === "arm64" ? 0x0100000c : 0x01000007);
  u32(bytes, 12, filetype); u32(bytes, 16, all.length); u32(bytes, 20, commandBytes); let at = 32;
  for (const item of all) { u32(bytes, at, item.type); u32(bytes, at + 4, 8 + item.body.length); bytes.set(item.body, at + 8); at += 8 + item.body.length; }
  return bytes;
}
function dylinker() { const body = padded("/usr/lib/dyld", 4); u32(body, 0, 12); return command(0x0e, body); }
function dylib(name: string, type = 0x0c) { const body = new Uint8Array(16 + padded(name, 0).length); u32(body, 0, 24); body.set(padded(name, 0), 16); return command(type, body); }
function fixture() {
  return { architecture: "arm64" as const, executablePath: "bin/hermes", images: [
    { path: "bin/hermes", kind: "regular_file" as const, bytes: build("arm64", [dylinker(), dylib("/usr/lib/libSystem.B.dylib"), dylib("@loader_path/../lib/libhermes.dylib")]) },
    { path: "lib/libhermes.dylib", kind: "regular_file" as const, bytes: build("arm64", [dylib("@loader_path/libhermes.dylib", 0x0d), dylib("/System/Library/Frameworks/Security.framework/Versions/A/Security")], undefined, 6) },
  ] };
}

test("accepts only a finite supplied thin-arm64 closure and grants no authority", () => {
  const result = validate(fixture());
  assert.deepEqual(result.imagePaths, ["bin/hermes", "lib/libhermes.dylib"]);
  assert.equal(result.imageInventory.length, 2); assert.match(result.closureDigest, /^sha256:[a-f0-9]{64}$/u);
  const changed = fixture(); changed.images[1]!.bytes = build("arm64", [dylib("@loader_path/libhermes.dylib", 0x0d), dylib("/usr/lib/libobjc.A.dylib")], undefined, 6);
  assert.notEqual(validate(changed).closureDigest, result.closureDigest);
  assert.equal(result.macosBaseline, "13.0");
  for (const [key, value] of Object.entries(result)) if (key.startsWith("grants") || key.startsWith("ready")) assert.equal(value, false);
  assert.equal(result.filesystemInspected, false); assert.equal(result.hostPathSearchPerformed, false);
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
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 52, 1); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 60, 28); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [command(0x8000001c, new Uint8Array(8))]); },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [command(0x02, new Uint8Array(0))]); },
    (v: ReturnType<typeof fixture>) => { const bytes = build("arm64", [dylinker()]); u32(bytes, 36, 0xfffffff8); v.images[0]!.bytes = bytes; },
    (v: ReturnType<typeof fixture>) => { v.images[0]!.bytes = build("arm64", [command(0x80000018, new Uint8Array(16))]); },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validate(value), refusal); }
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
  const symbolic = fixture(); symbolic.images[Symbol("hidden")] = true as never;
  assert.throws(() => validate(symbolic), refusal);
});
