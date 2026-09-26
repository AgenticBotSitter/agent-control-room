import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHermes021MacosNativeOwnerQualificationHostV1,
  type Hermes021MacosSubprocessHostConfigurationV1 } from
  "../../src/harness/hermes-021-v1/subprocess-stream-json-host";
import { reviewHermes021MacosExecutableV1 } from
  "../../src/harness/hermes-021-v1/reviewed-executable-identity";

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
    const review = await hermesOwnerQualificationIdentityFixture(configuration);
    const host = await createHermes021MacosNativeOwnerQualificationHostV1(configuration, review.capability);
    return Object.freeze({ host, reviewedExecutableIdentity: review.record });
  })();
}

export async function hermesOwnerQualificationIdentityFixture(
  configuration: Hermes021MacosSubprocessHostConfigurationV1) {
  const executableSha256 = `sha256:${createHash("sha256").update(await readFile(configuration.executablePath)).digest("hex")}`;
  return reviewHermes021MacosExecutableV1({ executablePath: configuration.executablePath, executableSha256 });
}
