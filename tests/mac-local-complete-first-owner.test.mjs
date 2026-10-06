import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeMacLocalFirstOwnerV1 } from "../scripts/mac-local/complete-first-owner.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store.ts";
import { publicKeyFingerprint } from "../src/node-protocol/v1/index.ts";
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

const diskConfiguration = {
  schema: "control-room.mac-local-protected-configuration/v1", port: 3210, workspaceId: "workspace:one",
  localOwnerSession: { schema: "control-room.local-owner-session/v1", origin: "http://127.0.0.1:3210",
    tenantId: "tenant:one", provider: "local", subject: "owner",
    ownerCodeDigest: sha256Digest({ ownerCode: "fixture owner code with sufficient length" }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web",
    password: "fixture-password", majorVersion: 17 },
  enablement: { schema: "control-room.owner-trusted-local-enablement/v1", mode: "mac-local", nodeId: "mac-1", workers: [
    { kind: "hermes", workerId: "worker:hermes", executablePath: "/opt/control-room-test/hermes", recordedVersion: "fixture" },
    { kind: "claude-code", workerId: "worker:claude", executablePath: "/opt/control-room-test/claude", recordedVersion: "fixture" },
    { kind: "codex", workerId: "worker:codex", executablePath: "/opt/control-room-test/codex", recordedVersion: "fixture" },
  ] }, workIntakeProjectIds: [],
};

const taskRuntimeBody = key => ({ schema: "control-room.mac-local-task-runtime/v1", keys: {
  planning: Buffer.alloc(32, 1).toString("base64url"), review: Buffer.from(key).toString("base64url"),
  harness: Buffer.alloc(32, 3).toString("base64url"), results: Buffer.alloc(32, 4).toString("base64url"),
  approvals: Buffer.alloc(32, 5).toString("base64url"), deliveryReceipt: Buffer.alloc(32, 6).toString("base64url"),
}, hermes: { profile: "fixture", provider: "fixture", model: "fixture", destination: "https://models.example.invalid:443" } });

const databaseRole = username => ({ ...diskConfiguration.database, username });

async function realProtectedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-first-owner-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700); await mkdir(join(root, "config"), { mode: 0o700 });
  const roles = { schema: "control-room.mac-local-database-roles/v1",
    web: databaseRole("control_room_web"), coordinator: databaseRole("control_room_coordinator"),
    results: databaseRole("control_room_results"), publisher: databaseRole("control_room_publisher"),
    agentReviewer: databaseRole("control_room_agent_reviewer"), queueWorker: databaseRole("control_room_queue_worker") };
  await writeFile(join(root, "config/mac-local.json"), `${JSON.stringify(diskConfiguration)}\n`, { mode: 0o600 });
  await writeFile(join(root, "config/database-roles.json"), `${JSON.stringify(roles)}\n`, { mode: 0o600 });
  await writeFile(join(root, "config/task-runtime.json"), `${JSON.stringify(taskRuntimeBody(reviewKey))}\n`, { mode: 0o600 });
  const genesis = CompletionGateStoreV1.genesisIntegrityForKeyV1("tenant:one", reviewKey);
  const manifest = createMacLocalFirstOwnerManifestV1(diskConfiguration, "2026-09-25T00:00:00.000Z", genesis);
  await writeFile(join(root, "config/first-owner-manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const nodes = manifest.nodes.map(node => {
    const pair = generateKeyPairSync("ed25519");
    const public_key_spki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    return { node_id: node.nodeId, id: `local-owner:${node.nodeId}`, tenant_id: "tenant:one", state: "active",
      algorithm: "ed25519", valid_until: null, public_key_spki, fingerprint: publicKeyFingerprint(public_key_spki) };
  });
  const fingerprints = Object.fromEntries(nodes.map(node => [node.node_id, node.fingerprint]));
  const receipt = { schema: "control-room.mac-local-first-owner-receipt/v1", tenantId: "tenant:one",
    manifestDigest: sha256Digest(manifest), created: 14, kept: 0, fingerprints };
  const receiptPath = join(root, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o644 });
  return { root, receiptPath, manifest, receipt, nodes };
}

function pinDatabase(fixture) {
  return { client: { query: async sql => {
    if (sql.startsWith("SELECT current_user")) return { rows: [{ role_ok: true }] };
    if (sql.includes("node_id,id,tenant_id")) return { rows: fixture.nodes };
    if (sql.includes("SELECT node_id,fingerprint")) return { rows: fixture.nodes };
    throw new Error(`unexpected pin query: ${sql}`);
  } }, close: async () => {} };
}

function laterCompletionEffects(counters = { pinned: 0, dbOpened: 0 }) {
  let checkpoint;
  const database = { client: { transaction: async work => work({ query: async query => {
    if (query.includes("control_completion_gate_integrity")) return { rows: [{ tenant_id: "tenant:one", revision: 1,
      record_count: 0, state_digest: CompletionGateStoreV1.genesisIntegrityForKeyV1("tenant:one", reviewKey).stateDigest,
      state_auth_tag: CompletionGateStoreV1.genesisIntegrityForKeyV1("tenant:one", reviewKey).stateAuthTag }] };
    if (query.includes("control_completion_gate_records")) return { rows: [{ count: "0" }] };
    throw new Error(`unexpected completion query: ${query}`);
  } }) }, close: async () => {} };
  const checkpoints = { read: async () => checkpoint, initialize: async value => { checkpoint = value; },
    advance: async () => {}, close: async () => {} };
  return { counters, runtime: {
    pinNodeKeys: async () => { counters.pinned += 1; },
    loadRoles: async () => ({ coordinator: {} }), openDatabase: () => { counters.dbOpened += 1; return database; },
    openCheckpoints: async () => checkpoints,
  } };
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "acr-first-owner-finish-"));
  await mkdir(join(root, "config"), { mode: 0o700 });
  const genesis = CompletionGateStoreV1.genesisIntegrityForKeyV1("tenant:one", reviewKey);
  const configuration = { ...config, workIntakeProjectIds: overrides.workIntakeProjectIds ?? [] };
  const manifest = createMacLocalFirstOwnerManifestV1(configuration, "2026-09-25T00:00:00.000Z", genesis);
  await writeFile(join(root, "config", "first-owner-manifest.json"), JSON.stringify(overrides.manifest ?? manifest), { mode: 0o600 });
  const receipt = { schema: "control-room.mac-local-first-owner-receipt/v1", tenantId: "tenant:one",
    manifestDigest: overrides.digest ?? sha256Digest(manifest),
    created: 14 + (configuration.workIntakeProjectIds.length > 0 ? 7 : 0), kept: 0,
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
  const runtime = { loadConfiguration: async () => configuration, readReceipt: async () => receipt,
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

test("intake tenant binding is included in the completion receipt row count", async () => {
  const { root, runtime, receipt } = await fixture({ workIntakeProjectIds: ["*"] });
  let expectedRows;
  runtime.readReceipt = async (_path, _nodeIds, expected) => { expectedRows = expected; return receipt; };
  assert.equal(await completeMacLocalFirstOwnerV1(root, join(root, "receipt.json"), runtime), "created");
  assert.equal(expectedRows, 21);
});

test("item 2: the default pin command writes one private exact pin and refuses a symlink target", async t => {
  const item = await realProtectedFixture(t), effects = laterCompletionEffects();
  const { pinNodeKeys: _stub, ...later } = effects.runtime;
  const runtime = { ...later, pinNodeKeysRuntime: { openDatabase: () => pinDatabase(item) } };
  assert.equal(await completeMacLocalFirstOwnerV1(item.root, item.receiptPath, runtime), "created");
  const pinPath = join(item.root, "config/node-keys.json"), entry = await lstat(pinPath);
  assert.equal(entry.isFile(), true); assert.equal(entry.isSymbolicLink(), false); assert.equal(entry.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(pinPath, "utf8")), {
    schema: "control-room.mac-local-node-keys/v1", fingerprints: item.receipt.fingerprints,
  });

  const target = join(item.root, "node-keys-target.json");
  await writeFile(target, await readFile(pinPath), { mode: 0o600 }); await rm(pinPath); await symlink(target, pinPath);
  const refused = laterCompletionEffects();
  const { pinNodeKeys: _unused, ...afterPin } = refused.runtime;
  await assert.rejects(completeMacLocalFirstOwnerV1(item.root, item.receiptPath,
    { ...afterPin, pinNodeKeysRuntime: { openDatabase: () => pinDatabase(item) } }), /mac_local_node_key_pin_mismatch/u);
  assert.equal(refused.counters.dbOpened, 0, "the completion database stays unopened when real pin custody refuses");
});

test("item 2 stress: twenty concurrent default pin callers converge on the same exact file", async t => {
  const item = await realProtectedFixture(t);
  const calls = Array.from({ length: 20 }, () => {
    const effects = laterCompletionEffects(), { pinNodeKeys: _stub, ...later } = effects.runtime;
    return completeMacLocalFirstOwnerV1(item.root, item.receiptPath,
      { ...later, pinNodeKeysRuntime: { openDatabase: () => pinDatabase(item) } });
  });
  const results = await Promise.allSettled(calls);
  assert.deepEqual(results.filter(result => result.status === "rejected"), []);
  assert.ok(results.every(result => result.status === "fulfilled" && result.value === "created"));
  assert.deepEqual(JSON.parse(await readFile(join(item.root, "config/node-keys.json"), "utf8")).fingerprints,
    item.receipt.fingerprints);
});

test("item 6: first-owner completion uses the protected configuration default and refuses a linked file first", async t => {
  const item = await realProtectedFixture(t), effects = laterCompletionEffects();
  let receiptReads = 0;
  const runtime = { ...effects.runtime, readReceipt: async () => { receiptReads += 1; return item.receipt; },
    loadTaskRuntime: async () => ({ keys: { review: reviewKey } }) };
  assert.equal(await completeMacLocalFirstOwnerV1(item.root, item.receiptPath, runtime), "created");
  assert.equal(receiptReads, 1);

  const linked = await realProtectedFixture(t), linkedEffects = laterCompletionEffects(), file = join(linked.root, "config/mac-local.json");
  const target = join(linked.root, "mac-local-target.json");
  await writeFile(target, `${JSON.stringify(diskConfiguration)}\n`, { mode: 0o600 }); await rm(file); await symlink(target, file);
  let reachedReceipt = false;
  await assert.rejects(completeMacLocalFirstOwnerV1(linked.root, linked.receiptPath, {
    ...linkedEffects.runtime, readReceipt: async () => { reachedReceipt = true; return linked.receipt; },
    loadTaskRuntime: async () => ({ keys: { review: reviewKey } }),
  }), /mac_local_protected_configuration_root_invalid/u);
  assert.equal(reachedReceipt, false); assert.deepEqual(linkedEffects.counters, { pinned: 0, dbOpened: 0 });
});

test("item 7: first-owner completion reads a real receipt and refuses linked or overlong evidence before pinning", async t => {
  const good = await realProtectedFixture(t), goodEffects = laterCompletionEffects();
  assert.equal(await completeMacLocalFirstOwnerV1(good.root, good.receiptPath, {
    ...goodEffects.runtime, loadConfiguration: async () => diskConfiguration,
    loadTaskRuntime: async () => ({ keys: { review: reviewKey } }),
  }), "created");
  assert.equal(goodEffects.counters.pinned, 1);

  const linked = await realProtectedFixture(t), target = join(linked.root, "receipt-target.json");
  await writeFile(target, `${JSON.stringify(linked.receipt)}\n`, { mode: 0o644 }); await rm(linked.receiptPath); await symlink(target, linked.receiptPath);
  const linkedEffects = laterCompletionEffects();
  await assert.rejects(completeMacLocalFirstOwnerV1(linked.root, linked.receiptPath, {
    ...linkedEffects.runtime, loadConfiguration: async () => diskConfiguration,
    loadTaskRuntime: async () => ({ keys: { review: reviewKey } }),
  }), /mac_local_node_key_receipt_refused/u);
  assert.deepEqual(linkedEffects.counters, { pinned: 0, dbOpened: 0 });

  const oversized = await realProtectedFixture(t), oversizedEffects = laterCompletionEffects();
  await writeFile(oversized.receiptPath, "x".repeat(16 * 1024 + 1));
  await assert.rejects(completeMacLocalFirstOwnerV1(oversized.root, oversized.receiptPath, {
    ...oversizedEffects.runtime, loadConfiguration: async () => diskConfiguration,
    loadTaskRuntime: async () => ({ keys: { review: reviewKey } }),
  }), /mac_local_node_key_receipt_refused/u);
  assert.deepEqual(oversizedEffects.counters, { pinned: 0, dbOpened: 0 });
});

test("item 8: first-owner completion loads the installed task key and refuses alteration or absence before pinning", async t => {
  const good = await realProtectedFixture(t), goodEffects = laterCompletionEffects();
  assert.equal(await completeMacLocalFirstOwnerV1(good.root, good.receiptPath, {
    ...goodEffects.runtime, loadConfiguration: async () => diskConfiguration, readReceipt: async () => good.receipt,
  }), "created");
  assert.equal(goodEffects.counters.pinned, 1);

  const altered = await realProtectedFixture(t), alteredEffects = laterCompletionEffects();
  await writeFile(join(altered.root, "config/task-runtime.json"),
    `${JSON.stringify(taskRuntimeBody(Buffer.alloc(32, 7)))}\n`, { mode: 0o600 });
  await assert.rejects(completeMacLocalFirstOwnerV1(altered.root, altered.receiptPath, {
    ...alteredEffects.runtime, loadConfiguration: async () => diskConfiguration, readReceipt: async () => altered.receipt,
  }), /mac_local_first_owner_completion_refused/u);
  assert.deepEqual(alteredEffects.counters, { pinned: 0, dbOpened: 0 });

  const missing = await realProtectedFixture(t), missingEffects = laterCompletionEffects();
  await rm(join(missing.root, "config/task-runtime.json"));
  await assert.rejects(completeMacLocalFirstOwnerV1(missing.root, missing.receiptPath, {
    ...missingEffects.runtime, loadConfiguration: async () => diskConfiguration, readReceipt: async () => missing.receipt,
  }), /mac_local_task_runtime_invalid/u);
  assert.deepEqual(missingEffects.counters, { pinned: 0, dbOpened: 0 });
});
