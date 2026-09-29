import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeMacLocalFirstOwnerV1 } from "../scripts/mac-local/complete-first-owner.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store.ts";
import { sha256Digest } from "../src/security/index.ts";

const reviewKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const config = {
  localOwnerSession: { tenantId: "tenant:one", provider: "local", subject: "owner" }, workspaceId: "workspace:one",
  enablement: { nodeId: "mac-1", workers: [
    { kind: "hermes", workerId: "worker:hermes" },
    { kind: "claude-code", workerId: "worker:claude" },
    { kind: "codex", workerId: "worker:codex" },
  ] },
};

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "acr-first-owner-finish-"));
  await mkdir(join(root, "config"), { mode: 0o700 });
  const genesis = CompletionGateStoreV1.genesisIntegrityForKeyV1("tenant:one", reviewKey);
  const manifest = createMacLocalFirstOwnerManifestV1(config, "2026-09-25T00:00:00.000Z", genesis);
  await writeFile(join(root, "config", "first-owner-manifest.json"), JSON.stringify(overrides.manifest ?? manifest), { mode: 0o600 });
  const receipt = { schema: "control-room.mac-local-first-owner-receipt/v1", tenantId: "tenant:one",
    manifestDigest: overrides.digest ?? sha256Digest(manifest), created: 14, kept: 0,
    fingerprints: Object.fromEntries(manifest.nodes.map(node => [node.nodeId, sha256Digest(node.nodeId)])) };
  let pinned = 0, dbOpened = 0, checkpointOpened = 0;
  const db = { client: { transaction: async work => work({ query: async query => {
    if (query.includes("control_completion_gate_integrity")) return { rows: [{ tenant_id: "tenant:one", revision: 1,
      record_count: 0, state_digest: genesis.stateDigest, state_auth_tag: genesis.stateAuthTag }] };
    if (query.includes("control_completion_gate_records")) return { rows: [{ count: "0" }] };
    throw new Error(`unexpected query: ${query}`);
  } }) }, close: async () => {} };
  let checkpoint;
  const checkpoints = { read: async () => checkpoint, initialize: async value => { checkpoint = value; }, advance: async () => {}, close: async () => {} };
  const runtime = { loadConfiguration: async () => config, readReceipt: async () => receipt,
    loadTaskRuntime: async () => ({ keys: { review: reviewKey } }), pinNodeKeys: async () => { pinned++; },
    loadRoles: async () => ({ coordinator: {} }), openDatabase: () => { dbOpened++; return db; },
    openCheckpoints: async () => { checkpointOpened++; return checkpoints; } };
  return { root, runtime, receipt, counts: () => ({ pinned, dbOpened, checkpointOpened }), manifest };
}

test("manifest digest is checked before any key pin or database access", async () => {
  const { root, runtime, counts } = await fixture({ digest: sha256Digest("wrong") });
  await assert.rejects(completeMacLocalFirstOwnerV1(root, join(root, "receipt.json"), runtime), /completion_refused/);
  assert.deepEqual(counts(), { pinned: 0, dbOpened: 0, checkpointOpened: 0 });
});

test("wrong genesis authentication tag is refused before key pin", async () => {
  const { root, runtime, receipt, counts } = await fixture();
  const path = join(root, "config", "first-owner-manifest.json");
  const { readFile } = await import("node:fs/promises");
  const value = JSON.parse(await readFile(path, "utf8"));
  value.completionGateGenesis.stateAuthTag = `hmac-sha256:${"0".repeat(64)}`;
  await writeFile(path, JSON.stringify(value));
  runtime.readReceipt = async () => ({ ...receipt, manifestDigest: sha256Digest(value) });
  await assert.rejects(completeMacLocalFirstOwnerV1(root, join(root, "receipt.json"), runtime), /completion_refused/);
  assert.deepEqual(counts(), { pinned: 0, dbOpened: 0, checkpointOpened: 0 });
});

test("committed genesis completes once and repeat keeps the same checkpoint", async () => {
  const { root, runtime, counts } = await fixture();
  const first = await completeMacLocalFirstOwnerV1(root, join(root, "receipt.json"), runtime);
  const second = await completeMacLocalFirstOwnerV1(root, join(root, "receipt.json"), runtime);
  assert.equal(first, "created");
  assert.equal(second, "already_present");
  assert.deepEqual(counts(), { pinned: 2, dbOpened: 2, checkpointOpened: 2 });
});
