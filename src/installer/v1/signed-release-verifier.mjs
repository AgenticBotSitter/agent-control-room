import { verifySignedReleaseFromTrustFileV1, verifySignedReleaseV1 } from "../../../scripts/release-signing.mjs";

/** The installer and connector updater share scripts/release-signing.mjs.
 * This wrapper is the installer's explicit trust boundary. */
export async function verifyInstallerSignedReleaseV1(input) {
  return verifySignedReleaseV1(input);
}

/** Production installer entrypoint: load the pinned installation trust record
 * from its private config file before accepting release bytes. */
export async function verifyInstallerSignedReleaseFromTrustFileV1(input, options) {
  return verifySignedReleaseFromTrustFileV1(input, options);
}
