import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompletionGateStoreV1 } from "../../src/completion-gate/v1/store.ts";
import { sha256Digest } from "../../src/security/index.ts";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres.ts";
import { loadMacLocalDatabaseRolesFromRootV1, loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader.ts";
import { openMacLocalRollbackCheckpointStoreV1 } from "../../src/web/v1/mac-local-rollback-checkpoint-store.ts";
import { loadMacLocalTaskRuntimeFromRootV1 } from "../../src/web/v1/mac-local-task-runtime.ts";
import { captureMacLocalFirstOwnerManifestV1, createMacLocalFirstOwnerManifestV1 } from "./first-owner-manifest.mjs";
import { pinMacLocalNodeKeysV1, readMacLocalFirstOwnerReceiptV1 } from "./pin-node-keys.mjs";

const refuse = () => { throw new Error("mac_local_first_owner_completion_refused"); };

/** This is the explicit post-commit step, not a startup repair path. */
export async function completeMacLocalFirstOwnerV1(protectedRoot, receiptPath, runtime = {}) {
  if (![protectedRoot, receiptPath].every(path => typeof path === "string" && isAbsolute(path) && resolve(path) === path)) refuse();
  const configuration = await (runtime.loadConfiguration ?? loadMacLocalProtectedConfigurationFromRootV1)(protectedRoot);
  const nodeIds = ["hermes", "claude", "codex"].map(kind => `${configuration.enablement.nodeId}.${kind}`);
  const manifestPath = resolve(protectedRoot, "config", "first-owner-manifest.json");
  let manifest;
  try {
    const entry = await lstat(manifestPath);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 16 * 1024
      || (typeof process.getuid === "function" && entry.uid !== process.getuid())) refuse();
    manifest = captureMacLocalFirstOwnerManifestV1(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch { refuse(); }
  const receipt = await (runtime.readReceipt ?? readMacLocalFirstOwnerReceiptV1)(receiptPath, nodeIds);
  if (receipt.tenantId !== configuration.localOwnerSession.tenantId || receipt.tenantId !== manifest.tenant.id
    || receipt.manifestDigest !== sha256Digest(manifest)
    || manifest.workspace.id !== configuration.workspaceId
    || nodeIds.some((nodeId, index) => manifest.nodes[index]?.nodeId !== nodeId)) refuse();
  const taskRuntime = await (runtime.loadTaskRuntime ?? loadMacLocalTaskRuntimeFromRootV1)(protectedRoot);
  const expectedGenesis = CompletionGateStoreV1.genesisIntegrityForKeyV1(receipt.tenantId, taskRuntime.keys.review);
  const expectedManifest = createMacLocalFirstOwnerManifestV1(configuration, manifest.createdAt, expectedGenesis);
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) refuse();

  // Key pinning must be established before the independent rollback checkpoint.
  await (runtime.pinNodeKeys ?? pinMacLocalNodeKeysV1)(protectedRoot, receiptPath, { receipt });
  const roles = await (runtime.loadRoles ?? loadMacLocalDatabaseRolesFromRootV1)(protectedRoot);
  const db = (runtime.openDatabase ?? createPrivatePostgresDatabase)(roles.coordinator);
  let checkpoints;
  try {
    checkpoints = await (runtime.openCheckpoints ?? openMacLocalRollbackCheckpointStoreV1)(protectedRoot);
    const gate = new CompletionGateStoreV1(db.client, taskRuntime.keys.review, checkpoints);
    return await gate.completeProvisionedTenantV1(receipt.tenantId);
  } finally {
    await checkpoints?.close();
    await db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write("Usage: pnpm mac:complete-first-owner <protected-root> <receipt-file>\n");
    process.exitCode = 2;
  } else {
    try { console.log(await completeMacLocalFirstOwnerV1(args[0], args[1])); }
    catch { process.stderr.write("mac_local_first_owner_completion_refused\n"); process.exitCode = 1; }
  }
}
