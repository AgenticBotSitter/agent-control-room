// The fleet gateway's proposal route must answer with the SAME named refusal
// codes it uses for every other route, instead of letting the intake service's
// own safe codes escape as an untyped 400 that the gateway's own operator log
// records as a server fault.
//
// This is a fast, database-free test of the translation itself: the intake
// service is replaced by one that throws each designed refusal in turn, and the
// handler's response is inspected. The end-to-end proof that these refusals are
// the ones a real bot meets is tests/bot-dogfood-postgres.test.ts; this file
// exists so a regression is caught in seconds rather than after a cluster
// build, and so the guard is mutation-checkable in isolation.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createFleetGatewayHandlerV1 } from "../src/fleet/v1";
import type { FleetGatewayStoreV1 } from "../src/fleet/v1";
import { WorkIntakeErrorV1, type WorkIntakeSafeCodeV1 } from "../src/work-intake/v1/errors";
import type { WorkBatchServiceV1 } from "../src/work-intake/v1/service";
import { RELEASE_TRUST_SCHEMA_V1, releaseKeyIdV1 } from "../scripts/release-signing.mjs";

const releasePublicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const RELEASE_TRUST = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
  keyId: releaseKeyIdV1(releasePublicKey), publicKey: releasePublicKey, versionFloor: "0.0.0", revokedKeyIds: [] });

const principal = Object.freeze({ tenantId: "tenant:unit", workerId: "fleet-worker:" + "1".repeat(32),
  nodeId: "node:unit", identityId: "identity:unit", workerKind: "mcp-agent", displayName: "unit",
  projectIds: Object.freeze(["project:unit"]), capabilities: Object.freeze(["code.change"]), maxConcurrent: 1,
  credentialId: "fleet-credential:" + "2".repeat(32), credentialExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });

/** A store that authenticates one worker and does nothing else. */
function stubStore(): FleetGatewayStoreV1 {
  return {
    authenticate: async () => principal,
    me: () => ({}),
    listWork: async () => [],
    myClaims: async () => [],
    recordMcpCall: async () => ({}),
    heartbeat: async () => ({}),
    rotate: async () => ({}),
    claim: async () => ({}),
    progress: async () => ({}),
    blocker: async () => ({}),
    submitResult: async () => ({}),
    reconcile: async () => ({}),
  } as unknown as FleetGatewayStoreV1;
}

const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;

async function proposeWith(code: WorkIntakeSafeCodeV1 | null) {
  const faults: unknown[] = [];
  const proposals = {
    submit: async () => {
      if (code) throw new WorkIntakeErrorV1(code);
      return { schema: "control-room.work-batch-receipt/v1", batchId: "batch:unit", projectId: "project:unit",
        state: "proposed", proposalDigest: `sha256:${"a".repeat(64)}`, revision: 1, replayed: false,
        startsWork: false, grantsExecutionAuthority: false };
    },
  } as unknown as WorkBatchServiceV1;
  const handler = createFleetGatewayHandlerV1({ store: stubStore(), proposals, releaseTrust: RELEASE_TRUST,
    onUnexpectedError: error => { faults.push(error); } });
  const server = createServer((request, response) => { void handler.handle(request, response); });
  await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${portOf(server)}/fleet/v1/projects/project%3Aunit/proposals`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer crw_${"a".repeat(43)}`,
        "x-control-room-worker": principal.workerId },
      body: JSON.stringify({ idempotencyKey: "unit-propose-0001", proposal: {} }) });
    return { status: response.status, body: await response.json() as { error?: string; ok?: boolean }, faults };
  } finally { await close(server); }
}

test("an intake refusal reaches a bot as a named fleet refusal, never as an untyped 400", async () => {
  // Every designed client refusal, with the fleet code a bot can act on.
  const expected: ReadonlyArray<readonly [WorkIntakeSafeCodeV1, string, number]> = [
    ["credential_inactive", "forbidden", 403],
    ["no_matching_grant", "forbidden", 403],
    ["replay_conflict", "conflict", 409],
    ["batch_not_found", "not_found", 404],
    ["invalid_input", "invalid", 400],
  ];
  for (const [safeCode, code, status] of expected) {
    const result = await proposeWith(safeCode);
    assert.equal(result.body.error, code, `${safeCode} must reach the bot as ${code}`);
    assert.equal(result.status, status, `${safeCode} must use the fleet status for ${code}`);
    assert.deepEqual(result.faults, [],
      `${safeCode} is a client refusal and must not reach the operator log`);
  }
});

test("an integrity failure is NOT a client refusal and still reaches the operator log", async () => {
  // Deliberately unmapped on purpose: a failed integrity check is never the
  // caller's fault, so it must not be dressed up as one. It stays an untyped
  // refusal AND is reported, so a real fault is visible.
  const result = await proposeWith("integrity_failed");
  assert.equal(result.body.error, "refused", "no client code is invented for an integrity failure");
  assert.equal(result.faults.length, 1, "an integrity failure reaches the operator log");
});

test("a proposal that succeeds is a 202 with the intake service's own receipt", async () => {
  const result = await proposeWith(null);
  assert.equal(result.status, 202);
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.faults, []);
});

test("a validation refusal (not an exception) is still a 422, unchanged", async () => {
  // `submit` can also answer `{ accepted: false }` for a proposal the intake
  // validator refused. That path must keep its own status.
  const handler = createFleetGatewayHandlerV1({ store: stubStore(), releaseTrust: RELEASE_TRUST, proposals: { submit: async () => ({
    accepted: false, safeReasonCode: "proposal_schema_mismatch", startsWork: false,
    grantsExecutionAuthority: false }) } as unknown as WorkBatchServiceV1, onUnexpectedError: () => {} });
  const server = createServer((request, response) => { void handler.handle(request, response); });
  await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${portOf(server)}/fleet/v1/projects/project%3Aunit/proposals`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer crw_${"a".repeat(43)}`,
        "x-control-room-worker": principal.workerId },
      body: JSON.stringify({ idempotencyKey: "unit-propose-0002", proposal: {} }) });
    assert.equal(response.status, 422);
  } finally { await close(server); }
});
