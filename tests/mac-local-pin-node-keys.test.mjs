import assert from "node:assert/strict";
import test from "node:test";
import { MAC_LOCAL_FIRST_OWNER_RECEIPT_V1, parseMacLocalFirstOwnerReceiptV1,
  pinMacLocalNodeKeysV1 } from "../scripts/mac-local/pin-node-keys.mjs";

const nodeIds = ["mac-1.hermes", "mac-1.claude", "mac-1.codex"];
const fingerprints = Object.fromEntries(nodeIds.map((id, index) => [id, `sha256:${String(index + 1).repeat(64)}`]));
const receipt = { schema: MAC_LOCAL_FIRST_OWNER_RECEIPT_V1, manifestDigest: "sha256:" + "a".repeat(64),
  tenantId: "tenant:mac-local", created: 14, kept: 0, fingerprints };
const configuration = { enablement: { nodeId: "mac-1" } };

function runtime(rows = nodeIds.map(node_id => ({ node_id, fingerprint: fingerprints[node_id] }))) {
  const events = [];
  const database = { client: { query: async (sql) => {
    events.push(sql);
    if (sql.startsWith("SELECT current_user")) return { rows: [{ role_ok: true }] };
    return { rows };
  } }, close: async () => events.push("close") };
  return { events, options: {
    receipt,
    loadConfiguration: async () => configuration,
    loadRoles: async () => ({ coordinator: { username: "control_room_coordinator" } }),
    openDatabase: config => { assert.equal(config.username, "control_room_coordinator"); return database; },
    checkPin: async (_db, root, loaded, initialize, expected) => {
      events.push("pin"); assert.equal(root, "/private/Protected"); assert.equal(loaded, configuration); assert.equal(initialize, true);
      assert.deepEqual(expected, fingerprints);
    },
  } };
}

test("receipt parser accepts exactly the three public fingerprints and row counts", () => {
  assert.deepEqual(parseMacLocalFirstOwnerReceiptV1(receipt, nodeIds), receipt);
  for (const invalid of [
    { ...receipt, fingerprints: { ...fingerprints, "mac-1.extra": "sha256:" + "a".repeat(64) } },
    { ...receipt, fingerprints: { ...fingerprints, "mac-1.codex": "wrong" } },
    { ...receipt, secret: "unexpected" },
  ]) assert.throws(() => parseMacLocalFirstOwnerReceiptV1(invalid, nodeIds), /receipt_refused/u);
});

test("pin command uses the coordinator login and invokes the established protected pin loader", async () => {
  const fake = runtime();
  assert.equal(await pinMacLocalNodeKeysV1("/private/Protected", "/tmp/receipt.json", fake.options), 0);
  assert.deepEqual(fake.events, ["SELECT current_user=$1 AND session_user=$1 AS role_ok",
    "SELECT node_id,fingerprint FROM control_node_keys WHERE node_id=ANY($1::text[])", "pin", "close"]);
});

test("a fingerprint mismatch refuses before the protected pin file is written", async () => {
  const mismatched = nodeIds.map(node_id => ({ node_id, fingerprint: node_id === "mac-1.codex"
    ? "sha256:" + "f".repeat(64) : fingerprints[node_id] }));
  const fake = runtime(mismatched);
  await assert.rejects(pinMacLocalNodeKeysV1("/private/Protected", "/tmp/receipt.json", fake.options), /receipt_refused/u);
  assert.ok(!fake.events.includes("pin"));
  assert.equal(fake.events.at(-1), "close");
});

test("a role identity mismatch refuses and closes without pinning", async () => {
  const fake = runtime();
  fake.options.openDatabase = () => ({ client: { query: async () => ({ rows: [{ role_ok: false }] }) },
    close: async () => fake.events.push("close") });
  await assert.rejects(pinMacLocalNodeKeysV1("/private/Protected", "/tmp/receipt.json", fake.options), /receipt_refused/u);
  assert.ok(!fake.events.includes("pin"));
  assert.equal(fake.events.at(-1), "close");
});
