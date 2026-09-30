#!/usr/bin/env node
// One-time installation helper. The private key belongs to the upgrader; the
// gateway and joined machines receive only the public SPKI value.
import { generateKeyPairSync } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function createConnectorReleaseKeyV1({ privateKeyPath }) {
  if (typeof privateKeyPath !== "string" || !isAbsolute(privateKeyPath) || resolve(privateKeyPath) !== privateKeyPath)
    throw new Error("connector_release_key_refused");
  const pair = generateKeyPairSync("ed25519");
  const privateBytes = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  const publicKeySpki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  const handle = await open(privateKeyPath, "wx", 0o600);
  try { await handle.writeFile(privateBytes); await handle.sync(); } finally { await handle.close(); }
  return Object.freeze({ publicKeySpki });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createConnectorReleaseKeyV1({ privateKeyPath: resolve(process.argv[2] ?? "") })
    .then(value => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch(() => { process.stderr.write("Control Room release-key creation refused.\n"); process.exitCode = 1; });
}
