import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHermes021MacosNativeOwnerQualificationHostV1,
  type Hermes021MacosSubprocessHostConfigurationV1 } from
  "../../src/harness/hermes-021-v1/subprocess-stream-json-host";
import { HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1 } from
  "../../src/harness/hermes-021-v1/reviewed-executable-identity";
import { HERMES_021_SOURCE_REVISION_V1 } from "../../src/harness/hermes-021-v1/connector-profile";

const executablePath = fileURLToPath(new URL("../fixtures/hermes-qualification-result.mjs", import.meta.url));

export function hermesOwnerQualificationConfigurationFixture(
  overrides: Partial<Hermes021MacosSubprocessHostConfigurationV1> = {}): Hermes021MacosSubprocessHostConfigurationV1 {
  return Object.freeze({ executablePath, profile: "owner-profile", model: "owner-model", provider: "owner-provider",
    workingDirectory: dirname(executablePath), ...overrides });
}

/** Uses the non-injectable native constructor with a local non-Hermes executable. */
export function createHermesOwnerQualificationHostFixture(
  configuration: Hermes021MacosSubprocessHostConfigurationV1) {
  return (async () => {
    const reviewedExecutableIdentity = await hermesOwnerQualificationIdentityFixture(configuration);
    const host = await createHermes021MacosNativeOwnerQualificationHostV1(configuration, reviewedExecutableIdentity);
    return Object.freeze({ host, reviewedExecutableIdentity });
  })();
}

export async function hermesOwnerQualificationIdentityFixture(
  configuration: Hermes021MacosSubprocessHostConfigurationV1) {
  const executableSha256 = `sha256:${createHash("sha256").update(await readFile(configuration.executablePath)).digest("hex")}`;
  return Object.freeze({ schema: HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1,
    executableSha256, expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
}
