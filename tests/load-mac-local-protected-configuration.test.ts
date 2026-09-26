import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { loadMacLocalProtectedConfigurationFromRootV1, loadMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-loader";

const root = await mkdtemp(join(tmpdir(), "acr-mac-local-config-"));
const value = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local", provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode: "a long owner code for test only" }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test-password", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/Applications/Codex.app/Contents/MacOS/codex", recordedVersion: "codex test" }] } };
async function file(mode: number, body = JSON.stringify(value)) { const path = join(root, `config-${Math.random()}.json`); await writeFile(path, body, { mode }); await chmod(path, mode); return path; }

test("loads one locked-down exact configuration file", async () => {
  const loaded = await loadMacLocalProtectedConfigurationV1(await file(0o600));
  assert.equal(loaded.workspaceId, "workspace:mac-local");
});
test("refuses loose permissions, a symlink-shaped file, bad JSON, and relative paths", async () => {
  await assert.rejects(loadMacLocalProtectedConfigurationV1(await file(0o644)));
  await assert.rejects(loadMacLocalProtectedConfigurationV1(await file(0o600, "{")));
  await assert.rejects(loadMacLocalProtectedConfigurationV1("relative.json"));
});

test("the fixed loader reads only the protected config/mac-local.json location", async () => {
  const protectedRoot = await mkdtemp(join(root, "Protected-"));
  const config = join(protectedRoot, "config");
  await (await import("node:fs/promises")).mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(join(config, "mac-local.json"), JSON.stringify(value), { mode: 0o600 });
  await chmod(join(config, "mac-local.json"), 0o600);
  const loaded = await loadMacLocalProtectedConfigurationFromRootV1(protectedRoot);
  assert.equal(loaded.workspaceId, "workspace:mac-local");
  await chmod(config, 0o755);
  await assert.rejects(loadMacLocalProtectedConfigurationFromRootV1(protectedRoot));
  await assert.rejects(loadMacLocalProtectedConfigurationFromRootV1("relative"));
});
