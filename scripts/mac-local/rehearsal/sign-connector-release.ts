// Rehearsal-only stand-in for the installer's connector-release signing step.
//
// The installed Mac is connector-only (start-web-host.mjs `connectorOnly: true`):
// its bots are fleet connector workers, so the only way an owner's task reaches
// one is an offer claimed through the fleet gateway. The gateway refuses to start
// without a signed `connector-release.json`, and the real installer signs one with
// the installation key (src/updater/v1/install/connector-release.mjs). `mac:up`
// never holds a private key, so without this step a rehearsal runs a website with
// no gateway: no bot can join, and the owner journey cannot send a task anywhere.
//
// This builds the connector exactly as `mac:up` step 5 does (same root, same
// trust, so `mac:up`'s own rebuild is byte-identical) and signs its advertisement
// with the throwaway key `setup.ts` kept beside the rehearsal. It always rewrites
// the advertisement: the release directory is shared by every rehearsal in this
// checkout, and an advertisement signed by an earlier rehearsal's key would make
// the web host refuse the release outright.
import { createPrivateKey, sign } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFleetConnectorReleaseV1 } from "../../build-fleet-connector.mjs";
import { captureReleaseTrustV1, connectorReleaseSignatureMaterialV1,
  verifyConnectorReleaseAdvertisementV1 } from "../../release-signing.mjs";

export const REHEARSAL_CONNECTOR_RELEASE_ROOT_V1 = fileURLToPath(new URL("../../fleet/release", import.meta.url));

export async function signRehearsalConnectorReleaseV1(rehearsalRoot: string) {
  if (!isAbsolute(rehearsalRoot) || resolve(rehearsalRoot) !== rehearsalRoot)
    throw new Error("rehearsal_connector_release_root_invalid");
  const trust = captureReleaseTrustV1(JSON.parse(await readFile(join(rehearsalRoot, "protected", "config", "release-trust.json"), "utf8")));
  const privateKey = createPrivateKey(await readFile(join(rehearsalRoot, "rehearsal-release-signing.pem")));
  const { root, manifest } = await buildFleetConnectorReleaseV1({ root: REHEARSAL_CONNECTOR_RELEASE_ROOT_V1, releaseTrust: trust });
  const unsigned = { version: manifest.version, file: manifest.file, size: manifest.size, sha256: manifest.sha256,
    builtFrom: manifest.builtFrom, minVersion: manifest.version };
  const advertisement = { ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), privateKey).toString("base64url") };
  // A key that does not match the rehearsal's trust must fail here, not as a
  // refused web host three steps later.
  verifyConnectorReleaseAdvertisementV1(advertisement, trust);
  const target = join(root, "connector-release.json"), temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(advertisement, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  await rename(temporary, target);
  return Object.freeze({ root, version: manifest.version, sha256: manifest.sha256 });
}

/** Removes only the advertisement this module signs; the unsigned bundle and
 * manifest stay, which `mac:up` treats as "no release to distribute yet". */
export async function removeRehearsalConnectorAdvertisementV1() {
  await rm(join(REHEARSAL_CONNECTOR_RELEASE_ROOT_V1, "connector-release.json"), { force: true });
}
