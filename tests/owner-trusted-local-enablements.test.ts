import assert from "node:assert/strict";
import test from "node:test";
import { captureOwnerTrustedLocalEnablementV1, ownerTrustedLocalEnablementDigestV1,
  OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, verifyOwnerTrustedLocalEnablementV1 } from "../src/harness/v1/owner-trusted-local-enablements";

const valid = Object.freeze({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local" as const, nodeId: "mac-1" as const,
  workers: [{ workerId: "worker:codex", kind: "codex" as const, executablePath: "/Applications/Codex.app/Contents/MacOS/codex", recordedVersion: "codex 0.155.0" },
    { workerId: "worker:marvin", kind: "hermes-021" as const, executablePath: "/usr/local/bin/hermes", recordedVersion: "hermes 0.21.3" }] });

test("captures one bounded mac-local worker record without granting execution", () => {
  const captured = captureOwnerTrustedLocalEnablementV1(valid);
  assert.equal(captured.nodeId, "mac-1"); assert.equal(captured.workers.length, 2);
  assert.match(captured.enablementDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(ownerTrustedLocalEnablementDigestV1(captured), captured.enablementDigest);
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.workers));
});

test("refuses paths, unknown fields, duplicate workers, and non-Mac node records", () => {
  for (const changed of [
    { ...valid, nodeId: "node:other" },
    { ...valid, extra: true },
    { ...valid, workers: [{ ...valid.workers[0], executablePath: "relative" }] },
    { ...valid, workers: [{ ...valid.workers[0] }, { ...valid.workers[0], kind: "claude-code" }] },
    { ...valid, workers: [{ ...valid.workers[0], recordedVersion: "version\nvalue" }] },
  ]) assert.throws(() => captureOwnerTrustedLocalEnablementV1(changed));
});

test("a missing or version-drifted executable leaves only that worker unavailable", async () => {
  const drifted = await verifyOwnerTrustedLocalEnablementV1(valid, async path => path.includes("Codex") ? "codex 0.155.0" : "hermes 0.21.2");
  assert.deepEqual(drifted, { nodeId: "mac-1", enabledWorkerIds: ["worker:codex"], unavailableWorkerIds: ["worker:marvin"] });
  const missing = await verifyOwnerTrustedLocalEnablementV1(valid, async path => { if (path.includes("hermes")) throw new Error("not found"); return "codex 0.155.0"; });
  assert.deepEqual(missing.unavailableWorkerIds, ["worker:marvin"]);
  await assert.rejects(verifyOwnerTrustedLocalEnablementV1(valid, async () => { throw new Error("not found"); }));
  const checked = await verifyOwnerTrustedLocalEnablementV1({ ...valid, workers: [valid.workers[0]] }, async () => "codex 0.155.0");
  assert.deepEqual(checked, { nodeId: "mac-1", enabledWorkerIds: ["worker:codex"], unavailableWorkerIds: [] });
});
