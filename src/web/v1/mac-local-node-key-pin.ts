import { randomBytes } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseClient } from "../../persistence/database";
import { publicKeyFingerprint } from "../../node-protocol/v1";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";

export const MAC_LOCAL_NODE_KEYS_V1 = "control-room.mac-local-node-keys/v1" as const;
const kinds = ["hermes", "claude", "codex"] as const;
function refused(): never { throw new Error("mac_local_node_key_pin_mismatch"); }

async function privateDirectory(path: string) {
  const entry = await lstat(path).catch(refused);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || entry.uid !== process.getuid?.()) refused();
}

async function acceptExistingPin(file: string, nodeIds: readonly string[], fingerprints: Readonly<Record<string, string>>) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || entry.uid !== process.getuid?.() || entry.size > 4096) refused();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (Object.keys(parsed).length !== 2 || parsed.schema !== MAC_LOCAL_NODE_KEYS_V1
      || !parsed.fingerprints || typeof parsed.fingerprints !== "object" || Array.isArray(parsed.fingerprints)
      || Object.keys(parsed.fingerprints).length !== 3
      || nodeIds.some(id => parsed.fingerprints[id] !== fingerprints[id])) refused();
  } catch { refused(); }
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
  try {
    await acceptExistingPin(file, nodeIds, fingerprints);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") refused();
  }
  if (!initialize) refused();
  // Publish only fully written bytes. A direct open("wx") on the final path
  // exposes an empty/partial file and makes identical concurrent initializers
  // fail. A private temporary inode plus atomic hard-link lets one caller win;
  // losers validate the exact winner instead of overwriting it.
  const temporary = `${file}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(expected)}\n`);
    await handle.sync();
    await handle.close(); handle = undefined;
    try { await link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") refused();
      await acceptExistingPin(file, nodeIds, fingerprints);
      return;
    }
  } catch { refused(); }
  finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  const parent = await open(directory, "r").catch(refused);
  try { await parent.sync(); } finally { await parent.close(); }
}
