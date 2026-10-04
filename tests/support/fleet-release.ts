import { generateKeyPairSync, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFleetConnectorReleaseForTestV1 } from "../../scripts/build-fleet-connector.mjs";
import { loadFleetConnectorReleaseV1 } from "../../scripts/run-fleet-gateway";
import { RELEASE_TRUST_SCHEMA_V1, connectorReleaseSignatureMaterialV1,
  releaseKeyIdV1 } from "../../scripts/release-signing.mjs";

export function createFleetReleaseTrustForTestV1(versionFloor = "0.0.0") {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return Object.freeze({ keys, trust: Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
    keyId: releaseKeyIdV1(publicKey), publicKey, versionFloor, revokedKeyIds: Object.freeze([]) }) });
}

export async function buildSignedFleetConnectorReleaseForTestV1(input: Readonly<{ root: string; builtFrom: string }>) {
  const signing = createFleetReleaseTrustForTestV1();
  const built = await buildFleetConnectorReleaseForTestV1({ ...input, releaseTrust: signing.trust });
  const unsigned = { version: built.manifest.version, file: built.manifest.file, sha256: built.manifest.sha256,
    size: built.manifest.size, builtFrom: built.manifest.builtFrom, minVersion: built.manifest.version };
  const advertisement = Object.freeze({ ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), signing.keys.privateKey).toString("base64url") });
  await writeFile(join(built.root, "connector-release.json"), `${JSON.stringify(advertisement, null, 2)}\n`);
  const connectorRelease = await loadFleetConnectorReleaseV1(built.root, signing.trust);
  return Object.freeze({ built, connectorRelease, releaseTrust: signing.trust });
}
