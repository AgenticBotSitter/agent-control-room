import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres.ts";
import { loadMacLocalDatabaseRolesFromRootV1, loadMacLocalProtectedConfigurationFromRootV1 }
  from "../../src/web/v1/mac-local-protected-loader.ts";
import { checkMacLocalNodeKeyPinV1 } from "../../src/web/v1/mac-local-node-key-pin.ts";

export const MAC_LOCAL_FIRST_OWNER_RECEIPT_V1 = "control-room.mac-local-first-owner-receipt/v1";
const refuse = () => { throw new Error("mac_local_node_key_receipt_refused"); };

/** A first-owner receipt is public evidence. Still reject links, oversized input,
 * extra fields, missing nodes, and malformed fingerprints before opening a DB. */
export function parseMacLocalFirstOwnerReceiptV1(value, nodeIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return refuse();
  const keys = ["schema", "created", "kept", "fingerprints"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key))
    || value.schema !== MAC_LOCAL_FIRST_OWNER_RECEIPT_V1
    || !Number.isSafeInteger(value.created) || value.created < 0
    || !Number.isSafeInteger(value.kept) || value.kept < 0
    || !value.fingerprints || typeof value.fingerprints !== "object" || Array.isArray(value.fingerprints)
    || Object.getPrototypeOf(value.fingerprints) !== Object.prototype
    || Object.keys(value.fingerprints).length !== 3
    || Object.keys(value.fingerprints).some(id => !nodeIds.includes(id))
    || nodeIds.some(id => !Object.hasOwn(value.fingerprints, id)
      || typeof value.fingerprints[id] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.fingerprints[id]))) return refuse();
  return Object.freeze({ ...value, fingerprints: Object.freeze({ ...value.fingerprints }) });
}

async function readReceipt(path, nodeIds) {
  if (!isAbsolute(path) || resolve(path) !== path) return refuse();
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16 * 1024) return refuse();
    return parseMacLocalFirstOwnerReceiptV1(JSON.parse(await readFile(path, "utf8")), nodeIds);
  } catch { return refuse(); }
}

export async function pinMacLocalNodeKeysV1(protectedRoot, receiptPath, runtime = {}) {
  const loadConfiguration = runtime.loadConfiguration ?? loadMacLocalProtectedConfigurationFromRootV1;
  const loadRoles = runtime.loadRoles ?? loadMacLocalDatabaseRolesFromRootV1;
  const openDatabase = runtime.openDatabase ?? createPrivatePostgresDatabase;
  const checkPin = runtime.checkPin ?? checkMacLocalNodeKeyPinV1;
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) return refuse();
  const configuration = await loadConfiguration(protectedRoot);
  const nodeIds = ["hermes", "claude", "codex"].map(kind => `${configuration.enablement.nodeId}.${kind}`);
  const receipt = runtime.receipt ?? await readReceipt(receiptPath, nodeIds);
  const expected = parseMacLocalFirstOwnerReceiptV1(receipt, nodeIds);
  const roles = await loadRoles(protectedRoot);
  const database = openDatabase(roles.coordinator);
  try {
    const identity = (await database.client.query("SELECT current_user=$1 AND session_user=$1 AS role_ok",
      [roles.coordinator.username])).rows[0];
    if (identity?.role_ok !== true) return refuse();
    const rows = (await database.client.query(
      "SELECT node_id,fingerprint FROM control_node_keys WHERE node_id=ANY($1::text[])", [nodeIds])).rows;
    if (rows.length !== 3) return refuse();
    for (const nodeId of nodeIds) {
      const row = rows.find(item => item.node_id === nodeId);
      if (!row || row.fingerprint !== expected.fingerprints[nodeId]) return refuse();
    }
    // The established pin loader performs the protected-file checks and writes
    // the exact schema-versioned node-keys.json format used by runtime checks.
    await checkPin(database.client, protectedRoot, configuration, true, expected.fingerprints);
  } finally {
    await database.close();
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write("Usage: pnpm mac:pin-node-keys <protected-root> <receipt-file>\n");
    process.exitCode = 2;
  } else {
    try { process.exitCode = await pinMacLocalNodeKeysV1(args[0], args[1]); }
    catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "mac_local_node_key_receipt_refused"}\n`);
      process.exitCode = 1;
    }
  }
}
