import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONTRACT_VERSION,
  assertSafeProjection,
  projectSummarySchema,
  workerSchema,
} from "../src/contracts/v1/index.ts";
import { fixturePacks, projects, workers } from "../src/fixtures/data.ts";

test("fixture packs conform to the founding contract", () => {
  for (const pack of fixturePacks) {
    assert.equal(pack.manifest.contractVersion, CONTRACT_VERSION);
    assert.ok(pack.manifest.supportedReadOperations.includes("readChanges"));
    pack.projects.forEach((project) => projectSummarySchema.parse(project));
    pack.workers.forEach((worker) => workerSchema.parse(worker));
    assertSafeProjection(pack);
  }
});

test("fixtures prove all three scheduler authority modes", () => {
  assert.deepEqual(
    new Set(projects.map((project) => project.authorityMode)),
    new Set(["control_room_native", "source_scheduled", "advisory"]),
  );
});

test("machines, worker runtimes, and agent identities stay distinct", () => {
  for (const worker of workers) {
    assert.notEqual(worker.id, worker.machineId);
    assert.notEqual(worker.id, worker.runtimeId);
    assert.notEqual(worker.machineId, worker.runtimeId);
  }
});

test("redaction guard rejects private bodies, signed links, and secrets", () => {
  assert.throws(() => assertSafeProjection({ transcriptText: "private words" }), /Forbidden projection field/);
  assert.throws(() => assertSafeProjection({ draftBody: "private draft" }), /Forbidden projection field/);
  assert.throws(() => assertSafeProjection({ link: "https://example.invalid/file?X-Amz-Signature=abc" }), /Unsafe projection value/);
  assert.throws(() => assertSafeProjection({ detail: "api_key=not-safe" }), /Unsafe projection value/);
});

test("safe projection retains forbidden fields under post-import traversal substitution", () => {
  const entriesDescriptor = Object.getOwnPropertyDescriptor(Object, "entries"),
    arrayDescriptor = Object.getOwnPropertyDescriptor(Array, "isArray"),
    forEachDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "forEach"),
    someDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "some"),
    testDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "test"),
    symbolReplaceDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, Symbol.replace),
    lowerDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "toLowerCase"),
    replaceDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "replace"),
    includesDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "includes"),
    applyDescriptor = Object.getOwnPropertyDescriptor(Reflect, "apply"),
    errorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Error");
  assert.ok(entriesDescriptor); assert.ok(arrayDescriptor); assert.ok(forEachDescriptor); assert.ok(someDescriptor);
  assert.ok(testDescriptor); assert.ok(symbolReplaceDescriptor); assert.ok(lowerDescriptor); assert.ok(replaceDescriptor);
  assert.ok(includesDescriptor);
  assert.ok(applyDescriptor); assert.ok(errorDescriptor);
  const sentinel = new Error("hostile projection walker"), hostile = () => { throw sentinel; };
  class HostileError { constructor() { throw sentinel; } }
  let rejected: unknown;
  Object.defineProperty(Object, "entries", { ...entriesDescriptor, value: hostile });
  Object.defineProperty(Array, "isArray", { ...arrayDescriptor, value: hostile });
  Object.defineProperty(Array.prototype, "forEach", { ...forEachDescriptor, value: hostile });
  Object.defineProperty(Array.prototype, "some", { ...someDescriptor, value: hostile });
  Object.defineProperty(RegExp.prototype, "test", { ...testDescriptor, value: hostile });
  Object.defineProperty(RegExp.prototype, Symbol.replace, { ...symbolReplaceDescriptor, value: hostile });
  Object.defineProperty(String.prototype, "toLowerCase", { ...lowerDescriptor, value: hostile });
  Object.defineProperty(String.prototype, "replace", { ...replaceDescriptor, value: hostile });
  Object.defineProperty(String.prototype, "includes", { ...includesDescriptor, value: hostile });
  Object.defineProperty(Reflect, "apply", { ...applyDescriptor, value: hostile });
  Object.defineProperty(globalThis, "Error", { ...errorDescriptor, value: HostileError });
  try {
    try { assertSafeProjection({ nested: [{ apiKey: "unsafe-value-123" }] }); }
    catch (error) { rejected = error; }
  } finally {
    Object.defineProperty(Object, "entries", entriesDescriptor);
    Object.defineProperty(Array, "isArray", arrayDescriptor);
    Object.defineProperty(Array.prototype, "forEach", forEachDescriptor);
    Object.defineProperty(Array.prototype, "some", someDescriptor);
    Object.defineProperty(RegExp.prototype, "test", testDescriptor);
    Object.defineProperty(RegExp.prototype, Symbol.replace, symbolReplaceDescriptor);
    Object.defineProperty(String.prototype, "toLowerCase", lowerDescriptor);
    Object.defineProperty(String.prototype, "replace", replaceDescriptor);
    Object.defineProperty(String.prototype, "includes", includesDescriptor);
    Object.defineProperty(Reflect, "apply", applyDescriptor);
    Object.defineProperty(globalThis, "Error", errorDescriptor);
  }
  assert.ok(rejected instanceof Error);
  assert.notEqual(rejected, sentinel);
  assert.match(rejected.message, /Forbidden projection field/);
});

test("Content Blooms fixture contains required operational states without content", () => {
  const blooms = fixturePacks.find((pack) => pack.manifest.sourceSystem === "content-blooms")!;
  assert.ok(blooms.workItems.some((item) => item.domainState === "transcription_capacity"));
  assert.ok(blooms.workItems.some((item) => item.domainState === "generating"));
  assert.ok(blooms.workItems.some((item) => item.domainState === "customer_input_required"));
  assert.ok(blooms.workItems.some((item) => item.domainState === "awaiting_operator_review"));
  assertSafeProjection(blooms);
});

test("machine-readable CR-0 schemas are versioned and parseable", async () => {
  const adapter = JSON.parse(await readFile(new URL("../contracts/project-adapter-v1.schema.json", import.meta.url), "utf8"));
  const receipt = JSON.parse(await readFile(new URL("../contracts/command-receipt-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(adapter.$defs.manifest.properties.contractVersion.const, CONTRACT_VERSION);
  assert.equal(receipt.properties.contractVersion.const, CONTRACT_VERSION);
  assert.deepEqual(adapter.$defs.authorityMode.enum, ["control_room_native", "source_scheduled", "advisory"]);
});
