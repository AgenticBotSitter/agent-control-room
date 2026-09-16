import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const schema = "control-room.github-broker-operator/v1";
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 32 * 1024;

function fail() { throw new Error("github_broker_operator_configuration_invalid"); }

export async function readProtectedFile(path, { maxBytes, trustedOwnerUid = 0, openFile = open } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(trustedOwnerUid)
    || !Number.isInteger(constants.O_NOFOLLOW)) fail();
  let handle;
  try {
    handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(trustedOwnerUid) || (before.mode & 0o037n) !== 0n
      || before.size < 1n || before.size > BigInt(maxBytes)) fail();
    const value = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || Buffer.byteLength(value, "utf8") !== Number(after.size)
      || value.includes("\0")) fail();
    return value;
  } catch { fail(); }
  finally { try { await handle?.close(); } catch {} }
}

function secret(value, minimum) {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (normalized.endsWith("\r")) return fail();
  if (normalized.length < minimum || normalized.length > MAX_SECRET_BYTES
    || normalized.trim() !== normalized) fail();
  return normalized;
}

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function bearerAuthorizer(expected) {
  const expectedBytes = Buffer.from(expected, "utf8");
  return request => {
    const raw = request.headers.authorization;
    if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(raw.slice(7), "utf8");
    return supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes);
  };
}

export async function createConfiguration({ signal, runtime, env = process.env, trustedOwnerUid = 0 } = {}) {
  if (signal?.aborted || !runtime || typeof runtime.prepareGitHubBrokerPrivateService !== "function"
    || typeof runtime.createGitHubAppJwt !== "function") fail();
  const required = ["ACR_GITHUB_BROKER_SETTINGS_FILE", "ACR_GITHUB_APP_PRIVATE_KEY_FILE",
    "ACR_GITHUB_WEBHOOK_SECRET_FILE", "ACR_GITHUB_WORKER_READ_SECRET_FILE",
    "ACR_GITHUB_DATABASE_PASSWORD_FILE"];
  if (required.some(name => typeof env[name] !== "string" || !env[name])) fail();
  const settingsText = await readProtectedFile(env.ACR_GITHUB_BROKER_SETTINGS_FILE,
    { maxBytes: MAX_SETTINGS_BYTES, trustedOwnerUid });
  let settings;
  try { settings = JSON.parse(settingsText); } catch { fail(); }
  if (!exactObject(settings, ["schema", "appId", "installationId", "repository", "port", "database"])
    || settings.schema !== "control-room.github-broker-settings/v1"
    || !exactObject(settings.database, ["host", "port", "database", "username", "majorVersion"])) fail();
  const [privateKeyPem, webhookSecret, workerReadSecret, databasePassword] = await Promise.all([
    readProtectedFile(env.ACR_GITHUB_APP_PRIVATE_KEY_FILE, { maxBytes: MAX_SECRET_BYTES, trustedOwnerUid }).then(value => secret(value, 64)),
    readProtectedFile(env.ACR_GITHUB_WEBHOOK_SECRET_FILE, { maxBytes: MAX_SECRET_BYTES, trustedOwnerUid }).then(value => secret(value, 32)),
    readProtectedFile(env.ACR_GITHUB_WORKER_READ_SECRET_FILE, { maxBytes: MAX_SECRET_BYTES, trustedOwnerUid }).then(value => secret(value, 32)),
    readProtectedFile(env.ACR_GITHUB_DATABASE_PASSWORD_FILE, { maxBytes: MAX_SECRET_BYTES, trustedOwnerUid }).then(value => secret(value, 24)),
  ]);
  if (signal.aborted) fail();
  // Offline signing proves the protected key parses. It never requests a token or contacts GitHub.
  runtime.createGitHubAppJwt({ appId: String(settings.appId), installationId: String(settings.installationId),
    privateKeyPem }, 1_800_000);
  const service = await runtime.prepareGitHubBrokerPrivateService({
    repository: settings.repository, installationId: settings.installationId, webhookSecret,
    port: settings.port, authorizeWorker: bearerAuthorizer(workerReadSecret),
    database: { ...settings.database, password: databasePassword },
  });
  if (signal.aborted) { await service.close(); fail(); }
  return service;
}
