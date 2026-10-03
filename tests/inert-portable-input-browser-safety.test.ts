import assert from "node:assert/strict";
import test from "node:test";
import { assertPortableInputSizeV1 } from "../src/security/inert-portable-input";

/**
 * R4U-01: `assertPortableInputSizeV1` is reachable from the browser bundle
 * (module manifest validation runs at import time in the client graph). A
 * real browser has no `Buffer` global, so a Node-only byte-length check
 * crashes every signed-in page with `ReferenceError: Buffer is not defined`.
 * This simulates that absence instead of relying on a built bundle.
 */
test("portable input size check works without a Node Buffer global (browser-safe)", () => {
  const realBuffer = (globalThis as Record<string, unknown>).Buffer;
  delete (globalThis as Record<string, unknown>).Buffer;
  try {
    assert.doesNotThrow(() => assertPortableInputSizeV1("prefix", { a: "b" }, 1_000));
    assert.throws(() => assertPortableInputSizeV1("prefix", { a: "b".repeat(2_000) }, 10), /prefix_input_oversized/);
  } finally {
    (globalThis as Record<string, unknown>).Buffer = realBuffer;
  }
});

test("portable input size check still measures UTF-8 bytes, not UTF-16 code units", () => {
  // "Buffer-free" is not "ASCII-only": multi-byte characters must still count
  // by their real UTF-8 size (e.g. an emoji is 4 bytes but 2 UTF-16 units).
  const value = { text: "🙂".repeat(10) };
  assert.throws(() => assertPortableInputSizeV1("prefix", value, 39), /prefix_input_oversized/);
  assert.doesNotThrow(() => assertPortableInputSizeV1("prefix", value, 100));
});
