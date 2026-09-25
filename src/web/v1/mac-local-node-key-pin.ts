import { lstat, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseClient } from "../../persistence/database";
import { publicKeyFingerprint } from "../../node-protocol/v1";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";

export const MAC_LOCAL_NODE_KEYS_V1 = "control-room.mac-local-node-keys/v1" as const;
const kinds = ["hermes", "claude", "codex"] as const;
const refused = (): never => { throw new Error("mac_local_node_key_pin_mismatch"); };

async function privateDirectory(path: string) {
  const entry = await lstat(path).catch(refused);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || entry.uid !== process.getuid?.()) refused();
}

/** The VPS public keys are pinned in a private file on the Mac. No signing key is
 * exported. First creation is explicit; a later missing file is never repaired. */
export async function checkMacLocalNodeKeyPinV1(db: DatabaseClient, root: string,
  configuration: MacLocalProtectedConfigurationV1, initialize = false,
  receiptFingerprints?: Readonly<Record<string, string>>): Promise<void> {
  if (!isAbsolute(root) || resolve(root) !== root) refused();
  const directory = join(root, "config"), file = join(directory, "node-keys.json");
  await privateDirectory(root);
  await privateDirectory(directory);
  const nodeIds = kinds.map(kind => `${configuration.enablement.nodeId}.${kind}`);
  const rows = (await db.query<{ node_id: string; id: string; tenant_id: string; state: string;
    algorithm: string; valid_until: unknown; public_key_spki: string; fingerprint: string }>(
    `SELECT node_id,id,tenant_id,state,algorithm,valid_until,public_key_spki,fingerprint
       FROM control_node_keys WHERE node_id=ANY($1::text[])`, [nodeIds])).rows;
  if (rows.length !== 3) refused();
  const fingerprints: Record<string, string> = Object.create(null);
  for (const nodeId of nodeIds) {
    const key = rows.find(row => row.node_id === nodeId);
    if (!key || key.id !== `local-owner:${nodeId}` || key.tenant_id !== configuration.localOwnerSession.tenantId
      || key.state !== "active" || key.algorithm !== "ed25519" || key.valid_until !== null
      || publicKeyFingerprint(key.public_key_spki) !== key.fingerprint
      || receiptFingerprints && receiptFingerprints[nodeId] !== key.fingerprint) refused();
    fingerprints[nodeId] = key.fingerprint;
  }
  const expected = { schema: MAC_LOCAL_NODE_KEYS_V1, fingerprints };
  let existing: string | undefined;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
      || entry.uid !== process.getuid?.() || entry.size > 4096) refused();
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") refused();
  }
  if (existing !== undefined) {
    try {
      const parsed = JSON.parse(existing);
      if (Object.keys(parsed).length !== 2 || parsed.schema !== MAC_LOCAL_NODE_KEYS_V1
        || Object.keys(parsed.fingerprints).length !== 3
        || nodeIds.some(id => parsed.fingerprints[id] !== fingerprints[id])) refused();
      return;
    } catch { refused(); }
  }
  if (!initialize) refused();
  const handle = await open(file, "wx", 0o600).catch(refused);
  try {
    await handle.writeFile(`${JSON.stringify(expected)}\n`);
    await handle.sync();
  } catch { await unlink(file).catch(() => {}); refused(); }
  finally { await handle.close(); }
  const parent = await open(directory, "r").catch(refused);
  try { await parent.sync(); } finally { await parent.close(); }
}
