/** A PostgreSQL SCRAM verifier derived locally from a high-entropy password.
 * The verifier is not a plaintext password, but must still be handled as
 * sensitive provisioning material and never committed or logged. */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const passwordPattern = /^[A-Za-z0-9_-]{32,}$/u;
export const scramVerifierPatternV1 = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/u;

export function postgresScramVerifierV1(password, salt = randomBytes(16)) {
  if (typeof password !== "string" || !passwordPattern.test(password)
    || !Buffer.isBuffer(salt) || salt.length !== 16) throw new Error("upgrade_scram_input_refused");
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export function checkedPostgresScramVerifierV1(value) {
  if (typeof value !== "string" || value.length > 256 || !scramVerifierPatternV1.test(value))
    throw new Error("upgrade_scram_verifier_refused");
  const [salt, keys] = value.slice("SCRAM-SHA-256$4096:".length).split("$");
  const [stored, server] = keys.split(":");
  if (Buffer.from(salt, "base64").length !== 16
    || Buffer.from(stored, "base64").length !== 32
    || Buffer.from(server, "base64").length !== 32)
    throw new Error("upgrade_scram_verifier_refused");
  return value;
}
