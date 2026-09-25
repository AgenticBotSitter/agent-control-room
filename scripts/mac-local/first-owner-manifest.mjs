import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { macLocalOwnerGrantIdV1, macLocalOwnerIdentityIdV1 } from "../../src/web/v1/mac-local-owner-bootstrap";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../src/harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../src/harness/claude-code-v1/task-planning-contract";
import { sha256Digest } from "../../src/security";
import { assertNoSecretMaterial } from "../../src/security/redaction";

export const MAC_LOCAL_FIRST_OWNER_MANIFEST_V1 = "control-room.mac-local-first-owner-manifest/v1";
const expectedTopKeys = ["schema", "tenant", "workspace", "identity", "grant", "adapters", "nodes", "createdAt"];
const workerSpecs = Object.freeze([
  { kind: "hermes", adapterId: HERMES_LOCAL_ADAPTER_V1 },
  { kind: "claude", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1 },
  { kind: "codex", adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 },
]);

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function createMacLocalFirstOwnerManifestV1(configuration, createdAt = new Date().toISOString()) {
  if (!configuration || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) throw new Error("mac_local_first_owner_manifest_invalid");
  const tenantId = configuration.localOwnerSession.tenantId;
  const workspaceId = configuration.workspaceId;
  const nodeBase = configuration.enablement.nodeId;
  const adapters = workerSpecs.map(({ adapterId }) => ({ id: adapterId }));
  const nodes = workerSpecs.map(({ kind }) => ({ id: `${nodeBase}.${kind}`, displayName: `Mac local ${kind}` }));
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
    createdAt,
  };
  if (!exactKeys(manifest, expectedTopKeys) || !exactKeys(manifest.tenant, ["id", "displayName"])
    || !exactKeys(manifest.workspace, ["id", "displayName"])
    || !exactKeys(manifest.identity, ["id", "displayName", "subjectDigest"])
    || !exactKeys(manifest.grant, ["id"]) || manifest.adapters.some(item => !exactKeys(item, ["id"]))
    || manifest.nodes.some(item => !exactKeys(item, ["id", "displayName"])))
    throw new Error("mac_local_first_owner_manifest_invalid");
  assertNoSecretMaterial(manifest, "Mac-local first-owner manifest");
  return Object.freeze(manifest);
}

export async function writeMacLocalFirstOwnerManifestV1(protectedRoot, outFile) {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot || !isAbsolute(outFile) || resolve(outFile) !== outFile)
    throw new Error("usage: pnpm mac:first-owner-manifest ABSOLUTE_PROTECTED_ROOT ABSOLUTE_OUT_FILE");
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(protectedRoot);
  const manifest = createMacLocalFirstOwnerManifestV1(configuration);
  await writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
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
