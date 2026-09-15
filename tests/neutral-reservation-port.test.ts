import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryNeutralReservationPort,
  type NeutralReservationRowV1 } from "../src/artifacts/v1/neutral-reservation-port";
import type { DatabaseSession } from "../src/persistence/database";

// The session is opaque to the port; the memory implementation ignores it.
// A recording stub proves the port never issues storage calls through it.
const inertSession: DatabaseSession = { query: async () => { throw new Error("port must not query"); } };

function row(overrides: Partial<NeutralReservationRowV1> = {}): NeutralReservationRowV1 {
  return {
    tenant_id: "tenant:test", project_id: "project:test", job_id: "job:test",
    attempt_id: "attempt:test", run_id: "run:test", artifact_id: "artifact:result:aa",
    identity_digest: "sha256:aa", state: "reserved", contract_digest: "sha256:cc",
    reservation: { marker: true }, auth_tag: "hmac-sha256:aa",
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

test("missing record reads null", async () => {
  const port = createInMemoryNeutralReservationPort();
  assert.equal(await port.findForUpdate(inertSession, "tenant:test", "run:nope"), null);
});

test("fresh insert wins once; the second insert on the same run conflicts", async () => {
  const port = createInMemoryNeutralReservationPort();
  assert.equal(await port.insertFresh(inertSession, row()), "inserted");
  assert.equal(await port.insertFresh(inertSession, row()), "conflict");
  const found = await port.findForUpdate(inertSession, "tenant:test", "run:test");
  assert.equal(found?.state, "reserved");
});

test("a second run reusing the same artifact conflicts on the artifact key", async () => {
  const port = createInMemoryNeutralReservationPort();
  assert.equal(await port.insertFresh(inertSession, row()), "inserted");
  assert.equal(await port.insertFresh(inertSession, row({ run_id: "run:other" })), "conflict");
  assert.equal(await port.findForUpdate(inertSession, "tenant:test", "run:other"), null);
});

test("compareAndSwap applies on matching prior and preserves created_at", async () => {
  const port = createInMemoryNeutralReservationPort();
  await port.insertFresh(inertSession, row());
  const swapped = await port.compareAndSwap(inertSession,
    { tenantId: "tenant:test", runId: "run:test", state: "reserved", contractDigest: "sha256:cc" },
    { ...row(), state: "bytes_verified", updated_at: "2026-09-14T00:00:01.000Z" });
  assert.equal(swapped, true);
  const found = await port.findForUpdate(inertSession, "tenant:test", "run:test");
  assert.equal(found?.state, "bytes_verified");
  assert.equal(found?.created_at, "2026-09-14T00:00:00.000Z");
  assert.equal(found?.updated_at, "2026-09-14T00:00:01.000Z");
});

test("compareAndSwap on stale prior changes nothing", async () => {
  const port = createInMemoryNeutralReservationPort();
  await port.insertFresh(inertSession, row());
  const swapped = await port.compareAndSwap(inertSession,
    { tenantId: "tenant:test", runId: "run:test", state: "bytes_verified", contractDigest: "sha256:cc" },
    { ...row(), state: "metadata_committed" });
  assert.equal(swapped, false);
  const found = await port.findForUpdate(inertSession, "tenant:test", "run:test");
  assert.equal(found?.state, "reserved");
});

test("concurrent inserts elect exactly one winner", async () => {
  const port = createInMemoryNeutralReservationPort();
  const outcomes = await Promise.all([
    port.insertFresh(inertSession, row()),
    port.insertFresh(inertSession, row()),
    port.insertFresh(inertSession, row()),
  ]);
  assert.deepEqual(outcomes.sort(), ["conflict", "conflict", "inserted"]);
});

test("reads return copies; callers cannot mutate the store", async () => {
  const port = createInMemoryNeutralReservationPort();
  await port.insertFresh(inertSession, row());
  const found = await port.findForUpdate(inertSession, "tenant:test", "run:test");
  found!.state = "metadata_committed";
  const reread = await port.findForUpdate(inertSession, "tenant:test", "run:test");
  assert.equal(reread?.state, "reserved");
});
