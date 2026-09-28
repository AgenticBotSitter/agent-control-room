import assert from "node:assert/strict";
import test from "node:test";
import { createConditionalByteAccounting } from "../scripts/multi-client/conditional-byte-accounting.mjs";

test("avoided bytes sum each 304's endpoint-matched 200 representation", () => {
  const accounting = createConditionalByteAccounting();
  accounting.record({ resource: "/small", status: 200, bytes: 11, etag: '"shared"' });
  accounting.record({ resource: "/large", status: 200, bytes: 101, etag: '"shared"' });
  accounting.record({ resource: "/unrelated", status: 200, bytes: 10_000, etag: '"other"' });

  accounting.record({ resource: "/small", status: 304, bytes: 0, conditional: '"shared"' });
  accounting.record({ resource: "/large", status: 304, bytes: 0, conditional: '"shared"' });
  accounting.record({ resource: "/large", status: 304, bytes: 0, conditional: '"shared"' });

  assert.equal(accounting.avoidedBytes(), 213,
    "the total is 11 + 101 + 101, not a global average of heterogeneous 200 responses");
});

test("a 304 without its exact known resource and validator cannot be reported as measured", () => {
  const accounting = createConditionalByteAccounting();
  accounting.record({ resource: "/known", status: 200, bytes: 25, etag: '"v1"' });

  assert.throws(
    () => accounting.record({ resource: "/other", status: 304, bytes: 0, conditional: '"v1"' }),
    /multi_client_304_without_known_representation/,
  );
});
