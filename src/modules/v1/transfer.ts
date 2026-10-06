import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { getRegisteredModuleManifestV1 } from "./registry";
import {
  MODULE_BUNDLE_SCHEMA_V1, canonicalModuleBundleV1, moduleKeyIdV1, signModuleBundleV1,
  type ModuleBundleInputV1, type ModuleBundleSignatureV1,
} from "./bundle";

/**
 * Exports a registered built-in module as a portable, canonical bundle file
 * the owner can download, inspect, or hand to another installation.
 *
 * Built-in modules (News, Idea Lab, Session Observations) predate the module
 * standard and keep their code in the host application, not in a portable
 * file inventory (see docs/MODULE_CONTRACT_V1.md). Their exported bundle
 * therefore always carries an empty file list: it is the exact manifest this
 * installation enforces, with a real fingerprint, not a code package. This
 * never loads, executes, or stages anything.
 */

const PKCS8_BASE64URL = /^[A-Za-z0-9_-]{16,2000}$/;
const FILE_NAME_UNSAFE = /[^A-Za-z0-9.-]/g;

export interface ModuleSigningKeyV1 {
  readonly privateKey: KeyObject;
  readonly publicKeySpki: string;
  readonly keyId: string;
}

/**
 * Parses an owner-configured local signing key (Ed25519 private key, PKCS8,
 * base64url) and derives its public fingerprint. Returns null when no key is
 * configured: downloads are then unsigned, and the owner sees them as such.
 */
export function loadModuleSigningKeyV1(privateKeyPkcs8Base64Url: string | undefined | null): ModuleSigningKeyV1 | null {
  if (privateKeyPkcs8Base64Url === undefined || privateKeyPkcs8Base64Url === null) return null;
  if (typeof privateKeyPkcs8Base64Url !== "string" || !PKCS8_BASE64URL.test(privateKeyPkcs8Base64Url)) {
    throw new Error("module_signing_key_invalid");
  }
  const der = Buffer.from(privateKeyPkcs8Base64Url, "base64url");
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" }); } catch { throw new Error("module_signing_key_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("module_signing_key_invalid");
  const publicKeySpki = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
  return Object.freeze({ privateKey, publicKeySpki, keyId: moduleKeyIdV1(publicKeySpki) });
}

export interface ModuleDownloadBundleV1 {
  readonly bundle: ModuleBundleInputV1;
  readonly signature: ModuleBundleSignatureV1 | null;
  readonly bundleDigest: string;
  readonly fileName: string;
}

/** A safe, deterministic download file name derived only from the exact registered id and version. */
export function moduleBundleFileNameV1(moduleId: string, version: string): string {
  const safeId = moduleId.replace(FILE_NAME_UNSAFE, "-");
  const safeVersion = version.replace(FILE_NAME_UNSAFE, "-");
  return `${safeId}-${safeVersion}.module-bundle.json`;
}

/**
 * Builds the exact canonical bundle for one registered module id/version:
 * `{ schema, manifest, files: [] }`, its digest, and — when a signing key is
 * configured — a signature over that exact digest. Throws the registry's own
 * refusal codes for an unknown module id or unavailable version.
 */
export function exportModuleBundleV1(moduleId: string, version: string | undefined,
  signingKey: ModuleSigningKeyV1 | null): Readonly<ModuleDownloadBundleV1> {
  const manifest = getRegisteredModuleManifestV1(moduleId, version);
  const bundle: ModuleBundleInputV1 = { schema: MODULE_BUNDLE_SCHEMA_V1, manifest, files: [] };
  const { bundleDigest } = canonicalModuleBundleV1(bundle);
  const signature = signingKey ? signModuleBundleV1(bundle, signingKey.privateKey, signingKey.publicKeySpki) : null;
  return Object.freeze({ bundle, signature, bundleDigest, fileName: moduleBundleFileNameV1(manifest.id, manifest.version) });
}
