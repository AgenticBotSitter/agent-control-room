import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { macLocalOwnerGrantIdV1, macLocalOwnerIdentityIdV1 } from "../../src/web/v1/mac-local-owner-bootstrap";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../src/harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../src/harness/claude-code-v1/task-planning-contract";
import { sha256Digest } from "../../src/security";
import { assertNoSecretMaterial } from "../../src/security/redaction";
import { loadMacLocalTaskRuntimeFromRootV1 } from "../../src/web/v1/mac-local-task-runtime";
import { CompletionGateStoreV1 } from "../../src/completion-gate/v1/store";

export const MAC_LOCAL_FIRST_OWNER_MANIFEST_V1 = "control-room.mac-local-first-owner-manifest/v1";
const expectedTopKeys = ["schema", "tenant", "workspace", "identity", "grant", "adapters", "nodes", "completionGateGenesis", "createdAt"];
const workerSpecs = Object.freeze([
  { kind: "hermes", adapterId: HERMES_LOCAL_ADAPTER_V1 },
  { kind: "claude", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1 },
  { kind: "codex", adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 },
]);

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function captureMacLocalFirstOwnerManifestV1(value) {
  if (!exactKeys(value, expectedTopKeys) || value.schema !== MAC_LOCAL_FIRST_OWNER_MANIFEST_V1
    || !exactKeys(value.tenant, ["id", "displayName"]) || !exactKeys(value.workspace, ["id", "displayName"])
    || !exactKeys(value.identity, ["id", "displayName", "subjectDigest"]) || !exactKeys(value.grant, ["id"])
    || !Array.isArray(value.adapters) || value.adapters.length !== workerSpecs.length
    || value.adapters.some((item, index) => !exactKeys(item, ["id"]) || item.id !== workerSpecs[index].adapterId)
    || !Array.isArray(value.nodes) || value.nodes.length !== workerSpecs.length
    || value.nodes.some((item, index) => !exactKeys(item, ["nodeId", "workerId", "adapterId"])
      || typeof item.nodeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(item.nodeId)
      || !item.nodeId.endsWith(`.${["hermes", "claude", "codex"][index]}`)
      || typeof item.workerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(item.workerId)
      || item.adapterId !== workerSpecs[index].adapterId)
    || !exactKeys(value.completionGateGenesis, ["revision", "recordCount", "stateDigest", "stateAuthTag"])
    || value.completionGateGenesis.revision !== 1 || value.completionGateGenesis.recordCount !== 0
    || !/^sha256:[a-f0-9]{64}$/.test(value.completionGateGenesis.stateDigest)
    || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.completionGateGenesis.stateAuthTag)
    || ![value.tenant.id, value.workspace.id, value.identity.id, value.grant.id,
      value.tenant.displayName, value.workspace.displayName, value.identity.displayName].every(item => typeof item === "string" && item.length > 0)
    || value.identity.id !== `identity:${value.tenant.id}:owner` || value.grant.id !== `grant:${value.tenant.id}:owner`
    || !/^sha256:[a-f0-9]{64}$/.test(value.identity.subjectDigest)
    || !value.nodes.every((item, index) => item.adapterId === value.adapters[index].id)
    || new Set(value.nodes.map((item, index) => item.nodeId.slice(0, -[".hermes", ".claude", ".codex"][index].length))).size !== 1
    || value.completionGateGenesis.stateDigest !== sha256Digest({ tenantId: value.tenant.id, records: [] })
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt)
    throw new Error("mac_local_first_owner_manifest_invalid");
  assertNoSecretMaterial(value, "Mac-local first-owner manifest");
  return Object.freeze(value);
}

export function createMacLocalFirstOwnerManifestV1(configuration, createdAt = new Date().toISOString(), completionGateGenesis = configuration?.completionGateGenesis) {
  if (!configuration || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) throw new Error("mac_local_first_owner_manifest_invalid");
  const tenantId = configuration.localOwnerSession.tenantId;
  const workspaceId = configuration.workspaceId;
  const nodeBase = configuration.enablement.nodeId;
  const adapters = workerSpecs.map(({ adapterId }) => ({ id: adapterId }));
  const nodes = workerSpecs.map(({ kind, adapterId }) => {
    const workerKind = kind === "claude" ? "claude-code" : kind;
    const matches = configuration.enablement.workers.filter(worker => worker.kind === workerKind);
    if (matches.length !== 1) throw new Error("mac_local_first_owner_manifest_invalid");
    return { nodeId: `${nodeBase}.${kind}`, workerId: matches[0].workerId, adapterId };
  });
  const workers = configuration.enablement.workers;
  if (!Array.isArray(workers) || workerSpecs.some(({ kind }) => {
    const workerKind = kind === "claude" ? "claude-code" : kind;
    return workers.filter(worker => worker.kind === workerKind).length !== 1;
  })) throw new Error("mac_local_first_owner_manifest_invalid");
  const manifest = {
    schema: MAC_LOCAL_FIRST_OWNER_MANIFEST_V1,
    tenant: { id: tenantId, displayName: "Mac local" },
    workspace: { id: workspaceId, displayName: "Mac local" },
    identity: { id: macLocalOwnerIdentityIdV1(tenantId), displayName: "Owner",
      subjectDigest: sha256Digest({ provider: configuration.localOwnerSession.provider, subject: configuration.localOwnerSession.subject }) },
    grant: { id: macLocalOwnerGrantIdV1(tenantId) },
    adapters,
    nodes,
    completionGateGenesis,
    createdAt,
  };
  return captureMacLocalFirstOwnerManifestV1(manifest);
}

export async function writeMacLocalFirstOwnerManifestV1(protectedRoot, outFile) {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot || !isAbsolute(outFile) || resolve(outFile) !== outFile)
    throw new Error("usage: pnpm mac:first-owner-manifest ABSOLUTE_PROTECTED_ROOT ABSOLUTE_OUT_FILE");
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(protectedRoot);
  const runtime = await loadMacLocalTaskRuntimeFromRootV1(protectedRoot);
  const completionGateGenesis = CompletionGateStoreV1.genesisIntegrityForKeyV1(configuration.localOwnerSession.tenantId, runtime.keys.review);
  const protectedCopy = resolve(protectedRoot, "config", "first-owner-manifest.json");
  let manifest;
  try {
    const entry = await lstat(protectedCopy);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16 * 1024 || (entry.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && entry.uid !== process.getuid()))
      throw new Error("mac_local_first_owner_manifest_conflict");
    const existing = await readFile(protectedCopy, "utf8");
    const savedManifest = captureMacLocalFirstOwnerManifestV1(JSON.parse(existing));
    const expectedManifest = createMacLocalFirstOwnerManifestV1(configuration, savedManifest.createdAt, completionGateGenesis);
    if (JSON.stringify(savedManifest) !== JSON.stringify(expectedManifest)) throw new Error("mac_local_first_owner_manifest_conflict");
    manifest = savedManifest;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    manifest = createMacLocalFirstOwnerManifestV1(configuration, new Date().toISOString(), completionGateGenesis);
    await writeFile(protectedCopy, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(outFile, manifestText, { flag: "wx", mode: 0o644 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("usage: pnpm mac:first-owner-manifest ABSOLUTE_PROTECTED_ROOT ABSOLUTE_OUT_FILE");
    const manifest = await writeMacLocalFirstOwnerManifestV1(process.argv[2], process.argv[3]);
    console.log(`wrote first-owner manifest ${manifest.schema}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "mac_local_first_owner_manifest_failed");
    process.exitCode = 1;
  }
}
